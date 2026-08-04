#!/usr/bin/env node
// Regenerates ../kevin_hanna_goal_plan.md as a narrative view of goals.json +
// accounts.json + budget_tracking.json. This file is never hand-edited —
// goals.json is the source of truth for every figure that appears here.
// Run after editing goals.json/accounts.json, same as build-data.mjs.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'kevin_hanna_goal_plan.md');

const goals = JSON.parse(readFileSync(join(here, 'goals.json'), 'utf8'));
const accounts = JSON.parse(readFileSync(join(here, 'accounts.json'), 'utf8'));
const budget = JSON.parse(readFileSync(join(here, 'budget_tracking.json'), 'utf8'));

const fmt = (n) => '$' + Math.round(n).toLocaleString();
const fmtK = (n) => n >= 1000000 ? '$' + (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M' : '$' + Math.round(n / 1000) + 'K';

function phaseIncome(p) { return Object.values(p.income).reduce((a, b) => a + b, 0); }
function phaseExpenses(p) { return Object.values(p.expenses).reduce((a, b) => a + b, 0); }

function incomeTable(phase) {
  const rows = Object.entries(phase.income).map(([k, v]) => `| ${k} | ${fmt(v)} |`).join('\n');
  return `| | Monthly (net) |\n|---|---|\n${rows}\n| **Total** | **${fmt(phaseIncome(phase))}** |`;
}

function expenseTable(phase) {
  const rows = Object.entries(phase.expenses).map(([k, v]) => `| ${k} | ${fmt(v)} |`).join('\n');
  const alloc = phase.allocation.map((a) => `| ${a.label} | ${fmt(a.amount)} |`).join('\n');
  const total = phaseExpenses(phase);
  const surplus = phaseIncome(phase) - total;
  return `| Category | Monthly |\n|---|---|\n${rows}\n| **Total** | **${fmt(total)}** |\n| **Surplus** | **${fmt(surplus)}** |` +
    (phase.allocation.length ? `\n\n**Surplus allocation**\n\n| | Monthly |\n|---|---|\n${alloc}` : '');
}

const retK = accounts.balances.retirement.kevin.amount;
const retH = accounts.balances.retirement.hanna.amount;
const brokK = accounts.balances.brokerage.kevin.amount;
const brokH = accounts.balances.brokerage.hanna.amount;
const cashK = accounts.balances.cash.kevin.amount;
const cashH = accounts.balances.cash.hanna.amount;
const heK = accounts.balances.homeEquity.kevin.amount;
const heH = accounts.balances.homeEquity.hanna.amount;
const combinedNW = retK + retH + brokK + brokH + cashK + cashH + heK + heH;

const currentPhase = goals.phases[0];
function trackerTarget(tracker) { return currentPhase.expenses[tracker.targetExpenseKey]; }

function weeksTable(tracker) {
  if (!tracker.weeks.length) return '*No weeks logged yet this cycle.*';
  return `| Week | Actual | Days |\n|---|---|---|\n${tracker.weeks.map((w) => `| ${w.weekOf} | ${fmt(w.actual)} | ${w.days} |`).join('\n')}`;
}

function tripsTable(travel) {
  const rows = travel.trips.map((t) =>
    `| ${t.label} | ${t.budgetedAmount ? fmt(t.budgetedAmount) : '—'} | ${fmt(t.actual)} |`
  ).join('\n');
  const unmatchedNote = travel.unmatched.length
    ? `\n\n*${travel.unmatched.length} travel-categorized transaction(s) didn't fall inside any planned trip window — review in budget_tracking.json's \`travel.unmatched\`.*`
    : '';
  return `| Trip | Budgeted | Actual |\n|---|---|---|\n${rows}${unmatchedNote}`;
}

const lifeGoalsSection = goals.lifeGoals.map((g, i) =>
  `### ${i + 1}. ${g.name}${g.targetYear ? ` (~${g.targetYear})` : ''}\n- Target: **${fmtK(g.targetAmount)}**${g.status === 'active' ? '' : ` — **${g.status}**`}\n- ${g.note}`
).join('\n\n');

const travelSection = goals.travel.map((t) =>
  `- **${t.year}${t.trip ? ' — ' + t.trip : ''}**${t.budgetedAmount ? ` (~${fmt(t.budgetedAmount)})` : ''}${t.note ? ` — ${t.note}` : ''}`
).join('\n');

const timelineSection = goals.timeline.map((t) => `| ${t.year} | ${t.title}${t.detail ? ' — ' + t.detail : ''} |`).join('\n');
const openDecisionsSection = goals.openDecisions.map((d) => `| ${d.decision} | ${d.status} |`).join('\n');
const careerSection = goals.careerOptions.map((c, i) => `${i + 1}. ${c}`).join('\n');

const md = `# Kevin & Hanna Farino — Life & Financial Goal Plan
*Generated from data/goals.json + data/accounts.json — do not hand-edit. Last regenerated: ${new Date().toISOString().slice(0, 10)} | Framework: ${goals.family.framework}*

---

## 👨‍👩‍👧 Family Profile
- **Kevin Farino** — ${goals.family.profile.kevin}
- **Hanna Kamaric** — ${goals.family.profile.hanna}
- **Baby** — ${goals.family.profile.baby}
- **Location** — ${goals.family.location}
- **Au pair** — ${goals.family.profile.auPair}
- **Kevin's work** — ${goals.family.profile.kevinWork}

---

## 💰 Income by phase

${goals.phases.map((p) => `### Phase ${p.id} — ${p.name} (${p.period})\n${incomeTable(p)}`).join('\n\n')}

---

## 📊 Monthly Expenses by phase

${goals.phases.filter((p) => Object.keys(p.expenses).length).map((p) => `### Phase ${p.id} — ${p.name}\n${expenseTable(p)}`).join('\n\n')}

---

## 🏦 Assets
*As of ${accounts.meta.asOf}. See data/accounts.json for per-field sourcing (Monarch-linked vs. manual).*

| Asset | Kevin | Hanna | Combined |
|---|---|---|---|
| Home equity | ${fmt(heK)} | ${fmt(heH)} | ${fmt(heK + heH)} |
| Retirement | ${fmt(retK)} | ${fmt(retH)} | ${fmt(retK + retH)} |
| Brokerage | ${fmt(brokK)} | ${fmt(brokH)} | ${fmt(brokK + brokH)} |
| Cash | ${fmt(cashK)} | ${fmt(cashH)} | ${fmt(cashK + cashH)} |
| **Combined net worth** | | | **${fmt(combinedNW)}** |

---

## 📅 Spend Tracking
*Three separate trackers — travel is excluded from the other two even when it lands on the same card.*

### Joint (Barclays) — target ${fmt(trackerTarget(budget.joint))}/mo
*Source: ${budget.joint.source}.* ${budget.joint.note}

${weeksTable(budget.joint)}

### Kevin personal — target ${fmt(trackerTarget(budget.kevinPersonal))}/mo
*Source: ${budget.kevinPersonal.source}.* ${budget.kevinPersonal.note}

${weeksTable(budget.kevinPersonal)}

### Travel
${budget.travel.note}

${tripsTable(budget.travel)}

---

## 🎯 Life Goals (confirmed)

${lifeGoalsSection}

---

## ✈️ Travel Goals
*Funded from surplus flex — not a fixed expense.*

${travelSection}

---

## 👶 Family Planning

**Baby #2 target: ${goals.familyPlanning.baby2TargetYear}**
**Baby #3 target: ${goals.familyPlanning.baby3TargetYear}**

${goals.familyPlanning.note}

---

## 💼 Kevin's Career Path

**Target:** $300K+ total comp. Load-bearing for all goals.

${careerSection}

---

## 📋 Open Decisions

| Decision | Status |
|---|---|
${openDecisionsSection}

---

## 🗓️ Timeline

| Date | Event |
|---|---|
${timelineSection}
`;

writeFileSync(outPath, md, 'utf8');
console.log('Wrote kevin_hanna_goal_plan.md');
