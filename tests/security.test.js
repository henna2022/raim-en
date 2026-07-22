'use strict';
// Security regressions: email HTML injection, CSV formula injection, ICS escaping.
const test = require('node:test');
const assert = require('node:assert');
const {
  makeDataDir, startApp, stopApp, withDb, newJar, get,
  makeReservation, adminLogin, nextWednesday,
} = require('./helper');

let ctx;

test.before(async () => {
  ctx = await startApp(makeDataDir());
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('S1: visitor-typed HTML is escaped in email templates', () => {
  const mailer = require('../src/mailer');
  const r = {
    code: 'RAIM-SEC001', name: '<img src=x onerror=alert(1)>', email: 'a@b.com',
    country: '<b>KR</b>', notes: '<script>steal()</script>', party_size: 2,
    visit_date: '2026-08-01', start_time: '09:40', end_time: '10:20',
    tour_type: 'permanent', language: 'ko', decline_reason: '<u>reason</u>',
  };
  for (const html of [
    mailer.requestReceivedEmail(r), mailer.confirmedEmail(r), mailer.declinedEmail(r),
    mailer.cancelledEmail(r), mailer.reminderEmail(r),
    mailer.staffNewRequestEmail(r), mailer.staffReleaseEmail(r),
  ]) {
    assert.ok(!html.includes('<img src=x'), 'raw <img injected');
    assert.ok(!html.includes('<script>'), 'raw <script> injected');
    assert.ok(!html.includes('<u>reason</u>'), 'raw decline_reason injected');
  }
  assert.ok(mailer.staffNewRequestEmail(r).includes('&lt;script&gt;'), 'notes should be escaped, not dropped');
});

test('S2: CSV export neutralizes formula-leading cells', async () => {
  const jar = newJar();
  await makeReservation(ctx.baseUrl, jar, {
    name: '=HYPERLINK("http://evil","x")',
    email: 'csv.inject@example.com',
    date: nextWednesday(),
  });
  const adminJar = newJar();
  await adminLogin(ctx.baseUrl, adminJar);
  const res = await get(ctx.baseUrl, adminJar, '/admin/reservations.csv');
  const body = await res.text();
  assert.strictEqual(res.status, 200);
  assert.ok(body.includes(`"'=HYPERLINK`), 'formula cell must be prefixed with a quote');
  assert.ok(!body.includes(`"=HYPERLINK`), 'unprefixed formula cell must not appear');
});

test('S3: ICS escapes commas in LOCATION per RFC 5545', () => {
  const mailer = require('../src/mailer');
  const ics = mailer.icsForReservation({
    code: 'RAIM-SEC002', visit_date: '2026-08-01', start_time: '09:40', end_time: '10:20',
    tour_type: 'special', party_size: 1,
  });
  // default address: "56, Madeul-ro 13-gil, Dobong-gu, Seoul, Republic of Korea"
  assert.ok(ics.includes('LOCATION:56\\,'), 'address commas must be escaped');
  const loc = ics.split('\r\n').find(l => l.startsWith('LOCATION:'));
  assert.ok(!/[^\\],/.test(loc), 'no unescaped comma in LOCATION');
});
