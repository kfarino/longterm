# Telegram Long-Poll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Telegram bot's 2-minute scheduled short-poll with a persistent long-polling loop, so a message is picked up in roughly a second instead of up to 2 minutes later.

**Architecture:** `runOnce()` — the function that does one `getUpdates` call and dispatches every message in the batch — keeps its exact signature and behavior; every existing test against it is untouched. A new `runPollLoop()` wraps it in a loop that passes a 25-second `timeout` into `getUpdates` (Telegram holds the connection open and returns the instant a message arrives) and self-exits every 15 minutes so code edits take effect automatically. Task Scheduler's existing `-MultipleInstances IgnoreNew` setting is both the crash-recovery and refresh-recovery mechanism — no new process-management tooling.

**Tech Stack:** Node.js ESM (`.mjs`), hand-rolled `assert/strict` test runners (no test framework), PowerShell `New-ScheduledTaskTrigger` — all matching existing conventions in `scripts/`.

**Design doc:** `docs/superpowers/specs/2026-08-06-telegram-long-poll-design.md` — read this first for the "why" behind every choice below (no true webhook, 15-minute self-refresh, reusing `IgnoreNew` instead of new tooling).

## Global Constraints

- `runOnce()`'s signature, defaults, and behavior when called with no new options must be **byte-for-byte identical** to today — every case in `data/test-telegram-bot.mjs` must keep passing unmodified.
- A thrown error inside one loop iteration (either the message-dispatch step or the calendar-sync step) must be caught, logged, and must not stop the loop — a persistent process cannot let one transient failure cost 15 minutes of uptime.
- No new inbound network exposure, no tunnel, no public endpoint — long-polling only.
- No new process-management tooling (NSSM, PM2, Windows Service). Supervision is Task Scheduler's `-MultipleInstances IgnoreNew` plus a short repetition interval, exactly as the design doc specifies.
- Every new file write is append-only or atomic, following this codebase's existing conventions (`fs.mkdirSync(..., {recursive:true})` before `fs.appendFileSync`, matching `telegram-bot-recap.mjs`'s `appendJsonl`).
- Tests inject every external dependency (`getUpdatesClient`, `telegramClient`, `calendarSyncFn`, `logPath`, `now`) — no real network calls, no writes to this machine's real `~/.longterm/logs/`.

---

### Task 1: Make `getUpdates` itself injectable and its timeout configurable

**Files:**
- Modify: `scripts/telegram-bot-poll.mjs:703-721` (inside `runOnce`)
- Test: `data/test-telegram-bot.mjs`

