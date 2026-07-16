'use strict';
const crypto = require('node:crypto');

const COOKIE_NAME = 'raim.csrf';
const MAX_AGE_MS = 8 * 60 * 60 * 1000;

// Hand-rolled parser for the Cookie request header — no cookie-parser dependency.
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (key === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return null;
}

const FORBIDDEN_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Form expired</title></head>
<body>
<p>Your form session expired. Please go back and try again.</p>
</body></html>`;

// Double-submit cookie CSRF guard: every request gets/keeps a random token in an
// httpOnly cookie; every POST must echo that same token back in the request body.
function csrfMiddleware(req, res, next) {
  let token = readCookie(req, COOKIE_NAME);
  if (!token) {
    token = crypto.randomBytes(24).toString('hex');
    res.cookie(COOKIE_NAME, token, { httpOnly: true, sameSite: 'lax', maxAge: MAX_AGE_MS });
  }
  res.locals.csrf = token;

  if (req.method === 'POST') {
    const submitted = String((req.body && req.body._csrf) || '');
    const cookieBuf = Buffer.from(token);
    const submittedBuf = Buffer.from(submitted);
    const valid = cookieBuf.length === submittedBuf.length
      && crypto.timingSafeEqual(cookieBuf, submittedBuf);
    if (!valid) {
      return res.status(403).type('html').send(FORBIDDEN_HTML);
    }
  }
  next();
}

module.exports = { csrfMiddleware };
