'use strict';
// Shared test harness for the P0-4 suite. node:test + node:assert + built-in
// fetch only — no npm test dependencies (supertest/jest/etc. are NOT installed).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const REPO_ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(REPO_ROOT, 'src');
const APP_PATH = path.join(SRC_DIR, 'app.js');

// ---------- app lifecycle ----------
// Every test file (and every "restart" within a file) gets a brand-new require
// of src/app.js so module-scope state (in-memory rate limiter Maps, the
// account-lockout Map in routes/admin.js, the open SQLite handle in db.js,
// etc.) is reset exactly like a real process restart would reset it. We only
// ever clear our OWN src/ modules from the cache — never node_modules.
function clearSrcCache() {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(SRC_DIR + path.sep)) delete require.cache[key];
  }
}

function makeDataDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'raim-test-'));
}

// Starts a fresh app instance bound to dataDir on an ephemeral port.
// IMPORTANT: this is the only place DATA_DIR is set — it must always be a
// throwaway tmp directory, never the real project data/ dir.
function startApp(dataDir) {
  if (!dataDir || !dataDir.includes('raim-test-')) {
    throw new Error('refusing to start app outside a raim-test- tmp dir: ' + dataDir);
  }
  process.env.DATA_DIR = dataDir;
  clearSrcCache();
  const app = require(APP_PATH);
  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once('listening', () => {
      const { port } = server.address();
      resolve({ app, server, baseUrl: `http://127.0.0.1:${port}`, dataDir });
    });
    server.once('error', reject);
  });
}

function stopApp(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Simulates a process restart against the same DATA_DIR: closes the old
// server and boots a brand-new one, resetting all in-memory counters while
// keeping the on-disk SQLite data intact.
async function restartApp(ctx) {
  await stopApp(ctx.server);
  const fresh = await startApp(ctx.dataDir);
  ctx.app = fresh.app;
  ctx.server = fresh.server;
  ctx.baseUrl = fresh.baseUrl;
  return ctx;
}

function openDb(dataDir) {
  return new DatabaseSync(path.join(dataDir, 'raim.db'));
}

// Opens a short-lived read connection, runs fn(db), always closes.
function withDb(dataDir, fn) {
  const db = openDb(dataDir);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// ---------- cookie jar ----------
function newJar() {
  return new Map();
}
function absorbSetCookie(jar, res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const sc of setCookies) {
    const pair = sc.split(';')[0];
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    jar.set(name, value);
  }
}
function cookieHeader(jar) {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

// Like a real HTML form: an array value (e.g. multiple checked `weekdays`
// checkboxes sharing one `name`) becomes repeated key=value pairs, not a
// single comma-joined value (which is what `new URLSearchParams(obj)` would
// naively produce, since it just String()s each property value).
function encodeFormBody(body) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (Array.isArray(value)) {
      for (const v of value) params.append(key, v);
    } else if (value != null) {
      params.append(key, value);
    }
  }
  return params.toString();
}

async function request(baseUrl, jar, method, urlPath, { body, headers } = {}) {
  const opts = { method, redirect: 'manual', headers: { ...(headers || {}) } };
  if (jar && jar.size) opts.headers['Cookie'] = cookieHeader(jar);
  if (body != null) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = typeof body === 'string' ? body : encodeFormBody(body);
  }
  const res = await fetch(baseUrl + urlPath, opts);
  if (jar) absorbSetCookie(jar, res);
  return res;
}

function get(baseUrl, jar, urlPath) {
  return request(baseUrl, jar, 'GET', urlPath);
}
function post(baseUrl, jar, urlPath, body) {
  return request(baseUrl, jar, 'POST', urlPath, { body });
}

// ---------- CSRF ----------
// Scrapes the raim.csrf token out of a rendered form's `_csrf` hidden input,
// per the P0-4 spec (not just reading the cookie directly) — this exercises
// the actual template output, not just the double-submit-cookie plumbing.
async function getCsrf(baseUrl, jar, pagePath) {
  const res = await get(baseUrl, jar, pagePath);
  const text = await res.text();
  const m = text.match(/name="_csrf"\s+value="([^"]*)"/);
  if (!m) throw new Error(`CSRF token not found on GET ${pagePath} (status ${res.status})`);
  return m[1];
}

// Fetches a CSRF token from csrfPage (default: a page that's always safe to
// scrape a token from) and POSTs body + _csrf to postPath.
async function postForm(baseUrl, jar, postPath, body, { csrfPage } = {}) {
  const page = csrfPage || '/reserve';
  const csrf = await getCsrf(baseUrl, jar, page);
  return post(baseUrl, jar, postPath, { ...body, _csrf: csrf });
}

// Same page picked for admin (logged-in) CSRF scraping — /admin/schedule
// unconditionally renders _csrf hidden inputs regardless of data present.
async function postAdminForm(baseUrl, jar, postPath, body) {
  return postForm(baseUrl, jar, postPath, body, { csrfPage: '/admin/schedule' });
}

