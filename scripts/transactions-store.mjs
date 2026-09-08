// Accumulating transaction ledger — the durable history behind the Telegram
// bot's search_transactions.
//
// budget_tracking.json is a *view*: fully rebuilt on every pull for the current
// joint cycle / personal month / live trips. On the 25th it stops describing
// last month entirely, and cycle_history.json deliberately keeps name+amount
// category totals only (no merchants), so "what did we spend at X last month"
// had no data to answer from at all once a cycle rolled over.
//
// This file is that data: one row per Monarch transaction, upserted by Monarch
// id and never dropped when it falls outside a later fetch window. Upsert
// matters beyond surviving pulls — Monarch re-categorizes and re-amounts a
// charge after it posts (a tip that lands days later), so merge-by-id records
// the correction where an append would double-count it. Same contract, and the
// same reasoning, as scripts/oura-store.mjs.
//
// Written by budget-tracking-pull.mjs, read by financial-context.mjs /
// telegram-bot-tools.mjs. Gitignored (AGENTS.md §0) — it holds real merchant
// line items.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { previousJointCycleStarts } from './cycle-history.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LEDGER_PATH = path.join(here, '..', 'data', 'transactions_ledger.json');

// A Telegram reply is a chat message, not a report. Past this many line items
// the reply reports the count and the totals instead of scrolling forever.
export const DEFAULT_ROW_LIMIT = 40;

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

export function loadLedger(filePath = DEFAULT_LEDGER_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data || typeof data.byId !== 'object' || data.byId === null) return emptyLedger();
    return { meta: data.meta || emptyLedger().meta, byId: data.byId };
  } catch {
    // Missing or unparseable degrades to empty, the same "answer emptier
    // rather than crash" convention the other context loaders use.
    return emptyLedger();
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

/**
 * Monarch's own id when there is one. Otherwise a deterministic synthetic id
 * from the fields that identify the charge, so a row without an id still
 * merges with itself on the next pull instead of accumulating a copy a day.
 */
export function transactionId(txn) {
  if (txn?.id != null && String(txn.id).trim() !== '') return String(txn.id);
  const account = typeof txn?.account === 'string'
    ? txn.account
    : (txn?.account?.displayName || txn?.account?.name || txn?.accountLabel || '');
  const merchant = String(txn?.merchant || txn?.plaidName || '').toLowerCase();
  return `syn_${txn?.date || ''}|${merchant}|${txn?.amount}|${account}`;
}

/**
 * Merge rows into the ledger. Ids absent from `rows` are left exactly as they
 * are — that is what keeps a closed cycle queryable after the live tracker has
 * moved on.
 */
export function upsertLedgerRows(filePath, rows, { asOf = null } = {}) {
  const ledger = loadLedger(filePath);
  const stamp = asOf || new Date().toISOString().slice(0, 10);
  for (const row of rows || []) {
    const id = row?.id ? String(row.id) : transactionId(row);
    if (!id) continue;
    ledger.byId[id] = { ...ledger.byId[id], ...row, id, updatedAt: stamp };
  }
  ledger.meta.lastUpdated = stamp;
  ledger.meta.transactionCount = Object.keys(ledger.byId).length;
  writeJson(filePath, ledger);
  return ledger;
}

function allRows(ledgerOrPath) {
  const ledger = typeof ledgerOrPath === 'string' ? loadLedger(ledgerOrPath) : (ledgerOrPath || emptyLedger());
  return Object.values(ledger.byId || {});
}

/**
 * How far back stored history actually reaches. A caller needs this to tell
 * "nothing was spent then" apart from "nothing was recorded then" — the second
 * one is the honest answer for any window older than the first pull.
 */
export function ledgerCoverage(ledgerOrPath) {
  const rows = allRows(ledgerOrPath);
  const dates = rows.map((r) => r.date).filter(Boolean).sort();
  return {
    count: rows.length,
    earliest: dates.length ? dates[0] : null,
    latest: dates.length ? dates[dates.length - 1] : null,
  };
}

/**
 * @param {string|object} ledgerOrPath
 * @param {object} opts
 * @param {string} [opts.merchant] case-insensitive substring
 * @param {string} [opts.tracker] joint | personal | travel
 * @param {string} [opts.startDate] YYYY-MM-DD, inclusive
 * @param {string} [opts.endDate] YYYY-MM-DD, inclusive
 * @param {number} [opts.limit] rows returned (totals always cover every match)
 */
export function queryLedger(ledgerOrPath, {
  merchant = null,
  tracker = null,
  startDate = null,
  endDate = null,
  limit = DEFAULT_ROW_LIMIT,
} = {}) {
  const ledger = typeof ledgerOrPath === 'string' ? loadLedger(ledgerOrPath) : (ledgerOrPath || emptyLedger());
  let rows = allRows(ledger);

  if (startDate) rows = rows.filter((r) => r.date && r.date >= startDate);
  if (endDate) rows = rows.filter((r) => r.date && r.date <= endDate);
  if (merchant && String(merchant).trim()) {
    const needle = String(merchant).trim().toLowerCase();
    rows = rows.filter((r) => r.merchant && r.merchant.toLowerCase().includes(needle));
  }
  if (tracker) {
    rows = rows.filter((r) => (tracker === 'personal'
      ? r.tracker === 'personal' || String(r.tracker || '').startsWith('personal:')
      : r.tracker === tracker));
  }

  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : String(a.id).localeCompare(String(b.id))));

  // Refunds and credits are stored as positive amounts, same as spend rows, so
  // they are summed separately rather than quietly netted off the total —
  // see AGENTS.md §2 "refunds vs payments".
  let spendTotal = 0;
  let refundTotal = 0;
  let spendCount = 0;
  let refundCount = 0;
  for (const r of rows) {
    const amount = Math.abs(Number(r.amount) || 0);
    if (r.type === 'refund' || r.type === 'credit') { refundTotal += amount; refundCount += 1; } else { spendTotal += amount; spendCount += 1; }
  }

  const shown = limit == null ? rows : rows.slice(0, limit);
  return {
    rows: shown.map((r) => ({
      id: r.id,
      tracker: r.ownerId ? `personal:${r.ownerId}` : r.tracker,
      group: r.group || r.category || 'Uncategorized',
      date: r.date,
      merchant: r.merchant,
      amount: Math.abs(Number(r.amount) || 0),
      type: r.type || 'spend',
    })),
    matchCount: rows.length,
    spendCount,
    refundCount,
    truncated: shown.length < rows.length,
    spendTotal: Math.round(spendTotal * 100) / 100,
    refundTotal: Math.round(refundTotal * 100) / 100,
    coverage: ledgerCoverage(ledger),
  };
}

function isoDateLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseLocal(iso) {
  return new Date(`${iso}T12:00:00`);
}

function shiftDays(iso, days) {
  const d = parseLocal(iso);
  d.setDate(d.getDate() + days);
  return isoDateLocal(d);
}

function formatShort(iso) {
  return parseLocal(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// Same Barclays 25th-of-month convention budget-tracking-pull.mjs uses for the
// live cycle. Only reached when the caller has no budget_tracking.json cycle
// start to hand over (a fresh checkout, or a bot answering before the first
// pull) — the real cycleStart always wins when it exists.
function jointCycleStartFor(today) {
  const start = new Date(today.getFullYear(), today.getMonth(), 25);
  if (today.getDate() < 25) start.setMonth(start.getMonth() - 1);
  return isoDateLocal(start);
}

/**
 * Turn what someone asked for ("last month", or explicit dates) into a real
 * window, honoring the fact that joint and personal run on different clocks:
 * joint on 25th-to-24th statement cycles, personal on calendar months. The
 * returned `label` names the actual dates so a reply can state which window it
 * searched rather than leaving the convention implicit.
 *
 * `isCurrent` means "the live window" — the caller should keep reading
 * budget_tracking.json for that one, since it carries manual cash charges the
 * Monarch ledger has never seen.
 */
export function resolveSearchWindow({
  period = null,
  since = null,
  until = null,
  tracker = null,
  jointCycleStart = null,
  today = new Date(),
} = {}) {
  const todayIso = isoDateLocal(today);

  if (since || until) {
    const startDate = since || null;
    const endDate = until || todayIso;
    return { startDate, endDate, isCurrent: false, label: windowLabel(startDate, endDate) };
  }

  const cycleStart = jointCycleStart || jointCycleStartFor(today);

  if (period === 'all') {
    return { startDate: null, endDate: null, isCurrent: false, label: 'all stored history' };
  }

  if (period === 'last_month') {
    if (tracker === 'personal') {
      const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 86400000);
      const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
      const startDate = isoDateLocal(firstOfPrevMonth);
      const endDate = isoDateLocal(lastOfPrevMonth);
      return { startDate, endDate, isCurrent: false, label: windowLabel(startDate, endDate) };
    }
    const startDate = previousJointCycleStarts(cycleStart, 1)[0];
    const endDate = shiftDays(cycleStart, -1);
    return { startDate, endDate, isCurrent: false, label: windowLabel(startDate, endDate) };
  }

  if (period === 'last_3_months') {
    // Three cycles counting the live one: the two closed cycles before this
    // one, plus everything so far this cycle.
    const startDate = previousJointCycleStarts(cycleStart, 2)[1];
    return { startDate, endDate: todayIso, isCurrent: false, label: windowLabel(startDate, todayIso) };
  }

  return { startDate: cycleStart, endDate: todayIso, isCurrent: true, label: 'this cycle' };
}

function windowLabel(startDate, endDate) {
  if (!startDate) return `through ${formatShort(endDate)}`;
  if (!endDate) return `from ${formatShort(startDate)}`;
  return `${formatShort(startDate)}–${formatShort(endDate)}`;
}
