// Covers scripts/cycle-history.mjs: joint cycle snapshots, habit heads-up,
// leftover-days-unrelated (that's financial-context), close-out text + dedup.
// Invented categories only — never live merchants.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  snapshotFromJointTracker,
  archiveClosedCycle,
  maybeArchiveOnRollover,
  deriveJointHabits,
  habitHeadsUp,
  thisCycleWatchCategory,
  closeOutText,
  markCloseOutSent,
  newestUnsentCloseOut,
  previousJointCycleStarts,
  cycleDaysBetween,
  buildSnapshotFromCharges,
  loadCycleHistory,
  saveCycleHistory,
  deliverCloseOuts,
} from '../scripts/cycle-history.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-history-test-'));

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

async function asyncTest(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

console.log('test-cycle-history.mjs');

const sampleTracker = {
  cycleStart: '2026-07-25',
  cycleDays: 30,
  weeks: [
    { weekOf: 'Jul 25–31', actual: 800, days: 7 },
    { weekOf: 'Aug 1–7', actual: 700, days: 7 },
    { weekOf: 'Aug 8–14', actual: 600, days: 7 },
    { weekOf: 'Aug 15–21', actual: 900, days: 7 },
  ],
  categories: [
    { name: 'Test Dining', amount: 1500, transactions: [{ merchant: 'Test Bistro', amount: 80 }] },
    { name: 'Test Groceries', amount: 1500 },
  ],
};

test('snapshotFromJointTracker drops merchant line items and sums weeks', () => {
  const snap = snapshotFromJointTracker(sampleTracker, { target: 5500, closedAt: '2026-08-25T12:00:00.000Z' });
  assert.equal(snap.cycleStart, '2026-07-25');
  assert.equal(snap.total, 3000);
  assert.equal(snap.target, 5500);
  assert.deepEqual(snap.categories.map((c) => c.name), ['Test Dining', 'Test Groceries']);
  assert.ok(!('transactions' in snap.categories[0]), 'history must not store merchants');
  assert.equal(snap.closeOutSent, false);
});

test('maybeArchiveOnRollover archives when cycleStart moved, and upserts on retry', () => {
  const tracking = { joint: sampleTracker };
  let { history, archived } = maybeArchiveOnRollover({}, tracking, '2026-08-25', { target: 5500, closedAt: '2026-08-25T12:00:00.000Z' });
  assert.ok(archived);
  assert.equal(history.joint.cycles.length, 1);
  const again = maybeArchiveOnRollover(history, tracking, '2026-08-25', { target: 5500, closedAt: '2026-08-25T13:00:00.000Z' });
  assert.equal(again.history.joint.cycles.length, 1, 'same cycleStart must not duplicate');
  const marked = markCloseOutSent(again.history, '2026-07-25');
  const afterSent = maybeArchiveOnRollover(marked, tracking, '2026-08-25', { target: 5500, closedAt: '2026-08-25T14:00:00.000Z' });
  assert.equal(afterSent.history.joint.cycles[0].closeOutSent, true, 're-archive must not unsend a delivered close-out');
  const sameCycle = maybeArchiveOnRollover(history, tracking, '2026-07-25', { target: 5500 });
  assert.equal(sameCycle.archived, null, 'still on the same cycle — nothing to archive');
});

test('deriveJointHabits flags a last-week spike and names the hottest category', () => {
  const snap = snapshotFromJointTracker(sampleTracker, { target: 5500 });
  const habits = deriveJointHabits([snap]);
  assert.equal(habits.sampleSize, 1);
  assert.equal(habits.lastWeekSpike, true, '900/3000 = 30% and 4 weeks');
  assert.equal(habits.lastWeekCategory, 'Test Dining');
  assert.match(habitHeadsUp(habits), /Test Dining/);
});

test('habitHeadsUp is silent when the sample is empty', () => {
  assert.equal(habitHeadsUp(deriveJointHabits([])), null);
  assert.equal(habitHeadsUp(deriveJointHabits([{ total: 100, weeks: [{ actual: 100, days: 7 }], categories: [{ name: 'Test Groceries', amount: 100 }] }])), null, 'a one-week cycle is not a last-week spike');
});

test('thisCycleWatchCategory picks the category running above its usual share', () => {
  const closed = snapshotFromJointTracker({
    cycleStart: '2026-06-25',
    weeks: [{ actual: 400, days: 7 }, { actual: 400, days: 7 }, { actual: 200, days: 7 }],
    categories: [{ name: 'Test Groceries', amount: 800 }, { name: 'Test Dining', amount: 200 }],
  }, { target: 5500 });
  const habits = deriveJointHabits([closed]);
  const watch = thisCycleWatchCategory(
    [{ name: 'Test Dining', amount: 400 }, { name: 'Test Groceries', amount: 100 }],
    500,
    habits,
  );
  assert.equal(watch, 'Test Dining');
});

test('closeOutText names target miss/hit and the hot category without merchants', () => {
  const snap = snapshotFromJointTracker(sampleTracker, { target: 5500 });
  const text = closeOutText(snap, deriveJointHabits([snap]));
  assert.match(text, /Jul 25/);
  assert.match(text, /\$3,000/);
  assert.match(text, /\$5,500/);
  assert.match(text, /Test Dining/);
  assert.doesNotMatch(text, /Test Bistro/);
});

test('newestUnsentCloseOut skips already-sent cycles; markCloseOutSent sticks', () => {
  let history = archiveClosedCycle({}, snapshotFromJointTracker(sampleTracker, { target: 5500 }));
  assert.equal(newestUnsentCloseOut(history).cycleStart, '2026-07-25');
  history = markCloseOutSent(history, '2026-07-25');
  assert.equal(newestUnsentCloseOut(history), null);
});

await asyncTest('deliverCloseOuts sends once; a failed send leaves the cycle unsent', async () => {
  const historyPath = path.join(tmpRoot, 'cycle_history.json');
  let history = archiveClosedCycle({}, snapshotFromJointTracker(sampleTracker, { target: 5500 }));
  saveCycleHistory(historyPath, history);
  const sent = [];
  await deliverCloseOuts(historyPath, { notifyFn: async (text) => { sent.push(text); } });
  assert.equal(sent.length, 1);
  assert.equal(loadCycleHistory(historyPath).joint.cycles[0].closeOutSent, true);

  sent.length = 0;
  await deliverCloseOuts(historyPath, { notifyFn: async () => { sent.push('again'); } });
  assert.equal(sent.length, 0, 'already sent — no second close-out');

  const failPath = path.join(tmpRoot, 'cycle_history_fail.json');
  saveCycleHistory(failPath, archiveClosedCycle({}, snapshotFromJointTracker({
    ...sampleTracker, cycleStart: '2026-06-25',
  }, { target: 5500 })));
  await deliverCloseOuts(failPath, { notifyFn: async () => { throw new Error('telegram down'); } });
  assert.equal(loadCycleHistory(failPath).joint.cycles[0].closeOutSent, false, 'failed send must retry later');
});

test('previousJointCycleStarts walks 25ths backward; cycleDaysBetween is the real span', () => {
  assert.deepEqual(previousJointCycleStarts('2026-08-25', 3), ['2026-07-25', '2026-06-25', '2026-05-25']);
  assert.equal(cycleDaysBetween('2026-07-25', '2026-08-25'), 31);
});

test('buildSnapshotFromCharges buckets joint charges into weeks and categories', () => {
  const snap = buildSnapshotFromCharges({
    cycleStart: '2026-07-25',
    cycleDays: 31,
    target: 5500,
    charges: [
      { date: '2026-07-26', category: 'Test Groceries', amount: 40 },
      { date: '2026-08-16', category: 'Test Dining', amount: 80 },
    ],
  });
  assert.equal(snap.total, 120);
  assert.equal(snap.categories[0].name, 'Test Dining');
  assert.ok(snap.weeks.length >= 4);
  assert.equal(snap.weeks[0].actual, 40);
});

test('loadCycleHistory degrades to empty on a missing file', () => {
  const empty = loadCycleHistory(path.join(tmpRoot, 'no-such.json'));
  assert.deepEqual(empty.joint.cycles, []);
});

console.log('All cycle-history tests passed.');
