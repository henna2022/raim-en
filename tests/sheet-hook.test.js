'use strict';
// 시트 → 앱 방향(POST /api/sheet/status) 검증.
// 이 경로는 직원이 Google 시트의 상태 드롭다운을 바꿀 때 Apps Script가 부른다.
// 여기서 잘못되면 방문객에게 확정 메일이 잘못 나가거나 두 번 나간다 — 그래서
// 인증·전이 규칙·멱등성·감사 기록을 전부 고정한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, restartApp, withDb, newJar, makeReservation, uniqueEmail,
} = require('./helper');

const SECRET = 'inbound-test-secret-0123456789';

let ctx;

async function postJson(body) {
  const res = await fetch(ctx.baseUrl + '/api/sheet/status', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    redirect: 'manual',
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 본문이 JSON이 아니면 그대로 둔다 */ }
  return { res, json, text };
}

// 예약 하나를 새로 만든다. /reserve는 IP당 10분에 5건으로 제한되는데 그 카운터는
// 메모리에 있어 앱을 다시 띄우면 초기화된다 — 한 파일에서 12건을 만들려면 필요하다.
async function book() {
  await restartApp(ctx);
  return makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
}

const change = (code, status, over = {}) => ({
  secret: SECRET,
  changes: [{ code, status, actor: 'staff@seoulraim.com', ...over }],
});

function rowOf(code) {
  return withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT status, decided_by, decided_at, decline_reason, release_needed FROM reservations WHERE code = ?').get(code));
}
function emailsTo(addr) {
  return withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT subject FROM email_log WHERE to_addr = ? ORDER BY id').all(addr).map(r => r.subject));
}

test.before(async () => {
  delete process.env.SHEETS_INBOUND_SECRET;
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
});
test.after(async () => {
  await stopApp(ctx.server);
  delete process.env.SHEETS_INBOUND_SECRET;
});

test('SK1: 비밀값이 설정되지 않았으면 엔드포인트 자체가 꺼져 있다', async () => {
  const { res, json } = await postJson(change('RAIM-NOPE00', '승인'));
  assert.equal(res.status, 503);
  assert.equal(json.error, 'disabled');
});

test('SK2: 비밀값을 켜면 CSRF 토큰 없이도 통과한다 (구글이 부르는 경로)', async () => {
  process.env.SHEETS_INBOUND_SECRET = SECRET;
  await restartApp(ctx);
  const { res, json } = await postJson(change('RAIM-NOPE00', '승인'));
  // CSRF 미들웨어에 걸렸다면 403 HTML이 돌아온다 — 그게 아니라 우리 응답이어야 한다.
  assert.equal(res.status, 200);
  assert.equal(json.results[0].error, 'not_found');
});

test('SK3: 비밀값이 틀리면 401이고 예약은 그대로다', async () => {
  const r = await book();
  const { res, json } = await postJson({ ...change(r.code, '승인'), secret: 'wrong-secret' });
  assert.equal(res.status, 401);
  assert.equal(json.error, 'unauthorized');
  assert.equal(rowOf(r.code).status, 'pending', '인증 실패로는 상태가 바뀌면 안 된다');
});

test('SK4: 승인 -> confirmed, 확정 메일 발송, 처리자에 구글 계정 기록', async () => {
  const r = await book();
  const { json } = await postJson(change(r.code, '승인'));
  assert.equal(json.results[0].ok, true);
  assert.equal(json.results[0].changed, true);
  assert.equal(json.results[0].label, '승인', '시트에 되쓸 값은 앱이 보는 진짜 상태여야 한다');

  const row = rowOf(r.code);
  assert.equal(row.status, 'confirmed');
  assert.equal(row.decided_by, 'staff@seoulraim.com', '드롭다운을 바꾼 사람의 구글 계정이 남아야 한다');
  assert.ok(row.decided_at, '처리일시가 찍혀야 한다');
  assert.equal(row.release_needed, 0);

  const subjects = emailsTo(r.email);
  assert.equal(subjects.filter(s => /Reservation confirmed/.test(s)).length, 1);
});

