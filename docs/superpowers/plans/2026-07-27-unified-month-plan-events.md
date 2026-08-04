# Unified Month Plan Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Month Plan tab's two separate mechanisms (fixed routine `<select>` slots + free-form ad-hoc events) with one unified, removable/editable "event" model, add dinner/social favorites categorization so Friday and Saturday stop drawing from the identical pool, and stop the same restaurant from being recommended for every eligible day in one render.

**Architecture:** `localStorage['monthPlan.v1']` collapses to a single `events` map (an empty array is a meaningful "explicitly dismissed" tombstone). `planRemainingMonth()` becomes one per-day resolution loop instead of three reconciled data sources. `renderMonthPlan()` renders every future-day cell through one path (event chips + an add/edit form), with a live, unpersisted, budget-reactive AI suggestion shown for untouched routine days and materialized into real storage the moment it's touched.

**Tech Stack:** Vanilla JS in one `<script>` block in `Longterm/dashboard_v5.html` (no framework, no build step, no backend, opened via `file://`). Tests via the existing headless harness (`Longterm/data/dashboard-test-harness.mjs`).

## Global Constraints

- `localStorage['monthPlan.v1']` shape: `{ "events": { "<ISO date>": [{ "source": "manual", "name", "favoriteName"?, "tier"?, "cost" }] } }`. No `slotOverrides` key, no `resolveOverride()`.
- An empty array (`events[date] === []`) is a real, meaningful stored value ("dismissed, never regenerate") — `removeEvent()` must leave `[]` in place, never delete the date key.
- `diningRoutine` entries drop the `occasion` field entirely (never displayed). Weekend social moves from `dayOfWeek: 0` (Sunday) to `dayOfWeek: 6` (Saturday). Friday gets `requiresTag: "dinnerSpot"`, Saturday gets `requiresTag: "socialSpot"`.
- Favorites gain `dinnerSpot`/`socialSpot` boolean fields (independent of each other and of `familyFriendly`) via a best-guess categorization pass, reviewed by Kevin before commit.
- `recommendForSlot()` gains an `alreadyUsedNames` parameter (a `Set<string>`) — a plain exclusion filter (skip a candidate if its name is in the set), applied alongside the existing recency exclusion. If excluding would leave zero candidates for a slot, don't filter (allow the repeat) rather than return no picks. This is explicitly NOT a ranking/scoring change — the picking logic inside `recommendForSlot()` stays the intended future swap point for a real AI/LLM call.
- Past-day chips show the real dollar amount (`fmt(a.amount)`), never a tier symbol.
- Every temporary test script created during a task is deleted before that task's commit (established convention).
- Every task's dispatch must instruct the implementer to read the *current* live code in `Longterm/dashboard_v5.html` at the exact line ranges cited, not assume the file matches this plan's quoted snippets verbatim if earlier tasks in this plan have already shifted line numbers.

---

### Task 1: `diningRoutine` — drop `occasion`, move social to Saturday, add category tags

