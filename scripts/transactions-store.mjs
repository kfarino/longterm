// Durable transaction overrides + accumulating Monarch ledger (JSON).
// Used by budget-tracking-pull.mjs and financial-context / Telegram search.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LEDGER_OVERLAP_DAYS = 120;
export const SEARCH_DEFAULT_LOOKBACK_DAYS = 90;

export function defaultOverridesPath() {
  return path.join(repoRoot, 'data', 'transaction_overrides.json');
}

export function defaultLedgerPath() {
  return path.join(repoRoot, 'data', 'transactions_ledger.json');
}

export function defaultOverridesExamplePath() {
  return path.join(repoRoot, 'examples', 'transaction_overrides.example.json');
}

function writeJson(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

export function emptyOverrides() {
  return {
    meta: {
      description: 'Durable spend routing overrides — see examples/transaction_overrides.example.json',
      lastUpdated: null,
    },
    categoryRules: [],
    reassignments: [],
  };
}

export function emptyLedger() {
  return {
    meta: {
      description: 'Accumulating Monarch transactions (upsert by id). Never hand-edit; refreshed by budget-tracking-pull.mjs.',
      lastUpdated: null,
      transactionCount: 0,
    },
    byId: {},
  };
}

/** Seed data/transaction_overrides.json from the example if missing. */
export function loadOrCreateOverrides(overridesPath = defaultOverridesPath(), examplePath = defaultOverridesExamplePath()) {
  if (!fs.existsSync(overridesPath)) {
    fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, overridesPath);
    } else {
      writeJson(overridesPath, emptyOverrides());
    }
  }
  return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
}

export function loadLedger(ledgerPath = defaultLedgerPath()) {
  if (!fs.existsSync(ledgerPath)) return emptyLedger();
  try {
    return JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
  } catch {
    return emptyLedger();
  }
}

export function transactionId(txn) {
  if (txn?.id != null && String(txn.id).trim() !== '') return String(txn.id);
  const date = txn?.date || '';
  const merchant = (txn?.merchant || txn?.plaidName || '').toLowerCase();
  const amount = txn?.amount;
  const account = typeof txn?.account === 'string'
    ? txn.account
    : (txn?.account?.displayName || txn?.account?.name || '');
  return `syn_${date}|${merchant}|${amount}|${account}`;
}

export function merchantText(txn) {
  return (txn?.merchant || txn?.plaidName || '').toLowerCase();
}

/** Standing category rules from overrides file; falls back to Monarch category. */
export function resolveCategory(txn, overrides) {
  const merchant = merchantText(txn);
  for (const rule of overrides?.categoryRules || []) {
    const match = (rule.merchantMatch || '').toLowerCase();
    if (match && merchant.includes(match)) return rule.category;
  }
  if (typeof txn.category === 'string') return txn.category;
  return txn.category?.name || '';
}

/**
 * One-off tracker reassignment: merchant substring + exact date.
 * reassignTo: "joint" | ownerId (personal) | "travel" (rare).
 */
export function resolveReassignment(txn, overrides) {
  const merchant = merchantText(txn);
  const date = txn?.date;
  if (!date) return null;
  return (overrides?.reassignments || []).find(
    (r) => merchant.includes((r.merchantMatch || '').toLowerCase()) && r.date === date,
  ) || null;
}

/**
 * Upsert normalized rows into the ledger. Does not delete ids outside this batch.
 * @param {object[]} rows — already-normalized ledger rows with `id`
 */
export function upsertLedgerRows(ledgerPath, rows, { asOf = null } = {}) {
  const ledger = loadLedger(ledgerPath);
  if (!ledger.byId) ledger.byId = {};
  const now = asOf || new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    if (!row?.id) continue;
    ledger.byId[row.id] = { ...ledger.byId[row.id], ...row, updatedAt: now };
  }
  ledger.meta = ledger.meta || {};
  ledger.meta.lastUpdated = now;
  ledger.meta.transactionCount = Object.keys(ledger.byId).length;
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  writeJson(ledgerPath, ledger);
  return ledger;
}