**Interfaces:**
- Consumes: nothing new — this is the first task.
- Produces: `runOnce(opts)` accepts two new optional keys on `opts`, used only on the non-fixture path:
  - `opts.getUpdatesClient: (token, method, body) => Promise<{ok, result}>` — defaults to the existing `callTelegram` when omitted.
  - `opts.getUpdatesTimeoutSeconds: number` — defaults to `0` when omitted (today's exact behavior), becomes `body.timeout` in the `getUpdates` call.
  Task 2 relies on both of these to drive `runPollLoop`'s tests without a real network call.

- [ ] **Step 1: Write the failing test**

Add to `data/test-telegram-bot.mjs`, near its other `runOnce` tests (find the file's existing `import` block and add nothing new — `runOnce` is already imported):

```js
await asyncTest('getUpdatesClient, when supplied, is used instead of the real Telegram API', async () => {
  const dir = path.join(tmpRoot, 'get-updates-client-injection');
  const paths = writeFixture(dir, { updates: { ok: true, result: [] } });
  const calls = [];
  const getUpdatesClient = async (token, method, body) => {
    calls.push({ token, method, body });
    return { ok: true, result: [] };
  };
  // updatesFixture takes priority over getUpdatesClient when both are set, so
  // this test must omit updatesFixture to actually exercise the new client —
  // point it at a nonexistent path explicitly rather than relying on baseOpts'
  // default (which does set updatesFixture).
  await runOnce({ ...baseOpts(paths, {}), updatesFixture: null, getUpdatesClient, getUpdatesTimeoutSeconds: 25 });

  assert.equal(calls.length, 1, 'getUpdatesClient should be called exactly once');
  assert.equal(calls[0].method, 'getUpdates');
  assert.equal(calls[0].body.timeout, 25, 'the configured timeout should reach the request body');
});

await asyncTest('omitting getUpdatesClient/getUpdatesTimeoutSeconds preserves the exact updatesFixture path (no behavior change)', async () => {
  // This is the regression guard: every other test in this file relies on
  // updatesFixture continuing to short-circuit before any client is touched.
  const dir = path.join(tmpRoot, 'get-updates-client-omitted');
  const paths = writeFixture(dir, { updates: { ok: true, result: [] } });
  const result = await runOnce(baseOpts(paths, {}));
  assert.ok(result, 'runOnce should complete normally with no new options supplied');
});
```

- [ ] **Step 2: Run tests to verify the first one fails**

Run: `node data/test-telegram-bot.mjs`
Expected: FAIL on `'getUpdatesClient, when supplied, is used instead of the real Telegram API'` — `getUpdatesClient` is never called because the current code always calls the real `callTelegram` (or reads `updatesFixture`).

- [ ] **Step 3: Implement the injection**

In `scripts/telegram-bot-poll.mjs`, replace the `getUpdates` block inside `runOnce`:

```js
  let updatesResponse;
  if (args.updatesFixture) {
    updatesResponse = JSON.parse(fs.readFileSync(args.updatesFixture, 'utf8'));
  } else {
    // timeout defaults to 0 (today's exact short-poll behavior) unless a
    // caller configures a longer one — runPollLoop (Task 2) passes 25.
    const body = { timeout: args.getUpdatesTimeoutSeconds || 0 };
    if (offset != null) body.offset = offset;
    const getUpdatesClient = args.getUpdatesClient || callTelegram;
    updatesResponse = await getUpdatesClient(token, 'getUpdates', body);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-telegram-bot.mjs`
Expected: PASS, including every pre-existing case in the file (this change is additive — `updatesFixture` still short-circuits exactly as before, and the real-network path defaults to `timeout: 0` exactly as before).

- [ ] **Step 5: Commit**

```bash
git add scripts/telegram-bot-poll.mjs data/test-telegram-bot.mjs
git commit -m "Make getUpdates injectable and its timeout configurable in runOnce."
```

---

### Task 2: `runPollLoop()` — the long-poll loop, self-refresh, and error containment

**Files:**
- Modify: `scripts/longterm-paths.mjs`
- Modify: `scripts/telegram-bot-poll.mjs`
- Create: `data/test-telegram-poll-loop.mjs`

**Interfaces:**
- Consumes: Task 1's `runOnce(opts)` with `getUpdatesClient`/`getUpdatesTimeoutSeconds`; the existing module-private `runCalendarSyncStep()` (unchanged, still returns `{skipped, error?}` or `{skipped: false, created, updated, deleted}`).
- Produces: `telegramPollLogPath(): string` (exported from `longterm-paths.mjs`); `runPollLoop(opts): Promise<{iterations: number}>` (exported from `telegram-bot-poll.mjs`), accepting:
  - `maxDurationMs: number` — default `15 * 60 * 1000`.
  - `maxIterations: number` — default `Infinity`; the test-only bound.
  - `getUpdatesTimeoutSeconds: number` — default `25`, forwarded into each `runOnce` call.
  - `calendarSyncFn: () => Promise<{skipped, created?, updated?, deleted?, error?}>` — default `runCalendarSyncStep`.
  - `logPath: string` — default `telegramPollLogPath()`.
  - `now: () => number` — default `() => Date.now()`.
  - every other key is forwarded verbatim to each `runOnce(...)` call (so `updatesPath`, `todosPath`, `getUpdatesClient`, etc. all flow through exactly as they do for a single `runOnce` call today).
  Task 3 calls this from `main()`.

- [ ] **Step 1: Add the log path helper**

In `scripts/longterm-paths.mjs`, add:

```js
export function telegramPollLogPath() {
  return path.join(longtermHome(), 'logs', 'telegram-poll.log');
}
```

- [ ] **Step 2: Write the failing test**

Create `data/test-telegram-poll-loop.mjs`:

```js
// Longterm/data/test-telegram-poll-loop.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// runPollLoop()'s own orchestration — looping, self-refresh bound, and
// per-iteration error containment — as distinct from runOnce()'s message
// dispatch logic, which test-telegram-bot.mjs already covers exhaustively.
// Run with:
//   node Longterm/data/test-telegram-poll-loop.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runPollLoop } from '../scripts/telegram-bot-poll.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-telegram-poll-loop.mjs');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'poll-loop-test-')); }

/**
 * A getUpdatesClient stub that always reports zero messages — runPollLoop's
 * own orchestration is what's under test here, not message dispatch, so an
 * empty batch every call keeps each iteration trivial and fast.
 */
function emptyGetUpdatesClient() {
  return async () => ({ ok: true, result: [] });
}

function writeMinimalFixture(dir) {
  const todosPath = path.join(dir, 'todos.json');
  const ownersPath = path.join(dir, 'owners.json');
  const offsetPath = path.join(dir, 'offset.json');
  const unparsedPath = path.join(dir, 'unparsed.jsonl');
  const goalsPath = path.join(dir, 'goals.json');
  fs.writeFileSync(todosPath, JSON.stringify({ items: [], weeklyGoals: [] }, null, 2));
  fs.writeFileSync(ownersPath, JSON.stringify({}, null, 2));
  fs.writeFileSync(goalsPath, JSON.stringify({ owners: [], diningRoutine: [], lowKeyHangIdeas: [] }, null, 2));
  return { todosPath, ownersPath, offsetPath, unparsedPath, goalsPath };
}

function baseLoopOpts(dir, extra = {}) {
  const p = writeMinimalFixture(dir);
  return {
    getUpdatesClient: emptyGetUpdatesClient(),
    telegramClient: async () => ({ ok: true }),
    // Deliberately no updatesFixture here — the point of this file is to
    // exercise getUpdatesClient across multiple iterations. That means
    // runOnce falls through to readLocalEnv(envPath) unless envPath is
    // overridden, so it must point somewhere guaranteed not to exist —
    // otherwise this test would depend on this machine's real
    // ~/.longterm/telegram.env, violating AGENTS.md's "tests must pass
    // without real .env files" rule. Same reasoning for ouraStoreDir/
    // healthOverridesPath, which would otherwise default to this worktree's
    // real data/oura/ and data/health_overrides.json.
    envPath: path.join(dir, 'nonexistent-telegram.env'),
    ouraStoreDir: path.join(dir, 'oura-store'),
    healthOverridesPath: path.join(dir, 'health_overrides.json'),
    token: 'test-token', groupChatId: '-1', botUsername: 'test_bot', apiKey: 'test-key',
    todosPath: p.todosPath, ownersPath: p.ownersPath, offsetPath: p.offsetPath,
    unparsedPath: p.unparsedPath, goalsPath: p.goalsPath,
    favoritePlacesPath: path.join(dir, 'fp.json'), monthPlanEventsPath: path.join(dir, 'mpe.json'),
    budgetTrackingPath: path.join(dir, 'bt.json'), accountsPath: path.join(dir, 'acc.json'),
    routineOverridesPath: path.join(dir, 'ro.json'), conversationLogPath: path.join(dir, 'conv.jsonl'),
    goalsChangelogPath: path.join(dir, 'gcl.jsonl'), pendingClarificationsPath: path.join(dir, 'pc.json'),
    remindersPath: path.join(dir, 'reminders.json'),
    calendarSyncFn: async () => ({ skipped: true }),
    logPath: path.join(dir, 'poll.log'),
    maxIterations: 3,
    ...extra,
  };
}

await asyncTest('loops exactly maxIterations times, not until maxDurationMs', async () => {
  const dir = tmpDir();
  const result = await runPollLoop(baseLoopOpts(dir, { maxIterations: 4 }));
  assert.equal(result.iterations, 4);
});

await asyncTest('each iteration forwards getUpdatesTimeoutSeconds into the getUpdates call', async () => {
  const dir = tmpDir();
  const timeouts = [];
  const spyClient = async (token, method, body) => { timeouts.push(body.timeout); return { ok: true, result: [] }; };
  await runPollLoop(baseLoopOpts(dir, { getUpdatesClient: spyClient, getUpdatesTimeoutSeconds: 25, maxIterations: 2 }));
  assert.deepEqual(timeouts, [25, 25]);
});

await asyncTest('calendarSyncFn is invoked once per iteration', async () => {
  const dir = tmpDir();
  let calls = 0;
  const calendarSyncFn = async () => { calls += 1; return { skipped: true }; };
  await runPollLoop(baseLoopOpts(dir, { calendarSyncFn, maxIterations: 3 }));
  assert.equal(calls, 3);
});

await asyncTest('a thrown error in one iteration is caught, logged, and the loop continues', async () => {
  const dir = tmpDir();
  let call = 0;
  const flakyClient = async () => {
    call += 1;
    if (call === 2) throw new Error('simulated Telegram API failure');
    return { ok: true, result: [] };
  };
  const result = await runPollLoop(baseLoopOpts(dir, { getUpdatesClient: flakyClient, maxIterations: 3 }));
  assert.equal(result.iterations, 3, 'the loop should still complete all 3 iterations despite the failure on #2');
  const log = fs.readFileSync(path.join(dir, 'poll.log'), 'utf8');
  assert.match(log, /simulated Telegram API failure/, 'the error should be recorded in the log');
});

await asyncTest('a thrown error from calendarSyncFn is caught and does not stop the loop', async () => {
  const dir = tmpDir();
  let call = 0;
  const flakyCalendar = async () => {
    call += 1;
    if (call === 1) throw new Error('simulated Calendar API failure');
    return { skipped: true };
  };
  const result = await runPollLoop(baseLoopOpts(dir, { calendarSyncFn: flakyCalendar, maxIterations: 3 }));
  assert.equal(result.iterations, 3);
  const log = fs.readFileSync(path.join(dir, 'poll.log'), 'utf8');
  assert.match(log, /simulated Calendar API failure/);
});

await asyncTest('the loop stops at maxDurationMs even if maxIterations is not reached', async () => {
  const dir = tmpDir();
  // Injected `now` advances by a full duration's worth on the very first
  // check after iteration 1, so the loop must not attempt iteration 2.
  let calls = 0;
  const startedAt = 1000;
  const now = () => (calls === 0 ? startedAt : startedAt + 20 * 60 * 1000);
  const countingClient = async () => { calls += 1; return { ok: true, result: [] }; };
  const result = await runPollLoop(baseLoopOpts(dir, {
    getUpdatesClient: countingClient, maxIterations: Infinity, maxDurationMs: 15 * 60 * 1000, now,
  }));
  assert.equal(result.iterations, 1, 'only the first iteration should run before the duration bound trips');
});

await asyncTest('start and exit are recorded in the log file, creating its directory if needed', async () => {
  const dir = tmpDir();
  const nestedLogPath = path.join(dir, 'nested', 'poll.log');
  await runPollLoop(baseLoopOpts(dir, { logPath: nestedLogPath, maxIterations: 1 }));
  const log = fs.readFileSync(nestedLogPath, 'utf8');
  assert.match(log, /loop start/);
  assert.match(log, /loop exiting after 1 iteration/);
});

console.log('All telegram-poll-loop tests passed.');
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node data/test-telegram-poll-loop.mjs`
Expected: FAIL — `runPollLoop` does not exist yet (`SyntaxError`/`does not provide an export named 'runPollLoop'`).

- [ ] **Step 4: Implement `runPollLoop`**

In `scripts/telegram-bot-poll.mjs`, add near `runOnce` (after it, before `runCalendarSyncStep`), and add the new import at the top of the file alongside the existing `longterm-paths.mjs` import:

```js
import { googleCalendarEnvPath, telegramEnvPath, telegramPollLogPath } from './longterm-paths.mjs';
```

```js
function appendPollLog(logPath, message) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${message}${os.EOL}`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, line, 'utf8');
}

