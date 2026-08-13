'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, restartApp, withDb, newJar,
  get, postForm, makeReservation, nextClosedMonday, nextWednesday,
  addDays, todayStrKST, uniqueEmail,
} = require('./helper');

// POST /reserve is limited to 5 requests / 10min per IP (see src/ratelimit.js).
// All of A1-A15 run against 127.0.0.1, so we must keep POST /reserve calls to
// <=5 per running app instance. We restart the app (same DATA_DIR, fresh
// in-memory counters) at the two points noted below to stay under that cap
// without ever exceeding 5 POSTs in any single instance.
//   instance 1: A6, A7, A8, A9, A10a                (5 POSTs)
//   instance 2: A10b, A10c, A11, A12, A13            (5 POSTs)
//   instance 3: A14a, A14b, A14c, A14d, A15           (5 POSTs)

let ctx;

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('A1: GET / -> 200, body contains "Book a Guided Tour"', async () => {
  const res = await get(ctx.baseUrl, null, '/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Book a Guided Tour/);
});

test('A2: GET /api/sessions?date=<next Monday> -> closed:true, reason mentions Monday', async () => {
  const date = nextClosedMonday();
  const res = await get(ctx.baseUrl, null, `/api/sessions?date=${date}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.closed, true);
  assert.match(data.reason, /Monday/);
});

test('A3: GET /api/sessions?date=<next Wednesday> -> 12 sessions, exactly 2 language:en (15:40 permanent, 16:30 special)', async () => {
  const date = nextWednesday();
  const res = await get(ctx.baseUrl, null, `/api/sessions?date=${date}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.closed, false);
  assert.equal(data.sessions.length, 12);
  const en = data.sessions.filter((s) => s.language === 'en');
  assert.equal(en.length, 2);
  const times = en.map((s) => s.start_time).sort();
  assert.deepEqual(times, ['15:40', '16:30']);
  const permanentEn = en.find((s) => s.start_time === '15:40');
  const specialEn = en.find((s) => s.start_time === '16:30');
  assert.equal(permanentEn.tour_type, 'permanent');
  assert.equal(specialEn.tour_type, 'special');
});

test('A4: GET /api/sessions?date=2026-13-99 -> 400', async () => {
  const res = await get(ctx.baseUrl, null, '/api/sessions?date=2026-13-99');
  assert.equal(res.status, 400);
});

test('A5: GET /api/sessions?date=<yesterday> -> closed (outside booking window)', async () => {
  const yesterday = addDays(todayStrKST(), -1);
  const res = await get(ctx.baseUrl, null, `/api/sessions?date=${yesterday}`);
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.closed, true);
});

test('A6: normal reservation (Wednesday, EN session, party 2) -> 302 /booking?...new=1, pending row in DB, 1 "Request received" email', async () => {
  const { res, code, email, date, slot_id } = await makeReservation(ctx.baseUrl, ctx.jar, {
    date: nextWednesday(), language: 'en', party_size: 2,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /^\/booking\?code=/);
  assert.match(location, /new=1/);
  assert.ok(code, 'expected a reservation code to be returned');

  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT * FROM reservations WHERE code = ?').get(code);
    assert.ok(row, 'expected a DB row for the new reservation');
    assert.equal(row.status, 'pending');
    const emails = db.prepare(
      `SELECT COUNT(*) AS c FROM email_log WHERE to_addr = ? AND subject LIKE '%Request received%'`
    ).get(email).c;
    assert.equal(emails, 1);
  });

  ctx.a6 = { code, email, date, slot_id };
});

test('A7: reservation on a Monday -> 400, re-rendered form', async () => {
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date: nextClosedMonday(), slot_id: '1', name: 'A7 Tester', email: uniqueEmail(),
    party_size: '2', agree: 'on',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /closed/i);
});

