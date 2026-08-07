// Read-only derivation over the Oura store — the health counterpart to
// financial-context.mjs, so the recap and the bot's on-demand tool agree on one
// set of numbers instead of re-deriving them.
//
// Depletion is measured against each person's OWN rolling baseline, never an
// absolute threshold. The two adults here are very different sleepers; a shared
// cutoff would fire constantly for one and never for the other, collapsing
// "whoever is more depleted" into a single person's number permanently.
// See docs/superpowers/specs/2026-08-06-oura-health-signal-design.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryOura, defaultOuraStoreDir } from './oura-store.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_THRESHOLDS = {
  rule: 'baselineStress',
  combine: 'either',
  baselineDays: 30,
  weekDays: 7,
  minNightsForBaseline: 14,
  minNightsInWeek: 3,
  sleepScoreDropPoints: 5,
  stressfulDaysInWeek: 3,
};

export function defaultHealthOverridesPath() {
  return path.join(repoRoot, 'data', 'health_overrides.json');
}

export function loadHealthOverrides(overridesPath = defaultHealthOverridesPath()) {
  try {
    return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
  } catch {
    return { excludedNights: [], baselineRules: [] };
  }
}

function isoDaysBefore(now, n) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function mean(values) {
  if (!values.length) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
}

function isExcludedNight(ownerId, day, overrides) {
  return (overrides?.excludedNights || []).some((e) => e.ownerId === ownerId && e.date === day);
}

function isExcludedFromBaseline(ownerId, day, overrides) {
  return (overrides?.baselineRules || []).some(
    (r) => r.ownerId === ownerId && r.excludeFromBaseline && day >= r.from && day <= r.to,
  );
}

/**
 * @returns {{ownerId,nights,weekNights,baselineNights,weekMean,baseline,drop,
 *            stressfulDays,depleted,reason}}
 */
export function computeOwnerHealth(ownerId, {
  sleepRows = [], stressRows = [], thresholds = DEFAULT_THRESHOLDS, overrides = null, now = new Date(),
} = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const weekStart = isoDaysBefore(now, t.weekDays);
  const baselineStart = isoDaysBefore(now, t.baselineDays);

  // A night with no record — or a record whose score is null — is simply
  // absent, never coerced to a zero. A ring left on the nightstand must not
  // read as catastrophic sleep and quietly cancel a night out.
  const usable = sleepRows.filter(
    (r) => r.day
      && typeof r.data?.score === 'number'
      && r.day >= baselineStart
      && !isExcludedNight(ownerId, r.day, overrides),
  );

  // weekStart is inclusive: with weekDays: 7 the week is the last 7 nights,
  // and the baseline is strictly older. An inclusive/exclusive mixup here puts
  // the oldest night of the week into the baseline, which both shrinks the
  // measured drop and contaminates the reference it is measured against.
  const weekScores = usable.filter((r) => r.day >= weekStart).map((r) => r.data.score);
  const baselineScores = usable
    .filter((r) => r.day < weekStart && !isExcludedFromBaseline(ownerId, r.day, overrides))
    .map((r) => r.data.score);

  const stressfulDays = stressRows.filter(
    (r) => r.day && r.day >= weekStart && r.data?.day_summary === 'stressful'
      && !isExcludedNight(ownerId, r.day, overrides),
  ).length;

  const base = {
    ownerId,
    nights: usable.length,
    weekNights: weekScores.length,
    baselineNights: baselineScores.length,
    weekMean: mean(weekScores),
    baseline: mean(baselineScores),
    stressfulDays,
    drop: 0,
  };

  if (baselineScores.length < t.minNightsForBaseline || weekScores.length < t.minNightsInWeek) {
    return { ...base, depleted: false, reason: 'insufficient_data' };
  }

  const drop = Math.round((base.baseline - base.weekMean) * 10) / 10;
  const bySleep = drop >= t.sleepScoreDropPoints;
  const byStress = stressfulDays >= t.stressfulDaysInWeek;

  let depleted;
  if (t.rule === 'baseline') depleted = bySleep;
  else if (t.rule === 'stress') depleted = byStress;
  else depleted = t.combine === 'both' ? (bySleep && byStress) : (bySleep || byStress);

  const parts = [`week averaged ${base.weekMean} against a ${base.baseline} baseline`];
  if (byStress) parts.push(`${stressfulDays} stressful days`);
  return {
    ...base,
    drop,
    depleted,
    reason: depleted ? parts.join(', ') : `within normal range (${parts[0]})`,
  };
}

/** Worse-of-the-two: depleted if ANY owner with sufficient data is. */
export function pickWorst(perOwner) {
  const depleted = Object.values(perOwner).filter((o) => o.depleted);
  if (!depleted.length) return null;
  const worst = depleted.sort((a, b) => (b.drop || 0) - (a.drop || 0))[0];
  return { ownerId: worst.ownerId, depleted: true, reason: worst.reason };
}

export function loadHealthContext({
  storeDir = defaultOuraStoreDir(),
  goalsPath = path.join(repoRoot, 'data', 'goals.json'),
  overridesPath = defaultHealthOverridesPath(),
  now = new Date(),
} = {}) {
  let owners = [];
  let thresholds = DEFAULT_THRESHOLDS;
  try {
    const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    owners = (goals.owners || []).map((o) => o.id).filter(Boolean);
    thresholds = { ...DEFAULT_THRESHOLDS, ...(goals.healthThresholds || {}) };
  } catch { /* missing/unparseable — degrade to empty */ }

  const overrides = loadHealthOverrides(overridesPath);
  const startDate = isoDaysBefore(now, thresholds.baselineDays);
  const endDate = new Date(now).toISOString().slice(0, 10);

  const perOwner = {};
  for (const ownerId of owners) {
    const sleepRows = queryOura('daily_sleep', { storeDir, ownerId, startDate, endDate });
    const stressRows = queryOura('daily_stress', { storeDir, ownerId, startDate, endDate });
    perOwner[ownerId] = computeOwnerHealth(ownerId, { sleepRows, stressRows, thresholds, overrides, now });
  }

  const configured = Object.values(perOwner).some((o) => o.nights > 0);
  return { configured, thresholds, perOwner, worst: pickWorst(perOwner) };
}