/**
 * @param {object} opts
 * @param {string} [opts.merchant] substring
 * @param {string} [opts.tracker] joint | personal | travel
 * @param {string} [opts.startDate] YYYY-MM-DD inclusive
 * @param {string} [opts.endDate] YYYY-MM-DD inclusive
 * @param {number} [opts.defaultLookbackDays] used when both dates omitted
 */
export function queryLedger(ledgerPath, {
  merchant = null,
  tracker = null,
  startDate = null,
  endDate = null,
  defaultLookbackDays = SEARCH_DEFAULT_LOOKBACK_DAYS,
} = {}) {
  const ledger = loadLedger(ledgerPath);
  let rows = Object.values(ledger.byId || {});

  let effectiveStart = startDate;
  let effectiveEnd = endDate;
  if (!effectiveStart && !effectiveEnd && defaultLookbackDays != null) {
    const end = new Date();
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - (defaultLookbackDays - 1));
    effectiveStart = start.toISOString().slice(0, 10);
    effectiveEnd = end.toISOString().slice(0, 10);
  }

  if (effectiveStart) rows = rows.filter((r) => r.date >= effectiveStart);
  if (effectiveEnd) rows = rows.filter((r) => r.date <= effectiveEnd);
  if (merchant && merchant.trim()) {
    const needle = merchant.trim().toLowerCase();
    rows = rows.filter((r) => r.merchant && r.merchant.toLowerCase().includes(needle));
  }
  if (tracker) {
    rows = rows.filter((r) => (
      tracker === 'personal' ? r.tracker === 'personal' || String(r.tracker || '').startsWith('personal:')
        : r.tracker === tracker
    ));
  }

  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return {
    rows: rows.map((r) => ({
      tracker: r.ownerId ? `personal:${r.ownerId}` : r.tracker,
      group: r.group || r.category || '',
      date: r.date,
      merchant: r.merchant,
      amount: r.amount,
      type: r.type || 'spend',
      id: r.id,
    })),
    window: { startDate: effectiveStart, endDate: effectiveEnd },
    source: 'ledger',
  };
}

export function ledgerHasRows(ledgerPath = defaultLedgerPath()) {
  const ledger = loadLedger(ledgerPath);
  return Object.keys(ledger.byId || {}).length > 0;
}

/** Re-route matching ledger rows after a one-off reassignment is saved. */
export function applyReassignmentToLedger(ledgerPath, { merchantMatch, date, reassignTo }) {
  const ledger = loadLedger(ledgerPath);
  if (!ledger.byId) return 0;
  const needle = (merchantMatch || '').toLowerCase();
  let n = 0;
  for (const row of Object.values(ledger.byId)) {
    if (row.date !== date) continue;
    if (!(row.merchant || '').toLowerCase().includes(needle)) continue;
    if (reassignTo === 'joint') {
      row.tracker = 'joint';
      row.ownerId = null;
    } else if (reassignTo === 'travel') {
      row.tracker = 'travel';
      row.ownerId = null;
    } else {
      row.tracker = 'personal';
      row.ownerId = reassignTo;
    }
    n += 1;
  }
  if (n) {
    ledger.meta.transactionCount = Object.keys(ledger.byId).length;
    writeJson(ledgerPath, ledger);
  }
  return n;
}

/** Re-label matching ledger rows after a standing category rule is saved. */
export function applyCategoryRuleToLedger(ledgerPath, { merchantMatch, category }) {
  const ledger = loadLedger(ledgerPath);
  if (!ledger.byId) return 0;
  const needle = (merchantMatch || '').toLowerCase();
  let n = 0;
  for (const row of Object.values(ledger.byId)) {
    if (!(row.merchant || '').toLowerCase().includes(needle)) continue;
    row.category = category;
    row.group = category;
    n += 1;
  }
  if (n) {
    ledger.meta.transactionCount = Object.keys(ledger.byId).length;
    writeJson(ledgerPath, ledger);
  }
  return n;
}
