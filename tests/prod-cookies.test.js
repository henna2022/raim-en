'use strict';
// Production cookie hardening: both cookies the app sets must carry Secure when
// NODE_ENV=production, so neither the session nor the CSRF token can travel over
// a plaintext downgrade. Runs its own production-mode app instance (its own
// DATA_DIR), separate from the other suites' development-mode instances.
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDataDir, startApp, stopApp, newJar, get, request, getCsrf } = require('./helper');

// Behind a TLS-terminating proxy the app only sees HTTPS via this header, and
// express-session refuses to set a `secure` cookie without it — so every
// production request in this suite carries it, exactly like the documented
// nginx config (docs/DEPLOY.md ⑤) does.
const PROXY_HTTPS = { 'X-Forwarded-Proto': 'https' };

let ctx;
const savedEnv = {};
// In production the seed refuses to use the git-committed dev password and
// mints a random one instead, so this suite supplies its own via the documented
// ADMIN_INITIAL_PASSWORD escape hatch (which it also exercises).
const ADMIN_PASSWORD = 'prod-suite-initial-password';

test.before(async () => {
  for (const k of ['NODE_ENV', 'SESSION_SECRET', 'TRUST_PROXY', 'ADMIN_INITIAL_PASSWORD']) savedEnv[k] = process.env[k];
  process.env.NODE_ENV = 'production';
  process.env.SESSION_SECRET = 'test-only-secret-for-prod-cookie-suite';
  process.env.TRUST_PROXY = '1'; // TLS terminated by a proxy, as documented in DEPLOY.md
  process.env.ADMIN_INITIAL_PASSWORD = ADMIN_PASSWORD;
  ctx = await startApp(makeDataDir());
});
test.after(async () => {
  await stopApp(ctx.server);
  // Restore so a later suite in the same process isn't left in production mode.
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

function flagsOf(setCookieHeaders, name) {
  const raw = setCookieHeaders.find(c => c.startsWith(name + '='));
  if (!raw) return null;
  return {
    secure: /;\s*Secure/i.test(raw),
    httpOnly: /;\s*HttpOnly/i.test(raw),
    sameSite: (raw.match(/SameSite=(\w+)/i) || [])[1] || null,
  };
}

test('P1: the CSRF cookie carries Secure + HttpOnly + SameSite in production', async () => {
  const res = await get(ctx.baseUrl, newJar(), '/admin/login');
  const flags = flagsOf(res.headers.getSetCookie(), 'raim.csrf');
  assert.ok(flags, 'raim.csrf must be set on a first visit');
  assert.equal(flags.secure, true, 'CSRF cookie must be Secure in production');
  assert.equal(flags.httpOnly, true);
  assert.equal(flags.sameSite, 'Lax');
});

test('P2: the session cookie carries Secure + HttpOnly + SameSite in production', async () => {
  const jar = newJar();
  const csrf = await getCsrf(ctx.baseUrl, jar, '/admin/login');
  const res = await request(ctx.baseUrl, jar, 'POST', '/admin/login', {
    body: { username: 'admin', password: ADMIN_PASSWORD, _csrf: csrf },
    headers: PROXY_HTTPS,
  });
  assert.equal(res.status, 302, 'login must succeed so a session cookie is issued');
  const flags = flagsOf(res.headers.getSetCookie(), 'raim.sid');
  assert.ok(flags, 'raim.sid must be set on login');
  assert.equal(flags.secure, true, 'session cookie must be Secure in production');
  assert.equal(flags.httpOnly, true);
  assert.equal(flags.sameSite, 'Lax');
});

// Guards the most common production misconfiguration: TRUST_PROXY=1 set but the
// proxy not forwarding X-Forwarded-Proto. The session cookie is then silently
// never issued and no one can log in — see docs/DEPLOY.md ⑤.
test('P4: without X-Forwarded-Proto the session cookie is (correctly) withheld', async () => {
  const jar = newJar();
  const csrf = await getCsrf(ctx.baseUrl, jar, '/admin/login');
  const res = await request(ctx.baseUrl, jar, 'POST', '/admin/login', {
    body: { username: 'admin', password: ADMIN_PASSWORD, _csrf: csrf },
  });
  assert.equal(res.status, 302, 'credentials are still accepted');
  assert.equal(flagsOf(res.headers.getSetCookie(), 'raim.sid'), null,
    'no session cookie over a connection the app cannot see as HTTPS');
});

test('P3: HSTS is sent in production', async () => {
  const res = await get(ctx.baseUrl, newJar(), '/');
  assert.match(res.headers.get('strict-transport-security') || '', /max-age=\d+/);
});
