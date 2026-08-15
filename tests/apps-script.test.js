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
      const range = {
        getSheet: () => sheet,
        getRow: () => r,
        getColumn: () => c,
        getLastRow: () => r + nr - 1,
        getLastColumn: () => c + nc - 1,
        // 데이터 확인 규칙(드롭다운/체크박스)도 서버 왕복 한 번이다 — 건수와
        // 무관하게 일정한지 GS14가 이 카운터로 지킨다.
        setDataValidation: () => { calls.write++; return range; },
        getValue: () => { calls.read++; return grid[r - 1] && grid[r - 1][c - 1] !== undefined ? grid[r - 1][c - 1] : ''; },
        setValue: (v) => { calls.write++; ensure(r, c); grid[r - 1][c - 1] = v; return range; },
        getValues: () => {
          calls.read++;
          const out = [];
          for (let i = 0; i < nr; i++) {
            const line = [];
            for (let j = 0; j < nc; j++) {
              const g = grid[r - 1 + i];
              line.push(g && g[c - 1 + j] !== undefined ? g[c - 1 + j] : '');
            }
            out.push(line);
          }
          return out;
        },
        setValues: (vals) => {
          calls.write++;
          for (let i = 0; i < vals.length; i++) {
            for (let j = 0; j < vals[i].length; j++) { ensure(r + i, c + j); grid[r - 1 + i][c - 1 + j] = vals[i][j]; }
          }
          return range;
        },
        clearContent: () => {
          calls.write++;
          for (let i = 0; i < nr; i++) for (let j = 0; j < nc; j++) { const g = grid[r - 1 + i]; if (g) g[c - 1 + j] = ''; }
          return range;
        },
        setFontWeight: () => range,
      };
      return range;
    },
    appendRow: (vals) => { grid.push([...vals]); },
    deleteRow: (r) => { calls.write++; grid.splice(r - 1, 1); },
    deleteRows: (r, n) => { calls.write++; grid.splice(r - 1, n); },
    insertColumnAfter: (c) => {
      calls.write++;
      for (const row of grid) row.splice(c, 0, '');
    },
    setFrozenRows: () => {},
    _grid: grid,
    _calls: calls,
  };
  return sheet;
}

function run(scriptPath, {
  secret = 'S3CRET', sheet = makeSheet('예약신청'),
  statusUrl = 'https://raim.example/api/sheet/status', statusSecret = 'INBOUND',
  // 시트 → 앱 POST의 가짜 서버. 요청은 fetched[]에 쌓이고, 응답은 reply(body)가 만든다.
  // /refresh 쪽은 refreshReply(body)로 바꿔치기할 수 있다 (기본: ok:true).
  reply = null, refreshFails = false, refreshReply = null,
} = {}) {
  const props = {
    SHEETS_WEBHOOK_SECRET: secret,
    APP_STATUS_URL: statusUrl,
    APP_STATUS_SECRET: statusSecret,
  };
  const fetched = [];
  const refreshed = [];
  const toasts = [];
  const alerts = [];
  const validation = () => {
    const b = {
      requireValueInList: () => b, requireCheckbox: () => b,
      setAllowInvalid: () => b, build: () => ({}),
    };
    return b;
  };
  const sandbox = {
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (k) => props[k] || null,
        setProperty: (k, v) => { props[k] = v; },
      }),
    },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({
        getSheetByName: (n) => (n === sheet.getName() ? sheet : null),
        insertSheet: () => sheet,
        toast: (msg, title) => toasts.push({ msg, title }),
      }),
      getActive: () => ({}),
      getUi: () => ({ createMenu: () => ({ addItem() { return this; }, addToUi() {} }), alert: (m) => alerts.push(m) }),
      newDataValidation: validation,
      flush: () => {},
    },
    LockService: { getDocumentLock: () => ({ tryLock: () => true, releaseLock: () => {} }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: (t) => ({ _t: t, setMimeType() { return this; }, getContent() { return this._t; } }),
    },
    Session: {
      getActiveUser: () => ({ getEmail: () => '' }),
      getEffectiveUser: () => ({ getEmail: () => 'owner@seoulraim.com' }),
    },
    Utilities: { formatDate: () => '2026-08-13 04:00:00' },
    UrlFetchApp: {
      fetch: (url, opts) => {
        const body = JSON.parse(opts.payload);
        if (/\/refresh$/.test(url)) {
          refreshed.push({ url, body });
          const out = refreshReply ? refreshReply(body) : { ok: true, marked: 0 };
          return {
            getResponseCode: () => (refreshFails ? 500 : (out._http || 200)),
            getContentText: () => JSON.stringify(out),
          };
        }
        fetched.push({ url, body });
        const out = reply ? reply(body) : { ok: true, results: body.changes.map(c => ({ code: c.code, ok: true, changed: true, label: c.status })) };
        return {
          getResponseCode: () => (out._http || 200),
          getContentText: () => JSON.stringify(out),
        };
      },
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      deleteTrigger: () => {},
      newTrigger: () => ({ forSpreadsheet: () => ({ onEdit: () => ({ create: () => {} }) }) }),
    },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(scriptPath, 'utf8'), sandbox);
  const post = (payload) => JSON.parse(
    sandbox.doPost({ postData: { contents: JSON.stringify(payload) } }).getContent()
  );
  const get = () => JSON.parse(sandbox.doGet().getContent());
  // 직원이 상태 셀을 고친 상황을 흉내낸다. row는 1부터 세는 시트 행 번호.
  const editStatus = (row, value, { user = 'staff@seoulraim.com', oldValue } = {}) => {
    const col = DISPLAY.indexOf('상태') + 1;
    sheet.getRange(row, col).setValue(value);
    sandbox.onSheetEdit({
      range: sheet.getRange(row, col),
      oldValue,
      user: user == null ? null : { getEmail: () => user },
    });
  };
  const setCell = (row, header, value) => sheet.getRange(row, DISPLAY.indexOf(header) + 1).setValue(value);
  const cell = (row, header) => sheet._grid[row - 1][DISPLAY.indexOf(header)];
  return { post, get, sheet, sandbox, fetched, refreshed, toasts, alerts, editStatus, setCell, cell };
}


