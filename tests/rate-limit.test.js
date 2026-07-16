'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, restartApp, newJar,
  post, postForm, getCsrf, uniqueEmail,
} = require('./helper');

// Dedicated file + dedicated server instance(s), per the P0-4 spec: rate/lockout
// counters are in-memory (module scope), so these tests must not share a
// process with anything that also hits /reserve or /admin/login.
let ctx;

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('R1: POST /reserve x6 (valid CSRF, content irrelevant) -> 6th is 429', async () => {
  const csrf = await getCsrf(ctx.baseUrl, ctx.jar, '/reserve');
  let last;
  for (let i = 0; i < 6; i++) {
    last = await post(ctx.baseUrl, ctx.jar, '/reserve', {
      date: 'not-a-real-date', slot_id: '1', name: '', email: uniqueEmail(),
      party_size: '2', agree: 'on', _csrf: csrf,
    });
  }
  assert.equal(last.status, 429);
});

test('R2: POST /admin/login wrong password x11 (distinct usernames) -> 11th is 429 (IP limit)', async () => {
  // Restart to get a clean IP-limiter + account-lockout Map before hammering
  // /admin/login (separate limiter from /reserve's, but isolate anyway).
  await restartApp(ctx);
  const csrf = await getCsrf(ctx.baseUrl, ctx.jar, '/admin/login');
  let last;
  for (let i = 0; i < 11; i++) {
    // A different (nonexistent) username per attempt so the per-account
    // lockout (threshold 5) never trips — this isolates the IP-based limiter
    // (max 10 / 15min) as the thing actually producing the 429 on request 11.
    last = await post(ctx.baseUrl, ctx.jar, '/admin/login', {
      username: `no-such-user-${i}`, password: 'wrong-password', _csrf: csrf,
    });
  }
  assert.equal(last.status, 429);
});

test('R3: same username x5 failed logins -> locked; correct password afterwards is still rejected', async () => {
  // Restart again: R2 alone consumed 11 of the 15-min IP-login budget, which
  // would otherwise mask the account-lockout behaviour under test here.
  await restartApp(ctx);
  const csrf = await getCsrf(ctx.baseUrl, ctx.jar, '/admin/login');
  let last;
  for (let i = 0; i < 5; i++) {
    last = await post(ctx.baseUrl, ctx.jar, '/admin/login', {
      username: 'admin', password: 'wrong-password', _csrf: csrf,
    });
  }
  // 5th failed attempt should already report the account as locked.
  assert.equal(last.status, 429);

  const afterLock = await postForm(ctx.baseUrl, ctx.jar, '/admin/login', {
    username: 'admin', password: 'raim2026!',
  }, { csrfPage: '/admin/login' });
  assert.equal(afterLock.status, 429);
});
