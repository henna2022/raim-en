'use strict';
// scripts/apps-script/Code.gs 검증.
// 이 스크립트는 Google 쪽에서 도는 코드라 npm test로는 닿지 않는다. 그래서 Apps Script
// API(SpreadsheetApp / LockService / PropertiesService / ContentService)를 흉내내는
// 샌드박스를 만들고 실제 파일을 vm으로 실행해, 사용자가 시트에 붙여넣기 전에
// upsert·삭제·열 이동·인증·수식 이스케이프가 맞는지 고정한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function makeSheet(name) {
  const grid = []; // grid[row-1][col-1]
  // Apps Script에서는 getValue/setValue/getValues/setValues 한 번이 서버 왕복 한 번이다.
  // 이 카운터가 곧 성능 지표다 — 셀 단위로 쓰면 배치가 실행 시간 제한에 걸린다.
  const calls = { read: 0, write: 0 };
  const ensure = (r, c) => {
    while (grid.length < r) grid.push([]);
    const row = grid[r - 1];
    while (row.length < c) row.push('');
  };
  const sheet = {
    getName: () => name,
    getLastRow: () => grid.length,
    getLastColumn: () => grid.reduce((m, r) => Math.max(m, r.length), 0),
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValue: () => { calls.read++; return grid[r - 1] && grid[r - 1][c - 1] !== undefined ? grid[r - 1][c - 1] : ''; },
        setValue: (v) => { calls.write++; ensure(r, c); grid[r - 1][c - 1] = v; },
        getValues: () => {
          calls.read++;
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) {
              const g = grid[r - 1 + i];
              row.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : '');
            }
            out.push(row);
          }
          return out;
        },
        setValues: (vals) => {
          calls.write++;
          for (let i = 0; i < vals.length; i++) {
            for (let j = 0; j < vals[i].length; j++) { ensure(r + i, c + j); grid[r - 1 + i][c - 1 + j] = vals[i][j]; }
          }
        },
        setFontWeight: () => {},
      };
    },
    appendRow: (vals) => { grid.push([...vals]); },
    deleteRow: (r) => { grid.splice(r - 1, 1); },
    setFrozenRows: () => {},
    _grid: grid,
    _calls: calls,
  };
  return sheet;
}

function run(scriptPath, { secret = 'S3CRET', sheet = makeSheet('예약신청') } = {}) {
  const sandbox = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k === 'SHEETS_WEBHOOK_SECRET' ? secret : null) }) },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: (n) => (n === sheet.getName() ? sheet : null), insertSheet: () => sheet }),
      flush: () => {},
    },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }),
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox);
  const post = (payload) => JSON.parse(
    sandbox.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent()
  );
  const get = () => JSON.parse(sandbox.doGet().getContent());
  return { post, get, sheet };
}


const SCRIPT = path.join(__dirname, '..', 'scripts', 'apps-script', 'Code.gs');
const HEADERS = ['신청코드', '상태', '방문일', '회차', '전시', '언어', '이름', '이메일', '국가',
  '인원', '요청사항', '신청일시', '처리일시', '처리자', '거절사유', '최종동기화'];
const row = (over = {}) => ({
  code: 'RAIM-AAA111', status: '대기(검토중)', visit_date: '2026-09-02', session: '15:40–16:30',
  tour_type: '상설전시', language: '영어', name: 'Aiko', email: 'a@example.com', country: 'Japan',
  party_size: 2, notes: '', created_at: '2026-08-13 01:00:00', decided_at: '', decided_by: '', decline_reason: '',
  ...over,
});

test('GS1: 최초 전송이면 헤더를 만들고 행을 추가한다', () => {
  const h = run(SCRIPT);
  const r = h.post({ secret: 'S3CRET', rows: [row()] });
  assert.deepEqual([r.ok, r.appended, r.updated], [true, 1, 0]);
  assert.equal(h.sheet._grid[0][0], '신청코드');
  assert.equal(h.sheet._grid[1][0], 'RAIM-AAA111');
  assert.equal(h.sheet._grid[1][6], 'Aiko');
});

