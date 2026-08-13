'use strict';
// Google 시트 미러: 성공 반영, 실패 시 예약이 막히지 않는지, 재시도 큐, 보안(비밀키).
// 실제 Apps Script 대신 로컬 목 웹앱을 띄워서 검증한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {
  makeDataDir, startApp, stopApp, restartApp, withDb, newJar,
  makeReservation, adminLogin, uniqueEmail, postAdminForm,
} = require('./helper');

let ctx;
let mock;      // 목 웹앱 상태
let sheets;    // 앱과 같은 모듈 인스턴스

// Apps Script 웹앱을 실제 동작 그대로 흉내내는 목.
// 핵심: 진짜 Apps Script는 /exec 로 온 POST에서 doPost를 실행한 뒤 302로
// script.googleusercontent.com 을 가리키고, 클라이언트는 그쪽을 GET 해서 결과를
// 받는다. fetch는 302에서 POST를 GET으로 바꾸므로, 이 왕복을 재현하지 않으면
// 실제 배포에서만 터지는 문제를 테스트가 놓친다.
function startMockWebhook() {
  const state = { requests: [], mode: 'ok', secret: 'test-sheet-secret', results: new Map(), seq: 0 };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    if (url.pathname === '/echo') { // 리다이렉트 후 결과 수령 (GET)
      const stored = state.results.get(url.searchParams.get('k'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(stored || { ok: false, error: 'expired' }));
    }

    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch { /* ignore */ }
      state.requests.push(parsed);

      if (state.mode === 'http500') { res.writeHead(500); return res.end('boom'); }
      if (state.mode === 'hang') return; // 응답하지 않음 → 클라이언트 타임아웃

      let result;
      if (!parsed || parsed.secret !== state.secret) result = { ok: false, error: 'unauthorized' };
      else if (state.mode === 'reject') result = { ok: false, error: 'simulated rejection' };
      else if (state.mode === 'doget') result = { ok: true, service: 'raim-en sheet mirror' }; // 쓰기 건수 없음
      else result = { ok: true, appended: (parsed.rows || []).length, updated: 0 };

      // doPost는 이미 실행됐고, 결과는 리다이렉트 대상에서 GET으로 가져간다.
      const key = String(++state.seq);
      state.results.set(key, result);
      res.writeHead(302, { Location: `/echo?k=${key}` });
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      state.server = server;
      state.url = `http://127.0.0.1:${server.address().port}/exec`;
      resolve(state);
    });
  });
}

function rowsSentFor(code) {
  return mock.requests.flatMap(r => (r && r.rows) || []).filter(row => row.code === code);
}
// 요청 경로는 nudge()로 비동기 전송하므로, 테스트는 동기화가 끝나기를 기다린다.
// syncPending()은 in-flight 요청이 있으면 그것을 반환하므로 중복 전송이 없다.
// 공개 폼 rate limit이 10분당 5건이라 4건마다 앱을 재시작해 카운터를 리셋한다
// (in-memory 리미터라 재시작이 곧 리셋 — 테스트 개수가 늘어도 안전하다).
let bookedSinceRestart = 0;
async function book(overrides) {
  if (bookedSinceRestart >= 4) {
    await restartApp(ctx);
    sheets = require('../src/sheets'); // 모듈 캐시가 비워졌으므로 새 인스턴스를 잡는다
    bookedSinceRestart = 0;
  }
  bookedSinceRestart += 1;
  const r = await makeReservation(ctx.baseUrl, ctx.jar, overrides);
  await sheets.syncPending();
  return r;
}

function syncFlag(code) {
  return withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT sheet_synced FROM reservations WHERE code = ?').get(code).sheet_synced);
}

test.before(async () => {
  mock = await startMockWebhook();
  process.env.SHEETS_WEBHOOK_URL = mock.url;
  process.env.SHEETS_WEBHOOK_SECRET = mock.secret;
  process.env.SHEETS_TIMEOUT_MS = '1500';
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  assert.equal((await adminLogin(ctx.baseUrl, ctx.jar, {})).status, 302);
  sheets = require('../src/sheets'); // startApp 이후에 require — 같은 DB 핸들을 쓰기 위해
});
test.after(async () => {
  await stopApp(ctx.server);
  await new Promise((r) => mock.server.close(r));
  delete process.env.SHEETS_WEBHOOK_URL;
  delete process.env.SHEETS_WEBHOOK_SECRET;
  delete process.env.SHEETS_TIMEOUT_MS;
});

