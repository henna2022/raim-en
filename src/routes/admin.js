'use strict';
const express = require('express');
const { db, hashPassword, verifyPassword, setSetting } = require('../db');
const {
  DATE_RE, isValidDateStr, todayStr, weekdayOf, closureInfo, sessionsForDate, getReservation, STATUS_BADGE, getSettings,
} = require('../helpers');
const mailer = require('../mailer');
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
const SLA_HOURS = 48;
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
  // declining these, not blocking more yeyak seats.
  const soldoutCheck = db.prepare('SELECT 1 FROM soldout WHERE date = ? AND slot_id = ?');
  for (const g of groups.values()) g.soldout = !!soldoutCheck.get(g.visit_date, g.slot_id);
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
  const releaseQueue = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.release_needed = 1 ORDER BY r.decided_at`).all();
  const batchDone = {
    confirmed: Math.max(0, Number.parseInt(req.query.confirmed, 10) || 0),
    skipped: Math.max(0, Number.parseInt(req.query.skipped, 10) || 0),
    emailfail: Math.max(0, Number.parseInt(req.query.emailfail, 10) || 0),
  };
  res.render('admin/dashboard', {
    staff: req.session.staff, pending, pendingGroups: groupPending(pending),
    todays, releaseQueue, today, batchDone,
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

  // Guarded UPDATE (status='pending' in the WHERE) so a row that changed
  // between page render and submit is skipped, never double-confirmed.
  // release_needed is cleared: a confirmed row means its yeyak seats are
  // blocked intentionally, so it must not linger in the release queue (a
  // cancel→reopen→re-confirm chain would otherwise leave the flag set and
  // invite staff to free a confirmed party's seats).
  const update = db.prepare(`UPDATE reservations SET status='confirmed', release_needed=0, decided_at=datetime('now'), decided_by=? WHERE id=? AND status='pending'`);
  let confirmed = 0;
  let emailFailed = 0;
  for (const r of rows) {
    if (update.run(req.session.staff.username, r.id).changes !== 1) continue;
    confirmed += 1;
    const updated = getReservation(r.id);
    const ics = mailer.icsForReservation(updated);
    const result = await mailer.sendMail(
      updated.email, `[Seoul RAIM] Reservation confirmed — ${updated.code}`, mailer.confirmedEmail(updated),
      [{ filename: 'raim-visit.ics', content: ics, contentType: 'text/calendar' }]
    );
    // Without SMTP everything lands in the outbox by design — only count
    // failures when real delivery was attempted, so the flash can be honest.
    if (mailer.smtpConfigured && !result.sent) emailFailed += 1;
  }
  res.redirect(`/admin?confirmed=${confirmed}&skipped=${rows.length - confirmed}&emailfail=${emailFailed}`);
});

const TRANSITIONS = {
  confirm: { from: ['pending'], to: 'confirmed' },
  decline: { from: ['pending'], to: 'declined' },
  cancel: { from: ['pending', 'confirmed'], to: 'cancelled' },
  attended: { from: ['confirmed'], to: 'attended' },
  no_show: { from: ['confirmed'], to: 'no_show' },
  reopen: { from: ['declined', 'cancelled', 'no_show', 'attended'], to: 'pending' },
};

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
  db.prepare(`UPDATE reservations SET status=?, decline_reason=?, decided_at=datetime('now'), decided_by=? WHERE id=?`)
    .run(t.to, req.params.action === 'decline' ? declineReason : r.decline_reason, req.session.staff.username, r.id);
  if (req.params.action === 'cancel' && r.status === 'confirmed') {
    // seats were blocked in yeyak — track the release until staff mark it done
    db.prepare('UPDATE reservations SET release_needed=1 WHERE id=?').run(r.id);
  }
  if (req.params.action === 'confirm') {
    // confirmed = seats blocked in yeyak on purpose; a stale release flag from
    // a cancel→reopen chain must not keep the row in the release queue.
    db.prepare('UPDATE reservations SET release_needed=0 WHERE id=?').run(r.id);
  }
  if (req.params.action === 'decline' && req.body.mark_soldout === 'on') {
    // One-click "this session is full": stop the booking form offering this
    // (date, session) so the decline doesn't repeat for the next visitor.
    db.prepare(`INSERT INTO soldout (date, slot_id, created_by) VALUES (?,?,?)
                ON CONFLICT(date, slot_id) DO NOTHING`)
      .run(r.visit_date, r.slot_id, req.session.staff.username);
  }

  const updated = getReservation(r.id);
  if (req.params.action === 'confirm') {
    const ics = mailer.icsForReservation(updated);
    await mailer.sendMail(
      updated.email, `[Seoul RAIM] Reservation confirmed — ${updated.code}`, mailer.confirmedEmail(updated),
      [{ filename: 'raim-visit.ics', content: ics, contentType: 'text/calendar' }]
    );
  } else if (req.params.action === 'decline') {
    await mailer.sendMail(updated.email, `[Seoul RAIM] About your request — ${updated.code}`, mailer.declinedEmail(updated));
  } else if (req.params.action === 'cancel') {
    await mailer.sendMail(updated.email, `[Seoul RAIM] Reservation cancelled — ${updated.code}`, mailer.cancelledEmail(updated));
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
  res.render('admin/schedule', {
    staff: req.session.staff, slots, closures, soldout, today: todayStr(),
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
  });
});
router.post('/settings', requireAdmin, (req, res) => {
  const keys = ['contact_email', 'contact_phone', 'address_en', 'max_party_size', 'booking_window_days', 'reply_sla_text', 'staff_notify_email', 'retention_days', 'noshow_retention_days', 'yeyak_url_permanent', 'yeyak_url_special', 'yeyak_admin_url'];
  for (const k of keys) {
    if (req.body[k] != null) setSetting(k, String(req.body[k]).trim().slice(0, 500));
  }
  res.redirect('/admin/settings?saved=1');
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
