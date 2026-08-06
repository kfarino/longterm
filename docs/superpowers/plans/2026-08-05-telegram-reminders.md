# Telegram Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Telegram bot a real, proactive, one-off, day-level reminder feature — "remind me tomorrow to call the doctor" creates a stored reminder that the bot itself announces to the group on that date, instead of silently becoming an untracked to-do.

**Architecture:** A new `data/reminders.json` store, three new bot tools (`add_reminder`/`list_reminders`/`cancel_reminder`) wired into the existing dispatcher the same way `add_todo`/`remove_event` already are, and a new sibling daily script (`telegram-bot-reminders.mjs`, modeled directly on `telegram-bot-recap.mjs`) that scans for due reminders and sends them as one grouped message via its own Windows Scheduled Task.

**Tech Stack:** Node.js ESM (`.mjs`), hand-rolled `assert/strict` test runners (no test framework), PowerShell `New-ScheduledTaskTrigger` for the daily job — all matching the existing conventions in `scripts/`.

**Design doc:** `docs/superpowers/specs/2026-08-05-telegram-reminders-design.md` — read this first for the "why" behind every choice below (proactive push, day-level only, one-off only, dedicated store not reused todos.json, grouped single message, all-or-nothing batch failure).

## Global Constraints

- Day-level granularity only — no time-of-day field on a reminder, no scheduler more frequent than once daily.
- One-off only — no recurring-reminder concept in this pass.
- Delivery is always to the one shared Telegram group — `owner` on a reminder is attribution text only, never a delivery filter.
- A reminder is a new dedicated concept (`data/reminders.json`), never folded into `todos.json`'s `deadline` field.
- Due-reminder matching is `date <= today`, never `date === today` — a missed scheduled-task run must not silently drop a reminder.
- Grouped delivery: all due reminders in one run become exactly one Telegram message. On send failure, **none** of that batch is marked sent (all-or-nothing); on success, **all** of it is.
- Every new data file, loader, and write follows this codebase's existing conventions verbatim: atomic `writeJson` (temp file + rename), "missing/unparseable file degrades quietly to an empty default" for every loader, dependency-injectable `telegramClient`/`anthropicClient`/`now` for tests (no real network calls in tests), and gitignoring any file holding real household data.

---

### Task 1: Reminder tools + dispatcher wiring

**Files:**
- Modify: `Longterm/scripts/telegram-bot-tools.mjs`
- Modify: `Longterm/scripts/telegram-bot-poll.mjs`
- Modify: `Longterm/.gitignore`
- Test: `Longterm/data/test-telegram-bot.mjs`

**Interfaces:**
- Consumes: the existing `(dataObject, args, owner?) => { dataObject, reply, needsClarification? }` tool-function shape already used by `add_todo`/`set_routine_day`/`remove_event` in `telegram-bot-tools.mjs`, and the existing `dispatchMessage`/`runOnce` read-snapshot-write cycle in `telegram-bot-poll.mjs` (see `routineOverrides`/`goals` for the pattern to mirror).
- Produces: `add_reminder`, `list_reminders`, `cancel_reminder` (exported functions), `REMINDER_TOOL_NAMES` (exported `Set`), three new `TOOL_DEFS` entries, three new `TOOL_IMPL` entries — all consumed by Task 1's own dispatcher wiring (no other task depends on this one).

- [ ] **Step 1: Add reminder tool functions to `telegram-bot-tools.mjs`**

Insert after `log_decision` (before the `get_budget_status` read-only section), so reminders sit alongside the other write tools:

