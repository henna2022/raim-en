'use strict';
// Google 시트 미러 — 신청/상태 변경을 Apps Script 웹앱(scripts/apps-script/Code.gs)으로
// 밀어 넣습니다. 시트는 직원이 "보는" 기록이고 원본은 이 앱의 DB입니다.
//
// 설계 원칙:
//  1) 시트가 예약을 막거나 늦추지 않는다 — 요청 경로에서는 await 하지 않고(nudge),
//     실패는 전부 삼킨다.
//  2) 놓치는 행이 없다 — reservations.sheet_synced=0 이 대기열이고, DB 트리거가
//     상태·개인정보 컬럼이 바뀔 때마다 자동으로 0으로 되돌린다(src/db.js). 호출부를
//     추가하는 걸 잊어도 동기화 루프가 알아서 따라잡는다.
//  3) 보존기한을 시트까지 적용한다 — 앱에서 파기된 건은 시트에서도 지운다.
const { db } = require('./db');
const { sessionOrdinal } = require('./helpers');

const WEBHOOK_URL = (process.env.SHEETS_WEBHOOK_URL || '').trim();
const WEBHOOK_SECRET = process.env.SHEETS_WEBHOOK_SECRET || '';
// 동기화 루프에서 쓰는 값. 요청 경로는 await 하지 않으므로 방문자 체감과 무관하다.
// Apps Script는 콜드 스타트가 있어 첫 호출이 수십 초 걸리기도 한다 — 실측에서
// 30초를 넘긴 적이 있어 넉넉하게 잡는다.
const TIMEOUT_MS = Number(process.env.SHEETS_TIMEOUT_MS || 45000);
const BATCH = 50;

const enabled = !!(WEBHOOK_URL && WEBHOOK_SECRET);

const TOUR_SHORT = { permanent: '상설', special: '기획' };
const STATUS_LABEL = {
  pending: '대기(검토중)',
  waitlisted: '대기자',
  confirmed: '확정',
  declined: '거절',
  cancelled: '취소',
  attended: '방문완료',
  no_show: '노쇼',
};

// 예약 행(reservations JOIN slots) → 시트 한 줄.
// 요청사항(자유입력)은 시트로 보내지 않는다 — 휠체어·알레르기 같은 건강 정보가
// 섞이면 민감정보가 되어 접속기록 보관기간이 2년으로 늘고 유출 시 신고 기준도
// 달라지기 때문. 상세는 관리자 페이지에서 확인한다.
function toRow(r) {
  // 전시 구분·회차·시간을 각각 열로 나눈다 — 시트에서 전시별로 필터하거나 시간대로
  // 정렬하려면 값이 따로 있어야 한다. 회차 번호는 그 날짜 기준으로 계산한다:
  // 기획전시는 주말에만 09:30이 열려 같은 시각이라도 요일에 따라 번호가 달라진다.
  const ordinal = sessionOrdinal(r.visit_date, r.tour_type, r.slot_id);
  return {
    code: r.code,
    status: STATUS_LABEL[r.status] || r.status,
    visit_date: r.visit_date,
    name: r.name,
    country: r.country,
    tour_type: TOUR_SHORT[r.tour_type] || r.tour_type,
    session: ordinal ? `${ordinal}회차` : '',
    time: `${r.start_time}~${r.end_time}`,
    party_size: r.party_size,
    email: r.email,
    created_at: r.created_at,
    decided_at: r.decided_at || '',
    decided_by: r.decided_by || '',
    decline_reason: r.decline_reason || '',
  };
}

async function post(body) {
  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: WEBHOOK_SECRET, ...body }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    // Apps Script는 doPost를 실행한 뒤 script.googleusercontent.com으로 302를 보낸다.
    // fetch가 302에서 POST를 GET으로 바꾸지만, 그건 결과를 받아오는 요청이라 본문은
    // 이미 도달한 뒤다. 아래 카운트 검증이 이 가정을 매번 확인해 준다.
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body2 = await res.json().catch(() => null);
  if (!body2 || body2.ok !== true) {
    throw new Error(`webhook rejected: ${body2 && body2.error ? body2.error : 'bad response'}`);
  }
  return body2;
}

// 쓰기 결과를 건수로 확인한다. ok:true만 믿으면 doGet 응답이나 엉뚱한 200을
// 성공으로 착각해 sheet_synced=1을 찍고 데이터를 영영 잃는다.
async function postRows(rows) {
  const res = await post({ rows });
  const written = (res.appended | 0) + (res.updated | 0);
  const failed = new Set((res.failed || []).map(String));
  if (written === 0 && rows.length > 0 && failed.size === 0) {
    throw new Error('webhook wrote nothing (POST가 doPost에 도달하지 못했을 수 있음)');
  }
  return failed;
}

