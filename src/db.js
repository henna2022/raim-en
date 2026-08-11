'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'raim.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// ---------- schema ----------
db.exec(`
CREATE TABLE IF NOT EXISTS staff (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'staff',          -- 'admin' | 'staff'
  pw_salt TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tour_type TEXT NOT NULL,                     -- 'permanent' | 'special'
  start_time TEXT NOT NULL,                    -- 'HH:MM'
  end_time TEXT NOT NULL,
  language TEXT NOT NULL DEFAULT 'ko',         -- 'ko' | 'en'
  weekdays TEXT NOT NULL,                      -- CSV of JS weekday numbers, e.g. '2,3,4,5,6,0' (Tue–Sun)
  label TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS closures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL UNIQUE,                   -- 'YYYY-MM-DD'
  kind TEXT NOT NULL DEFAULT 'closed',         -- 'closed' (extra closure) | 'open' (open on a Monday, e.g. public holiday)
  reason TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  slot_id INTEGER NOT NULL REFERENCES slots(id),
  visit_date TEXT NOT NULL,                    -- 'YYYY-MM-DD'
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  party_size INTEGER NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',      -- pending|confirmed|declined|cancelled|attended|no_show
  decline_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  decided_by TEXT
);

CREATE TABLE IF NOT EXISTS notices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general',    -- general|hours|parking|event
  pinned INTEGER NOT NULL DEFAULT 0,
  published INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A (date, session) the staff marked "fully booked" on the yeyak side. The
-- booking form stops offering it, and POST /reserve rejects it server-side,
-- so visitors stop filing requests that can only be declined.
CREATE TABLE IF NOT EXISTS soldout (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,                          -- 'YYYY-MM-DD'
  slot_id INTEGER NOT NULL REFERENCES slots(id),
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(date, slot_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_addr TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,             -- 1 = delivered via SMTP, 0 = outbox (dev mode)
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires INTEGER NOT NULL   -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_res_date ON reservations(visit_date);
CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(status);
`);

// ---------- lightweight migrations ----------
function ensureColumn(table, col, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
// yeyak release queue: set when a CONFIRMED reservation is cancelled — staff must
// unblock the seats they reserved in the Seoul public reservation (yeyak) admin.
ensureColumn('reservations', 'release_needed', 'release_needed INTEGER NOT NULL DEFAULT 0');
ensureColumn('reservations', 'released_at', 'released_at TEXT');
ensureColumn('reservations', 'released_by', 'released_by TEXT');
// Batch A: tracks whether the day-before-visit reminder email has been sent,
// so sendReminders() never emails the same reservation twice.
ensureColumn('reservations', 'reminder_sent', 'reminder_sent INTEGER NOT NULL DEFAULT 0');

// ---------- password helpers ----------
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(expectedHash, 'hex'));
}