```js
// --- Reminders (2026-08-05) ---
// A one-off timed nudge the bot proactively announces once, on its date --
// NOT a persistent household chore (see todos.json's own family-only scope).
// Call shape (reminders, args, owner?), a new distinct shape alongside
// todos/monthPlanEvents/overrides/goals/financialContext -- see
// REMINDER_TOOL_NAMES below for how telegram-bot-poll.mjs's dispatcher
// routes to it. Delivery itself (scanning for due reminders and sending
// them) lives in the separate scripts/telegram-bot-reminders.mjs daily job
// -- these functions only ever create/list/cancel, never send.

function nextReminderId(reminders) {
  const max = reminders.items.reduce((m, r) => {
    const n = parseInt(String(r.id).slice(1), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `r${max + 1}`;
}

export function add_reminder(reminders, { text, date, owner }) {
  if (!text || !text.trim()) {
    return { reminders, reply: "Couldn't set that reminder — missing what to remind you about." };
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { reminders, reply: "Couldn't set that reminder — need a specific date (YYYY-MM-DD)." };
  }
  const item = { id: nextReminderId(reminders), text: text.trim(), date, owner: owner || null, createdAt: new Date().toISOString(), sent: false, sentAt: null };
  reminders.items.push(item);
  return { reminders, reply: `Reminder set ✓ for ${date}: ${item.text}` };
}

export function list_reminders(reminders) {
  const open = reminders.items.filter((r) => !r.sent).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!open.length) return { reminders, reply: 'No upcoming reminders.' };
  const lines = open.map((r) => `${r.date}: ${r.text}${r.owner ? ` (${r.owner})` : ''}`);
  return { reminders, reply: `Upcoming reminders:\n${lines.join('\n')}` };
}

// Matches by case-insensitive substring on text (+ exact date if given, to
// disambiguate) -- same shape as remove_event's own matching, including the
// same "never guess, ask instead" handling for more than one match.
export function cancel_reminder(reminders, { text, date }) {
  if (!text || !text.trim()) {
    return { reminders, reply: "Couldn't cancel that — missing which reminder you mean." };
  }
  const needle = text.trim().toLowerCase();
  const open = reminders.items.filter((r) => !r.sent);
  const matches = open.filter((r) => r.text.toLowerCase().includes(needle) && (!date || r.date === date));
  if (!matches.length) {
    return { reminders, reply: `Couldn't find an upcoming reminder like "${text}".` };
  }
  if (matches.length > 1) {
    const names = matches.map((r) => `${r.date}: ${r.text}`).join(', ');
    return { reminders, reply: `Multiple reminders match "${text}": ${names}. Say which one to cancel.`, needsClarification: true };
  }
  const [match] = matches;
  reminders.items = reminders.items.filter((r) => r.id !== match.id);
  return { reminders, reply: `Cancelled ✓: ${match.text} (was ${match.date})` };
}

// Tool names whose implementation operates on a reminders object, not
// todos/monthPlanEvents/overrides/goals/financialContext -- a distinct call
// shape telegram-bot-poll.mjs's dispatch branches on the same way it already
// does for ROUTINE_OVERRIDE_TOOL_NAMES/GOALS_TOOL_NAMES.
export const REMINDER_TOOL_NAMES = new Set(['add_reminder', 'list_reminders', 'cancel_reminder']);
```

- [ ] **Step 2: Add the three tool definitions to `TOOL_DEFS`**

Insert into the `TOOL_DEFS` array (in `telegram-bot-tools.mjs`), right after the `get_calendar_events` entry (the array's last entry) — add a trailing comma to the existing last entry first:

```js
  {
    name: 'add_reminder',
    description: 'Set a one-off reminder that proactively pings the household Telegram group on a specific date (day-level only -- no specific time-of-day support). Use this, and never add_todo, whenever the user says "remind me..." or asks for a reminder: a to-do sits on the shared Planner list until done, a reminder proactively announces itself once on its date and never appears on the Planner list.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to be reminded about.' },
        date: { type: 'string', description: 'The date to fire on, as YYYY-MM-DD, resolved from whatever the user said ("tomorrow", "Friday") using today\'s date from context.' },
      },
      required: ['text', 'date'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List every upcoming (not yet sent) reminder.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel an upcoming reminder before it fires, matched by substring on its text (and its date, if given, to disambiguate). Never guess which one if more than one matches -- ask instead.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring to match against the reminder\'s text.' },
        date: { type: 'string', description: 'The reminder\'s date (YYYY-MM-DD), if known -- narrows an ambiguous match.' },
      },
      required: ['text'],
    },
  },
```

- [ ] **Step 3: Add the three `TOOL_IMPL` entries**

In `telegram-bot-tools.mjs`, add to the `TOOL_IMPL` object (owner is threaded in the same way `add_todo`'s entry does it):

```js
  add_reminder: (reminders, args, owner) => add_reminder(reminders, { text: args.text, date: args.date, owner }),
  list_reminders: (reminders) => list_reminders(reminders),
  cancel_reminder: (reminders, args) => cancel_reminder(reminders, { text: args.text, date: args.date }),
