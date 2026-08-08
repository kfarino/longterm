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

function mostRecentWithField(rows, extractFn, sinceDay) {
  const candidates = rows
    .filter((r) => r.day && r.day >= sinceDay)
    .map((r) => ({ day: r.day, value: extractFn(r.data) }))
    .filter((r) => r.value !== null && r.value !== undefined)
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  return candidates[0] || null;
}

// Separate from computeOwnerHealth on purpose — that function's depletion
// verdict feeds the Thursday recap's dining swap and must not change here.
// This is purely additive reporting for get_health_status.
//
// Readiness/resilience are how-are-you-TODAY concepts (Oura presents them as
// daily snapshots, not week averages), so this reports the most recent
// available day within recentDays, not a mean. Each field is searched
// independently: Kevin's real ring (set up 2026-08-06) had a genuine
// readiness score on both its first two days while contributors.hrv_balance
// was null on both — a present score must never be suppressed by an absent
// HRV balance on the same day, and vice versa.
export function computeOwnerVitals(ownerId, {
  readinessRows = [], resilienceRows = [], stressRows = [], now = new Date(), recentDays = 7, weekDays = 7,
} = {}) {
  const sinceDay = isoDaysBefore(now, recentDays);
  const weekStart = isoDaysBefore(now, weekDays);

  const readiness = mostRecentWithField(readinessRows, (d) => (typeof d?.score === 'number' ? d.score : null), sinceDay);
  const hrv = mostRecentWithField(
    readinessRows,
    (d) => (typeof d?.contributors?.hrv_balance === 'number' ? d.contributors.hrv_balance : null),
    sinceDay,
  );
  const resilience = mostRecentWithField(resilienceRows, (d) => (typeof d?.level === 'string' ? d.level : null), sinceDay);

  const stressBreakdown = { normal: 0, stressful: 0, restored: 0 };
  for (const r of stressRows) {
    if (!r.day || r.day < weekStart) continue;
    const summary = r.data?.day_summary;
    if (summary === 'normal' || summary === 'stressful' || summary === 'restored') stressBreakdown[summary] += 1;
  }

  return {
    readinessScore: readiness ? readiness.value : null,
    readinessDay: readiness ? readiness.day : null,
    hrvBalance: hrv ? hrv.value : null,
    resilienceLevel: resilience ? resilience.value : null,
    resilienceDay: resilience ? resilience.day : null,
    stressBreakdown,
  };
}

/** Worse-of-the-two: depleted if ANY owner with sufficient data is. */
export function pickWorst(perOwner) {
  const depleted = Object.values(perOwner).filter((o) => o.depleted);
  if (!depleted.length) return null;
  const worst = depleted.sort((a, b) => (b.drop || 0) - (a.drop || 0))[0];
  // displayName rides along so downstream copy can say "Kevin", not "kevin" —
  // every consumer here writes text a human reads in a Telegram message.
  return {
    ownerId: worst.ownerId,
    displayName: worst.displayName || worst.ownerId,
    depleted: true,
    reason: worst.reason,
  };
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
    owners = (goals.owners || [])
      .filter((o) => o && o.id)
      .map((o) => ({ id: o.id, displayName: o.displayName || o.id }));
    thresholds = { ...DEFAULT_THRESHOLDS, ...(goals.healthThresholds || {}) };
  } catch { /* missing/unparseable — degrade to empty */ }

  const overrides = loadHealthOverrides(overridesPath);
  const startDate = isoDaysBefore(now, thresholds.baselineDays);
  const endDate = new Date(now).toISOString().slice(0, 10);

  const perOwner = {};
  for (const { id: ownerId, displayName } of owners) {
    const sleepRows = queryOura('daily_sleep', { storeDir, ownerId, startDate, endDate });
    const stressRows = queryOura('daily_stress', { storeDir, ownerId, startDate, endDate });
    const readinessRows = queryOura('daily_readiness', { storeDir, ownerId, startDate, endDate });
    const resilienceRows = queryOura('daily_resilience', { storeDir, ownerId, startDate, endDate });
    perOwner[ownerId] = {
      ...computeOwnerHealth(ownerId, { sleepRows, stressRows, thresholds, overrides, now }),
      vitals: computeOwnerVitals(ownerId, { readinessRows, resilienceRows, stressRows, now }),
      displayName,
    };
  }

  const configured = Object.values(perOwner).some((o) => o.nights > 0);
  return { configured, thresholds, perOwner, worst: pickWorst(perOwner) };
}