const SCRIPT = path.join(__dirname, '..', 'scripts', 'apps-script', 'Code.gs');
// 앱이 채우는 열(미러 대상)과, 시트에 실제로 보이는 열 순서. yeyak차단은 시트
// 전용이라 HEADERS에는 없고 신청코드 바로 뒤에 끼어 있다.
const HEADERS = ['신청코드', '상태', '방문일', '이름', '국가', '전시', '회차', '시간', '예약 인원', '이메일',
  '신청일시', '처리일시', '처리자', '거절사유', '최종동기화'];
const DISPLAY = ['신청코드', 'yeyak차단', ...HEADERS.slice(1)];
const at = (name) => DISPLAY.indexOf(name);
const row = (over = {}) => ({
  code: 'RAIM-AAA111', status: '대기(검토중)', visit_date: '2026-09-02', session: '15:40–16:30',
  tour_type: '상설', session: '5회차', time: '15:40~16:20',
  name: 'Aiko', country: 'Japan', email: 'a@example.com',
  party_size: 2, created_at: '2026-08-13 01:00:00', decided_at: '', decided_by: '', decline_reason: '',
  ...over,
});

test('GS1: 최초 전송이면 헤더를 만들고 행을 추가한다', () => {
  const h = run(SCRIPT);
  const r = h.post({ secret: 'S3CRET', rows: [row()] });
  assert.deepEqual([r.ok, r.appended, r.updated], [true, 1, 0]);
  assert.equal(h.sheet._grid[0][0], '신청코드');
  assert.equal(h.sheet._grid[1][at('신청코드')], 'RAIM-AAA111');
  assert.equal(h.sheet._grid[1][at('이름')], 'Aiko');
});

test('GS2: 같은 코드를 다시 보내면 행이 늘지 않고 갱신된다 (upsert)', () => {
  const h = run(SCRIPT);
  h.post({ secret: 'S3CRET', rows: [row()] });
  const r = h.post({ secret: 'S3CRET', rows: [row({ status: '승인', decided_by: 'admin' })] });
  assert.deepEqual([r.appended, r.updated], [0, 1]);
  assert.equal(h.sheet._grid.length, 2, '중복 행이 생기면 안 된다');
  assert.equal(h.sheet._grid[1][at('상태')], '승인');
  assert.equal(h.sheet._grid[1][at('처리자')], 'admin');
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
  assert.ok(String(h.sheet._grid[1][at('이름')]).startsWith("'="));
});

test('GS6: 직원이 열을 끼워 넣어도 헤더 기준으로 올바른 칸에 쓴다', () => {
  const sheet = makeSheet('예약신청');
  sheet.appendRow(['메모', ...HEADERS]); // 맨 앞에 열 추가
  const h = run(SCRIPT, { sheet });
  const r = h.post({ secret: 'S3CRET', rows: [row({ code: 'RAIM-CCC333' })] });
  assert.equal(r.ok, true);
  const written = sheet._grid.find(x => x[1] === 'RAIM-CCC333');
  assert.ok(written, '신청코드가 밀린 위치(2열)에 들어가야 한다');
  assert.equal(written[4], 'Aiko', '이름도 같은 만큼 밀린 위치에 정확히 들어가야 한다');
});

test('GS7: 필요한 열이 없고 데이터도 없으면 헤더를 자동 재설정한다', () => {
  const sheet = makeSheet('예약신청');
  sheet.appendRow(['엉뚱한', '헤더']); // 우리 열 이름이 하나도 없음
  const h = run(SCRIPT, { sheet });
  const r = h.post({ secret: 'S3CRET', rows: [row()] });
  assert.equal(r.ok, true, '빈 시트라면 헤더를 새로 깔고 진행해야 한다');
  assert.deepEqual(sheet._grid[0].slice(0, DISPLAY.length), DISPLAY);
  assert.equal(r.appended, 1);
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
  h.post({ secret: 'S3CRET', rows: [row({ status: '승인' })] });  // 갱신 1건
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
  const row13 = sheet._grid.findIndex(x => x[0] === 'RAIM-AAA111');
  sheet._grid[row13][1] = '전화 확인함';               // 직원이 메모 입력
  h.post({ secret: 'S3CRET', rows: [row({ status: '승인' })] });  // 상태 갱신
  assert.equal(sheet._grid[row13][1], '전화 확인함', '직원이 쓴 열을 덮어쓰면 안 된다');
  assert.equal(sheet._grid[row13][2], '승인', '우리 열은 정상 갱신되어야 한다');
});

