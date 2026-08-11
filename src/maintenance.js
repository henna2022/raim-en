'use strict';
const { db, getSettings, setSetting } = require('./db');
const { todayStr, addDays, nowHM, SLA_HOURS } = require('./helpers');
const mailer = require('./mailer');

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
  const rows = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.status = 'waitlisted' AND r.visit_date < ?`).all(today);
  const update = db.prepare(`
    UPDATE reservations SET status='declined', decline_reason=?, decided_at=datetime('now'), decided_by='system'
    WHERE id=? AND status='waitlisted'`);
  const REASON = 'No seats freed up before your visit date.';
  let expired = 0;
  for (const r of rows) {
    if (update.run(REASON, r.id).changes !== 1) continue;
    expired += 1;
    await mailer.sendMail(r.email, `[Seoul RAIM] About your request — ${r.code}`,
      mailer.declinedEmail({ ...r, decline_reason: REASON }));
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

  const pending = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language,
           CAST((julianday('now') - julianday(r.created_at)) * 24 AS INTEGER) AS age_hours
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.status = 'pending'
    ORDER BY r.visit_date, s.start_time, r.created_at`).all();
  const releaseQueue = db.prepare(`
    SELECT r.*, s.start_time, s.end_time,
           (SELECT COUNT(*) FROM reservations w
             WHERE w.status = 'waitlisted' AND w.visit_date = r.visit_date AND w.slot_id = r.slot_id) AS waitlist_count
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.release_needed = 1 ORDER BY r.decided_at`).all();
  const todaysCount = db.prepare(`
    SELECT COUNT(*) AS c FROM reservations
    WHERE visit_date = ? AND status IN ('confirmed','attended')`).get(today).c;
  const waitlist = db.prepare(`
    SELECT r.*, s.tour_type, s.start_time, s.end_time, s.language
    FROM reservations r JOIN slots s ON s.id = r.slot_id
    WHERE r.status = 'waitlisted' AND r.visit_date >= ?
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
    mailer.digestEmail({ pending, releaseQueue, todaysCount, waitlist, slaHours: SLA_HOURS }));
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
  purgeOldData(); // once at boot
  safeReminders(); // once at boot
  safeExpire(); // once at boot — before the digest so expired rows never show up in it
  safeDigest(); // once at boot
  setInterval(purgeOldData, 12 * 60 * 60 * 1000).unref(); // then twice a day
  setInterval(safeReminders, 60 * 60 * 1000).unref(); // then hourly
  setInterval(safeExpire, 60 * 60 * 1000).unref(); // then hourly
  setInterval(safeDigest, 60 * 60 * 1000).unref(); // then hourly
}

module.exports = { purgeOldData, sendReminders, expireWaitlist, sendDailyDigest, start };
