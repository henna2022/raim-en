'use strict';
const express = require('express');
const { db, hashPassword, verifyPassword, setSetting } = require('../db');
const {
  DATE_RE, SLA_HOURS, isValidDateStr, todayStr, addDays, weekdayOf, closureInfo, sessionsForDate, getReservation, STATUS_BADGE, getSettings,
} = require('../helpers');
const holidays = require('../holidays');
const mailer = require('../mailer');
const sheets = require('../sheets');
const { TRANSITIONS, applyDecision } = require('../decisions');
const { rateLimit } = require('../ratelimit');

const router = express.Router();

// ---------- auth ----------
function requireLogin(req, res, next) {
  if (req.session && req.session.staff) return next();
  res.redirect('/admin/login');
}
function requireAdmin(req, res, next) {
  if (req.session.staff && req.session.staff.role === 'admin') return next();
  res.status(403).render('admin/error', { staff: req.session.staff, message: 'Admin role required.' });
}

// Same wording for both IP-level and account-level lockout so a client can't
// tell the two apart (and, for account lockout, can't tell "wrong password"
// from "this username exists and is locked").
const LOCKOUT_MESSAGE = 'Too many attempts. Try again later.';

// IP-based brute-force guard, reusing P0-1's in-memory limiter.
const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  onLimit: (req, res) => {
    res.status(429).render('admin/login', { error: LOCKOUT_MESSAGE });
  },
});

// Account-based lockout: module-scope Map<username, {fails, lockedUntil}>.
// Intentionally memory-only (not persisted to DB) — resets on restart, which
// is an accepted tradeoff per the spec.
const loginAttempts = new Map();
const ACCOUNT_LOCK_THRESHOLD = 5;
const ACCOUNT_LOCK_MS = 15 * 60 * 1000;
const LOGIN_FAIL_DELAY_MS = 400;
// Bound the Map against username-spraying: drop entries whose lock has passed
// (unlocked fail counters are cheap to lose — the IP limiter still applies).
setInterval(() => {
  const now = Date.now();
  for (const [name, e] of loginAttempts) {
    if (e.lockedUntil <= now) loginAttempts.delete(name);
  }
}, 30 * 60 * 1000).unref();

router.get('/login', (req, res) => {
  if (req.session.staff) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});
router.post('/login', loginIpLimiter, async (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const ip = req.ip;
  const now = Date.now();

  const existing = loginAttempts.get(username);
  if (existing && existing.lockedUntil > now) {
    console.warn('[auth] failed login', { username, ip });
    await new Promise(r => setTimeout(r, LOGIN_FAIL_DELAY_MS));
    return res.status(429).render('admin/login', { error: LOCKOUT_MESSAGE });
  }

  const row = db.prepare('SELECT * FROM staff WHERE username = ?').get(username);
  const valid = row && verifyPassword(password, row.pw_salt, row.pw_hash);
  if (!valid) {
    const entry = loginAttempts.get(username) || { fails: 0, lockedUntil: 0 };
    entry.fails += 1;
    let justLocked = false;
    if (entry.fails >= ACCOUNT_LOCK_THRESHOLD) {
      entry.lockedUntil = now + ACCOUNT_LOCK_MS;
      justLocked = true;
    }
    loginAttempts.set(username, entry);
    console.warn('[auth] failed login', { username, ip });
    await new Promise(r => setTimeout(r, LOGIN_FAIL_DELAY_MS));
    if (justLocked) return res.status(429).render('admin/login', { error: LOCKOUT_MESSAGE });
    return res.status(401).render('admin/login', { error: 'Invalid username or password.' });
  }

  loginAttempts.delete(username);
  req.session.staff = { id: row.id, username: row.username, name: row.name, role: row.role };
  res.redirect('/admin');
});
router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

router.use(requireLogin);

// ---------- dashboard ----------
function ageInfo(createdAtUtc) {
  // created_at is SQLite datetime('now') = UTC
  const ms = Date.now() - new Date(createdAtUtc.replace(' ', 'T') + 'Z').getTime();
  const hours = Math.max(0, Math.floor(ms / 3600000));
  const label = hours < 1 ? 'just now'
    : hours < 24 ? `${hours}h ago`
    : `${Math.floor(hours / 24)}d ${hours % 24}h ago`;
  return { hours, label, late: hours >= SLA_HOURS };
}