// Wraps runOnce() in a long-poll loop instead of the old "one short getUpdates
// call, then exit" cadence. Each iteration passes getUpdatesTimeoutSeconds
// into getUpdates, so Telegram holds the connection open and returns the
// instant a message arrives rather than after a fixed short interval — this
// is the entire mechanism behind "near-instant" pickup.
//
// Exits after maxDurationMs (15 min in production) rather than running
// forever: this project is edited often, and a truly-forever process would
// keep running stale code until someone remembered to restart it by hand.
// Task Scheduler's -MultipleInstances IgnoreNew setting (see
// install-telegram-scheduled-task.ps1) relaunches it within a minute either
// way — clean self-refresh or an unhandled crash look the same to the
// scheduler, and both self-heal without any code here needing to know which
// one happened.
//
// A thrown error in EITHER the message-dispatch step or the calendar-sync
// step is caught, logged, and the loop continues to the next iteration —
// unlike the old short-lived process (where a thrown error just killed that
// invocation and the next 2-minute tick tried again fresh), a persistent
// process cannot let one transient failure cost the whole 15-minute window.
export async function runPollLoop(opts = {}) {
  const {
    maxDurationMs = 15 * 60 * 1000,
    maxIterations = Infinity,
    getUpdatesTimeoutSeconds = 25,
    calendarSyncFn = runCalendarSyncStep,
    logPath = telegramPollLogPath(),
    now = () => Date.now(),
    ...runOnceOpts
  } = opts;

  const startedAt = now();
  let iteration = 0;
  appendPollLog(logPath, `loop start (max ${Math.round(maxDurationMs / 60000)} min)`);

  while (iteration < maxIterations && (now() - startedAt) < maxDurationMs) {
    iteration += 1;
    try {
      const result = await runOnce({ ...runOnceOpts, getUpdatesTimeoutSeconds });
      appendPollLog(logPath, `iteration ${iteration}: ${result.sentReplies.length} repl(y/ies) sent`);
    } catch (err) {
      appendPollLog(logPath, `iteration ${iteration} ERROR: ${err.message || err}`);
    }
    try {
      const calResult = await calendarSyncFn();
      if (!calResult.skipped) {
        appendPollLog(logPath, `iteration ${iteration} calendar sync: +${calResult.created} ~${calResult.updated} -${calResult.deleted}`);
      }
    } catch (err) {
      appendPollLog(logPath, `iteration ${iteration} calendar sync ERROR: ${err.message || err}`);
    }
  }

  appendPollLog(logPath, `loop exiting after ${iteration} iteration${iteration === 1 ? '' : 's'}`);
  return { iterations: iteration };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node data/test-telegram-poll-loop.mjs`
Expected: PASS — all 7 cases print `ok - ...`.

- [ ] **Step 6: Run the full existing suite to confirm nothing else broke**

Run: `node data/test-telegram-bot.mjs`
Expected: PASS — `runOnce` itself is unchanged by this task.

- [ ] **Step 7: Commit**

```bash
git add scripts/longterm-paths.mjs scripts/telegram-bot-poll.mjs data/test-telegram-poll-loop.mjs
git commit -m "Add runPollLoop: long-poll loop with 15-minute self-refresh and error containment."
```

---

### Task 3: Wire `--once` / CLI flags and switch `main()` to the loop by default

**Files:**
- Modify: `scripts/telegram-bot-poll.mjs`

**Interfaces:**
- Consumes: Task 2's `runPollLoop(opts)`.
- Produces: `main()` (unexported, unchanged interface — it's the script's entry point) now defaults to calling `runPollLoop(args)`; passing `--once` on the command line makes it fall back to exactly today's single-shot behavior. Three new CLI flags recognized by `parseArgs`: `--once` (boolean), `--max-duration-ms <n>`, `--max-iterations <n>` — the latter two exist so a human can smoke-test the real loop for a few seconds against the live Telegram API instead of waiting a full 15 minutes.

- [ ] **Step 1: Add the new flags to `parseArgs`**

In `scripts/telegram-bot-poll.mjs`, inside `parseArgs`, add `once: false` to the returned defaults object (alongside the existing `dryRun: false`), and add flag handling:

```js
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg === '--once') { args.once = true; continue; }
```

(that second line goes right below the existing `--dry-run` check). Then, in the `--key value` branch further down, add two more `else if` cases right before the final `else throw`:

```js
      else if (key === 'max-duration-ms') args.maxDurationMs = Number(value);
      else if (key === 'max-iterations') args.maxIterations = Number(value);
