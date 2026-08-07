// Longterm/data/test-oura-pull.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// oura-pull.mjs's own logic with an injected fetch, never the real API:
// the three window shapes (heartrate uniquely takes start_datetime/end_datetime),
// singleton vs collection response unwrapping, per-endpoint error containment,
// and that --dry-run genuinely writes nothing. Run with:
//   node Longterm/data/test-oura-pull.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { windowQuery, windowChunks, recordsFrom, pullOwner, loadOwnerIdsFromGoals } from '../scripts/oura-pull.mjs';
import { loadStore, OURA_ENDPOINTS } from '../scripts/oura-store.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-oura-pull.mjs');

const NOW = new Date('2026-03-01T12:00:00Z');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oura-pull-test-'));

test('a dated endpoint gets start_date/end_date spanning exactly `days` days', () => {
  const q = windowQuery({ key: 'daily_sleep', window: 'date' }, 30, NOW);
  assert.deepEqual(q, { start_date: '2026-01-31', end_date: '2026-03-01' });
});

test('a 1-day window is the single current day, not an empty range', () => {
  const q = windowQuery({ key: 'daily_sleep', window: 'date' }, 1, NOW);
  assert.equal(q.start_date, '2026-03-01');
  assert.equal(q.end_date, '2026-03-01');
});

test('heartrate uses start_datetime/end_datetime — it rejects start_date', () => {
  const q = windowQuery({ key: 'heartrate', window: 'datetime' }, 30, NOW);
  assert.equal(q.start_datetime, '2026-01-31T00:00:00+00:00');
  assert.equal(q.end_datetime, '2026-03-01T23:59:59+00:00');
  assert.equal(q.start_date, undefined, 'sending start_date to heartrate is an API error');
});

test('a singleton endpoint gets no window parameters at all', () => {
  assert.deepEqual(windowQuery({ key: 'personal_info', window: 'none' }, 30, NOW), {});
});

test('an endpoint with no server-side cap is a single request', () => {
  const chunks = windowChunks({ key: 'daily_sleep', window: 'date' }, 730, NOW);
  assert.equal(chunks.length, 1);
  const spanDays = (new Date(chunks[0].end_date) - new Date(chunks[0].start_date)) / 86400000;
  assert.equal(spanDays, 729, 'a 730-day inclusive window spans 729 days end-to-end');
});

test('heartrate splits a long backfill into <=30-day chunks', () => {
  // Oura returns HTTP 400 for any heartrate range over 30 days. Before
  // chunking, a --backfill-days 730 run silently pulled zero heart-rate
  // records while every other endpoint reported success.
  const endpoint = { key: 'heartrate', window: 'datetime', maxWindowDays: 30 };
  const chunks = windowChunks(endpoint, 730, NOW);
  assert.equal(chunks.length, Math.ceil(730 / 30));
  for (const c of chunks) {
    const spanDays = (new Date(c.end_datetime) - new Date(c.start_datetime)) / 86400000;
    assert.ok(spanDays <= 30, `chunk spans ${spanDays} days — Oura rejects anything over 30`);
  }
});

test('heartrate chunks tile the window contiguously back from today', () => {
  const endpoint = { key: 'heartrate', window: 'datetime', maxWindowDays: 30 };
  const chunks = windowChunks(endpoint, 90, NOW);
  assert.equal(chunks[0].end_datetime.slice(0, 10), '2026-03-01', 'newest chunk ends today');
  // Each chunk starts the day after the next-older chunk ends — no gaps.
  for (let i = 0; i < chunks.length - 1; i += 1) {
    const olderEnd = new Date(chunks[i + 1].end_datetime.slice(0, 10));
    const newerStart = new Date(chunks[i].start_datetime.slice(0, 10));
    const gapDays = (newerStart - olderEnd) / 86400000;
    assert.equal(gapDays, 1, `gap of ${gapDays} days between chunks would drop records`);
  }
  assert.equal(chunks[chunks.length - 1].start_datetime.slice(0, 10), '2025-12-02', 'oldest chunk reaches the full 90 days back');
});

test('a window at exactly the cap stays a single request', () => {
  const endpoint = { key: 'heartrate', window: 'datetime', maxWindowDays: 30 };
  assert.equal(windowChunks(endpoint, 30, NOW).length, 1);
});

test('a collection response unwraps its data array', () => {
  assert.equal(recordsFrom({ data: [{ id: 'a' }, { id: 'b' }] }).length, 2);
});

test('a singleton response becomes a single record', () => {
  const records = recordsFrom({ id: 'x', age: 38 });
  assert.equal(records.length, 1);
  assert.equal(records[0].age, 38);
});

test('an empty collection is zero records, not a failure', () => {
  assert.deepEqual(recordsFrom({ data: [] }), []);
  assert.deepEqual(recordsFrom(null), []);
});

