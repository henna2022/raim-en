'use strict';

// Fixed-window rate limiter — no npm dependency, in-memory Map keyed by keyFn(req).
function rateLimit({ windowMs, max, keyFn, onLimit }) {
  const store = new Map(); // key -> { count, resetAt }
  const getKey = keyFn || ((req) => req.ip);

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.resetAt <= now) store.delete(key);
    }
  }, 10 * 60 * 1000);
  cleanup.unref();

  return function rateLimitMiddleware(req, res, next) {
    const key = getKey(req);
    const now = Date.now();
    let entry = store.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      return onLimit(req, res);
    }
    next();
  };
}

module.exports = { rateLimit };
