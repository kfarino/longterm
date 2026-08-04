// Longterm/data/test-dashboard-contract.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// dashboard_v5.html's core cross-cutting invariants for the
// Budget / Current Position (Status+Trajectory sub-tabs) / Goals / Decisions
// IA: lazy rendering boundaries, the "reveal container before constructing
// Chart" ordering that jumpToTrajectory() once got backwards, and (since
// 2026-07-31) Month Plan's storage — moved off localStorage onto a fetch()-
// backed local API (see dashboard-server.mjs), which makes every Month Plan
// read/write async now. Run with:
//   node Longterm/data/test-dashboard-contract.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadDashboard } from './dashboard-test-harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));

function fakeTab() {
  return { classList: { add() {}, remove() {}, contains() { return false; } } };
}

function isoDaysAgo(n) {
  const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Tests run strictly sequentially (each awaited before the next starts) —
// loadDashboard() mutates shared global.document/window/fetch state per
// call, so two tests' async work must never interleave.
async function test(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

console.log('test-dashboard-contract.mjs');

await test('at load (no show() calls): budget/goals/decisions populated, position + sub-pages untouched', async () => {
  const d = loadDashboard();
  await d.initReady; // renderBudgetTab() is async (Month Plan's storage is a fetch() call now)
  assert.ok(d.elements['pg-budget'], 'pg-budget should have been rendered into');
  assert.ok(d.elements['pg-budget'].innerHTML.length > 0, 'pg-budget should be populated');
  assert.ok(d.elements['pg-goals'], 'pg-goals should have been rendered into');
  assert.ok(d.elements['pg-goals'].innerHTML.length > 0, 'pg-goals should be populated');
  assert.ok(d.elements['pg-decisions'], 'pg-decisions should have been rendered into');
  assert.ok(d.elements['pg-decisions'].innerHTML.length > 0, 'pg-decisions should be populated');

  assert.equal(d.elements['pg-position'], undefined, 'pg-position must never be touched before the tab is shown');
  assert.equal(d.elements['sub-status'], undefined, 'sub-status must never be touched before the tab is shown');
  assert.equal(d.elements['sub-trajectory'], undefined, 'sub-trajectory must never be touched before the tab is shown');
});

await test("show('position', ...) populates Status but leaves Trajectory empty; Chart not constructed", () => {
  const d = loadDashboard();
  let chartCalls = 0;
  global.Chart = function (ctx, cfg) { chartCalls++; this.data = cfg.data; this.update = () => {}; };

  d.show('position', fakeTab());

  assert.ok(d.elements['sub-status'].innerHTML.length > 0, 'sub-status should be populated by show(position)');
  // sub-trajectory is never even touched (getElementById never called for
  // it) until its sub-tab is switched to — renderPositionTab() only renders
  // Status eagerly, Trajectory stays lazy.
  assert.equal(d.elements['sub-trajectory'], undefined, 'sub-trajectory must stay untouched until its sub-tab is opened (lazy)');
  assert.equal(chartCalls, 0, 'Chart must not be constructed before Trajectory is ever opened');
});

await test("Status no longer includes phase cards (moved to the Goals tab)", () => {
  const d = loadDashboard();
  d.show('position', fakeTab());
  assert.ok(!d.elements['sub-status'].innerHTML.includes('phase-card'), 'Status should not render any .phase-card content');
  assert.ok(d.elements['pg-goals'].innerHTML.includes('phase-card'), 'phase cards should render on the Goals tab instead');
});

await test('Status includes the savings-goal module, positioned right after the "Today" readout', () => {
  const d = loadDashboard();
  d.show('position', fakeTab());
  const html = d.elements['sub-status'].innerHTML;
  assert.ok(html.includes('Progress toward targets'), 'Status should include the savings-goal progress panel');
  assert.ok(html.indexOf('Today') < html.indexOf('Progress toward targets'), 'savings goals should come after the Today module, not before it');
});

await test('first showPosition(trajectory) constructs Chart once; switching away+back does not duplicate it', () => {
  const d = loadDashboard();
  let chartCalls = 0;
  global.Chart = function (ctx, cfg) { chartCalls++; this.data = cfg.data; this.update = () => {}; };

  d.show('position', fakeTab());
  assert.equal(chartCalls, 0, 'sanity: Chart not yet constructed right after show(position)');

  d.showPosition('trajectory', fakeTab());
  assert.ok(d.elements['sub-trajectory'].innerHTML.length > 0, 'trajectory sub-page should be populated after opening');
  assert.equal(chartCalls, 1, 'Chart should be constructed exactly once on first open');

  d.showPosition('status', fakeTab()); // switch away
  d.showPosition('trajectory', fakeTab()); // switch back
  assert.equal(chartCalls, 1, 'Chart must not be constructed a second time on switch-away-and-back');
});

await test('jumpToTrajectory() called cold: switches to Current Position, constructs Chart once, only after the container is already active', () => {
  const d = loadDashboard();
  let chartCalls = 0;
  let activeAtConstruction = null;
  global.Chart = function (ctx, cfg) {
    chartCalls++;
    // Captured *inside* the constructor — this is the specific check that
    // would have caught the original bug, where renderTrajectory()/initChart()
    // ran before the container was ever marked active/visible.
    activeAtConstruction = d.elements['sub-trajectory'].classList.contains('active');
    this.data = cfg.data;
    this.update = () => {};
  };

  assert.equal(d.elements['pg-position'], undefined, 'sanity: Current Position must still be cold before jumpToTrajectory()');

  d.jumpToTrajectory();

  assert.equal(chartCalls, 1, 'Chart should be constructed exactly once by a cold jumpToTrajectory()');
  assert.equal(activeAtConstruction, true, 'container must already be marked active at the moment Chart is constructed');
});

await test('jumpToTrajectory() does not double-construct Chart when Trajectory is already open', () => {
  const d = loadDashboard();
  let chartCalls = 0;
  global.Chart = function (ctx, cfg) { chartCalls++; this.data = cfg.data; this.update = () => {}; };

  d.show('position', fakeTab());
  d.showPosition('trajectory', fakeTab()); // open it directly first
  assert.ok(d.elements['sub-trajectory'].classList.contains('active'));
  assert.equal(chartCalls, 1);

  d.jumpToTrajectory(); // must be a no-op chart-wise since it's already open

  assert.equal(chartCalls, 1, 'jumpToTrajectory must not construct Chart again for an already-open Trajectory section');
});

await test('pg-budget mounts a pg-monthplan mount point, which itself renders real Month Plan content (no leftover stat-strip)', async () => {
  const d = loadDashboard();
  await d.initReady;
  assert.ok(d.elements['pg-budget'].innerHTML.includes('id="pg-monthplan"'), 'pg-budget should mount the pg-monthplan container');
  assert.ok(d.elements['pg-monthplan'], 'pg-monthplan should have been rendered into');
  assert.ok(d.elements['pg-monthplan'].innerHTML.includes('Month Plan'), 'pg-monthplan should contain real Month Plan content');
  assert.ok(!d.elements['pg-monthplan'].innerHTML.includes('Dining budget, rest of cycle'), 'the old dining-budget stat-strip should be gone from the calendar section');
});

await test('renderGoalsTab() renders phase cards and every merged D.timeline entry in order (savings goals live on Status instead)', () => {
  const d = loadDashboard();
  const html = d.elements['pg-goals'].innerHTML;
  assert.ok(!html.includes('Progress toward targets'), 'Goals tab should NOT include the savings-goal progress panel — that moved to Status');
  assert.ok(html.includes('phase-card'), 'Goals tab should include the 6 phase cards');

  // Search for the title inside its own ms-title wrapper, not a bare
  // substring — some entries' detail text mentions another entry's title
  // (e.g. the Sept 2026 entry's detail mentions "LexiCo breakpoint", which
  // is also entry #6's own title), which would otherwise produce a false
  // match at the wrong position.
  const wrap = (t) => `<div class="ms-title">${t.title}</div>`;
  d.D.timeline.forEach((t) => {
    assert.ok(html.includes(wrap(t)), `timeline entry "${t.title}" should appear in Goals`);
  });
  const positions = d.D.timeline.map((t) => html.indexOf(wrap(t)));
  for (let i = 1; i < positions.length; i += 1) {
    assert.ok(positions[i] > positions[i - 1], `timeline entries should render in D.timeline order (entry ${i} out of order)`);
  }
});

await test('renderDecisionsTab(): renders decision cards (no goals, no timeline — "next steps" only)', () => {
  const d = loadDashboard();
  const html = d.elements['pg-decisions'].innerHTML;
  assert.ok(html.includes('Immediate — this week'), 'should render the urgent-decisions panel');
  assert.ok(html.includes('This quarter — 90 days'), 'should render the this-quarter panel');
  assert.ok(!html.includes('ms-title'), 'the milestone timeline should not appear on the Decisions tab (it lives on Goals now)');
  assert.ok(!html.includes('Progress toward targets'), 'savings goals should not appear on the Decisions tab');
});

await test('renderDecisionsTab() color-codes the Decisions nav tab when an urgent decision exists', () => {
  const dUrgent = loadDashboard({ decisions: [{ status: 'urgent', title: 't', body: 'b', action: 'a' }] });
  assert.ok(dUrgent.elements['ntab-decisions'].classList.contains('ntab-urgent'), 'nav tab should get ntab-urgent when an urgent decision exists');

  const dCalm = loadDashboard({ decisions: [{ status: 'watch', title: 't', body: 'b', action: 'a' }] });
  assert.ok(!dCalm.elements['ntab-decisions'].classList.contains('ntab-urgent'), 'nav tab should not be flagged urgent when nothing is urgent');
});

await test('computeTrackerPacing: on-pace vs over-pace variance sign', () => {
  const d = loadDashboard();
  const onPace = d.computeTrackerPacing({ weeks: [{ actual: 100, days: 7 }], cycleDays: 30, target: 1000 });
  assert.ok(onPace.variance < 0, 'low weekly spend against a generous target should project under target (negative variance)');

  const overPace = d.computeTrackerPacing({ weeks: [{ actual: 900, days: 7 }], cycleDays: 30, target: 1000 });
  assert.ok(overPace.variance > 0, 'high weekly spend against a tight target should project over target (positive variance)');
});

await test('renderCategoryDrilldown: renders every category (with its own line-item drill-down) and fallbacks when empty', () => {
  const d = loadDashboard();
  const withData = d.renderCategoryDrilldown([
    { name: 'Groceries', amount: 400, transactions: [{ date: '2026-07-01', merchant: 'Trader Joes', amount: 280 }, { date: '2026-07-05', merchant: 'Erewhon', amount: 120 }] },
    { name: 'Dining', amount: 250, transactions: [] },
  ], 'drill-test');
  assert.ok(withData.includes('Groceries') && withData.includes('$400'), 'should render category name and amount');
  assert.ok(withData.includes('Dining') && withData.includes('$250'));
  assert.ok(withData.indexOf('Groceries') < withData.indexOf('Dining'), 'should preserve input order (server pre-sorts)');

  // Line items sorted chronologically by the pull script — rendered as-is.
  assert.ok(withData.indexOf('Trader Joes') < withData.indexOf('Erewhon'), 'category transactions should render in the given (chronological) order');
  assert.ok(withData.includes('No line items recorded'), 'a category with an empty transactions array should show its own fallback');

  const empty = d.renderCategoryDrilldown([], 'drill-test-2');
  assert.ok(empty.includes('No category breakdown yet'), 'should show a fallback message when categories is empty');
});

await test('renderSpendTracker: Joint folds in Month Plan\'s planned spend, Kevin personal keeps the plain extrapolated projection', () => {
  const d = loadDashboard();
  const withPlan = d.renderSpendTracker('Joint (Barclays)', { weeks: [{ actual: 494, days: 3 }], cycleDays: 30, target: 5500 }, 'drill-x', 900);
  assert.ok(withPlan.includes('900 planned (dining, rest of cycle)'), 'should fold the passed planned-spend figure into the note');
  assert.ok(withPlan.includes('$1,394 known so far'), 'should show actual + planned as the known-so-far figure (494 + 900)');

  const noPlan = d.renderSpendTracker('Kevin personal', { weeks: [{ actual: 104, days: 7 }], cycleDays: 30, target: 1000 }, 'drill-y');
  assert.ok(noPlan.includes('projected'), 'without a planned-spend figure, should fall back to the extrapolated-projection wording');
  assert.ok(!noPlan.includes('planned (dining'), 'should not mention planned dining spend when none was passed');
});

await test('nav tab label reads "Planner" (renamed from "Budget")', () => {
  const html = readFileSync(join(here, '..', 'dashboard_v5.html'), 'utf8');
  assert.ok(html.includes('id="ntab-budget"    onclick="show(\'budget\',this)">Planner<'), 'the Budget tab\'s visible label should now read Planner');
});

await test('renderTodosSection: renders items with owner pills, omits null deadlines, shows age, strikes through done items, and renders weekly-goal progress in one list', () => {
  const d = loadDashboard({
    todos: {
      items: [
        { title: 'Fix the AC wall mount', owner: 'kevin', dateAdded: isoDaysAgo(5), deadline: null, done: false },
        { title: 'Buy a gift', owner: 'hanna', dateAdded: isoDaysAgo(2), deadline: '2026-08-15', done: false },
        { title: 'Already handled', owner: 'kevin', dateAdded: isoDaysAgo(10), deadline: null, done: true },
      ],
      weeklyGoals: [
        { title: 'Consulting outreach', owner: 'kevin', target: 5, unit: 'contacts', weekOf: '2026-07-27', count: 2 },
      ],
    },
  });
  const html = d.renderTodosSection();

  assert.ok(html.includes('todo-owner') && html.includes('>Kevin<'), 'should render a Kevin owner pill');
  assert.ok(html.includes('todo-owner-alt') && html.includes('>Hanna<'), 'should render a Hanna owner pill');
  assert.ok(html.includes('Fix the AC wall mount') && html.includes('Added 5 days ago'), 'should render title and age for an item with no deadline');
  assert.ok(!/Fix the AC wall mount[\s\S]{0,80}Due/.test(html), 'an item with deadline: null should not show a "Due" label');
  assert.ok(html.includes('Buy a gift') && html.includes('Due 2026-08-15'), 'an item with a real deadline should show it');
  assert.ok(/todo-done"[^>]*>[\s\S]*?Already handled/.test(html), 'a done item should be wrapped in the todo-done (strikethrough) class');
  assert.ok(html.includes('2 / 5 contacts this week'), 'should render the weekly goal\'s current/target progress');
  assert.ok(!html.includes("This month's action items") && !html.includes('Weekly goals'), 'should be one list, not separate monthly/weekly panels');
  assert.ok(!html.includes('class="g2"'), 'should not use the two-column g2 layout for to-dos');
});

await test('renderTodosSection: fallback message when the combined list is empty', () => {
  const d = loadDashboard({ todos: { items: [], weeklyGoals: [] } });
  const html = d.renderTodosSection();
  assert.ok(html.includes('Nothing on the list right now'), 'should show a fallback when both items and weeklyGoals are empty');
  assert.ok(!html.includes('No weekly goals set'), 'should not show a separate empty weekly-goals fallback');
});

// --- Month Plan storage (read-only fetch — the dashboard displays Month Plan
// but no longer edits it; the Telegram bot writes month_plan_events.json
// directly) ---

await test('loadMonthPlanState reads events through the fake fetch API (display-only, no write path)', async () => {
  const d = loadDashboard(undefined, { '2026-08-05': [{ name: 'Great White', tier: 'high' }] });
  const state = await d.loadMonthPlanState();
  assert.deepEqual(state.events, { '2026-08-05': [{ name: 'Great White', tier: 'high' }] }, 'should read back the seeded events unchanged');
});

await test('a future day with a planned/live-suggested slot renders a plain, non-interactive chip', async () => {
  const d = loadDashboard(undefined, { '2026-08-10': [{ source: 'manual', name: 'Bestia', tier: 'high', cost: 120 }] });
  await d.initReady;
  const html = d.elements['pg-monthplan'].innerHTML;
  assert.ok(html.includes('Bestia'), 'the stored event should be displayed');
  assert.ok(!html.includes('cal-add-event'), 'no "+ add event" control should render');
  assert.ok(!html.includes('cal-event-form'), 'no edit/add form should render');
  assert.ok(!html.includes('onclick'), 'Month Plan chips should carry no click handlers (display-only)');
});

// --- Bot-editable routine days (set_routine_day, via dining-routine-overrides.json) ---

await test('effectiveDiningRoutine moves the matching entry\'s dayOfWeek per a bot-set override, leaving others untouched', async () => {
  const d = loadDashboard();
  const rawRoutine = [
    { dayOfWeek: 3, tier: 'mid', dynamic: false, requiresTag: 'familyFriendly' },
    { dayOfWeek: 5, tier: 'mid', dynamic: true, requiresTag: 'dinnerSpot' },
    { dayOfWeek: 6, tier: 'mid', dynamic: true, requiresTag: 'socialSpot' },
  ];
  const overridden = d.effectiveDiningRoutine(rawRoutine, { family_dinner: 4, date_night: null, weekend_social: null });
  assert.equal(overridden.find((r) => r.requiresTag === 'familyFriendly').dayOfWeek, 4, 'family dinner should move to Thursday');
  assert.equal(overridden.find((r) => r.requiresTag === 'dinnerSpot').dayOfWeek, 5, 'date night should stay untouched');
  assert.equal(overridden.find((r) => r.requiresTag === 'socialSpot').dayOfWeek, 6, 'weekend social should stay untouched');
});

await test('effectiveDiningRoutine passes the routine through unchanged when there are no overrides', async () => {
  const d = loadDashboard();
  const rawRoutine = [{ dayOfWeek: 3, tier: 'mid', dynamic: false, requiresTag: 'familyFriendly' }];
  assert.deepEqual(d.effectiveDiningRoutine(rawRoutine, { family_dinner: null, date_night: null, weekend_social: null }), rawRoutine);
});

await test('loadRoutineOverrides fetches the bot-set override file live (via dashboard-server.mjs\'s GET-only route)', async () => {
  const d = loadDashboard(undefined, {}, { family_dinner: 4, date_night: null, weekend_social: null });
  const overrides = await d.loadRoutineOverrides();
  assert.deepEqual(overrides, { family_dinner: 4, date_night: null, weekend_social: null });
});

await test('loadRoutineOverrides degrades to all-null when the route/file is unavailable', async () => {
  const d = loadDashboard();
  global.fetch = async () => ({ ok: false, json: async () => ({}) });
  const overrides = await d.loadRoutineOverrides();
  assert.deepEqual(overrides, { family_dinner: null, date_night: null, weekend_social: null });
});

console.log('All tests passed.');
