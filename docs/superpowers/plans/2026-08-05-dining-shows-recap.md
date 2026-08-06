# Dining + Shows: Recap Redesign, Upcoming-Shows Tool, and Dashboard Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Telegram recap into structured sections, add an on-demand
"upcoming shows" bot capability that caches its findings, and build a new
interactive "Dining + Shows" dashboard tab where Kevin/Hanna can star-rate
restaurants and venues, with that rating feeding back into the recommendation
ranking.

**Architecture:** Five sequential tasks, each independently testable. Tasks 1-2 touch
the Telegram bot (`telegram-bot-recap.mjs`, `telegram-bot-tools.mjs`,
`telegram-bot-poll.mjs`). Tasks 3-4 add a write-back API + scoring term
(`dashboard-server.mjs`, `dining-recommendation.mjs`). Task 5 is the dashboard UI
(`dashboard_v5.html`), consuming Task 3's new routes.

**Tech Stack:** Plain Node.js (no framework), raw `node:http`, vanilla JS/HTML/CSS in
`dashboard_v5.html` (no build step, no framework), Anthropic Messages API with the
hosted `web_search_20260209` tool.

## Global Constraints

- No new npm dependencies — this project has none today and every existing script is
  plain Node with no framework; match that.
- Every live external call (Anthropic, web search) must degrade to a clear,
  non-crashing reply on failure — never throw out of a bot-tool-facing function.
- Every new file read must handle "file missing/corrupt" by degrading to an empty/
  default shape, not throwing — this is the established convention throughout this
  codebase (see `refreshFavoritePlaces`, `readEvents`, `readRoutineOverrides`, etc.).
- Test files in this repo are plain Node scripts with a hand-rolled `test`/`asyncTest`
  runner (no test framework) — run via `node data/test-<name>.mjs`, asserting with
  `node:assert/strict`. Match this exactly; do not introduce a test framework.
