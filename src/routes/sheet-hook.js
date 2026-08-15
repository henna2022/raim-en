'use strict';
// Google 시트 → 앱 (미러의 반대 방향).
//
// 직원이 시트 '상태' 열의 드롭다운을 바꾸면 Apps Script의 onEdit 트리거가 이 엔드포인트로
// POST 하고, 여기서 실제 예약 상태를 바꾸고 방문객 메일까지 보낸다. 그래야 시트가
// "보는 화면"이 아니라 "처리하는 화면"이 된다.
//
// 설계상 주의점:
//  1) 이 라우터는 CSRF 미들웨어보다 **앞에** 마운트된다(src/app.js). 브라우저 폼이
//     아니라 구글 서버가 부르는 경로라 CSRF 토큰이 있을 수 없고, 대신 공유 비밀값이
//     유일한 인증 수단이다.
//  2) 비밀값은 시트 미러(SHEETS_WEBHOOK_SECRET)와 **다른 값**을 쓴다. 이쪽이 새면
//     남의 예약을 임의로 승인·거절하고 방문객에게 메일을 보낼 수 있어 피해 범위가
//     훨씬 크다 — 두 방향의 사고를 분리해 둔다.
//  3) 이미 목표 상태인 행은 아무것도 하지 않는다. 시트가 재시도하거나 직원이 같은
//     값을 다시 골라도 확정 메일이 두 번 나가면 안 된다.
const express = require('express');
const crypto = require('node:crypto');
const { db } = require('../db');
const { getReservationByCode } = require('../helpers');
const { TRANSITIONS, applyDecision } = require('../decisions');
const mailer = require('../mailer');
const sheets = require('../sheets');
const { STATUS_LABEL, SHEET_ACTIONS } = sheets;
const { rateLimit } = require('../ratelimit');

const SECRET = process.env.SHEETS_INBOUND_SECRET || '';
const enabled = !!SECRET;
const MAX_CHANGES = 50;
// 재전송 요청은 상태를 바꾸지 않아 훨씬 싸다 — 시트 한 화면을 통째로 맞출 수 있게 넉넉히.
const MAX_REFRESH_CODES = 1000;

const router = express.Router();

