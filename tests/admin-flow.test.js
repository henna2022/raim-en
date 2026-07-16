'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, withDb, newJar,
  get, postAdminForm, postFormNoCsrf, makeReservation, adminLogin, uniqueEmail,
} = require('./helper');

let ctx;
let res1, res2, res3, res4; // {code, email, ...} from makeReservation

function reservationId(dataDir, code) {
  return withDb(dataDir, (db) => db.prepare('SELECT id FROM reservations WHERE code = ?').get(code).id);
}
function reservationStatus(dataDir, code) {
  return withDb(dataDir, (db) => db.prepare('SELECT status FROM reservations WHERE code = ?').get(code).status);
}

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, ctx.jar, {});
  assert.equal(loginRes.status, 302, 'admin login must succeed before admin-flow tests run');

  // 4 independent pending reservations to exercise the transition matrix
  // without any two tests racing over the same row's status.
  res1 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  res2 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  res3 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  res4 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('D1: confirm without the yeyak checkbox -> 400, status stays pending', async () => {
  const id = reservationId(ctx.dataDir, res1.code);
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/confirm`, {});
  assert.equal(res.status, 400);
  assert.equal(reservationStatus(ctx.dataDir, res1.code), 'pending');
});

test('D2: confirm with the checkbox -> confirmed, decided_by=admin, confirmation email logged', async () => {
  const id = reservationId(ctx.dataDir, res1.code);
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/confirm`, {
    yeyak_blocked: 'on',
  });
  assert.equal(res.status, 302);
  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT status, decided_by FROM reservations WHERE code = ?').get(res1.code);
    assert.equal(row.status, 'confirmed');
    assert.equal(row.decided_by, 'admin');
    const emails = db.prepare(
      `SELECT COUNT(*) AS c FROM email_log WHERE to_addr = ? AND subject LIKE '%confirmed%'`
    ).get(res1.email).c;
    assert.equal(emails, 1);
  });
});

test('D3: decline + reason -> declined, reason appears in the email body', async () => {
  const id = reservationId(ctx.dataDir, res2.code);
  const reason = 'Session fully booked for that date';
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/decline`, {
    decline_reason: reason,
  });
  assert.equal(res.status, 302);
  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT status, decline_reason FROM reservations WHERE code = ?').get(res2.code);
    assert.equal(row.status, 'declined');
    assert.equal(row.decline_reason, reason);
    const email = db.prepare(
      `SELECT html FROM email_log WHERE to_addr = ? AND subject LIKE '%About your request%' ORDER BY id DESC LIMIT 1`
    ).get(res2.email);
    assert.ok(email, 'expected a decline email to be logged');
    assert.match(email.html, new RegExp(reason));
  });
});

test('D4: attended on a pending reservation -> 400', async () => {
  const id = reservationId(ctx.dataDir, res3.code);
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/attended`, {});
  assert.equal(res.status, 400);
  assert.equal(reservationStatus(ctx.dataDir, res3.code), 'pending');
});

test('D5: confirmed -> no_show', async () => {
  // res1 is confirmed (from D2).
  const id = reservationId(ctx.dataDir, res1.code);
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/no_show`, {});
  assert.equal(res.status, 302);
  assert.equal(reservationStatus(ctx.dataDir, res1.code), 'no_show');
});

test('D6: confirmed -> staff cancel -> cancelled + email', async () => {
  const id4 = reservationId(ctx.dataDir, res4.code);
  const confirmRes = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id4}/confirm`, {
    yeyak_blocked: 'on',
  });
  assert.equal(confirmRes.status, 302);
  assert.equal(reservationStatus(ctx.dataDir, res4.code), 'confirmed');

  const cancelRes = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id4}/cancel`, {});
  assert.equal(cancelRes.status, 302);
  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT status FROM reservations WHERE code = ?').get(res4.code);
    assert.equal(row.status, 'cancelled');
    const emails = db.prepare(
      `SELECT COUNT(*) AS c FROM email_log WHERE to_addr = ? AND subject LIKE '%cancelled%'`
    ).get(res4.email).c;
    assert.equal(emails, 1);
  });
});

test('D7: declined -> reopen -> pending', async () => {
  // res2 is declined (from D3).
  const id = reservationId(ctx.dataDir, res2.code);
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/reopen`, {});
  assert.equal(res.status, 302);
  assert.equal(reservationStatus(ctx.dataDir, res2.code), 'pending');
});

test('D8: nonexistent action name -> 400', async () => {
  const id = reservationId(ctx.dataDir, res3.code);
  const before = reservationStatus(ctx.dataDir, res3.code);
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/not-a-real-action`, {});
  assert.equal(res.status, 400);
  assert.equal(reservationStatus(ctx.dataDir, res3.code), before);
});

test('D9: GET /admin/reservations.csv -> 200, text/csv, contains a reservation code', async () => {
  const res = await get(ctx.baseUrl, ctx.jar, '/admin/reservations.csv');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/csv/);
  const body = await res.text();
  assert.match(body, new RegExp(res1.code));
});

test('D10: confirm POST without CSRF token -> 403, status unchanged', async () => {
  // res3 is still pending (untouched by D4/D8).
  const id = reservationId(ctx.dataDir, res3.code);
  const before = reservationStatus(ctx.dataDir, res3.code);
  const res = await postFormNoCsrf(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/confirm`, {
    yeyak_blocked: 'on',
  });
  assert.equal(res.status, 403);
  assert.equal(reservationStatus(ctx.dataDir, res3.code), before);
});