- `favorite_places_raw.json` is the hand-maintained source of truth (as of 2026-08-05
  — see `CLAUDE.md`'s dining section); `favorite_places.json` is a derived/bundled
  file, never hand-edited directly except by the narrow rating patch in Task 3 (which
  patches both, by design, to keep them consistent without a full Monarch-driven
  regeneration).

---

### Task 1: Recap redesign — structured Budget/Todos/Planning sections, plus refunds

**Files:**
- Modify: `scripts/budget-tracking-pull.mjs` (new: refund/credit detection on the
  joint card, feeding a new `tracking.joint.refunds` field)
- Modify: `scripts/financial-context.mjs` (expose refunds through
  `loadTransactionDetail`)
- Modify: `scripts/telegram-bot-recap.mjs`
- Test: `data/test-budget-tracking-pull.mjs`, `data/test-telegram-recap.mjs`

**Interfaces:**
- Consumes: `financialContext.transactions` (array of `{tracker, group, date, merchant,
  amount, type?}`, produced by `scripts/financial-context.mjs`'s
  `loadTransactionDetail`/`loadFinancialContext` — `type: 'refund'` is new this task,
  present only on refund rows; existing spend rows have no `type` field, unchanged).
  `listOpenItems(todos)` (already imported from `telegram-bot-tools.mjs`, returns
  `{title, owner, dateAdded, deadline, done}[]`).
- Produces: `tracking.joint.refunds` (array of `{date, merchant, amount, category}`,
  written by `budget-tracking-pull.mjs`'s main pull, same file/shape convention as
  `tracking.joint.categories`). `gatherBundle()`'s returned object gains
  `budgetLineItems` (array), `budgetRefunds` (array), and `todosByOwner` (object keyed
  by owner id, each value an array of `{title, dateAdded, deadline}`); loses
  `staleTodo` (superseded — the full `todosByOwner` list already carries `dateAdded`
  for every item, so a separate single-oldest-item field is redundant now).

- [ ] **Step 0: Write the failing test for refund detection**

Real Monarch data confirms the exact filter needed: a card's own statement payment
(Barclays/Chase paying off the balance) always carries category `"Credit Card
Payment"` — a genuine merchant refund/credit keeps its original spend category (e.g.
an Amazon return still shows category `"Shopping"`) and is a positive amount on the
joint card. Add to `data/test-budget-tracking-pull.mjs`, after the existing tests
(before the `computeFavoritePlacesHistory` section, or at the end — anywhere at top
level is fine):

```js
// --- Refund/credit detection (2026-08-05) ---
// Reuses the same txn()/JOINT_LABELS fixtures already in this file; refund
// detection isn't part of refreshFavoritePlaces, so these tests call the main
// pull's transaction-processing directly via a small re-export the
// implementation step below adds: detectJointRefunds(transactions, jointLabels, travelCategoryNames).

import { detectJointRefunds } from '../scripts/budget-tracking-pull.mjs';

test('detectJointRefunds finds a genuine merchant refund (positive amount, original spend category, joint card)', () => {
  const refunds = detectJointRefunds([
    txn({ id: 'r1', date: '2026-07-20', amount: 39.5, merchant: 'Amazon', category: 'Shopping' }),
  ], JOINT_LABELS, new Set());
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].merchant, 'Amazon');
  assert.equal(refunds[0].amount, 39.5);
  assert.equal(refunds[0].category, 'Shopping');
});

test('detectJointRefunds excludes the card\'s own statement payment ("Credit Card Payment" category)', () => {
  const refunds = detectJointRefunds([
    txn({ id: 'p1', date: '2026-07-02', amount: 185, merchant: 'Payment Received', category: 'Credit Card Payment' }),
  ], JOINT_LABELS, new Set());
  assert.equal(refunds.length, 0);
});

test('detectJointRefunds excludes travel-category credits (travel has its own separate tracking)', () => {
  const refunds = detectJointRefunds([
    txn({ id: 't1', date: '2026-07-28', amount: 200, merchant: 'Lufthansa', category: 'Travel & Vacation' }),
  ], JOINT_LABELS, new Set(['travel & vacation']));
  assert.equal(refunds.length, 0);
});

test('detectJointRefunds excludes negative-amount (regular spend) and non-joint-card transactions', () => {
  const refunds = detectJointRefunds([
    txn({ id: 's1', date: '2026-07-20', amount: -39.5, merchant: 'Amazon', category: 'Shopping' }),
    txn({ id: 's2', date: '2026-07-20', amount: 39.5, merchant: 'Amazon', category: 'Shopping', account: 'Some Personal Card (...1111)' }),
  ], JOINT_LABELS, new Set());
  assert.equal(refunds.length, 0);
});
```

- [ ] **Step 0b: Run the test to verify it fails**

Run: `node data/test-budget-tracking-pull.mjs`
Expected: FAIL — `detectJointRefunds` is not exported yet (import error).

- [ ] **Step 0c: Implement refund detection in `budget-tracking-pull.mjs`**

Add this exported function, placed right after `matchFavorite` (before `tierFromAvg`):

```js
// Refunds/credits (2026-08-05): a positive-amount joint-card transaction
// that isn't the card's own statement payment ("Credit Card Payment"
// category — Barclays/Chase paying off the balance, not a merchant
// crediting money back — confirmed against real Monarch data) or travel
// (already excluded from the joint budget entirely, same as travel spend —
// travel refunds would need to reduce a trip's actual instead, out of scope
// here). spendAmount() deliberately zeroes out any non-negative amount, so
// this is a separate pass, not part of the main spend-processing loop.
export function detectJointRefunds(transactions, jointLabels, travelCategoryNames) {
  const refunds = [];
  for (const txn of transactions) {
    const rawAmount = Number(txn.amount);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) continue;
    const acct = accountLabel(txn);
    if (!jointLabels.has(acct)) continue;
    const catDisplay = categoryName(txn) || 'Uncategorized';
    const cat = catDisplay.toLowerCase();
    if (cat === 'credit card payment') continue;
    if (travelCategoryNames.has(cat)) continue;
    refunds.push({
      date: txn.date,
      merchant: txn.merchant || txn.plaidName || '',
      amount: Math.round(rawAmount * 100) / 100,
      category: catDisplay,
    });
  }
  return refunds.sort((a, b) => a.date.localeCompare(b.date));
}
```

Then in `main()`, find where `travelCategories` is built (`const travelCategories = new Set(tracking.mapping.travelCategoryNames.map((c) => c.toLowerCase()));`) and, a few lines later where `jointLabels` is built, add immediately after the main `for (const txn of transactions) { ... }` processing loop finishes (i.e., right before the `function bucketsToWeeks` definition, which is itself before the `tracking.personal`/`tracking.joint` assignment block) a call to compute refunds:

```js
    const jointRefunds = detectJointRefunds(transactions, jointLabels, travelCategories);
```

And in the `if (jointLabels.size > 0) { tracking.joint.weeks = ...; tracking.joint.categories = ...; ... }` block, add:

```js
      tracking.joint.refunds = jointRefunds;
```

immediately after the `tracking.joint.categories = categoryTotalsToArray(...)` line, inside that same `if` block.

- [ ] **Step 0d: Run the test to verify it passes**

Run: `node data/test-budget-tracking-pull.mjs`
Expected: `All budget-tracking-pull tests passed.`

- [ ] **Step 0e: Expose refunds through `financial-context.mjs`**

In `scripts/financial-context.mjs`'s `loadTransactionDetail` function, find:

```js
  addCategories('joint', bt.joint?.categories);
```

and add immediately after it:

```js
  for (const txn of bt.joint?.refunds || []) {
    rows.push({ tracker: 'joint', group: txn.category || 'Refund', date: txn.date, merchant: txn.merchant, amount: txn.amount, type: 'refund' });
  }
```

No test file changes needed for this step — `loadTransactionDetail` has no dedicated unit test file today (it's exercised indirectly through the recap and `search_transactions` tests); Step 1 below's new bundle test is what actually verifies this wiring end-to-end.

- [ ] **Step 1: Write the failing tests for the bundle/prompt redesign**

Add to `data/test-telegram-recap.mjs`, after the existing
`'gathers all signal categories...'` test:

```js
await asyncTest('bundle includes budgetLineItems: every joint-tracker charge over $100 this cycle', async () => {
  const dir = path.join(tmpRoot, 'budget-line-items');
  const paths = writeFixture(dir, {
    budgetTracking: {
      joint: {
        targetExpenseKey: 'Family budget',
        weeks: [{ actual: 1000, days: 7 }],
        cycleDays: 30,
        categories: [
          { name: 'Insurance', amount: 489.26, transactions: [{ date: '2026-07-26', merchant: 'Geico', amount: 489.26 }] },
          { name: 'Groceries', amount: 45, transactions: [{ date: '2026-07-28', merchant: 'Whole Foods', amount: 45 }] },
        ],
      },
      personal: { kevin: { label: 'Kevin personal', targetExpenseKey: 'Kevin personal', weeks: [{ actual: 900, days: 7 }], cycleDays: 30 } },
      travel: { trips: [] },
    },
  });
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(capturedBundle.budgetLineItems.length, 1, 'only the >$100 charge should be included');
  assert.equal(capturedBundle.budgetLineItems[0].merchant, 'Geico');
  assert.equal(capturedBundle.budgetLineItems[0].amount, 489.26);
});

await asyncTest('bundle includes budgetRefunds: every joint-tracker refund this cycle, and refunds are excluded from budgetLineItems', async () => {
  const dir = path.join(tmpRoot, 'budget-refunds');
  const paths = writeFixture(dir, {
    budgetTracking: {
      joint: {
        targetExpenseKey: 'Family budget',
        weeks: [{ actual: 1000, days: 7 }],
        cycleDays: 30,
        categories: [
          { name: 'Groceries', amount: 45, transactions: [{ date: '2026-07-28', merchant: 'Whole Foods', amount: 45 }] },
        ],
        refunds: [
          { date: '2026-07-29', merchant: 'Amazon', amount: 150.5, category: 'Shopping' },
        ],
      },
      personal: { kevin: { label: 'Kevin personal', targetExpenseKey: 'Kevin personal', weeks: [{ actual: 900, days: 7 }], cycleDays: 30 } },
      travel: { trips: [] },
    },
  });
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(capturedBundle.budgetRefunds.length, 1);
  assert.equal(capturedBundle.budgetRefunds[0].merchant, 'Amazon');
  assert.equal(capturedBundle.budgetRefunds[0].amount, 150.5);
  assert.equal(capturedBundle.budgetLineItems.length, 0, 'a refund over $100 should not also appear as a budgetLineItems spend line');
});

await asyncTest('bundle includes todosByOwner: every open item grouped by owner, staleTodo is gone', async () => {
  const dir = path.join(tmpRoot, 'todos-by-owner');
  const paths = writeFixture(dir, {
    todos: {
      meta: { description: 'test' },
      items: [
        { title: 'Kevin item 1', owner: 'kevin', dateAdded: '2026-07-01', deadline: null, done: false },
        { title: 'Kevin item 2', owner: 'kevin', dateAdded: '2026-07-20', deadline: null, done: false },
        { title: 'Hanna item', owner: 'hanna', dateAdded: '2026-07-28', deadline: null, done: false },
        { title: 'Done item', owner: 'kevin', dateAdded: '2026-06-01', deadline: null, done: true },
      ],
      weeklyGoals: [],
    },
  });
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(capturedBundle.todosByOwner.kevin.length, 2, 'both open Kevin items, not the done one');
  assert.equal(capturedBundle.todosByOwner.hanna.length, 1);
  assert.equal(capturedBundle.todosByOwner.kevin[0].title, 'Kevin item 1');
  assert.equal(capturedBundle.staleTodo, undefined, 'staleTodo field is superseded by todosByOwner');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-telegram-recap.mjs`
Expected: FAIL — `capturedBundle.budgetLineItems` is `undefined`, and
`capturedBundle.todosByOwner` is `undefined` (the field is currently called `staleTodo`
and shaped differently).

- [ ] **Step 3: Implement the bundle changes**

In `scripts/telegram-bot-recap.mjs`, replace the `oldestStaleTodo` function and
`gatherBundle` function (currently around the existing `oldestStaleTodo`/`gatherBundle`
definitions) with:

```js
// Budget section (2026-08-05 recap redesign): every joint-tracker line item
// over $100 this cycle, not just the aggregate pace number — reuses the same
// financialContext.transactions the interactive bot's search_transactions
// tool reads (see financial-context.mjs's loadTransactionDetail), so the
// recap and an ad-hoc "was X charged" question always agree. Explicitly
// excludes refund rows (type === 'refund') — those get their own
// budgetRefunds field below, not double-counted as a spend line here.
function budgetLineItemsOver100(financialContext) {
  return (financialContext.transactions || [])
    .filter((t) => t.tracker === 'joint' && t.amount > 100 && t.type !== 'refund')
    .sort((a, b) => b.amount - a.amount);
}

// Refunds/credits this cycle (2026-08-05) — see budget-tracking-pull.mjs's
// detectJointRefunds and financial-context.mjs's loadTransactionDetail for
// where these come from. Kevin: "critical change in recap. I want a line
// item for refunds."
function budgetRefundsThisCycle(financialContext) {
  return (financialContext.transactions || [])
    .filter((t) => t.tracker === 'joint' && t.type === 'refund')
    .sort((a, b) => b.amount - a.amount);
}

// Todos section (2026-08-05 recap redesign): every open item, grouped by
// owner — replaces the single-oldest-item summary (oldestStaleTodo), since
// each item already carries dateAdded and the LLM can note aging within the
// full list rather than needing a separate flagged field.
function todosByOwner(todos) {
  const grouped = {};
  for (const item of listOpenItems(todos)) {
    if (!grouped[item.owner]) grouped[item.owner] = [];
    grouped[item.owner].push({ title: item.title, dateAdded: item.dateAdded, deadline: item.deadline });
  }
  return grouped;
}
```

Then update `gatherBundle` (same file) to:

```js
// savingsGoals (life-goal progress %, e.g. "Croatia brokerage 47%")
// deliberately excluded (2026-08-02) — Kevin: "it included longterm goals.
// not wanted in the weekly recaps. just the week." Scoped to the recap only;
// the interactive get_savings_goals tool and the dashboard are unaffected.
function gatherBundle({ todos, monthPlanEvents, diningContext, financialContext, now, unparsedMessages, calendarSummary, recentPlanChanges }) {
  return {
    budgetStatus: financialContext.budgetStatus,
    budgetLineItems: budgetLineItemsOver100(financialContext),
    budgetRefunds: budgetRefundsThisCycle(financialContext),
    decisions: financialContext.decisions,
    dining: diningSummary(monthPlanEvents, diningContext),
    todosByOwner: todosByOwner(todos),
    unparsedMessages,
    calendarSummary,
    recentPlanChanges,
  };
}
```

Remove the old `oldestStaleTodo` function entirely (it's now unused — `daysAgo` may
still be used elsewhere in the file; if `daysAgo` becomes unused after this removal,
remove it too — check with a grep for other call sites before deleting it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-telegram-recap.mjs`
Expected: PASS on the three new tests (budgetLineItems, budgetRefunds, todosByOwner).
The original `'gathers all signal categories...'` test will now FAIL (it asserts
`capturedBundle.staleTodo.title` — see Step 5).

- [ ] **Step 5: Update the now-outdated assertion in the existing bundle-contents test**

In `data/test-telegram-recap.mjs`, find the test named
`'gathers all signal categories into the bundle handed to the LLM (scoped to the week, no long-term goals)'`
and replace its final two assertions:

```js
  assert.equal(capturedBundle.staleTodo.title, 'Oldest open item', 'bundle should surface only the single oldest open to-do');
  assert.equal(capturedBundle.staleTodo.owner, 'kevin');
```

with:

```js
  assert.equal(capturedBundle.todosByOwner.kevin[0].title, 'Oldest open item', 'bundle should group every open to-do by owner');
  assert.equal(capturedBundle.todosByOwner.hanna[0].title, 'Newer item');
  assert.deepEqual(capturedBundle.budgetLineItems, [], 'no line item over $100 in the default fixture');
  assert.deepEqual(capturedBundle.budgetRefunds, [], 'no refunds in the default fixture');
```

- [ ] **Step 6: Rewrite the system prompt for the structured format**

In `scripts/telegram-bot-recap.mjs`, replace the entire `RECAP_SYSTEM_PROMPT` constant
with:

```js
const RECAP_SYSTEM_PROMPT = `Compose a weekly recap message for a household Telegram group (Kevin & Hanna), using exactly three labeled sections in this order: "Budget:", "Todos:", "Planning:". Within each section, write naturally (not a bare data dump) but keep it skimmable — short lines, not paragraphs; a busy person reading on their phone should get the gist of each section in a few seconds.

Budget: report the joint tracker's pace using real dollar figures (amount logged so far, projected cycle total, target — e.g. "$1,270 logged, projected $5,442 vs a $5,500 target", from budgetStatus.joint), then list every joint-card line item over $100 this cycle from budgetLineItems (merchant, amount, and its group/category) — if budgetLineItems is empty, say so briefly rather than omitting the line entirely. Always include a refunds line too, from budgetRefunds (merchant and amount for each) — if budgetRefunds is empty, say plainly that there were no refunds this cycle rather than skipping the line; refunds are a standing part of this section, not an optional trailing callout.

Todos: list every open to-do from todosByOwner, grouped by the owner it's under (e.g. "Kevin: ..." then "Hanna: ..."), noting how long ago an item was added only if it's been sitting a while (more than a week or two) — skip an owner's line entirely if they have nothing open, rather than saying "none."

Planning: one line per routine occasion (family dinner / date night / weekend social) from the dining field, same as always — a live suggestion should prompt for a quick confirming reply (only a confirmed pick gets pushed to the shared Google Calendar); an already-confirmed pick or a "looks already covered" note is just mentioned in passing, not pushed for a reply.

After the three sections, always add one short standing line inviting a follow-up about upcoming shows, worded naturally each time but along these lines: "Curious what's on at our favorite venues? Just ask — I can check the next couple weeks." Include this every time, not conditionally.

Then, only if there's something notable, add one or two short trailing lines for: an urgent open decision (decisions, only flag one with status "urgent" — don't list every open decision), a non-recurring event on either Google calendar this week (calendarSummary — name whose calendar and the date; skip if calendarSummary is null or nothing non-recurring is on either calendar), unprocessed messages since the last recap (unparsedMessages — one line, don't quote them all verbatim), or a recent direct edit to the real financial plan (recentPlanChanges — if count is non-zero, mention briefly what changed using recentPlanChanges.recent as a hint). Skip any of these four with nothing to report — don't force a line just to fill space.

Never mention long-term savings goal progress or percentages — that's a different cadence of update, not part of this one. Do not use markdown formatting (no headers, no bullets, no bold) — plain text with the three section labels as the only structure. Keep the whole message focused; three clear sections plus at most a couple of trailing lines, not a wall of text.`;
```

- [ ] **Step 7: Run the full recap and budget-tracking-pull test suites**

Run: `node data/test-telegram-recap.mjs`
Expected: `All tests passed.` (every test, including the ones from earlier tasks this
session covering dining/calendar/unparsed/plan-change behavior — none of that logic
changed, only the bundle shape and prompt).

Run: `node data/test-budget-tracking-pull.mjs`
Expected: `All budget-tracking-pull tests passed.` (includes the new
`detectJointRefunds` tests from Step 0, plus every existing test — refund detection is
additive and doesn't touch the existing dedup/spend logic).

- [ ] **Step 8: Commit**

```bash
git add scripts/budget-tracking-pull.mjs scripts/financial-context.mjs scripts/telegram-bot-recap.mjs data/test-budget-tracking-pull.mjs data/test-telegram-recap.mjs
git commit -m "Redesign the weekly recap into structured Budget/Todos/Planning sections, add a refunds line item"
```

---

### Task 2: `get_upcoming_shows` on-demand bot tool

**Files:**
- Modify: `scripts/telegram-bot-tools.mjs` (add `TOOL_DEFS` entry only — no
  implementation here, since this is a live-call tool special-cased in the dispatcher,
  same category as `get_calendar_events`)
- Modify: `scripts/telegram-bot-poll.mjs`
- Test: `data/test-telegram-bot.mjs`

**Interfaces:**
- Consumes: `data/venues_to_follow.json`'s shape
  `{venues: [{name, category, area, address, type, vibe, dinnerPairing, sourceUrl}], weekendSocialSpots: {...}}`
  (already exists, written this session — read-only here).
- Produces: `data/upcoming_shows_cache.json`, shape
  `{fetchedAt: ISO string, days: number, findings: [{text: string, urls: string[]}]}`
  or `{fetchedAt: null, days: null, findings: []}` if nothing has been cached yet —
  this is what Task 5's dashboard tab reads via Task 3's new GET route.

- [ ] **Step 1: Add the tool schema**

In `scripts/telegram-bot-tools.mjs`, add to the `TOOL_DEFS` array, immediately before
the `get_calendar_events` entry:

```js
  {
    name: 'get_upcoming_shows',
    description: 'Report real upcoming shows/events (comedy, music) at the venues in venues_to_follow.json over roughly the next 2 weeks — live web search, Westside-weighted per the household\'s location preference. Only call this when the user actually asks about upcoming shows/events; it is not part of the automatic recap.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days ahead to look. Defaults to 14 if not given.' },
      },
    },
  },
