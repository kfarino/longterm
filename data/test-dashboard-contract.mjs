// Longterm/data/test-dashboard-contract.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// dashboard_v5.html's core cross-cutting invariants for the
// Now / Long term / Nights Out IA: lazy Long-term rendering, the "reveal
// container before constructing Chart" ordering that jumpToTrajectory() once
// got backwards, and (since 2026-07-31) Month Plan's storage — moved off
// localStorage onto a fetch()-backed local API (see dashboard-server.mjs),
// which makes every Month Plan read/write async now. Run with:
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

await test('at load: Now + Nights Out populated, Long term untouched', async () => {
  const d = loadDashboard();
  await d.initReady;
  assert.ok(d.elements['pg-now'], 'pg-now should have been rendered into');
  assert.ok(d.elements['pg-now'].innerHTML.length > 0, 'pg-now should be populated');
  assert.ok(d.elements['pg-now'].innerHTML.includes('This stretch'), 'Now opens with the 12-month context rail');
  assert.ok(d.elements['pg-now'].innerHTML.includes('This month'), 'budget sits under the context rail');
  assert.ok(d.elements['pg-dining'], 'pg-dining should have been rendered into');
  assert.ok(d.elements['pg-dining'].innerHTML.length > 0, 'pg-dining should be populated');

  assert.equal(d.elements['pg-long'], undefined, 'pg-long must stay untouched until Long term is opened');
  assert.equal(d.elements['sub-trajectory'], undefined, 'trajectory must stay untouched until Long term is opened');
});

await test("show('long') constructs Chart once against an already-active page", () => {
  const d = loadDashboard();
  let chartCalls = 0;
  let activeAtConstruction = null;
  global.Chart = function (ctx, cfg) {
    chartCalls++;
    activeAtConstruction = d.elements['pg-long'].classList.contains('active');
    this.data = cfg.data;
    this.update = () => {};
  };

  d.show('long', fakeTab());
  assert.equal(chartCalls, 1, 'Chart should construct on first Long term open');
  assert.equal(activeAtConstruction, true, 'pg-long must already be active when Chart constructs');
  assert.ok(d.elements['sub-trajectory'].innerHTML.length > 0, 'trajectory mount should be populated');

  d.show('now', fakeTab());
  d.show('long', fakeTab());
  assert.equal(chartCalls, 1, 'Chart must not construct a second time on switch-away-and-back');
});

await test('every tab switch resets scroll to the top of the page', () => {
  const d = loadDashboard();
  const before = global.window.scrollCalls.length;

  d.show('long', fakeTab());
  d.show('dining', fakeTab());
  d.show('now', fakeTab());

  const calls = global.window.scrollCalls.slice(before);
  assert.equal(calls.length, 3, 'each show() should reset scroll exactly once');
  for (const c of calls) assert.deepEqual(c, [0, 0], 'scroll should reset to the very top');
});

await test('a paused savings goal is labeled paused on Long term', () => {
  const d = loadDashboard({
    goals: [{ name: 'Test Fund', targetAmount: 10000, current: 0, status: 'paused', color: '#2d6a3f', note: 'paused for test' }],
  });
  d.show('long', fakeTab());
  assert.ok(d.elements['pg-long'].innerHTML.includes('Test Fund (paused)'), 'paused goals should show the status next to the name');
});

await test('jumpToTrajectory() called cold: opens Long term, constructs Chart once, only after the page is already active', () => {
  const d = loadDashboard();
  let chartCalls = 0;
  let activeAtConstruction = null;
  global.Chart = function (ctx, cfg) {
    chartCalls++;
    activeAtConstruction = d.elements['pg-long'].classList.contains('active');
    this.data = cfg.data;
    this.update = () => {};
  };

  assert.equal(d.elements['pg-long'], undefined, 'sanity: Long term must still be cold before jumpToTrajectory()');

  d.jumpToTrajectory();

  assert.equal(chartCalls, 1, 'Chart should be constructed exactly once by a cold jumpToTrajectory()');
  assert.equal(activeAtConstruction, true, 'container must already be marked active at the moment Chart is constructed');
});

