// Longterm/data/test-health-context.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// health-context.mjs's depletion rule: a personal rolling baseline (NOT an
// absolute threshold — the two adults here are very different sleepers, so a
// shared cutoff would fire constantly for one and never for the other), the
// insufficient-data gate that governs a newly set-up ring, and the rule that a
// night not worn is absent rather than zero. Run with:
//   node Longterm/data/test-health-context.mjs
import assert from 'node:assert/strict';
import { computeOwnerHealth, pickWorst } from '../scripts/health-context.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
console.log('test-health-context.mjs');

const NOW = new Date('2026-03-01T12:00:00Z');

const THRESHOLDS = {
  rule: 'baselineStress',
  combine: 'either',
  baselineDays: 30,
  weekDays: 7,
  minNightsForBaseline: 14,
  minNightsInWeek: 3,
  sleepScoreDropPoints: 5,
  stressfulDaysInWeek: 3,
};

function dayBefore(n) {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function sleepRows(scoresByDaysAgo) {
  return Object.entries(scoresByDaysAgo).map(([ago, score]) => ({
    ownerId: 'alex', endpoint: 'daily_sleep', day: dayBefore(Number(ago)), data: { score },
  }));
}

function stressRows(summariesByDaysAgo) {
  return Object.entries(summariesByDaysAgo).map(([ago, day_summary]) => ({
    ownerId: 'alex', endpoint: 'daily_stress', day: dayBefore(Number(ago)), data: { day_summary },
  }));
}

/** A steady run of nights, so the baseline is unambiguous. */
function steady(score, fromAgo, toAgo) {
  const out = {};
  for (let i = fromAgo; i <= toAgo; i += 1) out[i] = score;
  return out;
}

test('a week meaningfully below the personal baseline is depleted', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(80, 1, 7) });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, true);
  assert.equal(r.baseline, 90);
  assert.equal(r.weekMean, 80);
  assert.equal(r.drop, 10);
  assert.match(r.reason, /80/);
  assert.match(r.reason, /90/);
});

test('a week at the personal baseline is not depleted, even at a low absolute score', () => {
  // The whole point of a personal baseline: 62 is fine if 62 is your normal.
  const rows = sleepRows({ ...steady(62, 8, 30), ...steady(62, 1, 7) });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
  assert.equal(r.drop, 0);
});

test('a drop smaller than sleepScoreDropPoints does not fire', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(87, 1, 7) });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
});

test('the current week is excluded from its own baseline', () => {
  // If the week were included, the baseline would be dragged toward it and the
  // drop would read smaller than it truly is.
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(70, 1, 7) });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.baseline, 90);
});

test('enough stressful days alone fires under combine:either', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 7) });
  const stress = stressRows({ 1: 'stressful', 2: 'stressful', 3: 'stressful', 4: 'normal' });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: stress, thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, true);
  assert.equal(r.stressfulDays, 3);
});

test('combine:both requires sleep AND stress', () => {
  const both = { ...THRESHOLDS, combine: 'both' };
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 7) });
  const stress = stressRows({ 1: 'stressful', 2: 'stressful', 3: 'stressful' });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: stress, thresholds: both, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
});

test('rule:baseline ignores stress entirely', () => {
  const baselineOnly = { ...THRESHOLDS, rule: 'baseline' };
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 7) });
  const stress = stressRows({ 1: 'stressful', 2: 'stressful', 3: 'stressful', 4: 'stressful' });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: stress, thresholds: baselineOnly, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
});

test('rule:stress ignores the baseline entirely', () => {
  const stressOnly = { ...THRESHOLDS, rule: 'stress' };
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(70, 1, 7) });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: stressOnly, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
});

test('a brand-new ring reports insufficient_data, never depleted', () => {
  const rows = sleepRows({ 1: 74 });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
  assert.equal(r.reason, 'insufficient_data');
  assert.equal(r.nights, 1);
});

test('too few nights inside the week reports insufficient_data', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), 1: 60, 2: 60 });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.reason, 'insufficient_data');
  assert.equal(r.depleted, false);
});

test('a night not worn is absent, not a zero', () => {
  // The single most important correctness rule in this feature: gaps must not
  // read as catastrophic sleep. Four missing nights in the week must not
  // produce a depleted verdict on their own.
  const rows = sleepRows({ ...steady(90, 8, 30), 1: 90, 2: 90, 3: 90 });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.weekMean, 90);
  assert.equal(r.depleted, false);
});

test('a null score is treated as absent, not as a zero', () => {
  const rows = [
    ...sleepRows({ ...steady(90, 8, 30), 1: 90, 2: 90, 3: 90 }),
    { ownerId: 'alex', endpoint: 'daily_sleep', day: dayBefore(4), data: { score: null } },
  ];
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.weekMean, 90);
  assert.equal(r.depleted, false);
});

test('an excluded night is dropped from both the week and the baseline', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 6), 7: 20 });
  const overrides = { excludedNights: [{ ownerId: 'alex', date: dayBefore(7), reason: 'ring off' }] };
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides, now: NOW });
  assert.equal(r.weekMean, 90);
  assert.equal(r.depleted, false);
});

test('a baselineRule range is excluded from the baseline', () => {
  const rows = sleepRows({ ...steady(50, 20, 30), ...steady(90, 8, 19), ...steady(88, 1, 7) });
  const overrides = {
    baselineRules: [{ ownerId: 'alex', from: dayBefore(30), to: dayBefore(20), excludeFromBaseline: true, reason: 'illness' }],
  };
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides, now: NOW });
  assert.equal(r.baseline, 90);
  assert.equal(r.depleted, false);
});

test('an override for a different owner is ignored', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 6), 7: 20 });
  const overrides = { excludedNights: [{ ownerId: 'someone-else', date: dayBefore(7) }] };
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides, now: NOW });
  assert.ok(r.weekMean < 90);
});

test('pickWorst returns the depleted owner and ignores insufficient-data owners', () => {
  const perOwner = {
    alex: { ownerId: 'alex', depleted: false, reason: 'insufficient_data', drop: 0 },
    sam: { ownerId: 'sam', depleted: true, reason: 'week averaged 80 against a 90 baseline', drop: 10 },
  };
  const worst = pickWorst(perOwner);
  assert.equal(worst.ownerId, 'sam');
  assert.equal(worst.depleted, true);
});

test('pickWorst picks the larger drop when both are depleted', () => {
  const perOwner = {
    alex: { ownerId: 'alex', depleted: true, reason: 'a', drop: 6 },
    sam: { ownerId: 'sam', depleted: true, reason: 'b', drop: 12 },
  };
  assert.equal(pickWorst(perOwner).ownerId, 'sam');
});

test('pickWorst returns null when nobody is depleted', () => {
  assert.equal(pickWorst({ alex: { ownerId: 'alex', depleted: false, drop: 0 } }), null);
});

console.log('All health-context tests passed.');
