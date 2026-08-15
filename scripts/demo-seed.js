'use strict';
// 데모 시드 — 빈 DB로 시연을 시작하지 않도록 그럴듯한 예약 이력을 만든다.
// 대시보드의 모든 패널(대기 그룹, SLA 초과 강조, 대기자, yeyak 해제 대기,
// 어제의 방문완료/노쇼)과 발송함(Emails)이 한 번에 채워진다.
//
// 실행: npm run demo-seed   (DATA_DIR을 앱과 똑같이 따른다 — 기본 ./data)
//
// 안전장치:
//  - production에서는 실행을 거부한다. 데모 데이터가 운영 DB에 들어가면 안 된다.
//  - 데모 행은 이메일 도메인(@demo.example — RFC 2606이 예약해 배달 불가한
//    도메인)으로만 식별한다. 재실행하면 이전 데모 행을 지우고 새로 만들며(멱등),
//    그 외의 데이터는 절대 건드리지 않는다.
//  - 메일은 sendMail을 거치지 않고 발송함(outbox) 행으로만 기록한다 — SMTP가
//    설정된 서버에서 실행해도 이 스크립트 자체는 실제 발송을 하지 않는다.
//  - 부작용을 내는 스케줄 작업(대기자 자동거절·아침 다이제스트·구글 시트 미러)은
//    @demo.example 행을 건너뛴다(src/helpers.js NOT_DEMO_SQL). 그래서 SMTP·담당자
//    메일이 설정된 데모 서버에서도 가짜 방문자가 실제 메일·시트로 새어 나가지
//    않는다. 데모 데이터는 운영 시트에 미러되지 않는다(그게 목적이다).
//  - 삭제·삽입·플래그 설정을 한 트랜잭션으로 묶는다. 도중에 실패해도 이전 상태가
//    그대로 남고, "지우고 다시 만든다"는 약속이 어떤 실패 경로에서도 깨지지 않는다.

if (process.env.NODE_ENV === 'production') {
  console.error('demo-seed: NODE_ENV=production에서는 실행하지 않습니다 — 데모 데이터는 운영 DB에 넣는 것이 아닙니다.');
  process.exit(1);
}

const { db } = require('../src/db');
const {
  todayStr, addDays, closureInfo, sessionsForDate, genCode, getReservationByCode, DEMO_EMAIL_DOMAIN,
} = require('../src/helpers');
const mailer = require('../src/mailer');

const DEMO_DOMAIN = DEMO_EMAIL_DOMAIN;

// ---------- 열린 날짜 찾기 (쓰기 전에 먼저 확보한다) ----------
// dir=+1이면 미래로, -1이면 과거로 하루씩 움직이며 휴관이 아닌 날을 모은다.
function openDays(count, dir) {
  const days = [];
  for (let i = 1; days.length < count && i <= 30; i++) {
    const d = addDays(todayStr(), i * dir);
    if (closureInfo(d).closed) continue;
    const sessions = (sessionsForDate(d).sessions || []).filter(s => !s.soldout);
    if (sessions.length >= 2) days.push({ date: d, sessions });
  }
  return days;
}

// 삭제보다 먼저 검증한다 — 아니면 실패 경로에서 이전 데모 데이터만 날리고
// 새 데이터는 못 만들어, 시연 직전 재실행이 오히려 화면을 비워 버린다.
const future = openDays(3, 1);
const past = openDays(1, -1);
if (future.length < 3) {
  console.error('demo-seed: 예약 가능한 미래 날짜를 충분히 찾지 못했습니다 — 회차(slots) 시드가 있는 DB인지, 장기 휴관 설정이 없는지 확인하세요. (아무것도 바꾸지 않았습니다)');
  process.exit(1);
}

// 과거 방문일 기준으로 "생성은 그 며칠 전, 처리는 방문 즈음"이 되도록 시간을 잡는다.
// 고정 시간(예: 80시간 전)은 그 사이 휴관이 많아 과거 개관일이 멀 때 created_at이
// visit_date보다 뒤로 밀려 화면에 어색하게 보인다.
function hoursBeforeDate(dateStr, extraDays) {
  const days = Math.max(0, Math.round((Date.parse(todayStr()) - Date.parse(dateStr)) / 86400000));
  return (days + extraDays) * 24;
}

