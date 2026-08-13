'use strict';
// Sold-out toggle: decline-with-mark, public form blocking, schedule management, purge.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, restartApp, withDb, newJar,
  get, postForm, postAdminForm, makeReservation, adminLogin, uniqueEmail, addDays, nextMonday, nextWeekday,
} = require('./helper');

let ctx;
let res1, res2; // same session; res1 gets declined with the sold-out mark, res2 stays pending

function reservationId(dataDir, code) {
  return withDb(dataDir, (db) => db.prepare('SELECT id FROM reservations WHERE code = ?').get(code).id);
}
async function sessionsFor(date) {
  return (await (await get(ctx.baseUrl, ctx.jar, `/api/sessions?date=${encodeURIComponent(date)}`)).json()).sessions;
}

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, ctx.jar, {});
  assert.equal(loginRes.status, 302, 'admin login must succeed before soldout tests run');
  res1 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  res2 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  assert.equal(res1.slot_id, res2.slot_id, 'fixture needs one shared session');
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('SO1: decline with mark_soldout -> declined + session flagged in /api/sessions', async () => {
  const id = reservationId(ctx.dataDir, res1.code);
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/decline`, {
    decline_reason: 'Session fully booked', mark_soldout: 'on',
  });
  assert.equal(res.status, 302);
  const row = withDb(ctx.dataDir, (db) => db.prepare('SELECT status FROM reservations WHERE id = ?').get(id));
  assert.equal(row.status, 'declined');
  const mark = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT * FROM soldout WHERE date = ? AND slot_id = ?').get(res1.date, res1.slot_id));
  assert.ok(mark, 'soldout row must exist');
  assert.equal(mark.created_by, 'admin');

  const sessions = await sessionsFor(res1.date);
  const flagged = sessions.find(s => s.id === res1.slot_id);
  assert.equal(flagged.soldout, true);
  for (const s of sessions.filter(s => s.id !== res1.slot_id)) {
    assert.equal(s.soldout, false, 'other sessions must stay bookable');
  }
});

test('SO2: POST /reserve for a sold-out session -> 400, no reservation created', async () => {
  const before = withDb(ctx.dataDir, (db) => db.prepare('SELECT COUNT(*) AS c FROM reservations').get().c);
  const res = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date: res1.date, slot_id: String(res1.slot_id), name: 'Late Visitor', email: uniqueEmail(),
    country: 'Testland', party_size: '2', notes: '', agree: 'on',
  }, { csrfPage: '/reserve' });
  assert.equal(res.status, 400);
  // Must match the error box specifically — the phrase "(fully booked)" also
  // appears unconditionally in the page's session-rendering script.
  assert.match(await res.text(), /That session is fully booked/);
  const after = withDb(ctx.dataDir, (db) => db.prepare('SELECT COUNT(*) AS c FROM reservations').get().c);
  assert.equal(after, before);
});

test('SO3: dashboard group for a sold-out session shows the SOLD OUT badge', async () => {
  // res2 is still pending in the flagged session.
  const html = await (await get(ctx.baseUrl, ctx.jar, '/admin')).text();
  assert.match(html, /SOLD OUT/);
  assert.match(html, new RegExp(res2.code));
});

test('SO4: removing the mark (Schedule) makes the session bookable again', async () => {
  const markId = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT id FROM soldout WHERE date = ? AND slot_id = ?').get(res1.date, res1.slot_id).id);
  const del = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/schedule/soldout/${markId}/delete`, {});
  assert.equal(del.status, 302);

  const sessions = await sessionsFor(res1.date);
  assert.equal(sessions.find(s => s.id === res1.slot_id).soldout, false);

  const again = await makeReservation(ctx.baseUrl, ctx.jar, {
    email: uniqueEmail(), date: res1.date, slot_id: res1.slot_id,
  });
  assert.ok(again.code, 'reservation must succeed once the mark is removed');
});

test('SO5: manual mark via Schedule; invalid input rejected', async () => {
  const date = addDays(res1.date, 7); // same weekday next week -> session exists
  const ok = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/schedule/soldout', {
    date, slot_id: String(res1.slot_id),
  });
  assert.equal(ok.status, 302);
  assert.match(ok.headers.get('location') || '', /saved=1/);
  const sessions = await sessionsFor(date);
  assert.equal(sessions.find(s => s.id === res1.slot_id).soldout, true);

  const bad = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/schedule/soldout', {
    date: 'not-a-date', slot_id: '999999',
  });
  assert.match(bad.headers.get('location') || '', /error=/);

  // A mark that could never apply must be rejected, not silently saved:
  // past date, closed day (Monday), or a session that doesn't run that weekday.
  const noop = (dataDir) => withDb(dataDir, (db) => db.prepare('SELECT COUNT(*) AS c FROM soldout').get().c);
  const beforeCount = noop(ctx.dataDir);
  const past = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/schedule/soldout', {
    date: '2020-01-01', slot_id: String(res1.slot_id),
  });
  assert.match(past.headers.get('location') || '', /error=/);
  const monday = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/schedule/soldout', {
    date: nextMonday(), slot_id: String(res1.slot_id),
  });
  assert.match(monday.headers.get('location') || '', /error=/);
  // Wednesday-only English session on a Thursday: open day, wrong weekday.
  const enSlotId = withDb(ctx.dataDir, (db) =>
    db.prepare(`SELECT id FROM slots WHERE language = 'en' AND tour_type = 'permanent'`).get().id);
  const wrongDay = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/schedule/soldout', {
    date: nextWeekday(4), slot_id: String(enSlotId),
  });
  assert.match(wrongDay.headers.get('location') || '', /error=/);
  assert.equal(noop(ctx.dataDir), beforeCount, 'rejected marks must not be saved');
});

test('SO6: past-dated sold-out marks are purged by the retention job', async () => {
  withDb(ctx.dataDir, (db) =>
    db.prepare('INSERT OR IGNORE INTO soldout (date, slot_id, created_by) VALUES (?,?,?)')
      .run('2020-01-01', res1.slot_id, 'admin'));
  // Same module instance (and DB handle) as the running app — see features.test.js.
  // purgeOldData is what maintenance.start() schedules; the app runs it from the
  // listen callback, so call it directly rather than restarting the harness app
  // (which calls app.listen itself and therefore never starts maintenance).
  require('../src/maintenance').purgeOldData();
  const stale = withDb(ctx.dataDir, (db) =>
    db.prepare(`SELECT COUNT(*) AS c FROM soldout WHERE date < '2026-01-01'`).get().c);
  assert.equal(stale, 0, 'past-dated marks must be purged');
  const future = withDb(ctx.dataDir, (db) => db.prepare('SELECT COUNT(*) AS c FROM soldout').get().c);
  assert.ok(future >= 1, 'future-dated marks must survive the purge');
});