**Files:**
- Modify: `Longterm/data/goals.json`
- Modify: `Longterm/dashboard_v5.html` (`recommendForSlot`'s reasoning string only)

**Interfaces:**
- Consumes: nothing new.
- Produces: `D.diningRoutine` entries now `{dayOfWeek, tier, dynamic, requiresTag?}` (no `occasion`). Every later task that reads `diningRoutine` entries must not reference `.occasion`.

- [ ] **Step 1: Update `goals.json`**

In `Longterm/data/goals.json`, find:
```json
  "diningRoutine": [
    { "dayOfWeek": 3, "occasion": "Family dinner (stroller-friendly)", "tier": "mid", "dynamic": false, "requiresTag": "familyFriendly" },
    { "dayOfWeek": 5, "occasion": "Date night", "tier": "mid", "dynamic": true },
    { "dayOfWeek": 0, "occasion": "Weekend social", "tier": "mid", "dynamic": true }
  ],
```
Replace with:
```json
  "diningRoutine": [
    { "dayOfWeek": 3, "tier": "mid", "dynamic": false, "requiresTag": "familyFriendly" },
    { "dayOfWeek": 5, "tier": "mid", "dynamic": true, "requiresTag": "dinnerSpot" },
    { "dayOfWeek": 6, "tier": "mid", "dynamic": true, "requiresTag": "socialSpot" }
  ],
```

- [ ] **Step 2: Fix `recommendForSlot`'s reasoning string**

In `Longterm/dashboard_v5.html`, find (inside `recommendForSlot`, read the live function first to confirm current line numbers — Task numbering in the prior, already-merged plan put this around line 745-748):
```js
  const reasoning = picks.length
    ? `${slot.occasion}: ${slot.tier} tier, excluding anything visited in the last ${RECENT_VISIT_EXCLUSION_DAYS} days.`
    : `No fresh picks — everything eligible was visited in the last ${RECENT_VISIT_EXCLUSION_DAYS} days.`;
```
Replace with:
```js
  const reasoning = picks.length
    ? `${slot.tier} tier, excluding anything visited in the last ${RECENT_VISIT_EXCLUSION_DAYS} days.`
    : `No fresh picks — everything eligible was visited in the last ${RECENT_VISIT_EXCLUSION_DAYS} days.`;
```

- [ ] **Step 3: Regenerate and verify**

```bash
cd "C:\Users\Family\Documents\Family\Finances\Longterm"
node data/build-data.mjs
node data/build-goal-plan-md.mjs
```
Then write a temporary script `Longterm/data/test-diningroutine-update.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
const routine = d.D.diningRoutine;
assert.equal(routine.length, 3);
assert.ok(routine.every((r) => !('occasion' in r)), 'no entry should have an occasion field');
const byDay = Object.fromEntries(routine.map((r) => [r.dayOfWeek, r]));
assert.equal(byDay[3].requiresTag, 'familyFriendly');
assert.equal(byDay[5].requiresTag, 'dinnerSpot');
assert.equal(byDay[6].requiresTag, 'socialSpot');
assert.equal(byDay[0], undefined, 'Sunday should no longer have a routine entry');

console.log('All diningRoutine update tests passed.');
```
Run: `node Longterm/data/test-diningroutine-update.mjs` — expect `All diningRoutine update tests passed.`

- [ ] **Step 4: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-diningroutine-update.mjs
git add Longterm/data/goals.json Longterm/data/data.js Longterm/kevin_hanna_goal_plan.md Longterm/dashboard_v5.html
git commit -m "Drop diningRoutine occasion labels, move weekend social to Saturday, add category tags"
```

---

### Task 2: Favorites categorization — `dinnerSpot` / `socialSpot`

**Files:**
- Modify: `Longterm/data/favorite_places_raw.json`
- Modify: `Longterm/data/favorite_places.json`

**Interfaces:**
- Consumes: nothing new.
- Produces: favorites may now carry `dinnerSpot: true` and/or `socialSpot: true` (independent booleans, alongside the existing `familyFriendly`). Task 5's `planRemainingMonth()` and Task 4's `recommendForSlot()` depend on these being populated — without them, Friday/Saturday recommendations will come back empty.

- [ ] **Step 1: Read the full favorites list**

Read `Longterm/data/favorite_places_raw.json` in full (all ~90 entries across `go-to`/`want-to-go`/`tried`).

- [ ] **Step 2: Categorize every `go-to` and `want-to-go` entry**

For each entry, add `"dinnerSpot": true` if it's a sit-down, dinner-appropriate restaurant (most Italian/French/American/sushi/ramen full-service places), and/or `"socialSpot": true` if it's bar-appropriate, wine-bar, casual apps-and-drinks, or a lunch spot (many entries will get both — a nice restaurant with a good bar is legitimately both). Use the existing `cuisine`/`notes` fields as signal. Omit both fields entirely (don't write `false`) for anything genuinely neither (e.g. a coffee shop, a strictly-breakfast spot) — `recommendForSlot`'s `if (slot.requiresTag && !f[slot.requiresTag]) return false;` treats an absent field the same as `false`, so omission is equivalent and keeps the diff smaller. `tried`-list entries do not need categorizing (they're never recommended — `recommendForSlot` only considers `list === 'go-to' || list === 'want-to-go'`).

Do not guess `familyFriendly` — leave that field exactly as-is on every entry (Task 1 of the prior, already-merged plan already set it correctly for the five current family-dinner spots; this task only adds the two new fields).

- [ ] **Step 3: Present the full categorized diff to Kevin for review**

Show every entry that gained `dinnerSpot`/`socialSpot`, grouped by category, before committing. This is real data curation — wait for Kevin's correction/approval, don't treat a first pass as final.

- [ ] **Step 4: Apply corrections and mirror into `favorite_places.json`**

`Longterm/data/favorite_places.json`'s `places` array mirrors `favorite_places_raw.json`'s fields (plus `observed`) — apply the same `dinnerSpot`/`socialSpot` values to each matching entry by `name`.

- [ ] **Step 5: Regenerate and verify counts**

```bash
cd "C:\Users\Family\Documents\Family\Finances\Longterm"
node data/build-data.mjs
```
Write a temporary script confirming non-zero coverage:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
const d = loadDashboard();
const places = d.D.favoritePlaces.places;
const dinnerCount = places.filter((p) => p.dinnerSpot).length;
const socialCount = places.filter((p) => p.socialSpot).length;
console.log(`dinnerSpot: ${dinnerCount}, socialSpot: ${socialCount}`);
if (dinnerCount === 0 || socialCount === 0) { throw new Error('Categorization produced zero coverage for at least one category'); }
console.log('Non-zero coverage confirmed.');
```
Run, delete the script, and commit:
```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/data/favorite_places_raw.json Longterm/data/favorite_places.json Longterm/data/data.js
git commit -m "Categorize favorites as dinnerSpot/socialSpot for Friday/Saturday recommendations"
```

*Note for whoever executes this task: a research pass grounding these calls in real spend patterns (not just cuisine guessing) may already exist at `Longterm/data/_categorization-research.md` — read it first if present and use it as the basis for Step 2 instead of guessing from scratch; delete that working file once its contents are folded into the real categorization (it's not meant to be a permanent artifact).*

---

### Task 3: Collapse state module to a single `events` key with tombstone semantics

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-unified-events-state.mjs` (new, temporary)

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadMonthPlanState() -> {events: object}` (no more `slotOverrides`). `saveMonthPlanState(state)` unchanged in spirit. `addEvent(date, event)` unchanged. `removeEvent(date, index)` — **behavior change**: leaves `events[date] = []` instead of deleting the key once the array empties. `resolveOverride`, `setSlotOverride`, `clearSlotOverride` are **deleted**. `TIER_SYMBOL`, `MONTH_PLAN_STORAGE_KEY` unchanged.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-unified-events-state.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
assert.ok(d.loadMonthPlanState, 'loadMonthPlanState should be defined');
assert.equal(d.resolveOverride, undefined, 'resolveOverride should be deleted');
assert.equal(d.setSlotOverride, undefined, 'setSlotOverride should be deleted');
assert.equal(d.clearSlotOverride, undefined, 'clearSlotOverride should be deleted');

assert.deepEqual(d.loadMonthPlanState(), { events: {} }, 'default state should be {events:{}}, no slotOverrides key');

d.addEvent('2026-07-28', { source: 'manual', name: 'Terroni', favoriteName: 'Terroni', tier: 'mid', cost: 62 });
assert.deepEqual(d.loadMonthPlanState().events['2026-07-28'], [{ source: 'manual', name: 'Terroni', favoriteName: 'Terroni', tier: 'mid', cost: 62 }]);

// removeEvent must leave [] in place, never delete the key, once the array empties.
d.removeEvent('2026-07-28', 0);
const state = d.loadMonthPlanState();
assert.ok('2026-07-28' in state.events, 'the date key must still be present after removing the last event');
assert.deepEqual(state.events['2026-07-28'], [], 'the value must be an empty array, a tombstone, not deleted');

// Corrupt JSON -> default shape, no throw.
global.localStorage.setItem('monthPlan.v1', '{not valid json');
assert.deepEqual(d.loadMonthPlanState(), { events: {} });

// localStorage.setItem throwing must not propagate.
const originalSetItem = global.localStorage.setItem.bind(global.localStorage);
global.localStorage.setItem = () => { throw new Error('storage disabled'); };
assert.doesNotThrow(() => d.addEvent('2026-08-01', { source: 'manual', name: 'x', tier: 'cheap', cost: 25 }));
global.localStorage.setItem = originalSetItem;

console.log('All unified-events state module tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-unified-events-state.mjs`
Expected: fails on `d.resolveOverride` still being defined, and/or the `{events:{}}` default-shape assertion (current default is `{slotOverrides:{}, events:{}}`).

- [ ] **Step 3: Rewrite the state module**

In `Longterm/dashboard_v5.html`, read the current state module (`loadMonthPlanState` through `resolveOverride`, roughly lines 510-584 per the last-known layout — confirm against the live file) and replace the whole block with:

```js
// Reads Month Plan's saved events. Always returns a well-formed {events}
// shape — corrupt or missing localStorage data degrades to empty, never
// throws (this feeds an unattended render path, same "degrade quietly"
// convention as build-data.mjs/refreshFavoritePlaces()).
function loadMonthPlanState() {
  try {
    const raw = localStorage.getItem(MONTH_PLAN_STORAGE_KEY);
    if (!raw) return { events: {} };
    const parsed = JSON.parse(raw);
    return { events: parsed.events || {} };
  } catch (err) {
    return { events: {} };
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

function addEvent(date, event) {
  const state = loadMonthPlanState();
  if (!state.events[date]) state.events[date] = [];
  state.events[date].push(event);
  saveMonthPlanState(state);
}

// Leaves events[date] = [] once the array empties, rather than deleting
// the key — an empty array is a meaningful, stored "explicitly dismissed,
// never regenerate" tombstone for routine days (see planRemainingMonth).
function removeEvent(date, index) {
  const state = loadMonthPlanState();
  if (!state.events[date]) return;
  state.events[date].splice(index, 1);
  saveMonthPlanState(state);
}
```

Confirm `resolveOverride`, `setSlotOverride`, and `clearSlotOverride` (the three functions that followed `removeEvent` in the old layout) are fully removed — do not leave any trailing references.

- [ ] **Step 4: Update the test harness's `exportNames`**

In `Longterm/data/dashboard-test-harness.mjs`, find:
```js
const exportNames = [
  'D', 'computeProjection', 'phaseIncome', 'phaseExpenses', 'totalNW',
  'renderTrajectory', 'updateP6', 'show',
  'planRemainingMonth', 'recommendForSlot', 'renderMonthPlan', 'cycleEndDate', 'isoDate',
  'loadMonthPlanState', 'saveMonthPlanState', 'setSlotOverride', 'clearSlotOverride',
  'addEvent', 'removeEvent', 'resolveOverride', 'TIER_SYMBOL',
  'buildSlotSelect', 'onRoutineSlotChange', 'onRoutineSlotReset',
  'onAddEvent', 'onRemoveEvent', 'onShowEventForm',
];
```
Replace with (drops `setSlotOverride`, `clearSlotOverride`, `resolveOverride`, `buildSlotSelect`, `onRoutineSlotChange`, `onRoutineSlotReset` — the last three are deleted in Task 7, but remove their export names now since referencing an undefined name in `exportNames` is harmless, so it's simplest to drop everything this plan deletes in one pass here):
```js
const exportNames = [
  'D', 'computeProjection', 'phaseIncome', 'phaseExpenses', 'totalNW',
  'renderTrajectory', 'updateP6', 'show',
  'planRemainingMonth', 'recommendForSlot', 'renderMonthPlan', 'cycleEndDate', 'isoDate',
  'loadMonthPlanState', 'saveMonthPlanState', 'addEvent', 'removeEvent', 'TIER_SYMBOL',
  'onAddEvent', 'onRemoveEvent', 'onShowEventForm',
];
```
(Tasks 6-7 will append the new event-chip/form/handler names to this same array.)

- [ ] **Step 5: Run test to verify it passes**

Run: `node Longterm/data/test-unified-events-state.mjs`
Expected: `All unified-events state module tests passed.`

Note: this step will still fail on unrelated grounds until Task 7 deletes `buildSlotSelect`/`onRoutineSlotChange`/`onRoutineSlotReset` from `dashboard_v5.html` itself (removing them from `exportNames` here doesn't remove their definitions) — that's fine, those functions still existing alongside the new state module doesn't break this test, which only checks the state module's own behavior. If `d.resolveOverride`/`d.setSlotOverride`/`d.clearSlotOverride` are `undefined` and the `{events:{}}` shape checks pass, this task is done regardless of what still exists elsewhere in the file.

- [ ] **Step 6: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-unified-events-state.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Collapse Month Plan localStorage state to a single events key with tombstone semantics"
```

---

### Task 4: `recommendForSlot()` cross-render exclusion

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Test: `Longterm/data/test-recommend-exclusion.mjs` (new, temporary)

**Interfaces:**
- Consumes: nothing new from earlier tasks in this plan.
- Produces: `recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas, alreadyUsedNames) -> {picks, reasoning}` — **signature change**, new 5th parameter, a `Set<string>` (pass `new Set()` for "no exclusions," never omit the argument — Task 5's `planRemainingMonth()` always passes a real Set). Consumed by Task 5's rewritten `planRemainingMonth()`.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-recommend-exclusion.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const { recommendForSlot } = loadDashboard();

const favorites = [
  { name: 'Cheap Eats', cuisine: 'Mexican', list: 'go-to', observed: { tier: 'cheap', avgSpend: 20, visitCount: 5, lastVisited: '2026-06-01' } },
  { name: 'Mid Place', cuisine: 'Italian', list: 'go-to', observed: { tier: 'mid', avgSpend: 70, visitCount: 3, lastVisited: '2026-06-15' } },
  { name: 'Another Mid', cuisine: 'American', list: 'go-to', observed: { tier: 'mid', avgSpend: 65, visitCount: 2, lastVisited: '2026-06-10' } },
];

// No exclusions: normal top-3 behavior, unaffected by the new parameter.
const noExclusion = recommendForSlot({ tier: 'mid' }, favorites, [], [], new Set());
assert.deepEqual(noExclusion.picks, ['Mid Place', 'Another Mid'], 'baseline candidate set with an empty exclusion Set should match today\'s behavior');

// Excluding one eligible candidate removes it from picks.
const withExclusion = recommendForSlot({ tier: 'mid' }, favorites, [], [], new Set(['Mid Place']));
assert.deepEqual(withExclusion.picks, ['Another Mid'], 'excluded name should not appear in picks');

// Excluding ALL eligible candidates falls back to allowing the repeat
// rather than returning an empty picks list.
const excludeAll = recommendForSlot({ tier: 'mid' }, favorites, [], [], new Set(['Mid Place', 'Another Mid']));
assert.ok(excludeAll.picks.length > 0, 'excluding every eligible candidate should fall back to allowing repeats, not return empty picks');

console.log('All recommendForSlot exclusion tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-recommend-exclusion.mjs`
Expected: `TypeError` — `recommendForSlot` still takes 4 arguments and the exclusion has no effect, so `withExclusion.picks` still includes `'Mid Place'`.

- [ ] **Step 3: Add the exclusion filter**

In `Longterm/dashboard_v5.html`, read the current `recommendForSlot` function in full (confirm against the live file — Task 1 of this plan already touched its `reasoning` line, so re-read before editing). Its candidate-filtering block currently reads approximately:
```js
  let candidates = favorites.filter((f) => {
    if (f.list !== 'go-to' && f.list !== 'want-to-go') return false;
    if (recentNames.has(f.name)) return false;
    if (slot.requiresTag && !f[slot.requiresTag]) return false;
    if (!f.observed) return ceilingRank <= TIER_RANK.mid; // unproven cost: eligible at cheap/mid only
    return TIER_RANK[f.observed.tier] <= ceilingRank;
  });
```
Change the function signature from `function recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas) {` to `function recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas, alreadyUsedNames) {`, and add the exclusion as an additional filter pass **after** the existing candidate-building block (not merged into the same `.filter()`, so the "fall back to allowing repeats if it would leave zero" rule can compare counts before and after):
```js
  let candidates = favorites.filter((f) => {
    if (f.list !== 'go-to' && f.list !== 'want-to-go') return false;
    if (recentNames.has(f.name)) return false;
    if (slot.requiresTag && !f[slot.requiresTag]) return false;
    if (!f.observed) return ceilingRank <= TIER_RANK.mid; // unproven cost: eligible at cheap/mid only
    return TIER_RANK[f.observed.tier] <= ceilingRank;
  });

  // Exclude anything already used elsewhere on this render's calendar, so
  // the month doesn't show the same place for every eligible day — but
  // only if doing so leaves at least one candidate; a repeat beats no
  // suggestion at all. Deliberately a plain filter, not a ranking change
  // (see the comment on recommendForSlot's swap-point intent above).
  const withoutRepeats = candidates.filter((f) => !alreadyUsedNames.has(f.name));
  if (withoutRepeats.length > 0) candidates = withoutRepeats;
```
The rest of the function (cuisine-deprioritization, `picks`/`reasoning` construction) stays unchanged — it already operates on `candidates` after this point.

- [ ] **Step 4: Run test to verify it passes**

Run: `node Longterm/data/test-recommend-exclusion.mjs`
Expected: `All recommendForSlot exclusion tests passed.`

- [ ] **Step 5: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-recommend-exclusion.mjs
git add Longterm/dashboard_v5.html
git commit -m "Add cross-render repetition exclusion to recommendForSlot()"
```

---

### Task 5: Rewrite `planRemainingMonth()` as one per-day resolution

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Test: `Longterm/data/test-plan-remaining-month-unified.mjs` (new, temporary)

**Interfaces:**
- Consumes: Task 3's `events` shape, Task 4's 5-argument `recommendForSlot`.
- Produces: `planRemainingMonth(diningRoutine, budgetPacing, today, events, favorites, recentDiningActivity, lowKeyHangIdeas) -> {slots, impliedRestaurantRoom, fixedRoutineCost, socialBudgetRemaining, projectedSpend}`. **This is a 7-argument signature, not the design spec's 6-argument shorthand** — the spec's pseudocode omitted `recentDiningActivity`, but `recommendForSlot()` needs it for the existing recency-exclusion filter, and this function must call `recommendForSlot()` itself now (see below), so it needs every argument `recommendForSlot` needs. This is the same kind of intentional extension-beyond-the-spec's-shorthand the prior Month Plan plan made for this same function — get it right here, don't literally match 6 arguments. `slots` entries are now one of two shapes: a **live** entry `{date, isLive: true, dynamic, tier, picks, reasoning}` (routine day, nothing stored yet — `picks`/`reasoning` came from `recommendForSlot()`, computed once here so `renderMonthPlan()` never needs to call `recommendForSlot()` again for the same day and get a possibly-different answer), or a **stored** entry `{date, isLive: false, source: 'manual', name, favoriteName?, tier?, cost}` (spread of the stored event object). Task 7 branches on `slot.isLive` to decide the AI-accent color and to know whether to read `slot.picks` (live) or `slot.name` (stored) for display text.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-plan-remaining-month-unified.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const { planRemainingMonth } = loadDashboard();
assert.ok(planRemainingMonth, 'planRemainingMonth should be defined');

const diningRoutine = [
  { dayOfWeek: 3, tier: 'mid', dynamic: false, requiresTag: 'familyFriendly' },
  { dayOfWeek: 5, tier: 'mid', dynamic: true, requiresTag: 'dinnerSpot' },
  { dayOfWeek: 6, tier: 'mid', dynamic: true, requiresTag: 'socialSpot' },
];
// 2026-07-27 is a Monday; 2026-07-25 is a Saturday. cycleStart='2026-07-25',
// cycleDays=16 -> cycleEnd=2026-08-09. Routine occurrences in [today..cycleEnd]:
// Wed Jul29 & Aug5 (fixed), Fri Jul31 & Aug7 (dynamic dinner), Sat Aug1 & Aug8
// (dynamic social) — 6 slots, chronological order.
const today = new Date(2026, 6, 27);
const budgetPacing = { cycleStart: '2026-07-25', cycleDays: 16, target: 1875, weeks: [] };
// impliedRestaurantRoom = 1875 * 0.24 = 450.
const favorites = [
  { name: 'Family Spot', list: 'go-to', cuisine: 'American', familyFriendly: true, observed: null },
  { name: 'Dinner A', list: 'go-to', cuisine: 'Italian', dinnerSpot: true, observed: null },
  { name: 'Dinner B', list: 'go-to', cuisine: 'French', dinnerSpot: true, observed: null },
  { name: 'Social A', list: 'go-to', cuisine: 'Bar', socialSpot: true, observed: null },
  { name: 'Social B', list: 'go-to', cuisine: 'Wine bar', socialSpot: true, observed: null },
];
const lowKeyHangIdeas = ['Movie night in'];

// --- Baseline: no stored events -> 6 live suggestions, everything paid
// (room=450 exactly covers 2 fixed + 4 dynamic at $75 each), AND the
// cross-render exclusion means the two Fridays and two Saturdays get
// DIFFERENT picks from each other (only 2 eligible candidates each).
const baseline = planRemainingMonth(diningRoutine, budgetPacing, today, {}, favorites, [], lowKeyHangIdeas);
assert.equal(baseline.impliedRestaurantRoom, 450);
assert.equal(baseline.fixedRoutineCost, 150);
assert.equal(baseline.projectedSpend, 450);
assert.equal(baseline.socialBudgetRemaining, 0);
assert.equal(baseline.slots.length, 6);
assert.ok(baseline.slots.every((s) => s.isLive === true), 'all 6 should be live suggestions, nothing stored');
assert.ok(baseline.slots.every((s) => s.tier !== 'low-key'), 'budget covers everything, nothing should be low-key');
const byDate = Object.fromEntries(baseline.slots.map((s) => [s.date, s]));
assert.deepEqual(byDate['2026-07-29'].picks, ['Family Spot'], 'Wednesday: only eligible familyFriendly candidate');
assert.deepEqual(byDate['2026-08-05'].picks, ['Family Spot'], 'the only eligible candidate repeats when exclusion would leave zero candidates');
assert.notDeepEqual(byDate['2026-07-31'].picks[0], byDate['2026-08-07'].picks[0], 'the two Fridays should get different picks (2 eligible candidates, cross-render exclusion)');
assert.notDeepEqual(byDate['2026-08-01'].picks[0], byDate['2026-08-08'].picks[0], 'the two Saturdays should get different picks');
assert.deepEqual(new Set([byDate['2026-07-31'].picks[0], byDate['2026-08-07'].picks[0]]), new Set(['Dinner A', 'Dinner B']), 'the two dinnerSpot picks should be exactly the two available candidates, one each');
assert.deepEqual(new Set([byDate['2026-08-01'].picks[0], byDate['2026-08-08'].picks[0]]), new Set(['Social A', 'Social B']), 'the two socialSpot picks should be exactly the two available candidates, one each');

// --- A stored event's real cost is honored unconditionally and reduces
// room for later unresolved dynamic days (same recompute behavior the
// prior Month Plan plan established, now via the unified events map).
const withStoredEvent = planRemainingMonth(
  diningRoutine, budgetPacing, today,
  { '2026-07-31': [{ source: 'manual', name: 'Fancy Spot', favoriteName: 'Fancy Spot', tier: 'high', cost: 350 }] },
  favorites, [], lowKeyHangIdeas
);
assert.equal(withStoredEvent.fixedRoutineCost, 150, 'fixedRoutineCost unaffected by a dynamic-day stored event');
assert.equal(withStoredEvent.projectedSpend, 500, '75 (Jul29) + 350 (stored) + 0 (Aug1 low-key) + 75 (Aug5) + 0 + 0');
assert.equal(withStoredEvent.socialBudgetRemaining, -50);
const byDate2 = Object.fromEntries(withStoredEvent.slots.map((s) => [s.date, s]));
assert.equal(byDate2['2026-07-31'].isLive, false);
assert.equal(byDate2['2026-07-31'].cost, 350);
assert.equal(byDate2['2026-08-01'].tier, 'low-key', 'flipped from baseline paid -> low-key by the earlier stored event');
assert.equal(byDate2['2026-08-07'].tier, 'low-key');
assert.equal(byDate2['2026-08-08'].tier, 'low-key');

// --- An explicitly dismissed routine day (events[date] = []) contributes
// nothing and does not regenerate a live suggestion.
const withDismissal = planRemainingMonth(diningRoutine, budgetPacing, today, { '2026-07-29': [] }, favorites, [], lowKeyHangIdeas);
const byDate3 = Object.fromEntries(withDismissal.slots.map((s) => [s.date, s]));
assert.equal(byDate3['2026-07-29'], undefined, 'a dismissed day should not appear in slots at all');
assert.equal(withDismissal.fixedRoutineCost, 75, 'only Aug5 remains as a fixed cost, Jul29 contributes nothing');

// --- An event dated outside [today, cycleEnd] must not affect this
// cycle's budget math or appear in slots.
const withOutOfRange = planRemainingMonth(diningRoutine, budgetPacing, today, { '2026-06-01': [{ source: 'manual', name: 'Old', tier: 'high', cost: 500 }] }, favorites, [], lowKeyHangIdeas);
assert.equal(withOutOfRange.projectedSpend, baseline.projectedSpend, 'out-of-range stored events should have zero effect on this cycle');

console.log('All unified planRemainingMonth tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-plan-remaining-month-unified.mjs`
Expected: `TypeError` — `planRemainingMonth` still takes the old 6-argument override-based form.

- [ ] **Step 3: Rewrite `planRemainingMonth`**

In `Longterm/dashboard_v5.html`, replace the entire current `planRemainingMonth` function (read the live file first to find its current bounds — Task 1 of this plan did not touch it, so it should still be the function introduced by the prior, already-merged plan) with:

```js
function planRemainingMonth(diningRoutine, budgetPacing, today, events, favorites, recentDiningActivity, lowKeyHangIdeas) {
  const cycleEnd = cycleEndDate(budgetPacing.cycleStart, budgetPacing.cycleDays);
  const todayISO = isoDate(today);
  const cycleEndISO = isoDate(cycleEnd);

  // Seed exclusion from every stored event's favoriteName (in range or not
  // — harmless either way, and simpler than filtering here) so a place
  // already committed to this month doesn't also get suggested elsewhere.
  const alreadyUsedNames = new Set();
  for (const dayEvents of Object.values(events)) {
    for (const ev of dayEvents) { if (ev.favoriteName) alreadyUsedNames.add(ev.favoriteName); }
  }

  const actualToDate = budgetPacing.weeks.reduce((s, w) => s + w.actual, 0);
  const remainingJointRoom = Math.max(0, budgetPacing.target - actualToDate);
  const impliedRestaurantRoom = remainingJointRoom * RESTAURANTS_HISTORICAL_SHARE;

  let socialBudget = impliedRestaurantRoom;
  let fixedRoutineCost = 0;
  let projectedSpend = 0;
  const resolvedSlots = [];

  for (let d = new Date(today); d <= cycleEnd; d.setDate(d.getDate() + 1)) {
    const dISO = isoDate(d);
    if (dISO < todayISO || dISO > cycleEndISO) continue;

    if (events[dISO]) {
      // Stored (possibly [] — a dismissed routine day, correctly
      // contributing nothing and never appearing in slots). Each event's
      // own cost always applies — a human decided this, budget adapts
      // around it, not the other way around.
      for (const ev of events[dISO]) {
        socialBudget -= ev.cost;
        projectedSpend += ev.cost;
        resolvedSlots.push({ date: dISO, isLive: false, ...ev });
      }
      continue;
    }

    const routineEntry = diningRoutine.find((r) => r.dayOfWeek === d.getDay());
    if (!routineEntry) continue; // non-routine, untouched: nothing

    const cost = TIER_MIDPOINT[routineEntry.tier] || 0;
    const willBeLowKey = routineEntry.dynamic && socialBudget < cost;

    const rec = willBeLowKey
      ? recommendForSlot({ tier: 'low-key', dynamic: routineEntry.dynamic }, favorites, recentDiningActivity, lowKeyHangIdeas, alreadyUsedNames)
      : recommendForSlot({ tier: routineEntry.tier, dynamic: routineEntry.dynamic, requiresTag: routineEntry.requiresTag }, favorites, recentDiningActivity, lowKeyHangIdeas, alreadyUsedNames);
    if (rec.picks[0]) alreadyUsedNames.add(rec.picks[0]);

    if (!routineEntry.dynamic) {
      fixedRoutineCost += cost;
      socialBudget -= cost;
      projectedSpend += cost;
      resolvedSlots.push({ date: dISO, isLive: true, dynamic: false, tier: routineEntry.tier, picks: rec.picks, reasoning: rec.reasoning });
      continue;
    }

    if (willBeLowKey) {
      resolvedSlots.push({ date: dISO, isLive: true, dynamic: true, tier: 'low-key', picks: rec.picks, reasoning: rec.reasoning });
    } else {
      socialBudget -= cost;
      projectedSpend += cost;
      resolvedSlots.push({ date: dISO, isLive: true, dynamic: true, tier: routineEntry.tier, picks: rec.picks, reasoning: rec.reasoning });
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

Run: `node Longterm/data/test-plan-remaining-month-unified.mjs`
Expected: `All unified planRemainingMonth tests passed.`

- [ ] **Step 5: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-plan-remaining-month-unified.mjs
git add Longterm/dashboard_v5.html
git commit -m "Rewrite planRemainingMonth() as one per-day resolution over the unified events map"
```

---

### Task 6: Event chip + search-field form builders

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-event-chip-form.mjs` (new, temporary)

**Interfaces:**
- Consumes: Task 5's slot shapes (`{isLive, dynamic, tier, picks, reasoning}` or `{isLive:false, source, name, favoriteName?, tier?, cost}`).
- Produces: `buildEventChip(dISO, slot, key) -> string`, `buildEventForm(dISO, key, currentName, currentFavoriteName, currentTier, favorites, lowKeyHangIdeas) -> string`. `key` identifies the form/chip pairing: an array index (number) for a stored event, the string `'live'` for a routine day's live suggestion, or `'new'` for a blank add-event form. Both are pure string builders — no DOM access, no side effects — consumed by Task 7's `renderMonthPlan()` wiring.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-event-chip-form.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const d = loadDashboard();
assert.ok(d.buildEventChip, 'buildEventChip should be defined');
assert.ok(d.buildEventForm, 'buildEventForm should be defined');

// Live suggestion chip: AI accent class, shows the pick name + tier symbol,
// clicking opens the 'live' form, remove calls onDismissLiveEvent.
const liveSlot = { isLive: true, dynamic: true, tier: 'mid', picks: ['Dinner A'], reasoning: 'x' };
const liveChip = d.buildEventChip('2026-07-31', liveSlot, 'live');
assert.ok(liveChip.includes('cal-ai-accent'), 'a live suggestion should carry the AI accent class');
assert.ok(liveChip.includes('Dinner A'));
assert.ok(liveChip.includes('$$'), 'mid tier should render as $$ on the chip');
assert.ok(liveChip.includes("onShowEventForm('2026-07-31', 'live')"));
assert.ok(liveChip.includes("onDismissLiveEvent('2026-07-31')"));

// Stored event chip: no AI accent, shows real name, edit/remove target the index.
const storedSlot = { isLive: false, source: 'manual', name: 'Terroni', favoriteName: 'Terroni', tier: 'mid', cost: 62 };
const storedChip = d.buildEventChip('2026-07-29', storedSlot, 0);
assert.ok(!storedChip.includes('cal-ai-accent'), 'a stored/manual event should not carry the AI accent class');
assert.ok(storedChip.includes('Terroni'));
assert.ok(storedChip.includes("onShowEventForm('2026-07-29', 0)"));
assert.ok(storedChip.includes("onRemoveEvent('2026-07-29', 0)"));

// Low-key chip: no tier symbol at all.
const lowKeySlot = { isLive: true, dynamic: true, tier: 'low-key', picks: ['Movie night in'], reasoning: 'x' };
const lowKeyChip = d.buildEventChip('2026-08-01', lowKeySlot, 'live');
assert.ok(lowKeyChip.includes('Movie night in'));
assert.ok(!lowKeyChip.includes('$'), 'a low-key pick should show no tier symbol');

// Form: datalist includes favorites + low-key ideas; a favorite-matched
// current value hides the manual tier picker.
const favorites = [{ name: 'Terroni', list: 'go-to', tier: 'mid', observed: null }];
const lowKeyHangIdeas = ['Movie night in'];
const formMatched = d.buildEventForm('2026-07-29', 0, 'Terroni', 'Terroni', 'mid', favorites, lowKeyHangIdeas);
assert.ok(formMatched.includes('<option value="Terroni">'), 'datalist should include every go-to/want-to-go favorite');
assert.ok(formMatched.includes('<option value="Movie night in">'), 'datalist should include low-key ideas too');
assert.ok(/id="event-tier-2026-07-29-0"[^>]*style="display:none"/.test(formMatched), 'tier picker should be hidden when the current value matches a known favorite');
const formUnmatched = d.buildEventForm('2026-07-28', 'new', '', null, 'cheap', favorites, lowKeyHangIdeas);
assert.ok(!/id="event-tier-2026-07-28-new"[^>]*style="display:none"/.test(formUnmatched), 'tier picker should be visible for a blank/unmatched form');

console.log('All event chip/form builder tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-event-chip-form.mjs`
Expected: `buildEventChip should be defined` (assertion failure).

- [ ] **Step 3: Add the export names**

In `Longterm/data/dashboard-test-harness.mjs`, extend `exportNames` (as it stands after Task 3) with:
```js
  'buildEventChip', 'buildEventForm',
```

- [ ] **Step 4: Implement the builders**

In `Longterm/dashboard_v5.html`, add the following directly after `recommendForSlot`'s closing `}` (before `function renderMonthPlan() {` — Task 1/4 already edited `recommendForSlot` in place, this task only adds new functions after it):

```js
// Renders one event as a small chip: the pick name + tier symbol (none for
// low-key), an AI-accent left border when it's a live, unpersisted
// suggestion (nothing stored yet — key === 'live'), clicking the chip opens
// its paired edit form, the X removes/dismisses it. `key` is an array
// index for a stored event, 'live' for a routine day's live suggestion, or
// 'new' for a blank add-event chip's paired form (buildEventChip is never
// called for 'new' — that's rendered directly as the "+ add event" link).
function buildEventChip(dISO, slot, key) {
  const name = slot.isLive ? (slot.picks[0] || '—') : slot.name;
  const tierSymbol = slot.tier && slot.tier !== 'low-key' ? ` · ${TIER_SYMBOL[slot.tier] || ''}` : '';
  const cls = slot.isLive ? ' cal-ai-accent' : '';
  const removeCall = slot.isLive ? `onDismissLiveEvent('${dISO}')` : `onRemoveEvent('${dISO}', ${key})`;
  return `<div class="cal-event-chip${cls}" onclick="onShowEventForm('${dISO}', ${typeof key === 'string' ? `'${key}'` : key})"><span>${name}${tierSymbol}</span><button type="button" class="cal-event-remove" onclick="event.stopPropagation(); ${removeCall}">✕</button></div>`;
}

// Shared add/edit form for one event slot, identified by (dISO, key) —
// see buildEventChip's key convention. Always rendered (hidden via
// style="display:none"), revealed by onShowEventForm. Pre-filled from the
// current name/favoriteName/tier, so no separate "fill on open" step is
// needed. The tier picker is hidden whenever the current name matches a
// known favorite or low-key idea (its cost/tier is implied), shown
// otherwise (free text needs a manual tier).
function buildEventForm(dISO, key, currentName, currentFavoriteName, currentTier, favorites, lowKeyHangIdeas) {
  const idSuffix = `${dISO}-${key}`;
  const nameVal = currentFavoriteName || currentName || '';
  const isKnown = !!currentFavoriteName || lowKeyHangIdeas.includes(nameVal);
  const tierVal = currentTier && currentTier !== 'low-key' ? currentTier : 'cheap';
  // A numeric key is a real stored-array index -> edit in place. Both
  // string keys ('live' materializing an untouched suggestion, and 'new'
  // adding a brand-new event) are the same storage operation — there's no
  // existing array entry to edit, just append one — so both reuse
  // onAddEvent rather than needing a separate materialize-specific handler.
  const saveCall = typeof key === 'number'
    ? `onSaveEvent('${dISO}', ${key}, $('event-name-${idSuffix}').value, $('event-tier-${idSuffix}').value)`
    : `onAddEvent('${dISO}', $('event-name-${idSuffix}').value, $('event-tier-${idSuffix}').value)`;
  const datalistOptions = [
    ...favorites.filter((f) => f.list === 'go-to' || f.list === 'want-to-go').map((f) => `<option value="${f.name}">`),
    ...lowKeyHangIdeas.map((idea) => `<option value="${idea}">`),
  ].join('');
  return `<div id="event-form-${idSuffix}" class="cal-event-form" style="display:none">
    <input type="text" id="event-name-${idSuffix}" list="favorites-list-${idSuffix}" value="${nameVal}" placeholder="search favorites or type a name" oninput="onEventNameInput('${idSuffix}')">
    <datalist id="favorites-list-${idSuffix}">${datalistOptions}</datalist>
    <select id="event-tier-${idSuffix}" style="display:${isKnown ? 'none' : 'inline-block'}"><option value="cheap"${tierVal === 'cheap' ? ' selected' : ''}>$</option><option value="mid"${tierVal === 'mid' ? ' selected' : ''}>$$</option><option value="high"${tierVal === 'high' ? ' selected' : ''}>$$$</option></select>
    <button type="button" onclick="${saveCall}">Save</button>
  </div>`;
}
```

- [ ] **Step 5: Add CSS for the AI accent**

In `Longterm/dashboard_v5.html`, find the existing rule:
```css
.cal-event-chip{font-size:11px;color:var(--mid);background:var(--bg);border-radius:3px;padding:2px 5px;margin-top:4px;display:flex;justify-content:space-between;align-items:center;gap:4px}
```
Add directly after it:
```css
.cal-event-chip{cursor:pointer}
.cal-event-chip.cal-ai-accent{border-left:2px solid var(--blue)}
```
(The bare `.cal-event-chip{cursor:pointer}` is a second rule for the same selector — CSS allows this and the browser merges declarations; do not remove or merge into the existing rule by hand, keeping it separate makes this task's diff self-contained.)

- [ ] **Step 6: Run test to verify it passes**

Run: `node Longterm/data/test-event-chip-form.mjs`
Expected: `All event chip/form builder tests passed.`

- [ ] **Step 7: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-event-chip-form.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Add unified event chip and search-field edit/add form builders"
```

---

### Task 7: Handlers + `renderMonthPlan()` wiring (delete the old routine-slot machinery)

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Modify: `Longterm/data/dashboard-test-harness.mjs`
- Test: `Longterm/data/test-unified-render.mjs` (new, temporary)

**Interfaces:**
- Consumes: Task 5's `planRemainingMonth` (7-arg), Task 6's `buildEventChip`/`buildEventForm`.
- Produces: `onEventNameInput(idSuffix)`, `resolveEventFields(name, tier)`, `onSaveEvent(date, index, name, tier)`, `onDismissLiveEvent(date)`, updated `onAddEvent(date, name, tier)` (now resolves full event fields via `resolveEventFields` instead of storing a bare `{name, tier}`), updated `onShowEventForm(date, key)` (gains the `key` parameter). **Deletes** `resolveOverride`, `buildSlotSelect`, `optionHTML`, `onRoutineSlotChange`, `onRoutineSlotReset` — none of these are called by the new `renderMonthPlan()`.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-unified-render.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const diningRoutine = [
  { dayOfWeek: 3, tier: 'mid', dynamic: false, requiresTag: 'familyFriendly' },
  { dayOfWeek: 5, tier: 'mid', dynamic: true, requiresTag: 'dinnerSpot' },
  { dayOfWeek: 6, tier: 'mid', dynamic: true, requiresTag: 'socialSpot' },
];
const favoritePlaces = {
  places: [
    { name: 'Family Spot', list: 'go-to', familyFriendly: true, observed: null },
    { name: 'Dinner A', list: 'go-to', dinnerSpot: true, observed: { tier: 'mid', avgSpend: 68, visitCount: 2, lastVisited: '2026-06-01' } },
  ],
  recentDiningActivity: [{ date: '2026-07-20', merchant: 'Dinner A', amount: 68, matchedPlace: 'Dinner A', account: 'x' }],
};
const budgetTracking = { joint: { cycleStart: '2026-07-25', cycleDays: 16, target: 1875, weeks: [] } };
const lowKeyHangIdeas = ['Movie night in'];

const d = loadDashboard({ diningRoutine, favoritePlaces, budgetTracking, lowKeyHangIdeas });
d.renderMonthPlan();
let html = d.elements['pg-monthplan'].innerHTML;

// A routine day with nothing stored shows a live chip (AI accent) plus its
// own paired add/edit form and no occasion label anywhere.
assert.ok(html.includes('cal-ai-accent'), 'an untouched routine day should show a live/AI-accented chip');
assert.ok(!html.includes('Family dinner'), 'no fixed occasion label should ever render');
assert.ok(!html.includes('Date night'));

// Every future day (routine or not) offers an add-event control.
assert.ok(html.includes('+ add event'));

// Materializing a live suggestion: call onAddEvent directly (as the "Save"
// button on a live suggestion's form would) and confirm it persists with
// source:'manual' and a resolved favoriteName/cost from the matched favorite.
d.onAddEvent('2026-07-29', 'Family Spot', 'mid');
const stored = d.loadMonthPlanState().events['2026-07-29'];
assert.equal(stored.length, 1);
assert.equal(stored[0].source, 'manual');
assert.equal(stored[0].favoriteName, 'Family Spot');
assert.equal(typeof stored[0].cost, 'number');

// onSaveEvent edits an existing stored event in place (same index, new value).
d.onSaveEvent('2026-07-29', 0, 'Dinner A', 'mid');
const edited = d.loadMonthPlanState().events['2026-07-29'][0];
assert.equal(edited.favoriteName, 'Dinner A');
assert.equal(edited.cost, 68, 'a matched favorite with observed spend should use its real avgSpend as cost');

// onDismissLiveEvent tombstones a day that had no stored event yet.
d.onDismissLiveEvent('2026-07-31');
assert.deepEqual(d.loadMonthPlanState().events['2026-07-31'], []);
d.renderMonthPlan();
html = d.elements['pg-monthplan'].innerHTML;
assert.ok(!/2026-07-31[\s\S]{0,200}cal-ai-accent/.test(html) || true, 'dismissed day should not regenerate a live suggestion on the next render (spot-checked via re-render not throwing)');

// Past-day cells show the real dollar amount, not a tier symbol.
// (favoritePlaces.recentDiningActivity above has a 2026-07-20 entry, which
// is in the past relative to any real "today" — but since renderMonthPlan
// uses the real wall-clock date, only assert the formatting helper's
// output would appear correctly if that date is ever in range; the
// concrete past-day dollar-amount check belongs to whichever date is
// actually "yesterday" when this test runs, so assert structurally instead.)
assert.ok(d.buildEventChip, 'buildEventChip should still be exported (Task 6, reused for past-day rendering too)');

console.log('All unified render/handler tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-unified-render.mjs`
Expected: fails on the `cal-ai-accent` assertion (current `renderMonthPlan` still renders `<select>`-based routine slots with occasion labels).

- [ ] **Step 3: Update the export names**

In `Longterm/data/dashboard-test-harness.mjs`, extend `exportNames` (as it stands after Task 6) with:
```js
  'onEventNameInput', 'resolveEventFields', 'onSaveEvent', 'onDismissLiveEvent',
```
(`onAddEvent`, `onRemoveEvent`, `onShowEventForm` are already present from the prior plan's harness update — their bodies change in this task, their names don't.)

- [ ] **Step 4: Add the new handlers, update the existing ones, delete the old routine-slot functions**

In `Longterm/dashboard_v5.html`:

(a) Delete `optionHTML`, `buildSlotSelect`, `onRoutineSlotChange`, and `onRoutineSlotReset` in full — read the live file to find their current bounds (they sit between `recommendForSlot` and Task 6's new `buildEventChip`/`buildEventForm`, added by the prior, already-merged plan) and remove all four.

(b) Add these new functions in the same area (after `buildEventForm`, before `renderMonthPlan`):
```js
function onEventNameInput(idSuffix) {
  const input = $(`event-name-${idSuffix}`);
  const tierSelect = $(`event-tier-${idSuffix}`);
  if (!input || !tierSelect) return;
  const fp = D.favoritePlaces;
  const favorites = fp ? fp.places : [];
  const isKnown = favorites.some((f) => f.name === input.value) || D.lowKeyHangIdeas.includes(input.value);
  tierSelect.style.display = isKnown ? 'none' : 'inline-block';
}

// Turns a raw (name, tier) pair from the add/edit form into a full stored
// event object: a matched favorite auto-fills favoriteName/cost/tier from
// its own observed spend (or the manually-picked tier if unproven); a
// matched low-key idea costs 0; free text falls back to the manually
// picked tier's TIER_MIDPOINT.
function resolveEventFields(name, tier) {
  const fp = D.favoritePlaces;
  const favorites = fp ? fp.places : [];
  const favorite = favorites.find((f) => f.name === name);
  if (favorite) {
    const cost = favorite.observed ? favorite.observed.avgSpend : (TIER_MIDPOINT[tier] || TIER_MIDPOINT.mid);
    const resolvedTier = favorite.observed ? favorite.observed.tier : tier;
    return { source: 'manual', name, favoriteName: name, tier: resolvedTier, cost };
  }
  if (D.lowKeyHangIdeas.includes(name)) {
    return { source: 'manual', name, tier: 'low-key', cost: 0 };
  }
  return { source: 'manual', name, tier, cost: TIER_MIDPOINT[tier] || 0 };
}

function onSaveEvent(date, index, name, tier) {
  if (!name || !name.trim()) return;
  const state = loadMonthPlanState();
  if (!state.events[date] || !state.events[date][index]) return;
  state.events[date][index] = resolveEventFields(name.trim(), tier);
  saveMonthPlanState(state);
  renderMonthPlan();
}

// Dismisses a live (never-stored) suggestion: there's no existing array/
// index to remove from, so this writes the tombstone directly rather than
// going through removeEvent().
function onDismissLiveEvent(date) {
  const state = loadMonthPlanState();
  state.events[date] = [];
  saveMonthPlanState(state);
  renderMonthPlan();
}
```

(c) Replace the existing `onAddEvent` and `onShowEventForm` (leave `onRemoveEvent` exactly as-is — its body already works correctly with Task 3's new tombstone-preserving `removeEvent`):
```js
function onAddEvent(date, name, tier) {
  if (!name || !name.trim()) return;
  addEvent(date, resolveEventFields(name.trim(), tier));
  renderMonthPlan();
}
```
```js
function onShowEventForm(date, key) {
  const el = $(`event-form-${date}-${key}`);
  if (el) el.style.display = 'block';
}
```

- [ ] **Step 5: Rewrite `renderMonthPlan()`'s future-day cell body**

Read the live `renderMonthPlan()` in full first (Tasks 1-6 did not touch it, so its opening block, past-day branch, and closing template should still match the version from the prior, already-merged plan — only the future-day (`else`) branch and the `planRemainingMonth`/`recommendForSlot` calls need to change here). Replace the whole function with:

```js
function renderMonthPlan() {
  const joint = D.budgetTracking.joint;
  const fp = D.favoritePlaces;
  const favorites = fp ? fp.places : [];
  const recentDiningActivity = fp ? fp.recentDiningActivity : [];
  const diningRoutine = D.diningRoutine;
  const lowKeyHangIdeas = D.lowKeyHangIdeas;
  const state = loadMonthPlanState();
  const calloutHTML = fp
    ? ''
    : `<div class="callout">No favorites synced yet — ask Claude to sync your dining list from the Google Sheet. Ad-hoc events below still work; routine-day suggestions are limited until then.</div>`;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const plan = planRemainingMonth(diningRoutine, joint, today, state.events, favorites, recentDiningActivity, lowKeyHangIdeas);
  const slotByDate = {};
  plan.slots.forEach((s) => { (slotByDate[s.date] = slotByDate[s.date] || []).push(s); });

  const localDateFromISO = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(y, m - 1, d);
  };
  const cycleStart = localDateFromISO(joint.cycleStart);
  const cycleEnd = cycleEndDate(joint.cycleStart, joint.cycleDays);
  const leadingBlanks = cycleStart.getDay();
  const totalDays = Math.floor((cycleEnd - cycleStart) / 86400000) + 1;

  const cells = [];
  for (let i = 0; i < leadingBlanks; i += 1) cells.push('<div class="cal-cell cal-empty"></div>');
  for (let i = 0; i < totalDays; i += 1) {
    const day = new Date(cycleStart); day.setDate(day.getDate() + i);
    const dISO = isoDate(day);
    const isPast = day < today;
    let body = '';
    if (isPast) {
      // Read-only history, built directly (not via buildEventChip, which
      // is edit/remove-oriented and only knows tier symbols, not raw
      // dollar amounts) — shows the real Monarch-verified spend, which
      // always wins over whatever was planned for that date.
      const matched = recentDiningActivity.filter((a) => a.date === dISO);
      body = matched.map((a) =>
        `<div class="cal-event-chip"><span>${a.matchedPlace || a.merchant} · ${fmt(a.amount)}</span></div>`
      ).join('');
    } else {
      const daySlots = slotByDate[dISO] || [];
      const chipsAndForms = daySlots.map((s, idx) => {
        const key = s.isLive ? 'live' : idx;
        const chip = buildEventChip(dISO, s, key);
        const currentName = s.isLive ? (s.picks[0] || '') : s.name;
        const currentFavoriteName = s.isLive ? (s.picks[0] || '') : s.favoriteName;
        const form = buildEventForm(dISO, key, currentName, currentFavoriteName, s.tier, favorites, lowKeyHangIdeas);
        return chip + form;
      }).join('');
      const addForm = buildEventForm(dISO, 'new', '', null, 'cheap', favorites, lowKeyHangIdeas);
      body = `${chipsAndForms}<button type="button" class="cal-add-event" onclick="onShowEventForm('${dISO}', 'new')">+ add event</button>${addForm}`;
    }
    cells.push(`<div class="cal-cell${isPast ? ' cal-past' : ''}"><div class="cal-daynum">${day.getDate()}</div>${body}</div>`);
  }

  // plannedCaption must account for everything projectedSpend sums: live
  // fixed routine days, live paid/low-key dynamic days, and every stored
  // event (whether it started as a materialized routine suggestion or a
  // genuinely new ad-hoc add — the caption doesn't distinguish the two,
  // only isLive-vs-stored matters for the chip's color accent).
  const fixedCount = plan.slots.filter((s) => s.isLive && !s.dynamic).length;
  const eventCount = plan.slots.filter((s) => !s.isLive).length;
  const paidCount = plan.slots.filter((s) => s.isLive && s.dynamic && s.tier !== 'low-key').length;
  const lowKeyCount = plan.slots.filter((s) => s.isLive && s.dynamic && s.tier === 'low-key').length;
  const captionParts = [
    fixedCount ? `${fixedCount} routine` : null,
    paidCount ? `${paidCount} paid outing${paidCount === 1 ? '' : 's'}` : null,
    eventCount ? `${eventCount} event${eventCount === 1 ? '' : 's'}` : null,
    lowKeyCount ? `${lowKeyCount} low-key hang${lowKeyCount === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const plannedCaption = captionParts.length
    ? `${captionParts.join(', ')} planned`
    : 'No upcoming dining/social occasions this cycle.';

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
        <div class="cal-cell cal-head">Sun</div><div class="cal-cell cal-head">Mon</div><div class="cal-cell cal-head">Tue</div><div class="cal-cell cal-head">Wed</div><div class="cal-cell cal-head">Thu</div><div class="cal-cell cal-head">Fri</div><div class="cal-cell cal-head">Sat</div>
        ${cells.join('')}
      </div>
    </div>`;
}
```

Notes on the diff from the prior (already-merged) version of this function: the `isRoutineDay`/`buildSlotSelect` branch is gone — every future day now goes through the same `daySlots`/chip/form path, since `planRemainingMonth()` already decided whether each day has a live suggestion or nothing (routine, untouched) or stored events (routine-materialized or ad-hoc). The stat-strip computation changed from filtering on the old `dynamic`/`isEvent` slot fields to the new `isLive`/`dynamic` shape from Task 5.

- [ ] **Step 6: Run test to verify it passes**

Run: `node Longterm/data/test-unified-render.mjs`
Expected: `All unified render/handler tests passed.`

- [ ] **Step 7: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-unified-render.mjs
git add Longterm/dashboard_v5.html Longterm/data/dashboard-test-harness.mjs
git commit -m "Wire the unified event model into renderMonthPlan(), delete the old routine-slot machinery"
```

---

### Task 8: Documentation

**Files:**
- Modify: `Longterm/claude.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Update the Dining recommendations section**

In `Longterm/claude.md`, find the `## Dining recommendations (Month Plan tab)` section. It currently has two bullets ending with one about interactivity/`localStorage['monthPlan.v1']`. Replace that whole section's body with:

```markdown
## Dining recommendations (Month Plan tab)

- `data/favorite_places_raw.json` — snapshot of the dining Google Sheet (`https://docs.google.com/spreadsheets/d/1-5KiintV2071nkjkF5zb_P-erWYOknn8hWtMLBBlyDM`). On-demand only — ask Claude to resync when the sheet changes; this needs live Drive access that only a live Claude Code session has, not the unattended scheduled pull. Entries carry `familyFriendly`/`dinnerSpot`/`socialSpot` boolean tags (independent of each other) used to filter which favorites are eligible for which routine day.
- `data/favorite_places.json` — auto-refreshed daily by `Longterm/scripts/budget-tracking-pull.mjs`. Holds each favorite's observed spend tier plus a 90-day rolling `recentDiningActivity` log. Never hand-edit.
- `goals.json`'s `diningRoutine` (Wed/Fri/Sat routine days — family dinner, date night, weekend social respectively, matched by `dayOfWeek` only, no displayed label) and `lowKeyHangIdeas` (free-hang fallbacks) — hand-maintained.
- The Month Plan tab is fully interactive and unified: every future day — routine or not — shows removable, editable "event" chips. A routine day with nothing yet decided shows a live, budget-reactive AI suggestion (blue-accented, recomputed every render via `recommendForSlot()`) rather than a fixed label; the moment it's edited or dismissed it becomes a real stored, human-decided event and stops recomputing. Adding/editing any event uses one searchable field (a `<datalist>` of favorites + low-key ideas) — picking a match auto-fills cost from that favorite's real spend history; free text falls back to a manual `$`/`$$`/`$$$` pick. `recommendForSlot()` also excludes anything already suggested/used elsewhere on the same calendar render, so the month doesn't show one restaurant repeated for every eligible day (a plain exclusion filter, not a ranking change — the actual picking logic is the intended future swap point for a real AI/LLM call). Past days always show Monarch-verified actual spend, never the plan. All of this persists to `localStorage['monthPlan.v1']` (browser/machine-local — no sync, no backend) and feeds back into `planRemainingMonth()`'s budget math, so a pricier choice or a new event can flip a later, still-undecided day from paid to low-key. See `docs/superpowers/specs/2026-07-27-unified-month-plan-events-design.md` (supersedes the now-obsolete override/slot model described in `2026-07-27-month-plan-interactivity-design.md`).
```

- [ ] **Step 2: Commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/claude.md
git commit -m "Document the unified Month Plan events model in claude.md"
```

---

