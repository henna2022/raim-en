'use strict';
const { db, getSettings } = require('./db');
const holidays = require('./holidays');
const crypto = require('node:crypto');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Reply SLA for pending requests, shared by the dashboard badges and the
// morning digest email.
const SLA_HOURS = 48;

// 데모 시드(scripts/demo-seed.js)가 만든 행을 식별하는 이메일 도메인.
// RFC 2606이 문서·예시용으로 영구 예약한 도메인이라 실제로 배달되지 않는다 —
// 이 주소로 가는 메일·시트 내보내기·다이제스트 집계는 전부 부작용일 뿐이다.
// 부작용을 내는 스케줄 작업(대기자 자동거절·다이제스트·시트 미러)이 이 행을
// 건너뛰게 해서, 데모 데이터가 실서비스처럼 새어 나가지 않게 한다.
const DEMO_EMAIL_DOMAIN = 'demo.example';
// 우리가 만든 고정 리터럴만 넣는다(사용자 입력 아님) — SQL 조각으로 안전하다.
const NOT_DEMO_SQL = (alias) => `${alias ? alias + '.' : ''}email NOT LIKE '%@${DEMO_EMAIL_DOMAIN}'`;

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

// 휴관 판정. 우선순위대로:
//   ① Admin > Schedule의 수동 등록(closures)이 항상 최우선
//   ② 1월 1일 / 설날 당일 / 추석 당일은 공휴일이어도 휴관
//   ③ 월요일은 원칙 휴관. 단 그 월요일이 공휴일이면 개관한다
//   ④ 화요일은, 직전 월요일이 공휴일이라 개관했다면 대체 휴관
// ③에서 월요일이 ②에 걸려 어차피 닫는 날이라면 대체 휴관을 만들지 않는다 —
// 화요일 휴관은 "월요일에 열었으니 대신 쉬는" 보상이기 때문.
// Returns { closed: bool, reason: string, openOverride: bool }
function closureInfo(dateStr) {
  const override = db.prepare('SELECT kind, reason FROM closures WHERE date = ?').get(dateStr);
  if (override) {
    if (override.kind === 'open') return { closed: false, reason: '', openOverride: true };
    return { closed: true, reason: override.reason || 'Closed (museum notice)', openOverride: false };
  }

  const fixed = holidays.isClosedHoliday(dateStr);
  if (fixed) return { closed: true, reason: `Closed (${fixed.name})`, openOverride: false };

  const wd = weekdayOf(dateStr);
  if (wd === 1) {
    // 월요일이 공휴일이면 개관하고, 대신 다음 날 화요일에 쉰다.
    if (holidays.isHoliday(dateStr)) {
      return { closed: false, reason: '', openOverride: true };
    }
    return { closed: true, reason: 'Closed every Monday', openOverride: false };
  }

  if (wd === 2) {
    const monday = addDays(dateStr, -1);
    // 그 월요일이 ②로 이미 닫는 날이었다면 보상 휴관이 필요 없다.
    if (holidays.isHoliday(monday) && !holidays.isClosedHoliday(monday)
        && !db.prepare(`SELECT 1 FROM closures WHERE date = ? AND kind = 'closed'`).get(monday)) {
      return { closed: true, reason: 'Closed (open on Monday for the public holiday)', openOverride: false };
    }
  }

  return { closed: false, reason: '', openOverride: false };
}

// 이 회차가 그 날짜에 운영되는가. 요일 목록에 들어 있거나, 공휴일 추가 운영
// 회차(also_on_holiday)인데 그날이 공휴일이면 운영한다 — 기획전시 09:30이 주말과
// 공휴일에만 열리는 경우가 여기 해당한다.
// sessionsForDate와 sessionOrdinal이 반드시 같은 규칙을 써야 회차 번호가 어긋나지 않는다.
function slotRunsOn(slot, dateStr, wd) {
  if (slot.weekdays.split(',').includes(wd)) return true;
  return !!slot.also_on_holiday && holidays.isHoliday(dateStr);
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
  const soldoutIds = new Set(
    db.prepare('SELECT slot_id FROM soldout WHERE date = ?').all(dateStr).map(r => r.slot_id)
  );
  const rows = db.prepare('SELECT * FROM slots WHERE active = 1 ORDER BY start_time, tour_type').all();
  const running = rows.filter(s => slotRunsOn(s, dateStr, wd));
  // 전시별 회차 번호. 그날 실제로 운영되는 회차만 세므로 주말·공휴일에 09:30이
  // 붙으면 뒤 회차 번호가 하나씩 밀린다 — 직원·yeyak과 같은 번호를 써야 한다.
  const ordinals = new Map();
  for (const type of ['permanent', 'special']) {
    running.filter(s => s.tour_type === type)
      .sort((a, b) => a.start_time.localeCompare(b.start_time))
      .forEach((s, i) => ordinals.set(s.id, i + 1));
  }
  const sessions = running
    .map(s => ({
      id: s.id,
      tour_type: s.tour_type,
      ordinal: ordinals.get(s.id),
      start_time: s.start_time,
      end_time: s.end_time,
      language: s.language,
      label: s.label,
      past: isToday && s.start_time <= cutoff,
      soldout: soldoutIds.has(s.id),
    }));
  return { closed: false, reason: '', sessions };
}