// Pending requests grouped per (visit_date, slot) so staff can check seats in
// the yeyak admin ONCE per session and confirm the whole group in one action,
// instead of swivel-chairing to yeyak for every single request.
const KO_WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];
function groupPending(pending) {
  const groups = new Map();
  for (const r of pending) {
    const key = `${r.visit_date}|${r.slot_id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key: `${r.visit_date}-${r.slot_id}`,
        visit_date: r.visit_date,
        ko_weekday: KO_WEEKDAYS[weekdayOf(r.visit_date)],
        slot_id: r.slot_id,
        tour_type: r.tour_type,
        start_time: r.start_time,
        end_time: r.end_time,
        language: r.language,
        requests: [],
        seats: 0,
        late: false,
      });
    }
    const g = groups.get(key);
    g.requests.push(r);
    g.seats += r.party_size;
    if (r.age.late) g.late = true;
  }
  // Flag groups whose session is already marked fully booked — staff should be
  // waitlisting or declining these, not blocking more yeyak seats.
  const soldoutCheck = db.prepare('SELECT 1 FROM soldout WHERE date = ? AND slot_id = ?');
  // Older waitlisted requests outrank newer pending ones for the same session —
  // surface them on the group so a batch confirm doesn't silently jump the FIFO.
  const waitlistCheck = db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE status = 'waitlisted' AND visit_date = ? AND slot_id = ?`);
  for (const g of groups.values()) {
    g.soldout = !!soldoutCheck.get(g.visit_date, g.slot_id);
    g.waitlist_count = waitlistCheck.get(g.visit_date, g.slot_id).c;
  }
  // SLA-breached groups surface first (the "Over 48h — reply now" tile points
  // at the top of the list); the rest run in visit-date order.
  return [...groups.values()].sort((a, b) => {
    if (a.late !== b.late) return a.late ? -1 : 1;
    return a.visit_date === b.visit_date
      ? a.start_time.localeCompare(b.start_time)
      : a.visit_date.localeCompare(b.visit_date);
  });
}

router.get('/', (req, res) => {
  const today = todayStr();
  const pending = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language,
           (SELECT COUNT(*) FROM reservations n WHERE n.email = r.email AND n.status = 'no_show') AS noshow_count
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.status = 'pending' ORDER BY r.created_at`).all()
    .map(r => ({ ...r, age: ageInfo(r.created_at) }));
  const todays = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.visit_date = ? AND r.status IN ('confirmed','attended','no_show')
    ORDER BY s.start_time`).all(today);
  // waitlist_count: cancelled-but-still-blocked seats should be offered to
  // waitlisted requests of the same session before being released in yeyak.
  const releaseQueue = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language,
           (SELECT COUNT(*) FROM reservations w
             WHERE w.status = 'waitlisted' AND w.visit_date = r.visit_date AND w.slot_id = r.slot_id) AS waitlist_count
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.release_needed = 1 ORDER BY r.decided_at`).all();
  // FIFO within each session: created_at order is the promotion priority.
  const waitlist = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.status = 'waitlisted' AND r.visit_date >= ?
    ORDER BY r.visit_date, s.start_time, r.created_at`).all(today)
    .map(r => ({ ...r, age: ageInfo(r.created_at) }));
  const posBySession = new Map();
  for (const w of waitlist) {
    const key = `${w.visit_date}|${w.slot_id}`;
    const pos = (posBySession.get(key) || 0) + 1;
    posBySession.set(key, pos);
    w.pos = pos;
  }
  const batchDone = {
    confirmed: Math.max(0, Number.parseInt(req.query.confirmed, 10) || 0),
    skipped: Math.max(0, Number.parseInt(req.query.skipped, 10) || 0),
    emailfail: Math.max(0, Number.parseInt(req.query.emailfail, 10) || 0),
  };
  res.render('admin/dashboard', {
    staff: req.session.staff, pending, pendingGroups: groupPending(pending),
    todays, releaseQueue, waitlist, today, batchDone,
    lateCount: pending.filter(p => p.age.late).length, slaHours: SLA_HOURS,
    smtpConfigured: mailer.smtpConfigured, STATUS_BADGE, settings: getSettings(),
  });
});

