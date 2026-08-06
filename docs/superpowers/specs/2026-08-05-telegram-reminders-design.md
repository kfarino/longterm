# Real Telegram reminders

## Context

Kevin shared a screenshot of the bot replying "Got both reminders added for tomorrow"
after two messages that just added plain, undated `add_todo` items — no reminder
mechanism exists today, so the reply over-promised. Asked "does our bit have ability to
set reminders?" — it does not. This spec builds the real feature so that claim becomes
true, and fixes the dispatcher so it never again calls `add_todo` and describes the
result as a reminder.

Per CLAUDE.md, Telegram/notifications work was explicitly scoped as future work, "a new
plan, not an extension" of whatever branch was in flight when that line was written —
this is that new plan.

**Scope, per Kevin's answers during brainstorming:**
- Reminders **proactively message the Telegram group** at the right time (not a passive
  "surface it next time you ask" — that wouldn't match "remind me tomorrow").
- **Day-level granularity only** — no specific time-of-day support in this pass.
- **One-off only** — no recurring reminders yet.
- **A new dedicated `data/reminders.json`**, not a reuse of `todos.json`'s unused
  `deadline` field — a reminder is a one-time timed nudge, not necessarily a persistent
  household chore worth showing in the Planner tab, and not all reminders are
  household-shaped (a work reminder shouldn't live in a file documented as family-only).
- **Grouped delivery**: all reminders due on a given day are sent as **one** Telegram
  message, not one message per reminder.
- **Daily check at 8:00am**, all-or-nothing per batch: one `sendMessage` call for the
  whole group; on success every included item is marked sent, on failure none are, and
  the batch retries automatically next run (see catch-up logic below).

## 1. Data — `data/reminders.json` (new, gitignored like `todos.json`)

```json
{
  "meta": {
    "description": "One-off timed reminders the bot proactively announces to the Telegram group. Not a to-do list (see todos.json for household action items) — a reminder fires once, on or after its date, then is marked sent and never repeated. Bot-owned: written directly by add_reminder/cancel_reminder."
  },
  "items": [
    {
      "id": "r1",
      "text": "Call the doctor",
      "date": "2026-08-06",
      "owner": "kevin",
      "createdAt": "2026-08-05T21:00:00Z",
      "sent": false,
      "sentAt": null
    }
  ]
}
```

- `id`: simple incrementing string (`r` + next integer), assigned on creation — needed
  so `cancel_reminder` can target one unambiguously once a name match resolves.
- `owner`: optional/nullable, an id from `goals.owners` — attribution only ("Reminder for
  Hanna: ..."), never a delivery filter. Delivery is always to the one shared group chat.
- `date`: `YYYY-MM-DD`, resolved from relative phrasing ("tomorrow", "Friday") by the
  dispatcher the same way `add_family_event` already resolves dates, anchored on today.
- `sent`/`sentAt`: set together, only by the daily reminders job (§3). Nothing else
  mutates them.

## 2. Bot tools (`scripts/telegram-bot-tools.mjs`)

Three new entries in `TOOL_DEFS`/`TOOL_IMPL`, same shape as the existing todo tools:

- **`add_reminder({ text, date, owner? })`** — appends a new item with `sent: false`.
  Returns the created item (id included) so the dispatcher's reply can confirm
  concretely ("Reminder set for Aug 6: call the doctor").
- **`list_reminders()`** — read-only, returns unsent items sorted by date ascending. Used
  for "what reminders do we have" / "anything coming up."
- **`cancel_reminder({ text, date? })`** — matches unsent items by case-insensitive
  substring on `text` (+ exact `date` if given, same as `remove_event`'s date-scoping).
  Zero matches → a plain "couldn't find a reminder like that" result, no clarification
  needed. Exactly one match → delete it. More than one match → return
  `{ needsClarification: true, candidates: [...] }`, reusing the existing pending-question
  mechanism (`data/telegram-pending-clarifications.json`) that `remove_event` already
  uses for the same ambiguity shape — no new clarification plumbing required.

## 3. Dispatcher wiring (`scripts/telegram-bot-poll.mjs`)

- Add `add_reminder`/`list_reminders`/`cancel_reminder` to `TOOL_DEFS` and the dispatch
  shape sets, following the existing `TOOL_IMPL`-backed pattern (these are pure
  in-memory/file operations, not a live external call — unlike `get_calendar_events`).
- **System prompt fix** (`callAnthropicFallback`'s `system` string): add an explicit
  rule — "If the user says 'remind me...' or asks for a reminder, call `add_reminder`,
  never `add_todo` — a to-do and a reminder are different: a to-do sits on the shared
  Planner list until done, a reminder proactively pings the group once on its date." The
  existing rule ("never invent or promise a review process, notification, or follow-up
  mechanism that doesn't exist") is unchanged and now literally true for reminders,
  since `add_reminder` makes a real one.
- Reminder state (`data/reminders.json`) is loaded into context the same way
  `todos`/`monthPlanEvents` already are, so `list_reminders`'s output and any
  conversational "what's coming up" question can be answered from the bundled state
  without a second round trip.

## 4. Delivery — new `scripts/telegram-bot-reminders.mjs`

Sibling to `telegram-bot-recap.mjs`, same conventions: its own small `callTelegram` copy
(deliberate duplication, matching the existing convention across
`telegram-bot-poll.mjs`/`telegram-bot-recap.mjs`), `parseArgs`, and a `main()`.

- **`runOnce(args)`**:
  1. Read `data/reminders.json`.
  2. Filter to `!item.sent && item.date <= today` — `<=`, not `==`, so a reminder is
     never silently dropped if the scheduled task didn't run on its exact date (PC
     asleep, task failure) — it fires late on the next successful run instead.
  3. If the filtered list is empty: do nothing, return `{ sent: false, reason: 'none due' }`
     (same quiet-skip shape as the recap's own no-op path).
  4. Otherwise, compose one message:
     ```
     ⏰ Reminders for today:
     - Call the doctor (Kevin)
     - Fill the water tank
     ```
     (owner suffix omitted when `owner` is null.)
  5. One `telegramClient(token, 'sendMessage', { chat_id: groupChatId, text })` call for
     the whole batch. On success, mark every included item `sent: true, sentAt: now` and
     write the file back. On failure (thrown/rejected), leave every item untouched and
     let the error propagate — the next scheduled run retries the same batch, plus
     anything newly due by then.
- **`main()`**: same `args = parseArgs(...)` → `runOnce(args)` → `console.log(JSON.stringify(...))`
  shape as the recap script, for consistency and easy manual invocation.

## 5. Scheduled task — `scripts/install-telegram-reminders-scheduled-task.ps1`

Mirrors `install-telegram-recap-scheduled-task.ps1` almost exactly:

- `TaskName = 'LongtermTelegramReminders'`, `-At '08:00'` default, `-Uninstall`/`-WhatIf`
  switches identical in shape.
- Single daily trigger (`New-ScheduledTaskTrigger -Daily -At $atTime`) instead of the
  recap's two weekly triggers — everything else (node resolution, action, settings,
  registration) copied verbatim from the recap installer.

## 6. Tests

- **`data/test-telegram-reminders.mjs`** (new, mirrors `test-telegram-recap.mjs`'s
  shape): due-vs-not-due filtering (`date <= today` including a past/missed date),
  empty-batch no-op, successful send marks all included items sent and leaves
  not-yet-due items untouched, a failed send leaves every item's `sent` flag unchanged
  (verified by injecting a `telegramClient` stub that rejects, same DI pattern the recap
  test file already uses via `args.telegramClient`).
- **`data/test-telegram-bot.mjs`** (extend): `add_reminder` creates an item with the next
  sequential id; `cancel_reminder` deletes on a unique match, returns
  `needsClarification` with `candidates` on an ambiguous match, and a plain "not found"
  result on zero matches; `list_reminders` excludes sent items and sorts by date.

## Explicitly deferred

- Time-of-day precision ("remind me at 3pm") — day-level only for now, per Kevin's
  answer; would need a scheduler that runs more than once a day.
- Recurring reminders ("every Monday...") — one-off only for now.
- Per-owner delivery (DMing just one person) — every reminder goes to the shared group,
  matching how the rest of the bot already works (one group chat, no DM concept today).
