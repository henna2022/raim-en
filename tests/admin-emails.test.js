'use strict';
// 관리자 > Emails의 재발송 버튼. 저장된 스냅샷을 sendMail로 다시 보내
// 새 email_log 행이 생긴다 — 발송 실패 후속 조치와 데모의 핵심 경로다.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  startApp, stopApp, makeDataDir, withDb, newJar, get,
  postAdminForm, postFormNoCsrf, makeReservation, adminLogin, uniqueEmail,
} = require('./helper');

let ctx;
test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  await adminLogin(ctx.baseUrl, ctx.jar, {});
});
test.after(async () => { await stopApp(ctx.server); });

function emailRows() {
  return withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT id, to_addr, subject, html, sent FROM email_log ORDER BY id').all());
}

test('RS1: 재발송하면 같은 수신자·제목·본문으로 새 email_log 행이 생긴다', async () => {
  const r = await makeReservation(ctx.baseUrl, newJar(), { email: uniqueEmail() });
  const before = emailRows();
  const original = before.find(e => e.subject.includes('Request received') && e.subject.includes(r.code));
  assert.ok(original, '접수 메일이 있어야 한다');

  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/emails/${original.id}/resend`, {});
  assert.equal(res.status, 302);
  // 주소를 URL에 싣지 않는다 — 리다이렉트는 결과 플래그만 담는다.
  assert.equal(res.headers.get('location'), '/admin/emails?resent=1&ok=0');

  const after = emailRows();
  assert.equal(after.length, before.length + 1);
  const copy = after.at(-1);
  assert.equal(copy.to_addr, original.to_addr);
  assert.equal(copy.subject, original.subject);
  assert.equal(copy.html, original.html);
  assert.equal(copy.sent, 0, 'SMTP 미설정이므로 발송함(outbox)에 남는다');
});

test('RS2: 발송함 모드의 재발송 결과 페이지는 "실제 발송 없음"을 분명히 알린다', async () => {
  const page = await get(ctx.baseUrl, ctx.jar, '/admin/emails?resent=1&ok=0');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /실제로는 아무것도 전달되지 않았습니다/);
});

test('RS3: 없는 메일 id는 404, 행이 늘지 않는다', async () => {
  const before = emailRows().length;
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/emails/999999/resend', {});
  assert.equal(res.status, 404);
  assert.equal(emailRows().length, before);
});

test('RS4: CSRF 토큰 없이 재발송은 거부된다', async () => {
  const before = emailRows().length;
  const res = await postFormNoCsrf(ctx.baseUrl, ctx.jar, '/admin/emails/1/resend', {});
  assert.equal(res.status, 403);
  assert.equal(emailRows().length, before);
});

test('RS5: 로그인 없이 재발송은 거부된다', async () => {
  const before = emailRows().length;
  const res = await postFormNoCsrf(ctx.baseUrl, newJar(), '/admin/emails/1/resend', {});
  assert.ok([302, 403].includes(res.status), '로그인 페이지로 보내거나 거부해야 한다');
  assert.equal(emailRows().length, before);
});

test('RS6: Emails 목록에 Resend 버튼과 confirm 가드가 있다', async () => {
  const page = await get(ctx.baseUrl, ctx.jar, '/admin/emails');
  const body = await page.text();
  assert.match(body, /action="\/admin\/emails\/\d+\/resend"/);
  assert.match(body, /onsubmit="return confirm\(/);
});