// ---------- reservations ----------
const RESERVATIONS_PAGE_SIZE = 50;
router.get('/reservations', (req, res) => {
  const status = String(req.query.status || '');
  const date = String(req.query.date || '');
  const q = String(req.query.q || '').trim();
  const pageNum = Number.parseInt(req.query.page, 10);
  const page = Number.isInteger(pageNum) && pageNum >= 1 ? pageNum : 1;

  let where = ' WHERE 1=1';
  const params = [];
  if (status && STATUS_BADGE[status]) { where += ' AND r.status = ?'; params.push(status); }
  if (DATE_RE.test(date)) { where += ' AND r.visit_date = ?'; params.push(date); }
  if (q) {
    where += ' AND (r.name LIKE ? OR r.email LIKE ? OR r.code LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }

  const total = db.prepare(
    `SELECT COUNT(*) AS c FROM reservations r JOIN slots s ON s.id = r.slot_id${where}`
  ).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(total / RESERVATIONS_PAGE_SIZE));
  const offset = (page - 1) * RESERVATIONS_PAGE_SIZE;

  const sql = `SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language,
             (SELECT COUNT(*) FROM reservations n WHERE n.email = r.email AND n.status = 'no_show') AS noshow_count
             FROM reservations r JOIN slots s ON s.id = r.slot_id${where}
             ORDER BY r.visit_date DESC, s.start_time, r.created_at DESC LIMIT ? OFFSET ?`;
  const rows = db.prepare(sql).all(...params, RESERVATIONS_PAGE_SIZE, offset);
  res.render('admin/reservations', {
    staff: req.session.staff, rows, status, date, q, page, totalPages, total, STATUS_BADGE,
  });
});

router.get('/reservations.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT r.code, r.visit_date, s.start_time, s.end_time, s.tour_type, s.language,
           r.name, r.email, r.country, r.party_size, r.status, r.notes, r.created_at
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    ORDER BY r.visit_date, s.start_time`).all();
  // Quote cells; prefix =+-@ with ' so Excel/Sheets never execute visitor-typed
  // text (e.g. a name of "=HYPERLINK(...)") as a formula when staff open the CSV.
  const esc = v => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return `"${s.replaceAll('"', '""')}"`;
  };
  const header = 'code,visit_date,start_time,end_time,tour_type,language,name,email,country,party_size,status,notes,created_at';
  const body = rows.map(r => [r.code, r.visit_date, r.start_time, r.end_time, r.tour_type, r.language,
    r.name, r.email, r.country, r.party_size, r.status, r.notes, r.created_at].map(esc).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="raim-reservations.csv"');
  res.send(header + '\n' + body);
});

// yeyak release queue — must be registered BEFORE the generic /reservations/:id/:action route
router.post('/reservations/:id/released', (req, res) => {
  const r = getReservation(Number(req.params.id));
  if (!r || !r.release_needed) {
    return res.status(400).render('admin/error', { staff: req.session.staff, message: 'This reservation is not waiting for a yeyak release.' });
  }
  db.prepare(`UPDATE reservations SET release_needed=0, released_at=datetime('now'), released_by=? WHERE id=?`)
    .run(req.session.staff.username, r.id);
  res.redirect(req.get('referer') || '/admin');
});

