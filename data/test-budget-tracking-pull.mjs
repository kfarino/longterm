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
import { refreshFavoritePlaces, computeFavoritePlacesHistory, collapsePendingPostedDiningDuplicates } from '../scripts/budget-tracking-pull.mjs';

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

test('pending→posted with a NEW Monarch id (same merchant/amount, date ±2 days) collapses to one calendar entry', () => {
  // Sprout LA 2026-08-09: farmers-market charge showed twice on Month Plan
  // because Monarch minted a new id on post (Aug 2 pending id vs Aug 3 posted id).
  const dir = path.join(tmpRoot, 'new-id-date-shift');
  const { rawPath, outPath } = writeFixture(dir);
  const today = new Date('2026-08-09T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'pending-id', date: '2026-08-02', amount: -28.75, merchant: 'Test Ghost Kitchen' }),
  ], today, JOINT_LABELS);

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'posted-id', date: '2026-08-03', amount: -28.75, merchant: 'Test Ghost Kitchen' }),
  ], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.merchant === 'Test Ghost Kitchen');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].date, '2026-08-02');
  assert.equal(matches[0].id, 'posted-id');
  assert.equal(matches[0].amount, 28.75);
});

test('DoorDash on a personal card still lands on Month Plan dining activity', () => {
  const dir = path.join(tmpRoot, 'doordash-personal');
  const { rawPath, outPath } = writeFixture(dir);
  const today = new Date('2026-08-09T00:00:00Z');
  const personal = new Set(['CREDIT CARD (...8387)']);

  refreshFavoritePlaces(rawPath, outPath, [
    txn({
      id: 'dd-1',
      date: '2026-08-06',
      amount: -48.95,
      merchant: 'DoorDash',
      account: 'CREDIT CARD (...8387)',
    }),
  ], today, JOINT_LABELS, personal);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.merchant === 'DoorDash');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].amount, 48.95);
});

test('a charge reassigned to joint (Sora on Kevin personal) lands on Month Plan dining activity', () => {
  const dir = path.join(tmpRoot, 'sora-reassign');
  const { rawPath, outPath } = writeFixture(dir);
  const today = new Date('2026-08-09T00:00:00Z');
  const personal = new Set(['CREDIT CARD (...3939)']);

  refreshFavoritePlaces(rawPath, outPath, [
    txn({
      id: 'sora-1',
      date: '2026-08-01',
      amount: -240,
      merchant: 'Sora',
      account: 'CREDIT CARD (...3939)',
    }),
  ], today, JOINT_LABELS, personal);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.merchant === 'Sora');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].amount, 240);
  assert.equal(matches[0].includeOnMonthPlan, true);
});

test('same-day pending→posted with a NEW Monarch id collapses to one calendar entry', () => {
  // DoorDash / Mendocino 2026-08-13: Monarch minted a second id on post without
  // shifting the calendar date — old days > 0 gate left both on Month Plan.
  const dir = path.join(tmpRoot, 'same-day-new-id');
  const { rawPath, outPath } = writeFixture(dir);
  const today = new Date('2026-08-13T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'pending-same', date: '2026-08-11', amount: -39.24, merchant: 'Mendocino Farms' }),
  ], today, JOINT_LABELS);

  refreshFavoritePlaces(rawPath, outPath, [
    txn({ id: 'posted-same', date: '2026-08-11', amount: -39.24, merchant: 'Mendocino Farms' }),
  ], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.merchant === 'Mendocino Farms');
  assert.equal(matches.length, 1, 'same-day new Monarch id must collapse');
  assert.equal(matches[0].id, 'posted-same');
  assert.equal(matches[0].amount, 39.24);
});

