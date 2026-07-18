'use strict';
const { db, getSettings } = require('./db');
const { todayStr, addDays } = require('./helpers');
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
  if (reservations.changes || noshows.changes || emails.changes) {
    console.log(`[retention] purged ${reservations.changes} reservations, ${noshows.changes} no-shows, ${emails.changes} emails (older than ${days} days)`);
  }
  return { reservations: reservations.changes, noshows: noshows.changes, emails: emails.changes };
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

function start() {
  const safeReminders = () => sendReminders().catch(err => console.error('[reminder] failed', err));
  purgeOldData(); // once at boot
  safeReminders(); // once at boot
  setInterval(purgeOldData, 12 * 60 * 60 * 1000).unref(); // then twice a day
  setInterval(safeReminders, 60 * 60 * 1000).unref(); // then hourly
}

module.exports = { purgeOldData, sendReminders, start };
