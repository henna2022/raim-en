'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, withDb, newJar,
  get, postForm, makeReservation, uniqueEmail,
} = require('./helper');

let ctx;
let resA; // reservation used across B1-B4

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  resA = await makeReservation(ctx.baseUrl, ctx.jar, {});
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('B1: correct code+email lookup -> 200, status banner shown', async () => {
  const res = await get(ctx.baseUrl, ctx.jar, `/booking?code=${encodeURIComponent(resA.code)}&email=${encodeURIComponent(resA.email)}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /status-banner/);
  assert.match(body, /Pending review/);
  assert.match(body, new RegExp(resA.code));
});

test('B2: correct code, wrong email -> "No booking found", reservation details not exposed', async () => {
  const res = await get(ctx.baseUrl, ctx.jar, `/booking?code=${encodeURIComponent(resA.code)}&email=${encodeURIComponent('someone-else@example.com')}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /No booking found/);
  // The code is legitimately echoed back into the search form's own input
  // value (it's what the visitor just typed) — what must NOT leak is the
  // matched reservation's details (name, visit date/time, party size etc.).
  assert.doesNotMatch(body, /Test Visitor/);
  assert.doesNotMatch(body, /class="kv"/);
  assert.doesNotMatch(body, new RegExp(resA.date));
});

test('B3: cancel a pending reservation -> 302, status becomes cancelled, cancel email logged', async () => {
  const res = await postForm(ctx.baseUrl, ctx.jar, '/booking/cancel', {
    code: resA.code, email: resA.email,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /cancelled=1/);

  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT status FROM reservations WHERE code = ?').get(resA.code);
    assert.equal(row.status, 'cancelled');
    const emails = db.prepare(
      `SELECT COUNT(*) AS c FROM email_log WHERE to_addr = ? AND subject LIKE '%cancelled%'`
    ).get(resA.email).c;
    assert.equal(emails, 1);
  });
});

test('B4: cancel an already-cancelled reservation -> 302, status stays cancelled, no error', async () => {
  const res = await postForm(ctx.baseUrl, ctx.jar, '/booking/cancel', {
    code: resA.code, email: resA.email,
  });
  assert.equal(res.status, 302);
  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT status FROM reservations WHERE code = ?').get(resA.code);
    assert.equal(row.status, 'cancelled');
  });
});

test('B5: cancel attempt with wrong email -> no status change', async () => {
  const resB = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  const res = await postForm(ctx.baseUrl, ctx.jar, '/booking/cancel', {
    code: resB.code, email: 'wrong-email@example.com',
  });
  assert.equal(res.status, 302); // route always redirects, regardless of match
  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT status FROM reservations WHERE code = ?').get(resB.code);
    assert.equal(row.status, 'pending');
  });
});