test('GS2: 같은 코드를 다시 보내면 행이 늘지 않고 갱신된다 (upsert)', () => {
  const h = run(SCRIPT);
  h.post({ secret: 'S3CRET', rows: [row()] });
  const r = h.post({ secret: 'S3CRET', rows: [row({ status: '확정', decided_by: 'admin' })] });
  assert.deepEqual([r.appended, r.updated], [0, 1]);
  assert.equal(h.sheet._grid.length, 2, '중복 행이 생기면 안 된다');
  assert.equal(h.sheet._grid[1][1], '확정');
  assert.equal(h.sheet._grid[1][13], 'admin');
});

test('GS3: 비밀키가 틀리거나 없으면 거부한다 (웹앱이 "모든 사용자" 공개라 유일한 방어선)', () => {
  const h = run(SCRIPT);
  assert.equal(h.post({ secret: 'wrong', rows: [row()] }).ok, false);
  assert.equal(h.post({ rows: [row()] }).ok, false);
  assert.equal(h.sheet._grid.length, 0, '거부 시 아무것도 쓰지 않는다');
  // 스크립트 속성이 비어 있으면(설치 미완료) 어떤 요청도 통과시키지 않는다
  const unset = run(SCRIPT, { secret: '' });
  assert.equal(unset.post({ secret: '', rows: [row()] }).ok, false);
});

test('GS4: doGet은 쓰기 건수를 내보내지 않아 서버가 성공으로 오인하지 않는다', () => {
  const g = run(SCRIPT).get();
  assert.equal(g.ok, false);
  assert.equal(g.appended, undefined);
  assert.equal(g.updated, undefined);
});

test('GS5: 방문자가 넣은 수식은 앞에 따옴표가 붙어 실행되지 않는다', () => {
  const h = run(SCRIPT);
  h.post({ secret: 'S3CRET', rows: [row({ name: '=HYPERLINK("http://evil","x")' })] });
  assert.ok(String(h.sheet._grid[1][6]).startsWith("'="));
});

test('GS6: 직원이 열을 끼워 넣어도 헤더 기준으로 올바른 칸에 쓴다', () => {
  const sheet = makeSheet('예약신청');
  sheet.appendRow(['메모', ...HEADERS]); // 맨 앞에 열 추가
  const h = run(SCRIPT, { sheet });
  const r = h.post({ secret: 'S3CRET', rows: [row({ code: 'RAIM-CCC333' })] });
  assert.equal(r.ok, true);
  const written = sheet._grid.find(x => x[1] === 'RAIM-CCC333');
  assert.ok(written, '신청코드가 밀린 위치(2열)에 들어가야 한다');
  assert.equal(written[7], 'Aiko', '이름도 같은 만큼 밀린 위치에 정확히 들어가야 한다');
});

test('GS7: 헤더가 훼손되면 아무것도 쓰지 않고 거부한다', () => {
  const sheet = makeSheet('예약신청');
  sheet.appendRow(['엉뚱한', '헤더']);
  const h = run(SCRIPT, { sheet });
  const r = h.post({ secret: 'S3CRET', rows: [row()] });
  assert.equal(r.ok, false);
  assert.match(r.error, /header mismatch/);
  assert.equal(sheet._grid.length, 1, '거부 시 데이터를 쓰면 안 된다');
});

test('GS8: 보존기한 만료 삭제는 대상만 지우고 나머지는 남긴다', () => {
  const h = run(SCRIPT);
  h.post({ secret: 'S3CRET', rows: [row(), row({ code: 'RAIM-BBB222', name: 'Ben' })] });
  const before = h.sheet._grid.length;
  const r = h.post({ secret: 'S3CRET', deleteCodes: ['RAIM-AAA111'] });
  assert.equal(r.deleted, 1);
  assert.equal(h.sheet._grid.length, before - 1);
  assert.ok(!h.sheet._grid.some(x => x[0] === 'RAIM-AAA111'), '파기 대상이 시트에서 사라져야 한다');
  assert.ok(h.sheet._grid.some(x => x[0] === 'RAIM-BBB222'), '다른 예약은 남아야 한다');
});

