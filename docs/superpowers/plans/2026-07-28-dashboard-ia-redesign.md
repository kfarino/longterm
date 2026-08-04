# Dashboard IA & Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `dashboard_v5.html`'s 6-tab nav (Goals & Milestones, Current Position, Phases, Trajectory, Decisions, Month Plan) with 3 tabs (Budget, Long-Term Plan, Decisions), making the weekly budget-check-in workflow (spend pacing + the Month Plan calendar) the default landing view, collapsing Position/Phases/Trajectory/Goals into a reasoned "The Plan → Trajectory → Targets" accordion inside Long-Term Plan, and deleting the confirmed-duplicate all-phases expense grid that Current Position renders today.

**Architecture:** Every new function is built and headlessly tested against its own fresh element ids *before* the real HTML skeleton changes at all (the test harness's `FakeEl` auto-vivifies any id `getElementById` is asked for, regardless of whether that id exists in the live page yet) — so the live app stays 100% functional and unmodified through Tasks 1-7. Task 8 is the one atomic swap of the nav/page skeleton, `show()`, and the init block, plus deletion of the now-superseded `renderGoals`/`renderPosition`/`renderPhases`. Task 9 is required manual browser verification.

**Tech Stack:** Vanilla JS in one `<script>` block in `Longterm/dashboard_v5.html` (no framework, no build step, no backend, opened via `file://`). Chart.js via existing CDN `<script>` tag — unchanged. Tests via the existing headless harness (`Longterm/data/dashboard-test-harness.mjs`).

## Global Constraints

- Zero data-model changes. `goals.json`/`accounts.json`/`budget_tracking.json`/`favorite_places*.json`/`build-data.mjs` are not touched. `window.DATA`'s shape is identical before and after this plan.
- `pg-monthplan` keeps its literal id and everything under it (`renderMonthPlan`, `planRemainingMonth`, `recommendForSlot`, every event chip/form/handler) gets zero internal edits — it just nests inside the new Budget page instead of being its own top-level page.
- No new CSS colors, fonts, or icon library — new visual elements (`.peek-alert`, `.accordion-head`/`.acc-chevron`, `.pc-current`) reuse the existing `--red`/`--navy`/pill/`›`-glyph conventions already in the file, per `Longterm/docs/superpowers/specs/2026-07-28-dashboard-ia-redesign-design.md`.
- Every temporary test script created during a task is deleted before that task's commit (established convention — see `Longterm/docs/superpowers/plans/2026-07-27-unified-month-plan-events.md`).
- Every task's dispatch must instruct the implementer to read the *current* live code in `Longterm/dashboard_v5.html` at the cited line ranges, not assume the file matches this plan's quoted snippets verbatim if earlier tasks in this plan have already shifted line numbers.
- `FakeEl.classList` (`Longterm/data/dashboard-test-harness.mjs`) only supports `add()`/`remove()`/`contains()` — no `toggle()`. Any new code driving `classList` must call `add`/`remove` explicitly, never `.toggle(...)`, or headless tests will throw `TypeError`.
- `FakeEl` has no `scrollIntoView`. Any new code calling it must guard: `el.scrollIntoView && el.scrollIntoView(...)` — do not add a harness stub for this.

---

### Task 1: `renderUrgentPeek()` — urgent-decision peek alert

**Files:**
- Modify: `Longterm/dashboard_v5.html` (new function + new CSS rule)
- Modify: `Longterm/data/dashboard-test-harness.mjs` (`exportNames`)
- Test: `Longterm/data/test-urgent-peek.mjs` (new, temporary)

**Interfaces:**
- Consumes: `D.decisions` (existing shape, array of `{status, title, body, action}`).
- Produces: `renderUrgentPeek() -> string` — a pure string builder (same pattern as the existing `renderBudgetTracking()`, dashboard_v5.html:925), no DOM writes. Returns `''` when there are zero urgent decisions. Consumed by Task 2's `renderBudgetTab()`.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-urgent-peek.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const noUrgent = loadDashboard({ decisions: [{ status: 'good', title: 'x', body: 'y', action: 'z' }] });
assert.equal(noUrgent.renderUrgentPeek(), '', 'zero urgent decisions should render nothing');

const oneUrgent = loadDashboard({ decisions: [{ status: 'urgent', title: 'Build a plan', body: 'b', action: 'a' }] });
const html1 = oneUrgent.renderUrgentPeek();
assert.ok(html1.includes('1 urgent decision needs attention'));
assert.ok(html1.includes('peek-alert'));
assert.ok(html1.includes("show('decisions'"));

const twoUrgent = loadDashboard({
  decisions: [
    { status: 'urgent', title: 'A', body: 'b', action: 'a' },
    { status: 'urgent', title: 'B', body: 'b', action: 'a' },
    { status: 'good', title: 'C', body: 'b', action: 'a' },
  ],
});
assert.ok(twoUrgent.renderUrgentPeek().includes('2 urgent decisions need attention'));

console.log('All renderUrgentPeek tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-urgent-peek.mjs`
Expected: `TypeError` — `renderUrgentPeek` is not a function (not defined yet, and not yet in `exportNames`).

- [ ] **Step 3: Add the export name**

In `Longterm/data/dashboard-test-harness.mjs`, find the `exportNames` array (currently ends `'onEventNameInput', 'resolveEventFields', 'onSaveEvent', 'onDismissLiveEvent',`) and add on a new line:
```js
  'renderUrgentPeek',
```

- [ ] **Step 4: Implement `renderUrgentPeek()`**

In `Longterm/dashboard_v5.html`, read the current `renderDecisions()` function (starts at line 963, confirm against the live file) and add the new function directly before it:
```js
/* ═══════════════════════════════
   RENDER: URGENT-DECISION PEEK (Budget tab)
   ═══════════════════════════════ */
function renderUrgentPeek() {
  const n = D.decisions.filter((d) => d.status === 'urgent').length;
  if (!n) return '';
  const label = n === 1 ? '1 urgent decision needs attention' : `${n} urgent decisions need attention`;
  return `<div class="peek-alert" onclick="show('decisions', $('ntab-decisions'))"><span>⚠ ${label}</span><span>›</span></div>`;
}
```

- [ ] **Step 5: Add the CSS rule**

In `Longterm/dashboard_v5.html`, find the `@media(max-width:900px)` rule (currently starts at line 143). Add directly before it:
```css
.peek-alert{
  display:flex;justify-content:space-between;align-items:center;
  background:#fef2f2;border:1px solid #fecaca;border-radius:3px;
  padding:12px 16px;margin-bottom:20px;font-size:13px;font-weight:600;color:var(--red);
  cursor:pointer;transition:background .15s,border-color .15s;
}
.peek-alert:hover{background:#fee2e2;border-color:#fca5a5}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node Longterm/data/test-urgent-peek.mjs`
Expected: `All renderUrgentPeek tests passed.`

- [ ] **Step 7: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-urgent-peek.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add renderUrgentPeek() urgent-decision alert for the new Budget tab"
```

---

### Task 2: `renderBudgetTab()` — merge spend-tracking + Month Plan

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-budget-tab.mjs` (new, temporary)

**Interfaces:**
- Consumes: Task 1's `renderUrgentPeek()`, existing `renderBudgetTracking()` (dashboard_v5.html:925), existing `renderMonthPlan()` (dashboard_v5.html:827).
- Produces: `renderBudgetTab()` — writes to `$('pg-budget')`, no return value. This becomes the eagerly-rendered default tab in Task 8's init block.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-budget-tab.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
d.renderBudgetTab();
const budgetHtml = d.elements['pg-budget'].innerHTML;

assert.ok(budgetHtml.includes('pg-monthplan'), 'pg-budget should contain the nested pg-monthplan mount point');
assert.ok(budgetHtml.includes('Joint (Barclays)'), 'spend tracking should be part of the Budget tab');
assert.ok(budgetHtml.includes('Kevin personal'));

const monthPlanHtml = d.elements['pg-monthplan'].innerHTML;
assert.ok(monthPlanHtml.includes('Month Plan'), 'renderMonthPlan() should have run and populated the nested pg-monthplan div');

console.log('All renderBudgetTab tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-budget-tab.mjs`
Expected: `TypeError` — `renderBudgetTab` is not a function.

- [ ] **Step 3: Add the export name**

In `Longterm/data/dashboard-test-harness.mjs`, extend `exportNames` with:
```js
  'renderBudgetTab',
```

- [ ] **Step 4: Implement `renderBudgetTab()`**

In `Longterm/dashboard_v5.html`, add directly after `renderUrgentPeek()` (added in Task 1):
```js
/* ═══════════════════════════════
   RENDER: BUDGET TAB (default/first tab)
   ═══════════════════════════════ */
function renderBudgetTab() {
  $('pg-budget').innerHTML = `
    <div class="content">
      ${renderUrgentPeek()}
      ${renderBudgetTracking()}
      <div id="pg-monthplan"></div>
    </div>`;
  renderMonthPlan();
}
```
Note: `renderMonthPlan()` (unchanged, dashboard_v5.html:827) already targets `$('pg-monthplan')` internally — calling it after the innerHTML assignment above is what populates that nested div, exactly mirroring how `renderMonthPlan()` is invoked today.

- [ ] **Step 5: Run test to verify it passes**

Run: `node Longterm/data/test-budget-tab.mjs`
Expected: `All renderBudgetTab tests passed.`

- [ ] **Step 6: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-budget-tab.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add renderBudgetTab() merging spend-tracking panels with the Month Plan calendar"
```

---

### Task 3: `buildPhaseCardsHTML()` — extracted phase cards with current-phase treatment

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-phase-cards.mjs` (new, temporary)

**Interfaces:**
- Consumes: `D.phases`, `phaseIncome`/`phaseExpenses`/`phaseSurplus` (existing, dashboard_v5.html:201-203), `fmt` (dashboard_v5.html:197), `trHTML` (dashboard_v5.html:213).
- Produces: `buildPhaseCardsHTML() -> string` — pure string builder, one `.phase-card` per `D.phases` entry, no DOM writes. Consumed by Task 4's `renderPlanSection()`. **Phase 1 gets a `.pc-current` badge and shows its expenses directly (no click-to-reveal)**; Phases 2-6 keep today's click-to-expand behavior unchanged; **Phase 2 gains a `.callout`** with the "what's next" comparison text that used to live in `renderPosition()`.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-phase-cards.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
const html = d.buildPhaseCardsHTML();

assert.equal((html.match(/phase-card/g) || []).length, 6, 'should render one card per phase');
assert.ok(html.includes('pc-current'), 'phase 1 should carry the current-phase badge');

const p1Start = html.indexOf(d.D.phases[0].name);
const p2Start = html.indexOf(d.D.phases[1].name);
const p1Segment = html.slice(p1Start, p2Start);
assert.ok(!p1Segment.includes('exp-toggle'), 'the current phase should not use the click-to-reveal toggle');
assert.ok(!p1Segment.includes('display:none'), 'the current phase expenses should be visible by default, not hidden');
Object.keys(d.D.phases[0].expenses).forEach((label) => {
  assert.ok(p1Segment.includes(label), `current phase should list its "${label}" expense line directly`);
});

const p3Start = html.indexOf(d.D.phases[2].name);
const p2Segment = html.slice(p2Start, p3Start);
assert.ok(p2Segment.includes('callout'), "phase 2 should carry the what's-next callout");
assert.ok(p2Segment.includes('more than covers the gap'));

assert.ok(html.includes('sl-p6'), 'the last phase should still have its interactive expense slider');

console.log('All buildPhaseCardsHTML tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-phase-cards.mjs`
Expected: `TypeError` — `buildPhaseCardsHTML` is not a function.

- [ ] **Step 3: Add the export name**

In `Longterm/data/dashboard-test-harness.mjs`, extend `exportNames` with:
```js
  'buildPhaseCardsHTML',
```

- [ ] **Step 4: Implement `buildPhaseCardsHTML()`**

In `Longterm/dashboard_v5.html`, read the current `renderPhases()` in full (starts at line 402, confirm against the live file — this task does not delete it yet, that happens in Task 8 once `renderPlanSection()` fully supersedes it). Add the new function directly before `renderPhases()`:
```js
// Extracted, pure-string version of the phase-card builder. Phase 1 (the
// current phase) shows its expenses directly instead of behind a click —
// this is what lets Current Position's separate Phase-1 detail panel be
// deleted without losing at-a-glance visibility (see renderPlanSection()).
// Phase 2 carries the "what's next" comparison Position used to show in
// its own panel, now living directly on the card the comparison is about.
function buildPhaseCardsHTML() {
  const p1Surplus = phaseSurplus(D.phases[0]);

  return D.phases.map((p) => {
    const inc = phaseIncome(p);
    const exp = phaseExpenses(p);
    const sur = inc - exp;
    const isCurrent = p.id === 1;
    const incRows = Object.entries(p.income).map(([k, v]) => trHTML(k, fmt(v))).join('');
    const allocRows = p.allocation.map((a) => trHTML(a.label, fmt(a.amount), a.amount < 0 ? 'neg' : '')).join('');

    const expenseSection = isCurrent
      ? `<div class="alloc-head">Expenses</div>
         ${Object.entries(p.expenses).map(([k, v]) => `<div class="tr"><span class="tl">${k}</span><span class="tv muted">${fmt(v)}</span></div>`).join('')}`
      : `<div class="tr exp-toggle" onclick="toggleExpPanel(this)" style="cursor:pointer;margin-top:2px">
          <span class="tl">Expenses <span style="font-size:12px;color:var(--sub)">(expand)</span></span>
          <span class="tv">${fmt(exp)} ›</span>
        </div>
        <div class="exp-lines" style="display:none">
          ${Object.entries(p.expenses).map(([k, v]) => `<div class="tr"><span class="tl" style="padding-left:10px">${k}</span><span class="tv muted">${fmt(v)}</span></div>`).join('')}
        </div>`;

    // Last phase (semi-retirement) special: slider
    const surplusSection = p.id === D.phases.length ? `
      <div class="alloc-head">Monthly expenses — adjust</div>
      <div class="ctrl-row" style="margin-bottom:10px">
        <input type="range" id="sl-p6" min="8000" max="25000" step="500" value="14000" oninput="updateP6()">
        <span class="ctrl-val" id="lbl-p6">$14,000</span>
      </div>
      <div class="p6-exp" id="p6-exp">+$4,000</div>
      <div class="p6-note" id="p6-note">Surplus — savings continue growing</div>
    ` : `
      <div class="pc-surplus" style="color:${p.color}">${sur >= 0 ? '+' : ''}${fmt(sur)}</div>
      <div class="pc-note">${p.note || ''}</div>
      ${allocRows.length ? `<div class="alloc-head">Savings allocation</div>${allocRows}` : ''}
    `;

    const whatsNextCallout = p.id === 2
      ? `<div class="callout">${p.name} more than covers the gap — surplus <strong>${sur >= p1Surplus ? 'increases' : 'decreases'}</strong> into Phase ${p.id}.</div>`
      : '';

    return `
      <div class="phase-card" style="border-top-color:${p.color}">
        <div class="pc-phase" style="color:${p.color}">Phase ${p.id} · ${p.period}${isCurrent ? ' <span class="pc-current">Current</span>' : ''}</div>
        <div class="pc-name">${p.name}</div>
        ${incRows}
        ${expenseSection}
        ${surplusSection}
        ${whatsNextCallout}
      </div>`;
  }).join('');
}
```

- [ ] **Step 5: Add the CSS rule**

In `Longterm/dashboard_v5.html`, add directly after the `.peek-alert` rules added in Task 1:
```css
.pc-current{
  display:inline-block;font-size:11px;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;padding:2px 8px;border-radius:2px;
  background:var(--navy);color:#fff;margin-left:8px;
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node Longterm/data/test-phase-cards.mjs`
Expected: `All buildPhaseCardsHTML tests passed.`

- [ ] **Step 7: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-phase-cards.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add buildPhaseCardsHTML() with current-phase badge and Phase-2 what's-next callout"
```

---

### Task 4: `renderPlanSection()` — today-strip + phase cards, deletes the duplicate expense grid

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-plan-section.mjs` (new, temporary)

**Interfaces:**
- Consumes: Task 3's `buildPhaseCardsHTML()`, existing `updateP6()` (dashboard_v5.html:945), `totalNW()` (dashboard_v5.html:205), `fmt`/`fmtM`, `D.assets`, `D.futureAssets`.
- Produces: `renderPlanSection()` — writes to `$('acc-body-plan')`, calls `updateP6()` after mounting (same post-mount call `renderPhases()` makes today). Consumed by Task 7's `renderLongTermPlan()`.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-plan-section.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
d.renderPlanSection();
const html = d.elements['acc-body-plan'].innerHTML;

assert.ok(html.includes('Monthly surplus'));
assert.ok(html.includes('Asset allocation'));
assert.ok(html.includes('Future assets'));
assert.ok(!html.includes('Fixed monthly expenses by phase'), 'the duplicate all-phases expense grid must not be re-added');
assert.equal((html.match(/phase-card/g) || []).length, 6);
assert.ok(d.elements['lbl-p6'].textContent, 'updateP6() should have run and populated the phase-6 slider label');

console.log('All renderPlanSection tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-plan-section.mjs`
Expected: `TypeError` — `renderPlanSection` is not a function.

- [ ] **Step 3: Add the export name**

In `Longterm/data/dashboard-test-harness.mjs`, extend `exportNames` with:
```js
  'renderPlanSection',
```

- [ ] **Step 4: Implement `renderPlanSection()`**

In `Longterm/dashboard_v5.html`, read the current `renderPosition()` in full (starts at line 304, confirm against the live file) to confirm the exact stat-box/asset-allocation/future-assets markup being reused below. Add the new function directly after `buildPhaseCardsHTML()` (added in Task 3):
```js
/* ═══════════════════════════════
   RENDER: THE PLAN (Long-Term Plan, section 1)
   ═══════════════════════════════ */
function renderPlanSection() {
  const p1 = D.phases[0];
  const p1surplus = phaseSurplus(p1);
  const a = D.assets;

  const futureAssetsHTML = D.futureAssets.map((fa) =>
    trHTML(`${fa.name} (${fa.owner})`, `${fmt(fa.value)} · accessible ${fa.accessibleYear}`, 'muted')
  ).join('');

  $('acc-body-plan').innerHTML = `
    <div class="slabel">Today <span>Phase ${p1.id} of ${D.phases.length} — ${p1.name} · live as of ${D.family.asOf}</span></div>
    <div class="metrics m4">
      <div class="metric c-blue">
        <div class="mlabel">Monthly surplus</div>
        <div class="mval blue">${fmt(p1surplus)}</div>
        <div class="mnote">Current phase — not a future projection</div>
      </div>
      <div class="metric c-gold">
        <div class="mlabel">Retirement accounts</div>
        <div class="mval gold">${fmt(a.retirement.kevin + a.retirement.hanna)}</div>
        <div class="mnote">Both 401K + Roth maxed annually</div>
      </div>
      <div class="metric c-navy">
        <div class="mlabel">Brokerage investments</div>
        <div class="mval">${fmt(a.brokerage.kevin + a.brokerage.hanna)}</div>
        <div class="mnote">Kevin ${fmtM(a.brokerage.kevin)} · Hanna ${fmtM(a.brokerage.hanna)}</div>
      </div>
      <div class="metric c-green">
        <div class="mlabel">Liquid cash</div>
        <div class="mval green">${fmt(a.cash.kevin + a.cash.hanna)}</div>
        <div class="mnote">Hanna ${fmtM(a.cash.hanna)} · Kevin ${fmtM(a.cash.kevin)}</div>
      </div>
    </div>

    <div class="g2">
      <div class="panel">
        <div class="ptitle">Asset allocation</div>
        ${trHTML('Retirement — tax-advantaged', Math.round((a.retirement.kevin + a.retirement.hanna) / totalNW() * 100) + '%')}
        ${trHTML('Brokerage — liquid, taxable', Math.round((a.brokerage.kevin + a.brokerage.hanna) / totalNW() * 100) + '%')}
        ${trHTML('Home equity', Math.round((a.homeEquity.kevin + a.homeEquity.hanna) / totalNW() * 100) + '%')}
        ${trHTML('Cash', Math.round((a.cash.kevin + a.cash.hanna) / totalNW() * 100) + '%')}
      </div>
      <div class="panel">
        <div class="ptitle">Future assets (not liquid today)</div>
        ${futureAssetsHTML}
      </div>
    </div>

    <div class="slabel">Five phases of the plan</div>
    <div class="g3">${buildPhaseCardsHTML()}</div>
  `;

  updateP6();
}
```
Note what is deliberately **not** carried over from `renderPosition()`: the standalone Phase-1 income/expense/allocation panel (now covered by Phase 1's expanded-by-default card from `buildPhaseCardsHTML()`), the "what's next" panel (now a `.callout` on Phase 2's card), and `expGridHTML`, the full duplicate all-phases expense grid (deleted outright — confirmed dead weight, Phases already covers this).

- [ ] **Step 5: Run test to verify it passes**

Run: `node Longterm/data/test-plan-section.mjs`
Expected: `All renderPlanSection tests passed.`

- [ ] **Step 6: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-plan-section.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add renderPlanSection(), deleting Current Position's duplicate all-phases expense grid"
```

---

### Task 5: `renderTargetsSection()` — goals/milestones with a compact retirement stat

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-targets-section.mjs` (new, temporary)

**Interfaces:**
- Consumes: `D.milestones`, `D.goals`, `D.chart`, `computeProjection()` (existing, dashboard_v5.html:1036), `YEARS` (existing, dashboard_v5.html:1005), `fmtM`.
- Produces: `renderTargetsSection()` — writes to `$('acc-body-targets')`, no return value. Its retirement stat's `onclick` calls Task 7's `jumpToTrajectory()`. Consumed by Task 7's `renderLongTermPlan()`.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-targets-section.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
d.renderTargetsSection();
const html = d.elements['acc-body-targets'].innerHTML;

assert.ok(html.includes('Life milestones'));
assert.ok(html.includes('Savings goals'));
assert.ok(!html.includes('Spend tracking'), 'spend tracking now lives on the Budget tab, not Targets');
assert.ok(html.includes('jumpToTrajectory()'), 'the retirement stat should link into the Trajectory section');
assert.ok(!html.includes('safe withdrawal rate'), 'the old standalone retirement-projection callout should be gone, replaced by a compact stat');

console.log('All renderTargetsSection tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-targets-section.mjs`
Expected: `TypeError` — `renderTargetsSection` is not a function.

- [ ] **Step 3: Add the export name**

In `Longterm/data/dashboard-test-harness.mjs`, extend `exportNames` with:
```js
  'renderTargetsSection',
```

- [ ] **Step 4: Implement `renderTargetsSection()`**

In `Longterm/dashboard_v5.html`, read the current `renderGoals()` in full (starts at line 237, confirm against the live file) to confirm the exact milestone/goal-bar markup being reused below. Add the new function directly after `renderPlanSection()` (added in Task 4):
```js
/* ═══════════════════════════════
   RENDER: TARGETS (Long-Term Plan, section 3)
   ═══════════════════════════════ */
function renderTargetsSection() {
  const msHTML = D.milestones.map((m) => `
    <div class="milestone">
      <div class="ms-yr">${m.year}</div>
      <div class="ms-spine"><div class="ms-dot" style="${m.dotColor ? 'background:' + m.dotColor : ''}"></div><div class="ms-line"></div></div>
      <div class="ms-body">
        <div class="ms-title">${m.title}</div>
        <div class="ms-detail">${m.detail}</div>
      </div>
    </div>`).join('');

  const goalsHTML = D.goals.map((g) => {
    const current = g.trackLiveBrokerage ? (D.assets.brokerage.kevin + D.assets.brokerage.hanna) : g.current;
    const pct = Math.min(100, Math.round(current / g.targetAmount * 100));
    return `
      <div class="goal">
        <div class="goal-head">
          <span class="goal-name">${g.name}</span>
          <span class="goal-num">${fmtM(current)} / ${fmtM(g.targetAmount)}</span>
        </div>
        <div class="goal-bar"><div class="goal-fill" style="width:${pct}%;background:${g.color}"></div></div>
        <div class="goal-note">${g.note}</div>
      </div>`;
  }).join('');

  const c = D.chart;
  const proj = computeProjection(c.growthRate, c.liquidRate, c.croatiaK, c.kevin300kYr, c.sabbaticalK, c.sabbaticalYear, c.croatiaYear, c.hannaScenario);
  const ret2050 = proj.ret[YEARS.indexOf(2050)];

  $('acc-body-targets').innerHTML = `
    <div class="slabel">Life milestones</div>
    <div class="panel">${msHTML}</div>

    <div class="slabel">Savings goals</div>
    <div class="g2">
      <div class="panel">
        <div class="ptitle">Progress toward targets</div>
        ${goalsHTML}
      </div>
      <div class="panel">
        <div class="ptitle">Retirement projection</div>
        <div class="tr" onclick="jumpToTrajectory()" style="cursor:pointer">
          <span class="tl">Retirement by 2050 <span style="font-size:12px;color:var(--sub)">(baseline — see full chart)</span></span>
          <span class="tv gold">${fmtM(ret2050)} ›</span>
        </div>
      </div>
    </div>
  `;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node Longterm/data/test-targets-section.mjs`
Expected: `All renderTargetsSection tests passed.`

- [ ] **Step 6: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-targets-section.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add renderTargetsSection() with a compact retirement stat linking into Trajectory"
```

---

### Task 6: `renderTrajectory()` — retarget to `acc-body-trajectory`

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Test: `Longterm/data/test-trajectory-retarget.mjs` (new, temporary)

**Interfaces:**
- Consumes: nothing new.
- Produces: `renderTrajectory()` now writes to `$('acc-body-trajectory')` instead of `$('pg-trajectory')`. **Every other line of this function, and everything it calls (`initChart`, `refreshChart`, `updateStats`, `computeProjection`, the slider/scenario-button event listeners), is untouched.** This is the smallest possible diff — confirm against the live file before editing, since Tasks 1-5 shifted line numbers.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-trajectory-retarget.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
d.renderTrajectory();
assert.ok(d.elements['acc-body-trajectory'], 'renderTrajectory should target acc-body-trajectory now');
assert.ok(d.elements['acc-body-trajectory'].innerHTML.includes('Net worth trajectory'));
assert.equal(d.elements['pg-trajectory'], undefined, 'the old pg-trajectory id should no longer be touched');

console.log('All renderTrajectory retarget tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-trajectory-retarget.mjs`
Expected: fails on the `pg-trajectory` assertion — `d.elements['pg-trajectory']` is currently defined (the function still targets the old id), and `acc-body-trajectory` is currently `undefined`.

- [ ] **Step 3: Retarget the function**

In `Longterm/dashboard_v5.html`, find `renderTrajectory()` (re-locate it — earlier tasks in this plan shifted its line number from 1064). Change only its first line:
```js
function renderTrajectory() {
  $('pg-trajectory').innerHTML = `
```
to:
```js
function renderTrajectory() {
  $('acc-body-trajectory').innerHTML = `
```
Every other line inside the function (the entire template string, and the closing `initChart();` call) stays byte-identical.

- [ ] **Step 4: Run test to verify it passes**

Run: `node Longterm/data/test-trajectory-retarget.mjs`
Expected: `All renderTrajectory retarget tests passed.`

- [ ] **Step 5: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-trajectory-retarget.mjs
git add Longterm/dashboard_v5.html
git commit -m "Retarget renderTrajectory() to acc-body-trajectory for the Long-Term Plan accordion"
```

---

### Task 7: `renderLongTermPlan()` + `toggleAccordion()` + `jumpToTrajectory()`

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-longterm-accordion.mjs` (new, temporary)

**Interfaces:**
- Consumes: Task 4's `renderPlanSection()`, Task 5's `renderTargetsSection()`, Task 6's retargeted `renderTrajectory()`.
- Produces: `renderLongTermPlan()` — writes the 3-section accordion skeleton to `$('pg-longterm')`, then eagerly calls `renderPlanSection()` and `renderTargetsSection()` (cheap, no Chart.js dependency) but **leaves `acc-body-trajectory` empty**. `toggleAccordion(sectionId)` — opens/closes an accordion body; on Trajectory's *first* open, calls `renderTrajectory()` (this is the core risk-mitigation this task exists to prove). `jumpToTrajectory()` — opens Trajectory (rendering it if not already rendered) and scrolls it into view. A new top-level `renderedSections` Set (distinct from the existing `rendered` Set, which Task 8 repurposes for top-level tabs) tracks which accordion bodies have been rendered.

**This is the task that directly protects against the redesign's main regression risk**: `initChart()` (inside `renderTrajectory()`) only produces a correctly-sized chart when its canvas is already laid out and visible — exactly why today's `rendered` Set (dashboard_v5.html:1229) defers Trajectory's render until its tab is shown. Nesting Trajectory one level deeper (inside a collapsed accordion) reintroduces that same risk unless deferred one level further, which is what `renderedSections` does here.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-longterm-accordion.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();

// Wrap the harness's fake Chart constructor to count real construction calls —
// this is what proves the chart isn't built until Trajectory is actually opened,
// and isn't rebuilt on a subsequent close/reopen.
let chartCallCount = 0;
const OriginalChart = global.Chart;
global.Chart = function (...args) { chartCallCount++; return new OriginalChart(...args); };

d.renderLongTermPlan();

assert.ok(d.elements['acc-body-plan'].innerHTML.includes('phase-card'), 'The Plan should render eagerly on first Long-Term Plan visit');
assert.ok(d.elements['acc-body-targets'].innerHTML.includes('Life milestones'), 'Targets should render eagerly on first Long-Term Plan visit');
assert.equal(d.elements['acc-body-trajectory'].innerHTML, '', 'Trajectory should stay unrendered until its accordion is opened');
assert.equal(chartCallCount, 0, 'Chart should not be constructed before Trajectory is opened');

d.toggleAccordion('trajectory');
assert.ok(d.elements['acc-body-trajectory'].innerHTML.includes('Net worth trajectory'), 'opening Trajectory should render it');
assert.equal(chartCallCount, 1, 'Chart should be constructed exactly once on first open');

d.toggleAccordion('trajectory'); // close
d.toggleAccordion('trajectory'); // reopen
assert.equal(chartCallCount, 1, 'reopening should not re-render or re-construct the chart');

console.log('All renderLongTermPlan/toggleAccordion tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-longterm-accordion.mjs`
Expected: `TypeError` — `renderLongTermPlan`/`toggleAccordion` are not functions.

- [ ] **Step 3: Add the export names**

In `Longterm/data/dashboard-test-harness.mjs`, extend `exportNames` with:
```js
  'renderLongTermPlan', 'toggleAccordion', 'jumpToTrajectory',
```

- [ ] **Step 4: Implement**

In `Longterm/dashboard_v5.html`, add directly after `renderTargetsSection()` (added in Task 5):
```js
/* ═══════════════════════════════
   RENDER: LONG-TERM PLAN (accordion of 3 sections)
   ═══════════════════════════════ */
const renderedSections = new Set(); // accordion body ids: currently only 'trajectory' needs lazy rendering

function renderLongTermPlan() {
  $('pg-longterm').innerHTML = `
    <div class="content">
      <div class="accordion-head open" id="acc-head-plan" onclick="toggleAccordion('plan')">
        <span>The Plan</span><span class="acc-chevron">›</span>
      </div>
      <div class="accordion-body" id="acc-body-plan" style="display:block"></div>

      <div class="accordion-head" id="acc-head-trajectory" onclick="toggleAccordion('trajectory')">
        <span>Trajectory</span><span class="acc-chevron">›</span>
      </div>
      <div class="accordion-body" id="acc-body-trajectory" style="display:none"></div>

      <div class="accordion-head" id="acc-head-targets" onclick="toggleAccordion('targets')">
        <span>Targets</span><span class="acc-chevron">›</span>
      </div>
      <div class="accordion-body" id="acc-body-targets" style="display:none"></div>
    </div>`;

  renderPlanSection();
  renderTargetsSection();
}

function toggleAccordion(sectionId) {
  const head = $('acc-head-' + sectionId);
  const body = $('acc-body-' + sectionId);
  const opening = body.style.display !== 'block';
  body.style.display = opening ? 'block' : 'none';
  if (opening) head.classList.add('open'); else head.classList.remove('open');
  if (opening && sectionId === 'trajectory' && !renderedSections.has('trajectory')) {
    renderTrajectory(); // reveal container first, then inject+initChart — order matters, see initChart()
    renderedSections.add('trajectory');
  }
}

function jumpToTrajectory() {
  if (!renderedSections.has('trajectory')) {
    renderTrajectory();
    renderedSections.add('trajectory');
  }
  $('acc-body-trajectory').style.display = 'block';
  $('acc-head-trajectory').classList.add('open');
  const el = $('acc-body-trajectory');
  if (el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
```
Note the `classList.add`/`classList.remove` calls (never `.toggle(...)`) per this plan's Global Constraints — the test harness's `FakeEl.classList` has no `toggle()` method.

- [ ] **Step 5: Add the accordion CSS**

In `Longterm/dashboard_v5.html`, add directly after the `.pc-current` rule (added in Task 3):
```css
.accordion-head{
  display:flex;justify-content:space-between;align-items:center;cursor:pointer;
  padding:14px 0;border-bottom:1px solid var(--rule);
  font-size:14px;font-weight:700;color:var(--navy);user-select:none;
}
.acc-chevron{font-size:13px;color:var(--sub);transition:transform .18s ease,color .15s;display:inline-block}
.accordion-head.open .acc-chevron{transform:rotate(90deg);color:var(--navy)}
.accordion-head:hover .acc-chevron{color:var(--navy)}
.accordion-body{display:none;padding-top:6px}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node Longterm/data/test-longterm-accordion.mjs`
Expected: `All renderLongTermPlan/toggleAccordion tests passed.`

- [ ] **Step 7: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-longterm-accordion.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add renderLongTermPlan()/toggleAccordion()/jumpToTrajectory() with lazy Trajectory rendering"
```

---

### Task 8: Atomic swap — nav, page skeleton, `show()`, init block; delete superseded functions

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-dashboard-integration.mjs` (new, temporary)

**Interfaces:**
- Consumes: every function built in Tasks 1-7.
- Produces: the live dashboard now defaults to the Budget tab; `show(id, el)` operates over `{budget, longterm, decisions}` instead of the old 6 ids; `renderGoals()`, `renderPosition()`, `renderPhases()` and their top-level page divs (`pg-goals`, `pg-position`, `pg-phases`, plus the old top-level `pg-trajectory`/`pg-monthplan`) are deleted.

**This task is intentionally kept as one commit, not split further**: a half-old/half-new nav (e.g. new `show()` logic paired with old page divs, or vice versa) would be an actively broken intermediate state, unlike this repo's usual "every commit is a working state" pattern — splitting it would trade a false sense of finer granularity for a real broken commit in between.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-dashboard-integration.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();

// Eager tabs are populated immediately on load, with zero show() calls.
assert.ok(d.elements['pg-budget'].innerHTML.includes('Month Plan'), 'Budget tab should be eagerly rendered, including Month Plan');
assert.ok(d.elements['pg-budget'].innerHTML.includes('Joint (Barclays)'));
assert.ok(d.elements['pg-decisions'].innerHTML.includes('Decisions'));
assert.equal(d.elements['pg-longterm'], undefined, 'Long-Term Plan should not render until its tab is shown');

// show('longterm', ...) triggers the lazy render; Trajectory stays lazy within it.
const fakeTab = { classList: { add() {}, remove() {} } };
d.show('longterm', fakeTab);
assert.ok(d.elements['pg-longterm'].innerHTML.includes('accordion-head'));
assert.ok(d.elements['acc-body-plan'].innerHTML.includes('phase-card'));
assert.ok(d.elements['acc-body-targets'].innerHTML.includes('Life milestones'));
assert.equal(d.elements['acc-body-trajectory'].innerHTML, '', 'Trajectory should still be lazy after just switching tabs');

d.toggleAccordion('trajectory');
assert.ok(d.elements['acc-body-trajectory'].innerHTML.includes('Net worth trajectory'));

// Preserved interactive behaviors still fire post-redesign.
d.onAddEvent('2026-01-01', 'Test Place', 'mid');
const stored = d.loadMonthPlanState().events['2026-01-01'];
assert.equal(stored.length, 1);
assert.equal(stored[0].name, 'Test Place');

const fakeRow = { nextElementSibling: { style: {} }, querySelector: () => ({ textContent: '$100' }), dataset: {} };
assert.doesNotThrow(() => d.toggleExpPanel(fakeRow), 'Phases 2-6 click-to-expand should still work');
assert.doesNotThrow(() => d.updateP6(), 'the Phase-6 slider handler should still work');

console.log('All atomic-swap integration tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-dashboard-integration.mjs`
Expected: fails — `pg-budget`/`pg-decisions` are not populated on load yet (today's init block still calls `renderGoals()`/`renderPosition()`/`renderPhases()`/`renderDecisions()` into the old 6-tab skeleton), and `show('longterm', ...)` doesn't recognize `'longterm'` as a valid id yet.

- [ ] **Step 3: Add the export name**

In `Longterm/data/dashboard-test-harness.mjs`, extend `exportNames` with:
```js
  'toggleExpPanel',
```

- [ ] **Step 4: Rewrite the nav and page-div skeleton**

In `Longterm/dashboard_v5.html`, find the nav block (currently lines 167-174) and the page-div block (currently lines 176-182 — re-confirm against the live file, prior tasks in this plan did not touch these). Replace both together:
```html
<div class="nav">
  <div class="ntab active"  id="ntab-budget"    onclick="show('budget',this)">Budget</div>
  <div class="ntab"         id="ntab-longterm"  onclick="show('longterm',this)">Long-Term Plan</div>
  <div class="ntab"         id="ntab-decisions" onclick="show('decisions',this)">Decisions</div>
</div>

<!-- pages filled by JS -->
<div class="page active" id="pg-budget"></div>
<div class="page"        id="pg-longterm"></div>
<div class="page"        id="pg-decisions"></div>
```

- [ ] **Step 5: Rewrite `show()`**

Find `show(id, el)` (re-locate — earlier tasks shifted its line number from 1231). Replace the whole function:
```js
function show(id, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('active'));
  $('pg-'+id).classList.add('active');
  el.classList.add('active');
  if (id === 'longterm' && !rendered.has('longterm')) {
    renderLongTermPlan();
    rendered.add('longterm');
  }
}
```
The `rendered` Set declaration directly above `show()` is unchanged (still `const rendered = new Set();`) — it now just tracks top-level tab ids (`'longterm'` only) instead of `'trajectory'`/`'monthplan'`.

- [ ] **Step 6: Rewrite the init block**

Find the INIT block at the bottom of the script (re-locate — currently ends the file around where `renderHeader(); renderGoals(); renderPosition(); renderPhases(); renderDecisions();` appear, confirm against the live file). Replace:
```js
renderHeader();
renderGoals();
renderPosition();
renderPhases();
renderDecisions();
// trajectory renders lazily on first visit
```
with:
```js
renderHeader();
renderBudgetTab();
renderDecisions();
// Long-Term Plan (and, within it, Trajectory) render lazily — see show()/toggleAccordion().
```

- [ ] **Step 7: Delete the superseded functions**

Delete `renderGoals()` and `renderPosition()` in their entirety (fully superseded by `renderBudgetTab()`/`renderPlanSection()`/`renderTargetsSection()`), and delete `renderPhases()` in its entirety (fully superseded by `buildPhaseCardsHTML()` + `renderPlanSection()` — confirm no remaining caller references `renderPhases` anywhere in the file before deleting).

- [ ] **Step 8: Run test to verify it passes**

Run: `node Longterm/data/test-dashboard-integration.mjs`
Expected: `All atomic-swap integration tests passed.`

- [ ] **Step 9: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-dashboard-integration.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Swap dashboard nav to Budget/Long-Term Plan/Decisions, delete superseded render functions"
```

---

### Task 9: Manual real-browser verification with Kevin (required, not automatable)

**Files:** none modified — this is a verification-only task.

Headless tests can only prove the right functions ran, in the right order, with the right call counts — they cannot prove the redesign actually looks and feels right, or that Chart.js renders at the correct size the first time an accordion reveals it. Do not skip or fake this step.

- [ ] **Step 1: Open the file**

Open `Longterm/dashboard_v5.html` directly via `file://` in a real browser (Kevin's actual daily-use environment for this dashboard).

- [ ] **Step 2: Verify the Budget tab (default view)**

Confirm: the Budget tab is active by default; the urgent-decision peek appears if `goals.json`'s `decisions` currently has any `status: "urgent"` entries (it does, per the sabbatical-funding-plan decision) and clicking it switches to the Decisions tab; joint/personal/travel spend-tracking panels render correctly; the Month Plan calendar renders and is fully interactive (add/edit/remove an event via the searchable field, confirm cost auto-fills from a matched favorite, confirm the budget-pacing numbers update).

- [ ] **Step 3: Verify the Long-Term Plan tab**

Switch to it. Confirm "The Plan" is open by default and shows the today-strip + all 6 phase cards, with Phase 1 visibly marked "Current" and its expenses shown without needing a click, and Phase 2 showing the what's-next callout. Expand "Trajectory" — confirm the chart renders at full size immediately (not squished/zero-width), the 5 sliders and 3 scenario buttons all work. Expand "Targets" — confirm milestones and goal progress bars render, and clicking the retirement stat jumps to (and opens, if not already open) the Trajectory section.

- [ ] **Step 4: Verify the Decisions tab**

Confirm urgent/other decisions and decision gates render exactly as before.

- [ ] **Step 5: Verify the 900px mobile breakpoint**

Narrow the browser window below 900px. Confirm the peek alert, accordion headers, and phase-card grid all remain usable — the existing `@media(max-width:900px)` rule needs no changes per this plan, but confirm the new elements don't visually break under it.

- [ ] **Step 6: Get explicit sign-off**

Report back to Kevin what changed and ask him to confirm it looks and works as expected before considering this redesign complete.
