'use strict';
// Morning digest: due-time gating, once-per-day guard, content, empty/disabled paths.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, withDb, newJar,
  adminLogin, uniqueEmail, todayStrKST, addDays,
} = require('./helper');

let ctx;
let maintenance;

function setSettingDb(key, value) {
  withDb(ctx.dataDir, (db) => db.prepare(
    'INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
  ).run(key, value));
}
function resetLastSent() {
  withDb(ctx.dataDir, (db) => db.prepare(`DELETE FROM settings WHERE key = 'digest_last_sent'`).run());
}
function digestEmails() {
  return withDb(ctx.dataDir, (db) =>
    db.prepare(`SELECT subject, html FROM email_log WHERE subject LIKE '%아침 다이제스트%' ORDER BY id`).all());
}
// Direct insert so fixtures control created_at (SLA age) and release_needed.
function insertRow({ status = 'pending', hoursAgo = 1, releaseNeeded = 0, visitDate }) {
  return withDb(ctx.dataDir, (db) => {
    const slotId = db.prepare('SELECT id FROM slots WHERE active = 1 LIMIT 1').get().id;
    const code = 'DG' + Math.random().toString(36).slice(2, 9).toUpperCase();
    db.prepare(`INSERT INTO reservations
        (code, slot_id, visit_date, name, email, country, party_size, notes, status, release_needed, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now', ?))`)
      .run(code, slotId, visitDate || addDays(todayStrKST(), 3), 'Digest Fixture', uniqueEmail(), '',
        2, '', status, releaseNeeded, `-${hoursAgo} hours`);
    return code;
  });
}

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, ctx.jar, {});
  assert.equal(loginRes.status, 302, 'admin login must succeed before digest tests run');
  // Same module instance (and DB handle) as the running app — see features.test.js.
  maintenance = require('../src/maintenance');
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('DG1: due digest sends once with pending, SLA breaches and release queue', async () => {
  const fresh = insertRow({ hoursAgo: 2 });
  const late = insertRow({ hoursAgo: 60 });
  const release = insertRow({ status: 'cancelled', releaseNeeded: 1 });
  insertRow({ status: 'confirmed', visitDate: todayStrKST() });
  setSettingDb('digest_hour', '0'); // always due
  resetLastSent();

  const r = await maintenance.sendDailyDigest();
  assert.equal(r.sent, true);
  const emails = digestEmails();
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /대기 2건/);
  assert.match(emails[0].subject, /SLA 초과 1건/);
  assert.match(emails[0].subject, /yeyak 해제 1건/);
  for (const code of [fresh, late, release]) assert.ok(emails[0].html.includes(code), `digest must list ${code}`);
  assert.match(emails[0].html, /오늘 확정 방문 <strong>1건/);
});

test('DG2: second call the same day is a no-op', async () => {
  const r = await maintenance.sendDailyDigest();
  assert.deepEqual({ sent: r.sent, skipped: r.skipped }, { sent: false, skipped: 'already_sent' });
  assert.equal(digestEmails().length, 1);
});

test('DG3: not due before the configured hour', async () => {
  const nowHour = Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', hour12: false,
  }).format(new Date()));
  if (nowHour >= 23) return; // no strictly-later hour exists today (23:00-23:59 KST)
  resetLastSent();
  setSettingDb('digest_hour', String(nowHour + 1));
  const r = await maintenance.sendDailyDigest();
  assert.deepEqual({ sent: r.sent, skipped: r.skipped }, { sent: false, skipped: 'not_due' });
  assert.equal(digestEmails().length, 1);
});

test('DG4: nothing actionable -> skipped but the day is marked processed', async () => {
  withDb(ctx.dataDir, (db) => db.prepare(`UPDATE reservations SET status='declined', release_needed=0`).run());
  resetLastSent();
  setSettingDb('digest_hour', '0');
  const r = await maintenance.sendDailyDigest();
  assert.deepEqual({ sent: r.sent, skipped: r.skipped }, { sent: false, skipped: 'empty' });
  assert.equal(digestEmails().length, 1);
  const lastSent = withDb(ctx.dataDir, (db) =>
    db.prepare(`SELECT value FROM settings WHERE key = 'digest_last_sent'`).get().value);
  assert.equal(lastSent, todayStrKST(), 'empty digest must still mark the day processed');
});

test('DG5: empty digest_hour disables the digest', async () => {
  insertRow({ hoursAgo: 2 });
  resetLastSent();
  setSettingDb('digest_hour', '');
  const r = await maintenance.sendDailyDigest();
  assert.deepEqual({ sent: r.sent, skipped: r.skipped }, { sent: false, skipped: 'disabled' });
  assert.equal(digestEmails().length, 1);
});

test('DG6: no staff address -> skipped, no email logged, day marked processed', async () => {
  setSettingDb('digest_hour', '0');
  setSettingDb('staff_notify_email', '');
  resetLastSent();
  const r = await maintenance.sendDailyDigest();
  assert.deepEqual({ sent: r.sent, skipped: r.skipped }, { sent: false, skipped: 'no_address' });
  assert.equal(digestEmails().length, 1);
});

test('DG7: SMTP transport failure -> day NOT marked, next tick retries', async () => {
  setSettingDb('staff_notify_email', 'staff@example.com');
  resetLastSent();
  // Same module instance as the app (require cache) — simulate a configured
  // SMTP transport whose send fails, then restore.
  const mailer = require('../src/mailer');
  const realNotify = mailer.notifyStaff;
  const realSmtp = mailer.smtpConfigured;
  mailer.smtpConfigured = true;
  mailer.notifyStaff = async () => ({ sent: false, error: 'ETIMEDOUT' });
  try {
    const r = await maintenance.sendDailyDigest();
    assert.deepEqual({ sent: r.sent, skipped: r.skipped }, { sent: false, skipped: 'send_failed' });
    const marked = withDb(ctx.dataDir, (db) =>
      db.prepare(`SELECT value FROM settings WHERE key = 'digest_last_sent'`).get());
    assert.equal(marked, undefined, 'a failed send must not mark the day');
  } finally {
    mailer.notifyStaff = realNotify;
    mailer.smtpConfigured = realSmtp;
  }
  // Retry with the transport healthy again (outbox mode): the digest sends.
  const retry = await maintenance.sendDailyDigest();
  assert.equal(retry.sent, true);
  assert.equal(digestEmails().length, 2);
});