test('GS9: 여러 건 삭제 시 행 번호가 밀려 엉뚱한 줄이 지워지지 않는다', () => {
  const h = run(SCRIPT);
  const codes = ['RAIM-R1', 'RAIM-R2', 'RAIM-R3', 'RAIM-R4'];
  h.post({ secret: 'S3CRET', rows: codes.map(c => row({ code: c, name: c })) });
  const r = h.post({ secret: 'S3CRET', deleteCodes: ['RAIM-R1', 'RAIM-R3'] });
  assert.equal(r.deleted, 2);
  const left = h.sheet._grid.slice(1).map(x => x[0]);
  assert.deepEqual(left, ['RAIM-R2', 'RAIM-R4'], '지정한 행만 정확히 지워져야 한다');
});

test('GS10: 없는 코드 삭제와 빈 요청은 조용히 처리된다', () => {
  const h = run(SCRIPT);
  const r = h.post({ secret: 'S3CRET', deleteCodes: ['RAIM-NOPE99'] });
  assert.equal(r.ok, true);
  assert.equal(r.deleted, 0);
  assert.equal(h.post({ secret: 'S3CRET' }).ok, false, '보낼 것이 없으면 거부');
});

test('GS11: 한 줄을 쓸 때 서버 왕복이 몇 번인지 (셀 단위 쓰기 회귀 방지)', () => {
  // 실제 배포에서 확인된 문제: 셀마다 setValue를 부르면 16회 왕복이 되어
  // 갱신 한 건이 30초를 넘겼다. 한 줄은 setValues 한 번으로 써야 한다.
  const h = run(SCRIPT);
  h.post({ secret: 'S3CRET', rows: [row()] });      // 헤더 생성 + append
  const beforeWrites = h.sheet._calls.write;
  h.post({ secret: 'S3CRET', rows: [row({ status: '확정' })] });  // 갱신 1건
  const writes = h.sheet._calls.write - beforeWrites;
  assert.ok(writes <= 2, `갱신 1건의 쓰기 왕복은 2회 이하여야 한다 (실제 ${writes}회)`);
});

test('GS12: 50건 배치의 왕복 횟수가 건수에 비례하는 수준을 넘지 않는다', () => {
  const h = run(SCRIPT);
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(row({ code: `RAIM-B${String(i).padStart(3, '0')}` }));
  const before = h.sheet._calls.read + h.sheet._calls.write;
  const r = h.post({ secret: 'S3CRET', rows });
  const total = h.sheet._calls.read + h.sheet._calls.write - before;
  assert.equal(r.appended, 50);
  // 건당 쓰기 1 + 확인용 읽기 1 수준. 건당 16회였다면 800을 넘는다.
  assert.ok(total < 200, `50건 배치의 총 왕복은 200회 미만이어야 한다 (실제 ${total}회)`);
});

test('GS13: 갱신 시 우리 열이 아닌 칸(직원이 끼워 넣은 열)은 보존된다', () => {
  const sheet = makeSheet('예약신청');
  // 직원이 '신청코드' 뒤에 '담당자 메모' 열을 끼워 넣은 상황
  sheet.appendRow(['신청코드', '담당자 메모', ...HEADERS.slice(1)]);
  const h = run(SCRIPT, { sheet });
  h.post({ secret: 'S3CRET', rows: [row()] });
  const at = sheet._grid.findIndex(x => x[0] === 'RAIM-AAA111');
  sheet._grid[at][1] = '전화 확인함';               // 직원이 메모 입력
  h.post({ secret: 'S3CRET', rows: [row({ status: '확정' })] });  // 상태 갱신
  assert.equal(sheet._grid[at][1], '전화 확인함', '직원이 쓴 열을 덮어쓰면 안 된다');
  assert.equal(sheet._grid[at][2], '확정', '우리 열은 정상 갱신되어야 한다');
});