test('SH1: 신청이 접수되면 시트에 한 줄이 올라가고 동기화 표시가 남는다', async () => {
  mock.mode = 'ok';
  const r = await book({ email: uniqueEmail() });
  const sent = rowsSentFor(r.code);
  assert.equal(sent.length, 1, '신청 1건당 1행');
  assert.equal(sent[0].status, '대기(검토중)');
  assert.equal(sent[0].visit_date, r.date);
  assert.match(sent[0].tour_type, /^(상설|기획)$/, '전시 구분은 별도 열');
  assert.match(sent[0].session, /^\d+회차$/, '회차는 번호만');
  assert.match(sent[0].time, /^\d{2}:\d{2}~\d{2}:\d{2}$/, '시간도 별도 열');
  assert.equal(syncFlag(r.code), 1);
  // 비밀키가 실려 나가야 Apps Script가 통과시킨다
  assert.equal(mock.requests.at(-1).secret, mock.secret);
});

test('SH1b: Apps Script의 302 리다이렉트를 거쳐도 본문이 유실되지 않는다', async () => {
  // 목이 실제 Apps Script처럼 302로 응답하므로, 앞선 테스트가 통과했다는 것 자체가
  // POST 본문이 /exec 에 도달했다는 증거다. 여기서는 그 사실을 명시적으로 고정한다.
  mock.mode = 'ok';
  const before = mock.requests.length;
  withDb(ctx.dataDir, (db) => db.prepare('UPDATE reservations SET sheet_synced = 0').run());
  const out = await sheets.syncPending();
  assert.ok(out.synced >= 1, '302를 따라가고도 쓰기 건수를 확인해 성공 처리해야 한다');
  assert.ok(mock.requests.length > before);
  assert.ok(mock.requests.at(-1).rows, 'POST 본문(rows)이 서버에 도달해야 한다');
});

test('SH1c: doGet 같은 응답(쓰기 건수 없음)은 성공으로 취급하지 않는다', async () => {
  mock.mode = 'doget';   // {ok:true} 지만 appended/updated 가 없다
  const r = await book({ email: uniqueEmail() });
  const out = await sheets.syncPending();
  assert.equal(out.synced, 0, '쓰기 건수가 없으면 동기화로 인정하면 안 된다');
  assert.equal(syncFlag(r.code), 0);
  mock.mode = 'ok';
  await sheets.syncPending();
  assert.equal(syncFlag(r.code), 1);
});