```

- [ ] **Step 2: Write the failing tests**

Add to `data/test-telegram-bot.mjs`, in the "--- get_calendar_events ---" section area
(after those tests, before the "a message asking for two distinct things..." test):

```js
// --- get_upcoming_shows (live web search against venues_to_follow.json, mocked) ---

function writeVenuesFixture(dir, venues) {
  const venuesPath = path.join(dir, 'venues_to_follow.json');
  fs.writeFileSync(venuesPath, JSON.stringify({ venues, weekendSocialSpots: {} }, null, 2));
  return venuesPath;
}

await asyncTest('get_upcoming_shows: reports findings and writes them to the cache file', async () => {
  const dir = path.join(tmpRoot, 'upcoming-shows-basic');
  const venuesPath = writeVenuesFixture(dir, [{ name: 'Largo at the Coronet', area: 'central', address: '366 N La Cienega Blvd' }]);
  const cachePath = path.join(dir, 'upcoming_shows_cache.json');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot any good shows coming up?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_upcoming_shows', input: {} }],
  });
  const mockShowsClient = async () => ({
    content: [
      { type: 'text', text: 'Largo at the Coronet has a show Aug 20.' },
      { type: 'web_search_tool_result', content: [{ url: 'https://example.com/show' }] },
    ],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient, showsClient: mockShowsClient, venuesToFollowPath: venuesPath, upcomingShowsCachePath: cachePath }));
  assert.ok(result.sentReplies[0].includes('Largo at the Coronet has a show Aug 20.'));
  assert.ok(result.sentReplies[0].includes('https://example.com/show'));

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cache.days, 14);
  assert.equal(cache.findings.length, 1);
  assert.ok(cache.fetchedAt);
});

