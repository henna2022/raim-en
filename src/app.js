'use strict';
const path = require('node:path');
const express = require('express');
const session = require('express-session');

require('./db'); // initialize schema + seed
require('./maintenance').start(); // personal-data retention purge

const app = express();
const PORT = Number(process.env.PORT || 4310);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.disable('x-powered-by');

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(session({
  name: 'raim.sid',
  secret: process.env.SESSION_SECRET || 'dev-only-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000 },
}));

app.use('/', require('./routes/public'));
app.use('/admin', require('./routes/admin'));

app.use((req, res) => res.status(404).render('notfound'));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error(err);
  res.status(500).send('Internal server error');
});

app.listen(PORT, () => {
  console.log(`Seoul RAIM (EN) running at http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin (initial account: admin / raim2026!)`);
});
