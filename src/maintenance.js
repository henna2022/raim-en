'use strict';
const { db, getSettings, setSetting } = require('./db');
const { todayStr, addDays, nowHM, SLA_HOURS, NOT_DEMO_SQL } = require('./helpers');
const mailer = require('./mailer');
const sheets = require('./sheets');

// Personal-data retention: reservations (and the emails that quote them) are kept
// for `retention_days` after the visit date, then deleted. This is what makes the
// privacy note on the public site true — do not remove.
//
// No-show retention (option b): no_show rows are kept separately, for
// max(noshow_retention_days, retention_days) days, so the no-show badge (A4)
// stays useful even after the normal retention window would otherwise have
// erased the record.
function purgeOldData() {
  const settings = getSettings();
  const days = Math.max(1, Number(settings.retention_days || 90));
  const noshowDays = Math.max(1, Number(settings.noshow_retention_days || 365));
  const cutoffGeneral = addDays(todayStr(), -days);
  const cutoffNoshow = addDays(todayStr(), -Math.max(noshowDays, days));
  // 지울 코드를 먼저 모아 시트 삭제 큐에 넣는다. DB에서만 지워지면 Google 시트에
  // 방문객 개인정보가 무기한 남아, 공개 페이지의 보존기한 안내가 거짓이 된다.
  const doomed = [
    ...db.prepare(`SELECT code FROM reservations WHERE visit_date < ? AND status != 'no_show'`).all(cutoffGeneral),
    ...db.prepare(`SELECT code FROM reservations WHERE status = 'no_show' AND visit_date < ?`).all(cutoffNoshow),
  ].map(r => r.code);
  sheets.queueDeletes(doomed);

  const reservations = db.prepare(`DELETE FROM reservations WHERE visit_date < ? AND status != 'no_show'`).run(cutoffGeneral);
  const noshows = db.prepare(`DELETE FROM reservations WHERE status = 'no_show' AND visit_date < ?`).run(cutoffNoshow);
  const emails = db.prepare(`DELETE FROM email_log WHERE created_at < datetime('now', ?)`).run(`-${days} days`);
  // Sold-out marks are only meaningful for future dates — drop them right away.
  const soldout = db.prepare(`DELETE FROM soldout WHERE date < ?`).run(todayStr());
  if (reservations.changes || noshows.changes || emails.changes || soldout.changes) {
    console.log(`[retention] purged ${reservations.changes} reservations, ${noshows.changes} no-shows, ${emails.changes} emails, ${soldout.changes} sold-out marks (older than ${days} days)`);
  }
  return { reservations: reservations.changes, noshows: noshows.changes, emails: emails.changes, soldout: soldout.changes };
}

// Day-before-visit reminder emails: confirmed reservations visiting tomorrow
// (KST) that haven't been reminded yet get one, then are flagged so they're
// never emailed twice.
async function sendReminders() {
  const target = addDays(todayStr(), 1);
  const rows = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.status = 'confirmed' AND r.visit_date = ? AND r.reminder_sent = 0`).all(target);
  let sent = 0;
  for (const r of rows) {
    await mailer.sendMail(r.email, `[Seoul RAIM] Reminder — your visit is tomorrow (${r.code})`, mailer.reminderEmail(r));
    db.prepare('UPDATE reservations SET reminder_sent = 1 WHERE id = ?').run(r.id);
    sent += 1;
  }
  if (sent > 0) console.log(`[reminder] sent ${sent}`);
  return sent;
}

// Waitlisted requests whose visit date has passed can no longer be promoted —
// close them out (auto-decline + email) instead of letting them vanish from
// the dashboard/digest while the visitor still sees "Waitlisted" forever.
async function expireWaitlist() {
  const today = todayStr();
  // 데모 시드 행은 건너뛴다 — 자동거절하면 방문자에게 실메일이 나가고, 그
  // 상태 UPDATE가 시트 미러 트리거를 태워 가짜 방문자가 실제 시트로도 새어
  // 나간다(src/helpers.js DEMO_EMAIL_DOMAIN 주석 참조).
  const rows = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.status = 'waitlisted' AND r.visit_date < ? AND ${NOT_DEMO_SQL('r')}`).all(today);
  const update = db.prepare(`
    UPDATE reservations SET status='declined', decline_reason=?, decided_at=datetime('now'), decided_by='system'
    WHERE id=? AND status='waitlisted'`);
  const REASON = 'No seats freed up before your visit date.';
  let expired = 0;
  for (const r of rows) {
    // Email FIRST, commit the status only once delivery is accounted for. The
    // reverse order silently declines a visitor who is never told: the guarded
    // UPDATE no longer matches on a later pass, so nothing ever retries.
    // (Without SMTP the outbox row IS the delivery — same convention as the
    // digest below.)
    const sendResult = await mailer.sendMail(r.email, `[Seoul RAIM] About your request — ${r.code}`,
      mailer.declinedEmail({ ...r, decline_reason: REASON }));
    if (mailer.smtpConfigured && !sendResult.sent) {
      console.error(`[waitlist] decline email failed for ${r.code} (${sendResult.error}) — leaving it waitlisted for the next pass`);
      continue;
    }
    if (update.run(REASON, r.id).changes === 1) expired += 1;
  }
  if (expired > 0) console.log(`[waitlist] auto-declined ${expired} past-date waitlisted request(s)`);
  return expired;
}

