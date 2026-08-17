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

-- 보존기한이 지나 파기된 예약을 Google 시트에서도 지우기 위한 큐. 시트가 잠시
-- 죽어도 코드가 남아 다음 주기에 재시도되므로, DB에서만 지워지고 시트에는 개인정보가
-- 남는 상황을 막는다(src/sheets.js).
CREATE TABLE IF NOT EXISTS sheet_deletes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 시트 쪽에서 "지울 행을 못 찾음"으로 돌아온 횟수. 실측에서 동기화 직후 삭제를
-- 보내면 시트 읽기가 아직 새 행을 못 봐 0건이 나오는 경합이 있었다. 그때 큐를
-- 비우면 파기된 개인정보가 시트에 영구히 남으므로, 몇 번 더 시도한다.

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
// Google 시트 미러 반영 여부. 0이면 유지보수 루프가 재전송한다(src/sheets.js).
// 기본값 0이므로 시트를 나중에 연결해도 기존 예약이 자동으로 채워진다.
ensureColumn('reservations', 'sheet_synced', 'sheet_synced INTEGER NOT NULL DEFAULT 0');
// 공휴일에도 추가로 여는 회차(기획전시 09:30). 요일 목록만으로는 표현할 수 없어
// 별도 플래그로 둔다 — src/helpers.js slotRunsOn 참고.
ensureColumn('slots', 'also_on_holiday', 'also_on_holiday INTEGER NOT NULL DEFAULT 0');
ensureColumn('sheet_deletes', 'attempts', 'attempts INTEGER NOT NULL DEFAULT 0');

// 상태나 개인정보가 바뀌면 자동으로 미러 대기열에 다시 넣는다. 새 코드 경로에서
// sheets.nudge()를 부르는 걸 잊어도 시트가 조용히 낡지 않도록 하는 안전망.
// `AFTER UPDATE OF <cols>`라서 sheet_synced 자체를 갱신할 때는 발화하지 않는다(무한루프 없음).
db.exec(`
CREATE TRIGGER IF NOT EXISTS trg_reservations_sheet_dirty
AFTER UPDATE OF status, name, email, country, party_size, notes, visit_date, slot_id,
                decided_at, decided_by, decline_reason
ON reservations
BEGIN
  UPDATE reservations SET sheet_synced = 0 WHERE id = NEW.id;
END;
`);

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
    // The dev default below is public (checked into git), so a production host
    // must never be seeded with it — anyone could log in between first boot and
    // the operator's password change. In production use ADMIN_INITIAL_PASSWORD
    // if supplied, otherwise mint a random one and print it once.
    const isProd = process.env.NODE_ENV === 'production';
    const initialPassword = process.env.ADMIN_INITIAL_PASSWORD
      || (isProd ? crypto.randomBytes(12).toString('base64url') : 'raim2026!');
    const { salt, hash } = hashPassword(initialPassword);
    db.prepare('INSERT INTO staff (username, name, role, pw_salt, pw_hash) VALUES (?,?,?,?,?)')
      .run('admin', 'Administrator', 'admin', salt, hash);
    console.log(`[seed] Created initial admin account — username: admin / password: ${initialPassword} (change it in Admin > Staff)`);
    if (isProd) console.log('[seed] ^ This password is shown only once. Save it now, then change it after logging in.');
  }

  const slotCount = db.prepare('SELECT COUNT(*) AS c FROM slots').get().c;
  if (slotCount === 0) {
    // Official timetable (see 관람시간표). Tue–Sun = '2,3,4,5,6,0'. Museum closed Mondays.
    // English docent (notice 2026-05-29): permanent Wed 15:40, special Wed 16:30.
    // 모든 회차는 40분. 해설은 한국어가 기본이고, 수요일 상설 5회차(15:40)와
    // 기획 6회차(16:30)만 영어 도슨트다 — 그 외 회차의 외국인 방문객에게는
    // 영어 녹음 오디오가이드(MP3)를 제공한다.
    const TUE_SUN = '2,3,4,5,6,0';
    const TUE_SUN_NO_WED = '2,4,5,6,0';
    const WED = '3';
    const WEEKEND = '6,0'; // 토·일
    const rows = [
      // 상설전시 — 화~일 6회차, 매일 동일
      ['permanent', '09:40', '10:20', 'ko', TUE_SUN, 'Permanent Exhibition Tour #1'],
      ['permanent', '10:40', '11:20', 'ko', TUE_SUN, 'Permanent Exhibition Tour #2'],
      ['permanent', '12:10', '12:50', 'ko', TUE_SUN, 'Permanent Exhibition Tour #3'],
      ['permanent', '14:40', '15:20', 'ko', TUE_SUN, 'Permanent Exhibition Tour #4'],
      ['permanent', '15:40', '16:20', 'ko', TUE_SUN_NO_WED, 'Permanent Exhibition Tour #5'],
      ['permanent', '15:40', '16:20', 'en', WED, 'Permanent Exhibition Tour #5 — ENGLISH docent'],
      ['permanent', '16:40', '17:20', 'ko', TUE_SUN, 'Permanent Exhibition Tour #6'],
      // 기획전시 — 09:30은 주말만 운영. 그래서 회차 번호가 평일/주말에 달라진다
      // (평일 16:30 = 6회차, 주말 16:30 = 7회차). 번호는 날짜별로 계산한다.
      ['special', '09:30', '10:10', 'ko', WEEKEND, 'Special Exhibition Tour 09:30 (weekends & public holidays)', 1],
      ['special', '10:30', '11:10', 'ko', TUE_SUN, 'Special Exhibition Tour 10:30'],
      ['special', '11:30', '12:10', 'ko', TUE_SUN, 'Special Exhibition Tour 11:30'],
      ['special', '13:30', '14:10', 'ko', TUE_SUN, 'Special Exhibition Tour 13:30'],
      ['special', '14:30', '15:10', 'ko', TUE_SUN, 'Special Exhibition Tour 14:30'],
      ['special', '15:30', '16:10', 'ko', TUE_SUN, 'Special Exhibition Tour 15:30'],
      ['special', '16:30', '17:10', 'ko', TUE_SUN_NO_WED, 'Special Exhibition Tour 16:30'],
      ['special', '16:30', '17:10', 'en', WED, 'Special Exhibition Tour 16:30 — ENGLISH docent'],
    ];
    const ins = db.prepare('INSERT INTO slots (tour_type, start_time, end_time, language, weekdays, label, also_on_holiday) VALUES (?,?,?,?,?,?,?)');
    for (const r of rows) ins.run(r[0], r[1], r[2], r[3], r[4], r[5], r[6] || 0);
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
    max_party_size: '5',
    // 예약 오픈일 — 매달 이 날짜에 '다음 달' 전체가 열린다(기본 10일: 8/10 → 9월 오픈).
    // 예약 가능 범위는 src/helpers.js bookingMaxDate 참고. (구 booking_window_days는
    // 더 이상 쓰지 않지만, 기존 배포 DB 호환을 위해 값 자체는 남겨 둔다.)
    booking_open_day: '10',
    booking_window_days: '60',
    reply_sla_text: 'Requests are usually reviewed within 2 business days (the museum is closed on Mondays).',
    staff_notify_email: 'raim@seoulraim.com',
    retention_days: '90',
    noshow_retention_days: '365',
    digest_hour: '9',
    // Marks today as already-digested so neither a fresh install nor an upgrade
    // of an existing database fires an unannounced digest — containing the whole
    // pending backlog and visitor PII — the moment the process boots. The first
    // real digest goes out next morning at digest_hour. INSERT OR IGNORE means
    // this never overwrites a live value.
    digest_last_sent: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date()),
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

