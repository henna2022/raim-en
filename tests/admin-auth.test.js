'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, restartApp, newJar,
  get, post, postForm, getCsrf, adminLogin,
} = require('./helper');

let ctx;

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('C1: GET /admin while logged out -> 302 -> /admin/login', async () => {
  const res = await get(ctx.baseUrl, ctx.jar, '/admin');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/login');
});

test('C2: wrong password -> 401, generalized message (no username enumeration)', async () => {
  const res = await adminLogin(ctx.baseUrl, ctx.jar, { username: 'admin', password: 'totally-wrong' });
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.match(body, /Invalid username or password/);
  // Same message for a nonexistent username too — a client must not be able
  // to distinguish "wrong password" from "no such user" from the wording.
  const res2 = await adminLogin(ctx.baseUrl, ctx.jar, { username: 'nobody-here', password: 'totally-wrong' });
  assert.equal(res2.status, 401);
  const body2 = await res2.text();
  assert.match(body2, /Invalid username or password/);
});

test('C3: correct login -> 302, then GET /admin -> 200', async () => {
  const res = await adminLogin(ctx.baseUrl, ctx.jar, {});
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin');

  const dash = await get(ctx.baseUrl, ctx.jar, '/admin');
  assert.equal(dash.status, 200);
});

test('C4: logout -> subsequent GET /admin -> 302 -> login', async () => {
  const csrf = await getCsrf(ctx.baseUrl, ctx.jar, '/admin/schedule');
  const res = await post(ctx.baseUrl, ctx.jar, '/admin/logout', { _csrf: csrf });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin/login');

  const dash = await get(ctx.baseUrl, ctx.jar, '/admin');
  assert.equal(dash.status, 302);
  assert.equal(dash.headers.get('location'), '/admin/login');
});

test('C5: staff-role account created by admin -> GET /admin/staff -> 403', async () => {
  // Log back in as admin to create the staff account.
  await adminLogin(ctx.baseUrl, ctx.jar, {});
  const createRes = await postForm(ctx.baseUrl, ctx.jar, '/admin/staff', {
    username: 'deskstaff', name: 'Desk Staff', password: 'deskpass123', role: 'staff',
  }, { csrfPage: '/admin/schedule' });
  assert.equal(createRes.status, 302);
  assert.match(createRes.headers.get('location') || '', /saved=1/);

  // Fresh jar: log in as the new staff account and confirm it's restricted.
  const staffJar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, staffJar, { username: 'deskstaff', password: 'deskpass123' });
  assert.equal(loginRes.status, 302);

  const staffPage = await get(ctx.baseUrl, staffJar, '/admin/staff');
  assert.equal(staffPage.status, 403);
});

test('C6: session persists across app restart (same DATA_DIR)', async () => {
  const freshJar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, freshJar, {});
  assert.equal(loginRes.status, 302);

  await restartApp(ctx);

  const dash = await get(ctx.baseUrl, freshJar, '/admin');
  assert.equal(dash.status, 200);
});
