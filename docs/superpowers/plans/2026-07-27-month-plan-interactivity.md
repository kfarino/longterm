# Month Plan Interactivity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add dropdown overrides on the Month Plan tab's routine-slot days (Wed/Fri/Sun), ad-hoc cost-tagged events on all other days, both persisted to `localStorage`, and make the tab's budget math override-aware so it stays internally consistent as choices are filled in.

**Architecture:** A small `localStorage`-backed state module (`loadMonthPlanState`/`saveMonthPlanState`/etc.) sits between the DOM and `planRemainingMonth()`, which is rewritten from a two-pass (fixed-cost-lump-sum, then dynamic-resolution) algorithm into a single chronological walk that treats routine slots and ad-hoc events uniformly. `renderMonthPlan()` gains inline `<select>`/event-form markup wired to global `on*` handler functions (the same `onclick="show(...)"` inline-handler pattern already used elsewhere in this file), each of which mutates `localStorage` then calls `renderMonthPlan()` again — one code path for every interaction, no partial-DOM patching.

**Tech Stack:** Vanilla JS in a single `<script>` block inside `Longterm/dashboard_v5.html` (no framework, no build step, no backend — the file is opened directly via `file://`). Tests use the existing headless harness (`Longterm/data/dashboard-test-harness.mjs`), extended with an in-memory `localStorage` stub.

## Global Constraints

- No backend exists. Persistence is `localStorage` only, scoped to one browser/machine — this is an accepted v1 limitation, not a bug to work around.
- `localStorage['monthPlan.v1']` shape: `{ "slotOverrides": { "<ISO date>": {"type":"favorite"|"lowkey","name":"<string>"} }, "events": { "<ISO date>": [{"name":"<string>","tier":"cheap"|"mid"|"high"}] } }`.
- Tier vocabulary throughout stays `cheap|mid|high` (+ `'low-key'` for resolved-dynamic-slot display, exactly as established in the existing dining-recommendations code) — never introduce a parallel `$`/`$$`/`$$$` enum in stored data; only use those symbols for display (`TIER_SYMBOL` maps `cheap→$, mid→$$, high→$$$`).
- Every `localStorage` read/write is wrapped in try/catch; failures degrade to an empty/no-op state, never throw and never break rendering.
- A `slotOverrides` entry referencing a favorite name no longer present in `D.favoritePlaces.places` (or a `lowkey` entry naming an idea no longer in `D.lowKeyHangIdeas`) is treated as absent (falls back to the engine's own recommendation) and is silently dropped from storage on the next write to that date — never thrown, never left dangling forever.
- Every temporary test script created during a task is deleted before that task's commit (established convention — see every prior task in `2026-07-26-dining-recommendations.md`'s history).
- Every task's dispatch must instruct the implementer to read the *current* live code in `Longterm/dashboard_v5.html` at the exact line ranges cited, not assume the file matches this plan's quoted snippets verbatim if earlier tasks in this plan have already shifted line numbers.

---

### Task 1: Extend the test harness with a `localStorage` stub

**Files:**
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-harness-localstorage.mjs` (new, temporary — deleted after passing)

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadDashboard(dataOverride, localStorageSeed)` — `localStorageSeed` is a new, optional second parameter, an object of `{key: string}` pairs pre-populating the fake store before the dashboard's script block evaluates. After any `loadDashboard()` call, `global.localStorage` is a fresh, isolated `FakeLocalStorage` instance (`getItem`/`setItem`/`removeItem`/`clear`) that every later task's tests can read/write directly to set up or assert on persisted state.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-harness-localstorage.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

loadDashboard();
assert.equal(typeof global.localStorage, 'object', 'global.localStorage should be defined after loadDashboard()');
global.localStorage.setItem('foo', 'bar');
assert.equal(global.localStorage.getItem('foo'), 'bar', 'setItem/getItem should round-trip');
assert.equal(global.localStorage.getItem('missing'), null, 'getItem on a missing key should return null, not undefined');
global.localStorage.removeItem('foo');
assert.equal(global.localStorage.getItem('foo'), null, 'removeItem should clear the key');

loadDashboard(undefined, { 'seed-key': 'seed-value' });
assert.equal(global.localStorage.getItem('seed-key'), 'seed-value', 'loadDashboard should accept a localStorage seed as its 2nd argument');