await asyncTest('get_upcoming_shows: a failed live call degrades cleanly and leaves any existing cache untouched', async () => {
  const dir = path.join(tmpRoot, 'upcoming-shows-failure');
  const venuesPath = writeVenuesFixture(dir, [{ name: 'Largo at the Coronet', area: 'central', address: '366 N La Cienega Blvd' }]);
  const cachePath = path.join(dir, 'upcoming_shows_cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: '2026-08-01T00:00:00.000Z', days: 14, findings: [{ text: 'old finding', urls: [] }] }));
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot any shows soon?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_upcoming_shows', input: {} }],
  });
  const mockShowsClient = async () => { throw new Error('network down'); };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient, showsClient: mockShowsClient, venuesToFollowPath: venuesPath, upcomingShowsCachePath: cachePath }));
  assert.ok(result.sentReplies[0].includes("couldn't check upcoming shows" ) || result.sentReplies[0].toLowerCase().includes("couldn't check upcoming shows"));

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cache.findings[0].text, 'old finding', 'a failed call should not clear the existing cache');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `node data/test-telegram-bot.mjs`
Expected: FAIL — `get_upcoming_shows` is an unrecognized tool name (no dispatcher
branch or `TOOL_IMPL` entry exists yet), so `dispatchMessage` logs it to
`telegram-unparsed.jsonl` and falls through to the generic help-text reply instead of
either test's expected reply text.

- [ ] **Step 4: Add path args and the implementation functions**

In `scripts/telegram-bot-poll.mjs`, in `parseArgs`'s default args object, add two new
entries alongside the existing `favoritePlacesPath`:

```js
    venuesToFollowPath: path.join(repoDataDir, 'venues_to_follow.json'),
    upcomingShowsCachePath: path.join(repoDataDir, 'upcoming_shows_cache.json'),
```

And in the same function's `if (key === ...)` chain, alongside the existing
`favorite-places-path` branch:

```js
      else if (key === 'venues-to-follow-path') args.venuesToFollowPath = value;
      else if (key === 'upcoming-shows-cache-path') args.upcomingShowsCachePath = value;
```

Then, immediately after `getCalendarEventsReply` (the function ending
`return "Couldn't reach Google Calendar right now — try again shortly.";\n}`), add:

```js
const UPCOMING_SHOWS_SYSTEM_PROMPT = 'You are researching upcoming live shows for a household assistant Telegram bot. You will be given a list of specific venues (name and area) the household follows. Use web search to find real upcoming shows/events at these venues within the given day window from today. Prioritize venues tagged area "westside" first, since the household prefers closer options, but include any real find at any venue. For each finding, report: venue name, act/event name, date, and a source URL. If a venue has nothing found, do not mention it — only report what you actually find. If nothing at all turns up, say so plainly. Keep the reply concise — a short list, not prose paragraphs.';

async function callAnthropicUpcomingShows({ apiKey, venues, days }) {
  const venueList = venues.map((v) => `${v.name} (${v.area}) — ${v.address}`).join('\n');
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: UPCOMING_SHOWS_SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      messages: [{ role: 'user', content: `Venues:\n${venueList}\n\nDay window: next ${days} days from today (${today}).` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// get_upcoming_shows is a live external call (a second Anthropic request with
// the hosted web_search tool, scoped to venues_to_follow.json's venue list) —
// same category as get_calendar_events, special-cased in the dispatcher
// rather than a TOOL_IMPL entry. On success, caches the raw findings to disk
// so the dashboard's Dining + Shows tab can display them without making its
// own live search; a failed call leaves any existing cache file untouched
// (stale-but-present beats empty). Degrades to a clear, non-crashing reply on
// failure so a shows-lookup hiccup never breaks the rest of the bot's
// replies.
async function getUpcomingShowsReply({ days }, { apiKey, venuesToFollowPath, upcomingShowsCachePath, showsClient }) {
  let venuesData;
  try {
    venuesData = JSON.parse(fs.readFileSync(venuesToFollowPath, 'utf8'));
  } catch {
    return "Don't have a venue list to check yet — data/venues_to_follow.json is missing or unreadable.";
  }
  const venues = venuesData.venues || [];
  if (!venues.length) return 'No venues on the follow list yet.';
  const resolvedDays = days || 14;
  try {
    const client = showsClient || callAnthropicUpcomingShows;
    const response = await client({ apiKey, venues, days: resolvedDays });
    const text = (response.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    const urls = [];
    for (const block of response.content || []) {
      if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
      for (const result of block.content) {
        if (result.url && !urls.includes(result.url)) urls.push(result.url);
      }
    }
    writeJson(upcomingShowsCachePath, { fetchedAt: new Date().toISOString(), days: resolvedDays, findings: text ? [{ text, urls }] : [] });
    if (!text) return "Didn't find anything for the next couple weeks at our followed venues — try again closer to the date.";
    const sourcesLine = urls.length ? `\n\nSources:\n${urls.slice(0, 6).join('\n')}` : '';
    return `${text}${sourcesLine}`;
  } catch (err) {
    return "Couldn't check upcoming shows right now — try again shortly.";
  }
}
```