// Morning digest: one staff email a day (at digest_hour KST, hourly-checked)
// summarizing pending requests (SLA breaches flagged), the yeyak release
// queue, and today's confirmed visitors — a routine to work through instead
// of reacting to per-event notifications.
//
// The digest_last_sent guard marks the day as PROCESSED on a successful send,
// an intentionally-empty day, or a missing staff address — so the digest fires
// at most once per day and always at the scheduled hour, never as a surprise
// afternoon email after a quiet morning. A TRANSPORT failure (SMTP configured
// but the send errored) deliberately leaves the day unmarked, so the next
// hourly tick retries instead of silently losing the day's digest.
async function sendDailyDigest() {
  const settings = getSettings();
  const hour = Number.parseInt(settings.digest_hour, 10);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { sent: false, skipped: 'disabled' };

  const today = todayStr();
  if (settings.digest_last_sent === today) return { sent: false, skipped: 'already_sent' };
  if (Number(nowHM().slice(0, 2)) < hour) return { sent: false, skipped: 'not_due' };

  // 모든 집계에서 데모 시드 행을 뺀다 — 아니면 SMTP·담당자 메일이 설정된
  // 데모 서버에서 실제 직원에게 가짜 신청(SLA 초과 알람 포함)이 실려 나간다
  // (src/helpers.js DEMO_EMAIL_DOMAIN 주석 참조).
  const pending = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language,
           CAST((julianday('now') - julianday(r.created_at)) * 24 AS INTEGER) AS age_hours
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.status = 'pending' AND ${NOT_DEMO_SQL('r')}
    ORDER BY r.visit_date, s.start_time, r.created_at`).all();
  const releaseQueue = db.prepare(`
    SELECT r.*, s.start_time, s.end_time,
           (SELECT COUNT(*) FROM reservations w
             WHERE w.status = 'waitlisted' AND w.visit_date = r.visit_date AND w.slot_id = r.slot_id) AS waitlist_count
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.release_needed = 1 AND ${NOT_DEMO_SQL('r')} ORDER BY r.decided_at`).all();
  const todaysCount = db.prepare(`
    SELECT COUNT(*) AS c FROM reservations
    WHERE visit_date = ? AND status IN ('confirmed','attended') AND ${NOT_DEMO_SQL('')}`).get(today).c;
  const waitlist = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.status = 'waitlisted' AND r.visit_date >= ? AND ${NOT_DEMO_SQL('r')}
    ORDER BY r.visit_date, s.start_time, r.created_at`).all(today);

  // Waitlisted rows are actionable too (time-critical: promote or decline
  // before the visit date) — a waitlist-only day must still send.
  if (pending.length === 0 && releaseQueue.length === 0 && waitlist.length === 0) {
    setSetting('digest_last_sent', today);
    console.log('[digest] nothing actionable — skipped');
    return { sent: false, skipped: 'empty' };
  }

  const lateCount = pending.filter(p => p.age_hours >= SLA_HOURS).length;
  const subject = `[RAIM] 아침 다이제스트 — 대기 ${pending.length}건`
    + (lateCount > 0 ? ` (SLA 초과 ${lateCount}건)` : '')
    + ` · yeyak 해제 ${releaseQueue.length}건`
    + (waitlist.length > 0 ? ` · 대기자 ${waitlist.length}명` : '');
  const result = await mailer.notifyStaff(subject,
    mailer.digestEmail({
      pending, releaseQueue, todaysCount, waitlist, slaHours: SLA_HOURS,
      // 시트가 뒤처져 있으면 직원이 시트만 보고 신청을 놓칠 수 있으니 알린다.
      sheetPending: sheets.pendingCount(),
    }));
  if (result.skipped) {
    setSetting('digest_last_sent', today);
    console.log('[digest] staff_notify_email not set — skipped');
    return { sent: false, skipped: 'no_address' };
  }
  if (mailer.smtpConfigured && !result.sent) {
    // Real delivery was attempted and failed — leave the day unmarked so the
    // next hourly tick retries. (Without SMTP the outbox row IS the delivery.)
    console.error(`[digest] send failed (${result.error}) — will retry next hour`);
    return { sent: false, skipped: 'send_failed' };
  }
  setSetting('digest_last_sent', today);
  console.log(`[digest] sent (${pending.length} pending, ${releaseQueue.length} releases)`);
  return { sent: true, skipped: null };
}

function start() {
  const safeReminders = () => sendReminders().catch(err => console.error('[reminder] failed', err));
  const safeExpire = () => expireWaitlist().catch(err => console.error('[waitlist] expire failed', err));
  const safeDigest = () => sendDailyDigest().catch(err => console.error('[digest] failed', err));
  // 시트 미러는 실패해도 예약에 영향이 없으므로 조용히 재시도만 한다.
  // 삭제(보존기한 만료)를 먼저 흘려보내야 파기된 개인정보가 시트에 남지 않는다.
  const safeSheets = () => sheets.flushDeletes()
    .then(() => sheets.syncPending())
    .catch(err => console.error('[sheets] sync failed', err));
  purgeOldData(); // once at boot
  safeReminders(); // once at boot
  safeExpire(); // once at boot — before the digest so expired rows never show up in it
  safeDigest(); // once at boot
  safeSheets(); // once at boot — backfills the sheet when it is newly connected
  setInterval(purgeOldData, 12 * 60 * 60 * 1000).unref(); // then twice a day
  setInterval(safeReminders, 60 * 60 * 1000).unref(); // then hourly
  setInterval(safeExpire, 60 * 60 * 1000).unref(); // then hourly
  setInterval(safeDigest, 60 * 60 * 1000).unref(); // then hourly
  setInterval(safeSheets, 10 * 60 * 1000).unref(); // 시트는 더 자주 — 직원이 보는 화면이라 지연이 눈에 띈다
}

module.exports = { purgeOldData, sendReminders, expireWaitlist, sendDailyDigest, start };