```

- [ ] **Step 2: Rewrite `main()`**

Replace the existing `main()`:

```js
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.once) {
    const result = await runOnce(args);
    console.log(JSON.stringify({ ok: true, todosChanged: result.todosChanged, repliesSent: result.sentReplies.length }));
    const calendarResult = await runCalendarSyncStep();
    if (!calendarResult.skipped) {
      console.log(JSON.stringify({ ok: true, calendarCreated: calendarResult.created, calendarUpdated: calendarResult.updated, calendarDeleted: calendarResult.deleted }));
    }
    return;
  }
  const loopResult = await runPollLoop(args);
  console.log(JSON.stringify({ ok: true, iterations: loopResult.iterations }));
}
```

- [ ] **Step 3: Verify `--once` reproduces today's exact behavior against a fixture**

Run:
```bash
mkdir -p /tmp/once-smoke && cd /tmp/once-smoke
echo '{"ok":true,"result":[]}' > updates.json
echo '{"items":[],"weeklyGoals":[]}' > todos.json
echo '{}' > owners.json
echo '{"owners":[],"diningRoutine":[],"lowKeyHangIdeas":[]}' > goals.json
cd -
node scripts/telegram-bot-poll.mjs --once --updates-fixture /tmp/once-smoke/updates.json --todos-path /tmp/once-smoke/todos.json --owners-path /tmp/once-smoke/owners.json --goals-path /tmp/once-smoke/goals.json --offset-path /tmp/once-smoke/offset.json --unparsed-path /tmp/once-smoke/unparsed.jsonl --dry-run
```
Expected: prints one `{"ok":true,"todosChanged":false,"repliesSent":0}` line and exits immediately — no hang, no loop.

- [ ] **Step 4: Verify the default (no `--once`) path runs the loop and self-bounds**

Run:
```bash
node scripts/telegram-bot-poll.mjs --updates-fixture /tmp/once-smoke/updates.json --todos-path /tmp/once-smoke/todos.json --owners-path /tmp/once-smoke/owners.json --goals-path /tmp/once-smoke/goals.json --offset-path /tmp/once-smoke/offset.json --unparsed-path /tmp/once-smoke/unparsed.jsonl --dry-run --max-iterations 3
```
Expected: runs 3 quick iterations against the static fixture (each iteration re-reads the same fixture — fine for this smoke test, since the goal is confirming the loop actually iterates and exits, not exercising dispatch logic) and prints one final `{"ok":true,"iterations":3}` line, then exits — confirms `--max-iterations` bounds it even though `--once` was not passed.

- [ ] **Step 5: Run the full test suite**

Run: `node data/test-telegram-bot.mjs && node data/test-telegram-poll-loop.mjs`
Expected: both PASS.

- [ ] **Step 6: Commit**

```bash
git add scripts/telegram-bot-poll.mjs
git commit -m "Wire --once/--max-duration-ms/--max-iterations; default main() to the long-poll loop."
```

---

### Task 4: Installer — long-poll by default, `-Legacy` switch for instant rollback

**Files:**
- Modify: `scripts/install-telegram-scheduled-task.ps1`

**Interfaces:**
- Consumes: nothing from earlier tasks directly — this only needs `scripts/telegram-bot-poll.mjs` to accept `--once` (Task 3) for its `-Legacy` mode.
- Produces: no other script depends on this file; it's a standalone operational entry point.

- [ ] **Step 1: Rewrite the installer**

Replace the full contents of `scripts/install-telegram-scheduled-task.ps1`:

```powershell
param(
    [string]$TaskName = 'LongtermTelegramPoll',
    [int]$IntervalMinutes = 0,
    [switch]$Legacy,
    [switch]$Uninstall,
    [switch]$WhatIf
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Sibling to install-scheduled-task.ps1 (the Monarch daily-pull installer).
#
# Default mode: telegram-bot-poll.mjs runs its own internal long-poll loop
# (see runPollLoop in that file) and exits every ~15 minutes to pick up code
# changes automatically. This task's -RepetitionInterval only controls how
# quickly a crash or a clean self-refresh gets noticed and relaunched — the
# actual message-check cadence is governed by the script's own loop, not by
# this task firing. -MultipleInstances IgnoreNew (below) is what makes this
# self-healing: while the loop process is alive, each tick is a no-op; the
# moment it exits, the next tick relaunches it.
#
# -Legacy mode restores the exact pre-2026-08-06 behavior: telegram-bot-poll.mjs
# runs with --once (a single short getUpdates call, then exit) on a 2-minute
# interval. Use this as an instant rollback if long-polling ever misbehaves
# (e.g. an unexpected Telegram rate limit) — no code change needed, just
# re-run this installer with -Legacy.

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed scheduled task '$TaskName' (if it existed)."
    exit 0
}

