// Longterm/data/test-decisions.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// scripts/decisions.mjs — the one shared answer to "is this decision still
// open?" — plus financial-context.mjs's loadDecisions, which is what the
// Telegram bot's get_decisions and the Sun/Thu recap both read.
//
// Why this suite exists: a decision that had actually been settled (a refund
// that already posted) kept being cited by the weekly recap as still pending,
// because nothing could ever close a decision out — log_decision only ever
// appended. Closing one out has to make it disappear from every "open
// decisions" surface, not just one of them.
//
// Invented titles only — never a real household decision.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isResolvedDecision, openDecisions, matchDecisionsByTitle, RESOLVED_STATUSES } from '../scripts/decisions.mjs';
import { loadDecisions } from '../scripts/financial-context.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'decisions-test-'));

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

console.log('test-decisions.mjs');

const sampleDecisions = () => [
  { status: 'urgent', title: 'Test urgent decision', body: 'body', action: 'Do it' },
  { status: 'active', title: 'Expected Test Airline refund — test trip', body: 'body', action: 'Watch for the credit' },
  { status: 'watch', title: 'Test watch decision', body: 'body', action: 'Keep an eye on it' },
];

test('isResolvedDecision: resolved and closed both count, any casing; open statuses do not', () => {
  assert.equal(isResolvedDecision({ status: 'resolved' }), true);
  assert.equal(isResolvedDecision({ status: 'closed' }), true);
  assert.equal(isResolvedDecision({ status: 'Resolved' }), true);
  assert.equal(isResolvedDecision({ status: 'active' }), false);
  assert.equal(isResolvedDecision({ status: 'urgent' }), false);
  assert.equal(isResolvedDecision({ status: 'watch' }), false);
  assert.equal(isResolvedDecision({ status: 'good' }), false);
  // A decision with no status at all is open, not silently swallowed.
  assert.equal(isResolvedDecision({ title: 'No status' }), false);
  assert.equal(isResolvedDecision(null), false);
  assert.ok(RESOLVED_STATUSES.has('resolved') && RESOLVED_STATUSES.has('closed'));
});

test('openDecisions: drops resolved entries, preserves order of the rest', () => {
  const list = sampleDecisions();
  list[1] = { ...list[1], status: 'resolved', resolvedOn: '2026-08-30' };
  const open = openDecisions(list);
  assert.equal(open.length, 2);
  assert.deepEqual(open.map((d) => d.title), ['Test urgent decision', 'Test watch decision']);
});

test('openDecisions: tolerates a missing/undefined list rather than throwing', () => {
  assert.deepEqual(openDecisions(undefined), []);
  assert.deepEqual(openDecisions(null), []);
});

test('matchDecisionsByTitle: case-insensitive substring match, resolved entries included', () => {
  const list = sampleDecisions();
  list[1] = { ...list[1], status: 'resolved' };
  const matches = matchDecisionsByTitle(list, 'test airline refund');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].decision.title, 'Expected Test Airline refund — test trip');
  assert.equal(matches[0].index, 1, 'the index into the original array, so a caller can mutate in place');
});

test('matchDecisionsByTitle: an ambiguous needle returns every candidate rather than picking one', () => {
  const matches = matchDecisionsByTitle(sampleDecisions(), 'test');
  assert.equal(matches.length, 3);
});

test('matchDecisionsByTitle: no match returns an empty array', () => {
  assert.deepEqual(matchDecisionsByTitle(sampleDecisions(), 'nothing like this'), []);
});

// --- loadDecisions: the shared read the bot and the recap both go through ---

function writeGoals(name, decisions) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(dir, { recursive: true });
  const goalsPath = path.join(dir, 'goals.json');
  fs.writeFileSync(goalsPath, JSON.stringify({ decisions }, null, 2));
  return goalsPath;
}

test('loadDecisions: a resolved decision never reaches the bot or the recap', () => {
  const list = sampleDecisions();
  list[1] = { ...list[1], status: 'resolved', resolvedOn: '2026-08-30' };
  const goalsPath = writeGoals('load-resolved', list);
  const loaded = loadDecisions(goalsPath);
  assert.equal(loaded.length, 2);
  assert.ok(!loaded.some((d) => /refund/i.test(d.title)), 'the settled refund must not surface as an open decision');
});

test('loadDecisions: an all-open list comes through unchanged', () => {
  const goalsPath = writeGoals('load-open', sampleDecisions());
  assert.equal(loadDecisions(goalsPath).length, 3);
});

test('loadDecisions: goals.json with no decisions array degrades to empty', () => {
  const dir = path.join(tmpRoot, 'load-none');
  fs.mkdirSync(dir, { recursive: true });
  const goalsPath = path.join(dir, 'goals.json');
  fs.writeFileSync(goalsPath, JSON.stringify({ phases: [] }, null, 2));
  assert.deepEqual(loadDecisions(goalsPath), []);
});

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('test-decisions.mjs: all passed');
