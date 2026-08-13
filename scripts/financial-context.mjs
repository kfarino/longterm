// Finances/Longterm/scripts/financial-context.mjs
// Ported from dashboard_v5.html's inline computeTrackerPacing()/
// renderGoalsSection() math (2026-07-31) so the Telegram bot's financial
// Q&A tools and its weekly recap agree on the exact same numbers the
// dashboard shows — one source of truth for "how do we compute pace/
// progress," not re-derived separately in each place that needs it.
// Deliberately a duplicate of the dashboard's inline logic, not a shared
// import — same accepted tradeoff as dining-recommendation.mjs (the
// dashboard's script isn't loaded as a real ES module yet, so it can't
// import this file, or vice versa).
import fs from 'node:fs';

// Mirrors dashboard_v5.html's computeTrackerPacing(): weights by
// days-in-bucket, not entry count, so a trailing partial week doesn't skew
// the daily rate.
export function computeTrackerPacing(tracker) {
  const weeks = tracker.weeks || [];
  const total = weeks.reduce((s, w) => s + w.actual, 0);
  const totalDays = weeks.reduce((s, w) => s + (w.days || 7), 0);
  const dailyRate = totalDays ? total / totalDays : 0;
  const projected = dailyRate * (tracker.cycleDays || 30);
  const variance = projected - tracker.target;
  return { total, projected, variance };
}

/**
 * "How do we still hit the target?" — the forward-looking counterpart to
 * computeTrackerPacing's backward-looking projection.
 *
 * computeTrackerPacing answers "where do we land if nothing changes", which is
 * a forecast of failure, not a plan: it extrapolates the daily average and has
 * no relationship to the goal. This answers the actual question — what rate
 * gets us to target from here, and how far that is from the current rate.
 *
 * Expressed WEEKLY, not daily: the household reads this in a recap that lands
 * twice a week, so a weekly allowance is the unit they can act on.
 *
 * Deliberately separate from computeTrackerPacing, which is a byte-for-byte
 * duplicate of the dashboard's inline math and must not drift (AGENTS.md §2).
 *
 * Returns null when the tracker has no cycle configured — a made-up deadline is
 * worse than no advice.
 */
export function budgetGuidance(tracker, now = new Date()) {
  if (!tracker || !tracker.cycleStart || !tracker.cycleDays) return null;
  const start = new Date(`${tracker.cycleStart}T00:00:00`);
  if (Number.isNaN(start.getTime())) return null;

  const cycleDays = tracker.cycleDays;
  const rawElapsed = Math.floor((now - start) / 86400000);
  const daysElapsed = Math.min(Math.max(rawElapsed, 1), cycleDays);
  const daysRemaining = Math.max(0, cycleDays - rawElapsed);
  const remaining = tracker.target - tracker.total;

  const currentWeekly = (tracker.total / daysElapsed) * 7;
  // Null once the cycle is over — there is no "rest of the cycle" to pace.
  const requiredWeekly = daysRemaining > 0 ? (remaining / daysRemaining) * 7 : null;

  return {
    daysElapsed,
    daysRemaining,
    remaining,
    currentWeekly,
    requiredWeekly,
    // Advice only past the midpoint (Kevin, 2026-08-13): earlier than that a
    // few days of noise reads as a trend, and there is still plenty of runway,
    // so corrective advice is premature and becomes background noise.
    pastHalfway: rawElapsed >= cycleDays / 2,
    // Based on the actionable comparison, not the old projection: can we keep
    // spending the way we have been and still land on target?
    onTrack: requiredWeekly == null ? remaining >= 0 : requiredWeekly >= currentWeekly,
  };
}

// Reads budget_tracking.json + goals.json's phase-derived target (same
// "target is derived from the current phase's expense line, never a
// separately hand-typed number" rule build-data.mjs already enforces) and
// returns pacing for joint + each personal.<ownerId> tracker.
export function loadBudgetStatus(budgetTrackingPath, goalsPath) {
  const bt = JSON.parse(fs.readFileSync(budgetTrackingPath, 'utf8'));
  const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  const currentPhaseExpenses = goals.phases[0].expenses;
  const owners = goals.owners || [];

  const joint = { ...bt.joint, target: currentPhaseExpenses[bt.joint.targetExpenseKey] };
  const personal = {};
  for (const [ownerId, tracker] of Object.entries(bt.personal || {})) {
    const withTarget = { ...tracker, target: currentPhaseExpenses[tracker.targetExpenseKey] };
    const owner = owners.find((o) => o.id === ownerId);
    personal[ownerId] = {
      ...computeTrackerPacing(withTarget),
      target: withTarget.target,
      label: tracker.label || `${owner ? owner.displayName : ownerId} personal`,
      displayName: owner ? owner.displayName : ownerId,
      // Passed through (not folded into computeTrackerPacing) so the pacing
      // math stays byte-identical to the dashboard's inline copy — see the
      // header comment and AGENTS.md §2. Consumers derive "how much is left
      // and for how long" from these; the pace numbers are unchanged.
      cycleStart: tracker.cycleStart || null,
      cycleDays: tracker.cycleDays || null,
    };
  }

  return {
    joint: {
      ...computeTrackerPacing(joint),
      target: joint.target,
      label: joint.label || 'Joint',
      cycleStart: joint.cycleStart || null,
      cycleDays: joint.cycleDays || null,
    },
    personal,
    travel: bt.travel.trips.map((t) => ({ label: t.label, actual: t.actual, budgetedAmount: t.budgetedAmount })),
  };
}

