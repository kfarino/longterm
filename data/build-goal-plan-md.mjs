#!/usr/bin/env node
// Regenerates ../kevin_hanna_goal_plan.md as a narrative view of goals.json +
// accounts.json + budget_tracking.json. This file is never hand-edited —
// goals.json is the source of truth for every figure that appears here.
// Run after editing goals.json/accounts.json, same as build-data.mjs.
// Owner columns and personal trackers come from goals.owners[] — no hardcoded
// person ids.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'kevin_hanna_goal_plan.md');

const goals = JSON.parse(readFileSync(join(here, 'goals.json'), 'utf8'));
const accounts = JSON.parse(readFileSync(join(here, 'accounts.json'), 'utf8'));
const budget = JSON.parse(readFileSync(join(here, 'budget_tracking.json'), 'utf8'));

const owners = goals.owners || [];
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

function ownerAmount(bucket, ownerId) {
  return accounts.balances[bucket]?.[ownerId]?.amount || 0;
}

function sumBucket(bucket) {
  return owners.reduce((s, o) => s + ownerAmount(bucket, o.id), 0);
}

const combinedNW =
  sumBucket('retirement') + sumBucket('brokerage') + sumBucket('cash') + sumBucket('homeEquity');

const assetHeader = `| Asset | ${owners.map((o) => o.displayName).join(' | ')} | Combined |`;
const assetSep = `|---|${owners.map(() => '---').join('|')}|---|`;
function assetRow(label, bucket) {
  const cells = owners.map((o) => fmt(ownerAmount(bucket, o.id))).join(' | ');
  return `| ${label} | ${cells} | ${fmt(sumBucket(bucket))} |`;
}

const currentPhase = goals.phases[0];
function trackerTarget(tracker) { return currentPhase.expenses[tracker.targetExpenseKey]; }

function weeksTable(tracker) {
  if (!tracker.weeks?.length) return '*No weeks logged yet this cycle.*';
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

const profile = goals.family.profile || {};
const ownerProfileLines = owners
  .map((o) => `- **${o.displayName}** — ${profile[o.id] || '(no bio yet)'}`)
  .join('\n');
const otherProfileKeys = Object.keys(profile).filter((k) => !owners.some((o) => o.id === k));
const otherProfileLines = otherProfileKeys
  .map((k) => `- **${k}** — ${profile[k]}`)
  .join('\n');

const personalSections = owners.map((o) => {
  const tracker = budget.personal?.[o.id];
  if (!tracker) return '';
  const label = tracker.label || `${o.displayName} personal`;
  return `### ${label} — target ${fmt(trackerTarget(tracker))}/mo
*Source: ${tracker.source}.* ${tracker.note || ''}

${weeksTable(tracker)}`;
}).filter(Boolean).join('\n\n');

const lifeGoalsSection = goals.lifeGoals.map((g, i) =>
  `### ${i + 1}. ${g.name}${g.targetYear ? ` (~${g.targetYear})` : ''}\n- Target: **${fmtK(g.targetAmount)}**${g.status === 'active' ? '' : ` — **${g.status}**`}\n- ${g.note}`
).join('\n\n');

const travelSection = goals.travel.map((t) =>
  `- **${t.year}${t.trip ? ' — ' + t.trip : ''}**${t.budgetedAmount ? ` (~${fmt(t.budgetedAmount)})` : ''}${t.note ? ` — ${t.note}` : ''}`
).join('\n');

const timelineSection = goals.timeline.map((t) => `| ${t.year} | ${t.title}${t.detail ? ' — ' + t.detail : ''} |`).join('\n');
const decisions = goals.decisions || goals.openDecisions || [];
const openDecisionsSection = decisions.map((d) => {
  if (d.decision) return `| ${d.decision} | ${d.status} |`;
  return `| ${d.title} | ${d.status} |`;
}).join('\n');
const careerSection = (goals.careerOptions || []).map((c, i) => `${i + 1}. ${c}`).join('\n');

const md = `# ${goals.family.name} — Life & Financial Goal Plan
*Generated from data/goals.json + data/accounts.json — do not hand-edit. Last regenerated: ${new Date().toISOString().slice(0, 10)} | Framework: ${goals.family.framework}*

---

## Family Profile
${ownerProfileLines}
${otherProfileLines ? otherProfileLines + '\n' : ''}- **Location** — ${goals.family.location}

---

## Income by phase

${goals.phases.map((p) => `### Phase ${p.id} — ${p.name} (${p.period})\n${incomeTable(p)}`).join('\n\n')}

---

## Monthly Expenses by phase

${goals.phases.filter((p) => Object.keys(p.expenses).length).map((p) => `### Phase ${p.id} — ${p.name}\n${expenseTable(p)}`).join('\n\n')}

---

## Assets
*As of ${accounts.meta.asOf}. See data/accounts.json for per-field sourcing (Monarch-linked vs. manual).*

${assetHeader}
${assetSep}
${assetRow('Home equity', 'homeEquity')}
${assetRow('Retirement', 'retirement')}
${assetRow('Brokerage', 'brokerage')}
${assetRow('Cash', 'cash')}
| **Combined net worth** | ${owners.map(() => '').join(' | ')} | **${fmt(combinedNW)}** |

---

## Spend Tracking
*Travel is excluded from joint/personal even when it lands on the same card.*

### Joint — target ${fmt(trackerTarget(budget.joint))}/mo
*Source: ${budget.joint.source}.* ${budget.joint.note || ''}

${weeksTable(budget.joint)}

${personalSections}

### Travel
${budget.travel.note || ''}

${tripsTable(budget.travel)}

---

## Life Goals (confirmed)

${lifeGoalsSection}

---

## Travel Goals
*Funded from surplus flex — not a fixed expense.*

${travelSection}

---

## Family Planning

**Baby #2 target: ${goals.familyPlanning?.baby2TargetYear || '—'}**
**Baby #3 target: ${goals.familyPlanning?.baby3TargetYear || '—'}**

${goals.familyPlanning?.note || ''}

---

## Career Path

${careerSection || '*No career options listed.*'}

---

## Open Decisions

| Decision | Status |
|---|---|
${openDecisionsSection}

---

## Timeline

| Date | Event |
|---|---|
${timelineSection}
`;

writeFileSync(outPath, md, 'utf8');
console.log('Wrote kevin_hanna_goal_plan.md');
