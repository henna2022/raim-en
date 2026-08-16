'use strict';
// Batch confirm (dashboard per-session groups) + yeyak helper settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, restartApp, withDb, newJar,
  get, postAdminForm, makeReservation, adminLogin, uniqueEmail,
} = require('./helper');

let ctx;
let res1, res2, res3, resSp; // res1..3 share the default session; resSp is a special-tour session

function reservationId(dataDir, code) {
  return withDb(dataDir, (db) => db.prepare('SELECT id FROM reservations WHERE code = ?').get(code).id);
}
function reservationStatus(dataDir, code) {
  return withDb(dataDir, (db) => db.prepare('SELECT status FROM reservations WHERE code = ?').get(code).status);
}
function confirmedEmailCount(dataDir, toAddr) {
  return withDb(dataDir, (db) => db.prepare(
    `SELECT COUNT(*) AS c FROM email_log WHERE to_addr = ? AND subject LIKE '%Reservation confirmed%'`
  ).get(toAddr).c);
}

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, ctx.jar, {});
  assert.equal(loginRes.status, 302, 'admin login must succeed before batch-confirm tests run');

  res1 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  res2 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  res3 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  resSp = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail(), tour_type: 'special' });
  assert.notEqual(res1.slot_id, resSp.slot_id, 'fixture needs two different sessions');
  assert.equal(res1.slot_id, res2.slot_id, 'res1/res2 must share a session');
  assert.equal(res1.slot_id, res3.slot_id, 'res1/res3 must share a session');
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('B1: batch confirm without the yeyak checkbox -> 400, all stay pending', async () => {
  const ids = [reservationId(ctx.dataDir, res1.code), reservationId(ctx.dataDir, res2.code)];
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/reservations/batch-confirm', {
    ids: ids.map(String),
  });
  assert.equal(res.status, 400);
  assert.equal(reservationStatus(ctx.dataDir, res1.code), 'pending');
  assert.equal(reservationStatus(ctx.dataDir, res2.code), 'pending');
});

test('B2: batch confirm two same-session requests -> both confirmed, both emailed', async () => {
  const ids = [reservationId(ctx.dataDir, res1.code), reservationId(ctx.dataDir, res2.code)];
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/reservations/batch-confirm', {
    ids: ids.map(String), yeyak_blocked: 'on',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin?confirmed=2&skipped=0&emailfail=0');
  assert.equal(reservationStatus(ctx.dataDir, res1.code), 'confirmed');
  assert.equal(reservationStatus(ctx.dataDir, res2.code), 'confirmed');
  assert.equal(confirmedEmailCount(ctx.dataDir, res1.email), 1);
  assert.equal(confirmedEmailCount(ctx.dataDir, res2.email), 1);

  // Follow the redirect: the flash must state the count and be honest about
  // the outbox (SMTP is not configured in tests), never a blanket "sent".
  const html = await (await get(ctx.baseUrl, ctx.jar, res.headers.get('location'))).text();
  assert.match(html, /2건 확정했습니다\./);
  assert.match(html, /Outbox/);
});

test('B3: ids spanning two different sessions -> 400, nothing changes', async () => {
  const ids = [reservationId(ctx.dataDir, res3.code), reservationId(ctx.dataDir, resSp.code)];
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/reservations/batch-confirm', {
    ids: ids.map(String), yeyak_blocked: 'on',
  });
  assert.equal(res.status, 400);
  assert.equal(reservationStatus(ctx.dataDir, res3.code), 'pending');
  assert.equal(reservationStatus(ctx.dataDir, resSp.code), 'pending');
});

test('B4: a no-longer-pending id in the batch is skipped (not failed), the rest confirm', async () => {
  // res1 was already confirmed in B2; res3 is still pending in the same session.
  const ids = [reservationId(ctx.dataDir, res3.code), reservationId(ctx.dataDir, res1.code)];
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/reservations/batch-confirm', {
    ids: ids.map(String), yeyak_blocked: 'on',
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin?confirmed=1&skipped=1&emailfail=0');
  assert.equal(reservationStatus(ctx.dataDir, res3.code), 'confirmed');
  assert.equal(reservationStatus(ctx.dataDir, res1.code), 'confirmed');
  // res1 must NOT have been emailed a second time by the skip.
  assert.equal(confirmedEmailCount(ctx.dataDir, res1.email), 1);
});

test('B5: unknown reservation id -> 400', async () => {
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/reservations/batch-confirm', {
    ids: ['999999'], yeyak_blocked: 'on',
  });
  assert.equal(res.status, 400);
});

test('B6: dashboard groups pending requests per session with batch form + copy button', async () => {
  // resSp is still pending — it should render as a group.
  const html = await (await get(ctx.baseUrl, ctx.jar, '/admin')).text();
  assert.match(html, /class="res-group/);
  assert.match(html, /action="\/admin\/reservations\/batch-confirm"/);
  assert.match(html, /yeyak용 복사/);
  assert.match(html, /data-session="[^"]*기획전시/); // special tour, Korean session label for the yeyak copy line
  assert.match(html, new RegExp(resSp.code));
});

test('B8: confirming clears a stale release_needed flag (batch and single routes)', async () => {
  // A cancel→reopen chain can leave release_needed=1 on a pending row; a
  // confirm must clear it or the row lingers in the yeyak release queue.
  // Restart first: the fixture already used 4 of the 5 public /reserve
  // requests the in-memory rate limiter allows per window (session survives
  // the restart via the SQLite session store).
  await restartApp(ctx);
  const resB = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  const resS = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  const idB = reservationId(ctx.dataDir, resB.code);
  const idS = reservationId(ctx.dataDir, resS.code);
  withDb(ctx.dataDir, (db) => db.prepare('UPDATE reservations SET release_needed=1 WHERE id IN (?,?)').run(idB, idS));

  const batch = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/reservations/batch-confirm', {
    ids: [String(idB)], yeyak_blocked: 'on',
  });
  assert.equal(batch.status, 302);
  const single = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${idS}/confirm`, {
    yeyak_blocked: 'on',
  });
  assert.equal(single.status, 302);

  const flags = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT id, status, release_needed FROM reservations WHERE id IN (?,?)').all(idB, idS));
  for (const f of flags) {
    assert.equal(f.status, 'confirmed');
    assert.equal(f.release_needed, 0, `release_needed must be cleared on confirm (id ${f.id})`);
  }
});

test('B7: yeyak helper URLs — saved via settings, rendered on dashboard, non-http rejected', async () => {
  const url = 'https://yeyak.seoul.go.kr/web/reservation/selectReservView.do?rsv_svc_id=TEST123';
  let res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/settings', { yeyak_url_special: url });
  assert.equal(res.status, 302);
  let html = await (await get(ctx.baseUrl, ctx.jar, '/admin')).text();
  assert.match(html, /yeyak 예약 ↗/);
  assert.ok(html.includes('rsv_svc_id=TEST123'));

  // A javascript: URL must never render as a link.
  res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/settings', { yeyak_url_special: 'javascript:alert(1)' });
  assert.equal(res.status, 302);
  html = await (await get(ctx.baseUrl, ctx.jar, '/admin')).text();
  assert.ok(!html.includes('yeyak 예약 ↗'));
  assert.ok(!html.includes('href="javascript:'));
});
