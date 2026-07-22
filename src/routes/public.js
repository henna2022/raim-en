'use strict';
const express = require('express');
const { db } = require('../db');
const {
  isValidDateStr, todayStr, addDays, closureInfo, sessionsForDate, genCode,
  getReservationByCode, STATUS_BADGE, getSettings, getEnglishTours,
} = require('../helpers');
const mailer = require('../mailer');
const { rateLimit } = require('../ratelimit');

const router = express.Router();
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- spam / abuse protection ----------
const reserveLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  onLimit: (req, res) => {
    const s = getSettings();
    res.status(429).render('reserve', {
      settings: s,
      today: todayStr(),
      maxDate: addDays(todayStr(), Number(s.booking_window_days || 60)),
      error: 'Too many requests. Please wait a few minutes and try again.',
      form: {},
      enTours: getEnglishTours(),
    });
  },
});

const cancelLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  onLimit: (req, res) => {
    res.status(429).type('text/plain').send('Too many requests. Please wait a few minutes and try again.');
  },
});

const bookingLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 30,
  onLimit: (req, res) => {
    res.status(429).type('text/plain').send('Too many requests. Please wait a few minutes and try again.');
  },
});

// ---------- landing ----------
router.get('/', (req, res) => {
  const notices = db.prepare(
    'SELECT * FROM notices WHERE published = 1 ORDER BY pinned DESC, created_at DESC LIMIT 6'
  ).all();
  res.render('index', { notices, settings: getSettings(), today: todayStr(), enTours: getEnglishTours() });
});

// ---------- reservation flow ----------
router.get('/reserve', (req, res) => {
  const s = getSettings();
  res.render('reserve', {
    settings: s,
    today: todayStr(),
    maxDate: addDays(todayStr(), Number(s.booking_window_days || 60)),
    error: null,
    form: {},
    enTours: getEnglishTours(),
  });
});

router.get('/api/sessions', (req, res) => {
  const date = String(req.query.date || '');
  if (!isValidDateStr(date)) return res.status(400).json({ error: 'Invalid date' });
  const s = getSettings();
  const max = addDays(todayStr(), Number(s.booking_window_days || 60));
  if (date < todayStr() || date > max) {
    return res.json({ closed: true, reason: 'Outside the booking window', sessions: [] });
  }
  res.json(sessionsForDate(date));
});