- [ ] **Step 5: Wire the dispatcher branch**

In `scripts/telegram-bot-poll.mjs`'s `dispatchMessage` function, find the
`if (toolUse.name === 'get_calendar_events') { ... continue; }` branch (inside the
`for (const toolUse of toolUses)` loop) and add a new branch immediately after it:

```js
      if (toolUse.name === 'get_upcoming_shows') {
        rawReplies.push(await getUpcomingShowsReply(toolUse.input, { apiKey, venuesToFollowPath: args.venuesToFollowPath, upcomingShowsCachePath: args.upcomingShowsCachePath, showsClient: args.showsClient }));
        continue;
      }
```

This requires `dispatchMessage` to receive `venuesToFollowPath`, `upcomingShowsCachePath`,
and `showsClient`. Change its signature from:

```js
async function dispatchMessage({ message, owner, todos, monthPlanEvents, routineOverrides, goals, diningContext, financialContext, calendarReadContext, recentConversation, pendingClarification, now, botUsername, apiKey, unparsedPath, goalsChangelogPath, anthropicClient }) {
```

to:

```js
async function dispatchMessage({ message, owner, todos, monthPlanEvents, routineOverrides, goals, diningContext, financialContext, calendarReadContext, recentConversation, pendingClarification, now, botUsername, apiKey, unparsedPath, goalsChangelogPath, anthropicClient, venuesToFollowPath, upcomingShowsCachePath, showsClient }) {
```

And in `runOnce`, change the call site from:

```js
      const result = await dispatchMessage({
        message, owner, todos, monthPlanEvents, routineOverrides, goals, diningContext, financialContext, calendarReadContext, recentConversation, pendingClarification: pendingClarifications[owner] || null, now, botUsername, apiKey, unparsedPath: args.unparsedPath, goalsChangelogPath: args.goalsChangelogPath, anthropicClient: args.anthropicClient,
      });
```

to:

```js
      const result = await dispatchMessage({
        message, owner, todos, monthPlanEvents, routineOverrides, goals, diningContext, financialContext, calendarReadContext, recentConversation, pendingClarification: pendingClarifications[owner] || null, now, botUsername, apiKey, unparsedPath: args.unparsedPath, goalsChangelogPath: args.goalsChangelogPath, anthropicClient: args.anthropicClient, venuesToFollowPath: args.venuesToFollowPath, upcomingShowsCachePath: args.upcomingShowsCachePath, showsClient: args.showsClient,
      });
```

- [ ] **Step 6: Add the tool to the system prompt's read-only tool list**

In `dispatchMessage`'s `callAnthropicFallback` call, find the system prompt string's
list `(list_todos, get_dining_plan, get_budget_status, get_savings_goals, get_decisions, get_calendar_events, search_transactions)`
and add `get_upcoming_shows` to it. Immediately after that sentence, add one more:
`"If the message asks about upcoming shows, concerts, or comedy nights, call get_upcoming_shows — it checks the household's followed venues, not a general search."`

- [ ] **Step 7: Run tests to verify they pass**

Run: `node data/test-telegram-bot.mjs`
Expected: `All tests passed.`

- [ ] **Step 8: Commit**

```bash
git add scripts/telegram-bot-tools.mjs scripts/telegram-bot-poll.mjs data/test-telegram-bot.mjs
git commit -m "Add get_upcoming_shows: on-demand live show lookup against followed venues"
```

---

### Task 3: Dashboard API — rating write-back and read routes

**Files:**
- Modify: `scripts/dashboard-server.mjs`
- Test: `data/test-dashboard-server.mjs`

**Interfaces:**
- Consumes: `data/favorite_places_raw.json` (flat array), `data/favorite_places.json`
  (`{meta, places, recentDiningActivity}`), `data/venues_to_follow.json`
  (`{meta, venues, weekendSocialSpots}`), `data/upcoming_shows_cache.json` (from Task 2).
- Produces: `POST /api/rate-place` (body `{name, rating, kind}`, response
  `{ok: true, name, rating, kind}` or 404/400), `GET /api/upcoming-shows-cache`,
  `GET /api/venues-to-follow` — all consumed by Task 5's dashboard tab.

- [ ] **Step 1: Write the failing tests**