await asyncTest('a pull upserts every endpoint that returned records', async () => {
  const dir = tmpDir();
  const fakeGet = async (key) => (key === 'daily_sleep'
    ? { data: [{ id: 's1', day: '2026-03-01', score: 80 }] }
    : { data: [] });
  const result = await pullOwner('alex', { storeDir: dir, ouraGetFn: fakeGet, now: NOW });

  assert.equal(result.endpoints.daily_sleep.count, 1);
  assert.equal(result.endpoints.daily_sleep.upserted, 1);
  assert.equal(loadStore('daily_sleep', dir).meta.recordCount, 1);
});

await asyncTest('an endpoint with no data is recorded as empty, never as an error', async () => {
  // A newly set-up ring returns nothing for daily_activity/sleep/heartrate for
  // days. That must read as "no data yet", not as a broken pull.
  const dir = tmpDir();
  const result = await pullOwner('alex', { storeDir: dir, ouraGetFn: async () => ({ data: [] }), now: NOW });
  for (const endpoint of OURA_ENDPOINTS) {
    assert.equal(result.endpoints[endpoint.key].error, null, `${endpoint.key} should not be an error`);
    assert.equal(result.endpoints[endpoint.key].count, 0);
  }
});

await asyncTest('one failing endpoint does not abort the others', async () => {
  const dir = tmpDir();
  const fakeGet = async (key) => {
    if (key === 'daily_readiness') throw new Error('403 scope missing');
    return { data: [{ id: `${key}-1`, day: '2026-03-01', score: 80 }] };
  };
  const result = await pullOwner('alex', { storeDir: dir, ouraGetFn: fakeGet, now: NOW });

  assert.match(result.endpoints.daily_readiness.error, /403/);
  assert.equal(result.endpoints.daily_sleep.error, null, 'a sibling endpoint must still succeed');
  assert.equal(loadStore('daily_sleep', dir).meta.recordCount, 1);
  assert.equal(loadStore('daily_readiness', dir).meta.recordCount, 0);
});

await asyncTest('dry-run reports what it found but writes nothing', async () => {
  const dir = tmpDir();
  const fakeGet = async () => ({ data: [{ id: 's1', day: '2026-03-01', score: 80 }] });
  const result = await pullOwner('alex', { storeDir: dir, ouraGetFn: fakeGet, now: NOW, dryRun: true });

  assert.equal(result.endpoints.daily_sleep.count, 1, 'it still reports what it saw');
  assert.equal(result.endpoints.daily_sleep.upserted, 0);
  assert.equal(fs.existsSync(path.join(dir, 'daily_sleep.json')), false, 'dry-run must not create store files');
});

await asyncTest('a re-pull of a re-scored day corrects it in place', async () => {
  // The reason upsert is the right shape here: Oura revises a day's scores as
  // more data lands, so the same record id legitimately returns new numbers.
  const dir = tmpDir();
  const scored = (score) => async (key) => (key === 'daily_sleep'
    ? { data: [{ id: 's1', day: '2026-03-01', score }] }
    : { data: [] });

  await pullOwner('alex', { storeDir: dir, ouraGetFn: scored(70), now: NOW });
  await pullOwner('alex', { storeDir: dir, ouraGetFn: scored(76), now: NOW });

  const store = loadStore('daily_sleep', dir);
  assert.equal(store.meta.recordCount, 1, 'a revision must not create a second row');
  assert.equal(store.byId['alex:daily_sleep:s1'].data.score, 76);
});

await asyncTest('two owners accumulate side by side in the same endpoint file', async () => {
  const dir = tmpDir();
  const fakeGet = async (key) => (key === 'daily_sleep'
    ? { data: [{ id: 'shared-day', day: '2026-03-01', score: 80 }] }
    : { data: [] });

  await pullOwner('alex', { storeDir: dir, ouraGetFn: fakeGet, now: NOW });
  await pullOwner('sam', { storeDir: dir, ouraGetFn: fakeGet, now: NOW });

  const store = loadStore('daily_sleep', dir);
  assert.equal(store.meta.recordCount, 2, 'owner id is part of the key, so they cannot collide');
  assert.ok(store.byId['alex:daily_sleep:shared-day']);
  assert.ok(store.byId['sam:daily_sleep:shared-day']);
});

// loadOwnerIdsFromGoals's goalsPath parameter (2026-08-07): a caller with its
// own --goals-path (the recap, doing a live pull right before composing)
// must discover owners from THAT file, not silently fall back to this
// script's own repo-relative default — otherwise a caller elsewhere in the
// codebase pointed at a different goals.json would pull for the wrong
// household entirely.
test('loadOwnerIdsFromGoals reads the explicitly given path, not the repo default', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oura-goals-path-test-'));
  const goalsPath = path.join(dir, 'goals.json');
  fs.writeFileSync(goalsPath, JSON.stringify({ owners: [{ id: 'alex' }, { id: 'sam' }] }));
  assert.deepEqual(loadOwnerIdsFromGoals(goalsPath), ['alex', 'sam']);
});

test('loadOwnerIdsFromGoals degrades to empty for a missing explicit path, rather than falling back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oura-goals-path-missing-'));
  assert.deepEqual(loadOwnerIdsFromGoals(path.join(dir, 'nonexistent-goals.json')), []);
});

console.log('All oura-pull tests passed.');