// Batch confirm: one yeyak seat-block per session, then confirm every selected
// pending request of that session at once. All ids must belong to the SAME
// (visit_date, slot) — the "I blocked N seats" attestation only makes sense for
// a single session. Rows that stopped being pending between page render and
// submit (e.g. the visitor cancelled) are skipped and reported, not failed —
// but staff sized their yeyak block on the on-screen sum, so the flash banner
// tells them to re-check the blocked seat count.
router.post('/reservations/batch-confirm', async (req, res) => {
  const fail = (message) => res.status(400).render('admin/error', { staff: req.session.staff, message });
  if (req.body.yeyak_blocked !== 'on') {
    return fail('Please tick the checkbox confirming you have blocked these seats in the Seoul Public Service Reservation (yeyak) admin first.');
  }
  const ids = [...new Set([].concat(req.body.ids || [])
    .map(v => Number.parseInt(v, 10))
    .filter(n => Number.isInteger(n) && n > 0))];
  if (ids.length === 0 || ids.length > 100) {
    return fail('Select at least one request to confirm.');
  }

  const rows = ids.map(id => getReservation(id)).filter(Boolean);
  if (rows.length !== ids.length) return fail('One of the selected requests no longer exists.');
  const sameSession = rows.every(r =>
    r.visit_date === rows[0].visit_date && r.slot_id === rows[0].slot_id);
  if (!sameSession) return fail('Batch confirm only works within a single session. Please reload the dashboard.');

  // applyDecision's UPDATE carries the observed status in its WHERE, so a row
  // that changed between page render and submit is skipped, never
  // double-confirmed. The extra `status === 'pending'` gate keeps batch confirm
  // to what the dashboard's pending groups actually offer — promoting a
  // waitlisted request stays a deliberate, one-at-a-time action.
  let confirmed = 0;
  let emailFailed = 0;
  for (const r of rows) {
    if (r.status !== 'pending') continue;
    const result = await applyDecision(r, 'confirm', { actor: req.session.staff.username });
    if (!result.applied) continue;
    confirmed += 1;
    // Without SMTP everything lands in the outbox by design — only count
    // failures when real delivery was attempted, so the flash can be honest.
    if (mailer.smtpConfigured && !result.email.sent) emailFailed += 1;
  }
  res.redirect(`/admin?confirmed=${confirmed}&skipped=${rows.length - confirmed}&emailfail=${emailFailed}`);
});

// 전이 규칙과 메일 발송은 src/decisions.js에 있다 — Google 시트 드롭다운도 같은
// 규칙을 써야 하기 때문. 여기 남은 것은 관리자 화면에만 있는 절차(yeyak 차단 확인
// 체크박스, 매진 표시)와 리다이렉트뿐이다.
router.post('/reservations/:id/:action', async (req, res) => {
  const r = getReservation(Number(req.params.id));
  const t = TRANSITIONS[req.params.action];
  if (!r || !t || !t.from.includes(r.status)) {
    return res.status(400).render('admin/error', { staff: req.session.staff, message: 'Invalid action for this reservation.' });
  }
  if (req.params.action === 'confirm' && req.body.yeyak_blocked !== 'on') {
    return res.status(400).render('admin/error', {
      staff: req.session.staff,
      message: 'Please tick the checkbox confirming you have blocked these seats in the Seoul Public Service Reservation (yeyak) admin first.',
    });
  }
  const declineReason = String(req.body.decline_reason || '').trim().slice(0, 300);
  const result = await applyDecision(r, req.params.action, {
    actor: req.session.staff.username, declineReason,
  });
  if (!result.applied) {
    return res.status(409).render('admin/error', {
      staff: req.session.staff,
      message: 'This reservation changed while the page was open. Reload and try again.',
    });
  }
  if (['decline', 'waitlist'].includes(req.params.action) && req.body.mark_soldout === 'on') {
    // One-click "this session is full": stop the booking form offering this
    // (date, session) so the decline/waitlisting doesn't repeat for the next visitor.
    db.prepare(`INSERT INTO soldout (date, slot_id, created_by) VALUES (?,?,?)
                ON CONFLICT(date, slot_id) DO NOTHING`)
      .run(r.visit_date, r.slot_id, req.session.staff.username);
  }
  res.redirect(req.get('referer') || '/admin/reservations');
});