Add to `data/test-dashboard-server.mjs`, after the existing tests (before any trailing
static-file test, or at the end if that's already last):

```js
import { createServer, writeJsonAtomic, ratePlace, rateVenue } from '../scripts/dashboard-server.mjs';
```

(Update the existing import line at the top of the file to add `ratePlace, rateVenue`
to it, rather than adding a second import line.)

```js
const favoriteRawPath = path.join(tmpDir, 'favorite_places_raw.json');
const favoritePlacesPath = path.join(tmpDir, 'favorite_places.json');
const venuesToFollowPath = path.join(tmpDir, 'venues_to_follow.json');
const upcomingShowsCachePath = path.join(tmpDir, 'upcoming_shows_cache.json');

function startFullServer() {
  return new Promise((resolve) => {
    const server = createServer(eventsPath, routineOverridesPath, favoriteRawPath, favoritePlacesPath, venuesToFollowPath, upcomingShowsCachePath);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test('ratePlace patches the rating onto the matching entry in both favorite_places_raw.json and favorite_places.json', async () => {
  fs.writeFileSync(favoriteRawPath, JSON.stringify([{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to' }]));
  fs.writeFileSync(favoritePlacesPath, JSON.stringify({ meta: {}, places: [{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to', observed: null }], recentDiningActivity: [] }));

  const ok = ratePlace(favoriteRawPath, favoritePlacesPath, 'Terra Eataly', 5);
  assert.equal(ok, true);

  const raw = JSON.parse(fs.readFileSync(favoriteRawPath, 'utf8'));
  assert.equal(raw[0].rating, 5);
  const fp = JSON.parse(fs.readFileSync(favoritePlacesPath, 'utf8'));
  assert.equal(fp.places[0].rating, 5);
});

test('ratePlace returns false for an unmatched name, without writing anything', async () => {
  fs.writeFileSync(favoriteRawPath, JSON.stringify([{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to' }]));
  const ok = ratePlace(favoriteRawPath, favoritePlacesPath, 'Nonexistent Place', 3);
  assert.equal(ok, false);
});

test('rateVenue patches a top-level venue by name', async () => {
  fs.writeFileSync(venuesToFollowPath, JSON.stringify({ meta: {}, venues: [{ name: 'Largo at the Coronet', category: 'intimate-listening-room' }], weekendSocialSpots: {} }));
  const ok = rateVenue(venuesToFollowPath, 'Largo at the Coronet', 5);
  assert.equal(ok, true);
  const data = JSON.parse(fs.readFileSync(venuesToFollowPath, 'utf8'));
  assert.equal(data.venues[0].rating, 5);
});

test('rateVenue patches a nested weekendSocialSpots entry by name', async () => {
  fs.writeFileSync(venuesToFollowPath, JSON.stringify({ meta: {}, venues: [], weekendSocialSpots: { venice: [{ name: 'Gjelina', vibe: 'test' }] } }));
  const ok = rateVenue(venuesToFollowPath, 'Gjelina', 4);
  assert.equal(ok, true);
  const data = JSON.parse(fs.readFileSync(venuesToFollowPath, 'utf8'));
  assert.equal(data.weekendSocialSpots.venice[0].rating, 4);
});

test('POST /api/rate-place writes the rating and returns 200 with the echoed body', async () => {
  fs.writeFileSync(favoriteRawPath, JSON.stringify([{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to' }]));
  fs.writeFileSync(favoritePlacesPath, JSON.stringify({ meta: {}, places: [{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to' }], recentDiningActivity: [] }));
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rate-place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Terra Eataly', rating: 4, kind: 'restaurant' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, name: 'Terra Eataly', rating: 4, kind: 'restaurant' });
  } finally {
    server.close();
  }
});

test('POST /api/rate-place returns 404 for an unmatched name', async () => {
  fs.writeFileSync(favoriteRawPath, JSON.stringify([]));
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rate-place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nobody Here', rating: 3, kind: 'restaurant' }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

test('POST /api/rate-place returns 400 for a malformed body (missing kind, out-of-range rating)', async () => {
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rate-place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Terra Eataly', rating: 9 }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

test('GET /api/upcoming-shows-cache returns the empty default shape when the file does not exist yet', async () => {
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/upcoming-shows-cache`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { fetchedAt: null, days: null, findings: [] });
  } finally {
    server.close();
  }
});

test('GET /api/upcoming-shows-cache reflects a file written directly on disk', async () => {
  fs.writeFileSync(upcomingShowsCachePath, JSON.stringify({ fetchedAt: '2026-08-05T00:00:00.000Z', days: 14, findings: [{ text: 'A show', urls: [] }] }));
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/upcoming-shows-cache`);
    const body = await res.json();
    assert.equal(body.findings[0].text, 'A show');
  } finally {
    server.close();
  }
});

test('GET /api/venues-to-follow returns the empty default shape when the file does not exist yet', async () => {
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/venues-to-follow`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { venues: [], weekendSocialSpots: {} });
  } finally {
    server.close();
  }
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-dashboard-server.mjs`
Expected: FAIL — `ratePlace`/`rateVenue` are not exported yet, and the three new routes
don't exist (404/405 instead of the expected responses).

- [ ] **Step 3: Implement the read helpers, write helpers, and routes**

In `scripts/dashboard-server.mjs`, add new default path constants alongside the
existing ones:

```js
const defaultFavoriteRawPath = path.join(repoRoot, 'data', 'favorite_places_raw.json');
const defaultFavoritePlacesPath = path.join(repoRoot, 'data', 'favorite_places.json');
const defaultVenuesToFollowPath = path.join(repoRoot, 'data', 'venues_to_follow.json');
const defaultUpcomingShowsCachePath = path.join(repoRoot, 'data', 'upcoming_shows_cache.json');
```

Add these functions after `readRoutineOverrides`:

```js
export function readUpcomingShowsCache(cachePath) {
  if (!fs.existsSync(cachePath)) return { fetchedAt: null, days: null, findings: [] };
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return { fetchedAt: null, days: null, findings: [] };
  }
}

export function readVenuesToFollow(venuesPath) {
  if (!fs.existsSync(venuesPath)) return { venues: [], weekendSocialSpots: {} };
  try {
    return JSON.parse(fs.readFileSync(venuesPath, 'utf8'));
  } catch {
    return { venues: [], weekendSocialSpots: {} };
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// Patches a `rating` (1-5) field onto the matching entry, by exact name, in
// both the hand-maintained source-of-truth file and its build-time-bundled
// derivative, so the change is visible without needing a full Monarch-driven
// refreshFavoritePlaces regeneration — mirrors telegram-bot-tools.mjs's
// update_phase_expense writing straight into goals.json, no separate review
// gate. Returns true if a match was found and patched, false otherwise
// (caller sends 404).
export function ratePlace(rawPath, favoritePlacesPath, name, rating) {
  if (!fs.existsSync(rawPath)) return false;
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const rawEntry = raw.find((p) => p.name === name);
  if (!rawEntry) return false;
  rawEntry.rating = rating;
  writeJsonAtomic(rawPath, raw);

  if (fs.existsSync(favoritePlacesPath)) {
    const fp = JSON.parse(fs.readFileSync(favoritePlacesPath, 'utf8'));
    const place = (fp.places || []).find((p) => p.name === name);
    if (place) place.rating = rating;
    writeJsonAtomic(favoritePlacesPath, fp);
  }
  return true;
}

// Same idea for venues_to_follow.json — a name can be in the top-level
// `venues` array or nested inside `weekendSocialSpots.<area>`, so this checks
// both shapes rather than assuming one.
export function rateVenue(venuesPath, name, rating) {
  if (!fs.existsSync(venuesPath)) return false;
  const data = JSON.parse(fs.readFileSync(venuesPath, 'utf8'));
  let entry = (data.venues || []).find((v) => v.name === name);
  if (!entry && data.weekendSocialSpots) {
    for (const area of Object.values(data.weekendSocialSpots)) {
      if (!Array.isArray(area)) continue;
      const found = area.find((v) => v.name === name);
      if (found) { entry = found; break; }
    }
  }
  if (!entry) return false;
  entry.rating = rating;
  writeJsonAtomic(venuesPath, data);
  return true;
}
```

Update `createServer`'s signature and body:

```js
export function createServer(
  eventsPath = defaultEventsPath,
  routineOverridesPath = defaultRoutineOverridesPath,
  favoriteRawPath = defaultFavoriteRawPath,
  favoritePlacesPath = defaultFavoritePlacesPath,
  venuesToFollowPath = defaultVenuesToFollowPath,
  upcomingShowsCachePath = defaultUpcomingShowsCachePath,
) {
  return http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];

    if (urlPath === '/api/month-plan-events' && req.method === 'GET') {
      sendJson(res, 200, readEvents(eventsPath));
      return;
    }

    if (urlPath === '/api/dining-routine-overrides' && req.method === 'GET') {
      sendJson(res, 200, readRoutineOverrides(routineOverridesPath));
      return;
    }

    if (urlPath === '/api/upcoming-shows-cache' && req.method === 'GET') {
      sendJson(res, 200, readUpcomingShowsCache(upcomingShowsCachePath));
      return;
    }

    if (urlPath === '/api/venues-to-follow' && req.method === 'GET') {
      sendJson(res, 200, readVenuesToFollow(venuesToFollowPath));
      return;
    }

    // The one write route in this server — see ratePlace/rateVenue above for
    // why it patches two files for a restaurant rating but one for a venue.
    if (urlPath === '/api/rate-place' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400); res.end('Invalid JSON body'); return;
      }
      const { name, rating, kind } = body;
      if (!name || typeof name !== 'string' || !Number.isInteger(rating) || rating < 1 || rating > 5 || (kind !== 'restaurant' && kind !== 'venue')) {
        res.writeHead(400); res.end('Body must be { name: string, rating: 1-5 integer, kind: "restaurant"|"venue" }'); return;
      }
      const ok = kind === 'restaurant'
        ? ratePlace(favoriteRawPath, favoritePlacesPath, name, rating)
        : rateVenue(venuesToFollowPath, name, rating);
      if (!ok) { res.writeHead(404); res.end(`No ${kind} found named "${name}"`); return; }
      sendJson(res, 200, { ok: true, name, rating, kind });
      return;
    }

    if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }
    serveStatic(req, res);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-dashboard-server.mjs`
Expected: `All tests passed.`

- [ ] **Step 5: Commit**

```bash
git add scripts/dashboard-server.mjs data/test-dashboard-server.mjs
git commit -m "Add rating write-back and shows-cache/venues read routes to the dashboard server"
```

---

### Task 4: `recommendForSlot()` rating scoring term

**Files:**
- Modify: `scripts/dining-recommendation.mjs`
- Test: `data/test-dining-recommendation.mjs`

**Interfaces:**
- Consumes: `f.rating` (optional integer 1-5, or absent/undefined) on each favorite
  object passed into `recommendForSlot` — populated by Task 3's `ratePlace` once rated
  via the dashboard.

- [ ] **Step 1: Write the failing tests**

Add to `data/test-dining-recommendation.mjs`:

```js
test('a 5-star rated place outranks an unrated one, all else equal', () => {
  const favorites = [
    { name: 'Unrated', list: 'go-to', cuisine: 'Thai', visitStats: null },
    { name: 'Five Stars', list: 'go-to', cuisine: 'Italian', visitStats: null, rating: 5 },
  ];
  const rec = recommendForSlot(midSlot, favorites, [], [], new Set());
  assert.equal(rec.picks[0], 'Five Stars');
});

