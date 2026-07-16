'use strict';
const express = require('express');
const { db, hashPassword, verifyPassword, setSetting } = require('../db');
const {
  DATE_RE, todayStr, closureInfo, getReservation, STATUS_BADGE, getSettings,
} = require('../helpers');
const mailer = require('../mailer');

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

router.get('/login', (req, res) => {
  if (req.session.staff) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});
router.post('/login', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  const row = db.prepare('SELECT * FROM staff WHERE username = ?').get(username);
  if (!row || !verifyPassword(password, row.pw_salt, row.pw_hash)) {
    return res.status(401).render('admin/login', { error: 'Invalid username or password.' });
  }
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

router.get('/', (req, res) => {
  const today = todayStr();
  const pending = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
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
  res.render('admin/dashboard', {
    staff: req.session.staff, pending, todays, releaseQueue, today,
    lateCount: pending.filter(p => p.age.late).length, slaHours: SLA_HOURS,
    smtpConfigured: mailer.smtpConfigured, STATUS_BADGE,
  });
});

// ---------- reservations ----------
router.get('/reservations', (req, res) => {
  const status = String(req.query.status || '');
  const date = String(req.query.date || '');
  let sql = `SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
             FROM reservations r JOIN slots s ON s.id = r.slot_id WHERE 1=1`;
  const params = [];
  if (status && STATUS_BADGE[status]) { sql += ' AND r.status = ?'; params.push(status); }
  if (DATE_RE.test(date)) { sql += ' AND r.visit_date = ?'; params.push(date); }
  sql += ' ORDER BY r.visit_date DESC, s.start_time, r.created_at DESC LIMIT 500';
  const rows = db.prepare(sql).all(...params);
  res.render('admin/reservations', {
    staff: req.session.staff, rows, status, date, STATUS_BADGE,
  });
});

router.get('/reservations.csv', (req, res) => {
  const rows = db.prepare(`
    SELECT r.code, r.visit_date, s.start_time, s.end_time, s.tour_type, s.language,
           r.name, r.email, r.country, r.party_size, r.status, r.notes, r.created_at
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    ORDER BY r.visit_date, s.start_time`).all();
  const esc = v => `"${String(v == null ? '' : v).replaceAll('"', '""')}"`;
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

  const updated = getReservation(r.id);
  if (req.params.action === 'confirm') {
    await mailer.sendMail(updated.email, `[Seoul RAIM] Reservation confirmed — ${updated.code}`, mailer.confirmedEmail(updated));
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

// ---------- schedule (slots + closures) ----------
router.get('/schedule', (req, res) => {
  const slots = db.prepare('SELECT * FROM slots ORDER BY tour_type, start_time, language').all();
  const closures = db.prepare(`SELECT * FROM closures WHERE date >= date('now','-7 day') ORDER BY date`).all();
  res.render('admin/schedule', {
    staff: req.session.staff, slots, closures,
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
  if (!DATE_RE.test(date)) return res.redirect('/admin/schedule?error=' + encodeURIComponent('Pick a valid date.'));
  db.prepare(`INSERT INTO closures (date, kind, reason) VALUES (?,?,?)
              ON CONFLICT(date) DO UPDATE SET kind=excluded.kind, reason=excluded.reason`).run(date, kind, reason);
  res.redirect('/admin/schedule?saved=1');
});
router.post('/schedule/closures/:id/delete', (req, res) => {
  db.prepare('DELETE FROM closures WHERE id = ?').run(Number(req.params.id));
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
  const keys = ['contact_email', 'contact_phone', 'address_en', 'max_party_size', 'booking_window_days', 'reply_sla_text', 'staff_notify_email', 'retention_days'];
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
