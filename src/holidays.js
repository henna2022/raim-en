'use strict';
// 대한민국 공휴일 표.
//
// 왜 표로 두는가: 설날·추석·부처님오신날은 음력 기준이라 공식으로 계산할 수 없고,
// 계산하려면 음력 변환 라이브러리(새 의존성)나 외부 API(네트워크 장애 지점)가
// 필요하다. 이 앱은 의존성 없이 오프라인으로 동작해야 하므로 검증된 날짜를
// 직접 싣는다.
//
// 표에 없는 연도가 오면 isHoliday()는 false를 돌려주고 부팅 시 경고를 남긴다.
// 그 경우에도 Admin > Schedule에서 날짜를 직접 등록하면 정상 동작한다.
//
// 갱신 방법: 관공서의 공휴일에 관한 규정 + 한국천문연구원 음양력 자료로 확인해
// HOLIDAYS에 연도를 추가하고, 설날/추석 "당일"에 seollal / chuseok 표시를 남길 것.

// date → { name, substitute, seollal, chuseok }
const HOLIDAYS = new Map();

function add(date, name, opts = {}) {
  HOLIDAYS.set(date, {
    name,
    substitute: !!opts.substitute,
    seollal: !!opts.seollal,   // 설날 당일(음력 1/1)에만 true
    chuseok: !!opts.chuseok,   // 추석 당일(음력 8/15)에만 true
  });
}

// ── 2026 ──────────────────────────────────────────────
add('2026-01-01', '1월 1일');
add('2026-02-16', '설날 연휴');
add('2026-02-17', '설날', { seollal: true });
add('2026-02-18', '설날 연휴');
add('2026-03-01', '삼일절');
add('2026-03-02', '삼일절 대체공휴일', { substitute: true });
add('2026-05-05', '어린이날');
add('2026-05-24', '부처님오신날');
add('2026-05-25', '부처님오신날 대체공휴일', { substitute: true });
add('2026-06-06', '현충일');
add('2026-08-15', '광복절');
add('2026-08-17', '광복절 대체공휴일', { substitute: true });
add('2026-09-24', '추석 연휴');
add('2026-09-25', '추석', { chuseok: true });
add('2026-09-26', '추석 연휴');
add('2026-10-03', '개천절');
add('2026-10-05', '개천절 대체공휴일', { substitute: true });
add('2026-10-09', '한글날');
add('2026-12-25', '기독탄신일');

// ── 2027 ──────────────────────────────────────────────
add('2027-01-01', '1월 1일');
add('2027-02-06', '설날 연휴');
add('2027-02-07', '설날', { seollal: true });
add('2027-02-08', '설날 연휴');
add('2027-02-09', '설날 대체공휴일', { substitute: true });
add('2027-03-01', '삼일절');
add('2027-05-05', '어린이날');
add('2027-05-13', '부처님오신날');
add('2027-06-06', '현충일');
add('2027-06-07', '현충일 대체공휴일', { substitute: true });
add('2027-08-15', '광복절');
add('2027-08-16', '광복절 대체공휴일', { substitute: true });
add('2027-09-14', '추석 연휴');
add('2027-09-15', '추석', { chuseok: true });
add('2027-09-16', '추석 연휴');
add('2027-10-03', '개천절');
add('2027-10-04', '개천절 대체공휴일', { substitute: true });
add('2027-10-09', '한글날');
add('2027-10-11', '한글날 대체공휴일', { substitute: true });
add('2027-12-25', '기독탄신일');

// ── 2028 ──────────────────────────────────────────────
add('2028-01-01', '1월 1일');
add('2028-01-26', '설날 연휴');
add('2028-01-27', '설날', { seollal: true });
add('2028-01-28', '설날 연휴');
add('2028-03-01', '삼일절');
add('2028-05-02', '부처님오신날');
add('2028-05-05', '어린이날');
add('2028-06-06', '현충일');
add('2028-08-15', '광복절');
add('2028-10-02', '추석 연휴');
add('2028-10-03', '추석 · 개천절', { chuseok: true });
add('2028-10-04', '추석 연휴');
add('2028-10-05', '추석 대체공휴일', { substitute: true });
add('2028-10-09', '한글날');
add('2028-12-25', '기독탄신일');

const YEARS = new Set([...HOLIDAYS.keys()].map(d => d.slice(0, 4)));

function isCovered(dateStr) {
  return YEARS.has(String(dateStr).slice(0, 4));
}

function holidayInfo(dateStr) {
  return HOLIDAYS.get(dateStr) || null;
}

function isHoliday(dateStr) {
  return HOLIDAYS.has(dateStr);
}

// 과학관이 공휴일이어도 문을 닫는 날: 1월 1일, 설날 당일, 추석 당일.
function isClosedHoliday(dateStr) {
  if (/-01-01$/.test(dateStr)) return { closed: true, name: '1월 1일' };
  const h = HOLIDAYS.get(dateStr);
  if (h && h.seollal) return { closed: true, name: '설날 당일' };
  if (h && h.chuseok) return { closed: true, name: '추석 당일' };
  return null;
}

function coveredYears() {
  return [...YEARS].sort();
}

module.exports = { isHoliday, holidayInfo, isClosedHoliday, isCovered, coveredYears, HOLIDAYS };