await test('jumpToTrajectory() does not double-construct Chart when Long term is already open', () => {
  const d = loadDashboard();
  let chartCalls = 0;
  global.Chart = function (ctx, cfg) { chartCalls++; this.data = cfg.data; this.update = () => {}; };

  d.show('long', fakeTab());
  assert.ok(d.elements['pg-long'].classList.contains('active'));
  assert.equal(chartCalls, 1);

  d.jumpToTrajectory();

  assert.equal(chartCalls, 1, 'jumpToTrajectory must not construct Chart again for an already-open Long term page');
});

await test('Trajectory is current balances + savings controls, not income scenarios', () => {
  const d = loadDashboard();
  d.show('long', fakeTab());
  const html = d.elements['sub-trajectory'].innerHTML;
  assert.ok(html.includes('Monthly savings'), 'side panel should have a monthly savings slider');
  assert.ok(html.includes('Start saving'), 'side panel should have a start-year slider');
  assert.ok(html.includes('Growth rate'), 'growth slider stays');
  assert.ok(html.includes('Liquid/Cash rate'), 'liquid slider stays');
  assert.ok(html.includes('Croatia budget'), 'Croatia budget slider stays');
  assert.ok(!html.includes('Hanna scenario'), 'Hanna Fail/Neutral/Success/Croatia scenario row is gone');
  assert.ok(!html.includes('Kevin $300K'), 'Kevin $300k year slider is gone');
  assert.ok(!html.includes('scn-btn'), 'scenario buttons are gone');
});

await test('Now mounts a pg-monthplan mount point, which itself renders real Month Plan content (no leftover stat-strip)', async () => {
  const d = loadDashboard();
  await d.initReady;
  assert.ok(d.elements['pg-now'].innerHTML.includes('id="pg-monthplan"'), 'pg-now should mount the pg-monthplan container');
  assert.ok(d.elements['pg-monthplan'], 'pg-monthplan should have been rendered into');
  assert.ok(d.elements['pg-monthplan'].innerHTML.includes('Month Plan'), 'pg-monthplan should contain real Month Plan content');
  assert.ok(!d.elements['pg-monthplan'].innerHTML.includes('Dining budget, rest of cycle'), 'the old dining-budget stat-strip should be gone from the calendar section');
});

function isoFromToday(days) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

await test('Now stretch is rolling 12 months; later milestones sit on Long term', async () => {
  const d = loadDashboard();
  await d.initReady;
  const nowHtml = d.elements['pg-now'].innerHTML;
  assert.ok(nowHtml.includes('This stretch'), 'Now has the context rail');
  assert.ok(nowHtml.includes('stretch-tl'), 'This stretch is a timeline, not a card scroller');
  d.show('long', fakeTab());
  const longHtml = d.elements['pg-long'].innerHTML;
  assert.ok(longHtml.includes('Later milestones') || longHtml.includes('Vienna') || longHtml.includes('Croatia'), 'Long term keeps far milestones');
});

