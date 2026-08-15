'use strict';
const express = require('express');
const { db } = require('../db');
const {
  isValidDateStr, todayStr, addDays, closureInfo, sessionsForDate, genCode,
  getReservationByCode, maskName, STATUS_BADGE, getSettings, getEnglishTours,
} = require('../helpers');
const mailer = require('../mailer');
const countries = require('../countries');
const sheets = require('../sheets');
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
      enTours: getEnglishTours(), countries,
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
    enTours: getEnglishTours(), countries,
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
  const maxParty = Number(s.max_party_size || 5);
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
    agree: b.agree === 'on' || b.agree === 'true',
  };

  const fail = (msg) => res.status(400).render('reserve', {
    settings: s, today: todayStr(),
    maxDate: addDays(todayStr(), Number(s.booking_window_days || 60)),
    error: msg, form,
    enTours: getEnglishTours(), countries,
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
  if (slot.soldout) return fail('That session is fully booked on that date. Please pick another session or day.');
  if (!form.name) return fail('Please enter your name.');
  if (!EMAIL_RE.test(form.email)) return fail('Please enter a valid email address.');
  if (!Number.isInteger(form.party_size) || form.party_size < 1 || form.party_size > maxParty)
    return fail(`Party size must be between 1 and ${maxParty}. Groups of 20–60 should book by email instead.`);
  // 목록에 있는 국가만 받는다 — 폼을 우회한 임의 값이 통계를 오염시키지 않도록.
  if (!countries.isValid(form.country)) return fail('Please select your country from the list.');
  if (!form.agree) return fail('Please agree to the privacy notice and no-show policy.');

  const upcomingCount = db.prepare(
    `SELECT COUNT(*) AS c FROM reservations WHERE email = ? AND status IN ('pending','confirmed','waitlisted') AND visit_date >= ?`
  ).get(form.email, todayStr()).c;
  if (upcomingCount >= 3)
    return fail('You already have 3 upcoming reservations. Please cancel one via My Booking, or contact us by email.');

  const dup = db.prepare(
    `SELECT id FROM reservations WHERE email = ? AND visit_date = ? AND slot_id = ? AND status IN ('pending','confirmed','waitlisted')`
  ).get(form.email, form.date, form.slot_id);
  if (dup) return fail('You already have a request for this session. Check the My Booking page.');

  let code = genCode();
  while (db.prepare('SELECT 1 FROM reservations WHERE code = ?').get(code)) code = genCode();

  db.prepare(`INSERT INTO reservations (code, slot_id, visit_date, name, email, country, party_size)
              VALUES (?,?,?,?,?,?,?)`)
    .run(code, form.slot_id, form.date, form.name, form.email, form.country, form.party_size);

  const r = getReservationByCode(code);
  sheets.nudge(); // await 하지 않는다 — 시트 지연이 방문자 응답을 늦추면 안 된다
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
// 조회는 두 단계다:
//  ① 예약번호만 → 가린 보기. 상태·날짜·회차·인원만 보이고 이름은 첫 글자만,
//     이메일과 거절 사유는 아예 나가지 않는다. 번호를 주운 사람이 신청자를
//     특정하거나 연락처를 얻을 수 없어야 한다(PIPA).
//  ② 예약번호 + 이메일 일치 → 전체 보기. 취소도 여기서만 된다.
// 번호는 맞는데 이메일이 틀리면 가린 보기로 흘리지 않고 "찾을 수 없음"으로 막는다 —
// 이메일을 대입해 가며 맞는 주소를 찾아내는 확인 공격을 막기 위해서다.
// GET·POST가 같은 규칙을 타야 하므로 조회와 렌더를 한곳에 모은다.
function renderBookingLookup(res, { code, email, isNew, cancelled }) {
  let reservation = null;
  let masked = false;
  let error = null;
  if (code) {
    const r = getReservationByCode(code);
    if (!r) {
      error = email ? 'No booking found with that code and email.' : 'No booking found with that reservation code.';
    } else if (email) {
      if (r.email === email) reservation = r;
      else error = 'No booking found with that code and email.';
    } else {
      reservation = r;
      masked = true;
    }
  }
  res.render('booking', {
    settings: getSettings(), code, email, reservation, masked, error,
    isNew, cancelled,
    STATUS_BADGE, maskName,
  });
}

// GET은 코드만 담긴 링크용이다 — 신청 직후·취소 후 리다이렉트가 여기로 온다.
// email 파라미터는 UI가 더 이상 만들지 않지만(조회 폼은 POST로 바뀌었다),
// 예전에 북마크된 URL을 위해 계속 받아 준다 — 그런 URL이 여기까지 왔다면
// 로그와 방문 기록에는 이미 남은 뒤라, 받아 줘도 새로 새는 것은 없다.
router.get('/booking', bookingLimiter, (req, res) => {
  renderBookingLookup(res, {
    code: String(req.query.code || '').trim().toUpperCase(),
    email: String(req.query.email || '').trim().toLowerCase(),
    isNew: req.query.new === '1',
    cancelled: req.query.cancelled === '1',
  });
});

// 이메일이 든 조회는 POST 본문으로 받는다 — GET이면 쿼리스트링에 실려 nginx
// 접근 로그와 브라우저 방문 기록에 남는다(위 PIPA 주석 참조). 리다이렉트로
// 돌리면 이메일이 다시 URL에 실리므로, 결과를 여기서 바로 그린다.
router.post('/booking', bookingLimiter, (req, res) => {
  renderBookingLookup(res, {
    code: String((req.body && req.body.code) || '').trim().toUpperCase(),
    email: String((req.body && req.body.email) || '').trim().toLowerCase(),
    isNew: false,
    cancelled: false,
  });
});

router.post('/booking/cancel', cancelLimiter, async (req, res) => {
  const code = String(req.body.code || '').trim().toUpperCase();
  const email = String(req.body.email || '').trim().toLowerCase();
  const r = getReservationByCode(code);
  let didCancel = false;
  if (r && r.email === email && ['pending', 'confirmed', 'waitlisted'].includes(r.status)) {
    // A confirmed reservation has seats blocked in the yeyak admin — flag them for release.
    const needsRelease = r.status === 'confirmed' ? 1 : 0;
    // WHERE에 상태 조건을 다시 건다 — 위에서 읽은 뒤 직원이 먼저 처리하는 등
    // 상태가 바뀌었으면 아무것도 덮어쓰지 않고, 메일도 보내지 않는다.
    const info = db.prepare(`UPDATE reservations SET status='cancelled', release_needed=?, decided_at=datetime('now'), decided_by='visitor'
                             WHERE id=? AND status IN ('pending','confirmed','waitlisted')`)
      .run(needsRelease, r.id);
    didCancel = info.changes === 1;
    if (didCancel) {
      const updated = getReservationByCode(code);
      sheets.nudge();
      await mailer.sendMail(updated.email, `[Seoul RAIM] Reservation cancelled — ${updated.code}`, mailer.cancelledEmail(updated));
      if (needsRelease) {
        // Freed-but-still-blocked seats should go to waitlisted requests of the
        // same session first — tell staff how many candidates there are.
        const waitlistCount = db.prepare(
          `SELECT COUNT(*) AS c FROM reservations WHERE status = 'waitlisted' AND visit_date = ? AND slot_id = ?`
        ).get(updated.visit_date, updated.slot_id).c;
        await mailer.notifyStaff(
          `[RAIM] 확정 예약 취소 — yeyak 해제 필요 ${updated.code} (${updated.visit_date} ${updated.start_time})`,
          mailer.staffReleaseEmail(updated, waitlistCount)
        );
      }
    }
  }
  // 이메일은 리다이렉트 URL에 싣지 않는다 — 코드만으로 가린 보기에 내려주면
  // 상태 줄(Cancelled)과 배너로 확인은 충분하다(위 PIPA 주석 참조). cancelled=1은
  // 실제로 UPDATE가 실행됐을 때만 붙인다 — 이메일이 틀렸거나 상태가 이미
  // 바뀐 경우에 "취소됨" 배너를 보여주면 거짓 확인이 된다.
  res.redirect(`/booking?code=${encodeURIComponent(code)}${didCancel ? '&cancelled=1' : ''}`);
});

module.exports = router;