// 이 라우터에만 JSON 파서를 건다 — 나머지 사이트는 폼(urlencoded)만 받는다.
router.use(express.json({ limit: '64kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  onLimit: (req, res) => res.status(429).json({ ok: false, error: 'rate_limited' }),
});

// 길이를 먼저 보고 전체를 훑는 비교(Code.gs의 secretMatches_와 같은 방식).
function secretMatches(given) {
  if (!enabled || typeof given !== 'string') return false;
  const a = Buffer.from(SECRET);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 그 코드의 **지금** 상태 라벨. 전이 후에는 바뀐 상태를, 거부됐을 때는 그대로인
// 상태를 실어 보내야 시트가 진짜 값으로 맞춰진다. 그사이 보존기한 정리로 행이
// 사라졌으면 빈 문자열이 되어 시트 셀이 비워지고, 직원이 다시 확인하게 된다.
function labelOf(code) {
  const now = getReservationByCode(code);
  return now ? (STATUS_LABEL[now.status] || now.status) : '';
}

// 시트 한 줄의 처리 결과.
// label에는 항상 **앱이 보는 진짜 상태**를 실어 보낸다. 거부된 경우 시트가 이 값으로
// 셀을 되돌리므로, 편집 직전 값(e.oldValue)보다 이쪽이 정확하다 — 그 값 자체가
// 이미 낡았을 수 있기 때문. 실패 결과에서 label을 빠뜨리면 시트가 셀을 비워 버린다.
async function applyOne(change) {
  const code = String(change && change.code || '').trim().toUpperCase();
  const picked = String(change && change.status || '').trim();
  const actor = String(change && change.actor || '').trim().slice(0, 120);

  const r = getReservationByCode(code);
  if (!r) return { code, ok: false, error: 'not_found' };

  const label = () => labelOf(code);
  const action = SHEET_ACTIONS[picked];
  if (!action) return { code, ok: false, error: 'unknown_status', label: label() };

  // 이미 그 상태면 조용히 성공. 시트 재시도·중복 편집으로 메일이 두 번 나가지 않는다.
  if (r.status === TRANSITIONS[action].to) return { code, ok: true, changed: false, label: label() };

  const declineReason = action === 'decline'
    ? String(change.reason || '').trim().slice(0, 300)
    : null;
  const result = await applyDecision(r, action, { actor: actor || '시트', declineReason });
  if (!result.applied) return { code, ok: false, error: result.reason, label: label() };

  // 시트발 결정은 관리자 페이지에 흔적이 남지 않으므로 서버 로그에 남긴다.
  console.log(`[sheet-hook] ${code} ${r.status} → ${result.reservation.status} (처리자: ${actor || '미확인'})`);

  // 방문객 메일 결과도 실어 보낸다. ok:true만 보고 "메일도 나갔다"고 믿으면 SMTP
  // 장애 때 확정·거절 메일이 안 간 채 조용히 지나간다 — 방문객은 안내를 못 받았는데
  // 시트는 처리 완료로 보이는 상태가 가장 위험하다. reopen처럼 애초에 보낼 메일이
  // 없는 전이는 싣지 않는다 — '실패'로 오인되면 안 된다.
  const out = { code, ok: true, changed: true, label: label() };
  if (result.email && !result.email.skipped) {
    if (!mailer.smtpConfigured) {
      out.mail = 'outbox'; // SMTP 미설정: 설계상 미발송 보관 (관리자 > Emails에서 확인)
    } else if (result.email.sent) {
      out.mail = 'sent';
    } else {
      out.mail = 'failed';
      // 직원이 시트 토스트를 지나쳐도 서버 로그에는 남는다.
      console.error(`[sheet-hook] ${code} 방문객 메일 발송 실패: ${result.email.error || '원인 미상'}`);
    }
  }
  return out;
}

router.post('/status', limiter, async (req, res) => {
  if (!enabled) return res.status(503).json({ ok: false, error: 'disabled' });
  const body = req.body || {};
  if (!secretMatches(body.secret)) {
    console.warn(`[sheet-hook] 인증 실패 (ip: ${req.ip})`);
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  const changes = Array.isArray(body.changes) ? body.changes.slice(0, MAX_CHANGES) : [];
  if (changes.length === 0) return res.status(400).json({ ok: false, error: 'no_changes' });

  // 순차 처리 — 한 건이 확정 메일까지 끝난 뒤 다음으로 간다. 시트에서 한 번에 여러
  // 줄을 바꾸는 일은 드물고, 병렬로 보내 SMTP 쪽에서 막히는 것보다 낫다.
  const results = [];
  for (const change of changes) {
    try {
      results.push(await applyOne(change));
    } catch (err) {
      // 여기서도 label을 실어 보낸다 — 없으면 시트가 셀을 비워 버려, 예상 못한
      // 버그 하나가 "상태가 사라진 행"으로 번진다.
      const code = String(change && change.code || '').trim().toUpperCase();
      console.error('[sheet-hook] 처리 실패', err);
      const failed = { code, ok: false, error: 'server_error' };
      try {
        failed.label = labelOf(code);
      } catch {
        // 원인이 DB 쪽이면 labelOf도 같이 던진다 — catch 안에서 또 던지면 async
        // 핸들러의 거부를 Express 4가 못 받아 프로세스가 통째로 죽는다. label 없이
        // 보내면 시트가 셀을 비우고 직원이 다시 고르게 된다 — 그쪽이 안전한 방향이다.
      }
      results.push(failed);
    }
  }
  res.json({ ok: true, results });
});

// 시트를 앱 기준으로 되돌려 달라는 요청. 상태는 바꾸지 않고 미러 대기열에만 넣는다.
//
// 왜 필요한가: 미러는 sheet_synced=0인 행만 다시 보내고, 그 값은 DB가 실제로 바뀔 때만
// 0이 된다. 그래서 "시트에서 값을 고쳤지만 앱에는 반영하지 않은" 행 — 예컨대 한 번에
// 너무 많은 줄을 바꿔 Apps Script가 통째로 거부한 경우 — 은 DB가 그대로라 미러가
// 영영 다시 쓰지 않는다. 그러면 시트에는 '승인'이라고 적혀 있는데 앱은 대기 상태이고
// 확정 메일도 나가지 않은 채로 남는다. 그 상태가 가장 위험하다.
router.post('/refresh', limiter, (req, res) => {
  if (!enabled) return res.status(503).json({ ok: false, error: 'disabled' });
  const body = req.body || {};
  if (!secretMatches(body.secret)) {
    console.warn(`[sheet-hook] 인증 실패 (refresh, ip: ${req.ip})`);
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  // 전체 재전송: 코드 목록 없이 모든 행을 다시 쓰게 한다. 시트를 통째로 새로
  // 만들었거나 무엇이 어긋났는지 모를 때 쓰는 복구 수단 — 상태는 여전히 안 바꾼다.
  if (body.all === true) {
    const marked = db.prepare('UPDATE reservations SET sheet_synced = 0').run().changes;
    if (marked > 0) {
      console.log(`[sheet-hook] 전체 ${marked}건 시트 재전송 요청`);
      sheets.nudge(); // await 하지 않는다 — 곧바로 밀어내되 응답을 붙잡지 않는다
    }
    return res.json({ ok: true, marked });
  }

  const rawCodes = Array.isArray(body.codes) ? body.codes : [];
  // 넘치면 잘라내지 않고 통째로 거절한다. 조용히 일부만 처리하고 ok를 돌려주면
  // 호출한 쪽(Code.gs)은 "전부 됐다"고 믿고, 잘려 나간 행은 영영 낡은 채 남는다 —
  // 조용한 부분 성공이 제일 위험하다. 클라이언트가 나눠 보내거나 all:true를 쓴다.
  if (rawCodes.length > MAX_REFRESH_CODES) {
    return res.status(400).json({ ok: false, error: 'too_many_codes' });
  }
  const codes = rawCodes
    .map(c => String(c || '').trim().toUpperCase())
    .filter(Boolean);
  if (codes.length === 0) return res.status(400).json({ ok: false, error: 'no_codes' });

  const mark = db.prepare('UPDATE reservations SET sheet_synced = 0 WHERE code = ?');
  let marked = 0;
  for (const code of codes) marked += mark.run(code).changes;
  if (marked > 0) {
    console.log(`[sheet-hook] ${marked}건 시트 재전송 요청 (시트 값이 앱과 어긋남)`);
    sheets.nudge(); // await 하지 않는다 — 곧바로 밀어내되 응답을 붙잡지 않는다
  }
  res.json({ ok: true, marked });
});

module.exports = router;