function sumOwnerAmounts(bucket) {
  return Object.values(bucket || {}).reduce((s, entry) => s + (entry?.amount || 0), 0);
}

// Mirrors renderGoalsSection()'s current-vs-target math, including the
// trackLiveBrokerage special case (brokerage goal tracks the live combined
// brokerage total rather than a hand-typed number).
export function loadSavingsGoals(goalsPath, accountsPath) {
  const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  const liveBrokerage = sumOwnerAmounts(accounts.balances.brokerage);

  return goals.lifeGoals.map((g) => {
    const current = g.trackLiveBrokerage ? liveBrokerage : g.current;
    const pct = Math.min(100, Math.round((current / g.targetAmount) * 100));
    return { name: g.name, current, targetAmount: g.targetAmount, pct, status: g.status, note: g.note };
  });
}

// Plain pass-through of goals.json's decisions array — no math to port,
// just a read-only accessor kept alongside the others for a consistent
// "financial context" surface.
export function loadDecisions(goalsPath) {
  const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  return goals.decisions;
}

// Flattens the per-category/per-trip transaction line items budget_tracking.json
// already carries for the current cycle (loadBudgetStatus ignores these, reading
// only the `weeks` array for pacing) into one array the bot can filter by
// merchant/tracker. Current-cycle only — same window budget_tracking.json itself
// covers, no older history.
export function loadTransactionDetail(budgetTrackingPath) {
  const bt = JSON.parse(fs.readFileSync(budgetTrackingPath, 'utf8'));
  const rows = [];
  const addCategories = (tracker, categories) => {
    for (const cat of categories || []) {
      for (const txn of cat.transactions || []) {
        rows.push({ tracker, group: cat.name, date: txn.date, merchant: txn.merchant, amount: txn.amount });
      }
    }
  };
  addCategories('joint', bt.joint?.categories);
  for (const txn of bt.joint?.refunds || []) {
    rows.push({ tracker: 'joint', group: txn.category || 'Refund', date: txn.date, merchant: txn.merchant, amount: txn.amount, type: 'refund' });
  }
  for (const [ownerId, tracker] of Object.entries(bt.personal || {})) {
    addCategories(`personal:${ownerId}`, tracker.categories);
  }
  for (const trip of bt.travel?.trips || []) {
    for (const txn of trip.transactions || []) {
      const isCredit = txn.type === 'credit' || Number(txn.amount) < 0;
      rows.push({
        tracker: 'travel',
        group: trip.label,
        date: txn.date,
        merchant: txn.merchant,
        amount: isCredit ? -Math.abs(Number(txn.amount) || 0) : Number(txn.amount) || 0,
        ...(isCredit ? { type: 'credit' } : {}),
      });
    }
  }
  for (const txn of bt.travel?.unmatched || []) {
    rows.push({ tracker: 'travel', group: 'unmatched', date: txn.date, merchant: txn.merchant, amount: txn.amount });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return rows;
}

// Bundles all three for the recap script (Part B) and for the poller's
// dispatch (Part C) — read-only, loaded fresh each run, tolerating missing
// files the same "degrade quietly" way dining-recommendation.mjs's context
// loader does (a fresh checkout before these files exist shouldn't crash
// the bot, just report emptier answers).
export function loadFinancialContext({ budgetTrackingPath, goalsPath, accountsPath }) {
  let budgetStatus = { joint: null, personal: {}, travel: [] };
  try { budgetStatus = loadBudgetStatus(budgetTrackingPath, goalsPath); } catch { /* missing/unparseable — degrade to empty */ }
  let savingsGoals = [];
  try { savingsGoals = loadSavingsGoals(goalsPath, accountsPath); } catch { /* missing/unparseable — degrade to empty */ }
  let decisions = [];
  try { decisions = loadDecisions(goalsPath); } catch { /* missing/unparseable — degrade to empty */ }
  let transactions = [];
  try { transactions = loadTransactionDetail(budgetTrackingPath); } catch { /* missing/unparseable — degrade to empty */ }
  return { budgetStatus, savingsGoals, decisions, transactions };
}
