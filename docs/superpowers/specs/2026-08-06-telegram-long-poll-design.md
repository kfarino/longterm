# Telegram bot: long-polling instead of a 2-minute scheduled poll

*Branch: `feature/telegram-long-poll`. Approved 2026-08-06 — replace the 2-minute short-poll scheduled task with a persistent long-polling process, so a message is picked up in seconds rather than up to 2 minutes later.*

## Goal

Cut Telegram message pickup latency from "up to 2 minutes" to "typically under a second," without introducing a public webhook endpoint, a new process manager, or any new inbound network exposure to a machine that holds real household financial data (`AGENTS.md` §0).

## Non-goals

- **No true webhook.** A webhook needs a public HTTPS endpoint reachable from Telegram's servers, which on this machine means a tunnel (Cloudflare Tunnel or similar) in front of a local listener — a second moving part and a new inbound path into a machine we've deliberately kept local-only. Long-polling gets the same practical latency (Telegram returns the instant a message arrives) with zero new exposure.
- **No reply-latency work.** This is about *noticing* a message fast — how quickly the process learns a message exists. Once `dispatchMessage` runs, an LLM-fallback reply still takes however long the Anthropic call takes; that's unchanged and out of scope. No "typing…" indicator, no streaming.
- **No changes to the recap or reminders scheduled tasks.** Different cadence (twice-weekly / daily), unrelated to this change.
- **No new process-management tooling** (NSSM, PM2, Windows Service). Task Scheduler's existing `-MultipleInstances IgnoreNew` setting, already present in `install-telegram-scheduled-task.ps1`, gives crash recovery for free — see Architecture below.

## Architecture

`runOnce()` — the function that does one `getUpdates` call, dispatches every message in the batch, and writes results back to disk — is unchanged in signature and behavior. Every existing test in `test-telegram-bot.mjs` keeps passing against it untouched.

What changes is what calls `runOnce()`:

- **`runPollLoop(opts)`**, new, wraps `runOnce()` in a loop. Each iteration passes `getUpdatesTimeoutSeconds: 25` through to `runOnce`, which threads it into the `getUpdates` request body as `timeout` (today hardcoded to `0`). Telegram holds the HTTP connection open and returns the instant a message arrives, or after 25 seconds if none did — this is the entire mechanism that makes pickup near-instant. 25s is comfortably under Telegram's 50s cap and leaves headroom for the loop's own per-iteration bookkeeping.
- **Calendar sync moves inside the loop.** Today `runCalendarSyncStep()` runs once per 2-minute script invocation; now it runs once per `getUpdates` cycle — a side effect that also shortens the delay before a Month Plan change reaches Google Calendar. Google Calendar API quota (default ~1,000,000 queries/day) comfortably absorbs the resulting call-volume increase (from roughly 720/day to a few thousand/day).
- **The loop exits cleanly after `maxDurationMs`** (15 minutes, per the earlier decision) rather than running forever. This project is edited frequently — by Kevin, by Cursor, by me — and a truly-forever process would keep running old code until someone remembered to restart it by hand. A bounded self-refresh means an edit takes effect automatically within 15 minutes, no manual step, matching how every other script in this project already works (invoked fresh, always running current code).
- **Task Scheduler needs one parameter change, not new infrastructure.** `install-telegram-scheduled-task.ps1` already sets `-MultipleInstances IgnoreNew` on the trigger. That single setting is both halves of process supervision: while `runPollLoop` is alive, the repetition tick is a no-op (an instance is already running); the moment it exits — clean 15-minute refresh or an unhandled crash — the next tick relaunches it. The only change is dropping `-RepetitionInterval` from today's 2 minutes to 1 minute, since it now only controls "how long could a crash go unnoticed," not the message-check cadence.
- **`--once` CLI flag** preserves exactly today's behavior (one `runOnce` call, `timeout: 0`, exit) for manual debugging.
- **`install-telegram-scheduled-task.ps1` gains a `-Legacy` switch** that registers the task with the old 2-minute `-RepetitionInterval` and `--once` in the task's arguments — the exact pre-this-change configuration, restorable with one command and no code revert, if long-polling ever misbehaves (e.g., an unexpected rate limit).

## Error handling

A thrown error inside one loop iteration is caught, logged, and the loop continues to the next iteration — it must not cost 15 minutes of uptime over one transient failure (a Telegram hiccup, a momentarily-locked data file). This is new behavior relative to today: currently a thrown error kills the single short-lived process outright, and the next 2-minute tick just starts fresh, which was an acceptable failure mode only because failures were already cheap (2 minutes of downtime, at most). A persistent process needs to be more resilient to a single bad iteration.

`callTelegram`'s existing 3-attempt retry-with-backoff is unaffected by the longer timeout — an idle long-poll returns `{ok: true, result: []}`, not an error, so retry logic is never even invoked on the common "nothing happened" case.

**New log file**: `~/.longterm/logs/telegram-poll.log`, one line per loop start, one line per iteration summary (messages processed, calendar sync result), one line per caught error — mirroring `run-daily-pull.ps1`'s `Write-PullLog` convention. Today's script logs only to stdout, discarded by Task Scheduler with no redirection configured; that was fine for a process that either succeeds or is retried in 2 minutes, but a persistent process needs an inspectable history so a stuck or crash-looping process is diagnosable without guessing.

## Testing

`runPollLoop()` gets its own test file, injecting `maxIterations` (not wall-clock time) for determinism:

- loops exactly `maxIterations` times against canned `getUpdates` fixture responses
- a thrown error in one iteration is caught, logged, and the loop continues to the next
- calendar sync is invoked once per iteration
- the loop exits cleanly at the iteration limit without throwing

Every existing `test-telegram-bot.mjs` case continues to exercise `runOnce()` directly and is untouched by this change.

## Rollout

1. Ship the code change; keep the scheduled task on its current 2-minute short-poll config until manually cut over — no behavior change until the installer is re-run.
2. Re-run `install-telegram-scheduled-task.ps1` (updated defaults: long-poll mode, 1-minute repetition) to cut over.
3. Watch `~/.longterm/logs/telegram-poll.log` for a few cycles to confirm clean 15-minute refreshes and no error loops.
4. Rollback path: `install-telegram-scheduled-task.ps1 -Legacy` (or equivalent) restores the exact 2-minute `--once` behavior with no code changes needed.