test('SH2: 확정 처리하면 같은 코드로 상태가 갱신되어 다시 전송된다', async () => {
  mock.mode = 'ok';
  const r = await book({ email: uniqueEmail() });
  const id = withDb(ctx.dataDir, (db) => db.prepare('SELECT id FROM reservations WHERE code = ?').get(r.code).id);
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/confirm`, { yeyak_blocked: 'on' });
  assert.equal(res.status, 302);
  await sheets.syncPending();
  const sent = rowsSentFor(r.code);
  assert.equal(sent.length, 2, '접수 1회 + 확정 1회');
  assert.equal(sent[1].status, '확정');
  assert.equal(sent[1].decided_by, 'admin');
});

test('SH3: 시트가 죽어도 예약은 정상 접수되고, 실패 행은 재시도 큐에 남는다', async () => {
  mock.mode = 'http500';
  const r = await book({ email: uniqueEmail() });
  assert.ok(r.code, '시트 장애와 무관하게 예약 코드가 발급되어야 한다');
  assert.equal(syncFlag(r.code), 0, '실패한 행은 미동기화로 남는다');
  assert.ok(sheets.pendingCount() >= 1);

  mock.mode = 'ok';
  const out = await sheets.syncPending();
  assert.ok(out.synced >= 1, '복구되면 재전송된다');
  assert.equal(syncFlag(r.code), 1);
});

test('SH4: 웹훅이 응답하지 않아도 요청이 타임아웃으로 끊기고 예약은 살아남는다', async () => {
  mock.mode = 'hang';
  const started = Date.now();
  const r = await book({ email: uniqueEmail() });
  const elapsed = Date.now() - started;
  assert.ok(r.code, '무응답 웹훅이 예약을 막으면 안 된다');
  assert.ok(elapsed < 10000, `타임아웃이 걸려야 한다 (실제 ${elapsed}ms)`);
  assert.equal(syncFlag(r.code), 0);
  mock.mode = 'ok';
  await sheets.syncPending();
});

test('SH5: 웹훅이 200이지만 ok:false로 거부하면 성공으로 취급하지 않는다', async () => {
  mock.mode = 'reject';
  const r = await book({ email: uniqueEmail() });
  assert.equal(syncFlag(r.code), 0, 'HTTP 200이어도 본문의 ok를 확인해야 한다');
  mock.mode = 'ok';
  await sheets.syncPending();
  assert.equal(syncFlag(r.code), 1);
});

test('SH6: 요청사항 자유입력은 시트로 나가지 않는다 (민감정보 차단)', async () => {
  mock.mode = 'ok';
  const email = uniqueEmail();
  const r = await book({ email, name: 'Formula Test', notes: '=HYPERLINK("http://evil","x")' });
  const sent = rowsSentFor(r.code)[0];
  assert.equal(sent.name, 'Formula Test');
  assert.equal(sent.email, email, '이메일은 시트에 포함된다(직원 연락용)');
  // 자유입력·언어는 여전히 전송하지 않는다.
  assert.equal(sent.notes, undefined, '요청사항은 페이로드에 없어야 한다');
  assert.equal(sent.language, undefined, '언어도 더 이상 보내지 않는다');
  assert.ok(!JSON.stringify(sent).includes('HYPERLINK'), '자유입력 내용이 어떤 필드로도 새면 안 된다');
});

test('SH8: 보존기한이 지나 파기되면 시트에서도 삭제된다', async () => {
  mock.mode = 'ok';
  const r = await book({ email: uniqueEmail() });
  assert.equal(syncFlag(r.code), 1);
  // 방문일을 보존기한 밖으로 밀어넣고 파기 배치를 돌린다.
  withDb(ctx.dataDir, (db) =>
    db.prepare("UPDATE reservations SET visit_date = '2020-01-01' WHERE code = ?").run(r.code));
  require('../src/maintenance').purgeOldData();
  assert.equal(sheets.deletesPending(), 1, '파기된 코드가 시트 삭제 큐에 들어가야 한다');

  const out = await sheets.flushDeletes();
  assert.equal(out.deleted, 1);
  assert.equal(sheets.deletesPending(), 0);
  const del = mock.requests.filter(q => q && q.deleteCodes);
  assert.ok(del.at(-1).deleteCodes.includes(r.code), '삭제 요청에 해당 코드가 실려야 한다');
});

test('SH9: 시트 삭제가 실패하면 큐에 남아 다음 주기에 재시도된다', async () => {
  mock.mode = 'ok';
  const r = await book({ email: uniqueEmail() });
  withDb(ctx.dataDir, (db) =>
    db.prepare("UPDATE reservations SET visit_date = '2020-01-01' WHERE code = ?").run(r.code));
  require('../src/maintenance').purgeOldData();

  mock.mode = 'http500';
  assert.equal((await sheets.flushDeletes()).deleted, 0);
  assert.equal(sheets.deletesPending(), 1, '실패하면 큐에 남아야 개인정보가 시트에 방치되지 않는다');

  mock.mode = 'ok';
  assert.equal((await sheets.flushDeletes()).deleted, 1);
  assert.equal(sheets.deletesPending(), 0);
});

test('SH7: 설정이 없으면 기능이 꺼지고 예약 흐름에 전혀 관여하지 않는다', async () => {
  // 별도 앱 인스턴스를 환경변수 없이 띄운다.
  const savedUrl = process.env.SHEETS_WEBHOOK_URL;
  delete process.env.SHEETS_WEBHOOK_URL;
  const off = await startApp(makeDataDir());
  try {
    const offJar = newJar();
    const before = mock.requests.length;
    const r = await makeReservation(off.baseUrl, offJar, { email: uniqueEmail() });
    assert.ok(r.code, '시트 없이도 예약은 된다');
    assert.equal(mock.requests.length, before, '꺼져 있으면 웹훅을 호출하지 않는다');
    const offSheets = require('../src/sheets');
    assert.equal(offSheets.enabled, false);
    assert.deepEqual(await offSheets.syncPending(), { skipped: 'disabled', synced: 0, pending: 0 });
  } finally {
    await stopApp(off.server);
    process.env.SHEETS_WEBHOOK_URL = savedUrl;
  }
});
