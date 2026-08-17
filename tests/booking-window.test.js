'use strict';
// bookingMaxDate — "매달 10일에 다음 달이 열린다" 달력 규칙 검증.
// helpers를 require하면 db가 열리므로, 실제 data/를 건드리지 않도록 먼저
// DATA_DIR을 임시 폴더로 지정한다(startApp과 동일한 안전장치).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'raim-bw-'));
const { bookingMaxDate } = require('../src/helpers');

test('BW1: 오픈일(10일) 전에는 이번 달 말일까지만', () => {
  assert.equal(bookingMaxDate('2026-08-05', 10), '2026-08-31');
  assert.equal(bookingMaxDate('2026-08-09', 10), '2026-08-31');
});

test('BW2: 오픈일 당일·이후에는 다음 달 말일까지 (예: 8/10 → 9월 전체)', () => {
  assert.equal(bookingMaxDate('2026-08-10', 10), '2026-09-30');
  assert.equal(bookingMaxDate('2026-08-16', 10), '2026-09-30');
  assert.equal(bookingMaxDate('2026-08-31', 10), '2026-09-30');
});

test('BW3: 연말 넘김 — 12/10 이후에는 다음 해 1월 말일', () => {
  assert.equal(bookingMaxDate('2026-12-05', 10), '2026-12-31');
  assert.equal(bookingMaxDate('2026-12-10', 10), '2027-01-31');
});

test('BW4: 다음 달 말일이 달마다 다르게 계산된다 (2월/윤년)', () => {
  assert.equal(bookingMaxDate('2026-01-15', 10), '2026-02-28'); // 2026 평년
  assert.equal(bookingMaxDate('2028-01-15', 10), '2028-02-29'); // 2028 윤년
  assert.equal(bookingMaxDate('2026-03-20', 10), '2026-04-30');
});

test('BW5: 오픈일 설정값을 따른다 (기본 10, 범위 밖은 보정)', () => {
  assert.equal(bookingMaxDate('2026-08-05', 15), '2026-08-31'); // 5 < 15 → 이번 달
  assert.equal(bookingMaxDate('2026-08-20', 15), '2026-09-30'); // 20 >= 15 → 다음 달
  assert.equal(bookingMaxDate('2026-08-05'), '2026-08-31');      // 기본 10
  assert.equal(bookingMaxDate('2026-08-16'), '2026-09-30');
  // 잘못된/빈 값은 기본 10으로, 너무 큰 값은 28로 보정
  assert.equal(bookingMaxDate('2026-08-05', 0), '2026-08-31');   // 0 → 기본 10, 5 < 10 → 이번 달
  assert.equal(bookingMaxDate('2026-08-27', 99), '2026-08-31');  // 99 → 28, 27 < 28 → 이번 달
  assert.equal(bookingMaxDate('2026-08-28', 99), '2026-09-30');  // 28 >= 28 → 다음 달
});
