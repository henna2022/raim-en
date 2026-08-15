'use strict';
// scripts/demo-seed.js — 시연용 시드. 별도 프로세스로 실행해(스크립트의 실제
// 실행 경로 그대로) 멱등성·격리(비데모 데이터 보존)·production 거부를 고정한다.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { startApp, stopApp, makeDataDir, withDb, newJar, get, makeReservation, uniqueEmail } = require('./helper');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'demo-seed.js');

function runSeed(dataDir, env = {}) {
  return execFileSync(process.execPath, [SCRIPT], {
    env: { ...process.env, DATA_DIR: dataDir, NODE_ENV: 'test', ...env },
    encoding: 'utf8',
  });
}

function demoRows(dataDir) {
  return withDb(dataDir, (db) =>
    db.prepare(`SELECT code, status, sheet_synced, reminder_sent FROM reservations WHERE email LIKE '%@demo.example'`).all());
}

let ctx;
test.before(async () => { ctx = await startApp(makeDataDir()); });
test.after(async () => { await stopApp(ctx.server); });

test('DS1: 시드는 대시보드의 모든 패널을 채우는 상태 조합을 만든다', async () => {
  const out = runSeed(ctx.dataDir);
  assert.match(out, /데모 예약 \d+건 생성/);
  const rows = demoRows(ctx.dataDir);
  const statuses = new Set(rows.map(r => r.status));
  for (const s of ['pending', 'waitlisted', 'confirmed', 'declined', 'cancelled']) {
    assert.ok(statuses.has(s), `${s} 데모 행이 있어야 한다`);
  }
  // yeyak 해제 대기열이 채워졌는지 (확정 후 취소 1건)
  const release = withDb(ctx.dataDir, (db) =>
    db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE release_needed=1 AND email LIKE '%@demo.example'`).get().c);
  assert.equal(release, 1);
  // SLA 초과(48시간 넘게 대기) 데모가 하나는 있어야 다이제스트·대시보드 강조가 보인다
  const late = withDb(ctx.dataDir, (db) =>
    db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE status='pending'
                AND created_at <= datetime('now', '-48 hours') AND email LIKE '%@demo.example'`).get().c);
  assert.ok(late >= 1);
});

test('DS2: 발송함에 각 단계의 메일이 실발송 없이 기록된다', () => {
  const mails = withDb(ctx.dataDir, (db) =>
    db.prepare(`SELECT subject, sent FROM email_log WHERE to_addr LIKE '%@demo.example'`).all());
  assert.ok(mails.length >= 8, '접수·확정·대기자·거절·취소 메일이 쌓여야 한다');
  assert.ok(mails.every(m => m.sent === 0), '시드가 실제 발송을 일으키면 안 된다');
  assert.ok(mails.some(m => m.subject.includes('Reservation confirmed')));
  assert.ok(mails.some(m => m.subject.includes('Request received')));
});

test('DS3: 시트 미러와 리마인더가 데모 행을 건드리지 않게 표시된다', () => {
  const rows = demoRows(ctx.dataDir);
  assert.ok(rows.every(r => r.sheet_synced === 1), '가짜 방문객이 실제 시트로 흘러가면 안 된다');
  assert.ok(rows.every(r => r.reminder_sent === 1), '가짜 방문객에게 리마인더가 나가면 안 된다');
});

test('DS3b: 아침 다이제스트가 데모 행을 집계에서 제외한다 (SMTP 서버에서 가짜 알림 방지)', () => {
  // 스케줄 작업은 sheet_synced/reminder_sent가 아니라 상태로 뽑으므로, 데모 행이
  // 다이제스트 대기·대기자·해제 목록에 섞이면 담당자에게 가짜 신청이 나간다.
  delete require.cache[require.resolve('../src/helpers')];
  process.env.DATA_DIR = ctx.dataDir;
  const { NOT_DEMO_SQL } = require('../src/helpers');
  const counts = withDb(ctx.dataDir, (db) => ({
    pending: db.prepare(`SELECT COUNT(*) c FROM reservations WHERE status='pending' AND ${NOT_DEMO_SQL('')}`).get().c,
    demoPending: db.prepare(`SELECT COUNT(*) c FROM reservations WHERE status='pending' AND email LIKE '%@demo.example'`).get().c,
    release: db.prepare(`SELECT COUNT(*) c FROM reservations WHERE release_needed=1 AND ${NOT_DEMO_SQL('')}`).get().c,
    waitlist: db.prepare(`SELECT COUNT(*) c FROM reservations WHERE status='waitlisted' AND ${NOT_DEMO_SQL('')}`).get().c,
  }));
  assert.ok(counts.demoPending >= 3, '데모 대기 행 자체는 DB에 있어야 한다');
  assert.equal(counts.pending, 0, '다이제스트가 세는 대기 건에는 데모가 없어야 한다');
  assert.equal(counts.release, 0, '해제 대기열에도 데모가 없어야 한다');
  assert.equal(counts.waitlist, 0, '대기자 목록에도 데모가 없어야 한다');
});

