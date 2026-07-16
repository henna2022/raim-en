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

app.use(express.urlencoded({ extended: false }));
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

app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('notfound'));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).send('Internal server error');
});

module.exports = app;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Seoul RAIM (EN) running at http://localhost:${PORT}`);
    console.log(`Admin: http://localhost:${PORT}/admin (initial account: admin / raim2026!)`);
  });
}