test('GS14: 신규 행 여러 건은 왕복 횟수가 건수와 무관하게 일정하다', () => {
  // 실측: 행마다 따로 쓰면 행당 약 7초 → 50건이면 실행 시간 제한 초과.
  // 신규 행은 값도 드롭다운/체크박스 서식도 범위 단위로 한 번에 써야 한다.
  // 따라서 지켜야 할 것은 "몇 회 이하"가 아니라 "1건이든 30건이든 같다"이다.
  const h = run(SCRIPT);
  h.post({ secret: 'S3CRET', rows: [row()] }); // 헤더 생성

  const beforeOne = h.sheet._calls.write;
  h.post({ secret: 'S3CRET', rows: [row({ code: 'RAIM-N999' })] });
  const writesForOne = h.sheet._calls.write - beforeOne;

  const beforeMany = h.sheet._calls.write;
  const rows = [];
  for (let i = 0; i < 30; i++) rows.push(row({ code: `RAIM-N${String(i).padStart(3, '0')}` }));
  const r = h.post({ secret: 'S3CRET', rows });
  const writesForMany = h.sheet._calls.write - beforeMany;

  assert.equal(r.appended, 30);
  assert.equal(writesForMany, writesForOne,
    `신규 30건의 쓰기 왕복(${writesForMany})이 1건(${writesForOne})과 같아야 한다`);
  assert.ok(writesForOne <= 4, `신규 배치의 쓰기 왕복은 4회 이하여야 한다 (실제 ${writesForOne}회)`);
  // 실제로 30줄이 들어갔는지도 확인
  assert.equal(h.sheet._grid.length, 1 + 2 + 30, '헤더 + 기존 2건 + 신규 30건');
});

test('GS15: 연속된 행 삭제는 한 번의 호출로 처리된다', () => {
  const h = run(SCRIPT);
  const codes = [];
  for (let i = 0; i < 10; i++) codes.push(`RAIM-D${i}`);
  h.post({ secret: 'S3CRET', rows: codes.map(c => row({ code: c })) });
  const before = h.sheet._calls.write;
  const r = h.post({ secret: 'S3CRET', deleteCodes: codes });
  const writes = h.sheet._calls.write - before;
  assert.equal(r.deleted, 10);
  assert.ok(writes <= 2, `연속 10건 삭제는 쓰기 2회 이하 (실제 ${writes}회)`);
  assert.equal(h.sheet._grid.length, 1, '헤더만 남아야 한다');
});

test('GS16: 흩어진 행을 지워도 엉뚱한 줄이 지워지지 않는다', () => {
  const h = run(SCRIPT);
  const codes = ['A', 'B', 'C', 'D', 'E'].map(x => `RAIM-${x}`);
  h.post({ secret: 'S3CRET', rows: codes.map(c => row({ code: c })) });
  h.post({ secret: 'S3CRET', deleteCodes: ['RAIM-A', 'RAIM-C', 'RAIM-E'] });
  assert.deepEqual(h.sheet._grid.slice(1).map(x => x[0]), ['RAIM-B', 'RAIM-D']);
});

test('GS17: 같은 배치에 같은 코드가 두 번 오면 중복 행이 생기지 않는다', () => {
  const h = run(SCRIPT);
  const r = h.post({ secret: 'S3CRET', rows: [row({ status: '접수' }), row({ status: '승인' })] });
  assert.equal(r.appended, 1, '중복 코드는 한 줄로 합쳐져야 한다');
  assert.equal(h.sheet._grid.length, 2, '헤더 + 1행');
  assert.equal(h.sheet._grid[1][at('상태')], '승인', '나중 값이 반영되어야 한다');
});

test('GS18: 필요한 열이 빠진 옛 헤더는 데이터가 없을 때 새 구성으로 재설정된다', () => {
  // 실제 상황: 이미 배포해 둔 시트에 16열 헤더가 남아 있다. 새 열 이름 14개를 모두
  // 포함한 상위집합이므로 재설정 없이 그대로 동작해야 하고, 값은 이름이 붙은 칸에
  // 들어가야 한다(언어·요청사항 칸은 빈 채로 남는다).
  const OLD = ['신청코드', '상태', '방문일', '회차', '전시', '언어', '이름', '이메일', '국가',
    '인원', '요청사항', '신청일시', '처리일시', '처리자', '거절사유', '최종동기화'];
  const sheet = makeSheet('예약신청');
  sheet.appendRow(OLD);
  const h = run(SCRIPT, { sheet });
  const r = h.post({ secret: 'S3CRET', rows: [row()] });
  assert.equal(r.ok, true, '데이터가 없으면 헤더를 새로 깔고 진행');
  assert.deepEqual(sheet._grid[0].slice(0, DISPLAY.length), DISPLAY, '새 헤더로 교체');
  const line = sheet._grid[1];
  assert.equal(line[at('전시')], '상설');
  assert.equal(line[at('회차')], '5회차');
  assert.equal(line[at('시간')], '15:40~16:20');
  assert.equal(line[at('이름')], 'Aiko');
});

