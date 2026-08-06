// Permanent regression tests for scripts/transactions-store.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadOrCreateOverrides,
  resolveCategory,
  resolveReassignment,
  upsertLedgerRows,
  queryLedger,
  transactionId,
} from '../scripts/transactions-store.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'transactions-store-test-'));

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

console.log('test-transactions-store.mjs');

test('resolveCategory applies standing merchant rules before Monarch category', () => {
  const overrides = {
    categoryRules: [{ merchantMatch: 'anthropic', category: 'Subscriptions' }],
    reassignments: [],
  };
  assert.equal(
    resolveCategory({ merchant: 'Anthropic Claude', category: 'Shopping' }, overrides),
    'Subscriptions',
  );
  assert.equal(
    resolveCategory({ merchant: 'Target', category: 'Shopping' }, overrides),
    'Shopping',
  );
});

test('resolveReassignment matches merchant substring + exact date only', () => {
  const overrides = {
    categoryRules: [],
    reassignments: [{ merchantMatch: 'sora', date: '2026-08-01', reassignTo: 'joint' }],
  };
  assert.equal(resolveReassignment({ merchant: 'Sora Sushi', date: '2026-08-01' }, overrides).reassignTo, 'joint');
  assert.equal(resolveReassignment({ merchant: 'Sora Sushi', date: '2026-08-02' }, overrides), null);
});

test('upsertLedgerRows accumulates by id and does not drop older ids', () => {
  const ledgerPath = path.join(tmpRoot, 'ledger.json');
  upsertLedgerRows(ledgerPath, [
    { id: 'a', date: '2026-06-01', merchant: 'Old', amount: 10, tracker: 'joint', group: 'Shopping', type: 'spend' },
  ], { asOf: '2026-06-01' });
  upsertLedgerRows(ledgerPath, [
    { id: 'b', date: '2026-08-01', merchant: 'New', amount: 20, tracker: 'joint', group: 'Shopping', type: 'spend' },
    { id: 'a', date: '2026-06-01', merchant: 'Old', amount: 11, tracker: 'joint', group: 'Shopping', type: 'spend' },
  ], { asOf: '2026-08-01' });
  const { rows } = queryLedger(ledgerPath, { defaultLookbackDays: null });
  assert.equal(rows.length, 2);
  assert.equal(rows.find((r) => r.id === 'a').amount, 11);
  assert.equal(rows.find((r) => r.id === 'b').amount, 20);
});

test('queryLedger filters by merchant and date window', () => {
  const ledgerPath = path.join(tmpRoot, 'ledger-query.json');
  upsertLedgerRows(ledgerPath, [
    { id: '1', date: '2026-07-01', merchant: 'Geico', amount: 100, tracker: 'joint', group: 'Insurance', type: 'spend' },
    { id: '2', date: '2026-08-01', merchant: 'Geico', amount: 100, tracker: 'joint', group: 'Insurance', type: 'spend' },
    { id: '3', date: '2026-08-01', merchant: 'Target', amount: 50, tracker: 'joint', group: 'Shopping', type: 'spend' },
  ], { asOf: '2026-08-01' });
  const { rows } = queryLedger(ledgerPath, {
    merchant: 'Geico',
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    defaultLookbackDays: null,
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, '2');
});

test('loadOrCreateOverrides seeds from example when missing', () => {
  const overridesPath = path.join(tmpRoot, 'overrides.json');
  const examplePath = path.join(tmpRoot, 'overrides.example.json');
  fs.writeFileSync(examplePath, JSON.stringify({
    meta: {},
    categoryRules: [{ merchantMatch: 'x', category: 'Y' }],
    reassignments: [],
  }));
  const loaded = loadOrCreateOverrides(overridesPath, examplePath);
  assert.equal(loaded.categoryRules[0].category, 'Y');
  assert.ok(fs.existsSync(overridesPath));
});

test('transactionId prefers Monarch id', () => {
  assert.equal(transactionId({ id: 'abc', date: '2026-01-01', amount: -1 }), 'abc');
  assert.ok(transactionId({ date: '2026-01-01', merchant: 'X', amount: -5, account: 'Card' }).startsWith('syn_'));
});

console.log('All transactions-store tests passed.');