// ---------- seed ----------
function seed() {
  const staffCount = db.prepare('SELECT COUNT(*) AS c FROM staff').get().c;
  if (staffCount === 0) {
    const { salt, hash } = hashPassword('raim2026!');
    db.prepare('INSERT INTO staff (username, name, role, pw_salt, pw_hash) VALUES (?,?,?,?,?)')
      .run('admin', 'Administrator', 'admin', salt, hash);
    console.log('[seed] Created initial admin account — username: admin / password: raim2026! (change it in Admin > Staff)');
  }

  const slotCount = db.prepare('SELECT COUNT(*) AS c FROM slots').get().c;
  if (slotCount === 0) {
    // Official timetable (see 관람시간표). Tue–Sun = '2,3,4,5,6,0'. Museum closed Mondays.
    // English docent (notice 2026-05-29): permanent Wed 15:40, special Wed 16:30.
    const TUE_SUN = '2,3,4,5,6,0';
    const TUE_SUN_NO_WED = '2,4,5,6,0';
    const WED = '3';
    const rows = [
      ['permanent', '09:40', '10:20', 'ko', TUE_SUN, 'Permanent Exhibition Tour #1'],
      ['permanent', '10:40', '11:30', 'ko', TUE_SUN, 'Permanent Exhibition Tour #2'],
      ['permanent', '12:10', '13:00', 'ko', TUE_SUN, 'Permanent Exhibition Tour #3'],
      ['permanent', '14:40', '15:30', 'ko', TUE_SUN, 'Permanent Exhibition Tour #4'],
      ['permanent', '15:40', '16:30', 'ko', TUE_SUN_NO_WED, 'Permanent Exhibition Tour #5'],
      ['permanent', '15:40', '16:30', 'en', WED, 'Permanent Exhibition Tour — ENGLISH docent'],
      ['permanent', '16:40', '17:20', 'ko', TUE_SUN, 'Permanent Exhibition Tour #6'],
      ['special', '10:30', '11:10', 'ko', TUE_SUN, 'Special Exhibition Tour #1'],
      ['special', '11:30', '12:10', 'ko', TUE_SUN, 'Special Exhibition Tour #2'],
      ['special', '13:30', '14:10', 'ko', TUE_SUN, 'Special Exhibition Tour #3'],
      ['special', '14:30', '15:10', 'ko', TUE_SUN, 'Special Exhibition Tour #4'],
      ['special', '15:30', '16:10', 'ko', TUE_SUN, 'Special Exhibition Tour #5'],
      ['special', '16:30', '17:10', 'ko', TUE_SUN_NO_WED, 'Special Exhibition Tour #6'],
      ['special', '16:30', '17:10', 'en', WED, 'Special Exhibition Tour — ENGLISH docent'],
    ];
    const ins = db.prepare('INSERT INTO slots (tour_type, start_time, end_time, language, weekdays, label) VALUES (?,?,?,?,?,?)');
    for (const r of rows) ins.run(...r);
  }

  const noticeCount = db.prepare('SELECT COUNT(*) AS c FROM notices').get().c;
  if (noticeCount === 0) {
    const ins = db.prepare('INSERT INTO notices (title, body, category, pinned) VALUES (?,?,?,?)');
    ins.run(
      'English docent tours every Wednesday',
      'Free English-language docent tours run every Wednesday: Permanent Exhibition at 15:40 and Special Exhibition at 16:30. Advance reservation is required — use the booking form on this site.',
      'event', 1
    );
    ins.run(
      'Free open viewing on Aug 22–23 (2nd anniversary)',
      'To celebrate our 2nd anniversary, the Permanent Exhibition Hall is open for free self-guided viewing on August 22–23, 09:30–17:20, no reservation needed.',
      'event', 1
    );
    ins.run(
      'Parking is limited — public transport recommended',
      'The museum parking lot is small and subject to access restrictions. We strongly recommend arriving by subway: Line 1 or 4 to Chang-dong Station, Exit 1, then a 5-minute walk.',
      'parking', 0
    );
  }

  const defaults = {
    contact_email: 'raim@seoulraim.com',
    contact_phone: '+82-2-920-4300',
    address_en: '56, Madeul-ro 13-gil, Dobong-gu, Seoul, Republic of Korea',
    max_party_size: '6',
    booking_window_days: '60',
    reply_sla_text: 'Requests are usually reviewed within 2 business days (the museum is closed on Mondays).',
    staff_notify_email: 'raim@seoulraim.com',
    retention_days: '90',
    noshow_retention_days: '365',
    digest_hour: '9',
    // yeyak helper links shown on the dashboard. The service pages are opened
    // monthly on yeyak (one per exhibition per month), so staff paste the fresh
    // URLs here each month; empty = the dashboard just hides the link.
    yeyak_url_permanent: '',
    yeyak_url_special: '',
    yeyak_admin_url: '',
  };
  const insSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?,?)');
  for (const [k, v] of Object.entries(defaults)) insSetting.run(k, v);
}
seed();

// ---------- settings helpers ----------
function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

module.exports = { db, hashPassword, verifyPassword, getSettings, setSetting };
