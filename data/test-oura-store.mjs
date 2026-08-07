// Longterm/data/test-oura-store.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// oura-store.mjs's upsert/query semantics: merge-by-id without dropping rows
// outside the batch, id synthesis for heartrate + singletons, and revision
// overwrite (Oura re-scores a day as more data lands, so the same record id
// legitimately comes back with different numbers). Run with:
//   node Longterm/data/test-oura-store.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ouraRowId, normalizeRow, upsertOuraRows, queryOura, loadStore, OURA_OVERLAP_DAYS,
} from '../scripts/oura-store.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
console.log('test-oura-store.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oura-store-test-'));
}

test('OURA_OVERLAP_DAYS is 30', () => {
  assert.equal(OURA_OVERLAP_DAYS, 30);
});

test('a normal dated record keys on owner:endpoint:record.id', () => {
  const id = ouraRowId('alex', 'daily_sleep', { id: 'rec-1', day: '2026-01-15' });
  assert.equal(id, 'alex:daily_sleep:rec-1');
});

test('heartrate has no record id, so it keys on its timestamp', () => {
  const id = ouraRowId('alex', 'heartrate', { bpm: 60, timestamp: '2026-01-15T04:05:00+00:00' });
  assert.equal(id, 'alex:heartrate:2026-01-15T04:05:00+00:00');
});

test('a singleton keys on owner:endpoint only — current state, not history', () => {
  assert.equal(ouraRowId('alex', 'personal_info', { id: 'x' }), 'alex:personal_info');
  assert.equal(ouraRowId('alex', 'ring_configuration', { id: 'y' }), 'alex:ring_configuration');
});

test('normalizeRow nests the Oura record under data so no field can shadow ours', () => {
  const row = normalizeRow('alex', 'daily_sleep', { id: 'rec-1', day: '2026-01-15', score: 80, endpoint: 'BOGUS' });
  assert.equal(row.id, 'alex:daily_sleep:rec-1');
  assert.equal(row.ownerId, 'alex');
  assert.equal(row.endpoint, 'daily_sleep');
  assert.equal(row.day, '2026-01-15');
  assert.equal(row.data.score, 80);
  assert.equal(row.data.endpoint, 'BOGUS');
});

test('heartrate rows take their day from the timestamp date part', () => {
  const row = normalizeRow('alex', 'heartrate', { bpm: 61, timestamp: '2026-01-15T04:05:00+00:00' });
  assert.equal(row.day, '2026-01-15');
});

test('upsert keeps rows outside the current batch', () => {
  const dir = tmpDir();
  upsertOuraRows('daily_sleep', [normalizeRow('alex', 'daily_sleep', { id: 'old', day: '2026-01-01', score: 70 })], { storeDir: dir, asOf: '2026-01-01' });
  upsertOuraRows('daily_sleep', [normalizeRow('alex', 'daily_sleep', { id: 'new', day: '2026-02-01', score: 75 })], { storeDir: dir, asOf: '2026-02-01' });
  const store = loadStore('daily_sleep', dir);
  assert.equal(Object.keys(store.byId).length, 2);
  assert.ok(store.byId['alex:daily_sleep:old']);
  assert.ok(store.byId['alex:daily_sleep:new']);
});

test('a revised score overwrites in place rather than duplicating', () => {
  const dir = tmpDir();
  upsertOuraRows('daily_sleep', [normalizeRow('alex', 'daily_sleep', { id: 'r1', day: '2026-01-15', score: 70 })], { storeDir: dir, asOf: '2026-01-15' });
  upsertOuraRows('daily_sleep', [normalizeRow('alex', 'daily_sleep', { id: 'r1', day: '2026-01-15', score: 74 })], { storeDir: dir, asOf: '2026-01-16' });
  const store = loadStore('daily_sleep', dir);
  assert.equal(Object.keys(store.byId).length, 1);
  assert.equal(store.byId['alex:daily_sleep:r1'].data.score, 74);
  assert.equal(store.byId['alex:daily_sleep:r1'].updatedAt, '2026-01-16');
});

test('meta tracks lastUpdated and recordCount', () => {
  const dir = tmpDir();
  upsertOuraRows('daily_sleep', [
    normalizeRow('alex', 'daily_sleep', { id: 'a', day: '2026-01-15', score: 70 }),
    normalizeRow('sam', 'daily_sleep', { id: 'b', day: '2026-01-15', score: 90 }),
  ], { storeDir: dir, asOf: '2026-01-15' });
  const store = loadStore('daily_sleep', dir);
  assert.equal(store.meta.lastUpdated, '2026-01-15');
  assert.equal(store.meta.recordCount, 2);
});

test('query filters by owner and date range, newest first', () => {
  const dir = tmpDir();
  upsertOuraRows('daily_sleep', [
    normalizeRow('alex', 'daily_sleep', { id: 'a1', day: '2026-01-10', score: 70 }),
    normalizeRow('alex', 'daily_sleep', { id: 'a2', day: '2026-01-20', score: 72 }),
    normalizeRow('sam', 'daily_sleep', { id: 's1', day: '2026-01-20', score: 90 }),
  ], { storeDir: dir, asOf: '2026-01-20' });

  const alexAll = queryOura('daily_sleep', { storeDir: dir, ownerId: 'alex' });
  assert.equal(alexAll.length, 2);
  assert.equal(alexAll[0].day, '2026-01-20');

  const ranged = queryOura('daily_sleep', { storeDir: dir, ownerId: 'alex', startDate: '2026-01-15', endDate: '2026-01-25' });
  assert.equal(ranged.length, 1);
  assert.equal(ranged[0].data.score, 72);
});

test('a missing store file reads as empty rather than throwing', () => {
  const dir = tmpDir();
  assert.deepEqual(queryOura('daily_sleep', { storeDir: dir, ownerId: 'alex' }), []);
  assert.equal(loadStore('daily_sleep', dir).meta.recordCount, 0);
});

test('a corrupt store file degrades to empty rather than throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'daily_sleep.json'), '{ not json', 'utf8');
  assert.deepEqual(queryOura('daily_sleep', { storeDir: dir, ownerId: 'alex' }), []);
});

console.log('All oura-store tests passed.');
