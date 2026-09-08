// Covers scripts/transactions-store.mjs: the accumulating transaction ledger
// (upsert by Monarch id) that keeps CLOSED cycles queryable after
// budget_tracking.json has been rebuilt for the new one, plus the window
// resolution the Telegram bot's search_transactions uses to ask for "last
// month" without having to know the 25th-of-month cycle convention.
//
// Invented merchants only — never a live Monarch description (AGENTS.md §0).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  emptyLedger,
  loadLedger,
  upsertLedgerRows,
  queryLedger,
  ledgerCoverage,
  transactionId,
  resolveSearchWindow,
} from '../scripts/transactions-store.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transactions-store-test-'));
let seq = 0;
function tmpLedger() {
  seq += 1;
  return path.join(tmpRoot, `ledger-${seq}.json`);
}

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

console.log('test-transactions-store.mjs');

function row(overrides = {}) {
  return {
    id: 'txn-1',
    date: '2026-08-03',
    merchant: 'Test Bistro',
    amount: 84.25,
    accountLabel: 'FIXTURE JOINT (...0001)',
    category: 'Restaurants & Bars',
    tracker: 'joint',
    ownerId: null,
    type: 'spend',
    ...overrides,
  };
}

// --- Storage: accumulate, never drop ---

test('a stored row reads back with its fields intact', () => {
  const p = tmpLedger();
  upsertLedgerRows(p, [row()], { asOf: '2026-08-04' });
  const stored = loadLedger(p).byId['txn-1'];
  assert.equal(stored.merchant, 'Test Bistro');
  assert.equal(stored.amount, 84.25);
  assert.equal(stored.tracker, 'joint');
  assert.equal(stored.updatedAt, '2026-08-04');
});

test('re-upserting the same Monarch id corrects the row in place rather than duplicating it', () => {
  // Monarch re-categorizes and re-amounts a charge after it posts (a tip lands
  // days later). Merge-by-id records the correction; an append would count the
  // charge twice, which is the whole reason this is keyed by id.
  const p = tmpLedger();
  upsertLedgerRows(p, [row({ amount: 84.25, category: 'Uncategorized' })], { asOf: '2026-08-04' });
  upsertLedgerRows(p, [row({ amount: 99.5, category: 'Restaurants & Bars' })], { asOf: '2026-08-06' });
  const ledger = loadLedger(p);
  assert.equal(Object.keys(ledger.byId).length, 1, 'one charge is one row');
  assert.equal(ledger.byId['txn-1'].amount, 99.5);
  assert.equal(ledger.byId['txn-1'].category, 'Restaurants & Bars');
  assert.equal(ledger.meta.transactionCount, 1);
});

test('a row outside the new batch survives — this is what keeps a closed cycle queryable', () => {
  // The daily pull only ever fetches the CURRENT cycle. If an upsert dropped
  // ids it didn't see this run, last month's line items would vanish on the
  // 25th, which is exactly the gap this store exists to close.
  const p = tmpLedger();
  upsertLedgerRows(p, [row({ id: 'old', date: '2026-07-28', merchant: 'Fixture Grocers' })], { asOf: '2026-07-29' });
  upsertLedgerRows(p, [row({ id: 'new', date: '2026-08-30' })], { asOf: '2026-08-30' });
  const ledger = loadLedger(p);
  assert.equal(Object.keys(ledger.byId).length, 2);
  assert.equal(ledger.byId.old.merchant, 'Fixture Grocers');
});

test('a row with no usable id gets a stable synthesized one, so it still upserts', () => {
  const txn = { date: '2026-08-03', merchant: 'Test Bistro', amount: -84.25, account: 'FIXTURE JOINT (...0001)' };
  const first = transactionId(txn);
  assert.equal(first, transactionId({ ...txn }), 'same charge must synthesize the same id twice');
  assert.notEqual(first, transactionId({ ...txn, amount: -12 }), 'a different amount is a different charge');
  assert.equal(transactionId({ ...txn, id: '77' }), '77', 'a real Monarch id always wins');
});

test('a missing ledger file loads as empty rather than throwing', () => {
  const ledger = loadLedger(path.join(tmpRoot, 'no-such-ledger.json'));
  assert.deepEqual(ledger.byId, {});
  assert.equal(ledger.meta.transactionCount, emptyLedger().meta.transactionCount);
});

