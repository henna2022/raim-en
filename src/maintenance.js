'use strict';
const { db, getSettings } = require('./db');
const { todayStr, addDays } = require('./helpers');

// Personal-data retention: reservations (and the emails that quote them) are kept
// for `retention_days` after the visit date, then deleted. This is what makes the
// privacy note on the public site true — do not remove.
function purgeOldData() {
  const days = Math.max(1, Number(getSettings().retention_days || 90));
  const cutoffDate = addDays(todayStr(), -days);
  const reservations = db.prepare('DELETE FROM reservations WHERE visit_date < ?').run(cutoffDate);
  const emails = db.prepare(`DELETE FROM email_log WHERE created_at < datetime('now', ?)`).run(`-${days} days`);
  if (reservations.changes || emails.changes) {
    console.log(`[retention] purged ${reservations.changes} reservations, ${emails.changes} emails (older than ${days} days)`);
  }
  return { reservations: reservations.changes, emails: emails.changes };
}

function start() {
  purgeOldData(); // once at boot
  setInterval(purgeOldData, 12 * 60 * 60 * 1000).unref(); // then twice a day
}

module.exports = { purgeOldData, start };