test('end-of-pass heal collapses seed + two Monarch ids already in recentDiningActivity', () => {
  const dir = path.join(tmpRoot, 'heal-existing-dupes');
  const account = 'CREDIT CARD (...8387)';
  const { rawPath, outPath } = writeFixture(dir, [
    {
      id: 'seed-hanna-2026-08-06-DoorDash-48.95',
      date: '2026-08-06',
      merchant: 'DoorDash',
      amount: 48.95,
      matchedPlace: null,
      account,
      includeOnMonthPlan: true,
    },
    {
      id: 'id-a',
      date: '2026-08-06',
      merchant: 'DoorDash',
      amount: 48.95,
      matchedPlace: null,
      account,
      includeOnMonthPlan: true,
    },
    {
      id: 'id-b',
      date: '2026-08-06',
      merchant: 'DoorDash',
      amount: 48.95,
      matchedPlace: null,
      account,
      includeOnMonthPlan: true,
    },
  ]);
  const today = new Date('2026-08-13T00:00:00Z');
  const personal = new Set([account]);

  // No new transactions — heal must still collapse orphans left from prior pulls.
  refreshFavoritePlaces(rawPath, outPath, [], today, JOINT_LABELS, personal);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const matches = result.recentDiningActivity.filter((a) => a.merchant === 'DoorDash');
  assert.equal(matches.length, 1, 'seed + two Monarch ids must heal to one');
  assert.ok(!String(matches[0].id).startsWith('seed-'), 'prefer a real Monarch id over seed');
  assert.equal(matches[0].amount, 48.95);
});

test('collapsePendingPostedDiningDuplicates unit: seed+ids and distinct amounts', () => {
  const account = ' More Mastercard (...9054)';
  const collapsed = collapsePendingPostedDiningDuplicates([
    { id: 'seed-x', date: '2026-08-11', merchant: 'Mendocino Farms', amount: 39.24, account },
    { id: 'm1', date: '2026-08-11', merchant: 'Mendocino Farms', amount: 39.24, account },
    { id: 'lunch', date: '2026-08-11', merchant: 'Tu Madre', amount: 54.69, account },
    { id: 'dinner', date: '2026-08-11', merchant: 'Tu Madre', amount: 10.01, account },
  ]);
  assert.equal(collapsed.filter((e) => e.merchant === 'Mendocino Farms').length, 1);
  assert.equal(collapsed.filter((e) => e.merchant === 'Tu Madre').length, 2);
});