test('GS19: 데이터가 있는 시트는 헤더가 안 맞아도 절대 건드리지 않는다', () => {
  const sheet = makeSheet('예약신청');
  sheet.appendRow(['엉뚱한', '헤더']);
  sheet.appendRow(['소중한', '데이터']);
  const h = run(SCRIPT, { sheet });
  const r = h.post({ secret: 'S3CRET', rows: [row()] });
  assert.equal(r.ok, false);
  assert.match(r.error, /header mismatch/);
  assert.deepEqual(sheet._grid[1], ['소중한', '데이터'], '기존 데이터가 보존되어야 한다');
});

// ── 시트 → 앱 (상태 드롭다운) ─────────────────────────────
// 여기가 잘못되면 방문객에게 확정 메일이 잘못 나가거나, 좌석을 막지도 않고
// 확정이 나가 현장에서 자리가 없는 사태가 된다.

// 예약 1건이 들어 있는 시트를 만들어 돌려준다 (행 2가 그 예약).
function seeded(opts = {}) {
  const h = run(SCRIPT, opts);
  h.post({ secret: 'S3CRET', rows: [row()] });
  return h;
}

test('GS20: yeyak 차단을 체크하고 승인하면 서버로 전송되고 처리자가 기록된다', () => {
  const h = seeded();
  h.setCell(2, 'yeyak차단', true);
  h.editStatus(2, '승인');

  assert.equal(h.fetched.length, 1, '서버로 한 번 전송되어야 한다');
  assert.equal(h.fetched[0].body.secret, 'INBOUND');
  assert.deepEqual(h.fetched[0].body.changes, [{
    code: 'RAIM-AAA111', status: '승인', actor: 'staff@seoulraim.com', reason: '',
  }]);
  assert.equal(h.cell(2, '상태'), '승인');
  assert.equal(h.cell(2, '처리자'), 'staff@seoulraim.com', '드롭다운을 바꾼 구글 계정이 남아야 한다');
  assert.equal(h.cell(2, '처리일시'), '2026-08-13 04:00:00');
});

test('GS21: yeyak 차단을 체크하지 않으면 승인이 되돌려지고 서버로 가지 않는다', () => {
  const h = seeded();
  h.editStatus(2, '승인', { oldValue: '대기(검토중)' });

  assert.equal(h.fetched.length, 0, '좌석을 막지 않았으면 확정 메일이 나가면 안 된다');
  assert.equal(h.cell(2, '상태'), '대기(검토중)', '편집 직전 값으로 되돌아가야 한다');
  assert.match(h.toasts.at(-1).msg, /yeyak/);
});

test('GS22: yeyak 열이 아예 없으면 승인을 막는다 (fail closed)', () => {
  // 직원이 열을 지운 상황. 확인할 방법이 없으면 통과시키지 않는다.
  const sheet = makeSheet('예약신청');
  sheet.appendRow(HEADERS);
  const h = seeded({ sheet });
  const statusCol = HEADERS.indexOf('상태') + 1;
  sheet.getRange(2, statusCol).setValue('승인');
  h.sandbox.onSheetEdit({ range: sheet.getRange(2, statusCol), user: { getEmail: () => 's@x.com' } });

  assert.equal(h.fetched.length, 0);
  assert.match(h.toasts.at(-1).msg, /① 시트 설정/);
});

test('GS23: 거절은 yeyak 체크 없이 되고, 거절사유 칸이 함께 전송된다', () => {
  const h = seeded();
  h.setCell(2, '거절사유', '해당 회차 잔여석 없음');
  h.editStatus(2, '거절');

  assert.equal(h.fetched.length, 1);
  assert.equal(h.fetched[0].body.changes[0].status, '거절');
  assert.equal(h.fetched[0].body.changes[0].reason, '해당 회차 잔여석 없음');
});

test('GS24: 서버가 거부하면 서버가 알려준 진짜 상태로 되돌린다', () => {
  // 방문자가 그사이 취소한 경우. 편집 직전 값(대기)은 이미 낡았으므로 쓰지 않는다.
  const h = seeded({
    reply: (body) => ({
      ok: true,
      results: body.changes.map(c => ({ code: c.code, ok: false, error: 'invalid_transition', label: '취소' })),
    }),
  });
  h.setCell(2, 'yeyak차단', true);
  h.editStatus(2, '승인', { oldValue: '대기(검토중)' });

  assert.equal(h.cell(2, '상태'), '취소', '편집 직전 값이 아니라 앱의 현재 상태로 맞춘다');
  assert.match(h.toasts.at(-1).msg, /바꿀 수 없습니다/);
});

test('GS25: 서버가 분명히 거절하면(4xx) 값을 되돌린다', () => {
  const h = seeded({ reply: () => ({ ok: false, _http: 401, error: 'unauthorized' }) });
  h.setCell(2, 'yeyak차단', true);
  h.editStatus(2, '승인');
  assert.equal(h.cell(2, '상태'), '', '되돌릴 값을 모르면 비워서 다시 고르게 한다');
  assert.match(h.toasts.at(-1).title, /반영 실패/);
});