test('an unparseable ledger file degrades to empty rather than throwing', () => {
  const p = tmpLedger();
  fs.writeFileSync(p, '{ not json');
  assert.deepEqual(loadLedger(p).byId, {});
});

// --- Query ---

function seededLedger() {
  const p = tmpLedger();
  upsertLedgerRows(p, [
    row({ id: 'a', date: '2026-07-26', merchant: 'Test Bistro', amount: 84.25, category: 'Restaurants & Bars' }),
    row({ id: 'b', date: '2026-08-02', merchant: 'Fixture Grocers', amount: 210.1, category: 'Groceries' }),
    row({ id: 'c', date: '2026-08-20', merchant: 'test bistro annex', amount: 44, category: 'Restaurants & Bars' }),
    row({ id: 'd', date: '2026-08-28', merchant: 'Fixture Grocers', amount: 55, category: 'Groceries' }),
    row({ id: 'e', date: '2026-08-10', merchant: 'Sample Air', amount: 640, category: 'Travel & Vacation', tracker: 'travel' }),
    row({ id: 'f', date: '2026-08-11', merchant: 'Fixture Coffee', amount: 12, category: 'Coffee', tracker: 'personal', ownerId: 'kevin' }),
    row({ id: 'g', date: '2026-08-12', merchant: 'Fixture Grocers', amount: 30, category: 'Groceries', type: 'refund' }),
  ], { asOf: '2026-08-30' });
  return p;
}

test('merchant filter matches case-insensitively on a substring', () => {
  const { rows } = queryLedger(seededLedger(), { merchant: 'BISTRO' });
  assert.deepEqual(rows.map((r) => r.id), ['c', 'a'], 'both bistro rows, newest first');
});

test('rows come back newest first', () => {
  const { rows } = queryLedger(seededLedger(), { merchant: 'Fixture Grocers' });
  assert.deepEqual(rows.map((r) => r.date), ['2026-08-28', '2026-08-12', '2026-08-02']);
});

test('tracker "personal" matches an owner row and reports it as personal:<owner>', () => {
  const { rows } = queryLedger(seededLedger(), { tracker: 'personal' });
  assert.deepEqual(rows.map((r) => r.id), ['f']);
  assert.equal(rows[0].tracker, 'personal:kevin');
});

test('tracker "travel" excludes joint and personal rows', () => {
  const { rows } = queryLedger(seededLedger(), { tracker: 'travel' });
  assert.deepEqual(rows.map((r) => r.merchant), ['Sample Air']);
});

test('the date window is inclusive at both ends', () => {
  const { rows } = queryLedger(seededLedger(), { startDate: '2026-07-26', endDate: '2026-08-02' });
  assert.deepEqual(rows.map((r) => r.id).sort(), ['a', 'b'], 'both boundary days are in the window');
});

test('a row outside the window is left out', () => {
  const { rows } = queryLedger(seededLedger(), { startDate: '2026-08-25', endDate: '2026-08-31' });
  assert.deepEqual(rows.map((r) => r.id), ['d']);
});

test('spend and refund totals are reported separately, never netted silently', () => {
  const result = queryLedger(seededLedger(), { merchant: 'Fixture Grocers' });
  assert.equal(result.spendTotal, 265.1, '210.10 + 55.00');
  assert.equal(result.refundTotal, 30, 'the refund is reported on its own, not subtracted');
  assert.equal(result.matchCount, 3);
});

test('spend and refund rows are counted separately, so a reply can say "2 charges" honestly', () => {
  const result = queryLedger(seededLedger(), { merchant: 'Fixture Grocers' });
  assert.equal(result.spendCount, 2);
  assert.equal(result.refundCount, 1);
});

test('coverage reports how far back stored history actually goes', () => {
  // Without this a query over a window the ledger never covered would answer
  // "nothing found" — indistinguishable from "nothing was spent". The caller
  // needs to be able to say which one it is.
  const coverage = queryLedger(seededLedger(), { merchant: 'nothing-matches-this' }).coverage;
  assert.equal(coverage.earliest, '2026-07-26');
  assert.equal(coverage.latest, '2026-08-28');
  assert.equal(coverage.count, 7);
});

