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

// Reads budget_tracking.json + goals.json's phase-derived target (same
// "target is derived from the current phase's expense line, never a
// separately hand-typed number" rule build-data.mjs already enforces) and
// returns pacing for all three trackers.
export function loadBudgetStatus(budgetTrackingPath, goalsPath) {
  const bt = JSON.parse(fs.readFileSync(budgetTrackingPath, 'utf8'));
  const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  const currentPhaseExpenses = goals.phases[0].expenses;

  const joint = { ...bt.joint, target: currentPhaseExpenses[bt.joint.targetExpenseKey] };
  const kevinPersonal = { ...bt.kevinPersonal, target: currentPhaseExpenses[bt.kevinPersonal.targetExpenseKey] };

  return {
    joint: { ...computeTrackerPacing(joint), target: joint.target },
    kevinPersonal: { ...computeTrackerPacing(kevinPersonal), target: kevinPersonal.target },
    travel: bt.travel.trips.map((t) => ({ label: t.label, actual: t.actual, budgetedAmount: t.budgetedAmount })),
  };
}

// Mirrors renderGoalsSection()'s current-vs-target math, including the
// trackLiveBrokerage special case (Croatia's goal tracks the live combined
// brokerage total rather than a hand-typed number).
export function loadSavingsGoals(goalsPath, accountsPath) {
  const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  const accounts = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
  const liveBrokerage = accounts.balances.brokerage.kevin.amount + accounts.balances.brokerage.hanna.amount;

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

// Bundles all three for the recap script (Part B) and for the poller's
// dispatch (Part C) — read-only, loaded fresh each run, tolerating missing
// files the same "degrade quietly" way dining-recommendation.mjs's context
// loader does (a fresh checkout before these files exist shouldn't crash
// the bot, just report emptier answers).
export function loadFinancialContext({ budgetTrackingPath, goalsPath, accountsPath }) {
  let budgetStatus = { joint: null, kevinPersonal: null, travel: [] };
  try { budgetStatus = loadBudgetStatus(budgetTrackingPath, goalsPath); } catch { /* missing/unparseable — degrade to empty */ }
  let savingsGoals = [];
  try { savingsGoals = loadSavingsGoals(goalsPath, accountsPath); } catch { /* missing/unparseable — degrade to empty */ }
  let decisions = [];
  try { decisions = loadDecisions(goalsPath); } catch { /* missing/unparseable — degrade to empty */ }
  return { budgetStatus, savingsGoals, decisions };
}