test('GS25b: 응답을 못 받았을 때는 되돌리지 않는다 (이미 메일이 나갔을 수 있다)', () => {
  // 5xx·타임아웃은 서버가 처리를 마치고 응답만 흘렸을 수 있다. 여기서 되돌리면
  // 확정 메일이 나간 예약을 "처리 안 됨"으로 보이게 만든다.
  const h = seeded({ reply: () => ({ ok: false, _http: 502, error: 'bad gateway' }) });
  h.setCell(2, 'yeyak차단', true);
  h.editStatus(2, '승인');
  assert.equal(h.cell(2, '상태'), '승인', '값을 그대로 두고 다음 동기화에 맡긴다');
  assert.match(h.toasts.at(-1).title, /확인 필요/);
});

function bulkEdit(h, n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(row({ code: `RAIM-P${String(i).padStart(3, '0')}` }));
  h.post({ secret: 'S3CRET', rows });
  const statusCol = at('상태') + 1;
  h.sandbox.onSheetEdit({
    range: h.sheet.getRange(2, statusCol, n, 1),
    user: { getEmail: () => 'staff@seoulraim.com' },
  });
}

test('GS25c: 한 번에 20줄을 넘겨 바꾸면 아무것도 반영하지 않는다', () => {
  // 실수로 붙여넣기 한 번에 수십 명에게 확정 메일이 나가는 사고를 막는다.
  const h = run(SCRIPT);
  bulkEdit(h, 25);
  assert.equal(h.fetched.length, 0, '상태 변경 요청은 나가지 않는다');
  assert.match(h.toasts.at(-1).title, /반영하지 않음/);
});

test('GS25d: 그때 시트를 앱 기준으로 되돌려 달라고 요청한다', () => {
  // 이게 없으면 시트에는 '승인'이 찍힌 채 앱은 대기 상태로 남는다. 미러는 DB가
  // 실제로 바뀐 행만 다시 쓰므로, 아무도 그 칸을 고쳐 주지 않는다.
  const h = run(SCRIPT);
  bulkEdit(h, 25);
  assert.equal(h.refreshed.length, 1, '재전송 요청이 나가야 한다');
  assert.equal(h.refreshed[0].url, 'https://raim.example/api/sheet/refresh');
  assert.equal(h.refreshed[0].body.codes.length, 25, '건드린 줄 전부');
  assert.match(h.toasts.at(-1).msg, /앱 기준으로 되돌아갑니다/);
});

test('GS25e: 되돌리기 요청까지 실패하면 그 사실을 숨기지 않는다', () => {
  const h = run(SCRIPT, { refreshFails: true });
  bulkEdit(h, 25);
  assert.match(h.toasts.at(-1).msg, /④ 앱 기준으로 새로고침/,
    '시트 값이 앱과 다를 수 있다는 것과 복구 방법을 알려야 한다');
});

test('GS25f: 응답을 못 받았을 때도 재전송을 요청해 진짜 상태를 다시 받는다', () => {
  const h = seeded({ reply: () => ({ ok: false, _http: 502, error: 'bad gateway' }) });
  h.setCell(2, 'yeyak차단', true);
  h.editStatus(2, '승인');
  assert.equal(h.cell(2, '상태'), '승인', '되돌리지는 않는다 — 이미 처리됐을 수 있다');
  assert.equal(h.refreshed.length, 1, '앱에 진짜 상태를 다시 물어야 한다');
  assert.deepEqual(h.refreshed[0].body.codes, ['RAIM-AAA111']);
});

test('GS26: 상태 열이 아닌 칸을 고치면 아무 일도 일어나지 않는다', () => {
  const h = seeded();
  const nameCol = at('이름') + 1;
  h.sandbox.onSheetEdit({ range: h.sheet.getRange(2, nameCol), user: { getEmail: () => 's@x.com' } });
  assert.equal(h.fetched.length, 0);
});

test('GS27: 편집자 이메일을 알 수 없으면 시트 소유자로 둘러대지 않는다', () => {
  // 개인 gmail 계정으로 편집하면 구글이 이메일을 내주지 않는다. 하지 않은 사람에게
  // 처리 기록이 붙는 것보다 "미확인"이 낫다.
  const h = seeded();
  h.setCell(2, 'yeyak차단', true);
  h.editStatus(2, '승인', { user: null });
  assert.equal(h.fetched[0].body.changes[0].actor, '시트(편집자 미확인)');
  assert.notEqual(h.cell(2, '처리자'), 'owner@seoulraim.com');
});

test('GS28: ① 시트 설정은 yeyak 열을 만들고, 여러 번 실행해도 안전하다', () => {
  const sheet = makeSheet('예약신청');
  sheet.appendRow(HEADERS);   // yeyak 열이 없는 기존 시트
  const h = seeded({ sheet });
  assert.equal(sheet._grid[0].indexOf('yeyak차단'), -1);

  h.sandbox.setupSheet();
  assert.deepEqual(sheet._grid[0].slice(0, DISPLAY.length), DISPLAY, '신청코드 뒤에 끼워 넣는다');
  const width = sheet._grid[0].length;

  h.sandbox.setupSheet();
  assert.equal(sheet._grid[0].length, width, '두 번 실행해도 열이 늘지 않는다');
});