test('SK5: 같은 값을 다시 보내도 확정 메일이 두 번 나가지 않는다 (멱등)', async () => {
  const r = await book();
  await postJson(change(r.code, '승인'));
  const { json } = await postJson(change(r.code, '승인'));
  assert.equal(json.results[0].ok, true);
  assert.equal(json.results[0].changed, false, '이미 그 상태면 아무 일도 하지 않는다');
  assert.equal(emailsTo(r.email).filter(s => /Reservation confirmed/.test(s)).length, 1);
});

test('SK6: 거절 -> declined, 거절사유가 함께 저장되고 안내 메일이 나간다', async () => {
  const r = await book();
  const { json } = await postJson(change(r.code, '거절', { reason: '해당 회차 잔여석 없음' }));
  assert.equal(json.results[0].ok, true);
  const row = rowOf(r.code);
  assert.equal(row.status, 'declined');
  assert.equal(row.decline_reason, '해당 회차 잔여석 없음');
  assert.ok(emailsTo(r.email).some(s => /About your request/.test(s)));
});

test('SK7: 거절된 건을 대기(검토중)로 되돌릴 수 있고, 그때는 메일이 나가지 않는다', async () => {
  const r = await book();
  await postJson(change(r.code, '거절', { reason: '착오' }));
  const before = emailsTo(r.email).length;
  const { json } = await postJson(change(r.code, '대기(검토중)'));
  assert.equal(json.results[0].ok, true);
  assert.equal(rowOf(r.code).status, 'pending');
  assert.equal(emailsTo(r.email).length, before, '되돌리기는 방문객에게 알릴 것이 없다');
});

test('SK8: 취소된 예약은 시트에서 승인할 수 없고, 진짜 상태를 돌려준다', async () => {
  const r = await book();
  withDb(ctx.dataDir, (db) => db.prepare(`UPDATE reservations SET status='cancelled' WHERE code=?`).run(r.code));
  const { json } = await postJson(change(r.code, '승인'));
  assert.equal(json.results[0].ok, false);
  assert.equal(json.results[0].error, 'invalid_transition');
  assert.equal(json.results[0].label, '취소', '시트가 이 값으로 셀을 되돌린다');
  assert.equal(rowOf(r.code).status, 'cancelled');
  assert.ok(!emailsTo(r.email).some(s => /Reservation confirmed/.test(s)));
});

test('SK9: 드롭다운 밖의 값은 unknown_status로 거부한다', async () => {
  const r = await book();
  const { json } = await postJson(change(r.code, '방문완료'));
  assert.equal(json.results[0].ok, false);
  assert.equal(json.results[0].error, 'unknown_status');
  assert.equal(json.results[0].label, '대기(검토중)');
  assert.equal(rowOf(r.code).status, 'pending');
});

test('SK10: 한 번에 여러 줄을 보내면 건별로 결과가 돌아온다', async () => {
  const a = await book();
  const b = await book();
  const { json } = await postJson({
    secret: SECRET,
    changes: [
      { code: a.code, status: '승인', actor: 'a@seoulraim.com' },
      { code: 'RAIM-GHOST9', status: '승인', actor: 'a@seoulraim.com' },
      { code: b.code, status: '거절', actor: 'a@seoulraim.com', reason: '만석' },
    ],
  });
  assert.equal(json.results.length, 3);
  assert.equal(json.results[0].ok, true);
  assert.equal(json.results[1].error, 'not_found', '한 건이 실패해도 나머지는 처리된다');
  assert.equal(json.results[2].ok, true);
  assert.equal(rowOf(a.code).status, 'confirmed');
  assert.equal(rowOf(b.code).status, 'declined');
});

test('SK11: 빈 요청은 400', async () => {
  const { res, json } = await postJson({ secret: SECRET, changes: [] });
  assert.equal(res.status, 400);
  assert.equal(json.error, 'no_changes');
});

test('SK12: 승인된 예약은 웹사이트에서 예약번호만으로 확정 상태가 보인다', async () => {
  const r = await book();
  await postJson(change(r.code, '승인'));
  const page = await (await fetch(`${ctx.baseUrl}/booking?code=${encodeURIComponent(r.code)}`)).text();
  assert.match(page, /Confirmed/);
  assert.match(page, new RegExp(r.code));
  // 가린 보기 — 이메일은 어디에도 나가면 안 된다
  assert.doesNotMatch(page, new RegExp(r.email.replace(/[.+]/g, '\\$&')));
  assert.doesNotMatch(page, /Test Visitor/, '이름은 첫 글자만 남아야 한다');
});