test('a 1-star rated place ranks below an unrated one, all else equal', () => {
  const favorites = [
    { name: 'One Star', list: 'go-to', cuisine: 'Thai', visitStats: null, rating: 1 },
    { name: 'Unrated', list: 'go-to', cuisine: 'Italian', visitStats: null },
  ];
  const rec = recommendForSlot(midSlot, favorites, [], [], new Set());
  assert.equal(rec.picks[0], 'Unrated');
});

test('a 3-star rating is neutral — ties with an unrated place, both remain eligible picks', () => {
  const favorites = [
    { name: 'Three Star', list: 'go-to', cuisine: 'Thai', visitStats: null, rating: 3 },
    { name: 'Unrated', list: 'go-to', cuisine: 'Italian', visitStats: null },
  ];
  const rec = recommendForSlot(midSlot, favorites, [], [], new Set());
  assert.equal(rec.picks.length, 2);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-dining-recommendation.mjs`
Expected: FAIL — `rec.picks[0]` is not `'Five Stars'` (both currently tie at the flat
`familiarityScore` since neither has `visitStats`, and array order/other bonuses
decide, not `rating`).

- [ ] **Step 3: Implement the scoring term**

In `scripts/dining-recommendation.mjs`, find the `scored` computation inside
`recommendForSlot` and change:

```js
  const scored = candidates
    .map((f) => ({
      f,
      score: familiarityScore(f)
        - (recentCuisine && f.cuisine === recentCuisine ? 50 : 0)
        + (f.list === 'go-to' ? 10 : 0),
    }))
    .sort((a, b) => b.score - a.score);
```

to:

```js
  const scored = candidates
    .map((f) => ({
      f,
      score: familiarityScore(f)
        - (recentCuisine && f.cuisine === recentCuisine ? 50 : 0)
        + (f.list === 'go-to' ? 10 : 0)
        + ratingScore(f),
    }))
    .sort((a, b) => b.score - a.score);
```

And add the `ratingScore` helper immediately above `familiarityScore`'s own
definition:

```js
// A star rating from the dashboard's Dining + Shows tab (see
// dashboard-server.mjs's ratePlace/rateVenue) is an explicit, direct signal —
// stronger than the implicit visitStats-derived familiarityScore. 3 stars is
// neutral (no term added); each star above/below 3 shifts the score by 6, a
// magnitude comparable to a handful of extra visits under familiarityScore's
// visitCount term, so a strong rating can meaningfully move the ranking
// without completely overriding genuine visit history.
function ratingScore(f) {
  if (!f.rating) return 0;
  return (f.rating - 3) * 6;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-dining-recommendation.mjs`
Expected: `All tests passed.`

- [ ] **Step 5: Commit**

```bash
git add scripts/dining-recommendation.mjs data/test-dining-recommendation.mjs
git commit -m "Add a star-rating scoring term to recommendForSlot"
```

---

### Task 5: "Dining + Shows" dashboard tab

**Files:**
- Modify: `dashboard_v5.html`

**Interfaces:**
- Consumes: `D.favoritePlaces.places` (bundled, from `data/data.js` — each place may
  now carry `rating`/`visitStats` per earlier tasks), `GET /api/venues-to-follow`,
  `GET /api/upcoming-shows-cache` (Task 3), `POST /api/rate-place` (Task 3).

- [ ] **Step 1: Add the nav tab and page container**

In `dashboard_v5.html`, find the `<div class="nav">` block (around line 180) and add a
new tab after the existing four:

```html
<div class="nav">
  <div class="ntab active"  id="ntab-budget"    onclick="show('budget',this)">Planner</div>
  <div class="ntab"         id="ntab-position"  onclick="show('position',this)">Current Position</div>
  <div class="ntab"         id="ntab-goals"     onclick="show('goals',this)">Goals</div>
  <div class="ntab"         id="ntab-decisions" onclick="show('decisions',this)">Decisions</div>
  <div class="ntab"         id="ntab-dining"    onclick="show('dining',this)">Dining + Shows</div>
</div>

<!-- pages filled by JS -->
<div class="page active" id="pg-budget"></div>
<div class="page"        id="pg-position"></div>
<div class="page"        id="pg-goals"></div>
<div class="page"        id="pg-decisions"></div>
<div class="page"        id="pg-dining"></div>
```

- [ ] **Step 2: Write the render function**

Add this function in `dashboard_v5.html`'s `<script>` block, immediately after
`renderGoalsTab` (which ends `updateP6();\n}`):

```js
/* ═══════════════════════════════
   RENDER: DINING + SHOWS
   ═══════════════════════════════ */
async function loadVenuesToFollow() {
  try {
    const res = await fetch('/api/venues-to-follow');
    if (!res.ok) return { venues: [], weekendSocialSpots: {} };
    return await res.json();
  } catch (err) {
    return { venues: [], weekendSocialSpots: {} };
  }
}

async function loadUpcomingShowsCache() {
  try {
    const res = await fetch('/api/upcoming-shows-cache');
    if (!res.ok) return { fetchedAt: null, days: null, findings: [] };
    return await res.json();
  } catch (err) {
    return { fetchedAt: null, days: null, findings: [] };
  }
}

// Named postRating, not ratePlace, to avoid confusion with
// dashboard-server.mjs's exported ratePlace() — that one patches the JSON
// files server-side; this one is the browser-side fetch() call to the API.
async function postRating(name, rating, kind) {
  try {
    await fetch('/api/rate-place', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, rating, kind }),
    });
  } catch (err) {
    // Best-effort — a failed rating write shouldn't break the page; the
    // click just won't visually stick until the user retries.
  }
}