function Resolve-Node {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $node) {
        throw 'Node.js is required to run the Telegram bot poller.'
    }
    return $node.Source
}

$scriptPath = Join-Path $PSScriptRoot 'telegram-bot-poll.mjs'
if (-not (Test-Path -LiteralPath $scriptPath)) {
    throw "Missing script at $scriptPath"
}

if ($IntervalMinutes -le 0) {
    # Long-poll mode only needs a fast enough tick to notice a crash/refresh
    # quickly; legacy mode's interval IS the actual poll cadence, so it keeps
    # its historical, more conservative default.
    $IntervalMinutes = if ($Legacy) { 2 } else { 1 }
}

$nodeExe = Resolve-Node
$taskArgs = if ($Legacy) { ('"{0}" --once' -f $scriptPath) } else { ('"{0}"' -f $scriptPath) }
$modeLabel = if ($Legacy) { 'legacy short-poll (--once)' } else { 'long-poll loop' }

if ($WhatIf) {
    Write-Host ('Would create scheduled task "{0}" — {1}, checked/relaunched every {2} minute(s)' -f $TaskName, $modeLabel, $IntervalMinutes)
    Write-Host ('Task command: {0} {1}' -f $nodeExe, $taskArgs)
    exit 0
}

$action = New-ScheduledTaskAction -Execute $nodeExe -Argument $taskArgs
# [TimeSpan]::MaxValue overflows Task Scheduler's XML duration format
# (P99999999DT23H59M59S is out of range) — 10 years is effectively
# "indefinitely" for this purpose and stays within a valid duration.
$trigger = New-ScheduledTaskTrigger -Once -At ([datetime]::Now) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description "Runs the Longterm Telegram bot poller ($modeLabel)." -Force | Out-Host