test('GS29: 한 번에 여러 줄을 바꾸면 한 번의 요청으로 묶어 보낸다', () => {
  const h = run(SCRIPT);
  h.post({ secret: 'S3CRET', rows: [row(), row({ code: 'RAIM-BBB222', name: 'Ben' })] });
  h.setCell(2, 'yeyak차단', true);
  h.setCell(3, 'yeyak차단', true);
  const statusCol = at('상태') + 1;
  h.sheet.getRange(2, statusCol).setValue('승인');
  h.sheet.getRange(3, statusCol).setValue('승인');
  h.sandbox.onSheetEdit({
    range: h.sheet.getRange(2, statusCol, 2, 1),
    user: { getEmail: () => 'staff@seoulraim.com' },
  });
  assert.equal(h.fetched.length, 1, 'Apps Script 실행 시간 제한이 있어 행마다 부르면 안 된다');
  assert.deepEqual(h.fetched[0].body.changes.map(c => c.code), ['RAIM-AAA111', 'RAIM-BBB222']);
});

test('GS30: 체크해 둔 yeyak 칸은 앱→시트 동기화가 덮어쓰지 않는다', () => {
  // 이 칸이 동기화 때마다 풀리면 안전장치가 사실상 없는 것이 된다 —
  // 직원이 좌석을 막고 체크한 뒤 상태가 한 번 동기화되면 승인이 막혀 버린다.
  const h = seeded();
  h.setCell(2, 'yeyak차단', true);
  h.post({ secret: 'S3CRET', rows: [row({ decided_by: 'admin' })] }); // 앱이 같은 행을 갱신
  assert.equal(h.cell(2, 'yeyak차단'), true);
  assert.equal(h.cell(2, '처리자'), 'admin', '앱이 채우는 열은 정상 갱신되어야 한다');
});

test('GS31: 새로 들어온 신청의 yeyak 칸은 체크되지 않은 상태로 시작한다', () => {
  const h = run(SCRIPT);
  h.post({ secret: 'S3CRET', rows: [row()] });
  assert.equal(h.cell(2, 'yeyak차단'), false, '아직 좌석을 막지 않은 신청이다');
});

// ── 서버 왕복 중 행이 밀리는 경합 (applyResults_) ─────────────

test('GS32: 서버 왕복 중 위 행이 지워져도 처리자·처리일시가 제 줄에 찍힌다', () => {
  // 왕복은 메일 발송까지 수 초가 걸리고 그동안 시트는 잠겨 있지 않다 — 보존기한
  // 삭제나 직원의 행 삭제로 행이 밀리면, 편집 시점의 행 번호는 남의 예약을 가리킨다.
  const h = run(SCRIPT, {
    reply: (body) => {
      // 서버가 응답하기 직전, 첫 데이터 행(RAIM-AAA111)이 삭제돼 아래가 당겨진다.
      h.sheet.deleteRow(2);
      return { ok: true, results: body.changes.map(c => ({ code: c.code, ok: true, changed: true, label: c.status })) };
    },
  });
  h.post({ secret: 'S3CRET', rows: [row(), row({ code: 'RAIM-BBB222', name: 'Ben' })] });
  h.setCell(3, 'yeyak차단', true);
  h.editStatus(3, '승인'); // RAIM-BBB222 (3행) 승인 — 응답이 올 때는 2행이 됨
  assert.equal(h.cell(2, '신청코드'), 'RAIM-BBB222');
  assert.equal(h.cell(2, '처리자'), 'staff@seoulraim.com', '당겨진 새 위치에 찍혀야 한다');
  assert.notEqual(h.cell(2, '상태'), '', '남의 줄로 오인해 지우면 안 된다');
});

test('GS33: 왕복 중 행이 지워진 뒤의 거부 응답은 밀려 들어온 다른 예약을 되돌리지 않는다', () => {
  const h = run(SCRIPT, {
    reply: (body) => {
      h.sheet.deleteRow(2); // RAIM-AAA111 삭제 — RAIM-BBB222가 2행으로 당겨진다
      return { ok: true, results: body.changes.map(c => ({ code: c.code, ok: false, error: 'invalid_transition', label: '취소' })) };
    },
  });
  h.post({ secret: 'S3CRET', rows: [row(), row({ code: 'RAIM-BBB222', name: 'Ben', status: '대기(검토중)' })] });
  h.setCell(3, 'yeyak차단', true);
  h.editStatus(3, '승인'); // 거부됨 — 되돌리기는 BBB222의 지금 위치(2행)에 가야 한다
  assert.equal(h.cell(2, '신청코드'), 'RAIM-BBB222');
  assert.equal(h.cell(2, '상태'), '취소', '서버가 알려준 진짜 상태로, 제 줄에 되돌린다');
});

test('GS34: 왕복 중 그 행 자체가 사라졌으면 아무 줄도 건드리지 않고 알린다', () => {
  const h = run(SCRIPT, {
    reply: (body) => {
      h.sheet.deleteRow(3); // 편집한 행(RAIM-BBB222)이 통째로 삭제됨
      return { ok: true, results: body.changes.map(c => ({ code: c.code, ok: true, changed: true, label: c.status })) };
    },
  });
  h.post({ secret: 'S3CRET', rows: [row(), row({ code: 'RAIM-BBB222', name: 'Ben' })] });
  h.setCell(3, 'yeyak차단', true);
  const before = JSON.stringify(h.sheet._grid);
  h.editStatus(3, '승인');
  // editStatus가 셀에 쓴 '승인' 외에는 아무것도 변하지 않아야 한다 — 특히 남은
  // RAIM-AAA111(2행)에 처리자가 찍히면 안 된다.
  assert.equal(h.cell(2, '신청코드'), 'RAIM-AAA111');
  assert.equal(h.cell(2, '처리자'), '', '남의 줄에 처리자가 찍히면 안 된다');
  assert.match(h.toasts.at(-1).msg, /행을 찾지 못해/, '직원이 알 수 있어야 한다');
  void before;
});

