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
  // readLocalEnv(envPath) is only skipped when updatesFixture is set — this
  // suite deliberately omits updatesFixture (to exercise getUpdatesClient
  // across iterations), so envPath must point at a real, parseable file, not
  // just a "guaranteed nonexistent" one. Its values are irrelevant: the
  // explicit token/groupChatId/etc passed into baseLoopOpts win over
  // whatever readLocalEnv returns.
  const envPath = path.join(dir, 'fake-telegram.env');
  fs.writeFileSync(todosPath, JSON.stringify({ items: [], weeklyGoals: [] }, null, 2));
  fs.writeFileSync(ownersPath, JSON.stringify({}, null, 2));
  fs.writeFileSync(goalsPath, JSON.stringify({ owners: [], diningRoutine: [], lowKeyHangIdeas: [] }, null, 2));
  fs.writeFileSync(envPath, 'TELEGRAM_BOT_TOKEN=unused\n');
  return { todosPath, ownersPath, offsetPath, unparsedPath, goalsPath, envPath };
}

function baseLoopOpts(dir, extra = {}) {
  const p = writeMinimalFixture(dir);
  return {
    getUpdatesClient: emptyGetUpdatesClient(),
    telegramClient: async () => ({ ok: true }),
    // envPath points at writeMinimalFixture's fake local file, never this
    // machine's real ~/.longterm/telegram.env (AGENTS.md: tests must pass
    // without real .env files). Same reasoning for ouraStoreDir/
    // healthOverridesPath, which would otherwise default to this worktree's
    // real data/oura/ and data/health_overrides.json.
    envPath: p.envPath,
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

import { runCalendarSyncStep } from '../scripts/telegram-bot-poll.mjs';
import { isGoogleAuthFailure } from '../scripts/calendar-sync.mjs';

test('isGoogleAuthFailure catches invalid_grant / revoked refresh tokens', () => {
  assert.equal(isGoogleAuthFailure(new Error('Google token refresh failed: 400 { "error": "invalid_grant" }')), true);
  assert.equal(isGoogleAuthFailure(new Error('Token has been expired or revoked.')), true);
  assert.equal(isGoogleAuthFailure(new Error('Calendar API 503')), false);
});

// These tests previously asserted the opposite — that sync must NEVER retry
// while the pause file exists, and must never re-log. That is exactly how
// Google Calendar sync stayed dead for three days while the bot kept confirming
// events: the pause was checked before every attempt and cleared only after a
// success, so it could not expire, and the one log line scrolled away. The
// contract now is: back off, but always come back, and always be audible.
const AUTH_ERROR = 'Google token refresh failed: 400 { "error": "invalid_grant", "error_description": "Token has been expired or revoked." }';

function pauseHarness() {
  const dir = tmpDir();
  const envPath = path.join(dir, 'google-calendar.env');
  const pausePath = path.join(dir, 'auth-pause.json');
  const logPath = path.join(dir, 'poll.log');
  const monthPlanEventsPath = path.join(dir, 'month_plan_events.json');
  fs.writeFileSync(envPath, 'GOOGLE_CLIENT_ID=x\n');
  fs.writeFileSync(monthPlanEventsPath, JSON.stringify({ events: {} }));
  const alerts = [];
  const alertFn = async (text) => { alerts.push(text); };
  return { dir, envPath, pausePath, logPath, monthPlanEventsPath, alerts, alertFn };
}

await asyncTest('runCalendarSyncStep backs off after invalid_grant but retries once the backoff expires', async () => {
  const h = pauseHarness();
  let calls = 0;
  const syncFn = async () => { calls += 1; throw new Error(AUTH_ERROR); };
  const base = { envPath: h.envPath, authPausePath: h.pausePath, logPath: h.logPath, monthPlanEventsPath: h.monthPlanEventsPath, syncFn, alertFn: h.alertFn };

  const t0 = new Date('2026-08-12T00:00:00Z');
  const first = await runCalendarSyncStep({ ...base, now: t0 });
  assert.equal(first.paused, true);
  assert.equal(calls, 1);

  // Still inside the 6h backoff — suppressed, but not silent.
  const during = await runCalendarSyncStep({ ...base, now: new Date('2026-08-12T03:00:00Z') });
  assert.equal(during.paused, true);
  assert.equal(calls, 1, 'must not hammer Google while backing off');
  assert.match(fs.readFileSync(h.logPath, 'utf8'), /calendar sync paused until/);

  // Past the 6h backoff — must try again rather than stay dead forever.
  await runCalendarSyncStep({ ...base, now: new Date('2026-08-12T07:00:00Z') });
  assert.equal(calls, 2, 'must retry Google once the backoff has expired');

  const pause = JSON.parse(fs.readFileSync(h.pausePath, 'utf8'));
  assert.equal(pause.failureCount, 2);
  assert.equal(pause.at, t0.toISOString(), 'outage start time is preserved across re-arms');
});

await asyncTest('a recovered token clears the pause with no manual file deletion', async () => {
  const h = pauseHarness();
  let shouldFail = true;
  const syncFn = async () => {
    if (shouldFail) throw new Error(AUTH_ERROR);
    return { created: 3, updated: 0, deleted: 0 };
  };
  const base = { envPath: h.envPath, authPausePath: h.pausePath, logPath: h.logPath, monthPlanEventsPath: h.monthPlanEventsPath, syncFn, alertFn: h.alertFn };

  await runCalendarSyncStep({ ...base, now: new Date('2026-08-12T00:00:00Z') });
  assert.ok(fs.existsSync(h.pausePath), 'paused after the auth failure');

  shouldFail = false;
  const recovered = await runCalendarSyncStep({ ...base, now: new Date('2026-08-12T07:00:00Z') });
  assert.equal(recovered.created, 3);
  assert.equal(fs.existsSync(h.pausePath), false, 'a successful sync clears the pause by itself');
  assert.match(fs.readFileSync(h.logPath, 'utf8'), /RECOVERED/);
});

await asyncTest('a legacy pause file with no retryAfter is treated as expired, not permanent', async () => {
  const h = pauseHarness();
  // Exactly the shape left on disk by the pre-backoff code.
  fs.writeFileSync(h.pausePath, JSON.stringify({ at: '2026-08-09T19:58:16.341Z', reason: 'Google token refresh failed: invalid_grant' }));
  let calls = 0;
  const syncFn = async () => { calls += 1; return { created: 0, updated: 0, deleted: 0 }; };

  const result = await runCalendarSyncStep({
    envPath: h.envPath, authPausePath: h.pausePath, logPath: h.logPath,
    monthPlanEventsPath: h.monthPlanEventsPath, syncFn, alertFn: h.alertFn,
    now: new Date('2026-08-12T00:00:00Z'),
  });
  assert.equal(calls, 1, 'a stale latch must not block sync forever');
  assert.equal(result.skipped, undefined);
  assert.equal(fs.existsSync(h.pausePath), false);
});

await asyncTest('the humans are told once, then at most daily, while sync stays down', async () => {
  const h = pauseHarness();
  const syncFn = async () => { throw new Error(AUTH_ERROR); };
  const base = { envPath: h.envPath, authPausePath: h.pausePath, logPath: h.logPath, monthPlanEventsPath: h.monthPlanEventsPath, syncFn, alertFn: h.alertFn };

  await runCalendarSyncStep({ ...base, now: new Date('2026-08-12T00:00:00Z') });
  assert.equal(h.alerts.length, 1, 'alerts on the first failure');
  assert.match(h.alerts[0], /--reauth-only/, 'tells the user the command that actually fixes it');

  await runCalendarSyncStep({ ...base, now: new Date('2026-08-12T03:00:00Z') });
  assert.equal(h.alerts.length, 1, 'does not re-alert on every iteration');

  await runCalendarSyncStep({ ...base, now: new Date('2026-08-13T04:00:00Z') });
  assert.equal(h.alerts.length, 2, 're-alerts after a day so a silent outage cannot persist');
});

await asyncTest('a failing alert never fails the sync step', async () => {
  const h = pauseHarness();
  const syncFn = async () => { throw new Error(AUTH_ERROR); };
  const result = await runCalendarSyncStep({
    envPath: h.envPath, authPausePath: h.pausePath, logPath: h.logPath,
    monthPlanEventsPath: h.monthPlanEventsPath, syncFn,
    alertFn: async () => { throw new Error('telegram down'); },
    now: new Date('2026-08-12T00:00:00Z'),
  });
  assert.equal(result.paused, true);
  assert.match(fs.readFileSync(h.logPath, 'utf8'), /alert FAILED to send/);
});

console.log('All telegram-poll-loop tests passed.');