Write-Host ("Registered scheduled task '{0}' — {1}, checked/relaunched every {2} minute(s)." -f $TaskName, $modeLabel, $IntervalMinutes)
```

- [ ] **Step 2: Verify both modes with `-WhatIf` (no real registration, safe to run anytime)**

Run: `powershell -File scripts/install-telegram-scheduled-task.ps1 -WhatIf`
Expected: `Would create scheduled task "LongtermTelegramPoll" — long-poll loop, checked/relaunched every 1 minute(s)` and a command line with no `--once`.

Run: `powershell -File scripts/install-telegram-scheduled-task.ps1 -Legacy -WhatIf`
Expected: `Would create scheduled task "LongtermTelegramPoll" — legacy short-poll (--once), checked/relaunched every 2 minute(s)` and a command line ending in `--once`.

Run: `powershell -File scripts/install-telegram-scheduled-task.ps1 -IntervalMinutes 5 -WhatIf`
Expected: honors the explicit override — `every 5 minute(s)`, long-poll mode (no `--once`).

- [ ] **Step 3: Commit**

```bash
git add scripts/install-telegram-scheduled-task.ps1
git commit -m "Installer: long-poll by default, -Legacy switch restores the old 2-minute short-poll."
```

---

### Task 5: Docs, full suite, and rollout note

**Files:**
- Modify: `claude.md`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed elsewhere — documentation only.

- [ ] **Step 1: Fix the stale "2-minute scheduled task" reference**

In `claude.md`, find the `scripts/calendar-sync.mjs` bullet (search for `Runs as the last step of \`telegram-bot-poll.mjs\`'s 2-minute scheduled task`) and replace that clause:

```
Runs as the last step of every iteration of `telegram-bot-poll.mjs`'s long-poll loop (see below) — skips quietly until `google-calendar.env` exists, and a Calendar API failure never fails the poll itself.
```

- [ ] **Step 2: Add a bullet documenting the poll architecture itself**

In `claude.md`, add a new bullet near the `scripts/calendar-sync.mjs` one (same list):

```
- `scripts/telegram-bot-poll.mjs` — long-polls Telegram (2026-08-06, replacing a 2-minute scheduled short-poll): `runPollLoop()` calls `getUpdates` with a 25-second timeout in a loop, so a message is picked up in roughly a second rather than up to 2 minutes later, and self-exits every ~15 minutes so a code edit takes effect automatically at the next relaunch rather than needing a manual restart. Supervision reuses `install-telegram-scheduled-task.ps1`'s existing `-MultipleInstances IgnoreNew` setting — a 1-minute repetition tick is a no-op while the loop is alive and relaunches it within a minute of either a clean self-refresh or a crash, so no new process-management tooling was needed. `install-telegram-scheduled-task.ps1 -Legacy` restores the exact pre-2026-08-06 2-minute `--once` behavior as an instant rollback. Logs to `~/.longterm/logs/telegram-poll.log`.
```

- [ ] **Step 3: Run the full suite**

