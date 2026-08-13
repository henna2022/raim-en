'use strict';
// Boot-time safety, exercised by actually spawning `node src/app.js` (the real
// production entry point — the other suites require the module and call listen
// themselves, which bypasses both behaviours guarded here).
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { makeDataDir, withDb, APP_PATH, REPO_ROOT, todayStrKST, addDays } = require('./helper');

// Mirrors src/db.js hashPassword. Deliberately NOT `require`d from src/db.js:
// requiring that module opens a database at DATA_DIR, which is unset in this
// file (it spawns subprocesses instead of using startApp) and would therefore
// open the real ./data/raim.db.
function passwordMatches(password, salt, expectedHash) {
  return crypto.scryptSync(password, salt, 64).toString('hex') === expectedHash;
}

function runApp(env, { killAfterMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = execFile('node', [APP_PATH], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 15000,
    }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
    if (killAfterMs) setTimeout(() => child.kill('SIGKILL'), killAfterMs);
  });
}

// A reservation old enough for the retention purge to delete, plus a confirmed
// visit tomorrow that sendReminders would email.
function seedPurgeableData(dataDir) {
  return withDb(dataDir, (db) => {
    const slotId = db.prepare('SELECT id FROM slots WHERE active = 1 LIMIT 1').get().id;
    const ins = db.prepare(`INSERT INTO reservations
      (code, slot_id, visit_date, name, email, country, party_size, notes, status)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    ins.run('RAIM-PURGE1', slotId, addDays(todayStrKST(), -400), 'Old Visitor', 'old@example.com', '', 2, '', 'attended');
    ins.run('RAIM-REMIND', slotId, addDays(todayStrKST(), 1), 'Tomorrow Visitor', 'tomorrow@example.com', '', 2, '', 'confirmed');
    return {
      reservations: db.prepare('SELECT COUNT(*) AS c FROM reservations').get().c,
      emails: db.prepare('SELECT COUNT(*) AS c FROM email_log').get().c,
    };
  });
}
function counts(dataDir) {
  return withDb(dataDir, (db) => ({
    reservations: db.prepare('SELECT COUNT(*) AS c FROM reservations').get().c,
    emails: db.prepare('SELECT COUNT(*) AS c FROM email_log').get().c,
  }));
}

test('BG1: a production boot without SESSION_SECRET exits 1 and mutates nothing', async () => {
  const dataDir = makeDataDir();
  // First boot (dev mode) creates the schema so there is real data to lose.
  await runApp({ DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: '0' }, { killAfterMs: 2500 });
  const before = seedPurgeableData(dataDir);

  const res = await runApp({ DATA_DIR: dataDir, NODE_ENV: 'production', SESSION_SECRET: '' });
  assert.equal(res.code, 1, 'must refuse to boot');
  assert.match(res.stderr, /SESSION_SECRET must be set in production/);

  const after = counts(dataDir);
  assert.equal(after.reservations, before.reservations,
    'a refused boot must not run the retention purge — restart loops would replay it');
  assert.equal(after.emails, before.emails,
    'a refused boot must not send reminder/digest mail — restart loops would replay it');
});

test('BG2: the app binds loopback by default, and HOST overrides it', async () => {
  const dataDir = makeDataDir();
  const res = await runApp(
    { DATA_DIR: dataDir, PORT: '4399', SESSION_SECRET: 'boot-guard-secret' },
    { killAfterMs: 3000 },
  );
  assert.match(res.stdout, /running at http:\/\/127\.0\.0\.1:4399/,
    'default bind must be loopback so the port is never publicly reachable behind nginx');

  const res2 = await runApp(
    { DATA_DIR: makeDataDir(), PORT: '4398', HOST: '0.0.0.0', SESSION_SECRET: 'boot-guard-secret' },
    { killAfterMs: 3000 },
  );
  assert.match(res2.stdout, /running at http:\/\/0\.0\.0\.0:4398/,
    'HOST must still allow binding all interfaces (containers need this)');
});

test('BG3: production seeding never uses the git-committed dev password', async () => {
  const dataDir = makeDataDir();
  const res = await runApp(
    { DATA_DIR: dataDir, PORT: '4397', NODE_ENV: 'production', SESSION_SECRET: 'boot-guard-secret', ADMIN_INITIAL_PASSWORD: '' },
    { killAfterMs: 3000 },
  );
  assert.match(res.stdout, /Created initial admin account/);
  assert.ok(!res.stdout.includes('raim2026!'),
    'the public dev password must never seed a production host');

  const row = withDb(dataDir, (db) => db.prepare(`SELECT pw_salt, pw_hash FROM staff WHERE username = 'admin'`).get());
  assert.equal(passwordMatches('raim2026!', row.pw_salt, row.pw_hash), false,
    'the seeded production password must not be the committed default');
});