await test('This stretch timeline places phases, trips, milestones, and decisions on one 12-month axis', async () => {
  const tripStart = isoFromToday(30);
  const tripEnd = isoFromToday(40);
  const mileDate = isoFromToday(80);
  const d = loadDashboard({
    phases: [{
      id: 1,
      color: '#1e4d8c',
      name: 'Test current phase',
      period: `Now → ${isoFromToday(200)}`,
      note: 'fixture phase',
      income: { teddy: 10 },
      expenses: { rent: 1 },
    }],
    travel: [{
      id: 'test-coast',
      trip: 'Test Coast trip',
      startDate: tripStart,
      endDate: tripEnd,
      budgetedAmount: 100,
    }],
    timeline: [
      { year: mileDate, short: 'Test gate', title: 'Test gate', detail: 'in-window fixture' },
      { year: '2045', short: 'Far test', title: 'Far test milestone', detail: 'must not appear on Now' },
    ],
    decisions: [
      { status: 'active', title: 'Test path decision', body: 'say "this" fixture', action: 'fixture action' },
      { status: 'active', title: 'Test second decision', body: 'fixture body', action: 'a' },
    ],
    goals: [],
  });
  await d.initReady;
  const html = d.elements['pg-now'].innerHTML;
  assert.ok(html.includes('class="stretch-tl"') || html.includes("class='stretch-tl'") || html.includes('stretch-tl'), 'timeline root is present');
  assert.ok(html.includes('stretch-month'), 'month ticks mark the axis');
  assert.ok(html.includes('data-kind="phase"') && html.includes('Test current phase'), 'current phase is a span on the timeline');
  assert.ok(html.includes('data-kind="trip"') && html.includes('Test Coast trip'), 'vacation is a span on the timeline');
  assert.ok(html.includes('data-kind="milestone"') && html.includes('Test gate'), 'in-window milestone is a mark');
  assert.ok(html.includes('data-kind="decision"') && html.includes('Test path decision'), 'open decision is a mark');
  assert.ok(html.includes('Test second decision'), 'a quoted body must not swallow the next key row');
  assert.ok(!html.includes('Far test milestone'), 'milestones past the 12-month window stay off Now');
  assert.ok(!html.includes('class="hscroll"'), 'This stretch no longer uses the card scroller');
});

await test('Now tab is flagged urgent when an urgent decision exists', () => {
  const dUrgent = loadDashboard({ decisions: [{ status: 'urgent', title: 't', body: 'b', action: 'a' }] });
  assert.ok(dUrgent.elements['ntab-now'].classList.contains('ntab-urgent'), 'Now tab should get ntab-urgent when an urgent decision exists');

  const dCalm = loadDashboard({ decisions: [{ status: 'watch', title: 't', body: 'b', action: 'a' }] });
  assert.ok(!dCalm.elements['ntab-now'].classList.contains('ntab-urgent'), 'Now tab should not be flagged urgent when nothing is urgent');
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
    { name: 'Dining', amount: 250, transactions: [] },
    { name: 'Groceries', amount: 400, transactions: [{ date: '2026-07-01', merchant: 'Trader Joes', amount: 280 }, { date: '2026-07-05', merchant: 'Erewhon', amount: 120 }] },
  ], 'drill-test');
  assert.ok(withData.includes('Groceries') && withData.includes('$400'), 'should render category name and amount');
  assert.ok(withData.includes('Dining') && withData.includes('$250'));
  assert.ok(withData.indexOf('Groceries') < withData.indexOf('Dining'), 'categories should render highest spend first');

  // Newest first, even when the source array is chronological.
  assert.ok(withData.indexOf('Erewhon') < withData.indexOf('Trader Joes'), 'category line items should render most-recent first');
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

// A total the household corrected by hand (reconcile_tracker, 2026-09-20) is
// folded straight into weeks[].actual, so this panel adds up without knowing
// anything about it. That is the point — but a figure that no longer matches
// Monarch and says nothing about why is how a number becomes a mystery.
await test('renderSpendTracker: names a household correction folded into the total', () => {
  const d = loadDashboard();
  const corrected = d.renderSpendTracker(
    'Joint (Barclays)',
    { weeks: [{ actual: 494, days: 3, adjustment: -100 }], cycleDays: 30, target: 5500, adjustments: [{ amount: -100, reason: 'Matched to the card statement' }] },
    'drill-adj',
  );
  assert.ok(corrected.includes('Matched to the card statement'), 'the reason has to travel with the corrected number');
  assert.ok(/correction/i.test(corrected), 'and it has to be called a correction');

  const plain = d.renderSpendTracker('Joint (Barclays)', { weeks: [{ actual: 494, days: 3 }], cycleDays: 30, target: 5500 }, 'drill-plain');
  assert.ok(!/correction/i.test(plain), 'an untouched tracker says nothing about corrections');
});

