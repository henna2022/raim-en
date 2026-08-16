'use strict';
// Waitlist: staff waitlisting, visitor view/cancel, promotion, release-queue hints.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, withDb, newJar,
  get, postForm, postAdminForm, makeReservation, adminLogin, uniqueEmail, todayStrKST, addDays,
} = require('./helper');

let ctx;
let res1, res2; // same session: res1 gets waitlisted, res2 confirmed-then-cancelled

function row(code) {
  return withDb(ctx.dataDir, (db) => db.prepare('SELECT * FROM reservations WHERE code = ?').get(code));
}
function emailsFor(toAddr, subjectSubstring) {
  return withDb(ctx.dataDir, (db) => db.prepare(
    'SELECT subject, html FROM email_log WHERE to_addr = ? AND subject LIKE ?'
  ).all(toAddr, `%${subjectSubstring}%`));
}
function insertDirect({ code, status, email, slotId, visitDate }) {
  withDb(ctx.dataDir, (db) => {
    db.prepare(`INSERT INTO reservations
        (code, slot_id, visit_date, name, email, country, party_size, notes, status)
        VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(code, slotId, visitDate, 'Direct Fixture', email, '', 2, '', status);
  });
}

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, ctx.jar, {});
  assert.equal(loginRes.status, 302, 'admin login must succeed before waitlist tests run');
  res1 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  res2 = await makeReservation(ctx.baseUrl, ctx.jar, { email: uniqueEmail() });
  assert.equal(res1.slot_id, res2.slot_id, 'fixture needs one shared session');
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('W1: waitlist action (no soldout mark) -> waitlisted + visitor emailed', async () => {
  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${row(res1.code).id}/waitlist`, {});
  assert.equal(res.status, 302);
  assert.equal(row(res1.code).status, 'waitlisted');
  assert.equal(emailsFor(res1.email, "You're on the waitlist").length, 1);
  const mark = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT 1 FROM soldout WHERE date = ? AND slot_id = ?').get(res1.date, res1.slot_id));
  assert.equal(mark, undefined, 'no soldout mark without the checkbox');
});

test('W2: waitlisted blocks duplicate requests; My Booking shows waitlist state', async () => {
  const dup = await postForm(ctx.baseUrl, ctx.jar, '/reserve', {
    date: res1.date, slot_id: String(res1.slot_id), name: 'Dup Try', email: res1.email,
    country: 'Japan', party_size: '2', agree: 'on',
  }, { csrfPage: '/reserve' });
  assert.equal(dup.status, 400);
  assert.match(await dup.text(), /already have a request for this session/);

  const page = await (await get(ctx.baseUrl, ctx.jar,
    `/booking?code=${res1.code}&email=${encodeURIComponent(res1.email)}`)).text();
  assert.match(page, /Status: Waitlisted/);
  assert.match(page, /session is currently full/);
  assert.match(page, /Leave the waitlist/);
});

test('W3: dashboard shows the waitlist panel with FIFO position', async () => {
  const html = await (await get(ctx.baseUrl, ctx.jar, '/admin')).text();
  assert.match(html, /대기자 — 좌석이 나면 승격/);
  assert.match(html, new RegExp(res1.code));
  // Anchor to the position CELL — the panel caption contains a literal "(#1 first)"
  // that would satisfy a bare /#1/ even if the pos computation broke.
  assert.match(html, /<td class="muted">#1<\/td>/);
});

test('W4: cancelling a confirmed booking surfaces waitlist candidates for its seats', async () => {
  const id2 = row(res2.code).id;
  const confirm = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id2}/confirm`, { yeyak_blocked: 'on' });
  assert.equal(confirm.status, 302);

  const cancel = await postForm(ctx.baseUrl, ctx.jar, '/booking/cancel', {
    code: res2.code, email: res2.email,
  }, { csrfPage: '/reserve' });
  assert.equal(cancel.status, 302);
  assert.equal(row(res2.code).release_needed, 1);

  const staffMail = withDb(ctx.dataDir, (db) => db.prepare(
    `SELECT html FROM email_log WHERE subject LIKE '%예약 해제 필요%' ORDER BY id DESC LIMIT 1`).get());
  assert.match(staffMail.html, /대기자 1명/);
  assert.match(staffMail.html, /승격/);

  const dash = await (await get(ctx.baseUrl, ctx.jar, '/admin')).text();
  assert.match(dash, /대기자 1명/);
});

test('W5: promotion — confirm from waitlisted (yeyak attestation required)', async () => {
  const id1 = row(res1.code).id;
  const noCheckbox = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id1}/confirm`, {});
  assert.equal(noCheckbox.status, 400);
  assert.equal(row(res1.code).status, 'waitlisted');

  const promote = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${id1}/confirm`, { yeyak_blocked: 'on' });
  assert.equal(promote.status, 302);
  assert.equal(row(res1.code).status, 'confirmed');
  assert.equal(emailsFor(res1.email, 'Reservation confirmed').length, 1);
});

test('W6: visitor leaves the waitlist -> cancelled without a yeyak release flag', async () => {
  const email = uniqueEmail();
  insertDirect({
    code: 'RAIM-WLDIR1', status: 'waitlisted', email,
    slotId: res1.slot_id, visitDate: res1.date,
  });
  const cancel = await postForm(ctx.baseUrl, ctx.jar, '/booking/cancel', {
    code: 'RAIM-WLDIR1', email,
  }, { csrfPage: '/reserve' });
  assert.equal(cancel.status, 302);
  const r = row('RAIM-WLDIR1');
  assert.equal(r.status, 'cancelled');
  assert.equal(r.release_needed, 0, 'waitlisted rows have no blocked seats to release');
});

test('W8: past-date waitlisted rows are auto-declined with an email', async () => {
  // Same module instance as the running app (require cache) — see features.test.js.
  const maintenance = require('../src/maintenance');
  const email = uniqueEmail();
  insertDirect({
    code: 'RAIM-WLPAST', status: 'waitlisted', email,
    slotId: res1.slot_id, visitDate: addDays(todayStrKST(), -1),
  });
  const expired = await maintenance.expireWaitlist();
  assert.ok(expired >= 1);
  const r = row('RAIM-WLPAST');
  assert.equal(r.status, 'declined');
  assert.equal(r.decided_by, 'system');
  assert.match(r.decline_reason, /No seats freed up/);
  assert.equal(emailsFor(email, 'About your request').length, 1);
  // Future-dated waitlisted rows must be untouched (none left here, but the
  // sweep must not have declined pending/confirmed rows either).
  assert.equal(row(res1.code).status, 'confirmed');
});

test('W7: waitlist with mark_soldout=on also marks the session fully booked', async () => {
  const email = uniqueEmail();
  const futureDate = addDays(res1.date, 7); // same weekday, next week
  insertDirect({
    code: 'RAIM-WLDIR2', status: 'pending', email,
    slotId: res1.slot_id, visitDate: futureDate,
  });
  const res = await postAdminForm(ctx.baseUrl, ctx.jar,
    `/admin/reservations/${row('RAIM-WLDIR2').id}/waitlist`, { mark_soldout: 'on' });
  assert.equal(res.status, 302);
  assert.equal(row('RAIM-WLDIR2').status, 'waitlisted');
  const mark = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT 1 FROM soldout WHERE date = ? AND slot_id = ?').get(futureDate, res1.slot_id));
  assert.ok(mark, 'soldout mark must be created from the waitlist form checkbox');
});
