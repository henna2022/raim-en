'use strict';
// 예약 상태 전이를 한 곳에 모은다. 결정을 내리는 입구가 두 개이기 때문이다:
//   ① 관리자 페이지 (src/routes/admin.js)
//   ② Google 시트의 상태 드롭다운 (src/routes/sheet-hook.js)
// 규칙과 메일 발송이 양쪽에 흩어져 있으면, 시트에서만 승인된 예약이 확정 메일 없이
// 남거나 확정 예약이 두 번 확정되는 식으로 조용히 갈린다. 어느 쪽으로 들어와도
// 같은 전이 규칙 · 같은 메일 · 같은 감사 기록(decided_by/decided_at)을 남긴다.
const { db } = require('./db');
const { getReservation } = require('./helpers');
const mailer = require('./mailer');
const sheets = require('./sheets');

// 프로토타입이 없는 객체로 만든다. 이 표는 URL 조각(/admin/reservations/:id/:action)과
// 시트 셀 문자열로 조회되는데, 평범한 객체 리터럴이면 'constructor'·'toString' 같은
// 이름이 Object.prototype의 값을 물고 올라와 `if (!t)` 검사를 통과한다. 그러면
// 바로 다음 줄의 t.from.includes(...)가 던지고, async 핸들러 안이라 Express 4가
// 잡지 못해 프로세스가 죽는다. 여기서 막으면 모든 호출부가 한꺼번에 안전해진다.
const TRANSITIONS = Object.assign(Object.create(null), {
  confirm: { from: ['pending', 'waitlisted'], to: 'confirmed' },
  waitlist: { from: ['pending'], to: 'waitlisted' },
  decline: { from: ['pending', 'waitlisted'], to: 'declined' },
  cancel: { from: ['pending', 'confirmed', 'waitlisted'], to: 'cancelled' },
  attended: { from: ['confirmed'], to: 'attended' },
  no_show: { from: ['confirmed'], to: 'no_show' },
  reopen: { from: ['declined', 'cancelled', 'no_show', 'attended', 'waitlisted'], to: 'pending' },
});

// 상태 변경에 딸린 방문객 메일. reopen(대기로 되돌리기)은 방문객에게 알릴 것이
// 없으므로 보내지 않는다 — 관리자 페이지도 같은 규칙이었다.
async function sendDecisionEmail(r, action) {
  if (action === 'confirm') {
    const ics = mailer.icsForReservation(r);
    return mailer.sendMail(
      r.email, `[Seoul RAIM] Reservation confirmed — ${r.code}`, mailer.confirmedEmail(r),
      [{ filename: 'raim-visit.ics', content: ics, contentType: 'text/calendar' }]
    );
  }
  if (action === 'waitlist') {
    return mailer.sendMail(r.email, `[Seoul RAIM] You're on the waitlist — ${r.code}`, mailer.waitlistedEmail(r));
  }
  if (action === 'decline') {
    return mailer.sendMail(r.email, `[Seoul RAIM] About your request — ${r.code}`, mailer.declinedEmail(r));
  }
  if (action === 'cancel') {
    return mailer.sendMail(r.email, `[Seoul RAIM] Reservation cancelled — ${r.code}`, mailer.cancelledEmail(r));
  }
  return { sent: false, skipped: true };
}

// r: getReservation()이 돌려준 현재 행. action: TRANSITIONS의 키.
// actor: 감사 기록에 남길 처리자 (관리자 username 또는 시트를 고친 구글 계정).
// 반환: { applied, reason?, reservation? }
async function applyDecision(r, action, { actor = '', declineReason = null } = {}) {
  const t = TRANSITIONS[action];
  if (!t) return { applied: false, reason: 'invalid_action' };
  if (!r) return { applied: false, reason: 'not_found' };
  if (!t.from.includes(r.status)) return { applied: false, reason: 'invalid_transition' };

  const reason = action === 'decline'
    ? String(declineReason == null ? r.decline_reason : declineReason).slice(0, 300)
    : r.decline_reason;

  // WHERE에 관측한 status를 건 갱신. 화면(또는 시트)을 본 시점과 제출 시점 사이에
  // 값이 바뀌었다면 — 직원 두 명이 동시에 처리했거나 그사이 방문객이 취소했다면 —
  // 덮어쓰지 않고 물러난다. 이게 없으면 취소된 예약에 확정 메일이 나갈 수 있다.
  const changed = db.prepare(
    `UPDATE reservations SET status=?, decline_reason=?, decided_at=datetime('now'), decided_by=?
     WHERE id=? AND status=?`
  ).run(t.to, reason, String(actor || '').slice(0, 120), r.id, r.status).changes;
  if (changed !== 1) return { applied: false, reason: 'raced' };

  if (action === 'cancel' && r.status === 'confirmed') {
    // 확정 시 yeyak에 차단해 둔 좌석이 있다 — 직원이 풀 때까지 해제 대기열에 남긴다.
    db.prepare('UPDATE reservations SET release_needed=1 WHERE id=?').run(r.id);
  }
  if (action === 'confirm') {
    // 확정 = yeyak 좌석을 의도적으로 잡아 둔 상태. 취소→재개→재확정 흐름에서
    // 남은 해제 플래그가 확정된 일행의 좌석을 풀라고 안내하면 안 된다.
    db.prepare('UPDATE reservations SET release_needed=0 WHERE id=?').run(r.id);
  }

  const updated = getReservation(r.id);
  sheets.nudge(); // await 하지 않는다 — 시트 지연이 응답을 늦추면 안 된다
  const email = await sendDecisionEmail(updated, action);
  return { applied: true, reservation: updated, email };
}

module.exports = { TRANSITIONS, applyDecision, sendDecisionEmail };