// ---------- 예약 + 발송함 기록 (한 트랜잭션) ----------
const insertRes = db.prepare(`
  INSERT INTO reservations (code, slot_id, visit_date, name, email, country, party_size,
                            status, decline_reason, release_needed, created_at)
  VALUES (?,?,?,?,?,?,?,?,?,?, datetime('now', ?))`);
const decide = db.prepare(`
  UPDATE reservations SET decided_at = datetime('now', ?), decided_by = ? WHERE code = ?`);
const logMail = db.prepare(`INSERT INTO email_log (to_addr, subject, html, sent, error) VALUES (?,?,?,0,'')`);

const made = [];
function seedOne({ name, email, country, party, date, session, status = 'pending',
                   createdAgoH = 3, decidedAgoH = null, decidedBy = '시트(demo-seed)',
                   declineReason = '', releaseNeeded = 0, mails = ['received'] }) {
  let code = genCode();
  while (db.prepare('SELECT 1 FROM reservations WHERE code = ?').get(code)) code = genCode();
  insertRes.run(code, session.id, date, name, email, country, party,
    status, declineReason, releaseNeeded, `-${createdAgoH} hours`);
  if (decidedAgoH != null) decide.run(`-${decidedAgoH} hours`, decidedBy, code);

  // 실제 흐름이 남겼을 메일을 발송함에만 기록한다(실발송 없음). 제목은
  // public.js/decisions.js가 쓰는 실제 제목과 같아야 시연에서 어색하지 않다.
  const r = getReservationByCode(code);
  for (const kind of mails) {
    if (kind === 'received') logMail.run(r.email, `[Seoul RAIM] Request received — ${r.code}`, mailer.requestReceivedEmail(r));
    if (kind === 'confirmed') logMail.run(r.email, `[Seoul RAIM] Reservation confirmed — ${r.code}`, mailer.confirmedEmail(r));
    if (kind === 'waitlisted') logMail.run(r.email, `[Seoul RAIM] You're on the waitlist — ${r.code}`, mailer.waitlistedEmail(r));
    if (kind === 'declined') logMail.run(r.email, `[Seoul RAIM] About your request — ${r.code}`, mailer.declinedEmail(r));
    if (kind === 'cancelled') logMail.run(r.email, `[Seoul RAIM] Reservation cancelled — ${r.code}`, mailer.cancelledEmail(r));
  }
  made.push({ code, status, date, name });
  return code;
}

const [d1, d2, d3] = future;
let removedRes = 0;
let removedMail = 0;