test('SK13: 자바스크립트 내장 속성 이름을 상태로 보내도 죽지 않고 진짜 상태를 돌려준다', async () => {
  // 'constructor' 같은 이름은 평범한 객체 리터럴에서 Object.prototype의 값을 물고
  // 올라와 "유효한 액션"처럼 보인다. 그 상태로 진행하면 서버가 던지고, 시트는
  // label 없는 실패 응답을 받아 상태 칸을 비워 버린다.
  const r = await book();
  for (const evil of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    const { res, json } = await postJson(change(r.code, evil));
    assert.equal(res.status, 200, `${evil}: 서버가 살아 있어야 한다`);
    assert.equal(json.results[0].ok, false);
    assert.equal(json.results[0].error, 'unknown_status', `${evil}: 모르는 값으로 처리`);
    assert.equal(json.results[0].label, '대기(검토중)', `${evil}: 시트가 되돌릴 값이 실려야 한다`);
  }
  assert.equal(rowOf(r.code).status, 'pending');
});

test('SK14: /admin의 액션 이름으로도 프로세스가 죽지 않는다', async () => {
  // TRANSITIONS를 시트와 공유하면서 같은 함정이 관리자 경로에도 생겼다.
  // async 핸들러 안에서 던지면 Express 4가 못 잡아 프로세스가 통째로 내려간다.
  const r = await book();
  const id = withDb(ctx.dataDir, (db) => db.prepare('SELECT id FROM reservations WHERE code=?').get(r.code).id);
  const { adminLogin, postAdminForm, get } = require('./helper');
  await adminLogin(ctx.baseUrl, ctx.jar);
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id}/constructor`, {});
  assert.equal(res.status, 400, '알 수 없는 액션은 400이어야 한다');
  const alive = await get(ctx.baseUrl, ctx.jar, '/');
  assert.equal(alive.status, 200, '서버가 살아 있어야 한다');
});

test('SK15: /refresh는 상태를 바꾸지 않고 시트 재전송 대기열에만 넣는다', async () => {
  const r = await book();
  const before = withDb(ctx.dataDir, (db) => db.prepare('SELECT sheet_synced FROM reservations WHERE code=?').get(r.code));
  withDb(ctx.dataDir, (db) => db.prepare('UPDATE reservations SET sheet_synced=1 WHERE code=?').run(r.code));

  const res = await fetch(ctx.baseUrl + '/api/sheet/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, codes: [r.code, 'RAIM-GHOST9'] }),
  });
  const json = await res.json();
  assert.equal(json.marked, 1, '있는 코드만 센다');
  assert.equal(rowOf(r.code).status, 'pending', '상태는 건드리지 않는다');
  assert.equal(
    withDb(ctx.dataDir, (db) => db.prepare('SELECT sheet_synced FROM reservations WHERE code=?').get(r.code)).sheet_synced,
    0, '미러가 이 행을 다시 보내게 된다');
  assert.ok(before);
});

test('SK16: /refresh도 비밀값이 필요하다', async () => {
  const res = await fetch(ctx.baseUrl + '/api/sheet/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: 'wrong', codes: ['RAIM-AAA111'] }),
  });
  assert.equal(res.status, 401);
});

async function postRefresh(body) {
  const res = await fetch(ctx.baseUrl + '/api/sheet/refresh', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: SECRET, ...body }),
  });
  return { res, json: await res.json() };
}
const syncedOf = (code) => withDb(ctx.dataDir, (db) =>
  db.prepare('SELECT sheet_synced FROM reservations WHERE code = ?').get(code).sheet_synced);

test('SK17: /refresh all:true는 모든 행을 재전송 대기열에 넣는다', async () => {
  // 미러는 sheet_synced=0인 행만 다시 보낸다 — all:true가 하나라도 빠뜨리면
  // 그 행은 복구 수단이 없다. "전부"가 정말 전부인지 개수로 확인한다.
  const r = await book();
  withDb(ctx.dataDir, (db) => db.prepare('UPDATE reservations SET sheet_synced=1').run());
  const total = withDb(ctx.dataDir, (db) => db.prepare('SELECT COUNT(*) AS n FROM reservations').get().n);
  assert.ok(total > 1, '이 파일의 앞선 테스트들 덕에 행이 여럿이어야 의미가 있다');

  const { res, json } = await postRefresh({ all: true });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.marked, total, '모든 행이 표시돼야 한다');
  const stale = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE sheet_synced != 0').get().n);
  assert.equal(stale, 0);
  assert.equal(rowOf(r.code).status, 'pending', '상태는 건드리지 않는다');
});

test('SK18: /refresh에 한도 초과 코드 목록은 400 — 조용히 잘라내지 않는다', async () => {
  // 예전에는 1000개 넘게 보내면 잘라내고 ok:true를 돌려줬다 — 시트 쪽 복구 도구는
  // 전체가 다시 동기화됐다고 믿고, 잘린 행은 영영 낡은 채 남는다.
  const r = await book();
  withDb(ctx.dataDir, (db) => db.prepare('UPDATE reservations SET sheet_synced=1 WHERE code=?').run(r.code));
  const codes = Array.from({ length: 1000 }, (_, i) => `RAIM-X${String(i).padStart(5, '0')}`);
  codes.push(r.code); // 1001번째 — 잘라냈다면 이 코드가 버려졌을 자리

  const { res, json } = await postRefresh({ codes });
  assert.equal(res.status, 400);
  assert.equal(json.ok, false);
  assert.equal(json.error, 'too_many_codes');
  assert.equal(syncedOf(r.code), 1, '거절이면 부분 처리도 없어야 한다');
});

test('SK19: /refresh 코드 1000개까지는 기존대로 처리된다', async () => {
  const r = await book();
  withDb(ctx.dataDir, (db) => db.prepare('UPDATE reservations SET sheet_synced=1 WHERE code=?').run(r.code));
  const codes = Array.from({ length: 999 }, (_, i) => `RAIM-Y${String(i).padStart(5, '0')}`);
  codes.push(r.code); // 정확히 1000개

  const { res, json } = await postRefresh({ codes });
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(json.marked, 1, '있는 코드만 센다');
  assert.equal(syncedOf(r.code), 0);
});

test('SK20: SMTP 미설정(아웃박스 모드)이면 성공 응답에 mail:"outbox"가 실린다', async () => {
  // 아웃박스 모드에서는 모든 메일이 sent=0으로 보관되는 게 설계다 — 'failed'로
  // 보이면 직원이 멀쩡한 상태를 장애로 오인한다.
  const r = await book();
  const { json } = await postJson(change(r.code, '승인'));
  assert.equal(json.results[0].ok, true);
  assert.equal(json.results[0].changed, true);
  assert.equal(json.results[0].mail, 'outbox');
  const logged = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT sent FROM email_log WHERE to_addr=? ORDER BY id DESC').get(r.email));
  assert.equal(logged.sent, 0, '아웃박스 모드: 메일은 미발송으로 보관된다');

  // 방문객 메일이 애초에 없는 전이(reopen)에는 mail을 싣지 않는다.
  const r2 = await book();
  await postJson(change(r2.code, '거절', { reason: '착오' }));
  const { json: back } = await postJson(change(r2.code, '대기(검토중)'));
  assert.equal(back.results[0].ok, true);
  assert.equal(back.results[0].changed, true);
  assert.ok(!('mail' in back.results[0]), '보낼 메일이 없었는데 결과가 실리면 안 된다');
});

test('SK21: SMTP 발송 실패는 mail:"failed"로 드러난다', async () => {
  // 진짜 SMTP 서버 대신 아무도 듣지 않는 로컬 포트를 준다 — 접속 거부로 즉시
  // 실패하므로 "설정은 됐는데 발송이 안 되는" 장애를 결정적으로 재현한다.
  process.env.SMTP_HOST = '127.0.0.1';
  process.env.SMTP_PORT = '1';
  try {
    const r = await book(); // book()이 앱을 다시 띄우며 위 환경변수를 읽는다
    const { json } = await postJson(change(r.code, '승인'));
    assert.equal(json.results[0].ok, true, '상태 전이 자체는 성공이다');
    assert.equal(json.results[0].changed, true);
    assert.equal(json.results[0].mail, 'failed', '메일이 안 나갔다는 사실이 시트까지 가야 한다');
    assert.equal(rowOf(r.code).status, 'confirmed');
    const logged = withDb(ctx.dataDir, (db) =>
      db.prepare('SELECT sent, error FROM email_log WHERE to_addr=? ORDER BY id DESC').get(r.email));
    assert.equal(logged.sent, 0);
    assert.ok(logged.error, '실패 원인이 email_log에 남아야 한다');
  } finally {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    await restartApp(ctx); // 다음 테스트가 아웃박스 모드로 돌아가게 한다
  }
});

test('SK22: 읽은 뒤 상태가 바뀌면 덮어쓰지 않고 raced로 물러난다', async () => {
  // src/decisions.js의 guarded UPDATE(WHERE에 관측한 status) 검증. 라우트의 읽기와
  // UPDATE 사이는 동기 구간이라 테스트가 끼어들 수 없으므로, 그 UPDATE 문이 준비되는
  // 순간(읽은 직후, 실행 직전)에 방문객 취소를 흉내 내 상태를 바꿔 넣는다.
  const r = await book();
  const appDb = require('../src/db').db; // 앱이 쓰는 바로 그 연결
  const origPrepare = appDb.prepare.bind(appDb);
  let fired = false;
  appDb.prepare = function (sql) {
    if (!fired && /UPDATE reservations SET status=/.test(sql)) {
      fired = true;
      origPrepare(`UPDATE reservations SET status='cancelled' WHERE code=?`).run(r.code);
    }
    return origPrepare(sql);
  };
  try {
    const before = emailsTo(r.email).length;
    const { res, json } = await postJson(change(r.code, '승인'));
    assert.equal(res.status, 200);
    assert.equal(fired, true, '경합 주입이 실제로 일어났어야 한다');
    assert.equal(json.results[0].ok, false);
    assert.equal(json.results[0].error, 'raced');
    assert.equal(json.results[0].label, '취소', '시트에는 진짜 현재 상태가 실려야 한다');
    assert.equal(rowOf(r.code).status, 'cancelled', '경합에서 진 결정이 덮어쓰면 안 된다');
    assert.equal(emailsTo(r.email).length, before, '적용되지 않은 결정의 메일이 나가면 안 된다');
  } finally {
    delete appDb.prepare; // 자기 속성만 지워 원래 프로토타입 메서드로 되돌린다
  }
});

test('SK23: DB 오류 때 label 계산이 또 던져도 프로세스가 죽지 않는다', async () => {
  // catch 블록 안의 labelOf가 같은 DB 오류로 다시 던지면 async 핸들러의 거부를
  // Express 4가 못 받아 프로세스가 통째로 내려간다 — 그 회귀를 고정한다.
  const r = await book();
  const appDb = require('../src/db').db;
  const origPrepare = appDb.prepare.bind(appDb);
  appDb.prepare = function (sql) {
    // 예약 조회(JOIN slots)만 죽인다 — applyOne의 첫 읽기와 catch의 labelOf 둘 다.
    if (/JOIN slots/.test(sql)) throw new Error('db exploded (test)');
    return origPrepare(sql);
  };
  try {
    const { res, json } = await postJson(change(r.code, '승인'));
    assert.equal(res.status, 200, '오류여도 응답은 돌아와야 한다');
    assert.equal(json.results[0].ok, false);
    assert.equal(json.results[0].error, 'server_error');
    assert.ok(!('label' in json.results[0]), 'label 계산도 실패했으면 빼고 보낸다');
  } finally {
    delete appDb.prepare;
  }
  const alive = await fetch(ctx.baseUrl + '/');
  assert.equal(alive.status, 200, '서버가 살아 있어야 한다');
  assert.equal(rowOf(r.code).status, 'pending', '오류 경로에서 상태가 바뀌면 안 된다');
});
