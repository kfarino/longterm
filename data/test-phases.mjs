// Current phase is the latest one whose start date has arrived.
// Invented figures only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { currentPhase, currentPhaseIndex } from '../scripts/phases.mjs';
import { loadBudgetStatus } from '../scripts/financial-context.mjs';
import { loadDashboard } from './dashboard-test-harness.mjs';

const today = new Date(2026, 10, 9);

const phases = [
  { id: 1, name: 'Dual income', period: 'Aug 2026 → Nov 8, 2026', expenses: { 'Hanna personal': 3020, 'Family budget': 5500 } },
  { id: 2, name: 'Hanna payout', period: 'Nov 9, 2026 → May 2027', expenses: { 'Hanna personal': 1500, 'Family budget': 5500 } },
  { id: 3, name: 'Later', period: 'Jul 2027 → 2030', expenses: { 'Hanna personal': 1500, 'Family budget': 5500 } },
];

assert.equal(currentPhaseIndex(phases, today), 1, 'Nov 9 is inside Phase 2, not the phase that already ended');
assert.equal(currentPhase(phases, today).expenses['Hanna personal'], 1500);
assert.equal(currentPhaseIndex(phases, new Date(2026, 10, 8)), 0, 'the day before Phase 2 starts, Phase 1 is still current');
assert.equal(currentPhaseIndex([{ id: 1, period: 'Now → 2028', expenses: { 'Family budget': 4500 } }, { id: 2, period: '2028 → 2030', expenses: { 'Family budget': 5000 } }], today), 0, 'a later phase that has not started does not become current');

{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-budget-'));
  const goalsPath = path.join(dir, 'goals.json');
  const btPath = path.join(dir, 'budget_tracking.json');
  fs.writeFileSync(goalsPath, JSON.stringify({
    owners: [{ id: 'hanna', displayName: 'Hanna' }],
    phases,
  }));
  fs.writeFileSync(btPath, JSON.stringify({
    joint: { label: 'Joint', targetExpenseKey: 'Family budget', weeks: [{ actual: 10, days: 7 }], cycleDays: 30 },
    personal: { hanna: { label: 'Hanna personal', targetExpenseKey: 'Hanna personal', weeks: [{ actual: 4, days: 7 }], cycleDays: 30 } },
    travel: { trips: [] },
  }));
  const status = loadBudgetStatus(btPath, goalsPath, today);
  assert.equal(status.personal.hanna.target, 1500, 'Georgina quotes the current phase, not the first phase in the file');
  assert.equal(status.joint.target, 5500);
}

{
  const d = loadDashboard({
    phases: [
      { id: 1, color: '#111', name: 'Dual income', period: 'Now → Dec 31, 2099', note: '', income: { A: 10 }, expenses: { Rent: 1 }, allocation: [] },
      { id: 2, color: '#222', name: 'Payout phase', period: 'Jan 2000 → Dec 31, 2099', note: '', income: { A: 20 }, expenses: { Rent: 2 }, allocation: [] },
    ],
  });
  await d.renderNowTab();
  const html = d.elements['pg-now'].innerHTML;
  assert.match(html, /Payout phase · current/);
  assert.doesNotMatch(html, /Dual income · current/);
}

console.log('test-phases.mjs ok');