// ── 갱신 경로 배치화 ─────────────────────────────────────────

test('GS35: 전부 갱신인 50건 배치도 왕복 횟수가 건수와 무관하게 일정하다', () => {
  // ④ 새로고침 직후에는 배치 전체가 갱신이다 — 행마다 확인·읽기·쓰기 3회면
  // 150왕복으로 서버 타임아웃(45초)을 넘긴다. 연속 구간이면 읽기 1 + 쓰기 1이어야 한다.
  const h = run(SCRIPT);
  const rows = [];
  for (let i = 0; i < 50; i++) rows.push(row({ code: `RAIM-U${String(i).padStart(3, '0')}` }));
  h.post({ secret: 'S3CRET', rows });
  h.sheet._calls.read = 0;
  h.sheet._calls.write = 0;
  const r = h.post({ secret: 'S3CRET', rows: rows.map(x => ({ ...x, status: '승인' })) });
  assert.equal(r.updated, 50);
  assert.ok(h.sheet._calls.read + h.sheet._calls.write <= 6,
    `왕복 ${h.sheet._calls.read + h.sheet._calls.write}회 — 행 수에 비례하면 안 된다`);
  assert.equal(h.cell(2, '상태'), '승인');
  assert.equal(h.cell(51, '상태'), '승인');
});