// 일회성 시간표 정정 (기존 DB용). 초기 시드가 상설 4개 회차를 50분으로 넣었고,
// 기획 주말 09:30 회차가 빠져 있었다. 실제 운영은 전 회차 40분이다.
// 안전장치 두 겹: ① settings 플래그로 한 번만 실행 ② 예전 시드 값과 정확히
// 일치할 때만 수정하므로, 직원이 Schedule에서 손본 회차는 건드리지 않는다.
function correctScheduleTo40Minutes() {
  const already = db.prepare(`SELECT 1 FROM settings WHERE key = 'schedule_40min_fix'`).get();
  if (already) return;

  const fix = db.prepare(
    `UPDATE slots SET end_time = ? WHERE tour_type = ? AND start_time = ? AND end_time = ?`
  );
  const corrections = [
    ['permanent', '10:40', '11:30', '11:20'],
    ['permanent', '12:10', '13:00', '12:50'],
    ['permanent', '14:40', '15:30', '15:20'],
    ['permanent', '15:40', '16:30', '16:20'], // ko(수요일 제외) + en(수요일) 두 행 모두
  ];
  let changed = 0;
  for (const [type, start, oldEnd, newEnd] of corrections) {
    changed += fix.run(newEnd, type, start, oldEnd).changes;
  }

  const hasWeekendEarly = db.prepare(
    `SELECT 1 FROM slots WHERE tour_type = 'special' AND start_time = '09:30'`
  ).get();
  if (!hasWeekendEarly) {
    db.prepare(`INSERT INTO slots (tour_type, start_time, end_time, language, weekdays, label)
                VALUES ('special','09:30','10:10','ko','6,0','Special Exhibition Tour 09:30 (weekends & public holidays)')`).run();
    changed += 1;
  }

  // 09:30 회차는 공휴일에도 운영한다
  changed += db.prepare(
    `UPDATE slots SET also_on_holiday = 1 WHERE tour_type = 'special' AND start_time = '09:30' AND also_on_holiday = 0`
  ).run().changes;
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('schedule_40min_fix','1')`).run();
  if (changed > 0) console.log(`[schedule] 시간표 정정 ${changed}건 적용 (전 회차 40분, 기획 주말 09:30 추가)`);
}
correctScheduleTo40Minutes();

// 일회성 정정: 1회 예약 인원 상한 6 → 5.
// 별도 플래그를 쓰는 이유는 위 주석 참고 — 정정마다 플래그를 따로 둔다.
function correctMaxPartySize() {
  const already = db.prepare(`SELECT 1 FROM settings WHERE key = 'max_party_5_fix'`).get();
  if (already) return;
  const changed = db.prepare(`UPDATE settings SET value='5' WHERE key='max_party_size' AND value='6'`).run().changes;
  db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES ('max_party_5_fix','1')`).run();
  if (changed) console.log('[settings] 1회 예약 인원 상한을 5명으로 정정');
}
correctMaxPartySize();

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