// Renders one star-rating control as inline SVG stars, 1-5, no library.
// `current` is the existing rating (or falsy). Clicking a star re-renders
// this place's row with the new rating filled in immediately (optimistic —
// doesn't wait for the POST to resolve) and fires the write-back.
function starsHTML(name, kind, current) {
  const stars = [1, 2, 3, 4, 5].map((n) => {
    const filled = current && n <= current;
    return `<span class="dstar${filled ? ' filled' : ''}" onclick="onRateClick('${name.replace(/'/g, "\\'")}','${kind}',${n},this)">${filled ? '★' : '☆'}</span>`;
  }).join('');
  return `<span class="dstars">${stars}</span>`;
}

function onRateClick(name, kind, rating, el) {
  const container = el.closest('.dstars');
  container.querySelectorAll('.dstar').forEach((s, i) => {
    const filled = (i + 1) <= rating;
    s.classList.toggle('filled', filled);
    s.textContent = filled ? '★' : '☆';
  });
  postRating(name, rating, kind);
}

function placeRowHTML(place, kind) {
  const cuisine = place.cuisine ? ` — ${place.cuisine}` : '';
  const location = place.location ? ` (${place.location})` : '';
  return `
    <div class="drow">
      <div class="drow-name">${place.name}${cuisine}${location}</div>
      ${starsHTML(place.name, kind, place.rating)}
    </div>`;
}

function eligibleFavorites(tag) {
  const places = (D.favoritePlaces && D.favoritePlaces.places) || [];
  return places.filter((p) => p[tag]);
}

function showsFindingsHTML(cache) {
  if (!cache.findings.length) {
    return `<div class="callout">Nothing cached yet — ask the bot about upcoming shows in Telegram to populate this.</div>`;
  }
  const fetchedLabel = cache.fetchedAt ? new Date(cache.fetchedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const findingsHTML = cache.findings.map((f) => `<div class="drow"><div class="drow-name" style="white-space:pre-wrap">${f.text}</div></div>`).join('');
  return `<div class="callout">Last checked ${fetchedLabel} (next ${cache.days} days)</div>${findingsHTML}`;
}

function weekendSpotsHTML(weekendSocialSpots) {
  const areas = Object.entries(weekendSocialSpots || {});
  if (!areas.length) return '';
  return areas.map(([area, spots]) => `
    <div class="slabel" style="margin-top:18px;font-size:10px">${area}</div>
    ${spots.map((s) => placeRowHTML(s, 'venue')).join('')}
  `).join('');
}

async function renderDiningShowsTab() {
  const familyDinner = eligibleFavorites('familyFriendly');
  const dateNight = eligibleFavorites('dinnerSpot');
  const weekendSocial = eligibleFavorites('socialSpot');
  const [venuesData, showsCache] = await Promise.all([loadVenuesToFollow(), loadUpcomingShowsCache()]);

  $('pg-dining').innerHTML = `
    <div class="content">
      <div class="slabel">Family Dinner</div>
      <div class="panel">
        ${familyDinner.length ? familyDinner.map((p) => placeRowHTML(p, 'restaurant')).join('') : '<div class="callout">No family-friendly favorites tagged yet.</div>'}
      </div>

      <div class="slabel">Date Night — Restaurants</div>
      <div class="panel">
        ${dateNight.length ? dateNight.map((p) => placeRowHTML(p, 'restaurant')).join('') : '<div class="callout">No date-night favorites tagged yet.</div>'}
      </div>

      <div class="slabel">Date Night &amp; Weekend Social — Upcoming Shows</div>
      <div class="panel">
        ${showsFindingsHTML(showsCache)}
      </div>

      <div class="slabel">Weekend Social — Restaurants</div>
      <div class="panel">
        ${weekendSocial.length ? weekendSocial.map((p) => placeRowHTML(p, 'restaurant')).join('') : '<div class="callout">No weekend-social favorites tagged yet.</div>'}
      </div>

      <div class="slabel">Weekend Social — Hangout Ideas by Neighborhood</div>
      <div class="panel">
        ${weekendSpotsHTML(venuesData.weekendSocialSpots)}
      </div>
    </div>`;
}
```

- [ ] **Step 3: Add the CSS for star controls and rows**

In `dashboard_v5.html`'s `<style>` block, add after the existing `.callout` rule
(around line 58):

```css
.drow{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--rule)}
.drow:last-child{border-bottom:none}
.drow-name{font-size:13px;color:var(--mid)}
.dstars{white-space:nowrap}
.dstar{cursor:pointer;font-size:16px;color:var(--rule);user-select:none}
.dstar.filled{color:#d4a017}
```

(`#d4a017` is a muted gold, distinct from any color already used elsewhere in this
file's palette — if a review later finds this clashes, swap it for whichever accent
color the rest of the dashboard actually standardizes on; this is a reasonable default,
not a hard requirement.)

- [ ] **Step 4: Wire up eager rendering in INIT**

In `dashboard_v5.html`'s INIT block (around line 1364), add after `renderDecisionsTab();`:

```js
renderDiningShowsTab();
```

- [ ] **Step 5: Manually verify in the browser**

Run: `npm run dev` (from the `Longterm` directory)
Then open `http://localhost:4200/dashboard_v5.html`, click the "Dining + Shows" tab,
and confirm:
- The tab renders without a console error.
- Family Dinner / Date Night / Weekend Social sections show real favorites (or the
  "no favorites tagged yet" callout if none are tagged for that occasion).
- Clicking a star updates it visually immediately.
- Re-run `node -e "console.log(JSON.parse(require('fs').readFileSync('data/favorite_places_raw.json','utf8')).find(p=>p.name==='<the place you rated>'))"`
  (from the `Longterm` directory) and confirm the `rating` field landed on disk.
- The Upcoming Shows panel shows the "nothing cached yet" callout (since Task 2's tool
  hasn't been triggered from Telegram yet in this environment) rather than looking
  broken.

- [ ] **Step 6: Commit**

```bash
git add dashboard_v5.html
git commit -m "Add the Dining + Shows dashboard tab with interactive star ratings"
```

## Final Verification (all tasks)

Run every affected test file and confirm all pass, with no regressions in files this
plan didn't touch:

```bash
node data/test-telegram-recap.mjs
node data/test-telegram-bot.mjs
node data/test-dashboard-server.mjs
node data/test-dining-recommendation.mjs
node data/test-budget-tracking-pull.mjs
node data/test-dashboard-contract.mjs
```

Then manually smoke-test the two on-demand bot capabilities against real Telegram (not
just mocks) if `~/.longterm/telegram.env` is configured: ask the bot "what's on our
budget this cycle" (confirm the new structured recap-style detail isn't accidentally
leaking into interactive replies — it shouldn't, `get_budget_status` is unchanged) and
"any shows coming up at Largo" (confirm `get_upcoming_shows` fires and a real cache
file appears at `data/upcoming_shows_cache.json`).