test('GS36: 갱신 배치 도중 행이 밀려도 인덱스를 다시 읽어 제 줄에 쓴다', () => {
  // updateBlock_의 재조회 경로를 직접 검증한다: 인덱스가 낡아 코드가 안 맞으면
  // 그 줄을 건드리지 않고, 새로 읽은 위치에 쓴다.
  const h = run(SCRIPT);
  h.post({ secret: 'S3CRET', rows: [row(), row({ code: 'RAIM-BBB222', name: 'Ben' })] });
  const sandbox = h.sandbox;
  const sheet = h.sheet;
  const col = sandbox.resolveColumns_(sheet);
  // 낡은 인덱스를 일부러 만든다: BBB222가 3행이라고 알고 있지만 실제로는 2행(AAA 삭제).
  const stale = Object.assign(Object.create(null), { 'RAIM-BBB222': 3 });
  sheet.deleteRow(2); // RAIM-AAA111 삭제 → BBB222는 2행
  const result = { ok: true, appended: 0, updated: 0, deleted: 0, failed: [] };
  sandbox.updateBlock_(sheet, col, [{ code: 'RAIM-BBB222', values: sandbox.toValues_(row({ code: 'RAIM-BBB222', status: '승인', name: 'Ben' })) }], stale, result);
  assert.equal(result.updated, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(h.cell(2, '상태'), '승인', '새 위치(2행)에 쓰여야 한다');
});

// ── /refresh 계약: 분할 전송, 응답 검증, 전체 재전송 ─────────

test('GS37: 재전송 코드가 1000건을 넘으면 나눠 보낸다 (서버는 넘치면 통째로 거절)', () => {
  const h = run(SCRIPT);
  const codes = [];
  for (let i = 0; i < 1500; i++) codes.push(`RAIM-C${i}`);
  assert.equal(h.sandbox.requestRefresh_(codes), true);
  assert.equal(h.refreshed.length, 2, '1000 + 500으로 나눠야 한다');
  assert.equal(h.refreshed[0].body.codes.length, 1000);
  assert.equal(h.refreshed[1].body.codes.length, 500);
});

test('GS37b: HTTP 200이어도 본문이 ok:false면 실패로 처리한다', () => {
  const h = run(SCRIPT, { refreshReply: () => ({ ok: false, error: 'too_many_codes' }) });
  assert.equal(h.sandbox.requestRefresh_(['RAIM-X1']), false,
    '상태 코드만 믿으면 거절 응답을 성공으로 오인한다');
});

test('GS37c: APP_STATUS_URL 끝에 슬래시가 붙어도 refresh가 /status로 새지 않는다', () => {
  const h = run(SCRIPT, { statusUrl: 'https://raim.example/api/sheet/status/' });
  assert.equal(h.sandbox.requestRefresh_(['RAIM-X1']), true);
  assert.equal(h.refreshed.length, 1);
  assert.equal(h.refreshed[0].url, 'https://raim.example/api/sheet/refresh');
});

test('GS38: ④ 앱 기준으로 새로고침은 시트의 코드를 믿지 않고 전체 재전송을 요청한다', () => {
  // 이 메뉴를 쓰는 상황이 곧 "시트를 믿을 수 없는" 상황이다 — 코드 열이 망가졌거나
  // 행이 지워졌으면 시트에서 읽은 목록으로는 그 행들을 되살릴 수 없다.
  const h = seeded();
  h.sandbox.refreshFromApp();
  assert.equal(h.refreshed.length, 1);
  assert.equal(h.refreshed[0].body.all, true);
  assert.equal(h.refreshed[0].body.codes, undefined);
  assert.match(h.alerts.at(-1), /모든 예약을 다시 요청/);
});

test('GS38b: 붙여넣기가 신청코드 열까지 덮었으면 전체 재전송을 요청한다', () => {
  // 코드 열이 덮였으면 그 줄들에서 읽은 코드는 쓰레기다 — 그 목록으로 요청하면
  // 원래 있던 행은 영영 돌아오지 않는다.
  const h = run(SCRIPT);
  const rows = [];
  for (let i = 0; i < 25; i++) rows.push(row({ code: `RAIM-P${String(i).padStart(3, '0')}` }));
  h.post({ secret: 'S3CRET', rows });
  const keyCol = at('신청코드') + 1;
  h.sandbox.onSheetEdit({
    // 신청코드~상태 열을 포함한 25행 붙여넣기
    range: h.sheet.getRange(2, keyCol, 25, at('상태') + 1 - keyCol + 1),
    user: { getEmail: () => 'staff@seoulraim.com' },
  });
  assert.equal(h.fetched.length, 0, '상태 변경은 반영하지 않는다');
  assert.equal(h.refreshed.length, 1);
  assert.equal(h.refreshed[0].body.all, true, '시트에서 읽은 코드 목록을 쓰면 안 된다');
});

// ── 메일 결과 정직성 / 헤더 훼손 / 트리거 중복 ───────────────

test('GS39: 방문객 메일 발송 실패는 토스트로 드러난다 (상태는 되돌리지 않는다)', () => {
  const h = seeded({
    reply: (body) => ({ ok: true, results: body.changes.map(c => ({ code: c.code, ok: true, changed: true, label: c.status, mail: 'failed' })) }),
  });
  h.setCell(2, 'yeyak차단', true);
  h.editStatus(2, '승인');
  assert.equal(h.cell(2, '상태'), '승인', '상태 반영 자체는 성공 — 되돌리면 재시도로 메일이 두 번 갈 수 있다');
  assert.match(h.toasts.at(-1).msg, /메일 발송 실패/);
  assert.match(h.toasts.at(-1).msg, /RAIM-AAA111/, '어느 예약인지 알아야 후속 조치를 한다');
});

test('GS39b: SMTP 미설정(발송함 모드)이면 "발송됩니다"라고 거짓말하지 않는다', () => {
  const h = seeded({
    reply: (body) => ({ ok: true, results: body.changes.map(c => ({ code: c.code, ok: true, changed: true, label: c.status, mail: 'outbox' })) }),
  });
  h.setCell(2, 'yeyak차단', true);
  h.editStatus(2, '승인');
  assert.match(h.toasts.at(-1).msg, /발송함\(Outbox\)/);
  assert.doesNotMatch(h.toasts.at(-1).msg, /발송됩니다/);
});

test('GS39c: mail 필드가 없는(구버전 서버) 응답은 기존 안내를 유지한다', () => {
  const h = seeded();
  h.setCell(2, 'yeyak차단', true);
  h.editStatus(2, '승인');
  assert.match(h.toasts.at(-1).msg, /안내 메일이 발송됩니다/);
});

test('GS40: 상태 헤더 자체가 지워졌으면 데이터 행 편집에 경고한다', () => {
  // 헤더가 지워져도 데이터 행의 드롭다운은 살아 있다 — 직원이 계속 승인을 고르는데
  // 아무 일도 일어나지 않고(미러도 거부 중) 아무도 눈치채지 못하는 게 최악이다.
  const h = seeded();
  h.sheet.getRange(1, at('상태') + 1).setValue(''); // '상태' 헤더 파괴
  h.toasts.length = 0;
  h.editStatus(2, '승인');
  assert.equal(h.fetched.length, 0, '반영은 안 된다');
  assert.equal(h.toasts.length, 1, '조용히 물러나면 안 된다');
  assert.match(h.toasts[0].msg, /헤더 행이 원래 구성과 달라/);
});

test('GS41: 다른 계정이 이미 켠 자동 반영은 중복 설치하지 않는다', () => {
  // getProjectTriggers()는 실행한 사람의 트리거만 보여줘, 계정이 다르면 중복을
  // 못 잡는다 — 속성에 기록해 두 번 발화(처리자 이중 기록)를 막는다.
  const h = seeded();
  h.sandbox.installTriggers(); // owner@seoulraim.com이 설치
  assert.match(h.toasts.at(-1).msg, /자동 반영/);

  // 같은 계정은 재설치 가능
  h.sandbox.installTriggers();
  assert.match(h.toasts.at(-1).msg, /자동 반영/);

  // 다른 계정이 이미 설치해 둔 상태를 흉내낸다
  const h2 = seeded();
  h2.sandbox.PropertiesService.getScriptProperties().setProperty('RAIM_TRIGGER_OWNER', 'other@seoulraim.com');
  h2.toasts.length = 0;
  h2.sandbox.installTriggers();
  assert.equal(h2.toasts.length, 0, '설치했다는 토스트가 나가면 안 된다');
  assert.match(h2.alerts.at(-1), /이미 other@seoulraim\.com/);
});