// 성공한 행만 표시. sheet_synced=0 조건을 걸어, 전송 중에 값이 바뀌어 다시 큐에
// 들어간 행을 성공으로 덮어쓰지 않는다.
function markSynced(ids) {
  if (ids.length === 0) return;
  const stmt = db.prepare('UPDATE reservations SET sheet_synced = 1 WHERE id = ? AND sheet_synced = 0');
  for (const id of ids) stmt.run(id);
}

function pendingCount() {
  if (!enabled) return 0;
  return db.prepare('SELECT COUNT(*) AS c FROM reservations WHERE sheet_synced = 0').get().c;
}

// 요청 경로용 — await 하지 말 것. 실패해도 sheet_synced=0으로 남아 루프가 재시도한다.
function nudge() {
  if (!enabled) return;
  syncPending().catch(() => { /* 루프가 재시도하므로 여기서는 삼킨다 */ });
}

// 동시에 여러 번 불려도 한 번만 돈다. nudge()가 요청마다 호출되므로 이게 없으면
// 같은 행을 여러 번 전송하며 Apps Script 실행 시간을 낭비한다.
let inFlight = null;
function syncPending(limit = BATCH) {
  if (!enabled) return Promise.resolve({ skipped: 'disabled', synced: 0, pending: 0 });
  if (inFlight) return inFlight;
  inFlight = syncPendingOnce(limit).finally(() => { inFlight = null; });
  return inFlight;
}

// 밀린 행을 배치로 전송. 배치가 통째로 실패하면 행 단위로 한 번 더 시도해
// 문제 있는 한 건이 대기열 전체를 막지 않게 한다.
async function syncPendingOnce(limit) {
  const rows = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.sheet_synced = 0 ORDER BY r.id LIMIT ?`).all(limit);
  if (rows.length === 0) return { synced: 0, pending: 0 };

  let synced = 0;
  try {
    const failed = await postRows(rows.map(toRow));
    const ok = rows.filter(r => !failed.has(r.code));
    markSynced(ok.map(r => r.id));
    synced = ok.length;
    if (failed.size) console.error(`[sheets] ${failed.size}건이 시트 쪽에서 거부됨: ${[...failed].join(', ')}`);
  } catch (err) {
    console.error(`[sheets] 배치 동기화 실패 (${err.message}) — 행 단위로 재시도`);
    for (const r of rows) {
      try {
        const failed = await postRows([toRow(r)]);
        if (!failed.has(r.code)) { markSynced([r.id]); synced += 1; }
      } catch { /* 이 행은 다음 주기에 다시 시도 */ }
    }
  }
  if (synced > 0) console.log(`[sheets] ${synced}건 동기화`);
  return { synced, pending: pendingCount() };
}

// 앱에서 파기된 예약을 시트에서도 지우도록 큐에 넣는다(보존기한 일치).
// 동기 함수라 purgeOldData()의 삭제와 같은 흐름에서 안전하게 호출할 수 있고,
// 실제 전송은 flushDeletes()가 맡아 시트 장애와 무관하게 기록이 남는다.
function queueDeletes(codes) {
  if (!enabled || codes.length === 0) return 0;
  const queue = db.prepare('INSERT OR IGNORE INTO sheet_deletes (code) VALUES (?)');
  for (const code of codes) queue.run(code);
  return codes.length;
}

async function flushDeletes() {
  if (!enabled) return { deleted: 0 };
  const pending = db.prepare('SELECT code FROM sheet_deletes ORDER BY id LIMIT ?').all(BATCH).map(r => r.code);
  if (pending.length === 0) return { deleted: 0 };
  try {
    await post({ deleteCodes: pending });
    const del = db.prepare('DELETE FROM sheet_deletes WHERE code = ?');
    for (const code of pending) del.run(code);
    console.log(`[sheets] 보존기한 만료 ${pending.length}건 시트에서 삭제`);
    return { deleted: pending.length };
  } catch (err) {
    console.error(`[sheets] 시트 삭제 실패 (${err.message}) — 다음 주기에 재시도`);
    return { deleted: 0, error: String(err.message || err) };
  }
}

function deletesPending() {
  if (!enabled) return 0;
  return db.prepare('SELECT COUNT(*) AS c FROM sheet_deletes').get().c;
}

module.exports = {
  enabled, nudge, syncPending, queueDeletes, flushDeletes,
  pendingCount, deletesPending, toRow, STATUS_LABEL,
};
