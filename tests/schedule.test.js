'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, withDb, newJar,
  get, postAdminForm, makeReservation, adminLogin, nextWeekday,
} = require('./helper');

let ctx;

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, ctx.jar, {});
  assert.equal(loginRes.status, 302, 'admin login must succeed before schedule tests run');
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('E1: add a kind=closed closure on a Tuesday -> that date is closed with the reason shown', async () => {
  const date = nextWeekday(2); // Tuesday
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/schedule/closures', {
    date, kind: 'closed', reason: 'Test maintenance closure',
  });
  assert.equal(res.status, 302);

  const sessRes = await get(ctx.baseUrl, null, `/api/sessions?date=${date}`);
  const data = await sessRes.json();
  assert.equal(data.closed, true);
  assert.equal(data.reason, 'Test maintenance closure');
});

test('E2: add a kind=open closure on a Monday -> sessions for that Monday are not empty', async () => {
  const date = nextWeekday(1); // Monday
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/schedule/closures', {
    date, kind: 'open', reason: 'Public holiday makeup day',
  });
  assert.equal(res.status, 302);

  const sessRes = await get(ctx.baseUrl, null, `/api/sessions?date=${date}`);
  const data = await sessRes.json();
  assert.equal(data.closed, false);
  assert.ok(Array.isArray(data.sessions) && data.sessions.length > 0, 'expected sessions on the opened Monday');
});

test('E3: setting a slot to active=0 removes it from /api/sessions', async () => {
  const date = nextWeekday(4); // Thursday — this slot's weekdays include Thu
  const slot = withDb(ctx.dataDir, (db) => db.prepare(
    `SELECT * FROM slots WHERE start_time = '09:40' AND tour_type = 'permanent' AND language = 'ko'`
  ).get());
  assert.ok(slot, 'expected the seeded 09:40 permanent Korean slot to exist');

  const before = await (await get(ctx.baseUrl, null, `/api/sessions?date=${date}`)).json();
  assert.ok(before.sessions.some((s) => s.id === slot.id), 'slot should be present before deactivation');

  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/schedule/slots/${slot.id}`, {
    label: slot.label, tour_type: slot.tour_type, start_time: slot.start_time, end_time: slot.end_time,
    language: slot.language, weekdays: slot.weekdays.split(','),
    // active intentionally omitted -> unchecked checkbox
  });
  assert.equal(res.status, 302);

  const after = await (await get(ctx.baseUrl, null, `/api/sessions?date=${date}`)).json();
  assert.ok(!after.sessions.some((s) => s.id === slot.id), 'slot should be gone after deactivation');
});

test('E4: deleting a slot that has a reservation soft-deletes it (row kept, active=0)', async () => {
  const date = nextWeekday(5); // Friday
  const slot = withDb(ctx.dataDir, (db) => db.prepare(
    `SELECT * FROM slots WHERE start_time = '10:40' AND tour_type = 'permanent' AND language = 'ko'`
  ).get());
  assert.ok(slot, 'expected the seeded 10:40 permanent Korean slot to exist');

  const reservation = await makeReservation(ctx.baseUrl, ctx.jar, { date, slot_id: slot.id });
  assert.equal(reservation.res.status, 302);

  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/schedule/slots/${slot.id}`, {
    _delete: '1',
  });
  assert.equal(res.status, 302);

  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT * FROM slots WHERE id = ?').get(slot.id);
    assert.ok(row, 'slot row must still exist (soft delete)');
    assert.equal(row.active, 0);
  });
});

test('E5: deleting a slot with no reservations hard-deletes the row', async () => {
  const addRes = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/schedule/slots', {
    label: 'Temp Test Slot', tour_type: 'special', start_time: '08:00', end_time: '08:30',
    language: 'ko', weekdays: ['2'], active: 'on',
  });
  assert.equal(addRes.status, 302);

  const slot = withDb(ctx.dataDir, (db) => db.prepare(
    `SELECT * FROM slots WHERE label = 'Temp Test Slot'`
  ).get());
  assert.ok(slot, 'expected the newly-added slot to exist');

  const delRes = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/schedule/slots/${slot.id}`, {
    _delete: '1',
  });
  assert.equal(delRes.status, 302);

  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT * FROM slots WHERE id = ?').get(slot.id);
    assert.equal(row, undefined, 'slot row must be gone (hard delete)');
  });
});