// 그 날짜에 운영되는 같은 전시 회차 중 몇 번째인지 (1부터). 기획전시는 주말에만
// 09:30 회차가 열려 번호가 요일마다 달라지므로(평일 16:30=6회차, 주말 16:30=7회차)
// 고정 번호를 쓸 수 없고 날짜별로 계산해야 한다. 찾지 못하면 null.
function sessionOrdinal(dateStr, tourType, slotId) {
  if (!isValidDateStr(dateStr)) return null;
  const { openOverride } = closureInfo(dateStr);
  let wd = String(weekdayOf(dateStr));
  // 공휴일 대체로 개관한 월요일은 화요일 시간표를 따른다(sessionsForDate와 동일 규칙).
  if (openOverride && wd === '1') wd = '2';
  const sameDay = db.prepare(
    'SELECT id, weekdays, also_on_holiday FROM slots WHERE active = 1 AND tour_type = ? ORDER BY start_time'
  ).all(tourType).filter(s => slotRunsOn(s, dateStr, wd));
  const idx = sameDay.findIndex(s => s.id === slotId);
  return idx === -1 ? null : idx + 1;
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

// 예약번호만으로 조회했을 때 보여줄 이름. 본인이 자기 예약임을 알아보기에는
// 충분하되, 번호를 주웠거나 어깨너머로 본 사람이 신청자를 특정하지는 못하게
// 이름 전체의 첫 글자 하나 + '•••' 한 덩어리로 가린다. 낱말별로 가리면 낱말
// 수와 각 낱말의 첫 글자가 그대로 드러나는데, '이 수 민'·'李 明'처럼 띄어 쓴
// 한글·한자 이름은 그게 이름 전부다. 한 덩어리로 고정하면 낱말 수도 이름
// 길이도 새지 않는다. 이메일은 아예 내보내지 않는다(PIPA).
function maskName(name) {
  const trimmed = String(name == null ? '' : name).trim();
  if (!trimmed) return '';
  // 첫 글자는 코드 포인트 단위로 잘라야 한다. trimmed[0]은 UTF-16 단위라 '𠮷田'
  // 같은 이름에서 상위 서로게이트만 남고, UTF-8로 못 옮겨 브라우저에 U+FFFD(�)로
  // 뜬다 — 본인이 알아보라고 남긴 글자가 깨져 버린다.
  return [...trimmed][0] + '•••';
}

// 공개 예약조회(/booking)는 외국인 방문객용이라 영어를 유지한다. 관리자 페이지는
// 한국인 직원이 쓰므로 아래 STATUS_BADGE_KO를 쓴다 — 라벨만 다르고 CSS 클래스는
// 같다. 상태 키(pending 등)와 클래스는 절대 번역하지 않는다(로직·스타일에 쓰인다).
const STATUS_BADGE = {
  pending: ['Pending review', 'badge-pending'],
  waitlisted: ['Waitlisted', 'badge-waitlisted'],
  confirmed: ['Confirmed', 'badge-confirmed'],
  declined: ['Declined', 'badge-declined'],
  cancelled: ['Cancelled', 'badge-cancelled'],
  attended: ['Attended', 'badge-attended'],
  no_show: ['No-show', 'badge-noshow'],
};

// 관리자 페이지용 한국어 상태 라벨. 용어는 직원이 이미 보는 곳(README·직원 알림
// 메일·구글 시트)과 맞춘다: 확정 상태는 '확정', 대기자는 '대기자' 등.
const STATUS_BADGE_KO = {
  pending: ['검토 대기', 'badge-pending'],
  waitlisted: ['대기자', 'badge-waitlisted'],
  confirmed: ['확정', 'badge-confirmed'],
  declined: ['거절', 'badge-declined'],
  cancelled: ['취소', 'badge-cancelled'],
  attended: ['방문완료', 'badge-attended'],
  no_show: ['노쇼', 'badge-noshow'],
};

module.exports = {
  DATE_RE, SLA_HOURS, DEMO_EMAIL_DOMAIN, NOT_DEMO_SQL,
  isValidDateStr, todayStr, nowHM, weekdayOf, addDays,
  closureInfo, sessionsForDate, sessionOrdinal, slotRunsOn, genCode, getEnglishTours,
  getReservation, getReservationByCode, maskName, STATUS_BADGE, STATUS_BADGE_KO, getSettings,
};
