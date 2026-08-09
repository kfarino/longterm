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

await asyncTest('runCalendarSyncStep pauses after invalid_grant and stays quiet on later calls', async () => {
  const dir = tmpDir();
  const envPath = path.join(dir, 'google-calendar.env');
  const pausePath = path.join(dir, 'auth-pause.json');
  const logPath = path.join(dir, 'poll.log');
  fs.writeFileSync(envPath, 'GOOGLE_CLIENT_ID=x\n');
  let calls = 0;
  const syncFn = async () => {
    calls += 1;
    throw new Error('Google token refresh failed: 400 { "error": "invalid_grant", "error_description": "Token has been expired or revoked." }');
  };

  const first = await runCalendarSyncStep({ envPath, authPausePath: pausePath, logPath, syncFn });
  assert.equal(first.paused, true);
  assert.equal(calls, 1);
  assert.ok(fs.existsSync(pausePath));
  const log1 = fs.readFileSync(logPath, 'utf8');
  assert.match(log1, /PAUSED \(auth\)/);

  const second = await runCalendarSyncStep({ envPath, authPausePath: pausePath, logPath, syncFn });
  assert.equal(second.paused, true);
  assert.equal(calls, 1, 'must not retry Google while the pause file exists');
  const log2 = fs.readFileSync(logPath, 'utf8');
  assert.equal((log2.match(/PAUSED \(auth\)/g) || []).length, 1, 'must not re-log the pause on every poll iteration');
});

console.log('All telegram-poll-loop tests passed.');