test('planningCost becomes observed avgSpend when a favorite has no visit history', () => {
  const dir = path.join(tmpRoot, 'planning-cost');
  fs.mkdirSync(dir, { recursive: true });
  const rawPath = path.join(dir, 'favorite_places_raw.json');
  const outPath = path.join(dir, 'favorite_places.json');
  fs.writeFileSync(rawPath, JSON.stringify([
    { name: 'Terra Eataly', planningCost: 150, dinnerSpot: true },
    { name: 'Tu Madre' },
  ]));
  const today = new Date('2026-08-09T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const terra = result.places.find((p) => p.name === 'Terra Eataly');
  assert.equal(terra.observed.avgSpend, 150);
  assert.equal(terra.observed.tier, 'mid');
  const tuMadre = result.places.find((p) => p.name === 'Tu Madre');
  assert.equal(tuMadre.observed, null);
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

// --- computeFavoritePlacesHistory (2026-08-05) ---

test('computeFavoritePlacesHistory aggregates visit count, total spend, and first/last date per matched place', () => {
  const dir = path.join(tmpRoot, 'history-basic');
  const { rawPath } = writeFixture(dir);
  const historyPath = path.join(dir, 'favorite_places_history.json');
  const today = new Date('2026-08-05T00:00:00Z');

  computeFavoritePlacesHistory(rawPath, historyPath, [
    txn({ id: 't1', date: '2024-09-01', amount: -50, merchant: 'Locanda Portofino' }),
    txn({ id: 't2', date: '2025-03-15', amount: -80, merchant: 'Locanda Portofino' }),
    txn({ id: 't3', date: '2026-07-20', amount: -60, merchant: 'Locanda Portofino' }),
  ], JOINT_LABELS, today, 730);

  const result = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  const stats = result.stats['Locanda Portofino'];
  assert.equal(stats.visitCount, 3);
  assert.equal(stats.totalSpend, 190);
  assert.equal(stats.avgSpend, Math.round((190 / 3) * 100) / 100);
  assert.equal(stats.firstVisitDate, '2024-09-01');
  assert.equal(stats.lastVisitDate, '2026-07-20');
  assert.equal(result.meta.lookbackDays, 730);
});

test('computeFavoritePlacesHistory ignores non-joint-card and unmatched-merchant transactions', () => {
  const dir = path.join(tmpRoot, 'history-filters');
  const { rawPath } = writeFixture(dir);
  const historyPath = path.join(dir, 'favorite_places_history.json');
  const today = new Date('2026-08-05T00:00:00Z');

  computeFavoritePlacesHistory(rawPath, historyPath, [
    txn({ id: 'p1', date: '2025-01-01', amount: -40, merchant: 'Locanda Portofino', account: 'Some Personal Card (...1111)' }),
    txn({ id: 'u1', date: '2025-01-02', amount: -40, merchant: 'Totally Unknown Place' }),
  ], JOINT_LABELS, today, 730);

  const result = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert.deepEqual(result.stats, {}, 'personal-card and unmatched-merchant charges should not produce any history entries');
});

test('computeFavoritePlacesHistory full-recomputes rather than accumulating across runs', () => {
  const dir = path.join(tmpRoot, 'history-recompute');
  const { rawPath } = writeFixture(dir);
  const historyPath = path.join(dir, 'favorite_places_history.json');
  const today = new Date('2026-08-05T00:00:00Z');

  computeFavoritePlacesHistory(rawPath, historyPath, [
    txn({ id: 't1', date: '2025-01-01', amount: -40, merchant: 'Tu Madre' }),
    txn({ id: 't2', date: '2025-01-02', amount: -40, merchant: 'Tu Madre' }),
  ], JOINT_LABELS, today, 730);

  // Re-run with a narrower/different transaction set — should replace, not add to, the prior result.
  computeFavoritePlacesHistory(rawPath, historyPath, [
    txn({ id: 't3', date: '2025-06-01', amount: -40, merchant: 'Tu Madre' }),
  ], JOINT_LABELS, today, 730);

  const result = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert.equal(result.stats['Tu Madre'].visitCount, 1, 'a re-run should fully replace the prior computed stats, not accumulate on top of them');
});

// --- refreshFavoritePlaces + visitStats (2026-08-05) ---

test('refreshFavoritePlaces attaches visitStats from favorite_places_history.json onto the matching place', () => {
  const dir = path.join(tmpRoot, 'visitstats-attach');
  const { rawPath, outPath } = writeFixture(dir);
  const historyPath = path.join(dir, 'favorite_places_history.json');
  fs.writeFileSync(historyPath, JSON.stringify({
    meta: { lastRegenerated: '2026-08-05', lookbackDays: 730 },
    stats: { 'Locanda Portofino': { visitCount: 5, totalSpend: 400, avgSpend: 80, firstVisitDate: '2024-01-01', lastVisitDate: '2026-06-01' } },
  }));
  const today = new Date('2026-08-01T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const locanda = result.places.find((p) => p.name === 'Locanda Portofino');
  assert.deepEqual(locanda.visitStats, { visitCount: 5, totalSpend: 400, avgSpend: 80, firstVisitDate: '2024-01-01', lastVisitDate: '2026-06-01' });
  const tuMadre = result.places.find((p) => p.name === 'Tu Madre');
  assert.equal(tuMadre.visitStats, null, 'a place with no entry in the history file should get null visitStats, not undefined or a crash');
});

test('refreshFavoritePlaces falls back to historical avgSpend/tier for observed when there is no recent (90-day) activity', () => {
  const dir = path.join(tmpRoot, 'visitstats-cost-fallback');
  const { rawPath, outPath } = writeFixture(dir);
  const historyPath = path.join(dir, 'favorite_places_history.json');
  fs.writeFileSync(historyPath, JSON.stringify({
    meta: { lastRegenerated: '2026-08-05', lookbackDays: 730 },
    stats: { 'Locanda Portofino': { visitCount: 4, totalSpend: 600, avgSpend: 150, firstVisitDate: '2024-01-01', lastVisitDate: '2025-12-01' } },
  }));
  const today = new Date('2026-08-01T00:00:00Z');

  // No transactions this run, so no 90-day recentDiningActivity for this place.
  refreshFavoritePlaces(rawPath, outPath, [], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  const locanda = result.places.find((p) => p.name === 'Locanda Portofino');
  assert.ok(locanda.observed, 'should not be null just because nothing fell in the last 90 days — historical data exists');
  assert.equal(locanda.observed.avgSpend, 150);
  assert.equal(locanda.observed.tier, 'high');
  assert.equal(locanda.observed.visitCount, 4);
});

test('refreshFavoritePlaces degrades to null visitStats on every place when favorite_places_history.json is missing', () => {
  const dir = path.join(tmpRoot, 'visitstats-missing-history');
  const { rawPath, outPath } = writeFixture(dir);
  const today = new Date('2026-08-01T00:00:00Z');

  refreshFavoritePlaces(rawPath, outPath, [], today, JOINT_LABELS);

  const result = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  for (const place of result.places) {
    assert.equal(place.visitStats, null);
  }
});

// --- Refund/credit detection (2026-08-05) ---
// Reuses the same txn()/JOINT_LABELS fixtures already in this file; refund
// detection isn't part of refreshFavoritePlaces, so these tests call the main
// pull's transaction-processing directly via a small re-export the
// implementation step below adds: detectJointRefunds(transactions, jointLabels, travelCategoryNames).

import { detectJointRefunds, travelNetSpend, trackerReassignment, cardBalancesForLabels, categoryName, spendAmount, applyManualCharges, applyManualChargesToTracking } from '../scripts/budget-tracking-pull.mjs';

// All the existing fixture transactions below fall in July 2026, so this
// keeps them in-range while still being strict enough to exercise the new
// cycleStart filter (see the "leaked from a prior cycle" test below).
const CYCLE_START = new Date('2026-07-01');

test('categoryName: Sprout LA is Groceries (farmers market billed under hospitality parent)', () => {
  const empty = { categoryRules: [], reassignments: [], amountRules: [] };
  assert.equal(categoryName({ merchant: 'Sprout LA', category: 'Restaurants & Bars' }, empty), 'Groceries');
  assert.equal(categoryName({ merchant: 'Whole Foods', category: 'Groceries' }, empty), 'Groceries');
});

test('spendAmount: amountRules override pending Monarch amount (Chase tip already posted)', () => {
  const txn = { merchant: 'R+D Kitchen', date: '2026-08-08', amount: -55.37 };
  assert.equal(spendAmount(txn, { amountRules: [] }), 55.37);
  assert.equal(
    spendAmount(txn, {
      amountRules: [{ merchantMatch: 'r+d', date: '2026-08-08', amount: 65.37 }],
    }),
    65.37,
  );
  assert.equal(
    spendAmount(txn, {
      amountRules: [{ merchantMatch: 'r+d', date: '2026-08-09', amount: 65.37 }],
    }),
    55.37,
    'wrong date must not match',
  );
});

test('detectJointRefunds finds a genuine merchant refund (positive amount, original spend category, joint card)', () => {
  const refunds = detectJointRefunds([
    txn({ id: 'r1', date: '2026-07-20', amount: 39.5, merchant: 'Amazon', category: 'Shopping' }),
  ], JOINT_LABELS, new Set(), CYCLE_START);
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].merchant, 'Amazon');
  assert.equal(refunds[0].amount, 39.5);
  assert.equal(refunds[0].category, 'Shopping');
});

test('detectJointRefunds excludes the card\'s own statement payment ("Credit Card Payment" category)', () => {
  const refunds = detectJointRefunds([
    txn({ id: 'p1', date: '2026-07-02', amount: 185, merchant: 'Payment Received', category: 'Credit Card Payment' }),
  ], JOINT_LABELS, new Set(), CYCLE_START);
  assert.equal(refunds.length, 0);
});

test('detectJointRefunds excludes travel-category credits (travel has its own separate tracking)', () => {
  const refunds = detectJointRefunds([
    txn({ id: 't1', date: '2026-07-28', amount: 200, merchant: 'Lufthansa', category: 'Travel & Vacation' }),
  ], JOINT_LABELS, new Set(['travel & vacation']), CYCLE_START);
  assert.equal(refunds.length, 0);
});

test('detectJointRefunds excludes negative-amount (regular spend) and non-joint-card transactions', () => {
  const refunds = detectJointRefunds([
    txn({ id: 's1', date: '2026-07-20', amount: -39.5, merchant: 'Amazon', category: 'Shopping' }),
    txn({ id: 's2', date: '2026-07-20', amount: 39.5, merchant: 'Amazon', category: 'Shopping', account: 'Some Personal Card (...1111)' }),
  ], JOINT_LABELS, new Set(), CYCLE_START);
  assert.equal(refunds.length, 0);
});

test('detectJointRefunds excludes a refund dated before cycleStart (leaked from a prior cycle)', () => {
  const refunds = detectJointRefunds([
    txn({ id: 'old1', date: '2026-06-15', amount: 25, merchant: 'Amazon', category: 'Shopping' }),
  ], JOINT_LABELS, new Set(), CYCLE_START);
  assert.equal(refunds.length, 0, 'a refund dated before cycleStart must not leak into this cycle\'s refunds');
});

test('travelNetSpend: Monarch spend (negative) becomes positive trip actual; credit reduces it', () => {
  assert.equal(travelNetSpend(-1637.83), 1637.83);
  assert.equal(travelNetSpend(1617.83), -1617.83);
  assert.equal(travelNetSpend(0), 0);
});

test('trackerReassignment: Blue Mercury / Locanda go to Hanna personal; covering transfer excluded', () => {
  assert.equal(trackerReassignment(txn({ merchant: 'Blue Mercury', date: '2026-07-28', amount: -137.19 })).reassignTo, 'hanna');
  assert.equal(trackerReassignment(txn({ merchant: 'Locanda Portofino', date: '2026-07-30', amount: -201.11 })).reassignTo, 'hanna');
  assert.equal(trackerReassignment(txn({ merchant: 'Barclays - Cards', date: '2026-08-06', amount: 338.3 })).reassignTo, 'exclude');
  assert.equal(trackerReassignment(txn({ merchant: 'Blue Mercury', date: '2026-07-29', amount: -10 })), null);
});

test('detectJointRefunds skips one-offs marked reassignTo exclude (Hanna reimbursement transfer)', () => {
  const refunds = detectJointRefunds([
    txn({ id: 'pay1', date: '2026-08-06', amount: 338.3, merchant: 'Barclays - Cards', category: 'Transfer' }),
  ], JOINT_LABELS, new Set(), CYCLE_START);
  assert.equal(refunds.length, 0);
});

test('cardBalancesForLabels matches mapped display names and keeps Monarch signed balances', () => {
  const accounts = [
    { displayName: 'CREDIT CARD (...8387)', balance: -412.5 },
    { displayName: 'CREDIT CARD (...3939)', currentBalance: -100 },
    { displayName: ' More Mastercard (...9054)', balance: -2000 },
    { displayName: 'TOTAL CHECKING (...4299)', balance: 500 },
  ];
  const hanna = cardBalancesForLabels(accounts, ['CREDIT CARD (...8387)']);
  assert.deepEqual(hanna, [{ label: 'CREDIT CARD (...8387)', balance: -412.5 }]);
  const joint = cardBalancesForLabels(accounts, [' More Mastercard (...9054)']);
  assert.equal(joint[0].balance, -2000);
  assert.deepEqual(cardBalancesForLabels(accounts, ['CREDIT CARD (...9999)']), []);
});

test('applyManualCharges merges a not-yet-in-Monarch personal charge into week + category totals', () => {
  const personalCycleStart = new Date('2026-08-01T12:00:00');
  const personalState = {
    kevin: {
      buckets: new Map([[1, 167.75]]),
      categoryTotals: new Map([['Shopping', 167.75]]),
      categoryTransactions: new Map([['Shopping', [{ date: '2026-08-11', merchant: 'Alex Crane', amount: 167.75 }]]]),
    },
  };
  applyManualCharges(personalState, [
    { owner: 'kevin', date: '2026-08-13', merchant: 'RAM', amount: 79, category: 'Shopping' },
  ], personalCycleStart);
  assert.equal(personalState.kevin.buckets.get(1), 246.75);
  assert.equal(personalState.kevin.categoryTotals.get('Shopping'), 246.75);
  assert.equal(personalState.kevin.categoryTransactions.get('Shopping').length, 2);
});

test('applyManualCharges skips when Monarch already has the same date+merchant+amount', () => {
  const personalCycleStart = new Date('2026-08-01T12:00:00');
  const personalState = {
    kevin: {
      buckets: new Map([[1, 79]]),
      categoryTotals: new Map([['Shopping', 79]]),
      categoryTransactions: new Map([['Shopping', [{ date: '2026-08-13', merchant: 'RAM', amount: 79 }]]]),
    },
  };
  applyManualCharges(personalState, [
    { owner: 'kevin', date: '2026-08-13', merchant: 'RAM', amount: 79, category: 'Shopping' },
  ], personalCycleStart);
  assert.equal(personalState.kevin.buckets.get(1), 79);
  assert.equal(personalState.kevin.categoryTransactions.get('Shopping').length, 1);
});

test('applyManualCharges merges a tracker:joint cash charge into joint week + category totals', () => {
  const personalCycleStart = new Date('2026-08-01T12:00:00');
  const jointCycleStart = new Date('2026-07-25T12:00:00');
  const personalState = {
    kevin: {
      buckets: new Map(),
      categoryTotals: new Map(),
      categoryTransactions: new Map(),
    },
  };
  const jointState = {
    buckets: new Map([[0, 100]]),
    categoryTotals: new Map([['Groceries', 100]]),
    categoryTransactions: new Map([['Groceries', [{ date: '2026-07-26', merchant: 'Test Market', amount: 100 }]]]),
  };
  applyManualCharges(personalState, [
    { tracker: 'joint', date: '2026-08-15', merchant: 'Test Babysitter', amount: 80, category: 'Childcare' },
  ], personalCycleStart, jointState, jointCycleStart);
  // Jul 25 cycle: Aug 15 is day 21 → week bucket 3
  assert.equal(jointState.buckets.get(3), 80);
  assert.equal(jointState.categoryTotals.get('Childcare'), 80);
  assert.equal(jointState.categoryTransactions.get('Childcare').length, 1);
  assert.equal(jointState.categoryTransactions.get('Childcare')[0].merchant, 'Test Babysitter');
  assert.equal(personalState.kevin.buckets.size, 0, 'joint charges must not land on a personal tracker');
});

test('applyManualCharges skips a joint charge when the same date+merchant+amount is already on joint', () => {
  const jointCycleStart = new Date('2026-07-25T12:00:00');
  const jointState = {
    buckets: new Map([[3, 80]]),
    categoryTotals: new Map([['Childcare', 80]]),
    categoryTransactions: new Map([['Childcare', [{ date: '2026-08-15', merchant: 'Test Babysitter', amount: 80 }]]]),
  };
  applyManualCharges({}, [
    { tracker: 'joint', date: '2026-08-15', merchant: 'Test Babysitter', amount: 80, category: 'Childcare' },
  ], new Date('2026-08-01T12:00:00'), jointState, jointCycleStart);
  assert.equal(jointState.buckets.get(3), 80);
  assert.equal(jointState.categoryTransactions.get('Childcare').length, 1);
});

test('applyManualChargesToTracking patches joint weeks[].actual and category line items', () => {
  const tracking = {
    joint: {
      cycleStart: '2026-07-25',
      weeks: [
        { weekOf: 'Jul 25–31', actual: 100, days: 7 },
        { weekOf: 'Aug 1–7', actual: 0, days: 7 },
        { weekOf: 'Aug 8–14', actual: 0, days: 7 },
        { weekOf: 'Aug 15–21', actual: 10, days: 7 },
      ],
      categories: [
        { name: 'Groceries', amount: 100, transactions: [{ date: '2026-07-26', merchant: 'Test Market', amount: 100 }] },
      ],
    },
    personal: { kevin: { cycleStart: '2026-08-01', weeks: [{ actual: 0, days: 7 }], categories: [] } },
  };
  applyManualChargesToTracking(tracking, [
    { tracker: 'joint', date: '2026-08-15', merchant: 'Test Babysitter', amount: 80, category: 'Childcare' },
  ]);
  assert.equal(tracking.joint.weeks[3].actual, 90);
  const childcare = tracking.joint.categories.find((c) => c.name === 'Childcare');
  assert.ok(childcare, 'Childcare category should be created');
  assert.equal(childcare.amount, 80);
  assert.equal(childcare.transactions.length, 1);
  assert.equal(childcare.transactions[0].merchant, 'Test Babysitter');
  assert.equal(childcare.transactions[0].date, '2026-08-15');
});

test('applyManualChargesToTracking skips a duplicate joint charge and charges before cycleStart', () => {
  const tracking = {
    joint: {
      cycleStart: '2026-07-25',
      weeks: [{ weekOf: 'Jul 25–31', actual: 80, days: 7 }],
      categories: [
        { name: 'Childcare', amount: 80, transactions: [{ date: '2026-07-26', merchant: 'Test Babysitter', amount: 80 }] },
      ],
    },
    personal: {},
  };
  applyManualChargesToTracking(tracking, [
    { tracker: 'joint', date: '2026-07-26', merchant: 'Test Babysitter', amount: 80, category: 'Childcare' },
    { tracker: 'joint', date: '2026-07-20', merchant: 'Test Babysitter', amount: 40, category: 'Childcare' },
  ]);
  assert.equal(tracking.joint.weeks[0].actual, 80);
  assert.equal(tracking.joint.categories[0].transactions.length, 1);
});

console.log('All budget-tracking-pull tests passed.');