// ---------- printable day list ----------
router.get('/day/:date/print', (req, res) => {
  const date = req.params.date;
  if (!DATE_RE.test(date)) return res.status(400).send('Bad date');
  const rows = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.visit_date = ? AND r.status IN ('confirmed','attended','no_show')
    ORDER BY s.start_time, r.name`).all(date);
  res.render('admin/print_day', { date, rows, STATUS_BADGE });
});

// ---------- schedule (slots + closures + sold-out sessions) ----------
router.get('/schedule', (req, res) => {
  const slots = db.prepare('SELECT * FROM slots ORDER BY tour_type, start_time, language').all();
  const closures = db.prepare(`SELECT * FROM closures WHERE date >= date('now','-7 day') ORDER BY date`).all();
  const soldout = db.prepare(`
    SELECT so.*, s.start_time, s.end_time, s.tour_type, s.language, s.label
    FROM soldout so JOIN slots s ON s.id = so.slot_id
    WHERE so.date >= ? ORDER BY so.date, s.start_time`).all(todayStr());
  // 앞으로 120일간 실제로 닫는 날을 계산해 보여준다. 공휴일 규칙(월요일 개관 →
  // 화요일 대체 휴관 등)이 의도대로 도는지 직원이 눈으로 확인할 수 있어야 한다.
  const upcomingClosures = [];
  const start = todayStr();
  for (let i = 0; i < 120; i++) {
    const date = addDays(start, i);
    const info = closureInfo(date);
    const holiday = holidays.holidayInfo(date);
    if (info.closed) upcomingClosures.push({ date, reason: info.reason, holiday: holiday ? holiday.name : '' });
    else if (holiday) upcomingClosures.push({ date, reason: '', holiday: holiday.name, open: true });
  }
  res.render('admin/schedule', {
    staff: req.session.staff, slots, closures, soldout, today: todayStr(),
    upcomingClosures, holidayYears: holidays.coveredYears(),
    holidayTableCovers: holidays.isCovered(addDays(start, 120)),
    saved: req.query.saved === '1', error: req.query.error || null,
  });
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function parseSlotForm(b) {
  const weekdays = []
    .concat(b.weekdays || [])
    .map(Number).filter(n => n >= 0 && n <= 6);
  return {
    tour_type: b.tour_type === 'special' ? 'special' : 'permanent',
    start_time: String(b.start_time || '').trim(),
    end_time: String(b.end_time || '').trim(),
    language: b.language === 'en' ? 'en' : 'ko',
    weekdays: [...new Set(weekdays)].sort().join(','),
    label: String(b.label || '').trim().slice(0, 120),
    active: b.active === 'on' ? 1 : 0,
  };
}

router.post('/schedule/slots', (req, res) => {
  const s = parseSlotForm(req.body);
  if (!TIME_RE.test(s.start_time) || !TIME_RE.test(s.end_time) || !s.weekdays || !s.label) {
    return res.redirect('/admin/schedule?error=' + encodeURIComponent('Slot needs label, HH:MM times and at least one weekday.'));
  }
  db.prepare('INSERT INTO slots (tour_type, start_time, end_time, language, weekdays, label, active) VALUES (?,?,?,?,?,?,?)')
    .run(s.tour_type, s.start_time, s.end_time, s.language, s.weekdays, s.label, s.active);
  res.redirect('/admin/schedule?saved=1');
});

router.post('/schedule/slots/:id', (req, res) => {
  const id = Number(req.params.id);
  if (req.body._delete === '1') {
    const used = db.prepare('SELECT COUNT(*) AS c FROM reservations WHERE slot_id = ?').get(id).c;
    if (used > 0) {
      // keep history intact — deactivate instead of deleting
      db.prepare('UPDATE slots SET active = 0 WHERE id = ?').run(id);
    } else {
      // sold-out marks reference the slot (FK) and are meaningless without it
      db.prepare('DELETE FROM soldout WHERE slot_id = ?').run(id);
      db.prepare('DELETE FROM slots WHERE id = ?').run(id);
    }
    return res.redirect('/admin/schedule?saved=1');
  }
  const s = parseSlotForm(req.body);
  if (!TIME_RE.test(s.start_time) || !TIME_RE.test(s.end_time) || !s.weekdays || !s.label) {
    return res.redirect('/admin/schedule?error=' + encodeURIComponent('Slot needs label, HH:MM times and at least one weekday.'));
  }
  db.prepare('UPDATE slots SET tour_type=?, start_time=?, end_time=?, language=?, weekdays=?, label=?, active=? WHERE id=?')
    .run(s.tour_type, s.start_time, s.end_time, s.language, s.weekdays, s.label, s.active, id);
  res.redirect('/admin/schedule?saved=1');
});

router.post('/schedule/closures', (req, res) => {
  const date = String(req.body.date || '').trim();
  const kind = req.body.kind === 'open' ? 'open' : 'closed';
  const reason = String(req.body.reason || '').trim().slice(0, 200);
  if (!isValidDateStr(date)) return res.redirect('/admin/schedule?error=' + encodeURIComponent('Pick a valid date.'));
  db.prepare(`INSERT INTO closures (date, kind, reason) VALUES (?,?,?)
              ON CONFLICT(date) DO UPDATE SET kind=excluded.kind, reason=excluded.reason`).run(date, kind, reason);
  res.redirect('/admin/schedule?saved=1');
});
router.post('/schedule/closures/:id/delete', (req, res) => {
  db.prepare('DELETE FROM closures WHERE id = ?').run(Number(req.params.id));
  res.redirect('/admin/schedule?saved=1');
});

// Sold-out sessions: manual add (e.g. staff spot a full session in yeyak
// before any request arrives) and undo (seats freed up by a yeyak cancel).
router.post('/schedule/soldout', (req, res) => {
  const date = String(req.body.date || '').trim();
  const slotId = Number.parseInt(req.body.slot_id, 10);
  const err = (msg) => res.redirect('/admin/schedule?error=' + encodeURIComponent(msg));
  if (!isValidDateStr(date)) return err('Pick a valid date.');
  if (date < todayStr()) return err('Sold-out marks can only be set for today or future dates.');
  // The (date, session) pair must be one the booking form actually offers —
  // a mark on a wrong-weekday/inactive slot or a closed date would save
  // "successfully" but never block anything (silent no-op).
  const day = sessionsForDate(date);
  if (day.closed || !day.sessions.some(s => s.id === slotId)) {
    return err('That session does not run on that date, so it cannot be marked sold out.');
  }
  db.prepare(`INSERT INTO soldout (date, slot_id, created_by) VALUES (?,?,?)
              ON CONFLICT(date, slot_id) DO NOTHING`).run(date, slotId, req.session.staff.username);
  res.redirect('/admin/schedule?saved=1');
});
router.post('/schedule/soldout/:id/delete', (req, res) => {
  db.prepare('DELETE FROM soldout WHERE id = ?').run(Number(req.params.id));
  res.redirect('/admin/schedule?saved=1');
});

// ---------- notices ----------
router.get('/notices', (req, res) => {
  const notices = db.prepare('SELECT * FROM notices ORDER BY pinned DESC, created_at DESC').all();
  res.render('admin/notices', { staff: req.session.staff, notices, saved: req.query.saved === '1' });
});
router.post('/notices', (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!title || !body) return res.redirect('/admin/notices');
  db.prepare('INSERT INTO notices (title, body, category, pinned, published) VALUES (?,?,?,?,?)')
    .run(title, body, String(req.body.category || 'general'), req.body.pinned === 'on' ? 1 : 0, req.body.published === 'on' ? 1 : 0);
  res.redirect('/admin/notices?saved=1');
});
router.post('/notices/:id', (req, res) => {
  const id = Number(req.params.id);
  if (req.body._delete === '1') {
    db.prepare('DELETE FROM notices WHERE id = ?').run(id);
    return res.redirect('/admin/notices?saved=1');
  }
  const title = String(req.body.title || '').trim().slice(0, 200);
  const body = String(req.body.body || '').trim().slice(0, 2000);
  if (!title || !body) return res.redirect('/admin/notices');
  db.prepare(`UPDATE notices SET title=?, body=?, category=?, pinned=?, published=?, updated_at=datetime('now') WHERE id=?`)
    .run(title, body, String(req.body.category || 'general'), req.body.pinned === 'on' ? 1 : 0, req.body.published === 'on' ? 1 : 0, id);
  res.redirect('/admin/notices?saved=1');
});

// ---------- staff ----------
router.get('/staff', requireAdmin, (req, res) => {
  const staffRows = db.prepare('SELECT id, username, name, role, created_at FROM staff ORDER BY id').all();
  res.render('admin/staff', {
    staff: req.session.staff, staffRows,
    saved: req.query.saved === '1', error: req.query.error || null,
  });
});
router.post('/staff', requireAdmin, (req, res) => {
  const username = String(req.body.username || '').trim().slice(0, 40);
  const name = String(req.body.name || '').trim().slice(0, 60);
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'staff';
  if (!/^[a-zA-Z0-9._-]{3,}$/.test(username) || !name || password.length < 8) {
    return res.redirect('/admin/staff?error=' + encodeURIComponent('Username (3+ chars), name and password (8+ chars) are required.'));
  }
  if (db.prepare('SELECT 1 FROM staff WHERE username = ?').get(username)) {
    return res.redirect('/admin/staff?error=' + encodeURIComponent('That username already exists.'));
  }
  const { salt, hash } = hashPassword(password);
  db.prepare('INSERT INTO staff (username, name, role, pw_salt, pw_hash) VALUES (?,?,?,?,?)').run(username, name, role, salt, hash);
  res.redirect('/admin/staff?saved=1');
});
router.post('/staff/:id/delete', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.staff.id) {
    return res.redirect('/admin/staff?error=' + encodeURIComponent('You cannot delete your own account.'));
  }
  db.prepare('DELETE FROM staff WHERE id = ?').run(id);
  res.redirect('/admin/staff?saved=1');
});
router.post('/staff/:id/password', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const password = String(req.body.password || '');
  if (password.length < 8) return res.redirect('/admin/staff?error=' + encodeURIComponent('Password must be 8+ characters.'));
  const { salt, hash } = hashPassword(password);
  db.prepare('UPDATE staff SET pw_salt=?, pw_hash=? WHERE id=?').run(salt, hash, id);
  res.redirect('/admin/staff?saved=1');
});

// ---------- settings ----------
router.get('/settings', requireAdmin, (req, res) => {
  res.render('admin/settings', {
    staff: req.session.staff, settings: getSettings(),
    smtpConfigured: mailer.smtpConfigured, saved: req.query.saved === '1',
    error: req.query.error || null,
  });
});
// Numeric settings are clamped, never stored raw: a typo in retention_days
// would otherwise be honoured by the twice-daily purge and delete live
// reservations, and a non-numeric digest_hour silently disables the digest.
// Out-of-range input keeps the current value rather than writing nonsense.
const NUMERIC_SETTINGS = {
  max_party_size: { min: 1, max: 19 },
  booking_window_days: { min: 1, max: 180 },
  retention_days: { min: 1, max: 3650 },
  noshow_retention_days: { min: 1, max: 3650 },
  digest_hour: { min: 0, max: 23, allowEmpty: true }, // empty = digest disabled
};
router.post('/settings', requireAdmin, (req, res) => {
  const keys = ['contact_email', 'contact_phone', 'address_en', 'max_party_size', 'booking_window_days', 'reply_sla_text', 'staff_notify_email', 'retention_days', 'noshow_retention_days', 'yeyak_url_permanent', 'yeyak_url_special', 'yeyak_admin_url', 'digest_hour'];
  const rejected = [];
  for (const k of keys) {
    if (req.body[k] == null) continue;
    const raw = String(req.body[k]).trim().slice(0, 500);
    const rule = NUMERIC_SETTINGS[k];
    if (rule) {
      if (raw === '' && rule.allowEmpty) { setSetting(k, ''); continue; }
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || String(n) !== raw || n < rule.min || n > rule.max) {
        rejected.push(k);
        continue;
      }
      setSetting(k, String(n));
      continue;
    }
    setSetting(k, raw);
  }
  const q = rejected.length
    ? '?error=' + encodeURIComponent(`Ignored out-of-range value(s): ${rejected.join(', ')}. Other settings were saved.`)
    : '?saved=1';
  res.redirect('/admin/settings' + q);
});

// ---------- email outbox ----------
router.get('/emails', (req, res) => {
  const emails = db.prepare('SELECT id, to_addr, subject, sent, error, created_at FROM email_log ORDER BY id DESC LIMIT 200').all();
  res.render('admin/emails', { staff: req.session.staff, emails, smtpConfigured: mailer.smtpConfigured });
});
router.get('/emails/:id', (req, res) => {
  const row = db.prepare('SELECT html FROM email_log WHERE id = ?').get(Number(req.params.id));
  if (!row) return res.status(404).send('Not found');
  res.send(row.html);
});

module.exports = router;
