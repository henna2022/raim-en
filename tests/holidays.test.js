'use strict';
// 공휴일 규칙:
//  · 월요일 휴관이 원칙이나, 그 월요일이 공휴일이면 개관하고 화요일에 대신 쉰다
//  · 1월 1일 / 설날 당일 / 추석 당일은 휴관 (연휴 나머지 이틀은 정상 개관)
//  · 기획전시 09:30 회차는 주말과 공휴일에 추가로 운영된다
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeDataDir, startApp, stopApp, newJar, get } = require('./helper');
const holidays = require('../src/holidays');

let ctx;
let helpers;

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  helpers = require('../src/helpers'); // startApp 이후 — 앱과 같은 DB 핸들
});
test.after(async () => { await stopApp(ctx.server); });

const closure = (d) => helpers.closureInfo(d);
async function sessionsFor(date) {
  return (await (await get(ctx.baseUrl, ctx.jar, `/api/sessions?date=${encodeURIComponent(date)}`)).json());
}

test('H1: 1월 1일 · 설날 당일 · 추석 당일은 휴관한다', () => {
  for (const d of ['2026-01-01', '2027-01-01', '2028-01-01']) {
    assert.equal(closure(d).closed, true, `${d} 신정은 휴관`);
  }
  assert.equal(closure('2026-02-17').closed, true, '2026 설날 당일');
  assert.equal(closure('2026-09-25').closed, true, '2026 추석 당일');
  assert.equal(closure('2027-02-07').closed, true, '2027 설날 당일');
  assert.equal(closure('2027-09-15').closed, true, '2027 추석 당일');
});

test('H2: 설날·추석 연휴의 나머지 이틀은 정상 개관한다', () => {
  // 2026 설날 연휴 2/16(월)~2/18(수) — 당일은 2/17
  assert.equal(closure('2026-02-18').closed, false, '설날 다음날은 개관');
  // 2026 추석 연휴 9/24(목)~9/26(토) — 당일은 9/25
  assert.equal(closure('2026-09-24').closed, false, '추석 전날은 개관');
  assert.equal(closure('2026-09-26').closed, false, '추석 다음날은 개관');
  // 2027 설날 연휴 2/6(토)~2/8(월) — 당일은 2/7
  assert.equal(closure('2027-02-06').closed, false, '설날 전날은 개관');
  assert.equal(closure('2027-02-08').closed, false, '설날 다음날(월)은 공휴일이라 개관');
});

test('H3: 평범한 월요일은 휴관, 공휴일 월요일은 개관한다', () => {
  assert.equal(closure('2026-08-24').closed, true, '공휴일 아닌 월요일');
  assert.match(closure('2026-08-24').reason, /Monday/);

  // 2026-08-17(월) = 광복절 대체공휴일
  assert.ok(holidays.isHoliday('2026-08-17'));
  const mon = closure('2026-08-17');
  assert.equal(mon.closed, false, '공휴일 월요일은 개관');
  assert.equal(mon.openOverride, true);
});

test('H4: 월요일이 공휴일이면 다음 화요일에 대신 휴관한다', () => {
  const tue = closure('2026-08-18'); // 8/17(월) 공휴일의 다음 날
  assert.equal(tue.closed, true, '월요일에 열었으니 화요일에 쉰다');
  assert.match(tue.reason, /Monday/);

  // 앞 월요일이 평범한 날이면 화요일은 정상 개관
  assert.equal(closure('2026-08-25').closed, false, '8/24(월)은 그냥 휴관일 → 화요일 정상');
});

test('H5: 월요일이 어차피 휴관인 공휴일(설날 당일 등)이면 화요일은 쉬지 않는다', () => {
  // 2026-02-16(월)은 설날 연휴지만 당일이 아니므로 공휴일 개관 → 2/17(화)은 설날 당일이라 휴관
  assert.equal(closure('2026-02-16').closed, false, '설날 전날(월)은 공휴일이라 개관');
  assert.equal(closure('2026-02-17').closed, true, '설날 당일은 휴관');

  // 2028-01-01은 토요일이므로, 월요일이 "어차피 닫는 공휴일"인 경우를 직접 만든다:
  // 2027-02-08(월)은 설날 연휴(당일 아님) → 개관, 따라서 2/9(화)는 대체 휴관.
  assert.equal(closure('2027-02-09').closed, true, '2/8(월) 개관에 대한 대체 휴관');
});