// Checking cash is not credit-card debt (2026-09-20). Kevin's personal
// mapping is two Chase cards (negative = owed) plus Ally checking (positive
// = cash). Math.abs() on every mapped row used to add the cash to the owe
// total and count it as a third "card".
const MIXED_CARD_BALANCES = [
  { label: 'CREDIT CARD (...1111)', balance: -1500 },
  { label: 'CREDIT CARD (...2222)', balance: -800 },
  { label: 'Spending Account (...3333)', balance: 2911 },
];

await test('formatCardBalanceLine: two debt cards + checking cash counts only the debts', () => {
  const d = loadDashboard();
  assert.equal(
    d.formatCardBalanceLine(MIXED_CARD_BALANCES),
    'Card balances: $2,300 owed total (2 cards)',
    'Ally-style positive checking must not join the owe total or the card count',
  );
  assert.equal(d.cardDebtOwed(MIXED_CARD_BALANCES), 2300);
});

await test('formatCardBalanceLine: checking-only mapping hides the card-owe line', () => {
  const d = loadDashboard();
  assert.equal(d.formatCardBalanceLine([{ label: 'Spending Account (...3333)', balance: 2911 }]), null);
  assert.equal(d.cardDebtOwed([{ label: 'Spending Account (...3333)', balance: 2911 }]), 0);
});

await test('formatCardBalanceLine: a single debt card stays singular', () => {
  const d = loadDashboard();
  assert.equal(
    d.formatCardBalanceLine([{ label: 'CREDIT CARD (...1111)', balance: -450 }]),
    'Card balance: $450 owed',
  );
});

await test('formatCardBalanceLine: shared due date rides on the owe line; checking has none', () => {
  const d = loadDashboard();
  const sameDue = [
    { label: 'CREDIT CARD (...1111)', balance: -1500, dueDate: '2026-10-03' },
    { label: 'CREDIT CARD (...2222)', balance: -800, dueDate: '2026-10-03' },
    { label: 'Spending Account (...3333)', balance: 2911 },
  ];
  assert.equal(
    d.formatCardBalanceLine(sameDue),
    'Card balances: $2,300 owed total (2 cards, due Oct 3)',
  );

  const splitDue = [
    { label: 'CREDIT CARD (...1111)', balance: -1500, dueDate: '2026-10-03' },
    { label: 'CREDIT CARD (...2222)', balance: -800, dueDate: '2026-10-12' },
  ];
  assert.equal(
    d.formatCardBalanceLine(splitDue),
    'Card balances: $2,300 owed total (2 cards, due Oct 3 / Oct 12)',
  );

  assert.equal(
    d.formatCardBalanceLine([{ label: 'CREDIT CARD (...1111)', balance: -450, dueDate: '2026-10-03' }]),
    'Card balance: $450 owed (due Oct 3)',
  );
});

await test('formatCardBalanceLine: a reconnect-needed card is named, not treated as complete', () => {
  const d = loadDashboard();
  assert.match(
    d.formatCardBalanceLine([{
      label: ' More Mastercard (...9054)',
      balance: -2000,
      syncStatus: 'needs_reconnect',
      lastUpdated: '2026-09-26',
    }]),
    /reconnect in Monarch/,
  );
});

await test('renderSpendTracker: empty weeks on a disconnected card does not read as $0 spend', () => {
  const d = loadDashboard();
  const html = d.renderSpendTracker('Joint (Barclays)', {
    weeks: [],
    cycleStart: '2026-09-25',
    cycleDays: 30,
    target: 4500,
    cardBalances: [{
      label: ' More Mastercard (...9054)',
      balance: -2000,
      syncStatus: 'needs_reconnect',
      lastUpdated: '2026-09-26',
    }],
  }, 'drill-joint');
  assert.match(html, /reconnect in Monarch/);
  assert.match(html, /incomplete/i);
  assert.doesNotMatch(html, /No weeks logged yet this cycle/);
});

