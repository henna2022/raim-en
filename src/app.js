'use strict';
const path = require('node:path');
const express = require('express');
const session = require('express-session');
const { csrfMiddleware } = require('./csrf');
const SqliteStore = require('./session-store');

require('./db'); // initialize schema + seed
require('./maintenance').start(); // personal-data retention purge

// Refuse to boot in production without a real session secret — the fallback
// below is public (checked into git) and would let anyone forge session cookies.
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET must be set in production.');
  process.exit(1);
}
if (process.env.NODE_ENV !== 'production' && !process.env.SESSION_SECRET) {
  console.warn('[session] SESSION_SECRET not set — using the insecure default secret. Set SESSION_SECRET before deploying to production.');
}

const app = express();
const PORT = Number(process.env.PORT || 4310);

// Only trust the reverse proxy's X-Forwarded-For header when explicitly deployed
// behind one — otherwise req.ip would be spoofable by any client.
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

// Security headers (hand-rolled — no helmet dependency). The CSP keeps
// 'unsafe-inline' because the pages use small inline <script>/onclick handlers;
// stored-XSS is already blocked by EJS/email escaping, and this CSP still
// forbids loading scripts, frames or objects from any other origin.
// Referrer-Policy: same-origin matters here — the /booking URL carries the
// reservation code + email, and the page links out to external map sites in
// new tabs, so the referrer must not leak those query params off-origin.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), interest-cohort=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  name: 'raim.sid',
  store: new SqliteStore(),
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 8 * 60 * 60 * 1000,
    // Only mark cookies secure in production. Behind a reverse proxy that
    // terminates TLS, TRUST_PROXY=1 (see `trust proxy` setting above) must
    // also be set, or Express won't see the request as secure and the
    // browser will silently refuse to send the cookie back.
    secure: process.env.NODE_ENV === 'production',
  },
}));
app.use(csrfMiddleware);

// Absolute site origin for OG/canonical tags — social & messaging scrapers
// can't resolve a relative og:image. Prefer an explicit BASE_URL; otherwise
// derive from the request (req.protocol honours the reverse proxy when
// TRUST_PROXY=1 is set).
app.use((req, res, next) => {
  res.locals.siteOrigin = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  // Canonical path only — never the query string (the /booking URL carries the
  // reservation code + email, which must not end up in canonical/og:url tags).
  res.locals.canonicalPath = req.path;
  next();
});

app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('notfound'));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  // Client errors (oversized/malformed body, bad JSON…) carry their own status;
  // only 5xx is a real server fault worth logging as an error.
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).send(status >= 500 ? 'Internal server error' : 'Bad request');
});

module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Seoul RAIM (EN) running at http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin (initial account: admin / raim2026!)`);
  });
}