test('ledgerCoverage on an empty ledger reports no rows and no dates', () => {
  const coverage = ledgerCoverage(path.join(tmpRoot, 'no-such-ledger.json'));
  assert.equal(coverage.count, 0);
  assert.equal(coverage.earliest, null);
  assert.equal(coverage.latest, null);
});

test('a long result is capped and says so, while the totals still cover every match', () => {
  const result = queryLedger(seededLedger(), { limit: 2 });
  assert.equal(result.rows.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.matchCount, 7, 'the count reflects all matches, not just the shown ones');
});

// --- Window resolution (what "last month" means here) ---

const TODAY = new Date(2026, 8, 8); // 2026-09-08, inside the Aug 25 joint cycle

test('last_month on the joint tracker is the prior 25th-to-24th cycle', () => {
  const w = resolveSearchWindow({ period: 'last_month', tracker: 'joint', jointCycleStart: '2026-08-25', today: TODAY });
  assert.equal(w.startDate, '2026-07-25');
  assert.equal(w.endDate, '2026-08-24');
});

test('last_month with no tracker named follows the joint cycle convention', () => {
  const w = resolveSearchWindow({ period: 'last_month', jointCycleStart: '2026-08-25', today: TODAY });
  assert.equal(w.startDate, '2026-07-25');
  assert.equal(w.endDate, '2026-08-24');
});

test('last_month on a personal tracker is the prior calendar month, which is its own clock', () => {
  // Joint runs 25th-to-24th, personal runs calendar months. Answering a
  // personal question over the joint window would quietly report the wrong
  // three weeks.
  const w = resolveSearchWindow({ period: 'last_month', tracker: 'personal', jointCycleStart: '2026-08-25', today: TODAY });
  assert.equal(w.startDate, '2026-08-01');
  assert.equal(w.endDate, '2026-08-31');
});

test('the window carries a human label naming the real dates it searched', () => {
  const w = resolveSearchWindow({ period: 'last_month', tracker: 'joint', jointCycleStart: '2026-08-25', today: TODAY });
  assert.match(w.label, /Jul 25/);
  assert.match(w.label, /Aug 24/);
});

test('last_3_months reaches back three joint cycles and runs to today', () => {
  const w = resolveSearchWindow({ period: 'last_3_months', jointCycleStart: '2026-08-25', today: TODAY });
  assert.equal(w.startDate, '2026-06-25');
  assert.equal(w.endDate, '2026-09-08');
});

test('explicit since/until wins over the named period', () => {
  const w = resolveSearchWindow({ period: 'last_month', since: '2026-05-01', until: '2026-05-31', today: TODAY });
  assert.equal(w.startDate, '2026-05-01');
  assert.equal(w.endDate, '2026-05-31');
});

test('a lone since runs to today', () => {
  const w = resolveSearchWindow({ since: '2026-05-01', today: TODAY });
  assert.equal(w.startDate, '2026-05-01');
  assert.equal(w.endDate, '2026-09-08');
});

test('"all" searches everything stored, with no bounds', () => {
  const w = resolveSearchWindow({ period: 'all', today: TODAY });
  assert.equal(w.startDate, null);
  assert.equal(w.endDate, null);
});

test('current is the live cycle, and is flagged as such so the caller keeps using the live tracker', () => {
  const w = resolveSearchWindow({ period: 'current', jointCycleStart: '2026-08-25', today: TODAY });
  assert.equal(w.isCurrent, true);
});

test('no period and no dates means current — the historical path is strictly opt-in', () => {
  assert.equal(resolveSearchWindow({ today: TODAY }).isCurrent, true);
});

test('a joint cycle start can be derived from today when budget_tracking has not been read', () => {
  // Same 25th convention as the pull; a bot restart before the first pull of
  // the day should not lose the ability to answer "last month".
  const w = resolveSearchWindow({ period: 'last_month', tracker: 'joint', today: new Date(2026, 8, 8) });
  assert.equal(w.startDate, '2026-07-25');
  assert.equal(w.endDate, '2026-08-24');
});

test('before the 25th, the current cycle is still the previous month\'s 25th', () => {
  const w = resolveSearchWindow({ period: 'last_month', tracker: 'joint', today: new Date(2026, 8, 3) });
  assert.equal(w.startDate, '2026-07-25', 'Sep 3 sits in the Aug 25 cycle, so last month is Jul 25');
  assert.equal(w.endDate, '2026-08-24');
});

console.log('All tests passed.');