test('A8: reservation outside the 60-day window -> 400', async () => {
  const outside = addDays(todayStrKST(), 61);
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date: outside, slot_id: '1', name: 'A8 Tester', email: uniqueEmail(),
    party_size: '2', agree: 'on',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /booking window/i);
});

test('A9: nonexistent slot_id for that weekday (9999) -> 400', async () => {
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date: nextWednesday(), slot_id: '9999', name: 'A9 Tester', email: uniqueEmail(),
    party_size: '2', agree: 'on',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /select a session/i);
});

let sharedSlotId; // captured during A10a for reuse by A10b/A10c

test('A10a: party_size 0 -> 400', async () => {
  const date = nextWednesday();
  const sessRes = await get(ctx.baseUrl, null, `/api/sessions?date=${date}`);
  const day = await sessRes.json();
  sharedSlotId = day.sessions[0].id;
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date, slot_id: String(sharedSlotId), name: 'A10 Tester', email: uniqueEmail(),
    party_size: '0', agree: 'on',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /Party size must be between/i);
});

test('A10b: party_size 7 -> 400', async () => {
  // Restart to reset the per-IP reserve limiter counter before the 2nd batch
  // of POST /reserve calls in this file (see budget comment near the top).
  await restartApp(ctx);
  const date = nextWednesday();
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date, slot_id: String(sharedSlotId), name: 'A10 Tester', email: uniqueEmail(),
    party_size: '7', agree: 'on',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /Party size must be between/i);
});

test("A10c: party_size 'abc' -> 400", async () => {
  const date = nextWednesday();
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date, slot_id: String(sharedSlotId), name: 'A10 Tester', email: uniqueEmail(),
    party_size: 'abc', agree: 'on',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /Party size must be between/i);
});

test('A11: malformed email -> 400', async () => {
  const date = nextWednesday();
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date, slot_id: String(sharedSlotId), name: 'A11 Tester', email: 'not-an-email',
    party_size: '2', agree: 'on',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /valid email/i);
});

test('A12: agree checkbox unchecked -> 400', async () => {
  const date = nextWednesday();
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date, slot_id: String(sharedSlotId), name: 'A12 Tester', email: uniqueEmail(),
    party_size: '2',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /agree/i);
});

test('A13: duplicate email+date+slot -> 400', async () => {
  // Same email + date + slot_id as A6's already-pending reservation.
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date: ctx.a6.date, slot_id: String(ctx.a6.slot_id), name: 'A13 Tester',
    email: ctx.a6.email, country: 'Japan', party_size: '2', agree: 'on',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /already have a request/i);
});

let fourthSlotId;

test('A14a: create 1st of 3 upcoming reservations for the same email', async () => {
  // Restart again to reset the reserve limiter before the final batch.
  await restartApp(ctx);
  const date = nextWednesday();
  const sessRes = await get(ctx.baseUrl, null, `/api/sessions?date=${date}`);
  const day = await sessRes.json();
  ctx.a14 = { date, email: uniqueEmail(), slots: day.sessions.map((s) => s.id) };
  fourthSlotId = ctx.a14.slots[3];
  const r = await makeReservation(ctx.baseUrl, ctx.jar, {
    date, slot_id: ctx.a14.slots[0], email: ctx.a14.email, party_size: 2,
  });
  assert.equal(r.res.status, 302);
});

test('A14b: create 2nd of 3 upcoming reservations for the same email', async () => {
  const r = await makeReservation(ctx.baseUrl, ctx.jar, {
    date: ctx.a14.date, slot_id: ctx.a14.slots[1], email: ctx.a14.email, party_size: 2,
  });
  assert.equal(r.res.status, 302);
});

test('A14c: create 3rd of 3 upcoming reservations for the same email', async () => {
  const r = await makeReservation(ctx.baseUrl, ctx.jar, {
    date: ctx.a14.date, slot_id: ctx.a14.slots[2], email: ctx.a14.email, party_size: 2,
  });
  assert.equal(r.res.status, 302);
});

