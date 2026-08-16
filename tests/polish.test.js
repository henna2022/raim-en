'use strict';
// Batch B polish tests (docs/B-batch-polish.md, section B8). Case list is
// fixed by the instruction doc: G1-G6 below, plus G7 which is "run the whole
// `npm test` suite and see 0 failures" — that's a meta-check over this whole
// file plus the pre-existing 56, not something that can be a nested test here
// (it would recursively invoke the suite), so — mirroring how F8 was handled
// in tests/features.test.js for Batch A — it is satisfied by the [완료 기준]
// #1 evidence (full `npm test` output) instead of a `test()` block.
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeDataDir, startApp, stopApp, withDb, newJar,
  get, makeReservation, adminLogin, uniqueEmail,
} = require('./helper');

let ctx;
let mailer;

test.before(async () => {
  ctx = await startApp(makeDataDir());
  ctx.jar = newJar();
  const loginRes = await adminLogin(ctx.baseUrl, ctx.jar, {});
  assert.equal(loginRes.status, 302, 'admin login must succeed before polish tests run');
  // Require mailer AFTER startApp() has set DATA_DIR and refreshed the src/
  // module cache, so this resolves to the SAME cached module (and therefore
  // the same src/db.js singleton connection) the running app uses — per the
  // A6 note in docs/A-batch-features.md, reused here for B8.
  mailer = require('../src/mailer');
});
test.after(async () => {
  await stopApp(ctx.server);
});

test('G1: icsForReservation() — visit_date 2026-08-01, 09:40-10:20 KST -> UTC DTSTART/DTEND, UID, CRLF', () => {
  const r = {
    code: 'RAIM-G1TEST',
    visit_date: '2026-08-01',
    start_time: '09:40',
    end_time: '10:20',
    tour_type: 'permanent',
    party_size: 2,
  };
  const ics = mailer.icsForReservation(r);
  assert.match(ics, /DTSTART:20260801T004000Z/);
  assert.match(ics, /DTEND:20260801T012000Z/);
  assert.match(ics, /UID:/);
  assert.match(ics, /\r\n/, 'expected CRLF line endings');
});

test('G2: GET /robots.txt -> 200, contains Disallow: /admin', async () => {
  const res = await get(ctx.baseUrl, null, '/robots.txt');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Disallow: \/admin/);
});

test('G3: GET /favicon.svg -> 200, image/svg+xml', async () => {
  const res = await get(ctx.baseUrl, null, '/favicon.svg');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /image\/svg\+xml/);
});

test('G4: 2 reservations (Alice/Bob) -> GET /admin/reservations?q=alice shows only Alice', async () => {
  await makeReservation(ctx.baseUrl, ctx.jar, { name: 'Alice Anderson', email: uniqueEmail() });
  await makeReservation(ctx.baseUrl, ctx.jar, { name: 'Bob Baker', email: uniqueEmail() });

  const res = await get(ctx.baseUrl, ctx.jar, '/admin/reservations?q=alice');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Alice Anderson/);
  assert.doesNotMatch(body, /Bob Baker/);
});

test('G5: 60 reservations -> GET /admin/reservations?page=2 -> 200, "Page 2 of 2", 10 rows', async () => {
  // Isolated app instance (own tmp DATA_DIR) so the total reservation count is
  // exactly 60 — the shared `ctx` instance already holds the Alice/Bob rows
  // from G4, which would otherwise throw off the "10 rows on page 2" math.
  const g5 = await startApp(makeDataDir());
  try {
    const jar = newJar();
    const loginRes = await adminLogin(g5.baseUrl, jar, {});
    assert.equal(loginRes.status, 302);

    const slotId = withDb(g5.dataDir, (db) => db.prepare('SELECT id FROM slots WHERE active = 1 LIMIT 1').get().id);
    withDb(g5.dataDir, (db) => {
      const ins = db.prepare(`INSERT INTO reservations
          (code, slot_id, visit_date, name, email, country, party_size, notes, status)
          VALUES (?,?,?,?,?,?,?,?,?)`);
      for (let i = 0; i < 60; i++) {
        ins.run(
          `G5CODE${String(i).padStart(3, '0')}`, slotId, '2026-08-05',
          `Bulk Visitor ${i}`, `bulk${i}@example.com`, '', 2, '', 'pending'
        );
      }
    });

    const res = await get(g5.baseUrl, jar, '/admin/reservations?page=2');
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /2 \/ 2 페이지/);
    const rowCount = (body.match(/<td><strong>G5CODE/g) || []).length;
    assert.equal(rowCount, 10);
  } finally {
    await stopApp(g5.server);
  }
});

test('G6: GET / — slider images lazy, hero not lazy, og:title present', async () => {
  const res = await get(ctx.baseUrl, null, '/');
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /loading="lazy"/, 'expected at least one lazy-loaded slider image');
  const heroMatch = body.match(/<img src="\/img\/hero\.jpg"[^>]*>/);
  assert.ok(heroMatch, 'hero image tag not found');
  assert.doesNotMatch(heroMatch[0], /loading="lazy"/, 'hero image must not be lazy-loaded (LCP)');
  assert.match(body, /property="og:title"/);
});