```

- [ ] **Step 4: Seed `data/reminders.json` and gitignore it**

Create `Longterm/data/reminders.json`:

```json
{
  "meta": {
    "description": "One-off timed reminders the bot proactively announces to the Telegram group (see scripts/telegram-bot-reminders.mjs). Not a to-do list -- see data/todos.json for household action items. A reminder fires once, on or after its date, then is marked sent and never repeated. Bot-owned: written directly by add_reminder/cancel_reminder in scripts/telegram-bot-tools.mjs."
  },
  "items": []
}
```

Add to `Longterm/.gitignore`, alongside the other bot-owned data files (near `data/telegram-pending-clarifications.json`):

```
data/reminders.json
```

- [ ] **Step 5: Wire `reminders` through `telegram-bot-poll.mjs`'s `parseArgs`, loader, `dispatchMessage`, and `runOnce`**

In `telegram-bot-poll.mjs`:

1. Extend the import from `./telegram-bot-tools.mjs` to include `REMINDER_TOOL_NAMES`:

```js
import { add_todo, TOOL_DEFS, TOOL_IMPL, DINING_TOOL_NAMES, FINANCIAL_TOOL_NAMES, FAMILY_EVENT_TOOL_NAMES, ROUTINE_OVERRIDE_TOOL_NAMES, GOALS_TOOL_NAMES, REMINDER_TOOL_NAMES } from './telegram-bot-tools.mjs';
```

2. In `parseArgs`'s `args` default object, add (alongside `monthPlanEventsPath`):

```js
    remindersPath: path.join(repoDataDir, 'reminders.json'),
```

And in the `--`-flag loop, alongside the `month-plan-events-path` branch:

```js
      else if (key === 'reminders-path') args.remindersPath = value;