// A mapped card the pull found no Monarch account for (remap_account,
// 2026-10-01). Nothing on screen would otherwise say why the total is low —
// cardBalances only gets a row for a label that MATCHED a live account, so a
// dangling mapping is invisible in the one panel it most affects. Same rule
// as a reconcile correction: a total that disagrees with reality states why.
await test('renderSpendTracker: names a mapped card that is no longer in Monarch', () => {
  const d = loadDashboard();
  const html = d.renderSpendTracker('Kevin personal', {
    weeks: [{ actual: 104, days: 7 }],
    cycleStart: '2026-09-16',
    cycleDays: 30,
    target: 1000,
    cardBalances: [{ label: 'Spending Account (...3333)', balance: 2911 }],
    mappedCardsNotFound: ['CREDIT CARD (...1111)'],
  }, 'drill-dangling');
  assert.match(html, /CREDIT CARD \(\.\.\.1111\)/);
  assert.match(html, /no longer in Monarch/i);
  assert.match(html, /incomplete/i);

  const plain = d.renderSpendTracker('Kevin personal', {
    weeks: [{ actual: 104, days: 7 }], cycleStart: '2026-09-16', cycleDays: 30, target: 1000,
  }, 'drill-plain-mapping');
  assert.doesNotMatch(plain, /no longer in Monarch/i, 'silent when every mapped card is real');
});

await test('renderSpendTracker: nothing logged on a dangling mapping does not read as $0 spend', () => {
  const d = loadDashboard();
  const html = d.renderSpendTracker('Kevin personal', {
    weeks: [],
    cycleStart: '2026-09-16',
    cycleDays: 30,
    target: 1000,
    mappedCardsNotFound: ['CREDIT CARD (...1111)'],
  }, 'drill-dangling-empty');
  assert.match(html, /Do not treat this as \$0 spend/);
  assert.doesNotMatch(html, /No weeks logged yet this cycle/);
});

await test('renderSpendTracker: mixed cards+checking meta uses statement cycle + debt-only owe line', () => {
  const d = loadDashboard();
  const html = d.renderSpendTracker('Kevin personal', {
    weeks: [{ actual: 104, days: 7 }],
    cycleStart: '2026-09-16',
    cycleDays: 30,
    target: 1000,
    cardBalances: [
      { label: 'CREDIT CARD (...1111)', balance: -1500, dueDate: '2026-10-03' },
      { label: 'CREDIT CARD (...2222)', balance: -800, dueDate: '2026-10-03' },
      { label: 'Spending Account (...3333)', balance: 2911 },
    ],
  }, 'drill-cards');
  assert.ok(html.includes('Cycle: Sep 16 – Oct 15, 2026'), 'personal cycle is the statement window, not a calendar month');
  assert.ok(html.includes('Card balances: $2,300 owed total (2 cards, due Oct 3)'));
  assert.ok(!html.includes('3 cards'), 'checking is not a card');
  assert.ok(!html.includes('$5,211'), 'checking cash must not be added to owed');
});