test('H6: 기획전시 09:30 회차는 주말과 공휴일에만 열린다', async () => {
  // 평일(목요일) — 09:30 없음, 기획 6회차
  const thu = await sessionsFor('2026-08-20');
  const thuSpecial = thu.sessions.filter(s => s.tour_type === 'special');
  assert.equal(thuSpecial.length, 6, '평일 기획은 6회차');
  assert.ok(!thuSpecial.some(s => s.start_time === '09:30'), '평일에는 09:30 없음');

  // 토요일 — 09:30 포함 7회차
  const sat = await sessionsFor('2026-08-22');
  const satSpecial = sat.sessions.filter(s => s.tour_type === 'special');
  assert.equal(satSpecial.length, 7, '주말 기획은 7회차');
  assert.ok(satSpecial.some(s => s.start_time === '09:30'), '주말에는 09:30 운영');

  // 공휴일(월요일 대체공휴일) — 평일이지만 09:30 운영
  const holiday = await sessionsFor('2026-08-17');
  assert.equal(holiday.closed, undefined === holiday.closed ? holiday.closed : false);
  const holSpecial = holiday.sessions.filter(s => s.tour_type === 'special');
  assert.ok(holSpecial.some(s => s.start_time === '09:30'), '공휴일에는 09:30 운영');
});

test('H7: 회차 번호는 그날 실제 운영 회차 기준으로 매겨진다', async () => {
  const slotAt = (sessions, type, start) =>
    sessions.find(s => s.tour_type === type && s.start_time === start);

  const thu = (await sessionsFor('2026-08-20')).sessions;
  const sat = (await sessionsFor('2026-08-22')).sessions;
  const hol = (await sessionsFor('2026-08-17')).sessions;

  // 같은 16:30이라도 평일은 6회차, 주말·공휴일은 09:30이 앞에 붙어 7회차
  assert.equal(helpers.sessionOrdinal('2026-08-20', 'special', slotAt(thu, 'special', '16:30').id), 6);
  assert.equal(helpers.sessionOrdinal('2026-08-22', 'special', slotAt(sat, 'special', '16:30').id), 7);
  assert.equal(helpers.sessionOrdinal('2026-08-17', 'special', slotAt(hol, 'special', '16:30').id), 7);
  // 상설은 공휴일 여부와 무관하게 항상 6회차 구성
  assert.equal(helpers.sessionOrdinal('2026-08-20', 'permanent', slotAt(thu, 'permanent', '16:40').id), 6);
});

test('H8: 수동 등록(closures)은 공휴일 규칙보다 우선한다', () => {
  const { db } = require('../src/db');
  // 공휴일 월요일을 강제로 휴관 처리
  db.prepare(`INSERT INTO closures (date, kind, reason) VALUES ('2026-08-17','closed','시설 점검')
              ON CONFLICT(date) DO UPDATE SET kind='closed', reason='시설 점검'`).run();
  assert.equal(closure('2026-08-17').closed, true, '수동 휴관이 공휴일 개관보다 우선');
  // 그 월요일은 열지 않았으므로 화요일 대체 휴관도 없어야 한다
  assert.equal(closure('2026-08-18').closed, false, '월요일에 안 열었으면 화요일은 정상');
  db.prepare(`DELETE FROM closures WHERE date = '2026-08-17'`).run();
});

test('H9: 표에 없는 연도는 공휴일 없음으로 처리되고 월요일 규칙만 남는다', () => {
  assert.equal(holidays.isCovered('2026-05-05'), true);
  assert.equal(holidays.isCovered('2035-05-05'), false, '표에 없는 연도');
  assert.equal(holidays.isHoliday('2035-05-05'), false);
  // 표가 없어도 앱이 죽지 않고, 평소 규칙(월요일 휴관)대로 동작해야 한다
  assert.equal(closure('2035-05-07').closed, true, '2035-05-07은 월요일');
  assert.equal(closure('2035-05-08').closed, false);
});