```

3. Add a loader, right after `loadMonthPlanEvents`:

```js
// Bot-owned (add_reminder/cancel_reminder), not read/written by anything
// else. Missing/unparseable degrades to no reminders, same convention as
// every other loader here.
function loadReminders(remindersPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(remindersPath, 'utf8'));
    return { items: parsed.items || [] };
  } catch {
    return { items: [] };
  }
}
```

4. Extend `dispatchMessage`'s parameter object to accept `reminders`, and thread it through every return statement exactly the way `routineOverrides` already is (add `reminders` next to `routineOverrides` in the destructured signature and in every `return { todos, monthPlanEvents, routineOverrides, goals, ... }` object in the function — there are 6 such return sites: the deterministic-parse early return, the no-api-key early return, the no-tool-or-text return, the clarifying-question return, the catch-block return, and the two return statements at the end of the try block). Also declare `let newReminders = reminders;` alongside `newTodos`/`newMonthPlanEvents`/etc., and add the dispatch branch (insert after the `GOALS_TOOL_NAMES` branch, before the `FINANCIAL_TOOL_NAMES` branch):

```js
      } else if (REMINDER_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(newReminders, toolUse.input, owner);
        newReminders = result.reminders;
        rawReplies.push(result.reply);
        if (result.needsClarification) stillNeedsClarification = result.reply;
```

Every `return { todos: newTodos, monthPlanEvents: newMonthPlanEvents, routineOverrides: newRoutineOverrides, goals: newGoals, ... }` inside the try block (the "all unrecognized" return, the clarification return, and the final return) also needs `reminders: newReminders` added.

5. Update the dispatcher system prompt (`callAnthropicFallback`'s `system` string) — insert this sentence right after the existing "Use delete_todo (not mark_done)..." sentence:

```
If the user says "remind me..." or otherwise asks for a reminder, call add_reminder — never add_todo. A to-do sits on the shared Planner list until done; a reminder proactively pings the group once, on its date, and never appears on the Planner list. Use list_reminders for "what reminders do we have" and cancel_reminder to cancel one before it fires (never guess which one if more than one plausibly matches — ask instead, same as remove_event).
```

And add `list_reminders` to the existing read-only-tools sentence ("call the relevant read-only tool (list_todos, get_dining_plan, get_budget_status, ...)").

6. In `runOnce`, right after `let pendingClarifications = loadPendingClarifications(...)` / its snapshot line, add:

```js
  let reminders = loadReminders(args.remindersPath);
  const remindersSnapshot = JSON.stringify(reminders);
```

Pass `reminders` into the `dispatchMessage({...})` call (alongside `routineOverrides`), and after the call, add `reminders = result.reminders;` alongside the existing `routineOverrides = result.routineOverrides;` line.

Near the end, alongside the `pendingClarificationsChanged`/write block, add:

```js
  // Bot-owned reminder store -- same atomic write as every other state file
  // here. Delivery (scanning for due reminders and sending them) is a
  // separate daily job (telegram-bot-reminders.mjs); this poller only ever
  // creates/lists/cancels.
  const remindersChanged = JSON.stringify(reminders) !== remindersSnapshot;
  if (remindersChanged && !args.dryRun) {
    writeJson(args.remindersPath, reminders);
  }
```

And add `remindersChanged, reminders` to `runOnce`'s final returned object.

- [ ] **Step 6: Add tests to `data/test-telegram-bot.mjs`**

Add `remindersPath` to `writeFixture`'s destructured options and body (mirroring `routineOverrides`'s conditional-write pattern — reminders should default to an empty list unless a test overrides it):

```js
  const remindersPath = path.join(dir, 'reminders.json');
  fs.writeFileSync(remindersPath, JSON.stringify({ meta: { description: 'test' }, items: reminders || [] }, null, 2));
```
(add `reminders` to the destructured parameter list, and `remindersPath` to the function's returned object)

Add `remindersPath: paths.remindersPath` to `baseOpts`'s returned object.

Add these tests, after the existing `remove_event`-related tests:

```js
await asyncTest('add_reminder: creates a reminder with a sequential id and confirms the date', async () => {
  const dir = path.join(tmpRoot, 'add-reminder');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot remind me tomorrow to call the doctor' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_reminder', input: { text: 'Call the doctor', date: '2026-08-06' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.remindersChanged, true);
  assert.equal(result.reminders.items.length, 1);
  assert.equal(result.reminders.items[0].id, 'r1');
  assert.equal(result.reminders.items[0].owner, 'kevin');
  assert.equal(result.reminders.items[0].sent, false);
  assert.ok(result.sentReplies[0].includes('2026-08-06'));
});

await asyncTest('add_reminder: a second reminder gets the next sequential id', async () => {
  const dir = path.join(tmpRoot, 'add-reminder-sequential-id');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot remind me Friday to pay rent' })] },
    reminders: [{ id: 'r1', text: 'Existing reminder', date: '2026-08-06', owner: 'hanna', createdAt: '2026-08-01T00:00:00.000Z', sent: false, sentAt: null }],
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_reminder', input: { text: 'Pay rent', date: '2026-08-08' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.reminders.items[1].id, 'r2');
});

await asyncTest('list_reminders: reports upcoming reminders sorted by date, excludes sent ones', async () => {
  const dir = path.join(tmpRoot, 'list-reminders');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot what reminders do we have' })] },
    reminders: [
      { id: 'r1', text: 'Later reminder', date: '2026-08-10', owner: 'kevin', createdAt: '2026-08-01T00:00:00.000Z', sent: false, sentAt: null },
      { id: 'r2', text: 'Sooner reminder', date: '2026-08-06', owner: 'hanna', createdAt: '2026-08-01T00:00:00.000Z', sent: false, sentAt: null },
      { id: 'r3', text: 'Already sent one', date: '2026-08-02', owner: null, createdAt: '2026-08-01T00:00:00.000Z', sent: true, sentAt: '2026-08-02T08:00:00.000Z' },
    ],
  });
  const mockClient = async () => ({ content: [{ type: 'tool_use', name: 'list_reminders', input: {} }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const reply = result.sentReplies[0];
  assert.ok(reply.indexOf('Sooner reminder') < reply.indexOf('Later reminder'), 'should be sorted by date ascending');
  assert.ok(!reply.includes('Already sent one'), 'a sent reminder should not be listed as upcoming');
});

await asyncTest('cancel_reminder: cancels a uniquely-matched reminder', async () => {
  const dir = path.join(tmpRoot, 'cancel-reminder-unique');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot cancel the doctor reminder' })] },
    reminders: [{ id: 'r1', text: 'Call the doctor', date: '2026-08-06', owner: 'kevin', createdAt: '2026-08-01T00:00:00.000Z', sent: false, sentAt: null }],
  });
  const mockClient = async () => ({ content: [{ type: 'tool_use', name: 'cancel_reminder', input: { text: 'doctor' } }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.reminders.items.length, 0);
  assert.ok(result.sentReplies[0].includes('Cancelled'));
});

await asyncTest('cancel_reminder: an ambiguous match asks instead of guessing, and cancels nothing', async () => {
  const dir = path.join(tmpRoot, 'cancel-reminder-ambiguous');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot cancel the reminder about the appointment' })] },
    reminders: [
      { id: 'r1', text: 'Dentist appointment', date: '2026-08-06', owner: 'kevin', createdAt: '2026-08-01T00:00:00.000Z', sent: false, sentAt: null },
      { id: 'r2', text: 'Vet appointment', date: '2026-08-07', owner: 'hanna', createdAt: '2026-08-01T00:00:00.000Z', sent: false, sentAt: null },
    ],
  });
  const mockClient = async () => ({ content: [{ type: 'tool_use', name: 'cancel_reminder', input: { text: 'appointment' } }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.remindersChanged, false, 'nothing should be cancelled when the target is ambiguous');
  assert.ok(result.sentReplies[0].includes('Say which one'));
});

await asyncTest('cancel_reminder: no match replies clearly rather than throwing', async () => {
  const dir = path.join(tmpRoot, 'cancel-reminder-no-match');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot cancel the nonexistent reminder' })] },
  });
  const mockClient = async () => ({ content: [{ type: 'tool_use', name: 'cancel_reminder', input: { text: 'nonexistent' } }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.ok(result.sentReplies[0].includes("Couldn't find"));
});
```

- [ ] **Step 7: Run the tests**

Run: `node Longterm/data/test-telegram-bot.mjs`
Expected: all tests pass, including the 6 new ones above.

- [ ] **Step 8: Commit**

```bash
git add scripts/telegram-bot-tools.mjs scripts/telegram-bot-poll.mjs data/reminders.json .gitignore data/test-telegram-bot.mjs
git commit -m "feat: add add_reminder/list_reminders/cancel_reminder bot tools"
```

---

### Task 2: Daily delivery job

**Files:**
- Create: `Longterm/scripts/telegram-bot-reminders.mjs`
- Test: `Longterm/data/test-telegram-reminders.mjs`

**Interfaces:**
- Consumes: `data/reminders.json`'s shape from Task 1 (`{ items: [{ id, text, date, owner, createdAt, sent, sentAt }] }`) — no code dependency on Task 1, only the agreed data shape.
- Produces: an exported `runOnce(opts)` function (same DI-testable shape as `telegram-bot-recap.mjs`'s `runOnce` — accepts `remindersPath`, `now`, `token`, `groupChatId`, `dryRun`, `telegramClient`), used by Task 3's scheduled-task installer and by this task's own tests.

- [ ] **Step 1: Write the failing tests**

Create `Longterm/data/test-telegram-reminders.mjs`:

```js
// Longterm/data/test-telegram-reminders.mjs
//
// Permanent regression test (NOT a temp task script -- do not delete). Covers
// telegram-bot-reminders.mjs's due-vs-not-due filtering (including the <=
// catch-up behavior for a missed run), the grouped single-message send, and
// the all-or-nothing sent-marking on success vs. failure. Run with:
//   node Longterm/data/test-telegram-reminders.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce } from '../scripts/telegram-bot-reminders.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-reminders-test-'));

async function asyncTest(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

function writeFixture(dir, { items } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const remindersPath = path.join(dir, 'reminders.json');
  fs.writeFileSync(remindersPath, JSON.stringify({ meta: { description: 'test' }, items: items || [] }, null, 2));
  return { remindersPath };
}

function baseOpts(paths, extra = {}) {
  return {
    remindersPath: paths.remindersPath,
    token: 'test-token',
    groupChatId: '-999',
    dryRun: false,
    ...extra,
  };
}

const TODAY = new Date(2026, 7, 6, 8, 0, 0); // 2026-08-06

console.log('test-telegram-reminders.mjs');

await asyncTest('no due reminders: no message sent, nothing marked', async () => {
  const dir = path.join(tmpRoot, 'none-due');
  const paths = writeFixture(dir, {
    items: [{ id: 'r1', text: 'Future thing', date: '2026-08-07', owner: null, createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null }],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'none_due');
  assert.equal(sent.length, 0);
});

await asyncTest('a reminder due exactly today is sent and marked sent', async () => {
  const dir = path.join(tmpRoot, 'due-today');
  const paths = writeFixture(dir, {
    items: [{ id: 'r1', text: 'Call the doctor', date: '2026-08-06', owner: 'kevin', createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null }],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, '-999');
  assert.ok(sent[0].body.text.includes('Call the doctor (kevin)'));
  const persisted = JSON.parse(fs.readFileSync(paths.remindersPath, 'utf8'));
  assert.equal(persisted.items[0].sent, true);
  assert.ok(persisted.items[0].sentAt);
});

await asyncTest('a reminder from a missed past date still fires (<=, not ==)', async () => {
  const dir = path.join(tmpRoot, 'missed-past-date');
  const paths = writeFixture(dir, {
    items: [{ id: 'r1', text: 'Overdue thing', date: '2026-08-03', owner: null, createdAt: '2026-08-01T00:00:00.000Z', sent: false, sentAt: null }],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(result.sent, true);
  assert.ok(sent[0].body.text.includes('Overdue thing'));
});

await asyncTest('multiple due reminders are grouped into one message; a null owner has no suffix', async () => {
  const dir = path.join(tmpRoot, 'grouped');
  const paths = writeFixture(dir, {
    items: [
      { id: 'r1', text: 'Call the doctor', date: '2026-08-06', owner: 'kevin', createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
      { id: 'r2', text: 'Fill the water tank', date: '2026-08-05', owner: null, createdAt: '2026-08-04T00:00:00.000Z', sent: false, sentAt: null },
    ],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(sent.length, 1, 'both due reminders should be one message, not two sends');
  assert.ok(sent[0].body.text.includes('Call the doctor (kevin)'));
  assert.ok(sent[0].body.text.includes('Fill the water tank') && !sent[0].body.text.includes('Fill the water tank ('), 'a null owner should have no suffix');
  assert.equal(result.count, 2);
});

await asyncTest('a not-yet-due reminder is left untouched even when another in the same file is due', async () => {
  const dir = path.join(tmpRoot, 'mixed-due-not-due');
  const paths = writeFixture(dir, {
    items: [
      { id: 'r1', text: 'Due today', date: '2026-08-06', owner: null, createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
      { id: 'r2', text: 'Not due yet', date: '2026-08-10', owner: null, createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
    ],
  });
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  const persisted = JSON.parse(fs.readFileSync(paths.remindersPath, 'utf8'));
  assert.equal(persisted.items.find((r) => r.id === 'r1').sent, true);
  assert.equal(persisted.items.find((r) => r.id === 'r2').sent, false);
});

await asyncTest('a failed send leaves every due item unmarked -- the whole batch retries next run', async () => {
  const dir = path.join(tmpRoot, 'failed-send');
  const paths = writeFixture(dir, {
    items: [
      { id: 'r1', text: 'Call the doctor', date: '2026-08-06', owner: 'kevin', createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
      { id: 'r2', text: 'Fill the water tank', date: '2026-08-06', owner: null, createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
    ],
  });
  const mockTelegram = async () => { throw new Error('Telegram is down'); };
  await assert.rejects(() => runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram })));
  const persisted = JSON.parse(fs.readFileSync(paths.remindersPath, 'utf8'));
  assert.equal(persisted.items[0].sent, false);
  assert.equal(persisted.items[1].sent, false);
});

await asyncTest('a sent reminder is never included again on a later run', async () => {
  const dir = path.join(tmpRoot, 'already-sent-excluded');
  const paths = writeFixture(dir, {
    items: [{ id: 'r1', text: 'Already handled', date: '2026-08-01', owner: null, createdAt: '2026-08-01T00:00:00.000Z', sent: true, sentAt: '2026-08-01T08:00:00.000Z' }],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(result.sent, false);
  assert.equal(sent.length, 0);
});

console.log('All tests passed.');
```

- [ ] **Step 2: Run the test file to verify it fails**

Run: `node Longterm/data/test-telegram-reminders.mjs`
Expected: `Cannot find module '../scripts/telegram-bot-reminders.mjs'` (the module doesn't exist yet).

- [ ] **Step 3: Write `scripts/telegram-bot-reminders.mjs`**

```js
#!/usr/bin/env node
// Finances/Longterm/scripts/telegram-bot-reminders.mjs
// Sends any one-off reminders due today (or earlier -- see the <= catch-up
// note below) as a single grouped Telegram message into the same group the
// interactive bot uses, then marks them sent. Sibling to
// telegram-bot-recap.mjs -- same conventions (own callTelegram copy,
// parseArgs/runOnce/main shape) -- but a much simpler daily job: no LLM
// call, no dedup log (the item's own `sent` flag is the dedup). Runs via its
// own scheduled task (install-telegram-reminders-scheduled-task.ps1), daily
// at 8am by default. See docs/superpowers/specs/2026-08-05-telegram-reminders-design.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { telegramEnvPath } from './longterm-paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDataDir = path.join(here, '..', 'data');

function parseArgs(argv) {
  const args = {
    envPath: telegramEnvPath(),
    remindersPath: path.join(repoDataDir, 'reminders.json'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      i += 1;
      if (key === 'env-path') args.envPath = value;
      else if (key === 'reminders-path') args.remindersPath = value;
      else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readLocalEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) throw new Error(`Missing env file: ${filePath}`);
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return values;
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

function loadReminders(remindersPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(remindersPath, 'utf8'));
    return { items: parsed.items || [] };
  } catch {
    return { items: [] };
  }
}

// <= today, not ==, so a reminder due on a date the scheduled task didn't
// run (PC asleep, task failure) still fires late on the next successful run
// instead of being silently dropped.
function dueReminders(reminders, today) {
  return reminders.items.filter((r) => !r.sent && r.date <= today);
}

function formatGroupedMessage(due) {
  const lines = due.map((r) => `- ${r.text}${r.owner ? ` (${r.owner})` : ''}`);
  return `⏰ Reminders for today:\n${lines.join('\n')}`;
}

async function callTelegram(token, method, body) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(`Telegram ${method} rejected: ${JSON.stringify(json)}`);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

export async function runOnce(opts) {
  const args = { ...parseArgs([]), ...opts };
  const now = args.now || new Date();
  const today = isoDate(now);

  const reminders = loadReminders(args.remindersPath);
  const due = dueReminders(reminders, today);
  if (!due.length) return { sent: false, reason: 'none_due' };

  const envValues = args.token && args.groupChatId ? {} : readLocalEnv(args.envPath);
  const token = args.token || envValues.TELEGRAM_BOT_TOKEN;
  const groupChatId = args.groupChatId || envValues.TELEGRAM_GROUP_CHAT_ID;
  const text = formatGroupedMessage(due);

  if (!args.dryRun) {
    const telegramClient = args.telegramClient || callTelegram;
    // All-or-nothing: one send call for the whole batch. On failure this
    // throws and propagates -- nothing here is marked sent, so the exact
    // same batch (plus anything newly due) retries next run.
    await telegramClient(token, 'sendMessage', { chat_id: groupChatId, text });
    const dueIds = new Set(due.map((r) => r.id));
    reminders.items = reminders.items.map((r) => (dueIds.has(r.id) ? { ...r, sent: true, sentAt: now.toISOString() } : r));
    writeJson(args.remindersPath, reminders);
  }

  return { sent: true, count: due.length, text, reminders };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOnce(args);
  console.log(JSON.stringify({ ok: true, sent: result.sent, count: result.count || 0, reason: result.reason || null }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node Longterm/data/test-telegram-reminders.mjs`
Expected: `All tests passed.`, all 7 tests print `ok`.

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram-bot-reminders.mjs data/test-telegram-reminders.mjs
git commit -m "feat: add daily grouped-reminder delivery job"
```

---

### Task 3: Scheduled task installer + documentation

**Files:**
- Create: `Longterm/scripts/install-telegram-reminders-scheduled-task.ps1`
- Modify: `Longterm/CLAUDE.md`

**Interfaces:**
- Consumes: `telegram-bot-reminders.mjs`'s file path (Task 2) — no code dependency, just references the script by path.
- Produces: nothing consumed by another task — this is the final, integration-facing task.

- [ ] **Step 1: Write the scheduled-task installer**

Create `Longterm/scripts/install-telegram-reminders-scheduled-task.ps1`:

```powershell
param(
    [string]$TaskName = 'LongtermTelegramReminders',
    [string]$At = '08:00',
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Sibling to install-telegram-recap-scheduled-task.ps1, but a single daily
# trigger instead of two weekly ones -- reminders are day-level, checked once
# each morning, not tied to a Sun/Thu cadence.

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName' (if it existed)."
    exit 0
}

function Resolve-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'Node.js is required to run the Telegram reminders script.'
    }
    return $node.Source
}

$scriptPath = Join-Path $PSScriptRoot 'telegram-bot-reminders.mjs'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing script at $scriptPath"
}

$nodeExe = Resolve-Node
$taskArgs = ('"{0}"' -f $scriptPath)
$atTime = [datetime]::ParseExact($At, 'HH:mm', $null)

if ($WhatIf) {
    Write-Host ('Would create scheduled task "{0}" running daily at {1}' -f $TaskName, $At)
    Write-Host ('Task command: {0} {1}' -f $nodeExe, $taskArgs)
    exit 0
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $taskArgs
$trigger = New-ScheduledTaskTrigger -Daily -At $atTime
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'Sends any due one-off reminders as one grouped Telegram message, daily.' -Force | Out-Host

Write-Host ("Registered scheduled task '{0}' (daily at {1})." -f $TaskName, $At)
```

- [ ] **Step 2: Dry-run the installer to verify it resolves correctly**

Run: `powershell -File Longterm/scripts/install-telegram-reminders-scheduled-task.ps1 -WhatIf`
Expected: prints `Would create scheduled task "LongtermTelegramReminders" running daily at 08:00` and a `Task command:` line pointing at `telegram-bot-reminders.mjs` — no error.

- [ ] **Step 3: Register the real scheduled task**

Run: `powershell -File Longterm/scripts/install-telegram-reminders-scheduled-task.ps1`
Expected: `Registered scheduled task 'LongtermTelegramReminders' (daily at 08:00).` — confirm with `Get-ScheduledTask -TaskName LongtermTelegramReminders` that it exists and is enabled.

- [ ] **Step 4: Document the feature in `CLAUDE.md`**

In the `## Project files` section, add a new bullet after the `update_phase_expense`/`log_decision` bullet:

```markdown
- `data/reminders.json` — bot-owned (2026-08-05): one-off timed reminders, written directly by `add_reminder`/`cancel_reminder` in `scripts/telegram-bot-tools.mjs`. Not a to-do list — see `data/todos.json` for household action items; a reminder fires once, proactively, on its date, and is never shown in the Planner tab. Delivered by `scripts/telegram-bot-reminders.mjs`, a daily job (`install-telegram-reminders-scheduled-task.ps1`, 08:00 by default) that groups every reminder due that day (`date <= today`, so a missed run still catches up rather than silently dropping one) into a single Telegram message, then marks the batch sent — all-or-nothing: a failed send leaves the whole batch unmarked so it retries next run. Day-level granularity and one-off only in this pass — no specific time-of-day, no recurrence. See `docs/superpowers/specs/2026-08-05-telegram-reminders-design.md`.
```

- [ ] **Step 5: Commit**

```bash
git add scripts/install-telegram-reminders-scheduled-task.ps1 CLAUDE.md
git commit -m "feat: install reminders scheduled task; document the feature"
```

## Self-Review Notes

- **Spec coverage:** every section of the design doc (data shape, 3 bot tools, dispatcher rule fix, delivery job, grouped/all-or-nothing send, scheduled task, tests) maps to a task step above.
- **Placeholder scan:** none — every step has real, complete code.
- **Type consistency:** `reminders` object shape (`{ items: [...] }`) and item shape (`{ id, text, date, owner, createdAt, sent, sentAt }`) are identical across Task 1's tool functions, Task 1's poll.mjs loader, and Task 2's delivery script's loader — verified by re-reading each Step 1/3/5 code block side by side.
