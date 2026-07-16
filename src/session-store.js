'use strict';
const session = require('express-session');
const { db } = require('./db');

// Hand-rolled express-session Store backed by the app's own SQLite DB — no
// connect-sqlite3 or similar dependency. Survives process restarts, unlike
// the default MemoryStore, and doesn't leak memory across long-running staff
// sessions.
const DEFAULT_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8h — matches app.js session cookie maxAge

const getStmt = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
const upsertStmt = db.prepare(`
  INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
  ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires
`);
const destroyStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
const touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
const purgeStmt = db.prepare('DELETE FROM sessions WHERE expires < ?');

function expiresFor(sess) {
  if (sess && sess.cookie && sess.cookie.expires) {
    const t = new Date(sess.cookie.expires).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return Date.now() + DEFAULT_MAX_AGE_MS;
}

class SqliteStore extends session.Store {
  get(sid, cb) {
    let row;
    try {
      row = getStmt.get(sid);
    } catch (err) {
      return cb(err);
    }
    if (!row) return cb(null, null);
    if (row.expires < Date.now()) {
      try { destroyStmt.run(sid); } catch { /* best-effort cleanup, ignore */ }
      return cb(null, null);
    }
    let sess;
    try {
      sess = JSON.parse(row.data);
    } catch {
      // Corrupt/unparseable row — treat as "no session" rather than throwing.
      return cb(null, null);
    }
    cb(null, sess);
  }

  set(sid, sess, cb) {
    try {
      upsertStmt.run(sid, JSON.stringify(sess), expiresFor(sess));
    } catch (err) {
      return cb(err);
    }
    cb();
  }

  destroy(sid, cb) {
    try {
      destroyStmt.run(sid);
    } catch (err) {
      return cb(err);
    }
    cb();
  }

  touch(sid, sess, cb) {
    try {
      touchStmt.run(expiresFor(sess), sid);
    } catch (err) {
      return cb(err);
    }
    cb();
  }
}

// Sweep expired sessions periodically instead of on every request.
const cleanup = setInterval(() => {
  try { purgeStmt.run(Date.now()); } catch (err) { console.error('[session-store] cleanup failed', err); }
}, 30 * 60 * 1000);
cleanup.unref();

module.exports = SqliteStore;
