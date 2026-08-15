'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, withDb, newJar,
  get, postForm, postFormNoCsrf, makeReservation, uniqueEmail,
} = require('./helper');

let ctx;
let resA; // reservation used across B1-B4

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  resA = await makeReservation(ctx.baseUrl, ctx.jar, {});
});
test.after(async () => {
  await stopApp(ctx.server);
});

// 이메일이 든 조회는 POST 본문으로 다닌다 — GET 쿼리스트링에 실리면 nginx 접근
// 로그와 브라우저 방문 기록에 남는다(PIPA). B1·B2가 실제 UI가 쓰는 POST 경로다.

test('B1: POST code+email lookup -> 200, full view with status banner and cancel form', async () => {
  const res = await postForm(ctx.baseUrl, ctx.jar, '/booking', { code: resA.code, email: resA.email });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /status-banner/);
  assert.match(body, /Pending review/);
  assert.match(body, new RegExp(resA.code));
  assert.match(body, /Cancel this reservation/);
});

test('B2: POST correct code, wrong email -> "No booking found", no masked fallback', async () => {
  // 가린 보기로도 흘리지 않는다 — 이메일을 대입해 가며 맞는 주소를 찾아내는
  // 확인 공격을 막기 위해서다 (GET 쪽 규칙은 B8이 지킨다).
  const res = await postForm(ctx.baseUrl, ctx.jar, '/booking', {
    code: resA.code, email: 'someone-else@example.com',
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /No booking found/);
  // The code is legitimately echoed back into the search form's own input
  // value (it's what the visitor just typed) — what must NOT leak is the
  // matched reservation's details (name, visit date/time, party size etc.).
  assert.doesNotMatch(body, /Test Visitor/);
  assert.doesNotMatch(body, /class="kv"/);
  assert.doesNotMatch(body, new RegExp(resA.date));
});

test('B2b: POST /booking without a CSRF token -> 403, no reservation details rendered', async () => {
  const res = await postFormNoCsrf(ctx.baseUrl, ctx.jar, '/booking', {
    code: resA.code, email: resA.email,
  });
  assert.equal(res.status, 403);
  const body = await res.text();
  assert.match(body, /expired/);
  assert.doesNotMatch(body, /class="kv"/);
});

test('B2c: legacy GET with code+email still resolves the full view (bookmarked URLs)', async () => {
  // UI는 더 이상 이런 URL을 만들지 않지만, 예전 북마크가 여기까지 왔다면 로그에는
  // 이미 남은 뒤다 — 계속 받아 줘도 새로 새는 것은 없다 (src/routes/public.js).
  const res = await get(ctx.baseUrl, ctx.jar,
    `/booking?code=${encodeURIComponent(resA.code)}&email=${encodeURIComponent(resA.email)}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /class="kv"/);
  assert.match(body, /Test Visitor/);
});

test('B3: cancel a pending reservation -> 302 to code-only URL with cancelled=1, status cancelled, cancel email logged', async () => {
  const res = await postForm(ctx.baseUrl, ctx.jar, '/booking/cancel', {
    code: resA.code, email: resA.email,
  });
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  // 리다이렉트 URL에 이메일이 실리면 접근 로그·방문 기록에 남는다 — 코드만 싣는다.
  assert.equal(location, `/booking?code=${encodeURIComponent(resA.code)}&cancelled=1`);
  assert.doesNotMatch(location, /email=/);

  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT status FROM reservations WHERE code = ?').get(resA.code);
    assert.equal(row.status, 'cancelled');
    const emails = db.prepare(
      `SELECT COUNT(*) AS c FROM email_log WHERE to_addr = ? AND subject LIKE '%cancelled%'`
    ).get(resA.email).c;
    assert.equal(emails, 1);
  });

  // 리다이렉트가 닿는 곳은 가린 보기다 — 배너와 상태 줄로 취소가 확인되고,
  // 이름은 가려지고 이메일은 나가지 않아야 한다.
  const landing = await (await get(ctx.baseUrl, ctx.jar, location)).text();
  assert.match(landing, /Your reservation has been cancelled/);
  assert.match(landing, /Status: Cancelled/);
  assert.doesNotMatch(landing, /Test Visitor/);
  assert.doesNotMatch(landing, new RegExp(resA.email.replace(/[.+]/g, '\\$&')));
});

test('B4: cancel an already-cancelled reservation -> 302 WITHOUT cancelled=1, status stays cancelled', async () => {
  const res = await postForm(ctx.baseUrl, ctx.jar, '/booking/cancel', {
    code: resA.code, email: resA.email,
  });
  assert.equal(res.status, 302);
  // 아무것도 취소되지 않았는데 "취소됨" 배너를 띄우면 거짓 확인이 된다.
  const location = res.headers.get('location');
  assert.equal(location, `/booking?code=${encodeURIComponent(resA.code)}`);
  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT status FROM reservations WHERE code = ?').get(resA.code);
    assert.equal(row.status, 'cancelled');
  });
});

test('B5: cancel attempt with wrong email -> no status change, redirect WITHOUT cancelled=1 or email', async () => {
  const resB = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  const res = await postForm(ctx.baseUrl, ctx.jar, '/booking/cancel', {
    code: resB.code, email: 'wrong-email@example.com',
  });
  assert.equal(res.status, 302); // route always redirects, regardless of match
  assert.equal(res.headers.get('location'), `/booking?code=${encodeURIComponent(resB.code)}`);
  withDb(ctx.dataDir, (db) => {
    const row = db.prepare('SELECT status FROM reservations WHERE code = ?').get(resB.code);
    assert.equal(row.status, 'pending');
  });
});

// ── 예약번호만으로 조회 (가린 보기) ────────────────────────
// 번호만 넣어도 상태가 보여야 하되, 번호를 주운 사람이 신청자를 특정하거나
// 연락처를 얻을 수는 없어야 한다.

test('B6: 예약번호만 넣어도 상태가 보이고, 이름은 전체 첫 글자 하나만 남고 이메일은 나가지 않는다', async () => {
  const r = await makeReservation(ctx.baseUrl, ctx.jar, { name: 'Aiko Tanaka', email: uniqueEmail() });
  const res = await get(ctx.baseUrl, ctx.jar, `/booking?code=${encodeURIComponent(r.code)}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Pending review/);
  assert.match(body, new RegExp(r.code));
  assert.match(body, /A•••/, '이름 전체에서 첫 글자 하나 + ••• 한 덩어리, 점 개수는 고정');
  assert.doesNotMatch(body, /T•••/, '낱말별로 가리면 낱말 수와 각 낱말의 첫 글자가 드러난다');
  assert.doesNotMatch(body, /Aiko|Tanaka/);
  assert.doesNotMatch(body, new RegExp(r.email.replace(/[.+]/g, '\\$&')));
});

test('B7: 가린 보기에서는 취소 버튼이 나오지 않는다 (취소는 이메일 확인 후에만)', async () => {
  const r = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  const masked = await (await get(ctx.baseUrl, ctx.jar, `/booking?code=${encodeURIComponent(r.code)}`)).text();
  assert.doesNotMatch(masked, /Cancel this reservation/);
  assert.match(masked, /Enter the email address/);

  const full = await (await postForm(ctx.baseUrl, ctx.jar, '/booking', {
    code: r.code, email: r.email,
  })).text();
  assert.match(full, /Cancel this reservation/);
});

test('B8: 번호는 맞고 이메일이 틀리면 가린 보기로도 흘리지 않는다', async () => {
  // 이렇게 흘리면 이메일을 대입해 가며 맞는 주소를 찾아내는 확인 공격이 성립한다.
  const r = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  const body = await (await get(ctx.baseUrl, ctx.jar,
    `/booking?code=${encodeURIComponent(r.code)}&email=someone-else%40example.com`)).text();
  assert.match(body, /No booking found/);
  assert.doesNotMatch(body, /class="kv"/);
});

test('B9: 존재하지 않는 번호는 조회되지 않는다', async () => {
  const body = await (await get(ctx.baseUrl, ctx.jar, '/booking?code=RAIM-ZZZZZZ')).text();
  assert.match(body, /No booking found with that reservation code/);
  assert.doesNotMatch(body, /class="kv"/);
});

test('B10: 이름 가리기 — 전체 첫 글자 한 덩어리, 서로게이트 쌍도 깨지지 않는다', async () => {
  // '𠮷'는 UTF-16 두 칸을 차지한다. name[0]으로 자르면 반쪽만 남아 브라우저에
  // �로 뜨고, 본인이 알아보라고 남긴 글자가 의미를 잃는다.
  const { maskName } = require('../src/helpers');
  assert.equal(maskName('𠮷田'), '𠮷•••');
  assert.equal(maskName('Aiko Tanaka'), 'A•••');
  // 띄어 쓴 한글·한자 이름 — 낱말별로 가리면 낱말 수와 첫 글자들로 이름 전체가
  // 그대로 드러난다 ('이 수 민' → '이 수 민').
  assert.equal(maskName('이 수 민'), '이•••');
  assert.equal(maskName('이수민'), '이•••');
  assert.equal(maskName('李 明'), '李•••');
  // 한 글자 낱말도 가린다 — 예전처럼 그대로 내보내면 그게 이름 전부다.
  assert.equal(maskName('A'), 'A•••');
  assert.equal(maskName(''), '');
  assert.equal(maskName('   '), '');
  assert.equal(maskName(null), '');
});
