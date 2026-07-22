'use strict';
// HTTP hardening: security headers on every response + request body size cap.
const test = require('node:test');
const assert = require('node:assert');
const { makeDataDir, startApp, stopApp, newJar, get } = require('./helper');

let ctx;
test.before(async () => { ctx = await startApp(makeDataDir()); });
test.after(async () => { await stopApp(ctx.server); });

test('H1: security headers present on public responses', async () => {
  const res = await get(ctx.baseUrl, newJar(), '/');
  assert.strictEqual(res.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(res.headers.get('x-frame-options'), 'DENY');
  assert.strictEqual(res.headers.get('referrer-policy'), 'same-origin');
  const csp = res.headers.get('content-security-policy') || '';
  assert.ok(csp.includes("default-src 'self'"), 'CSP default-src');
  assert.ok(csp.includes("frame-ancestors 'none'"), 'CSP frame-ancestors');
  assert.ok(csp.includes("object-src 'none'"), 'CSP object-src');
});

test('H2: no HSTS outside production', async () => {
  const res = await get(ctx.baseUrl, newJar(), '/');
  assert.strictEqual(res.headers.get('strict-transport-security'), null);
});

test('H3: oversized request body is rejected with a client error', async () => {
  const res = await fetch(ctx.baseUrl + '/reserve', {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'name=' + 'x'.repeat(40000),
  });
  assert.strictEqual(res.status, 413); // Payload Too Large, not 500
});