await test('liquidCashBreakdown: personal CC debt ignores positive checking', async () => {
  const d = loadDashboard({
    owners: [
      { id: 'kevin', displayName: 'Kevin' },
      { id: 'hanna', displayName: 'Hanna' },
    ],
    assets: { cash: { kevin: 4200, hanna: 1800 } },
    budgetTracking: {
      personal: {
        kevin: {
          cardBalances: MIXED_CARD_BALANCES,
          weeks: [{ actual: 0, days: 1 }],
          cycleStart: '2026-09-16',
          cycleDays: 30,
          target: 1000,
        },
        hanna: {
          cardBalances: [{ label: 'CREDIT CARD (...4444)', balance: -350 }],
          weeks: [{ actual: 0, days: 1 }],
          cycleStart: '2026-09-01',
          cycleDays: 30,
          target: 500,
        },
      },
      joint: {
        cycleStart: '2026-08-25',
        cycleDays: 30,
        weeks: [{ actual: 0, days: 1 }],
        target: 5500,
        cardBalances: [{ label: ' More Mastercard (...5555)', balance: -1200 }],
      },
      travel: { trips: [], unmatched: [] },
    },
  });
  const liq = d.liquidCashBreakdown();
  const kevin = liq.perOwner.find((p) => p.id === 'kevin');
  const hanna = liq.perOwner.find((p) => p.id === 'hanna');
  assert.equal(kevin.cc, 2300, 'Kevin CC debt is the two Chase cards, not Ally cash');
  assert.equal(hanna.cc, 350);
  assert.equal(liq.jointCc, 1200);
  assert.equal(liq.totalCc, 3850);
  await d.initReady;
});

await test('nav tabs are Now, Long term, and Nights Out', () => {
  const html = readFileSync(join(here, '..', 'dashboard_v5.html'), 'utf8');
  assert.ok(html.includes("onclick=\"show('now',this)\">Now<"), 'first tab is Now');
  assert.ok(html.includes("onclick=\"show('long',this)\">Long term<"), 'second tab is Long term');
  assert.ok(html.includes("onclick=\"show('dining',this)\">Nights Out<"), 'dining tab is labeled Nights Out');
  assert.ok(!html.includes('>Planner<'), 'Planner tab is gone');
  assert.ok(!html.includes('>Current Position<'), 'Current Position tab is gone');
  assert.ok(!html.includes('>Dining + Shows<'), 'old Dining + Shows label is gone');
});