db.exec('BEGIN');
try {
  // 이전 데모 행 정리 (그 외 데이터는 건드리지 않는다). 트랜잭션 안이라, 아래
  // 삽입 중 무엇이 실패하면 이 삭제까지 통째로 롤백된다.
  removedRes = db.prepare(`DELETE FROM reservations WHERE email LIKE '%@' || ?`).run(DEMO_DOMAIN).changes;
  removedMail = db.prepare(`DELETE FROM email_log WHERE to_addr LIKE '%@' || ?`).run(DEMO_DOMAIN).changes;

  // 대기 2건이 같은 회차 — 대시보드의 (방문일, 회차) 그룹 묶음과 "합계 좌석 차단"이 보인다.
  seedOne({ name: 'Ana García', email: `ana@${DEMO_DOMAIN}`, country: 'Spain', party: 2,
    date: d1.date, session: d1.sessions[0], createdAgoH: 5 });
  seedOne({ name: 'Kenji Sato', email: `kenji@${DEMO_DOMAIN}`, country: 'Japan', party: 3,
    date: d1.date, session: d1.sessions[0], createdAgoH: 26 });
  // SLA(48시간) 초과 대기 — 다이제스트와 대시보드의 빨간 강조가 보인다.
  seedOne({ name: 'Priya Sharma', email: `priya@${DEMO_DOMAIN}`, country: 'India', party: 1,
    date: d2.date, session: d2.sessions[1], createdAgoH: 52 });
  // 대기자 — 좌석이 나면 승격(Confirm)하는 흐름.
  seedOne({ name: 'Lena Müller', email: `lena@${DEMO_DOMAIN}`, country: 'Germany', party: 2,
    date: d1.date, session: d1.sessions[1], status: 'waitlisted',
    createdAgoH: 20, decidedAgoH: 18, mails: ['received', 'waitlisted'] });
  // 확정 — My Booking 조회·취소 시연용.
  seedOne({ name: 'Grace Lee', email: `grace@${DEMO_DOMAIN}`, country: 'Singapore', party: 4,
    date: d2.date, session: d2.sessions[0], status: 'confirmed',
    createdAgoH: 30, decidedAgoH: 24, mails: ['received', 'confirmed'] });
  // 거절 — 사유가 이메일 확인 보기에서만 보이는 것도 시연 포인트.
  seedOne({ name: 'Marco Rossi', email: `marco@${DEMO_DOMAIN}`, country: 'Italy', party: 5,
    date: d3.date, session: d3.sessions[0], status: 'declined',
    declineReason: 'The session was fully booked; please try another date.',
    createdAgoH: 40, decidedAgoH: 36, mails: ['received', 'declined'] });
  // 확정 후 취소 — yeyak 해제 대기열(release queue)이 채워진다.
  seedOne({ name: 'Tom Becker', email: `tom@${DEMO_DOMAIN}`, country: 'Australia', party: 2,
    date: d3.date, session: d3.sessions[1], status: 'cancelled', releaseNeeded: 1,
    decidedBy: 'visitor', createdAgoH: 48, decidedAgoH: 6,
    mails: ['received', 'confirmed', 'cancelled'] });
  // 지난 방문일의 방문완료/노쇼 — 데스크 처리 이력이 보인다. (휴관 등으로 못 찾으면 건너뛴다)
  if (past.length) {
    const pd = past[0].date;
    seedOne({ name: 'Yuki Tanaka', email: `yuki@${DEMO_DOMAIN}`, country: 'Japan', party: 2,
      date: pd, session: past[0].sessions[0], status: 'attended',
      createdAgoH: hoursBeforeDate(pd, 3), decidedAgoH: hoursBeforeDate(pd, 0), decidedBy: 'admin',
      mails: ['received', 'confirmed'] });
    seedOne({ name: 'Emma Wilson', email: `emma@${DEMO_DOMAIN}`, country: 'United Kingdom', party: 1,
      date: pd, session: past[0].sessions[1], status: 'no_show',
      createdAgoH: hoursBeforeDate(pd, 3), decidedAgoH: hoursBeforeDate(pd, 0), decidedBy: 'admin',
      mails: ['received', 'confirmed'] });
  }

  // 리마인더가 가짜 방문객에게 나가지 않게 한다(스케줄 작업은 @demo.example를 건너뛰지만
  // 리마인더는 reminder_sent로도 막는다). decided_at UPDATE가 sheet_synced를 0으로 만드는
  // 트리거를 태우므로 이 정리는 반드시 삽입이 모두 끝난 뒤에 한다.
  db.prepare(`UPDATE reservations SET sheet_synced = 1, reminder_sent = 1 WHERE email LIKE '%@' || ?`).run(DEMO_DOMAIN);

  db.exec('COMMIT');
} catch (err) {
  db.exec('ROLLBACK');
  console.error('demo-seed: 시드 도중 오류가 발생해 아무것도 바꾸지 않았습니다(롤백).', err);
  process.exit(1);
}

// ---------- 요약 ----------
if (removedRes || removedMail) {
  console.log(`이전 데모 데이터 정리: 예약 ${removedRes}건, 메일 ${removedMail}건 삭제`);
}
console.log(`데모 예약 ${made.length}건 생성:`);
for (const m of made) console.log(`  ${m.code}  ${m.status.padEnd(10)} ${m.date}  ${m.name}`);
console.log(`
- 발송함(관리자 > Emails)에도 각 단계의 메일이 기록되어 있습니다 (실발송 없음).
- 데모 행은 @${DEMO_DOMAIN} 이메일로 식별합니다. 재실행하면 지우고 다시 만들며,
  실제 신청 데이터는 건드리지 않습니다.
- 스케줄 작업(대기자 자동거절·다이제스트·시트 미러)은 데모 행을 건너뜁니다 —
  SMTP·담당자 메일이 설정돼 있어도 가짜 방문자가 실제로 나가지 않습니다.
  같은 이유로 데모 데이터는 운영 구글 시트에 미러되지 않습니다.`);