console.log('All harness localStorage stub tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-harness-localstorage.mjs`
Expected: throws `TypeError: Cannot read properties of undefined (reading 'setItem')` (or similar — `global.localStorage` doesn't exist yet).

- [ ] **Step 3: Implement the `localStorage` stub**

In `Longterm/data/dashboard-test-harness.mjs`, add a new class directly after the existing `class FakeEl { ... }` block (currently lines 14-29) and before `const exportNames = [...]`:

```js
class FakeLocalStorage {
  constructor(seed) {
    this._store = new Map(Object.entries(seed || {}));
  }
  getItem(key) { return this._store.has(key) ? this._store.get(key) : null; }
  setItem(key, value) { this._store.set(key, String(value)); }
  removeItem(key) { this._store.delete(key); }
  clear() { this._store.clear(); }
}
```

Then change the `loadDashboard` function signature and wire the stub in. Currently it reads:
```js
export function loadDashboard(dataOverride) {
```
Change to:
```js
export function loadDashboard(dataOverride, localStorageSeed) {
```

Currently, later in the same function, `global.window` is set like this:
```js
  global.window = { DATA: dataOverride ? { ...bundled, ...dataOverride } : bundled };
  global.Chart = function (ctx, cfg) { this.data = cfg.data; this.update = () => {}; };
```
Change to:
```js
  const fakeLocalStorage = new FakeLocalStorage(localStorageSeed);
  global.localStorage = fakeLocalStorage;
  global.window = { DATA: dataOverride ? { ...bundled, ...dataOverride } : bundled, localStorage: fakeLocalStorage };
  global.Chart = function (ctx, cfg) { this.data = cfg.data; this.update = () => {}; };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node Longterm/data/test-harness-localstorage.mjs`
Expected: `All harness localStorage stub tests passed.`

- [ ] **Step 5: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-harness-localstorage.mjs
git add Longterm/data/dashboard-test-harness.mjs
git commit -m "Add localStorage stub to dashboard test harness"
```

---

### Task 2: `localStorage` state module in `dashboard_v5.html`

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs` (add new export names)
- Test: `Longterm/data/test-month-plan-state.mjs` (new, temporary)

**Interfaces:**
- Consumes: the `localStorage` global (real in a browser, `FakeLocalStorage` from Task 1 in tests).
- Produces (new globals, consumed by later tasks):
  - `loadMonthPlanState() -> {slotOverrides: object, events: object}` — always returns a well-formed object, never throws.
  - `saveMonthPlanState(state)` — writes `state` back to `localStorage`, never throws.
  - `setSlotOverride(date, override)` / `clearSlotOverride(date)` — read-modify-write helpers for `slotOverrides`.
  - `addEvent(date, event)` / `removeEvent(date, index)` — read-modify-write helpers for `events`; `removeEvent` deletes the date's key entirely once its array is empty.
  - `resolveOverride(date, overrides, favorites, lowKeyHangIdeas) -> {type, name, favorite?} | null` — validates a `slotOverrides[date]` entry against the current favorites/low-key-ideas lists; returns `null` if absent or stale (dropped from storage on next write to that date, not here — this function only reads).
  - `TIER_SYMBOL` — `{cheap: '$', mid: '$$', high: '$$$'}`, used by Task 5's event UI.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-month-plan-state.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
assert.ok(d.loadMonthPlanState, 'loadMonthPlanState should be defined');

// Empty localStorage -> well-formed default shape.
assert.deepEqual(d.loadMonthPlanState(), { slotOverrides: {}, events: {} }, 'default state should be empty slotOverrides/events');

// setSlotOverride / clearSlotOverride round-trip.
d.setSlotOverride('2026-07-31', { type: 'favorite', name: 'Fancy Spot' });
assert.deepEqual(d.loadMonthPlanState().slotOverrides, { '2026-07-31': { type: 'favorite', name: 'Fancy Spot' } });
d.clearSlotOverride('2026-07-31');
assert.deepEqual(d.loadMonthPlanState().slotOverrides, {}, 'clearSlotOverride should remove the entry');

// addEvent / removeEvent, including empty-array cleanup.
d.addEvent('2026-07-28', { name: 'Cheeky lunch', tier: 'cheap' });
assert.deepEqual(d.loadMonthPlanState().events, { '2026-07-28': [{ name: 'Cheeky lunch', tier: 'cheap' }] });
d.addEvent('2026-07-28', { name: 'Coffee catch-up', tier: 'cheap' });
assert.equal(d.loadMonthPlanState().events['2026-07-28'].length, 2, 'a second event on the same date should append, not replace');
d.removeEvent('2026-07-28', 0);
assert.deepEqual(d.loadMonthPlanState().events['2026-07-28'], [{ name: 'Coffee catch-up', tier: 'cheap' }], 'removeEvent should remove by index');
d.removeEvent('2026-07-28', 0);
assert.equal(d.loadMonthPlanState().events['2026-07-28'], undefined, 'removing the last event should delete the date key entirely, not leave an empty array');

// Corrupt JSON in localStorage -> default shape, no throw.
global.localStorage.setItem('monthPlan.v1', '{not valid json');
assert.deepEqual(d.loadMonthPlanState(), { slotOverrides: {}, events: {} }, 'corrupt JSON should fall back to the default shape');

// resolveOverride: valid favorite, stale favorite, valid lowkey, stale lowkey, absent.
const favorites = [{ name: 'Fancy Spot', cuisine: 'Steak', list: 'go-to', observed: { tier: 'high', avgSpend: 350, visitCount: 2, lastVisited: '2026-06-01' } }];
const lowKeyHangIdeas = ['Movie night in'];
const overrides = {
  slotOverrides: {
    '2026-07-31': { type: 'favorite', name: 'Fancy Spot' },
    '2026-08-02': { type: 'favorite', name: 'No Longer Exists' },
    '2026-08-05': { type: 'lowkey', name: 'Movie night in' },
    '2026-08-07': { type: 'lowkey', name: 'Not A Real Idea' },
  },
  events: {},
};
const valid = d.resolveOverride('2026-07-31', overrides, favorites, lowKeyHangIdeas);
assert.equal(valid.type, 'favorite');
assert.equal(valid.favorite.name, 'Fancy Spot');
assert.equal(d.resolveOverride('2026-08-02', overrides, favorites, lowKeyHangIdeas), null, 'stale favorite override should resolve to null');
const validLowkey = d.resolveOverride('2026-08-05', overrides, favorites, lowKeyHangIdeas);
assert.equal(validLowkey.type, 'lowkey');
assert.equal(d.resolveOverride('2026-08-07', overrides, favorites, lowKeyHangIdeas), null, 'stale lowkey override should resolve to null');
assert.equal(d.resolveOverride('2026-09-01', overrides, favorites, lowKeyHangIdeas), null, 'a date with no override should resolve to null');

assert.deepEqual(d.TIER_SYMBOL, { cheap: '$', mid: '$$', high: '$$$' });

// localStorage.setItem throwing (private-browsing mode, disabled storage,
// a file:// origin that blocks it, etc.) should not propagate — the write
// just silently fails for that session.
const originalSetItem = global.localStorage.setItem.bind(global.localStorage);
global.localStorage.setItem = () => { throw new Error('storage disabled'); };
assert.doesNotThrow(() => d.setSlotOverride('2026-09-01', { type: 'favorite', name: 'Anything' }), 'setSlotOverride should not throw when localStorage.setItem throws');
global.localStorage.setItem = originalSetItem;

console.log('All Month Plan state module tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-month-plan-state.mjs`
Expected: throws `loadMonthPlanState should be defined` (assertion) or a `TypeError` calling `d.loadMonthPlanState`.

- [ ] **Step 3: Add the export names**

In `Longterm/data/dashboard-test-harness.mjs`, the `exportNames` array currently reads:
```js
const exportNames = [
  'D', 'computeProjection', 'phaseIncome', 'phaseExpenses', 'totalNW',
  'renderTrajectory', 'updateP6', 'show',
  'planRemainingMonth', 'recommendForSlot', 'renderMonthPlan', 'cycleEndDate', 'isoDate',
];
```
Change the last line to add the new names:
```js
const exportNames = [
  'D', 'computeProjection', 'phaseIncome', 'phaseExpenses', 'totalNW',
  'renderTrajectory', 'updateP6', 'show',
  'planRemainingMonth', 'recommendForSlot', 'renderMonthPlan', 'cycleEndDate', 'isoDate',
  'loadMonthPlanState', 'saveMonthPlanState', 'setSlotOverride', 'clearSlotOverride',
  'addEvent', 'removeEvent', 'resolveOverride', 'TIER_SYMBOL',
];
```

- [ ] **Step 4: Implement the state module**

In `Longterm/dashboard_v5.html`, find this exact block (currently lines 492-496):
```js
const TIER_MIDPOINT = { cheap: 25, mid: 75, high: 150 };
const TIER_RANK = { cheap: 0, mid: 1, high: 2 };
const RESTAURANTS_HISTORICAL_SHARE = 0.24;
const RECENT_VISIT_EXCLUSION_DAYS = 10;

function cycleEndDate(cycleStartISO, cycleDays) {
```
Insert the following new block between the `RECENT_VISIT_EXCLUSION_DAYS` line and the blank line before `function cycleEndDate`:
```js
const TIER_MIDPOINT = { cheap: 25, mid: 75, high: 150 };
const TIER_RANK = { cheap: 0, mid: 1, high: 2 };
const RESTAURANTS_HISTORICAL_SHARE = 0.24;
const RECENT_VISIT_EXCLUSION_DAYS = 10;
const TIER_SYMBOL = { cheap: '$', mid: '$$', high: '$$$' };
const MONTH_PLAN_STORAGE_KEY = 'monthPlan.v1';

// Reads Month Plan's saved overrides/events. Always returns a well-formed
// {slotOverrides, events} shape — corrupt or missing localStorage data
// degrades to empty, never throws (this feeds an unattended render path,
// same "degrade quietly" convention as build-data.mjs/refreshFavoritePlaces()).
function loadMonthPlanState() {
  try {
    const raw = localStorage.getItem(MONTH_PLAN_STORAGE_KEY);
    if (!raw) return { slotOverrides: {}, events: {} };
    const parsed = JSON.parse(raw);
    return {
      slotOverrides: parsed.slotOverrides || {},
      events: parsed.events || {},
    };
  } catch (err) {
    return { slotOverrides: {}, events: {} };
  }
}

function saveMonthPlanState(state) {
  try {
    localStorage.setItem(MONTH_PLAN_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    // localStorage unavailable (private browsing, disabled storage, a
    // file:// origin with storage off, etc.) — this session just won't
    // persist; rendering still works off whatever was already loaded.
  }
}

function setSlotOverride(date, override) {
  const state = loadMonthPlanState();
  state.slotOverrides[date] = override;
  saveMonthPlanState(state);
}

function clearSlotOverride(date) {
  const state = loadMonthPlanState();
  delete state.slotOverrides[date];
  saveMonthPlanState(state);
}

function addEvent(date, event) {
  const state = loadMonthPlanState();
  if (!state.events[date]) state.events[date] = [];
  state.events[date].push(event);
  saveMonthPlanState(state);
}

function removeEvent(date, index) {
  const state = loadMonthPlanState();
  if (!state.events[date]) return;
  state.events[date].splice(index, 1);
  if (state.events[date].length === 0) delete state.events[date];
  saveMonthPlanState(state);
}

// Validates a slotOverrides[date] entry against the current favorites/
// low-key-ideas lists. Returns null if absent OR stale (e.g. a favorite
// removed from the sheet since the override was saved) — callers treat
// null exactly like "no override", never throw or dangle a bad reference.
// Shared by planRemainingMonth() (budget math) and renderMonthPlan()
// (dropdown default-selection) so the two never disagree about whether
// an override is live.
function resolveOverride(date, overrides, favorites, lowKeyHangIdeas) {
  const override = overrides.slotOverrides[date];
  if (!override) return null;
  if (override.type === 'favorite') {
    const favorite = favorites.find((f) => f.name === override.name);
    return favorite ? { ...override, favorite } : null;
  }
  if (override.type === 'lowkey') {
    return lowKeyHangIdeas.includes(override.name) ? override : null;
  }
  return null;
}

function cycleEndDate(cycleStartISO, cycleDays) {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node Longterm/data/test-month-plan-state.mjs`
Expected: `All Month Plan state module tests passed.`

- [ ] **Step 6: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-month-plan-state.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add Month Plan localStorage state module (overrides, events, resolveOverride)"
```

---

### Task 3: Override-aware `planRemainingMonth()` recompute

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Test: `Longterm/data/test-plan-remaining-month-overrides.mjs` (new, temporary)

**Interfaces:**
- Consumes: `resolveOverride` (Task 2), existing `cycleEndDate`/`isoDate`/`TIER_MIDPOINT` (unchanged).
- Produces: `planRemainingMonth(diningRoutine, budgetPacing, today, overrides, favorites, lowKeyHangIdeas) -> {slots, impliedRestaurantRoom, fixedRoutineCost, socialBudgetRemaining, projectedSpend}`. **Signature change from the existing 3-argument form** — this is an intentional extension beyond the design spec's shorthand (`overrides` alone isn't enough to price a favorite override; `favorites`/`lowKeyHangIdeas` are needed too). Task 4 and Task 6 both call this new 6-argument form. `slots` entries keep their existing shape (`{date, occasion, tier, dynamic, requiresTag}`) plus a new `isEvent` boolean (`true` only for ad-hoc-event pseudo-slots, which never have `requiresTag`).

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-plan-remaining-month-overrides.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const { planRemainingMonth } = loadDashboard();
assert.ok(planRemainingMonth, 'planRemainingMonth should be defined');

const diningRoutine = [
  { dayOfWeek: 3, occasion: 'Family dinner', tier: 'mid', dynamic: false, requiresTag: 'familyFriendly' },
  { dayOfWeek: 5, occasion: 'Date night', tier: 'mid', dynamic: true },
  { dayOfWeek: 0, occasion: 'Weekend social', tier: 'mid', dynamic: true },
];
// 2026-07-27 is a Monday; 2026-07-25 is a Saturday (verified against this
// project's own Task 8 timezone-fix history). cycleStart="2026-07-25",
// cycleDays=16 -> cycleEnd=2026-08-09 (Sunday). Routine occurrences in
// [today..cycleEnd]: Wed Jul29 & Aug5 (fixed), Fri Jul31 & Aug7 (dynamic),
// Sun Aug2 & Aug9 (dynamic) — 6 slots total, in that chronological order.
const today = new Date(2026, 6, 27);
const budgetPacing = { cycleStart: '2026-07-25', cycleDays: 16, target: 1875, weeks: [] };
// impliedRestaurantRoom = (1875 - 0) * 0.24 = 450.
const favorites = [
  { name: 'Fancy Spot', cuisine: 'Steak', list: 'go-to', observed: { tier: 'high', avgSpend: 350, visitCount: 2, lastVisited: '2026-06-01' } },
];
const lowKeyHangIdeas = ['Movie night in'];
const emptyOverrides = { slotOverrides: {}, events: {} };

// --- Baseline: no overrides, no events -> every dynamic slot affordable, all paid.
const baseline = planRemainingMonth(diningRoutine, budgetPacing, today, emptyOverrides, favorites, lowKeyHangIdeas);
assert.equal(baseline.impliedRestaurantRoom, 450);
assert.equal(baseline.fixedRoutineCost, 150, 'two $75 fixed Wed dinners (Jul29, Aug5)');
assert.equal(baseline.projectedSpend, 450);
assert.equal(baseline.socialBudgetRemaining, 0);
assert.equal(baseline.slots.length, 6);
assert.ok(baseline.slots.every((s) => s.tier !== 'low-key'), 'baseline: nothing should resolve low-key, budget covers everything');

// --- Overriding an early dynamic slot to a pricier favorite flips LATER
// unoverridden dynamic slots to low-key (the core recompute behavior).
const overriddenOverrides = { slotOverrides: { '2026-07-31': { type: 'favorite', name: 'Fancy Spot' } }, events: {} };
const withOverride = planRemainingMonth(diningRoutine, budgetPacing, today, overriddenOverrides, favorites, lowKeyHangIdeas);
assert.equal(withOverride.fixedRoutineCost, 150, 'fixedRoutineCost is unaffected by a dynamic-slot override');
assert.equal(withOverride.projectedSpend, 500, '75 (Jul29 fixed) + 350 (Jul31 override) + 0 (Aug2 low-key) + 75 (Aug5 fixed) + 0 + 0');
assert.equal(withOverride.socialBudgetRemaining, -50);
const bySlotDate = Object.fromEntries(withOverride.slots.map((s) => [s.date, s]));
assert.equal(bySlotDate['2026-07-31'].tier, 'mid', 'the overridden slot itself is always honored as paid, never forced low-key');
assert.equal(bySlotDate['2026-08-02'].tier, 'low-key', 'flipped from baseline paid -> low-key by the earlier pricier override');
assert.equal(bySlotDate['2026-08-07'].tier, 'low-key', 'flipped from baseline paid -> low-key');
assert.equal(bySlotDate['2026-08-09'].tier, 'low-key', 'flipped from baseline paid -> low-key');

// --- An ad-hoc event between two dynamic slots reduces budget only for
// slots chronologically AFTER it, not before (walk-order correctness).
const eventOverrides = { slotOverrides: {}, events: { '2026-08-03': [{ name: 'Impromptu lunch', tier: 'high' }] } };
const withEvent = planRemainingMonth(diningRoutine, budgetPacing, today, eventOverrides, favorites, lowKeyHangIdeas);
assert.equal(withEvent.fixedRoutineCost, 150, 'ad-hoc events are not counted in fixedRoutineCost');
assert.equal(withEvent.projectedSpend, 450, '75+75+75 (Jul29,Jul31,Aug2 all paid) + 150 (event) + 75 (Aug5) + 0 + 0 (Aug7,Aug9 flip low-key)');
assert.equal(withEvent.socialBudgetRemaining, 0);
const bySlotDate2 = Object.fromEntries(withEvent.slots.map((s) => [s.date, s]));
assert.equal(bySlotDate2['2026-08-02'].tier, 'mid', 'Aug2 is BEFORE the Aug3 event -> unaffected, still paid');
assert.equal(bySlotDate2['2026-08-07'].tier, 'low-key', 'Aug7 is AFTER the Aug3 event -> budget reduced, flips to low-key');
assert.equal(bySlotDate2['2026-08-09'].tier, 'low-key', 'Aug9 is AFTER the Aug3 event -> flips to low-key');
const eventSlot = withEvent.slots.find((s) => s.date === '2026-08-03');
assert.ok(eventSlot, 'the event itself should appear in slots');
assert.equal(eventSlot.isEvent, true);
assert.equal(eventSlot.occasion, 'Impromptu lunch');
assert.equal(eventSlot.tier, 'high');

// --- A stale override (favorite no longer exists) falls back to the
// engine's own resolution exactly as if there were no override at all.
const staleOverrides = { slotOverrides: { '2026-07-31': { type: 'favorite', name: 'No Longer Exists' } }, events: {} };
const withStale = planRemainingMonth(diningRoutine, budgetPacing, today, staleOverrides, favorites, lowKeyHangIdeas);
assert.equal(withStale.projectedSpend, baseline.projectedSpend, 'a stale override should have zero effect on budget math');
assert.equal(withStale.socialBudgetRemaining, baseline.socialBudgetRemaining);
assert.deepEqual(withStale.slots.map((s) => s.tier), baseline.slots.map((s) => s.tier), 'stale override should not throw and should match baseline exactly');

// --- An event dated outside [today, cycleEnd] (e.g. left over from a prior
// cycle, or a UI bug that let one through) must not affect this cycle's
// budget math or appear in slots.
const outOfRangeOverrides = { slotOverrides: {}, events: { '2026-06-01': [{ name: 'Old cycle leftover', tier: 'high' }], '2026-09-01': [{ name: 'Future cycle', tier: 'high' }] } };
const withOutOfRange = planRemainingMonth(diningRoutine, budgetPacing, today, outOfRangeOverrides, favorites, lowKeyHangIdeas);
assert.equal(withOutOfRange.projectedSpend, baseline.projectedSpend, 'out-of-range events should have zero effect on this cycle\'s budget math');
assert.ok(!withOutOfRange.slots.some((s) => s.isEvent), 'out-of-range events should not appear in slots at all');

console.log('All planRemainingMonth override-recompute tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-plan-remaining-month-overrides.mjs`
Expected: `TypeError` — `planRemainingMonth` still takes 3 arguments and ignores/misuses the extra ones, producing wrong numbers or a crash inside the old two-pass logic.

- [ ] **Step 3: Rewrite `planRemainingMonth`**

In `Longterm/dashboard_v5.html`, replace the entire current `planRemainingMonth` function (currently lines 517-552, from `function planRemainingMonth(diningRoutine, budgetPacing, today) {` through its closing `}` right before the `recommendForSlot` comment) with:

```js
function planRemainingMonth(diningRoutine, budgetPacing, today, overrides, favorites, lowKeyHangIdeas) {
  const cycleEnd = cycleEndDate(budgetPacing.cycleStart, budgetPacing.cycleDays);

  const routineSlots = [];
  for (let d = new Date(today); d <= cycleEnd; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    for (const entry of diningRoutine.filter((r) => r.dayOfWeek === dow)) {
      routineSlots.push({ date: isoDate(d), occasion: entry.occasion, tier: entry.tier, dynamic: entry.dynamic, requiresTag: entry.requiresTag, isEvent: false });
    }
  }

  // Only events dated within [today, cycleEnd] affect this cycle's plan —
  // the UI only ever lets you add one inside that range (Task 5 only shows
  // "+ add event" on today-or-future cells), but filter defensively so a
  // stray out-of-range date in storage (e.g. left over from a prior cycle)
  // can't silently skew this cycle's budget math or go unrendered.
  const todayISO = isoDate(today);
  const cycleEndISO = isoDate(cycleEnd);
  const eventSlots = [];
  for (const [date, dayEvents] of Object.entries(overrides.events || {})) {
    if (date < todayISO || date > cycleEndISO) continue;
    for (const event of dayEvents) {
      eventSlots.push({ date, occasion: event.name, tier: event.tier, dynamic: false, isEvent: true });
    }
  }

  const combined = [...routineSlots, ...eventSlots].sort((a, b) => a.date.localeCompare(b.date));

  const actualToDate = budgetPacing.weeks.reduce((s, w) => s + w.actual, 0);
  const remainingJointRoom = Math.max(0, budgetPacing.target - actualToDate);
  const impliedRestaurantRoom = remainingJointRoom * RESTAURANTS_HISTORICAL_SHARE;

  // Single chronological walk: every "always happens" item (fixed routine
  // slots, ad-hoc events, and any dynamic slot with an override) subtracts
  // its real cost as encountered, in date order, so an item's date position
  // relative to unresolved dynamic slots is what determines whose budget it
  // affects. Unresolved dynamic slots (no override) resolve against
  // whatever's left at that point in the walk.
  let socialBudget = impliedRestaurantRoom;
  let fixedRoutineCost = 0;
  let projectedSpend = 0;
  const resolvedSlots = [];

  for (const slot of combined) {
    if (slot.isEvent) {
      const cost = TIER_MIDPOINT[slot.tier] || 0;
      socialBudget -= cost;
      projectedSpend += cost;
      resolvedSlots.push(slot);
      continue;
    }

    const resolved = resolveOverride(slot.date, overrides, favorites, lowKeyHangIdeas);

    if (!slot.dynamic) {
      // Fixed routine slot — always happens, override-aware cost.
      const cost = resolved
        ? (resolved.type === 'lowkey' ? 0 : (resolved.favorite.observed ? resolved.favorite.observed.avgSpend : (TIER_MIDPOINT[slot.tier] || 0)))
        : (TIER_MIDPOINT[slot.tier] || 0);
      fixedRoutineCost += cost;
      socialBudget -= cost;
      projectedSpend += cost;
      resolvedSlots.push(resolved && resolved.type === 'lowkey' ? { ...slot, tier: 'low-key' } : slot);
      continue;
    }

    if (resolved) {
      // Dynamic slot with a manual override — always honored as picked,
      // its real cost still reduces room for whatever comes later.
      const cost = resolved.type === 'lowkey' ? 0 : (resolved.favorite.observed ? resolved.favorite.observed.avgSpend : (TIER_MIDPOINT[slot.tier] || 0));
      socialBudget -= cost;
      projectedSpend += cost;
      resolvedSlots.push(resolved.type === 'lowkey' ? { ...slot, tier: 'low-key' } : slot);
      continue;
    }

    // Dynamic slot, no override — today's existing affordability logic.
    const cost = TIER_MIDPOINT[slot.tier] || 0;
    if (socialBudget >= cost) {
      socialBudget -= cost;
      projectedSpend += cost;
      resolvedSlots.push(slot);
    } else {
      resolvedSlots.push({ ...slot, tier: 'low-key' });
    }
  }

  return {
    slots: resolvedSlots,
    impliedRestaurantRoom: Math.round(impliedRestaurantRoom),
    fixedRoutineCost: Math.round(fixedRoutineCost),
    socialBudgetRemaining: Math.round(socialBudget),
    projectedSpend: Math.round(projectedSpend),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node Longterm/data/test-plan-remaining-month-overrides.mjs`
Expected: `All planRemainingMonth override-recompute tests passed.`

- [ ] **Step 5: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-plan-remaining-month-overrides.mjs
git add Longterm/dashboard_v5.html
git commit -m "Make planRemainingMonth() override-aware (single chronological pass)"
```

---

### Task 4: Routine-slot dropdown UI in `renderMonthPlan()`

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs` (add new export names)
- Test: `Longterm/data/test-routine-slot-dropdown.mjs` (new, temporary)

**Interfaces:**
- Consumes: `resolveOverride`/`setSlotOverride`/`clearSlotOverride` (Task 2), the new 6-argument `planRemainingMonth` (Task 3), existing `recommendForSlot`.
- Produces: `buildSlotSelect(slot, favorites, recentDiningActivity, lowKeyHangIdeas, overrides) -> string` (an HTML `<select>` + optional reset-button string), `onRoutineSlotChange(date, value)`, `onRoutineSlotReset(date)` — both re-render the tab after mutating state. Task 5 relies on `renderMonthPlan()`'s restructured `!fp` guard (see Step 3) continuing to allow rendering when favorites data is missing.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-routine-slot-dropdown.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
assert.ok(d.buildSlotSelect, 'buildSlotSelect should be defined');

const favorites = [
  { name: 'Great White', cuisine: 'Californian', list: 'go-to', observed: { tier: 'mid', avgSpend: 80, visitCount: 4, lastVisited: '2026-06-01' } },
  { name: 'Fancy Spot', cuisine: 'Steak', list: 'go-to', observed: { tier: 'high', avgSpend: 350, visitCount: 2, lastVisited: '2026-06-01' } },
  { name: 'Amara', cuisine: 'Mediterranean', list: 'want-to-go', observed: null },
];
const lowKeyHangIdeas = ['Movie night in', 'Host game night'];
const slot = { date: '2026-07-31', occasion: 'Date night', tier: 'mid', dynamic: true, isEvent: false };

// No override -> engine's top pick is selected by default.
const noOverride = { slotOverrides: {}, events: {} };
const html1 = d.buildSlotSelect(slot, favorites, [], lowKeyHangIdeas, noOverride);
assert.ok(html1.includes('<select'), 'should render a <select>');
assert.ok(html1.includes('lowkey:Movie night in'), 'dynamic slots should include low-key options');
assert.ok(!html1.includes('cal-reset'), 'no reset button when there is no active override');

// With a valid override -> that option is selected, reset button present.
const withOverride = { slotOverrides: { '2026-07-31': { type: 'favorite', name: 'Fancy Spot' } }, events: {} };
const html2 = d.buildSlotSelect(slot, favorites, [], lowKeyHangIdeas, withOverride);
assert.ok(/<option value="Fancy Spot" selected>/.test(html2), 'the overridden favorite should be the selected option');
assert.ok(html2.includes('onRoutineSlotReset(\'2026-07-31\')'), 'reset button should target the correct date');

// onRoutineSlotChange: favorite selection.
d.onRoutineSlotChange('2026-07-31', 'Great White');
assert.deepEqual(d.loadMonthPlanState().slotOverrides['2026-07-31'], { type: 'favorite', name: 'Great White' });

// onRoutineSlotChange: low-key selection (prefixed value).
d.onRoutineSlotChange('2026-07-31', 'lowkey:Host game night');
assert.deepEqual(d.loadMonthPlanState().slotOverrides['2026-07-31'], { type: 'lowkey', name: 'Host game night' });

// onRoutineSlotReset clears it.
d.onRoutineSlotReset('2026-07-31');
assert.equal(d.loadMonthPlanState().slotOverrides['2026-07-31'], undefined);

// D.favoritePlaces === null: rendering must not throw, must show the
// reduced-functionality callout (events still work, dropdowns don't), and
// must not attempt to build a <select> with no favorites data.
const d2 = loadDashboard({ favoritePlaces: null });
assert.doesNotThrow(() => d2.renderMonthPlan(), 'renderMonthPlan should not throw when favoritePlaces is null');
const htmlNoFp = d2.elements['pg-monthplan'].innerHTML;
assert.ok(htmlNoFp.includes('No favorites synced yet'), 'should show the reduced-functionality callout');
assert.ok(htmlNoFp.includes('Ad-hoc events below still work'), 'callout should clarify events still work');

// Corrupt localStorage JSON should not crash a full render.
global.localStorage.setItem('monthPlan.v1', '{not valid json');
assert.doesNotThrow(() => d.renderMonthPlan(), 'renderMonthPlan should not throw with corrupt localStorage');

console.log('All routine-slot dropdown tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-routine-slot-dropdown.mjs`
Expected: `buildSlotSelect should be defined` (assertion failure) — the function doesn't exist yet.

- [ ] **Step 3: Add the export names**

In `Longterm/data/dashboard-test-harness.mjs`, extend the `exportNames` array (as it stands after Task 2) with three more names:
```js
  'buildSlotSelect', 'onRoutineSlotChange', 'onRoutineSlotReset',
```

- [ ] **Step 4: Implement `buildSlotSelect` and the change/reset handlers**

In `Longterm/dashboard_v5.html`, add the following new functions directly after `recommendForSlot` (i.e. after its closing `}`, before `function renderMonthPlan() {`):

```js
function optionHTML(value, label, selectedValue) {
  return `<option value="${value}"${value === selectedValue ? ' selected' : ''}>${label}</option>`;
}

// Builds the <select> markup for one routine slot: recommendForSlot()'s own
// picks first (pre-selected by default), then every remaining go-to/want-to-go
// favorite, then (dynamic slots only) the low-key ideas — plus a reset button
// when a manual override is active. This is the swap point for a future
// smarter-picker UI without touching planRemainingMonth or the calendar grid.
function buildSlotSelect(slot, favorites, recentDiningActivity, lowKeyHangIdeas, overrides) {
  const rec = recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas);
  const resolved = resolveOverride(slot.date, overrides, favorites, lowKeyHangIdeas);
  const selectedValue = resolved
    ? (resolved.type === 'lowkey' ? `lowkey:${resolved.name}` : resolved.name)
    : (rec.picks[0] || '');

  const topNames = new Set(rec.picks);
  const topOptions = rec.picks.map((name) => optionHTML(name, name, selectedValue)).join('');
  const otherFavorites = favorites
    .filter((f) => (f.list === 'go-to' || f.list === 'want-to-go') && !topNames.has(f.name))
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((f) => optionHTML(f.name, f.name, selectedValue))
    .join('');
  const lowKeyOptions = slot.dynamic
    ? lowKeyHangIdeas.map((idea) => optionHTML(`lowkey:${idea}`, `${idea} (low-key)`, selectedValue)).join('')
    : '';

  const resetBtn = resolved
    ? `<button type="button" class="cal-reset" onclick="onRoutineSlotReset('${slot.date}')" title="Reset to recommendation">↺</button>`
    : '';

  return `<select class="cal-pick-select" onchange="onRoutineSlotChange('${slot.date}', this.value)">${topOptions}<optgroup label="All favorites">${otherFavorites}</optgroup>${lowKeyOptions}</select>${resetBtn}`;
}

function onRoutineSlotChange(date, value) {
  if (value.indexOf('lowkey:') === 0) {
    setSlotOverride(date, { type: 'lowkey', name: value.slice('lowkey:'.length) });
  } else {
    setSlotOverride(date, { type: 'favorite', name: value });
  }
  renderMonthPlan();
}

function onRoutineSlotReset(date) {
  clearSlotOverride(date);
  renderMonthPlan();
}

```

- [ ] **Step 5: Wire `buildSlotSelect` into `renderMonthPlan()` and loosen the `!fp` guard**

In `Longterm/dashboard_v5.html`, `renderMonthPlan()` currently starts like this (read the live function first — Task 3 did not touch this function, so it should still match):

```js
function renderMonthPlan() {
  const joint = D.budgetTracking.joint;
  const fp = D.favoritePlaces;

  if (!fp) {
    $('pg-monthplan').innerHTML = `
      <div class="content">
        <div class="slabel">Month Plan</div>
        <div class="callout">No favorites synced yet — ask Claude to sync your dining list from the Google Sheet.</div>
      </div>`;
    return;
  }

  const favorites = fp.places;
  const recentDiningActivity = fp.recentDiningActivity;
  const diningRoutine = D.diningRoutine;
  const lowKeyHangIdeas = D.lowKeyHangIdeas;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const plan = planRemainingMonth(diningRoutine, joint, today);
```

Per the design spec, ad-hoc events (Task 5) must still work even when `D.favoritePlaces` is null (no Google Sheet sync has ever run) — only the favorites-dependent routine dropdowns are unavailable in that case. Replace this whole opening block (through the `planRemainingMonth` call) with:

```js
function renderMonthPlan() {
  const joint = D.budgetTracking.joint;
  const fp = D.favoritePlaces;
  const favorites = fp ? fp.places : [];
  const recentDiningActivity = fp ? fp.recentDiningActivity : [];
  const diningRoutine = D.diningRoutine;
  const lowKeyHangIdeas = D.lowKeyHangIdeas;
  const overrides = loadMonthPlanState();
  const calloutHTML = fp
    ? ''
    : `<div class="callout">No favorites synced yet — ask Claude to sync your dining list from the Google Sheet. Ad-hoc events below still work; routine-slot picks are limited until then.</div>`;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const plan = planRemainingMonth(diningRoutine, joint, today, overrides, favorites, lowKeyHangIdeas);
```

Then find the existing future-day (non-past) branch, currently:

```js
    } else {
      body = (slotByDate[dISO] || []).map((s) => {
        const rec = recommendForSlot(s, favorites, recentDiningActivity, lowKeyHangIdeas);
        const cls = s.tier === 'low-key' ? 'cal-lowkey' : '';
        return `<div class="cal-occasion ${cls}">${s.occasion}</div><div class="cal-pick ${cls}">${rec.picks.join(', ') || '—'}</div>`;
      }).join('');
    }
```

Replace it with (this introduces the routine-vs-non-routine branch that Task 5 will extend — the non-routine `else` branch below stays exactly as blank as it is today; Task 5 fills it in):

```js
    } else {
      const isRoutineDay = diningRoutine.some((r) => r.dayOfWeek === day.getDay());
      if (isRoutineDay) {
        body = (slotByDate[dISO] || []).filter((s) => !s.isEvent).map((s) => {
          const cls = s.tier === 'low-key' ? 'cal-lowkey' : '';
          const pick = fp
            ? buildSlotSelect(s, favorites, recentDiningActivity, lowKeyHangIdeas, overrides)
            : (recommendForSlot(s, favorites, recentDiningActivity, lowKeyHangIdeas).picks.join(', ') || '—');
          return `<div class="cal-occasion ${cls}">${s.occasion}</div><div class="cal-pick ${cls}">${pick}</div>`;
        }).join('');
      } else {
        body = '';
      }
    }
```

Finally, find the closing template literal, currently:

```js
  $('pg-monthplan').innerHTML = `
    <div class="content">
      <div class="slabel">Month Plan</div>
      <div class="stat-strip">
```

Insert `calloutHTML` right after the `<div class="slabel">Month Plan</div>` line:

```js
  $('pg-monthplan').innerHTML = `
    <div class="content">
      <div class="slabel">Month Plan</div>
      ${calloutHTML}
      <div class="stat-strip">
```

Leave the rest of the function (the stat-strip contents and the closing `cal-grid`) untouched for this task — Task 6 redesigns the stat-strip itself.

- [ ] **Step 6: Add CSS for the dropdown and reset button**

In `Longterm/dashboard_v5.html`, find the existing rule (around line 128):
```css
.cal-lowkey{color:var(--green)}
```
Add directly after it:
```css
.cal-pick-select{font-size:11px;color:var(--mid);width:100%;max-width:130px;margin-top:2px;border:1px solid var(--rule2);border-radius:3px;background:#fff;padding:2px 4px}
.cal-reset{font-size:10px;border:none;background:none;color:var(--sub);cursor:pointer;margin-left:4px;padding:0}
.cal-reset:hover{color:var(--navy)}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node Longterm/data/test-routine-slot-dropdown.mjs`
Expected: `All routine-slot dropdown tests passed.`

Also re-run Task 3's algorithm behavior end-to-end through the real render path as a quick regression check (no separate file needed — do this manually in the same Node REPL-style temporary script before deleting it, or trust Task 3's own test, which still exercises `planRemainingMonth` directly and is unaffected by this task's UI-layer changes).

- [ ] **Step 8: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-routine-slot-dropdown.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add routine-slot dropdown overrides to Month Plan tab"
```

---

### Task 5: Ad-hoc events UI on non-routine days

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs` (add new export names)
- Test: `Longterm/data/test-adhoc-events.mjs` (new, temporary)

**Interfaces:**
- Consumes: `addEvent`/`removeEvent` (Task 2), the `isRoutineDay` branch structure introduced in Task 4 (this task only changes the `else { body = ''; }` arm).
- Produces: `onAddEvent(date, name, tier)`, `onRemoveEvent(date, index)`, `onShowEventForm(date)` — all re-render (or, for `onShowEventForm`, just reveal the inline form) after acting.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-adhoc-events.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
assert.ok(d.onAddEvent, 'onAddEvent should be defined');

// Adding an event persists it.
d.onAddEvent('2026-07-28', 'Cheeky lunch with Sarah', 'cheap');
assert.deepEqual(d.loadMonthPlanState().events['2026-07-28'], [{ name: 'Cheeky lunch with Sarah', tier: 'cheap' }]);

// A second event on the same date appends.
d.onAddEvent('2026-07-28', 'Evening drinks', 'mid');
assert.equal(d.loadMonthPlanState().events['2026-07-28'].length, 2);

// Blank/whitespace-only name is rejected, not saved.
d.onAddEvent('2026-07-29', '   ', 'cheap');
assert.equal(d.loadMonthPlanState().events['2026-07-29'], undefined, 'a blank event name should not be saved');

// Removing by index works and cleans up the date key once empty.
d.onRemoveEvent('2026-07-28', 0);
assert.deepEqual(d.loadMonthPlanState().events['2026-07-28'], [{ name: 'Evening drinks', tier: 'mid' }]);
d.onRemoveEvent('2026-07-28', 0);
assert.equal(d.loadMonthPlanState().events['2026-07-28'], undefined);

// The rendered non-routine cell shows an "+ add event" control and, once
// added, a chip with the tier symbol and a remove button.
d.onAddEvent('2026-07-28', 'Cheeky lunch with Sarah', 'cheap');
d.renderMonthPlan();
const html = d.elements['pg-monthplan'].innerHTML;
assert.ok(html.includes('Cheeky lunch with Sarah'), 'event name should render in the calendar');
assert.ok(html.includes('$'), 'the cheap tier should render as a $ symbol');
assert.ok(html.includes("onRemoveEvent('2026-07-28', 0)"), 'the chip should wire a remove button to the right date/index');
assert.ok(html.includes('+ add event'), 'non-routine days should offer an add-event control');

// onShowEventForm reveals the inline form (style.display flips to 'block').
d.onShowEventForm('2026-07-28');
assert.equal(d.elements['event-form-2026-07-28'].style.display, 'block');

// D.favoritePlaces === null: ad-hoc events must still work, since they
// don't depend on favorites data at all.
const d2 = loadDashboard({ favoritePlaces: null });
d2.onAddEvent('2026-07-28', 'Coffee with a friend', 'cheap');
d2.renderMonthPlan();
const htmlNoFp = d2.elements['pg-monthplan'].innerHTML;
assert.ok(htmlNoFp.includes('Coffee with a friend'), 'ad-hoc events should render even when favoritePlaces is null');

console.log('All ad-hoc events tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-adhoc-events.mjs`
Expected: `onAddEvent should be defined` (assertion failure).

- [ ] **Step 3: Add the export names**

In `Longterm/data/dashboard-test-harness.mjs`, extend the `exportNames` array (as it stands after Task 4) with three more names:
```js
  'onAddEvent', 'onRemoveEvent', 'onShowEventForm',
```

- [ ] **Step 4: Implement the event handlers**

In `Longterm/dashboard_v5.html`, add the following new functions directly after `onRoutineSlotReset` (added in Task 4), before `function renderMonthPlan() {`:

```js
function onAddEvent(date, name, tier) {
  if (!name || !name.trim()) return;
  addEvent(date, { name: name.trim(), tier });
  renderMonthPlan();
}

function onRemoveEvent(date, index) {
  removeEvent(date, index);
  renderMonthPlan();
}

function onShowEventForm(date) {
  const el = $(`event-form-${date}`);
  if (el) el.style.display = 'block';
}
```

- [ ] **Step 5: Fill in the non-routine day branch**

In `Longterm/dashboard_v5.html`, `renderMonthPlan()`'s future-day branch (added in Task 4) currently reads:

```js
    } else {
      const isRoutineDay = diningRoutine.some((r) => r.dayOfWeek === day.getDay());
      if (isRoutineDay) {
        body = (slotByDate[dISO] || []).filter((s) => !s.isEvent).map((s) => {
          const cls = s.tier === 'low-key' ? 'cal-lowkey' : '';
          const pick = fp
            ? buildSlotSelect(s, favorites, recentDiningActivity, lowKeyHangIdeas, overrides)
            : (recommendForSlot(s, favorites, recentDiningActivity, lowKeyHangIdeas).picks.join(', ') || '—');
          return `<div class="cal-occasion ${cls}">${s.occasion}</div><div class="cal-pick ${cls}">${pick}</div>`;
        }).join('');
      } else {
        body = '';
      }
    }
```

Replace the `else { body = ''; }` arm with:

```js
      } else {
        const dayEvents = overrides.events[dISO] || [];
        const eventChips = dayEvents.map((ev, idx) =>
          `<div class="cal-event-chip"><span>${ev.name} · ${TIER_SYMBOL[ev.tier]}</span><button type="button" class="cal-event-remove" onclick="onRemoveEvent('${dISO}', ${idx})">✕</button></div>`
        ).join('');
        body = `${eventChips}<button type="button" class="cal-add-event" onclick="onShowEventForm('${dISO}')">+ add event</button><div id="event-form-${dISO}" class="cal-event-form" style="display:none"><input type="text" id="event-name-${dISO}" placeholder="event name"><select id="event-tier-${dISO}"><option value="cheap">$</option><option value="mid">$$</option><option value="high">$$$</option></select><button type="button" onclick="onAddEvent('${dISO}', $('event-name-${dISO}').value, $('event-tier-${dISO}').value)">Add</button></div>`;
      }
```

- [ ] **Step 6: Add CSS for the event chips and inline form**

In `Longterm/dashboard_v5.html`, directly after the `.cal-reset:hover{color:var(--navy)}` rule added in Task 4, add:

```css
.cal-event-chip{font-size:11px;color:var(--mid);background:var(--bg);border-radius:3px;padding:2px 5px;margin-top:4px;display:flex;justify-content:space-between;align-items:center;gap:4px}
.cal-event-remove{font-size:10px;border:none;background:none;color:var(--sub);cursor:pointer;padding:0}
.cal-event-remove:hover{color:var(--red)}
.cal-add-event{font-size:11px;color:var(--sub);border:none;background:none;cursor:pointer;padding:0;margin-top:4px;text-decoration:underline}
.cal-add-event:hover{color:var(--navy)}
.cal-event-form{margin-top:4px;display:flex;flex-direction:column;gap:3px}
.cal-event-form input,.cal-event-form select{font-size:11px;padding:2px 4px;border:1px solid var(--rule2);border-radius:3px}
```

- [ ] **Step 7: Run test to verify it passes**

Run: `node Longterm/data/test-adhoc-events.mjs`
Expected: `All ad-hoc events tests passed.`

- [ ] **Step 8: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-adhoc-events.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add ad-hoc cost-tagged events on non-routine Month Plan days"
```

---

### Task 6: Summary strip redesign (3 stats + caption)

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Test: `Longterm/data/test-summary-strip.mjs` (new, temporary)

**Interfaces:**
- Consumes: `plan.impliedRestaurantRoom`, `plan.projectedSpend` (Task 3), `fmt` (existing helper).
- Produces: no new exported functions — this task only changes `renderMonthPlan()`'s stat-strip markup, verified by asserting on rendered HTML.

- [ ] **Step 1: Write the failing test**

`renderMonthPlan()` always reads the real wall-clock date internally (`new Date()` — it's not parameterized, and this task doesn't change that), so this test cannot hardcode absolute dates the way Task 3's test did. Instead it computes `today` the same way `renderMonthPlan()` does and derives dates relative to it, making the test deterministic regardless of which real date it happens to run on.

Create `Longterm/data/test-summary-strip.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const goals = {
  diningRoutine: [
    { dayOfWeek: 3, occasion: 'Family dinner', tier: 'mid', dynamic: false, requiresTag: 'familyFriendly' },
    { dayOfWeek: 5, occasion: 'Date night', tier: 'mid', dynamic: true },
    { dayOfWeek: 0, occasion: 'Weekend social', tier: 'mid', dynamic: true },
  ],
  lowKeyHangIdeas: ['Movie night in'],
};
const favoritePlaces = {
  places: [{ name: 'Fancy Spot', cuisine: 'Steak', list: 'go-to', observed: { tier: 'high', avgSpend: 350, visitCount: 2, lastVisited: '2026-06-01' } }],
  recentDiningActivity: [],
};

const today = new Date(); today.setHours(0, 0, 0, 0);
const isoDateLocal = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
// A 60-day cycle starting today always contains multiple Wed/Fri/Sun
// occurrences, regardless of what today actually is.
const budgetTracking = { joint: { cycleStart: isoDateLocal(today), cycleDays: 60, target: 1875, weeks: [] } };
// impliedRestaurantRoom = 1875 * 0.24 = 450 — deterministic, independent of date.

const d = loadDashboard({ diningRoutine: goals.diningRoutine, lowKeyHangIdeas: goals.lowKeyHangIdeas, favoritePlaces, budgetTracking });
d.renderMonthPlan();
let html = d.elements['pg-monthplan'].innerHTML;

assert.ok(html.includes('Dining budget, rest of cycle'), 'renamed stat label should be present');
assert.ok(html.includes('$450'), 'impliedRestaurantRoom should render as $450');
assert.ok(html.includes('Planned spend'), 'new planned-spend stat label should be present');
assert.ok(html.includes('Vs. budget'), 'new vs-budget stat label should be present');
assert.ok(!html.includes('Restaurants room left'), 'old stat label should be gone');
assert.ok(!html.includes('Fixed routine cost'), 'old stat box should be gone (still on the plan object, just not its own box)');
assert.ok(!html.includes('Social budget remaining'), 'old stat label should be gone');
// A 60-day window always contains at least one dynamic (Fri/Sun) slot, so
// the "N paid outings, M low-key hangs" caption format must appear (not
// the "no upcoming occasions" fallback).
assert.ok(/\d+ paid outing/.test(html), 'caption should mention a paid-outings count');
assert.ok(/\d+ low-key hang/.test(html), 'caption should mention a low-key-hangs count');

// Force "over budget" deterministically: find the next 2 Fridays from today
// (a 60-day window always contains at least 2) and override both to the
// $350 favorite. Overridden slots are always honored/subtracted regardless
// of what else resolves, so $700 committed alone guarantees projectedSpend
// ends up over the $450 budget by the end of the walk.
const fridays = [];
for (let dt = new Date(today), i = 0; fridays.length < 2 && i < 60; dt.setDate(dt.getDate() + 1), i += 1) {
  if (dt.getDay() === 5) fridays.push(isoDateLocal(dt));
}
assert.equal(fridays.length, 2, 'a 60-day window must contain at least 2 Fridays');
d.setSlotOverride(fridays[0], { type: 'favorite', name: 'Fancy Spot' });
d.setSlotOverride(fridays[1], { type: 'favorite', name: 'Fancy Spot' });
d.renderMonthPlan();
html = d.elements['pg-monthplan'].innerHTML;
assert.ok(/\$\d+ over budget/.test(html), 'two $350 overrides ($700 total) should exceed the $450 budget and render an "over budget" framing');
assert.ok(html.includes('var(--red)'), 'over-budget delta should be styled red');

console.log('All summary strip redesign tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-summary-strip.mjs`
Expected: fails on the `'Dining budget, rest of cycle'` assertion — the old 4-box labels are still present.

- [ ] **Step 3: Redesign the stat-strip markup**

In `Longterm/dashboard_v5.html`, find the existing block right before the final `$('pg-monthplan').innerHTML = ...` assignment — currently:

```js
  const weekendSocialSlots = plan.slots.filter((s) => diningRoutine.some((r) => r.occasion === s.occasion && r.dynamic));
  const paidSocialCount = weekendSocialSlots.filter((s) => s.tier !== 'low-key').length;
  const lowKeySocialCount = weekendSocialSlots.length - paidSocialCount;
  const socialSummary = weekendSocialSlots.length
    ? `${paidSocialCount} paid / ${lowKeySocialCount} low-key of ${weekendSocialSlots.length} remaining`
    : 'No upcoming weekend social occasions this cycle.';

  $('pg-monthplan').innerHTML = `
    <div class="content">
      <div class="slabel">Month Plan</div>
      ${calloutHTML}
      <div class="stat-strip">
        <div class="stat-box"><div class="sb-label">Restaurants room left</div><div class="sb-val">${fmt(plan.impliedRestaurantRoom)}</div><div class="sb-note">Of joint budget, ~24% historical share</div></div>
        <div class="stat-box"><div class="sb-label">Fixed routine cost</div><div class="sb-val">${fmt(plan.fixedRoutineCost)}</div><div class="sb-note">Family dinner + date night, rest of cycle</div></div>
        <div class="stat-box"><div class="sb-label">Social budget remaining</div><div class="sb-val">${fmt(plan.socialBudgetRemaining)}</div><div class="sb-note">After fixed routine</div></div>
        <div class="stat-box"><div class="sb-label">Weekend social (rest of cycle)</div><div class="sb-val" style="font-size:13px;line-height:1.4">${socialSummary}</div></div>
      </div>
      <div class="cal-grid">
```

Replace it with:

```js
  const dynamicSlots = plan.slots.filter((s) => s.dynamic);
  const paidCount = dynamicSlots.filter((s) => s.tier !== 'low-key').length;
  const lowKeyCount = dynamicSlots.length - paidCount;
  const plannedCaption = dynamicSlots.length
    ? `${paidCount} paid outing${paidCount === 1 ? '' : 's'}, ${lowKeyCount} low-key hang${lowKeyCount === 1 ? '' : 's'} planned`
    : 'No upcoming date-night/social occasions this cycle.';

  const delta = plan.impliedRestaurantRoom - plan.projectedSpend;
  const overBudget = delta < 0;
  const deltaLabel = overBudget ? `${fmt(Math.abs(delta))} over budget` : `${fmt(Math.abs(delta))} under budget`;
  const deltaColor = overBudget ? 'var(--red)' : 'var(--green)';

  $('pg-monthplan').innerHTML = `
    <div class="content">
      <div class="slabel">Month Plan</div>
      ${calloutHTML}
      <div class="stat-strip stat-strip-3">
        <div class="stat-box"><div class="sb-label">Dining budget, rest of cycle</div><div class="sb-val">${fmt(plan.impliedRestaurantRoom)}</div><div class="sb-note">Of joint budget, ~24% historical share</div></div>
        <div class="stat-box"><div class="sb-label">Planned spend</div><div class="sb-val">${fmt(plan.projectedSpend)}</div><div class="sb-note">${plannedCaption}</div></div>
        <div class="stat-box"><div class="sb-label">Vs. budget</div><div class="sb-val" style="color:${deltaColor}">${deltaLabel}</div></div>
      </div>
      <div class="cal-grid">
```

- [ ] **Step 4: Add the `stat-strip-3` CSS modifier**

`.stat-strip` is shared with another tab that uses 4 columns (`grid-template-columns:repeat(4,1fr)`) — do not change the base rule. In `Longterm/dashboard_v5.html`, find:

```css
.stat-strip{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:3px;overflow:hidden;margin-bottom:20px}
```

Add directly after it:

```css
.stat-strip.stat-strip-3{grid-template-columns:repeat(3,1fr)}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node Longterm/data/test-summary-strip.mjs`
Expected: `All summary strip redesign tests passed.`

- [ ] **Step 6: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-summary-strip.mjs
git add Longterm/dashboard_v5.html
git commit -m "Redesign Month Plan summary strip: 3 stats + caption, drop confusing 4-box layout"
```

---

### Task 7: Documentation

**Files:**
- Modify: `Longterm/claude.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Update the Dining recommendations section**

In `Longterm/claude.md`, find the existing `## Dining recommendations (Month Plan tab)` section (added by the earlier dining-recommendations plan). Its last bullet currently reads:

```
- `dashboard_v5.html`'s Month Plan tab computes suggestions live via two isolated functions, `planRemainingMonth()` (decides paid-vs-low-key for the rest of the cycle's dynamic slots, based on budget pacing) and `recommendForSlot()` (picks specific places). Both are deliberately simple v1 heuristics — see `docs/superpowers/specs/2026-07-26-dining-recommendations-design.md` for the full design and the intended upgrade path (a v2 could swap either function's body for a smarter model without touching the calendar UI).
```

Replace it with:

```
- `dashboard_v5.html`'s Month Plan tab computes suggestions live via two isolated functions, `planRemainingMonth()` (decides paid-vs-low-key for the rest of the cycle's dynamic slots, based on budget pacing) and `recommendForSlot()` (picks specific places). Both are deliberately simple v1 heuristics — see `docs/superpowers/specs/2026-07-26-dining-recommendations-design.md` for the full design and the intended upgrade path (a v2 could swap either function's body for a smarter model without touching the calendar UI).
- The tab is interactive: routine-slot days (Wed/Fri/Sun) show a dropdown defaulting to the engine's recommendation, overridable to any favorite or a low-key idea; non-routine days support ad-hoc cost-tagged events. Both persist to `localStorage['monthPlan.v1']` (browser/machine-local — no sync, no backend) and feed back into `planRemainingMonth()`'s budget math via `resolveOverride()`, so a pricier override or a new event can flip a later, still-unresolved slot from paid to low-key. See `docs/superpowers/specs/2026-07-27-month-plan-interactivity-design.md`.
```

- [ ] **Step 2: Commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/claude.md
git commit -m "Document Month Plan interactivity (overrides, events, localStorage) in claude.md"
```

---