// Deliberately posts WITHOUT a valid _csrf (for CSRF-rejection tests).
function postFormNoCsrf(baseUrl, jar, postPath, body) {
  return post(baseUrl, jar, postPath, { ...body });
}

// ---------- date helpers (KST) ----------
// Re-implemented locally (mirrors src/helpers.js todayStr/addDays/weekdayOf)
// rather than requiring src/helpers.js, because requiring it would pull in
// src/db.js and open a DB connection — before DATA_DIR is deliberately set —
// which risks touching the real dev database. Keeping this file DB-free until
// startApp() runs is what keeps data/raim.db safe.
function todayStrKST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul' }).format(new Date());
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekdayOf(dateStr) {
  return new Date(dateStr + 'T12:00:00Z').getUTCDay(); // 0=Sun..6=Sat
}
// Next date (strictly after today, KST) matching targetDow, guaranteed
// within a 60-day booking window (search radius is only 7 days).
function nextWeekday(targetDow) {
  const today = todayStrKST();
  for (let i = 1; i <= 7; i++) {
    const candidate = addDays(today, i);
    if (weekdayOf(candidate) === targetDow) return candidate;
  }
  throw new Error('nextWeekday: not found within 7 days');
}
const nextMonday = () => nextWeekday(1);
// 공휴일이 아닌(= 실제로 휴관하는) 다음 월요일. 월요일이 공휴일이면 과학관은
// 문을 열고 대신 화요일에 쉬므로, "월요일은 닫혀 있다"를 확인하는 테스트는
// 공휴일 월요일을 피해야 한다. holidays.js는 DB를 열지 않아 여기서 안전하게 쓴다.
const publicHolidays = require('../src/holidays');
function nextClosedMonday() {
  const today = todayStrKST();
  for (let i = 1; i <= 90; i++) {
    const candidate = addDays(today, i);
    if (weekdayOf(candidate) === 1 && !publicHolidays.isHoliday(candidate)) return candidate;
  }
  throw new Error('nextClosedMonday: not found within 90 days');
}
const nextWednesday = () => nextWeekday(3);

// ---------- reservation helper ----------
let emailCounter = 0;
function uniqueEmail() {
  emailCounter += 1;
  return `visitor${Date.now()}${emailCounter}@example.com`;
}

// Performs a normal, successful public reservation request. Returns the
// parsed { code, email, date, slot_id, name, party_size } plus the raw
// redirect Response. Defaults to next Wednesday's English permanent-tour
// session with party size 2, per the spec's canonical "normal" booking.
async function makeReservation(baseUrl, jar, overrides = {}) {
  const date = overrides.date || nextWednesday();
  const sessRes = await get(baseUrl, jar, `/api/sessions?date=${encodeURIComponent(date)}`);
  const day = await sessRes.json();
  let slotId = overrides.slot_id;
  if (slotId == null) {
    const wantLang = overrides.language;
    const wantType = overrides.tour_type;
    const candidates = (day.sessions || []).filter((s) => !s.past
      && (wantLang == null || s.language === wantLang)
      && (wantType == null || s.tour_type === wantType));
    if (!candidates.length) throw new Error(`makeReservation: no matching session on ${date}`);
    slotId = candidates[0].id;
  }
  const email = overrides.email || uniqueEmail();
  const body = {
    date,
    slot_id: String(slotId),
    name: overrides.name != null ? overrides.name : 'Test Visitor',
    email,
    country: overrides.country != null ? overrides.country : 'Testland',
    party_size: String(overrides.party_size != null ? overrides.party_size : 2),
    notes: overrides.notes != null ? overrides.notes : '',
    agree: overrides.agree != null ? overrides.agree : 'on',
  };
  if (overrides.website != null) body.website = overrides.website;
  const res = await postForm(baseUrl, jar, '/reserve', body, { csrfPage: '/reserve' });
  const location = res.headers.get('location') || '';
  const url = new URL(location, baseUrl);
  const code = url.searchParams.get('code');
  return { res, code, email, date, slot_id: slotId, party_size: Number(body.party_size) };
}

// ---------- admin login helper ----------
async function adminLogin(baseUrl, jar, { username = 'admin', password = 'raim2026!' } = {}) {
  return postForm(baseUrl, jar, '/admin/login', { username, password }, { csrfPage: '/admin/login' });
}

module.exports = {
  REPO_ROOT, SRC_DIR, APP_PATH,
  makeDataDir, startApp, stopApp, restartApp, openDb, withDb,
  newJar, get, post, request,
  getCsrf, postForm, postAdminForm, postFormNoCsrf,
  todayStrKST, addDays, weekdayOf, nextWeekday, nextMonday, nextClosedMonday, nextWednesday,
  makeReservation, uniqueEmail, adminLogin,
};
