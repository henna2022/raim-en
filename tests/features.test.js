'use strict';
// Batch A feature tests (docs/A-batch-features.md, section A6). Case list is
// fixed by the instruction doc: F1-F7 below, plus F8 which is "run the whole
// `npm test` suite and see 0 failures" — that's a meta-check over this whole
// file plus the pre-existing 49, not something that can be a nested test here,
// so it is satisfied by the [완료 기준] #1 evidence instead of a `test()` block.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, withDb, newJar,
  get, postAdminForm, makeReservation, adminLogin,
  todayStrKST, addDays, uniqueEmail,
} = require('./helper');

let ctx;
let maintenance;

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, ctx.jar, {});
  assert.equal(loginRes.status, 302, 'admin login must succeed before feature tests run');
  // Require maintenance.js AFTER startApp() has set DATA_DIR and refreshed the
  // src/ module cache, so this require resolves to the SAME cached module (and
  // therefore the same src/db.js singleton connection) the running app uses —
  // per the A6 note in docs/A-batch-features.md.
  maintenance = require('../src/maintenance');
});
test.after(async () => {
  await stopApp(ctx.server);
});

// Inserts a reservation row directly (bypassing the public booking flow /
// closures / booking-window rules) so fixtures can target exact visit_date +
// status combinations, per A6's "no_show 1건(관리자 전이로 생성)" vs the F1-F4
// fixtures which just need rows to exist in a given state.
function insertReservation(overrides = {}) {
  return withDb(ctx.dataDir, (db) => {
    const slotId = overrides.slot_id != null
      ? overrides.slot_id
      : db.prepare('SELECT id FROM slots WHERE active = 1 LIMIT 1').get().id;
    const code = 'TEST' + Math.random().toString(36).slice(2, 9).toUpperCase();
    db.prepare(`INSERT INTO reservations
        (code, slot_id, visit_date, name, email, country, party_size, notes, status, reminder_sent)
        VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(
        code, slotId, overrides.visit_date, overrides.name || 'Test Visitor',
        overrides.email || uniqueEmail(), overrides.country || '',
        overrides.party_size != null ? overrides.party_size : 2, overrides.notes || '',
        overrides.status || 'pending', overrides.reminder_sent != null ? overrides.reminder_sent : 0
      );
    return db.prepare('SELECT * FROM reservations WHERE code = ?').get(code);
  });
}

function emailLogCount(subjectSubstring) {
  return withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT COUNT(*) AS c FROM email_log WHERE subject LIKE ?').get(`%${subjectSubstring}%`).c
  );
}

test('F1: sendReminders() emails a confirmed reservation visiting tomorrow, once', async () => {
  const tomorrow = addDays(todayStrKST(), 1);
  const r = insertReservation({ visit_date: tomorrow, status: 'confirmed' });

  const sentCount = await maintenance.sendReminders();
  assert.equal(sentCount, 1);
  assert.equal(emailLogCount('Reminder'), 1, 'expected exactly one Reminder email logged');

  const updated = withDb(ctx.dataDir, (db) =>
    db.prepare('SELECT reminder_sent FROM reservations WHERE id = ?').get(r.id));
  assert.equal(updated.reminder_sent, 1);
});

test('F2: calling sendReminders() again immediately does not re-send', async () => {
  const sentCount = await maintenance.sendReminders();
  assert.equal(sentCount, 0);
  assert.equal(emailLogCount('Reminder'), 1, 'Reminder email count must stay the same (no duplicate send)');
});

test('F3: sendReminders() ignores pending (tomorrow) and confirmed (day after tomorrow)', async () => {
  const tomorrow = addDays(todayStrKST(), 1);
  const dayAfter = addDays(todayStrKST(), 2);
  insertReservation({ visit_date: tomorrow, status: 'pending' });
  insertReservation({ visit_date: dayAfter, status: 'confirmed' });

  const sentCount = await maintenance.sendReminders();
  assert.equal(sentCount, 0);
});

test('F4: purgeOldData() keeps no-shows past general retention but purges them past noshow retention', async () => {
  const settingsRes = await postAdminForm(ctx.baseUrl, ctx.jar, '/admin/settings', {
    retention_days: '90', noshow_retention_days: '365',
  });
  assert.equal(settingsRes.status, 302);

  const today = todayStrKST();
  const attended = insertReservation({ visit_date: addDays(today, -100), status: 'attended' });
  const noshow100 = insertReservation({ visit_date: addDays(today, -100), status: 'no_show' });
  const noshow400 = insertReservation({ visit_date: addDays(today, -400), status: 'no_show' });

  maintenance.purgeOldData();

  withDb(ctx.dataDir, (db) => {
    assert.equal(db.prepare('SELECT id FROM reservations WHERE id = ?').get(attended.id), undefined,
      'attended reservation 100 days past visit_date should be purged');
    assert.ok(db.prepare('SELECT id FROM reservations WHERE id = ?').get(noshow100.id),
      'no_show reservation 100 days past visit_date should be kept (under noshow_retention_days)');
    assert.equal(db.prepare('SELECT id FROM reservations WHERE id = ?').get(noshow400.id), undefined,
      'no_show reservation 400 days past visit_date should be purged (over noshow_retention_days)');
  });
});

test('F5: editing the EN permanent slot start_time updates the public homepage copy', async () => {
  const slot = withDb(ctx.dataDir, (db) => db.prepare(
    `SELECT * FROM slots WHERE language = 'en' AND tour_type = 'permanent'`
  ).get());
  assert.ok(slot, 'expected the seeded EN permanent slot to exist');

  const before = await (await get(ctx.baseUrl, null, '/')).text();
  assert.match(before, /15:40/, 'expected the original 15:40 EN permanent time on the homepage');

  const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/schedule/slots/${slot.id}`, {
    label: slot.label, tour_type: slot.tour_type, start_time: '15:50', end_time: slot.end_time,
    language: slot.language, weekdays: slot.weekdays.split(','), active: 'on',
  });
  assert.equal(res.status, 302);

  const after = await (await get(ctx.baseUrl, null, '/')).text();
  assert.match(after, /15:50/, 'expected the updated 15:50 EN permanent time on the homepage');
  // A5 explicitly says the notices seed content is staff-managed and must be
  // left untouched — its default text ("...Permanent Exhibition at 15:40...")
  // legitimately still contains 15:40. Excluding that one <section> is what
  // makes "본문에 15:40 미포함" consistent with A5's own carve-out, rather than
  // a self-contradictory spec — see the judgment note in the final report.
  const afterMinusNotices = after.replace(/<section id="notices">[\s\S]*?<\/section>/, '');
  assert.doesNotMatch(afterMinusNotices, /15:40/,
    'stale 15:40 must no longer appear anywhere on the homepage outside the untouched notices section');
});

test('F6: deactivating both EN slots drops the chip and shows the "not scheduled" copy', async () => {
  const enSlots = withDb(ctx.dataDir, (db) => db.prepare(`SELECT * FROM slots WHERE language = 'en'`).all());
  assert.equal(enSlots.length, 2, 'expected exactly 2 seeded EN slots');

  for (const slot of enSlots) {
    const res = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/schedule/slots/${slot.id}`, {
      label: slot.label, tour_type: slot.tour_type, start_time: slot.start_time, end_time: slot.end_time,
      language: slot.language, weekdays: slot.weekdays.split(','),
      // active intentionally omitted -> unchecked checkbox -> active = 0
    });
    assert.equal(res.status, 302);
  }

  const body = await (await get(ctx.baseUrl, null, '/')).text();
  assert.doesNotMatch(body, /English tours every/, 'chip must not render once no EN slot is active');
  assert.match(body, /not currently scheduled/, 'expected the "not currently scheduled" fallback copy');
});

test('F7: a visitor with a prior no_show shows a "No-shows: 1" badge on the dashboard', async () => {
  const email = uniqueEmail();
  const first = await makeReservation(ctx.baseUrl, ctx.jar, { email });
  assert.equal(first.res.status, 302);

  const row = withDb(ctx.dataDir, (db) => db.prepare('SELECT id FROM reservations WHERE code = ?').get(first.code));
  assert.ok(row, 'expected the first reservation to exist');

  const confirmRes = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${row.id}/confirm`, { yeyak_blocked: 'on' });
  assert.equal(confirmRes.status, 302);
  const noshowRes = await postAdminForm(ctx.baseUrl, ctx.jar, `/admin/reservations/${row.id}/no_show`, {});
  assert.equal(noshowRes.status, 302);

  // Same email, same session — allowed now that the first booking is no_show
  // (dup-check and the 3-upcoming-reservations cap both only look at pending/confirmed).
  const second = await makeReservation(ctx.baseUrl, ctx.jar, { email, date: first.date, slot_id: first.slot_id });
  assert.equal(second.res.status, 302);

  const dashboardHtml = await (await get(ctx.baseUrl, ctx.jar, '/admin')).text();
  assert.match(dashboardHtml, /No-shows: 1/);
});
