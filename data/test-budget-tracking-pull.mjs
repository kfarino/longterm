// Longterm/data/test-budget-tracking-pull.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// budget-tracking-pull.mjs's refreshFavoritePlaces(), specifically its
// dedup/identity logic for favorite_places.json's recentDiningActivity log.
// Reproduces a real live bug (2026-08-03): a charge's amount legitimately
// changes between pulls (pending -> posted, e.g. tip added) but was keyed by
// amount, so the same real transaction got recorded twice (found live:
// Locanda Portofino, 2026-07-30, $171.11 then $201.11). Run with:
//   node Longterm/data/test-budget-tracking-pull.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { refreshFavoritePlaces } from '../scripts/budget-tracking-pull.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-tracking-pull-test-'));

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

const JOINT_LABELS = new Set([' More Mastercard (...9054)']);
const RAW_FAVORITES = [
  { name: 'Locanda Portofino' },
  { name: 'Tu Madre' },
];

function writeFixture(dir, recentDiningActivity) {
  fs.mkdirSync(dir, { recursive: true });
  const rawPath = path.join(dir, 'favorite_places_raw.json');
  const outPath = path.join(dir, 'favorite_places.json');
  fs.writeFileSync(rawPath, JSON.stringify(RAW_FAVORITES, null, 2));
  if (recentDiningActivity) {
    fs.writeFileSync(outPath, JSON.stringify({ places: RAW_FAVORITES, recentDiningActivity }, null, 2));
  }
  return { rawPath, outPath };
}

function txn({ id, date, amount, merchant, category = 'Restaurants & Bars', account = ' More Mastercard (...9054)' }) {
  return { id, date, amount, merchant, category, account };
}

console.log('test-budget-tracking-pull.mjs');

test('a transaction whose amount changes between pulls (pending -> posted) updates in place, not a duplicate', () => {
  const dir = path.join(tmpRoot, 'pending-to-posted');
  const { rawPath, outPath } = writeFixture(dir);
  const today = new Date('2026-08-01T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'txn-1', date: '2026-07-30', amount: -171.11, merchant: 'Locanda Portofino' }),
  ], today, JOINT_LABELS);

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'txn-1', date: '2026-07-30', amount: -201.11, merchant: 'Locanda Portofino' }),
  ], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.merchant === 'Locanda Portofino');
  assert.equal(matches.length, 1, 'expected exactly one entry after the amount changed for the same transaction id');
  assert.equal(matches[0].amount, 201.11);
});

test('a transaction whose DATE shifts between pulls (pending auth-date vs. posted settle-date) updates in place, keeping the EARLIER (true spend) date', () => {
  // The same real-world pattern as the pending->posted amount change above,
  // caught live a second time (2026-08-03): Mendocino Farms was recorded
  // pending on 2026-07-30, then posted/settled a day later on 2026-07-31 —
  // same id, same amount, only the date moved. The posted date is a
  // settlement artifact, not a new spend event, so the entry should keep
  // the earlier date (when the spend actually happened), regardless of
  // which order the two observations arrive in.
  const dir = path.join(tmpRoot, 'date-shift');
  const { rawPath, outPath } = writeFixture(dir);
  const today = new Date('2026-08-01T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'txn-2', date: '2026-07-30', amount: -50.93, merchant: 'Mendocino Farms' }),
  ], today, JOINT_LABELS);

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'txn-2', date: '2026-07-31', amount: -50.93, merchant: 'Mendocino Farms' }),
  ], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.merchant === 'Mendocino Farms');
  assert.equal(matches.length, 1, 'expected exactly one entry after the date shifted for the same transaction id');
  assert.equal(matches[0].date, '2026-07-30', 'should keep the earlier (pending/auth) date, not the later posted/settled date');
});

test('the earlier date is kept even if the earlier-dated observation arrives SECOND (pull order should not matter)', () => {
  const dir = path.join(tmpRoot, 'date-shift-reverse-order');
  const { rawPath, outPath } = writeFixture(dir);
  const today = new Date('2026-08-01T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'txn-3', date: '2026-07-31', amount: -50.93, merchant: 'Mendocino Farms' }),
  ], today, JOINT_LABELS);

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'txn-3', date: '2026-07-30', amount: -50.93, merchant: 'Mendocino Farms' }),
  ], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.merchant === 'Mendocino Farms');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].date, '2026-07-30');
});

test('two genuinely separate same-day/same-merchant transactions (different ids) are both kept', () => {
  const dir = path.join(tmpRoot, 'two-real-visits');
  const { rawPath, outPath } = writeFixture(dir);
  const today = new Date('2026-08-01T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'txn-a', date: '2026-07-24', amount: -54.69, merchant: 'Tu Madre' }),
    txn({ id: 'txn-b', date: '2026-07-24', amount: -10.01, merchant: 'Tu Madre' }),
  ], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.merchant === 'Tu Madre');
  assert.equal(matches.length, 2, 'two distinct real transactions should not be collapsed into one');
  assert.deepEqual(matches.map((a) => a.amount).sort(), [10.01, 54.69]);
});

test('a legacy entry (no id, recorded before this fix) is not re-duplicated when the same charge reappears unchanged', () => {
  const dir = path.join(tmpRoot, 'legacy-entry');
  const { rawPath, outPath } = writeFixture(dir, [
    { date: '2026-07-20', merchant: 'Locanda Portofino', amount: 100, matchedPlace: 'Locanda Portofino', account: ' More Mastercard (...9054)' },
  ]);
  const today = new Date('2026-08-01T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'txn-new', date: '2026-07-20', amount: -100, merchant: 'Locanda Portofino' }),
  ], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.date === '2026-07-20');
  assert.equal(matches.length, 1, 'an unchanged legacy entry should not be duplicated by the legacy composite-key fallback');
});

console.log('All budget-tracking-pull tests passed.');