await test('renderTodosSection: renders open items with owner pills, omits null deadlines, shows age, hides done items, and renders weekly-goal progress in one list', () => {
  // Owners override so CI (examples use teddy/lilly) still exercises kevin/hanna pills.
  const d = loadDashboard({
    owners: [
      { id: 'kevin', displayName: 'Kevin' },
      { id: 'hanna', displayName: 'Hanna' },
    ],
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

  // Owner pills moved from a two-class kevin/`-alt` scheme to a per-owner
  // class derived from goals.owners (ownerColorClass()). The assertion below
  // tracked the old name and had been failing since that refactor; the pills
  // themselves never regressed — .todo-owner.owner-hanna still carries the
  // same distinct colour the old .todo-owner-alt rule did.
  assert.ok(html.includes('owner-kevin') && html.includes('>Kevin<'), 'should render a Kevin owner pill');
  assert.ok(html.includes('owner-hanna') && html.includes('>Hanna<'), 'should render a Hanna owner pill');
  assert.ok(html.includes('Fix the AC wall mount') && html.includes('Added 5 days ago'), 'should render title and age for an item with no deadline');
  assert.ok(!/Fix the AC wall mount[\s\S]{0,80}Due/.test(html), 'an item with deadline: null should not show a "Due" label');
  assert.ok(html.includes('Buy a gift') && html.includes('Due 2026-08-15'), 'an item with a real deadline should show it');
  assert.ok(!html.includes('Already handled'), 'done items stay in data but should not render on the dashboard');
  assert.ok(html.includes('2 / 5 contacts this week'), 'should render the weekly goal\'s current/target progress');
  assert.ok(!html.includes("This month's action items") && !html.includes('Weekly goals'), 'should be one list, not separate monthly/weekly panels');
  assert.ok(!html.includes('class="g2"'), 'should not use the two-column g2 layout for to-dos');
});

await test('renderTodosSection: fallback message when the combined list is empty', () => {
  const d = loadDashboard({ todos: { items: [], weeklyGoals: [] } });
  const html = d.renderTodosSection();
  assert.ok(html.includes('Nothing on the list right now'), 'should show a fallback when both items and weeklyGoals are empty');
  assert.ok(!html.includes('No weekly goals set'), 'should not show a separate empty weekly-goals fallback');
  assert.ok(html.includes('todo-add') && html.includes('Add'), 'empty list still has a way to create a to-do');
});

await test('renderTodosSection: each open item can be marked done, and there is an add form', () => {
  const d = loadDashboard({
    owners: [
      { id: 'kevin', displayName: 'Kevin' },
      { id: 'hanna', displayName: 'Hanna' },
    ],
    todos: {
      items: [
        { title: 'Fix the AC wall mount', owner: 'kevin', dateAdded: isoDaysAgo(5), deadline: null, done: false },
      ],
      weeklyGoals: [],
    },
  });
  const html = d.renderTodosSection();
  assert.ok(/todo-done/.test(html) && html.includes('Done'), 'open items get a Done control');
  assert.ok(html.includes('Fix the AC wall mount'));
  assert.ok(html.includes('todo-add'), 'there is an add form');
  assert.ok(html.includes('name="title"') || html.includes('id="todo-title"'), 'add form takes a title');
  assert.ok(/kevin|hanna/i.test(html), 'add form can pick an owner');
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
  // Three staleness / environment bugs this assertion has hit:
  //  1. The seeded event carried no `kind`, but isBudgetPlanEvent() has
  //     required kind 'dining'|'family' since 2026-08-04, so the chip was
  //     filtered out and never rendered.
  //  2. The date was hardcoded to 2026-08-10. Month Plan only draws today
  //     through the cycle end, so the fixture silently stopped being a
  //     "future day" once the real clock passed it — same class of bug as
  //     get_dining_plan reading the real clock in test-telegram-recap.mjs.
  //     Derived from today instead, so it can't rot again.
  //  3. Tomorrow is still outside the calendar if data.js's joint cycle
  //     already ended. CI seeds examples (cycleStart 2026-08-01, 31 days →
  //     ended Aug 31); a developer machine with a live current-cycle
  //     data.js still passed. Override the joint window so today+tomorrow
  //     are always inside it. loadDashboard shallow-merges, so the override
  //     must keep travel/personal shape renderBudgetTab() reads.
  const today = isoDaysAgo(0);
  const tomorrow = isoDaysAgo(-1);
  const d = loadDashboard({
    budgetTracking: {
      joint: {
        label: 'Joint household',
        cycleStart: today,
        cycleDays: 30,
        target: 5500,
        weeks: [{ actual: 0, days: 1 }],
      },
      personal: {},
      travel: { trips: [], unmatched: [] },
    },
  }, { [tomorrow]: [{ source: 'manual', kind: 'dining', name: 'Bestia', tier: 'high', cost: 120 }] });
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

await test('planRemainingMonth shows an away chip instead of a live restaurant on a trip stay date', () => {
  const d = loadDashboard();
  const today = new Date(2026, 7, 26);
  const budgetPacing = { cycleStart: '2026-08-25', cycleDays: 30, target: 5500, weeks: [{ actual: 0, days: 1 }] };
  const routine = [{ dayOfWeek: 5, tier: 'mid', dynamic: true, requiresTag: 'dinnerSpot' }];
  const travel = [{ id: 'boston', trip: 'Labor Day — Boston', startDate: '2026-08-28', endDate: '2026-09-07' }];
  const favorites = [{ name: 'Test Bistro', list: 'go-to', dinnerSpot: true, observed: { tier: 'mid', avgSpend: 60 } }];
  const plan = d.planRemainingMonth(routine, budgetPacing, today, {}, favorites, [], [], travel);
  const away = plan.slots.find((s) => s.date === '2026-08-28');
  assert.ok(away, 'Friday during the trip is a routine date-night');
  assert.equal(away.isLive, false);
  assert.equal(away.name, 'Labor Day — Boston');
  assert.ok(!away.picks, 'must not generate an LA restaurant pick');
  assert.equal(away.cost, 0);
});

console.log('All tests passed.');