test('A14d: 4th reservation for the same email -> 400, "3 upcoming" in message', async () => {
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date: ctx.a14.date, slot_id: String(fourthSlotId), name: 'A14 Tester',
    email: ctx.a14.email, country: 'Japan', party_size: '2', agree: 'on',
  });
  assert.equal(res.status, 400);
  const body = await res.text();
  assert.match(body, /3 upcoming/);
});

test('A15: honeypot (website) filled -> 302 but no DB row, no email logged', async () => {
  const email = uniqueEmail();
  const date = nextWednesday();
  const sessRes = await get(ctx.baseUrl, null, `/api/sessions?date=${date}`);
  const day = await sessRes.json();
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date, slot_id: String(day.sessions[0].id), name: 'Honeypot Bot', email,
    party_size: '2', agree: 'on', website: 'http://spam.example',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/booking?new=1');

  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT * FROM reservations WHERE email = ?').get(email);
    assert.equal(row, undefined, 'honeypot submission must not create a DB row');
    const emailCount = db.prepare('SELECT COUNT(*) AS c FROM email_log WHERE to_addr = ?').get(email).c;
    assert.equal(emailCount, 0, 'honeypot submission must not send/log any email');
  });
});

test('A16: country must come from the list — free text is rejected', async () => {
  await restartApp(ctx); // 공개 폼 rate limit 리셋
  const base = {
    date: nextWednesday(), name: 'Country Tester', email: uniqueEmail(),
    party_size: '2', agree: 'on',
  };
  const day = await (await get(ctx.baseUrl, null, `/api/sessions?date=${base.date}`)).json();
  const slot_id = String(day.sessions[0].id);

  for (const bad of ['Testland', 'kr', '', '   ']) {
    const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', { ...base, slot_id, country: bad });
    assert.equal(res.status, 400, `country="${bad}" must be rejected`);
    assert.match(await res.text(), /select your country/i);
  }

  const ok = await postForm(ctx.baseUrl, ctx.jar, '/reserve', { ...base, slot_id, country: 'Japan' });
  assert.equal(ok.status, 302, '목록에 있는 국가는 통과해야 한다');
});

test('A17: party size is capped at 5, and the form offers exactly 1–5', async () => {
  await restartApp(ctx);
  const date = nextWednesday();
  const day = await (await get(ctx.baseUrl, null, `/api/sessions?date=${date}`)).json();
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date, slot_id: String(day.sessions[0].id), name: 'Six Tester', email: uniqueEmail(),
    country: 'Japan', party_size: '6', agree: 'on',
  });
  assert.equal(res.status, 400, '6명은 거부되어야 한다');
  assert.match(await res.text(), /between 1 and 5/);

  const form = await (await get(ctx.baseUrl, ctx.jar, '/reserve')).text();
  const options = [...form.matchAll(/<option value="(\d+)"[^>]*>\d+ (?:person|people)</g)].map(m => m[1]);
  assert.deepEqual(options, ['1', '2', '3', '4', '5'], '폼에 1~5명만 있어야 한다');
});

test('A18: the free-text notes field is gone from the form and never stored', async () => {
  const form = await (await get(ctx.baseUrl, ctx.jar, '/reserve')).text();
  assert.ok(!/name="notes"/.test(form), '요청사항 입력란이 없어야 한다');

  await restartApp(ctx);
  const date = nextWednesday();
  const day = await (await get(ctx.baseUrl, null, `/api/sessions?date=${date}`)).json();
  const email = uniqueEmail();
  // 폼을 우회해 notes 를 밀어넣어도 저장되면 안 된다.
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date, slot_id: String(day.sessions[1].id), name: 'Notes Tester', email,
    country: 'Japan', party_size: '2', agree: 'on', notes: 'wheelchair user — must not be stored',
  });
  assert.equal(res.status, 302);
  const stored = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT notes FROM reservations WHERE email = ?').get(email));
  assert.equal(stored.notes, '', '전송된 notes 는 무시되어야 한다');
});