test('DS3c: 지난 날짜 데모 대기자는 자동거절되지 않는다 (실메일·시트 유출 방지)', async () => {
  // 시드가 만든 미래 대기자(Lena)는 언젠가 과거가 된다. 그때 expireWaitlist가
  // 잡아 자동거절하면 방문자에게 실메일이 나가고 상태 UPDATE가 시트 미러까지
  // 태운다 — 스케줄 작업이 데모 행을 건너뛰어야 그 유출이 막힌다.
  withDb(ctx.dataDir, (db) => {
    const slot = db.prepare('SELECT id FROM slots LIMIT 1').get().id;
    db.prepare(`INSERT INTO reservations (code, slot_id, visit_date, name, email, country, party_size, status, sheet_synced, reminder_sent)
                VALUES ('RAIM-DEMOEXP', ?, '2020-01-01', 'Past Demo', 'expire@demo.example', 'Spain', 1, 'waitlisted', 1, 1)`).run(slot);
  });
  const mailsBefore = withDb(ctx.dataDir, (db) =>
    db.prepare(`SELECT COUNT(*) c FROM email_log WHERE to_addr = 'expire@demo.example'`).get().c);

  delete require.cache[require.resolve('../src/maintenance')];
  process.env.DATA_DIR = ctx.dataDir;
  await require('../src/maintenance').expireWaitlist();

  const after = withDb(ctx.dataDir, (db) => ({
    status: db.prepare(`SELECT status, sheet_synced FROM reservations WHERE code='RAIM-DEMOEXP'`).get(),
    mails: db.prepare(`SELECT COUNT(*) c FROM email_log WHERE to_addr = 'expire@demo.example'`).get().c,
  }));
  assert.equal(after.status.status, 'waitlisted', '데모 대기자는 자동거절되지 않아야 한다');
  assert.equal(after.status.sheet_synced, 1, '시트 미러 트리거가 다시 켜지면 안 된다');
  assert.equal(after.mails, mailsBefore, '데모 방문자에게 메일이 나가면 안 된다');
});

test('DS4: 재실행은 멱등이고, 실제 신청 데이터는 건드리지 않는다', async () => {
  // 앞선 테스트가 남긴 데모 행에 기대지 않도록 한 번 시드해 기준선을 잡는다.
  runSeed(ctx.dataDir);
  // 진짜 방문객 신청을 하나 만들어 둔다
  const real = await makeReservation(ctx.baseUrl, newJar(), { email: uniqueEmail() });
  const firstCodes = demoRows(ctx.dataDir).map(r => r.code).sort();

  runSeed(ctx.dataDir);
  const rows = demoRows(ctx.dataDir);
  assert.equal(rows.length, firstCodes.length, '재실행해도 데모 행 수가 늘지 않는다');
  assert.notDeepEqual(rows.map(r => r.code).sort(), firstCodes, '이전 데모 행은 지워지고 새로 만든다');

  const realRow = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT status FROM reservations WHERE code = ?').get(real.code));
  assert.ok(realRow, '실제 신청은 남아 있어야 한다');
  assert.equal(realRow.status, 'pending');
});

test('DS5: production에서는 실행을 거부하고 아무것도 쓰지 않는다', () => {
  const dir = makeDataDir();
  assert.throws(() => runSeed(dir, { NODE_ENV: 'production' }), /production/i);
  // DB 파일 자체가 만들어지지 않았거나, 만들어졌어도 데모 행이 없어야 한다
  try {
    assert.equal(demoRows(dir).length, 0);
  } catch { /* DB 파일이 없으면 그것으로 충분하다 */ }
});

test('DS6: 시드 후 관리자 화면들이 정상 렌더링되고 데모 신청이 보인다', async () => {
  const jar = newJar();
  const { adminLogin } = require('./helper');
  await adminLogin(ctx.baseUrl, jar, {});
  const pendingCode = withDb(ctx.dataDir, (db) =>
    db.prepare(`SELECT code FROM reservations WHERE status='pending' AND email LIKE '%@demo.example' LIMIT 1`).get().code);
  const dash = await get(ctx.baseUrl, jar, '/admin');
  assert.equal(dash.status, 200);
  assert.match(await dash.text(), new RegExp(pendingCode), '데모 신청이 대시보드에 보여야 한다');
  const reservations = await get(ctx.baseUrl, jar, '/admin/reservations');
  assert.equal(reservations.status, 200);
  const emails = await get(ctx.baseUrl, jar, '/admin/emails');
  assert.equal(emails.status, 200);
});