router.post('/reserve', reserveLimiter, async (req, res) => {
  const s = getSettings();
  const maxParty = Number(s.max_party_size || 6);
  const b = req.body || {};

  // Honeypot: hidden "website" field only a bot would fill in. Pretend success —
  // no DB write, no email — so the bot doesn't learn to look for a real signal.
  if (String(b.website || '').trim() !== '') {
    return res.redirect('/booking?new=1');
  }

  const form = {
    date: String(b.date || '').trim(),
    slot_id: Number(b.slot_id || 0),
    name: String(b.name || '').trim().slice(0, 80),
    email: String(b.email || '').trim().slice(0, 120).toLowerCase(),
    country: String(b.country || '').trim().slice(0, 60),
    party_size: Number(b.party_size || 0),
    notes: String(b.notes || '').trim().slice(0, 500),
    agree: b.agree === 'on' || b.agree === 'true',
  };

  const fail = (msg) => res.status(400).render('reserve', {
    settings: s, today: todayStr(),
    maxDate: addDays(todayStr(), Number(s.booking_window_days || 60)),
    error: msg, form,
    enTours: getEnglishTours(),
  });

  if (!isValidDateStr(form.date)) return fail('Please pick a valid date.');
  if (form.date < todayStr() || form.date > addDays(todayStr(), Number(s.booking_window_days || 60)))
    return fail('That date is outside the booking window.');
  const { closed } = closureInfo(form.date);
  if (closed) return fail('The museum is closed on that date.');
  const day = sessionsForDate(form.date);
  const slot = day.sessions.find(x => x.id === form.slot_id);
  if (!slot) return fail('Please select a session.');
  if (slot.past) return fail('That session has already started today. Please pick a later one.');
  if (!form.name) return fail('Please enter your name.');
  if (!EMAIL_RE.test(form.email)) return fail('Please enter a valid email address.');
  if (!Number.isInteger(form.party_size) || form.party_size < 1 || form.party_size > maxParty)
    return fail(`Party size must be between 1 and ${maxParty}. Groups of 20–60 should book by email instead.`);
  if (!form.agree) return fail('Please agree to the privacy notice and no-show policy.');

  const upcomingCount = db.prepare(
    `SELECT COUNT(*) AS c FROM reservations WHERE email = ? AND status IN ('pending','confirmed') AND visit_date >= ?`
  ).get(form.email, todayStr()).c;
  if (upcomingCount >= 3)
    return fail('You already have 3 upcoming reservations. Please cancel one via My Booking, or contact us by email.');

  const dup = db.prepare(
    `SELECT id FROM reservations WHERE email = ? AND visit_date = ? AND slot_id = ? AND status IN ('pending','confirmed')`
  ).get(form.email, form.date, form.slot_id);
  if (dup) return fail('You already have a request for this session. Check the My Booking page.');

  let code = genCode();
  while (db.prepare('SELECT 1 FROM reservations WHERE code = ?').get(code)) code = genCode();

  db.prepare(`INSERT INTO reservations (code, slot_id, visit_date, name, email, country, party_size, notes)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(code, form.slot_id, form.date, form.name, form.email, form.country, form.party_size, form.notes);

  const r = getReservationByCode(code);
  await mailer.sendMail(r.email, `[Seoul RAIM] Request received — ${r.code}`, mailer.requestReceivedEmail(r));
  const todayTag = r.visit_date === todayStr() ? '[오늘] ' : '';
  await mailer.notifyStaff(
    `[RAIM] ${todayTag}새 외국인 예약 신청 ${r.code} — ${r.visit_date} ${r.start_time}`,
    mailer.staffNewRequestEmail(r)
  );

  // Redirect with the code only — never the email. An email in the URL would be
  // written to web-server access logs and browser history (a PIPA concern for an
  // official site). The visitor's code is shown on the landing banner so they can
  // save it; looking up the full booking still requires code + email together.
  res.redirect(`/booking?code=${encodeURIComponent(code)}&new=1`);
});

// ---------- booking status / cancel ----------
router.get('/booking', bookingLimiter, (req, res) => {
  const code = String(req.query.code || '').trim().toUpperCase();
  const email = String(req.query.email || '').trim().toLowerCase();
  let reservation = null;
  let error = null;
  if (code && email) {
    const r = getReservationByCode(code);
    if (r && r.email === email) reservation = r;
    else error = 'No booking found with that code and email.';
  }
  res.render('booking', {
    settings: getSettings(), code, email, reservation, error,
    isNew: req.query.new === '1', cancelled: req.query.cancelled === '1',
    STATUS_BADGE,
  });
});

router.post('/booking/cancel', cancelLimiter, async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const r = getReservationByCode(code);
  if (r && r.email === email && ['pending', 'confirmed'].includes(r.status)) {
    // A confirmed reservation has seats blocked in the yeyak admin — flag them for release.
    const needsRelease = r.status === 'confirmed' ? 1 : 0;
    db.prepare(`UPDATE reservations SET status='cancelled', release_needed=?, decided_at=datetime('now'), decided_by='visitor' WHERE id=?`)
      .run(needsRelease, r.id);
    const updated = getReservationByCode(code);
    await mailer.sendMail(updated.email, `[Seoul RAIM] Reservation cancelled — ${updated.code}`, mailer.cancelledEmail(updated));
    if (needsRelease) {
      await mailer.notifyStaff(
        `[RAIM] 확정 예약 취소 — yeyak 해제 필요 ${updated.code} (${updated.visit_date} ${updated.start_time})`,
        mailer.staffReleaseEmail(updated)
      );
    }
  }
  res.redirect(`/booking?code=${encodeURIComponent(code)}&email=${encodeURIComponent(email)}&cancelled=1`);
});

module.exports = router;