Run each of: `node data/test-telegram-bot.mjs`, `node data/test-telegram-poll-loop.mjs`, `node data/test-calendar-sync.mjs`, `node data/test-telegram-recap.mjs`, `node data/test-telegram-reminders.mjs`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
npm run check:secrets
git add claude.md
git commit -m "Document the long-poll architecture; fix the stale 2-minute reference."
```

- [ ] **Step 5: Note the rollout step that is NOT part of this plan**

This plan ships the code and the updated installer, but does **not** re-run the installer against the real Windows Scheduled Task — per the design doc's Rollout section, that's a deliberate separate step (re-run `install-telegram-scheduled-task.ps1` to cut over, watch `~/.longterm/logs/telegram-poll.log` for a few cycles, keep `-Legacy` as the documented rollback). Flag this to the user explicitly when the plan is complete; do not run the real installer against the production scheduled task as part of implementing this plan.

---

## Self-review

**Spec coverage:** `getUpdates` timeout + injectability (Task 1) · long-poll loop, 25s timeout, 15-min self-refresh, calendar sync per iteration, error containment, log file (Task 2) · `--once` CLI escape hatch (Task 3) · Task Scheduler `-Legacy` switch and `-MultipleInstances IgnoreNew` reuse (Task 4) · doc fix for the stale "2-minute" reference (Task 5). The spec's non-goals (no webhook, no reply-latency work, no new process tooling, no recap/reminders changes) correctly have no corresponding task.

**Type consistency:** `runOnce`'s new `getUpdatesClient`/`getUpdatesTimeoutSeconds` (Task 1) are exactly the keys `runPollLoop` forwards via its `...runOnceOpts` spread plus its own explicit `getUpdatesTimeoutSeconds` (Task 2). `calendarSyncFn`'s return shape (`{skipped, created?, updated?, deleted?, error?}`) matches what `runCalendarSyncStep` already returns and what `main()` already destructures today. `runPollLoop`'s return (`{iterations}`) is what Task 3's `main()` logs.
