# Joint cycle habits for the Telegram bot

**Date:** 2026-08-25
**Status:** implemented

## What this is

The bot already knows this joint cycle’s total and, after halfway, a weekly
rate to hit target. It cannot see prior cycles (`budget_tracking.json` is
rebuilt for the live window), so it cannot name a category to ease, warn about
a last-week spike, or wrap a cycle when the 25th ticks. Under a week left, a
weekly rate is the wrong unit.

V1 is **joint only**. Personals stay on their own clock and are out of scope.
Dining recommendations are unchanged.

## Locked product rules

- Category cue during the cycle **and** a close-out that trains the next one.
- Surfaces: Sun/Thu recap, `get_budget_status`, and a **one-shot Telegram**
  when a joint cycle closes.
- Dollar **rate waits until halfway**. Prior-cycle **habits may speak earlier**.
- Under **7 days left**, do not say `$X/wk`. Say what’s left for the rest of
  this cycle (and a rough per-day). After the cycle ends, no forward rate.
- Name **one** watch category, not a lecture. No merchant name-and-shame in
  history. No filler if the sample is too thin.
- Snapshot **before** the daily pull overwrites the live cycle. Telegram must
  not fail the money pull. A failed send retries next run until marked sent.

## Data — `data/cycle_history.json` (gitignored)

Current cycle stays in `budget_tracking.json`. Closed joint cycles accumulate
here (newest first, cap 6). Each snapshot:

- `cycleStart`, `cycleDays`, `target`, `total`
- `categories`: `{ name, amount }[]` (no transactions)
- `weeks`: `{ weekOf, actual, days }[]`
- `closedAt`, `closeOutSent`

Habits are **derived at read time**, not stored as a second SoT: last-week
spike (last week ≥ 28% of a cycle that has at least 3 weeks), usual category
shares, and (after halfway, for the live cycle) the category whose share is
≥ 8pp above its usual share.

## Rollover

Each daily budget pull, after reading `budget_tracking.json` and computing
today’s 25th-cycle start, if `joint.cycleStart` is a different ISO date and
the tracker has weeks or categories, archive it (upsert by `cycleStart`), then
fetch/rebuild as today. Idempotent.

## Close-out Telegram

One message per closed `cycleStart`. Short: landed vs target, hottest
category, last-week spike if any, what to watch next. Newest unsent only if
several pile up. Injected `notifyFn` in tests; live uses the group chat.

## Backfill (one-shot)

`node scripts/budget-tracking-pull.mjs --cycle-history-backfill-cycles 3`

Rebuilds the last 2–3 **closed** joint 25th-cycles from Monarch with the same
card/travel routing as the daily pull. Does not rewrite the live cycle file.
Older backfilled cycles are marked `closeOutSent: true`; the most recent
closed cycle may still notify (catch-up after a 25th that already overwrote
the live file). Re-run recomputes; it does not duplicate.

## Bot copy

`budgetGuidance()` gains `leftoverDays`, `requiredDaily` (weekly fields stay
for ≥ 7 days). Recap prompt and `get_budget_status` use leftover copy when
`leftoverDays`. `budgetHabits.headsUp` may appear before halfway; the rate
must not. After halfway, one category cue if a watch category exists.

## Tests / privacy

Fixture categories only. `cycle_history.json` gitignored + secrets checker.
Tests cover rollover upsert, close-out dedup, leftover-days wording, silent
rate before halfway, habit heads-up before halfway, contained notify failure.
