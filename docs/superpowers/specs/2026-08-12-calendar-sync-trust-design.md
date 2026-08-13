# Making the Telegram bot's confirmations trustworthy

**Date:** 2026-08-12
**Status:** implemented

## The failure

A poker night was added via the bot. It replied `Poker added Tues 8/18 7-11pm`.
The event never reached Google Calendar. Challenged, the bot guessed at causes —
"check if that calendar is set to visible", "a stale event ID" — both wrong, and
re-added the event, creating a duplicate.

The bot was not lying. Every layer was built so it could not know the truth.

## Root cause, in five parts

1. **Google's refresh token was dead.** Verified live: `invalid_grant — "Token
   has been expired or revoked."` Minted Aug 2, died Aug 9 — exactly 7 days,
   the signature of an OAuth consent screen still in **Testing** publishing
   status, which expires refresh tokens weekly. This would have recurred every
   week regardless of any code fix.

2. **The pause was a one-way latch.** `runCalendarSyncStep` checked the pause
   file *before* attempting a sync and cleared it only *after* one succeeded.
   Once written, it could never retry, so it could never clear. Re-running the
   auth setup didn't clear it either. Sync had been off since Aug 9 — confirmed
   against Google directly: nothing created on the Family Planner calendar since
   Aug 6.

3. **It failed in silence.** The paused path returned `{skipped, paused}` with no
   log line; the caller only logged `if (!calResult.skipped)`. The single
   "PAUSED" line was written once, ever, into a log that appends a heartbeat
   every 25 seconds. Nothing reached Telegram. Three days, three stranded
   events, no signal.

4. **"Added ✓" was a claim about a JavaScript object.** `add_family_event`
   returned its success string after mutating an in-memory object; `runOnce`
   sent the reply; `calendarSyncFn()` ran *afterward*, in the poll loop. No
   ordering existed in which the reply could have reflected the sync.

5. **No dedupe.** `add_family_event` appended unconditionally, so the model's
   second call stored Poker twice.

## What was built

**Restoring service.** `calendar-auth-setup.mjs` gained `--reauth-only`, which
replaces only the three OAuth fields and preserves `GOOGLE_CALENDAR_ID` /
`GOOGLE_READ_CALENDAR_IDS`. This is load-bearing: first-run mode unconditionally
POSTs a *new* "Family Planner" calendar and rewrites the id, which would strand
17 already-synced events on the old calendar and leave both phones subscribed to
it. The preservation rule is a pure exported function, `buildReauthEnv`, so the
property that matters is testable without a browser consent flow. Re-auth also
clears the pause file, which it previously did not.

**Backoff, not a latch.** The pause record now carries `retryAfter`,
`failureCount`, `lastFailureAt`, and `lastAlertAt`; `isCalendarAuthPauseActive`
gates on `retryAfter` with a 6h → 12h → 24h escalation. This keeps the original
intent of the pause (no retry every 25 seconds, no flashing `node.exe` window)
while removing the deadlock. A pause record with **no** `retryAfter` — the shape
the old code wrote — deliberately reads as *expired*, so a stale file on disk
heals on first run of the new code instead of needing a manual delete. `at`
records when the outage *started* and survives re-arming, because "how long has
this been broken" is the question that matters.

**Audible failure.** `scripts/calendar-sync-alerts.mjs` holds the policy as pure
functions: alert on the first failure, then at most once per 24h while it stays
broken. Repeating matters because this failure is invisible from the user's side
— events keep "saving" fine — but repeating every retry would train everyone to
ignore it, which is how the original spam concern became total silence. The
message names the broken thing, says saved events are not lost, and gives the
exact fix command including `--reauth-only`. Sending is injected, so tests need
no network, and a failed alert never fails the sync step or the poll.

**Verified confirmations.** `runOnce` now persists `month_plan_events.json` and,
for turns that actually wrote an event, runs the sync step *before* composing the
reply. Three honest outcomes: synced, sync down, sync failed this once. The
caveat is appended **after** `naturalizeBatch` — that step rewrites replies
through an LLM, and a hedge about a broken integration is exactly what a "make
this sound natural" pass smooths away.

**No more guessing.** A read-only `get_sync_status` tool reports pause state,
reason, outage age, and the count of events missing a `googleEventId`. The system
prompt's first section now requires calling it whenever someone says an event is
missing, and forbids speculating about causes or re-adding an event to "fix" it.

**Tool hardening.** `add_family_event` dedupes on name + date + time — matching
on the whole object would let a trivial field difference create a duplicate. The
empty `catch` in the message loop (which discarded the error and `break`ed,
letting one unprocessable message block every later one forever) now logs, records
to `telegram-unparsed.jsonl`, and gives up on a message after 3 attempts. The
dispatch fallthrough that treated any unclassified tool as a to-do tool is now an
explicit `TODO_TOOL_NAMES` set.

**Comprehension.** Tool selection moved from `claude-haiku-4-5` to
`claude-sonnet-5` — this one call picks among ~23 tools with overlapping triggers
(`add_todo` vs `add_reminder`, `get_dining_plan` vs `set_dinner_plan`) and is
where "the bot can't do simple things" was being decided. The 4,500-character
single-paragraph system prompt was restructured into labeled sections with the
truthfulness rule first; content preserved, structure is the fix. `thinking`
stays explicitly disabled — load-bearing on Sonnet 5, which otherwise runs
adaptive thinking by default and can consume the token budget without emitting a
tool call.

**Tests and CI.** `data/test-telegram-poll-loop.mjs` previously asserted the bug
was correct (`'must not retry Google while the pause file exists'`, `'must not
re-log the pause on every poll iteration'`); those are rewritten to the new
contract. New suite `data/test-calendar-trust.mjs` covers re-auth preservation,
backoff, legacy-pause expiry, alert cadence, dedupe, caveat text, and
`get_sync_status`. `npm test` now exists (`scripts/run-tests.mjs`, one process per
suite) and CI runs it in full — it previously ran 2 of 19 suites, which is how the
bug-asserting test stayed green.

## Follow-up owned by a human

The Google Cloud consent screen for project `family-desktop-cli` must be switched
from **Testing** to **In production**. Without it the refresh token keeps expiring
every 7 days; the difference now is that the bot will say so loudly instead of
going quiet for three days.
