'use strict';
const { db, getSettings } = require('./db');
const crypto = require('node:crypto');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// True only for real calendar dates — DATE_RE alone accepts e.g. 2026-13-99.
function isValidDateStr(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function todayStr() {
  // Museum operates in KST; render dates in Asia/Seoul regardless of server TZ.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}
function nowHM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}
function weekdayOf(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay(); // 0=Sun .. 6=Sat
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Returns { closed: bool, reason: string, openOverride: bool }
function closureInfo(dateStr) {
  const override = db.prepare('SELECT kind, reason FROM closures WHERE date = ?').get(dateStr);
  if (override) {
    if (override.kind === 'open') return { closed: false, reason: '', openOverride: true };
    return { closed: true, reason: override.reason || 'Closed (museum notice)', openOverride: false };
  }
  if (weekdayOf(dateStr) === 1) return { closed: true, reason: 'Closed every Monday', openOverride: false };
  return { closed: false, reason: '', openOverride: false };
}

// Bookable sessions for a given date (already filters past times for today).
function sessionsForDate(dateStr) {
  const { closed, reason, openOverride } = closureInfo(dateStr);
  if (closed) return { closed: true, reason, sessions: [] };
  let wd = String(weekdayOf(dateStr));
  // A Monday opened via an 'open' override (public-holiday shift) runs the
  // standard weekday timetable. No slot lists Monday, so use Tuesday's set —
  // Wednesday-only English sessions correctly stay excluded.
  if (openOverride && wd === '1') wd = '2';
  const isToday = dateStr === todayStr();
  const cutoff = nowHM();
  const rows = db.prepare('SELECT * FROM slots WHERE active = 1 ORDER BY start_time, tour_type').all();
  const sessions = rows
    .filter(s => s.weekdays.split(',').includes(wd))
    .map(s => ({
      id: s.id,
      tour_type: s.tour_type,
      start_time: s.start_time,
      end_time: s.end_time,
      language: s.language,
      label: s.label,
      past: isToday && s.start_time <= cutoff,
    }));
  return { closed: false, reason: '', sessions };
}

// ---------- English tour single-source-of-truth (A5) ----------
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// weekdays CSV (e.g. '2,3') -> 'Tuesday & Wednesday'
function weekdayLabel(weekdaysCsv) {
  return weekdaysCsv.split(',').map(n => WEEKDAY_NAMES[Number(n)]).join(' & ');
}

// Reads the active EN-language slots and derives every English-tour phrase the
// public templates need, so admin schedule edits never leave the site copy stale.
function getEnglishTours() {
  const rows = db.prepare(`SELECT * FROM slots WHERE active = 1 AND language = 'en' ORDER BY start_time`).all();
  if (rows.length === 0) {
    return { available: false, chip: null, summary: null, perType: { permanent: null, special: null } };
  }

  const firstWeekdays = rows[0].weekdays;
  const allSameSingleDay = rows.every(r => r.weekdays === firstWeekdays) && firstWeekdays.split(',').length === 1;
  const chip = allSameSingleDay
    ? `English tours every ${WEEKDAY_NAMES[Number(firstWeekdays)]}`
    : 'English docent tours available';

  const groups = new Map(); // weekday label -> item strings, in start_time order
  for (const r of rows) {
    const label = weekdayLabel(r.weekdays);
    const item = `${r.tour_type === 'permanent' ? 'Permanent Exhibition' : 'Special Exhibition'} ${r.start_time}`;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  }
  const groupTexts = [...groups.entries()].map(([label, items]) => `${label}: ${items.join(' · ')}`);
  const summary = groupTexts.length === 1 ? `Every ${groupTexts[0]}` : groupTexts.join('; ');

  function firstOfType(type) {
    const match = rows.find(r => r.tour_type === type); // rows already ordered by start_time asc
    if (!match) return null;
    return `every ${weekdayLabel(match.weekdays)} at ${match.start_time}`;
  }

  return {
    available: true,
    chip,
    summary,
    perType: { permanent: firstOfType('permanent'), special: firstOfType('special') },
  };
}

function genCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L
  let code = '';
  for (let i = 0; i < 6; i++) code += alphabet[crypto.randomInt(alphabet.length)];
  return 'RAIM-' + code;
}

function getReservation(id) {
  return db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language, s.label
    FROM reservations r JOIN slots s ON s.id = r.slot_id WHERE r.id = ?`).get(id);
}
function getReservationByCode(code) {
  return db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language, s.label
    FROM reservations r JOIN slots s ON s.id = r.slot_id WHERE r.code = ?`).get(code);
}

const STATUS_BADGE = {
  pending: ['Pending review', 'badge-pending'],
  confirmed: ['Confirmed', 'badge-confirmed'],
  declined: ['Declined', 'badge-declined'],
  cancelled: ['Cancelled', 'badge-cancelled'],
  attended: ['Attended', 'badge-attended'],
  no_show: ['No-show', 'badge-noshow'],
};

module.exports = {
  DATE_RE, isValidDateStr, todayStr, nowHM, weekdayOf, addDays,
  closureInfo, sessionsForDate, genCode, getEnglishTours,
  getReservation, getReservationByCode, STATUS_BADGE, getSettings,
};
