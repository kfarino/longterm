#!/usr/bin/env node
// Pulls current-cycle transactions from Monarch and refreshes
// Longterm/data/budget_tracking.json's joint/Kevin-personal/travel trackers.
// Sibling to networth-pull.mjs in this same folder (same JSON-RPC/auth/
// sanitize/atomic-write pattern), calling get_transactions instead of
// get_accounts. Part of this project's own self-contained daily pull —
// see run-daily-pull.ps1 and install-scheduled-task.ps1 in this same folder.
//
// Runs monarch-mcp-jamiew from a persistent local venv (~/.longterm/monarch-mcp-venv)
// rather than via `uvx`/`uv` — see networth-pull.mjs's header for why. Spawns
// the venv's signed python.exe, not the unsigned pip console-script stub.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { monarchEnvPath, monarchMcpExePath, resolveMonarchMcpLaunch } from './longterm-paths.mjs';
import {
  DEFAULT_LEDGER_PATH,
  transactionId,
  upsertLedgerRows,
  loadLedger,
} from './transactions-store.mjs';
import {
  loadCycleHistory,
  saveCycleHistory,
  maybeArchiveOnRollover,
  archiveClosedCycle,
  previousJointCycleStarts,
  cycleDaysBetween,
  buildSnapshotFromCharges,
  deliverCloseOuts,
  defaultCloseOutNotifyFn,
} from './cycle-history.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    outputPath: path.join(repoRoot, 'data', 'budget_tracking.json'),
    goalsPath: path.join(repoRoot, 'data', 'goals.json'),
    envFile: monarchEnvPath(),
    mcpServerExe: monarchMcpExePath(),
    limit: 1000,
    dryRun: false,
    historyBackfillDays: null,
    cycleHistoryPath: path.join(repoRoot, 'data', 'cycle_history.json'),
    cycleHistoryBackfillCycles: null,
    transactionsLedgerPath: DEFAULT_LEDGER_PATH,
    ledgerBackfillDays: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      if (key === 'output-path') args.outputPath = value;
      else if (key === 'goals-path') args.goalsPath = value;
      else if (key === 'monarch-env-file') args.envFile = value;
      else if (key === 'mcp-server-exe') args.mcpServerExe = value;
      else if (key === 'limit') args.limit = Number.parseInt(value, 10);
      else if (key === 'history-backfill-days') args.historyBackfillDays = Number.parseInt(value, 10);
      else if (key === 'cycle-history-path') args.cycleHistoryPath = value;
      else if (key === 'cycle-history-backfill-cycles') args.cycleHistoryBackfillCycles = Number.parseInt(value, 10);
      else if (key === 'transactions-ledger-path') args.transactionsLedgerPath = value;
      else if (key === 'ledger-backfill-days') args.ledgerBackfillDays = Number.parseInt(value, 10);
      else throw new Error(`Unknown argument: ${arg}`);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

// Parses a simple KEY=VALUE .env file (no quoting/multi-line support needed —
// monarch.env has never used either) into a plain object.
function parseEnvFile(envFilePath) {
  const vars = {};
  for (const line of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function sanitize(value) {
  return String(value)
    .replace(/(MONARCH_(?:EMAIL|PASSWORD|MFA_SECRET|SESSION_DIR)=)[^\s]+/gi, '$1[redacted]')
    .replace(/(TELEGRAM_[A-Z_]*=)[^\s]+/gi, '$1[redacted]')
    .replace(/(password|secret|token)(["':=\s]+)[^"',\s]+/gi, '$1$2[redacted]');
}

class McpClient {
  constructor({ mcpServerExe, envFile }) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderrLines = [];
    const launch = resolveMonarchMcpLaunch(mcpServerExe);
    this.proc = spawn(launch.command, launch.args, {
      cwd: repoRoot,
      env: { ...process.env, ...parseEnvFile(envFile) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.stderrLines.push(sanitize(line).slice(0, 500));
      }
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    this.proc.on('exit', (code, signal) => {
      const error = new Error(`Monarch MCP process exited before completing request: code=${code} signal=${signal || ''}`.trim());
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}`));
      }, 120000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'longterm-budget-tracking-pull', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    return parseToolResult(result);
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

function parseToolResult(result) {
  const text = (result?.content || [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  if (!text) return result;
  let parsed = JSON.parse(text);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return parsed;
}

function extractTransactions(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.transactions)) return payload.transactions;
  if (Array.isArray(payload?.results)) return payload.results;
  if (Array.isArray(payload?.data?.transactions)) return payload.data.transactions;
  if (Array.isArray(payload?.data?.allTransactions?.results)) return payload.data.allTransactions.results;
  throw new Error('Could not find a transactions array in Monarch MCP response');
}

async function fetchTransactions(client, startDate, endDate, limit) {
  const all = [];
  let offset = 0;
  while (true) {
    const payload = await client.callTool('get_transactions', {
      start_date: startDate,
      end_date: endDate,
      limit,
      offset,
      verbose: false,
      hidden_from_reports: false,
    });
    const page = extractTransactions(payload);
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

function extractAccounts(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.data?.accounts)) return payload.data.accounts;
  throw new Error('Could not find an accounts array in Monarch MCP response');
}

async function fetchAccounts(client) {
  const payload = await client.callTool('get_accounts', {});
  return extractAccounts(payload);
}

/** Match mapped spend-card labels to live Monarch balances (credit cards are typically negative = amount owed). */
export function cardBalancesForLabels(accounts, labels) {
  const wanted = new Set(labels || []);
  if (!wanted.size) return [];
  const out = [];
  for (const a of accounts || []) {
    const label = a.displayName || a.name || '';
    if (!wanted.has(label)) continue;
    const balance = Number(a.balance ?? a.currentBalance ?? a.displayBalance ?? a.amount);
    if (!Number.isFinite(balance)) continue;
    const row = { label, balance: Math.round(balance * 100) / 100 };
    const dueDate = firstAccountIsoDate(a, ACCOUNT_DUE_DATE_KEYS);
    if (dueDate) row.dueDate = dueDate;
    out.push(row);
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

// monarchmoney's GetAccounts fragment has minimumPayment / plannedPayment but
// no statement due date or period. Copy a due date only when the account
// object actually carries one — do not invent a Chase due day.
const ACCOUNT_DUE_DATE_KEYS = [
  'statementDueDate', 'dueDate', 'nextPaymentDate', 'paymentDueDate',
  'lastStatementDueDate', 'nextDueDate',
];

function firstAccountIsoDate(account, keys) {
  for (const key of keys) {
    const iso = asIsoDate(account?.[key]);
    if (iso) return iso;
  }
  return null;
}

function asIsoDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return isoDate(value);
  const match = String(value).trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

// Monarch/Plaid's own categorization is sometimes just wrong or too generic
// for this household's budget tracking (e.g. a restaurant tagged as a bare
// "Credit Card Payment", or an AI-subscription merchant Monarch doesn't
// recognize at all). Matched case-insensitively as a substring against the
// merchant name, checked before falling back to Monarch's given category.
// Applied inside categoryName() itself (not at each call site) so every
// caller — the main joint/Kevin-personal categorization loop and
// refreshFavoritePlaces()'s separate dining-detection pass — benefits
// automatically from one source of truth.
//
// Durable overrides also live in data/transaction_overrides.json (amountRules
// for pending→posted tip corrections Chase already shows, categoryRules,
// reassignments, manualCharges for not-yet-in-Monarch personal spend). Code
// defaults below still apply; the JSON file wins on matching amountRules /
// adds extra category+reassignment+manualCharge rows.
const MERCHANT_CATEGORY_OVERRIDES = [
  { match: 'r+d', category: 'Restaurants & Bars' },
  // Farmers-market produce billed under the Sprout LA hospitality parent
  // name — groceries, not dining (Kevin/Hanna 2026-08-09).
  { match: 'sprout', category: 'Groceries' },
  { match: 'anthropic', category: 'Subscriptions' },
  { match: 'eleven labs', category: 'Subscriptions' },
  { match: 'elevenlabs', category: 'Subscriptions' },
  { match: 'grok', category: 'Subscriptions' },
  { match: 'xai', category: 'Subscriptions' },
];

const TRACKER_REASSIGNMENTS = [
  { merchantMatch: 'sora', date: '2026-08-01', reassignTo: 'joint', note: 'Lunch Kevin covered — a joint/family expense, per Kevin 2026-08-02.' },
  { merchantMatch: 'blue mercury', date: '2026-07-28', reassignTo: 'hanna', note: 'Hanna reimbursed via personal payment; counts on Hanna personal (not joint). Per Hanna 2026-08-09.' },
  { merchantMatch: 'locanda portofino', date: '2026-07-30', reassignTo: 'hanna', note: 'Hanna reimbursed via personal payment; counts on Hanna personal (not joint). Per Hanna 2026-08-09.' },
  { merchantMatch: 'barclays - cards', date: '2026-08-06', reassignTo: 'exclude', note: 'Hanna personal payment netting Blue Mercury + Locanda — not a merchant refund. Per Hanna 2026-08-09.' },
];

function overridesPath() {
  return path.join(repoRoot, 'data', 'transaction_overrides.json');
}

export function loadTransactionOverrides(filePath = overridesPath()) {
  const empty = { categoryRules: [], reassignments: [], amountRules: [], tripAssignments: [], travelCredits: [], manualCharges: [], budgetAdjustments: [] };
  if (!fs.existsSync(filePath)) {
    return empty;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      categoryRules: raw.categoryRules || [],
      reassignments: raw.reassignments || [],
      amountRules: raw.amountRules || [],
      tripAssignments: raw.tripAssignments || [],
      travelCredits: raw.travelCredits || [],
      manualCharges: raw.manualCharges || [],
      budgetAdjustments: raw.budgetAdjustments || [],
    };
  } catch {
    return empty;
  }
}

/** Compact Monarch shape uses a string; verbose uses { name }. */
export function merchantName(transaction) {
  if (typeof transaction?.merchant === 'string') return transaction.merchant;
  if (transaction?.merchant?.name) return transaction.merchant.name;
  return transaction?.plaidName || '';
}

/** Prefer a real Monarch id over a hand seed id when collapsing duplicates. */
export function preferDiningActivityId(a, b) {
  const aSeed = String(a || '').startsWith('seed-');
  const bSeed = String(b || '').startsWith('seed-');
  if (a && !aSeed && (!b || bSeed)) return a;
  if (b && !bSeed && (!a || aSeed)) return b;
  return b || a || null;
}

/**
 * Same real charge can appear multiple times in recentDiningActivity when
 * Monarch mints a new id on post (sometimes same calendar day) or a seed
 * entry was added before Monarch caught up. Collapse by merchant+account+
 * amount within ±2 days. Distinct same-day visits with different amounts
 * (e.g. Tu Madre lunch + dinner) stay separate.
 */
export function diningActivityPendingPostedMatch(a, b) {
  if (!a || !b) return false;
  if (a.merchant !== b.merchant || a.account !== b.account) return false;
  if (Math.abs(Number(a.amount) - Number(b.amount)) > 0.009) return false;
  if (a.id && b.id && a.id === b.id) return false;
  const days = Math.abs(
    (new Date(`${a.date}T12:00:00`) - new Date(`${b.date}T12:00:00`)) / 86400000,
  );
  return days <= 2;
}

export function collapsePendingPostedDiningDuplicates(entries) {
  const kept = [];
  const sorted = [...entries].sort(
    (a, b) => a.date.localeCompare(b.date) || String(a.id || '').localeCompare(String(b.id || '')),
  );
  for (const entry of sorted) {
    const match = kept.find((e) => diningActivityPendingPostedMatch(e, entry));
    if (!match) {
      kept.push({ ...entry });
      continue;
    }
    match.date = match.date < entry.date ? match.date : entry.date;
    match.amount = Number(entry.amount);
    match.merchant = entry.merchant || match.merchant;
    match.account = entry.account || match.account;
    if (entry.matchedPlace != null) match.matchedPlace = entry.matchedPlace;
    if (entry.includeOnMonthPlan) match.includeOnMonthPlan = true;
    match.id = preferDiningActivityId(match.id, entry.id);
  }
  return kept;
}

export function categoryName(transaction, overrides = null) {
  const rules = overrides || loadTransactionOverrides();
  const merchant = merchantName(transaction).toLowerCase();
  const matches = (rules.categoryRules || []).filter((o) => merchant.includes(String(o.merchantMatch || '').toLowerCase()));
  const abs = Math.abs(Number(transaction.amount));
  const withAmount = Number.isFinite(abs)
    ? matches.find((o) => o.amount != null && Math.abs(abs - Number(o.amount)) < 0.011)
    : null;
  const fromFile = withAmount || matches.find((o) => o.amount == null);
  if (fromFile?.category) return fromFile.category;
  const fromCode = MERCHANT_CATEGORY_OVERRIDES.find((o) => merchant.includes(o.match));
  if (fromCode) return fromCode.category;
  if (typeof transaction.category === 'string') return transaction.category;
  return transaction.category?.name || '';
}

/** Card payments and bank transfers (Venmo/Vanguard/Zelle leftovers) are
 *  balance-sheet moves, not new spend — except when categoryName has already
 *  relabelled a standing payment (tennis Zelle → Tennis). */
export function isBalanceMovement(transaction, overrides = null) {
  const cat = (categoryName(transaction, overrides) || '').toLowerCase();
  return cat === 'credit card payment' || cat === 'transfer';
}

export function tripAssignment(transaction, overrides = null) {
  const rules = overrides || loadTransactionOverrides();
  const merchant = merchantName(transaction).toLowerCase();
  return (rules.tripAssignments || []).find(
    (r) => merchant.includes(String(r.merchantMatch || '').toLowerCase()) && transaction.date === r.date,
  ) || null;
}

/**
 * The tripId a pin forces a charge onto regardless of the category Monarch
 * filed it under — or null.
 *
 * tripAssignments started life as a tie-breaker: a charge Monarch had ALREADY
 * put in a travel category, sitting in two trips' booking lookbacks, needed a
 * human to say which trip owned it. But plenty of real trip costs never get a
 * travel category at all — airport parking posts as Transportation, an airport
 * meal as Restaurants & Bars — so they counted against the joint budget with
 * nothing able to move them (2026-09-17). A pin naming a tripId now also
 * *routes* the charge into travel, and is checked everywhere a tracker gets
 * decided: the live loop, ledgerRowsFromTransactions, collectJointCharges, and
 * mergeLedgerIntoTripBuckets' fold-back for charges older than the fetch window.
 *
 * A `skip: true` pin makes the opposite claim (not a family trip — work,
 * reimbursed, a refunded original booking) and never reroutes anything.
 */
export function tripReroute(transaction, overrides = null) {
  const assigned = tripAssignment(transaction, overrides);
  if (!assigned || assigned.skip) return null;
  return assigned.tripId || null;
}

const BOOKING_LOOKBACK_DAYS = 300;

export function buildTripWindows(travel, bookingLookbackDays = BOOKING_LOOKBACK_DAYS) {
  return (travel || [])
    .filter((t) => t.startDate && t.endDate)
    .map((t) => {
      const start = new Date(t.startDate);
      const lookbackDays = t.budgetedAmount != null ? bookingLookbackDays : 0;
      const bookingStart = new Date(start);
      bookingStart.setDate(bookingStart.getDate() - lookbackDays);
      return { ...t, start, end: new Date(t.endDate), bookingStart };
    });
}

/** Pin via tripAssignments when a charge sits in two lookbacks; otherwise the
 *  unique window match, or unmatched (never guess). */
export function resolveTravelTrip(transaction, trips, overrides = null) {
  const assigned = tripAssignment(transaction, overrides);
  if (assigned?.skip) return { trip: null, skip: true };
  if (assigned?.tripId) {
    const trip = (trips || []).find((t) => t.id === assigned.tripId);
    if (trip) return { trip };
  }
  const txnDate = new Date(`${transaction.date}T12:00:00`);
  const candidates = (trips || []).filter((t) => txnDate >= t.bookingStart && txnDate <= t.end);
  if (candidates.length === 1) return { trip: candidates[0] };
  if (candidates.length > 1) {
    return { trip: null, unmatched: true, ambiguousBetween: candidates.map((t) => t.id) };
  }
  return { trip: null, unmatched: true };
}

function tripTxnKey(row) {
  return `${row.date}|${String(row.merchant || '').toLowerCase()}|${Math.round((Math.abs(Number(row.amount) || 0)) * 100)}`;
}

function alreadyOnTrip(bucket, summary, row = null) {
  if (row?.id && bucket.transactions.some((t) => t.id && t.id === row.id)) return true;
  const key = tripTxnKey(summary);
  const same = bucket.transactions.filter((t) => tripTxnKey(t) === key);
  if (same.length === 0) return false;
  // Two real tickets can share date+merchant+amount (Hanna's two $1,154.83
  // Lufthansa charges on 2026-07-27). Distinct ids stay distinct. A live
  // fetch row with no id is the same charge as a later ledger fold.
  if (row?.id && same.every((t) => t.id && t.id !== row.id)) return false;
  return true;
}

/** Fold stored travel rows (older than this fetch) into live trip buckets so a
 *  budgeted trip is not zeroed when its original flights leave the pull window. */
export function mergeLedgerIntoTripBuckets(buckets, ledgerRows, skipKeys = new Set(), overrides = null) {
  for (const row of ledgerRows || []) {
    const pin = tripAssignment({ date: row.date, merchant: row.merchant, amount: row.amount }, overrides);
    if (pin?.skip) continue;
    // A pin added *after* the charge was already stored still has to reach the
    // trip: the stored row says tracker "joint" and the next pull can only
    // retag it if it is still inside the fetch window. Honouring the pin here
    // is what makes reassigning an older charge actually change a trip total.
    const tripId = (row.tracker === 'travel' && row.tripId) ? row.tripId : (pin?.tripId || null);
    if (!tripId) continue;
    if (!buckets.has(tripId)) buckets.set(tripId, { actual: 0, transactions: [] });
    const bucket = buckets.get(tripId);
    const amount = Math.round(Math.abs(Number(row.amount) || 0) * 100) / 100;
    if (!(amount > 0)) continue;
    const isCredit = row.type === 'credit' || row.type === 'refund';
    const summary = {
      date: row.date,
      merchant: row.merchant,
      amount,
      ...(isCredit ? { type: 'credit' } : {}),
    };
    if (skipKeys.has(tripTxnKey(summary))) continue;
    if (alreadyOnTrip(bucket, summary, row)) continue;
    if (row.id) summary.id = row.id;
    bucket.transactions.push(summary);
    bucket.actual = Math.round((bucket.actual + (isCredit ? -amount : amount)) * 100) / 100;
  }
  return buckets;
}

export function applyTravelCredits(buckets, credits) {
  for (const c of credits || []) {
    if (!c?.tripId) continue;
    const amount = Math.round(Math.abs(Number(c.amount) || 0) * 100) / 100;
    if (!(amount > 0)) continue;
    if (!buckets.has(c.tripId)) buckets.set(c.tripId, { actual: 0, transactions: [] });
    const bucket = buckets.get(c.tripId);
    const summary = { date: c.date, merchant: c.merchant, amount, type: 'credit' };
    if (bucket.transactions.some((t) => tripTxnKey(t) === tripTxnKey(summary))) continue;
    bucket.transactions.push(summary);
    bucket.actual = Math.round((bucket.actual - amount) * 100) / 100;
  }
  return buckets;
}

export function trackerReassignment(transaction, overrides = null) {
  const rules = overrides || loadTransactionOverrides();
  const merchant = merchantName(transaction).toLowerCase();
  const fromFile = (rules.reassignments || []).find(
    (r) => merchant.includes(String(r.merchantMatch || '').toLowerCase()) && transaction.date === r.date,
  );
  if (fromFile) return fromFile;
  return TRACKER_REASSIGNMENTS.find((r) => merchant.includes(r.merchantMatch) && transaction.date === r.date) || null;
}

/** Absolute spend dollars. amountRules override Monarch when Chase already posted a tip Monarch still shows as pending. */
export function spendAmount(transaction, overrides = null) {
  const rules = overrides || loadTransactionOverrides();
  const merchant = merchantName(transaction).toLowerCase();
  const rule = (rules.amountRules || []).find(
    (r) => merchant.includes(String(r.merchantMatch || '').toLowerCase()) && transaction.date === r.date,
  );
  if (rule && Number.isFinite(Number(rule.amount))) {
    return Math.round(Math.abs(Number(rule.amount)) * 100) / 100;
  }
  const value = Number(transaction.amount);
  if (!Number.isFinite(value) || value >= 0) return 0; // only negative (debit) amounts are spend
  return Math.abs(value);
}

function manualChargeAmount(charge) {
  return Math.round(Math.abs(Number(charge.amount)) * 100) / 100;
}

function isSameManualCharge(transaction, summary) {
  return transaction.date === summary.date
    && String(transaction.merchant).toLowerCase() === String(summary.merchant).toLowerCase()
    && Math.abs(Number(transaction.amount) - summary.amount) < 0.01;
}

function applyChargeToMaps(state, charge, cycleStart) {
  const amount = manualChargeAmount(charge);
  if (!(amount > 0) || !charge.date || !charge.merchant || !state || !cycleStart) return;
  const catDisplay = charge.category || 'Uncategorized';
  const summary = { date: charge.date, merchant: charge.merchant, amount };
  const already = [...state.categoryTransactions.values()].flat().some((t) => isSameManualCharge(t, summary));
  if (already) return;
  const txnDate = new Date(`${charge.date}T12:00:00`);
  const b = weekBucket(txnDate, cycleStart);
  if (b < 0) return;
  state.buckets.set(b, Math.round(((state.buckets.get(b) || 0) + amount) * 100) / 100);
  state.categoryTotals.set(catDisplay, Math.round(((state.categoryTotals.get(catDisplay) || 0) + amount) * 100) / 100);
  if (!state.categoryTransactions.has(catDisplay)) state.categoryTransactions.set(catDisplay, []);
  state.categoryTransactions.get(catDisplay).push(summary);
}

/**
 * Merge not-yet-in-Monarch charges into the per-tracker accumulators.
 * `tracker: "joint"` goes to jointState; `{ owner }` stays on that personal
 * tracker. Skips when the same date + merchant + amount is already present
 * (so a later pull that catches the real charge does not double-count).
 */
export function applyManualCharges(personalState, manualCharges, personalCycleStart, jointState, jointCycleStart) {
  for (const charge of manualCharges || []) {
    if (charge?.tracker === 'joint') {
      applyChargeToMaps(jointState, charge, jointCycleStart);
      continue;
    }
    const ownerId = charge?.owner;
    const state = ownerId && personalState?.[ownerId];
    if (!state) continue;
    applyChargeToMaps(state, charge, cycleStartForOwner(personalCycleStart, ownerId));
  }
}

function cycleStartForOwner(personalCycleStart, ownerId) {
  if (personalCycleStart instanceof Date) return personalCycleStart;
  if (personalCycleStart && typeof personalCycleStart === 'object') return personalCycleStart[ownerId];
  return personalCycleStart;
}

function growWeeks(weeks, bucketIndex) {
  while (weeks.length <= bucketIndex) {
    weeks.push({ weekOf: `week ${weeks.length + 1}`, actual: 0, days: 7 });
  }
}

/**
 * Patch live budget_tracking.json trackers with manualCharges (bot path).
 * Same dedup + cycle-window rules as applyManualCharges; used so a cash
 * charge shows up in get_budget_status / the dashboard before the next
 * morning Monarch pull rebuilds this file from overrides.
 */
export function applyManualChargesToTracking(tracking, manualCharges) {
  for (const charge of manualCharges || []) {
    const tracker = charge?.tracker === 'joint'
      ? tracking?.joint
      : tracking?.personal?.[charge?.owner || charge?.tracker];
    if (!tracker || !tracker.cycleStart) continue;
    const amount = manualChargeAmount(charge);
    if (!(amount > 0) || !charge.date || !charge.merchant) continue;
    const catDisplay = charge.category || 'Uncategorized';
    const summary = { date: charge.date, merchant: charge.merchant, amount };
    const already = (tracker.categories || []).flatMap((c) => c.transactions || []).some((t) => isSameManualCharge(t, summary));
    if (already) continue;
    const cycleStart = new Date(`${tracker.cycleStart}T12:00:00`);
    const txnDate = new Date(`${charge.date}T12:00:00`);
    const b = weekBucket(txnDate, cycleStart);
    if (b < 0) continue;
    if (!Array.isArray(tracker.weeks)) tracker.weeks = [];
    growWeeks(tracker.weeks, b);
    tracker.weeks[b].actual = Math.round(((Number(tracker.weeks[b].actual) || 0) + amount) * 100) / 100;
    if (!Array.isArray(tracker.categories)) tracker.categories = [];
    let cat = tracker.categories.find((c) => c.name === catDisplay);
    if (!cat) {
      cat = { name: catDisplay, amount: 0, transactions: [] };
      tracker.categories.push(cat);
    }
    cat.amount = Math.round(((Number(cat.amount) || 0) + amount) * 100) / 100;
    cat.transactions.push(summary);
    cat.transactions.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  for (const tracker of [
    tracking?.joint,
    ...Object.values(tracking?.personal || {}),
  ].filter(Boolean)) {
    if (!Array.isArray(tracker.categories)) continue;
    tracker.categories.sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
  }
  return tracking;
}

/** A pin identifies one charge: exact date, merchant substring, and the amount
 *  when the pin carries one (two same-day charges at the same merchant are
 *  otherwise indistinguishable in this view — no ids on tracker line items). */
function pinMatchesRow(pin, row) {
  if (!row || row.date !== pin.date) return false;
  if (!String(row.merchant || '').toLowerCase().includes(String(pin.merchantMatch).toLowerCase())) return false;
  if (pin.amount == null) return true;
  const want = Math.round(Math.abs(Number(pin.amount)) * 100) / 100;
  return Math.abs(Math.abs(Number(row.amount) || 0) - want) < 0.011;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** Lift the pinned charge out of a joint/personal category, decrementing that
 *  category total and its week bucket so the tracker still adds up. */
function liftFromSpendTracker(tracker, pin) {
  if (!tracker || !Array.isArray(tracker.categories)) return null;
  for (const cat of tracker.categories) {
    const idx = (cat.transactions || []).findIndex((t) => pinMatchesRow(pin, t));
    if (idx < 0) continue;
    const [row] = cat.transactions.splice(idx, 1);
    const amount = round2(Math.abs(Number(row.amount) || 0));
    cat.amount = round2((Number(cat.amount) || 0) - amount);
    if (tracker.cycleStart && Array.isArray(tracker.weeks)) {
      const b = weekBucket(new Date(`${row.date}T12:00:00`), new Date(`${tracker.cycleStart}T12:00:00`));
      if (b >= 0 && tracker.weeks[b]) tracker.weeks[b].actual = round2((Number(tracker.weeks[b].actual) || 0) - amount);
    }
    // A category whose only line item just moved to a trip is not a $0 spend
    // category, it is no category at all.
    if (!cat.transactions.length && Math.abs(cat.amount) < 0.011) {
      tracker.categories = tracker.categories.filter((c) => c !== cat);
    }
    tracker.categories.sort((a, b) => (Number(b.amount) || 0) - (Number(a.amount) || 0));
    return { date: row.date, merchant: row.merchant, amount, ...(row.id ? { id: row.id } : {}) };
  }
  return null;
}

/** Repin: the charge is on a trip, just the wrong one. Credits keep their sign
 *  so moving a refund between trips moves the reduction with it. */
function liftFromOtherTrip(trips, pin, targetId) {
  for (const trip of trips || []) {
    if (trip.id === targetId || !Array.isArray(trip.transactions)) continue;
    const idx = trip.transactions.findIndex((t) => pinMatchesRow(pin, t));
    if (idx < 0) continue;
    const [row] = trip.transactions.splice(idx, 1);
    const amount = round2(Math.abs(Number(row.amount) || 0));
    const isCredit = row.type === 'credit';
    trip.actual = round2((Number(trip.actual) || 0) - (isCredit ? -amount : amount));
    return { date: row.date, merchant: row.merchant, amount, ...(row.id ? { id: row.id } : {}), ...(isCredit ? { type: 'credit' } : {}) };
  }
  return null;
}

/** The charge Monarch called travel but matched to no trip (or to two). */
function liftFromUnmatched(travel, pin) {
  if (!Array.isArray(travel?.unmatched)) return null;
  const idx = travel.unmatched.findIndex((t) => pinMatchesRow(pin, t));
  if (idx < 0) return null;
  const [row] = travel.unmatched.splice(idx, 1);
  const isCredit = row.type === 'credit';
  return {
    date: row.date,
    merchant: row.merchant,
    amount: round2(Math.abs(Number(row.amount) || 0)),
    ...(row.id ? { id: row.id } : {}),
    ...(isCredit ? { type: 'credit' } : {}),
  };
}

/**
 * Patch live budget_tracking.json by moving each pinned charge onto its trip
 * (bot path) — the counterpart to applyManualChargesToTracking, and there for
 * the same reason: the reroute above only takes effect on the next Monarch
 * pull, and a charge should stop counting against the joint budget the moment
 * someone says it was a trip cost, not tomorrow morning.
 *
 * Idempotent, because the poller re-applies the entire pin list on every
 * overrides write: a charge already on its target trip is left alone. A pin
 * whose charge isn't anywhere in this view (a closed cycle, or Monarch hasn't
 * posted it) changes nothing here — the pin itself still governs future pulls.
 *
 * Settled trips (budgetedAmount: null, e.g. a past trip) are exactly why this
 * has to write the trip too: the daily pull deliberately never rebuilds them,
 * so this is the only thing that can add a charge to one.
 */
export function applyTripReassignmentsToTracking(tracking, tripAssignments) {
  const trips = tracking?.travel?.trips || [];
  for (const pin of tripAssignments || []) {
    if (!pin || pin.skip || !pin.tripId || !pin.date || !pin.merchantMatch) continue;
    const target = trips.find((t) => t.id === pin.tripId);
    if (!target) continue;
    if (!Array.isArray(target.transactions)) target.transactions = [];
    if (target.transactions.some((t) => pinMatchesRow(pin, t))) continue;

    const moved = liftFromSpendTracker(tracking?.joint, pin)
      || Object.values(tracking?.personal || {}).reduce((found, t) => found || liftFromSpendTracker(t, pin), null)
      || liftFromOtherTrip(trips, pin, target.id)
      || liftFromUnmatched(tracking?.travel, pin);
    if (!moved) continue;

    target.transactions.push(moved);
    target.transactions.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
    target.actual = round2((Number(target.actual) || 0) + (moved.type === 'credit' ? -moved.amount : moved.amount));
  }
  return tracking;
}

/**
 * Apply a household correction to a tracker's current-cycle logged total
 * (2026-09-20) — the third and last thing that can change a live tracker,
 * alongside applyManualChargesToTracking (a charge that exists in real life
 * but not in Monarch) and applyTripReassignmentsToTracking (a charge on the
 * wrong budget). A correction is neither of those: it is the residual between
 * what Monarch has logged for this cycle and what the household says is true,
 * and it deliberately names no merchant. Inventing a fake merchant to close
 * that gap would put a charge that never happened into the category breakdown
 * and, via the ledger, into history.
 *
 * Folded into the LAST week bucket, not carried as a separate figure: every
 * consumer derives a tracker's total by summing weeks[].actual (the dashboard
 * inline, financial-context.mjs's computeTrackerPacing, the recap through it).
 * Teaching one of those about an `adjustments` term and not the other is the
 * dual-math drift AGENTS.md §2 exists to prevent. `days` is untouched, so the
 * day-weighted daily rate keeps its real denominator.
 *
 * Two rules keep it honest:
 *   - The receipt for "already folded in" is `week.adjustment` on the week row
 *     itself, never a flag on the tracker. The morning pull rebuilds weeks[]
 *     from Monarch, so those fresh rows carry no receipt and this function
 *     will not subtract a correction that isn't in them. Re-applying the whole
 *     list is therefore safe on both paths, which is what the poller does on
 *     every overrides write.
 *   - An adjustment applies only to the cycle it was made for (`cycleStart`
 *     must match the tracker's). A correction that silently carried into next
 *     month would be an invisible, permanent offset on the family budget.
 */
export function applyBudgetAdjustmentsToTracking(tracking, budgetAdjustments) {
  const entries = [['joint', tracking?.joint], ...Object.entries(tracking?.personal || {})];
  for (const [key, tracker] of entries) {
    if (!tracker) continue;
    for (const week of tracker.weeks || []) {
      if (week.adjustment == null) continue;
      week.actual = round2((Number(week.actual) || 0) - Number(week.adjustment));
      delete week.adjustment;
    }
    delete tracker.adjustments;

    const applicable = (budgetAdjustments || []).filter((a) => (
      a
      && adjustmentTrackerKey(a) === key
      && a.cycleStart
      && a.cycleStart === tracker.cycleStart
      && Number.isFinite(Number(a.amount))
      && Number(a.amount) !== 0
    ));
    if (!applicable.length) continue;

    if (!Array.isArray(tracker.weeks) || !tracker.weeks.length) {
      tracker.weeks = [{ weekOf: 'week 1', actual: 0, days: 7 }];
    }
    const folded = applicable.reduce((sum, a) => round2(sum + Number(a.amount)), 0);
    const last = tracker.weeks[tracker.weeks.length - 1];
    last.actual = round2((Number(last.actual) || 0) + folded);
    last.adjustment = folded;
    tracker.adjustments = applicable.map((a) => ({
      amount: round2(Number(a.amount)),
      reason: a.reason || null,
      ...(a.addedBy ? { addedBy: a.addedBy } : {}),
      ...(a.at ? { at: a.at } : {}),
    }));
  }
  return tracking;
}

/** `{ tracker: "joint" }` or `{ owner: "kevin" }`, same shape manualCharges use. */
function adjustmentTrackerKey(adjustment) {
  if (adjustment.tracker === 'joint') return 'joint';
  return adjustment.owner || adjustment.tracker || null;
}

/** Monarch: spend is negative, credits positive. Trip actual is net spend (credits reduce it). */
export function travelNetSpend(rawAmount) {
  const n = Number(rawAmount);
  if (!Number.isFinite(n) || n === 0) return 0;
  return Math.round((-n) * 100) / 100;
}

// get_transactions (compact shape) exposes only a display-name string for the
// account (e.g. "CREDIT CARD (...3939)") — no numeric id, unlike get_accounts.
function accountLabel(transaction) {
  if (typeof transaction.account === 'string') return transaction.account;
  return transaction.account?.displayName || transaction.account?.name || '';
}

// Most recent 25th-of-month on or before `today` — the Barclays statement-period
// convention. This is specific to that card; do not reuse it for other cards.
function currentCycleStart(today) {
  const start = new Date(today.getFullYear(), today.getMonth(), 25);
  if (today.getDate() < 25) start.setMonth(start.getMonth() - 1);
  return start;
}

// Fallback when mapping.personalCycle has no startDay/closeDay. Checking/cash
// never defines a personal window — see resolvePersonalCycle.
function currentMonthStart(today) {
  return new Date(today.getFullYear(), today.getMonth(), 1);
}

const CREDIT_CARD_LABEL = /credit card|mastercard|visa|amex|american express|discover/i;
const CHECKING_LIKE_LABEL = /spending account|checking|savings/i;

export function isCheckingLikeLabel(label) {
  return CHECKING_LIKE_LABEL.test(label || '');
}

export function isCreditCardLikeLabel(label) {
  return CREDIT_CARD_LABEL.test(label || '') && !CHECKING_LIKE_LABEL.test(label || '');
}

// Which mapped account defines the personal statement window. Ally checking
// never does. goals.json / mapping notes have no designated "main" Chase card,
// so when two credit cards are listed we take the first in personalAccountLabels.
export function personalCycleAnchorLabel(labels, cycleCfg) {
  const list = labels || [];
  if (cycleCfg?.accountLabel && list.includes(cycleCfg.accountLabel) && !isCheckingLikeLabel(cycleCfg.accountLabel)) {
    return cycleCfg.accountLabel;
  }
  return list.find((label) => isCreditCardLikeLabel(label)) || null;
}

function cycleStartOnDay(today, day) {
  const start = new Date(today.getFullYear(), today.getMonth(), day);
  if (today.getDate() < day) start.setMonth(start.getMonth() - 1);
  return start;
}

function nextMonthSameDay(start) {
  const next = new Date(start);
  next.setMonth(next.getMonth() + 1);
  return next;
}

function personalStartDay(cycleCfg) {
  const startDay = Number(cycleCfg?.startDay);
  if (Number.isInteger(startDay) && startDay >= 1 && startDay <= 31) return startDay;
  const closeDay = Number(cycleCfg?.closeDay);
  if (Number.isInteger(closeDay) && closeDay >= 1 && closeDay <= 31) {
    return closeDay >= 31 ? 1 : closeDay + 1;
  }
  return null;
}

// Personal cycle is independent of joint's 25th. mapping.personalCycle[owner]
// may name the credit card and the statement-window start day (same convention
// as currentCycleStart). No startDay → calendar month. Monarch get_accounts
// does not expose a statement period, so this is the durable config.
export function resolvePersonalCycle(today, ownerId, mapping) {
  const labels = mapping?.personalAccountLabels?.[ownerId] || [];
  const cycleCfg = mapping?.personalCycle?.[ownerId] || {};
  const anchorLabel = personalCycleAnchorLabel(labels, cycleCfg);
  const startDay = personalStartDay(cycleCfg);
  const start = startDay ? cycleStartOnDay(today, startDay) : currentMonthStart(today);
  const next = nextMonthSameDay(start);
  return {
    anchorLabel,
    start,
    cycleStart: isoDate(start),
    cycleDays: cycleDaysBetween(isoDate(start), isoDate(next)),
  };
}

function jointTargetFromGoals(goals, tracking) {
  const key = tracking?.joint?.targetExpenseKey;
  if (!key) return null;
  const v = goals?.phases?.[0]?.expenses?.[key];
  return v == null ? null : Number(v);
}

// Joint-only charges for closed-cycle backfill. Same card / travel / reassignment
// routing as the live pull, but no merchant line items — just date, category, amount.
function collectJointCharges(transactions, tracking) {
  const overrides = loadTransactionOverrides();
  const travelCategories = new Set((tracking.mapping?.travelCategoryNames || []).map((c) => c.toLowerCase()));
  const jointLabels = new Set(tracking.mapping?.jointAccountLabels || []);
  const personalLabelsByOwner = tracking.mapping?.personalAccountLabels || {};
  const labelToOwnerId = new Map();
  for (const [ownerId, labels] of Object.entries(personalLabelsByOwner)) {
    for (const label of labels || []) labelToOwnerId.set(label, ownerId);
  }
  const charges = [];
  for (const txn of transactions) {
    const catDisplay = categoryName(txn, overrides) || 'Uncategorized';
    const cat = catDisplay.toLowerCase();
    if (travelCategories.has(cat) || tripReroute(txn, overrides)) continue;
    const amount = spendAmount(txn, overrides);
    if (amount === 0) continue;
    const reassignment = trackerReassignment(txn, overrides);
    if (reassignment?.reassignTo === 'exclude') continue;
    const acct = accountLabel(txn);
    let routeToJoint = false;
    if (reassignment) {
      if (reassignment.reassignTo === 'joint') routeToJoint = true;
    } else if (labelToOwnerId.has(acct)) {
      routeToJoint = false;
    } else if (jointLabels.has(acct)) {
      routeToJoint = true;
    }
    if (!routeToJoint) continue;
    charges.push({ date: txn.date, category: catDisplay, amount: Math.round(amount * 100) / 100 });
  }
  return charges;
}

// One durable ledger row per transaction, for scripts/transactions-store.mjs —
// the history that makes a CLOSED cycle still searchable after this file has
// rebuilt budget_tracking.json for the new one.
//
// Routing mirrors the live loop's card / travel / reassignment rules, in the
// same spirit (and for the same reason) as collectJointCharges above: a second,
// simpler pass rather than a refactor of the money loop itself. It is
// deliberately NOT week-bucketed and NOT cycle-clipped — a charge from before
// the current cycle start is precisely what this is here to keep. Travel rows
// carry tripId when resolveTravelTrip can pin them (including tripAssignments).
export function ledgerRowsFromTransactions(transactions, tracking, { overrides = null, trips = [] } = {}) {
  const rules = overrides || loadTransactionOverrides();
  const travelCategories = new Set((tracking?.mapping?.travelCategoryNames || []).map((c) => c.toLowerCase()));
  const jointLabels = new Set(tracking?.mapping?.jointAccountLabels || []);
  const personalLabelsByOwner = tracking?.mapping?.personalAccountLabels || {};
  const labelToOwnerId = new Map();
  for (const [ownerId, labels] of Object.entries(personalLabelsByOwner)) {
    for (const label of labels || []) labelToOwnerId.set(label, ownerId);
  }

  const rows = [];
  for (const txn of transactions || []) {
    const reassignment = trackerReassignment(txn, rules);
    if (reassignment?.reassignTo === 'exclude') continue;

    const catDisplay = categoryName(txn, rules) || 'Uncategorized';
    const cat = catDisplay.toLowerCase();
    const acct = accountLabel(txn);
    const rawAmount = Number(txn.amount);
    if (!Number.isFinite(rawAmount) || rawAmount === 0) continue;

    let tracker = null;
    let ownerId = null;
    if (travelCategories.has(cat) || tripReroute(txn, rules)) {
      tracker = 'travel';
    } else if (reassignment) {
      if (reassignment.reassignTo === 'joint') tracker = 'joint';
      else if (personalLabelsByOwner[reassignment.reassignTo]) { tracker = 'personal'; ownerId = reassignment.reassignTo; }
    } else if (labelToOwnerId.has(acct)) {
      tracker = 'personal';
      ownerId = labelToOwnerId.get(acct);
    } else if (jointLabels.has(acct)) {
      tracker = 'joint';
    }
    // Anything else (Vanguard brokerage, 401k, savings, ...) isn't a spend card.
    if (!tracker) continue;

    // Paying a card off from a debit account is not new spend — it already
    // counted on the card. Same for Transfer (Venmo/Vanguard) unless
    // categoryName relabelled it (tennis Zelle → Tennis).
    if (tracker !== 'travel' && isBalanceMovement(txn, rules)) continue;

    // A positive amount is money coming back. The card paying off its own
    // balance is not a refund and is not spend — same exclusion, and the same
    // reasoning, as detectJointRefunds.
    const isCredit = rawAmount > 0;
    if (isCredit && cat === 'credit card payment') continue;
    const amount = isCredit
      ? Math.round(Math.abs(rawAmount) * 100) / 100
      : spendAmount(txn, rules);
    if (amount === 0) continue;

    let tripId = null;
    if (tracker === 'travel') {
      const resolved = resolveTravelTrip(txn, trips, rules);
      if (resolved.skip) {
        // Keep the row so a later upsert clears a stale tripId; do not pin it.
      } else if (resolved.trip) {
        tripId = resolved.trip.id;
      } else {
        // resolveTravelTrip only accepts a pin whose trip is in the `trips`
        // list it was handed, and `trips` is optional here. An explicit pin is
        // a human naming the trip, so it is recorded either way — history
        // should not lose the attribution just because a caller omitted the
        // trip list. A tripId no live trip claims is inert downstream.
        tripId = tripReroute(txn, rules);
      }
    }

    rows.push({
      id: transactionId({ ...txn, accountLabel: acct }),
      date: txn.date,
      merchant: merchantName(txn),
      amount,
      accountLabel: acct,
      category: catDisplay,
      group: tripId || catDisplay,
      tracker,
      ownerId,
      tripId,
      type: isCredit ? (tracker === 'travel' ? 'credit' : 'refund') : 'spend',
    });
  }
  return rows;
}

function daysInMonth(today) {
  return new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
}

const DINING_CATEGORY_NAMES = new Set(['restaurants & bars']);
const DINING_LOOKBACK_DAYS = 90;
// Delivery apps are household eating-out even when they land on a personal
// card (e.g. Hanna DoorDash 2026-08-06) — Month Plan should show them.
const DELIVERY_MERCHANT_MATCHES = ['doordash', 'uber eats', 'ubereats', 'grubhub', 'postmates', 'caviar'];

function isDeliveryMerchant(merchant) {
  const m = String(merchant || '').toLowerCase();
  return DELIVERY_MERCHANT_MATCHES.some((needle) => m.includes(needle));
}

/** Joint-card dining, delivery on any household card, or one-off reassigned to joint. */
export function countsTowardMonthPlanDining(txn, jointLabels, personalLabels = new Set()) {
  const cat = categoryName(txn).toLowerCase();
  if (!DINING_CATEGORY_NAMES.has(cat)) return false;
  const account = accountLabel(txn);
  const merchant = txn.merchant || txn.plaidName || '';
  if (jointLabels.has(account)) return true;
  if (isDeliveryMerchant(merchant) && personalLabels.has(account)) return true;
  const reassignment = trackerReassignment(txn);
  return !!(reassignment && reassignment.reassignTo === 'joint');
}

function monthPlanDiningAccountOk(entry, jointLabels, personalLabels = new Set()) {
  if (jointLabels.has(entry.account)) return true;
  if (!personalLabels.has(entry.account)) return false;
  if (isDeliveryMerchant(entry.merchant)) return true;
  // Personal-card charge that was explicitly included (reassigned to joint, etc.)
  return entry.includeOnMonthPlan === true;
}

function matchFavorite(merchant, favorites) {
  const m = merchant.toLowerCase();
  if (!m) return null;
  return favorites.find((f) => {
    const name = f.name.toLowerCase();
    if (name.length < 5) {
      // Short names (e.g. "Casa", "Jar") produce false-positive substring
      // matches against unrelated merchants (e.g. "Casablanca Bistro" would
      // otherwise match "Casa"). Require a word-boundary match instead of a
      // raw substring for these.
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`).test(m);
    }
    return m.includes(name) || name.includes(m);
  }) || null;
}

// Refunds/credits (2026-08-05): a positive-amount joint-card transaction
// that isn't the card's own statement payment ("Credit Card Payment"
// category — Barclays/Chase paying off the balance, not a merchant
// crediting money back — confirmed against real Monarch data) or travel
// (travel credits reduce the matched trip's actual in the main loop instead —
// see travelNetSpend). spendAmount() deliberately zeroes out any non-negative
// amount, so this is a separate pass, not part of the main spend-processing
// loop. cycleStart (2026-08-05): the main spend-processing loop only counts
// transactions within the current joint cycle (weekBucket's `b >= 0` guard),
// but the fetched transaction window starts at the earliest of joint and each
// personal cycle (personal may be a statement window or calendar month) —
// without this filter a refund from the tail end of the PRIOR cycle would leak
// into "this cycle"'s refunds list. Any transaction dated before cycleStart is
// skipped.
// Excluded reassignments (2026-08-09): one-offs marked reassignTo "exclude"
// (e.g. a personal reimbursement transfer) are skipped here too.
export function detectJointRefunds(transactions, jointLabels, travelCategoryNames, cycleStart) {
  const refunds = [];
  for (const txn of transactions) {
    const rawAmount = Number(txn.amount);
    if (!Number.isFinite(rawAmount) || rawAmount <= 0) continue;
    if (new Date(txn.date) < cycleStart) continue;
    const acct = accountLabel(txn);
    if (!jointLabels.has(acct)) continue;
    if (trackerReassignment(txn)?.reassignTo === 'exclude') continue;
    const catDisplay = categoryName(txn) || 'Uncategorized';
    const cat = catDisplay.toLowerCase();
    if (cat === 'credit card payment') continue;
    if (travelCategoryNames.has(cat)) continue;
    refunds.push({
      date: txn.date,
      merchant: txn.merchant || txn.plaidName || '',
      amount: Math.round(rawAmount * 100) / 100,
      category: catDisplay,
    });
  }
  return refunds.sort((a, b) => a.date.localeCompare(b.date));
}

function tierFromAvg(avg) {
  if (avg < 40) return 'cheap';
  if (avg <= 90) return 'mid';
  return 'high';
}

// One-off/occasional deep pull (e.g. 2 years), NOT the nightly cycle-scoped
// fetch — see the `--history-backfill-days` CLI mode below. Full recompute
// every run rather than an incremental merge: a wide pull is cheap enough to
// just redo, and full recompute avoids drift/double-counting bugs an
// incremental merge would risk. Joint-only, same reasoning as
// refreshFavoritePlaces's recentDiningActivity below — this is a joint-budget
// planning signal, so personal-card dining shouldn't skew "how much do we
// actually go here." Written to its own file (not folded into
// favorite_places.json's recentDiningActivity) because that array is
// hard-trimmed to a 90-day rolling window every nightly run and structurally
// cannot hold multi-year history.
export function computeFavoritePlacesHistory(rawPath, historyPath, transactions, jointLabels, today, lookbackDays) {
  if (!fs.existsSync(rawPath)) return null;
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const statsByName = new Map();
  for (const txn of transactions) {
    const amount = spendAmount(txn);
    if (amount === 0) continue;
    const cat = categoryName(txn).toLowerCase();
    if (!DINING_CATEGORY_NAMES.has(cat)) continue;
    const account = accountLabel(txn);
    if (!jointLabels.has(account)) continue;
    const merchant = merchantName(txn);
    const match = matchFavorite(merchant, raw);
    if (!match) continue;
    const roundedAmount = Math.round(amount * 100) / 100;
    const entry = statsByName.get(match.name) || { visitCount: 0, totalSpend: 0, firstVisitDate: txn.date, lastVisitDate: txn.date };
    entry.visitCount += 1;
    entry.totalSpend = Math.round((entry.totalSpend + roundedAmount) * 100) / 100;
    if (txn.date < entry.firstVisitDate) entry.firstVisitDate = txn.date;
    if (txn.date > entry.lastVisitDate) entry.lastVisitDate = txn.date;
    statsByName.set(match.name, entry);
  }
  const stats = {};
  for (const [name, s] of statsByName) {
    stats[name] = { ...s, avgSpend: Math.round((s.totalSpend / s.visitCount) * 100) / 100 };
  }
  const result = { meta: { lastRegenerated: isoDate(today), lookbackDays }, stats };
  writeJson(historyPath, result);
  return result;
}

// Self-updates favorite_places.json from transactions budget-tracking-pull.mjs
// already fetched this run — zero additional Monarch calls. Silently does
// nothing if favorite_places_raw.json hasn't been synced yet (Task 2 of the
// dining-recommendations plan) rather than erroring the whole pull.
// Month Plan past chips: joint-card dining, plus delivery apps on personal
// cards (DoorDash etc. — still household eating-out), plus charges
// reassigned to joint (e.g. Sora on Kevin's card). jointLabels /
// personalLabels also filter the EXISTING stored array on every run.
export function refreshFavoritePlaces(rawPath, outPath, transactions, today, jointLabels, personalLabels = new Set()) {
  if (!fs.existsSync(rawPath)) return;
  let raw;
  let existing;
  try {
    raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
    existing = fs.existsSync(outPath)
      ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
      : { recentDiningActivity: [] };
  } catch (error) {
    console.error(sanitize(`refreshFavoritePlaces: failed to parse dining data, skipping this run's update: ${error.message}`));
    return;
  }

  // Long-term visit history (see computeFavoritePlacesHistory above) — a
  // separate file, not derived from recentDiningActivity below, since that
  // array is hard-trimmed to a 90-day rolling window every run. Missing file
  // (history never backfilled) degrades to no visitStats on any place, same
  // "missing file degrades quietly" convention as everywhere else in this
  // codebase — recommendForSlot() falls back to its pre-history scoring in
  // that case.
  const historyPath = path.join(path.dirname(rawPath), 'favorite_places_history.json');
  let historyStats = {};
  if (fs.existsSync(historyPath)) {
    try {
      historyStats = JSON.parse(fs.readFileSync(historyPath, 'utf8')).stats || {};
    } catch { /* corrupt history file — degrade to no visitStats rather than fail the whole pull */ }
  }

  // Identity is the transaction's own stable Monarch `id`, not date/merchant/
  // amount/account — a charge's amount legitimately changes between pulls
  // (pending -> posted, e.g. a tip added after the fact) while staying the
  // same real transaction. Keying by amount instead (pre-2026-08-03) meant an
  // amount correction looked like a brand-new transaction and got appended
  // as a duplicate rather than updating the existing entry in place — found
  // via a real live duplicate (Locanda Portofino, 2026-07-30: $171.11 then
  // $201.11 once the tip posted, both retained). Two genuinely separate same-
  // day/same-merchant charges (each with their own real id, e.g. two actual
  // Tu Madre visits in one day) are correctly kept as two entries.
  // Entries recorded before this fix have no `id` even though the real
  // Monarch transaction they represent always has one — the incoming
  // transaction being fetched again will carry an id same as any other, so
  // the composite-key fallback below applies whenever there's no id match,
  // not just when the incoming transaction itself lacks one. Once matched,
  // the id gets backfilled onto the legacy entry so any later amount change
  // to that same transaction goes through the id-matched update path above
  // instead of hitting this fallback (and risking a duplicate) again.
  const byId = new Map();
  const legacyByKey = new Map();
  for (const entry of existing.recentDiningActivity) {
    if (entry.id) byId.set(entry.id, entry);
    else legacyByKey.set(`${entry.date}|${entry.merchant}|${entry.amount}|${entry.account}`, entry);
  }

  const newEntries = [];
  for (const txn of transactions) {
    const amount = spendAmount(txn);
    if (amount === 0) continue;
    if (!countsTowardMonthPlanDining(txn, jointLabels, personalLabels)) continue;
    const account = accountLabel(txn);
    const merchant = merchantName(txn);
    const roundedAmount = Math.round(amount * 100) / 100;
    const id = txn.id || null;

    if (id && byId.has(id)) {
      const entry = byId.get(id);
      // Date: keep whichever of the two is EARLIER, not whatever this pull
      // happens to report. A pending transaction's date is the real moment
      // of spend; once it posts/settles, Monarch can report a later date
      // (the bank's settlement date, not a new spend) — found live
      // (Mendocino Farms: pending 2026-07-30, posted 2026-07-31, same real
      // charge). Amount is the opposite: take the LATEST value, since a
      // pending amount can be a pre-tip estimate and the posted amount is
      // the true final charge (found live: Locanda Portofino, $171.11
      // pending -> $201.11 posted).
      entry.date = entry.date < txn.date ? entry.date : txn.date;
      entry.merchant = merchant;
      entry.amount = roundedAmount;
      entry.account = account;
      entry.matchedPlace = matchFavorite(merchant, raw)?.name ?? null;
      continue;
    }

    const legacyKey = `${txn.date}|${merchant}|${roundedAmount}|${account}`;
    if (legacyByKey.has(legacyKey)) {
      if (id) legacyByKey.get(legacyKey).id = id;
      continue;
    }

    // Pending → posted can mint a *new* Monarch id while keeping the same
    // merchant/amount and shifting the date by a day (found live: Sprout LA
    // $28.75 on 2026-08-02 and again on 2026-08-03, two ids → Month Plan
    // calendar showed the farmers-market charge twice). Collapse into the
    // earlier-dated entry and adopt the newer id so later pulls update in place.
    const pendingPosted = [...byId.values(), ...legacyByKey.values()].find((entry) => {
      if (!entry || entry.merchant !== merchant || entry.account !== account) return false;
      if (Math.abs(entry.amount - roundedAmount) > 0.009) return false;
      if (id && entry.id && entry.id === id) return false;
      const days = Math.abs((new Date(`${entry.date}T12:00:00`) - new Date(`${txn.date}T12:00:00`)) / 86400000);
      // Include same-day (days === 0): Monarch sometimes mints a new id on
      // post without shifting the calendar date (DoorDash ×3 / Mendocino ×2).
      return days <= 2;
    });
    if (pendingPosted) {
      pendingPosted.date = pendingPosted.date < txn.date ? pendingPosted.date : txn.date;
      pendingPosted.amount = roundedAmount;
      pendingPosted.merchant = merchant;
      pendingPosted.account = account;
      pendingPosted.matchedPlace = matchFavorite(merchant, raw)?.name ?? null;
      if (id) {
        if (pendingPosted.id && byId.get(pendingPosted.id) === pendingPosted) byId.delete(pendingPosted.id);
        pendingPosted.id = preferDiningActivityId(pendingPosted.id, id);
        byId.set(pendingPosted.id, pendingPosted);
      }
      continue;
    }

    const match = matchFavorite(merchant, raw);
    const newEntry = {
      id,
      date: txn.date,
      merchant,
      amount: roundedAmount,
      matchedPlace: match ? match.name : null,
      account,
      // Survives the account filter below when the charge lived on a personal
      // card but still counts (delivery apps, or reassigned-to-joint).
      includeOnMonthPlan: true,
    };
    newEntries.push(newEntry);
    if (id) byId.set(id, newEntry);
  }

  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - DINING_LOOKBACK_DAYS);
  // End-of-pass heal: collapse any seed+new-id / pending→posted duplicates
  // already sitting in the accumulating array (same-day or ±2 days). Inline
  // pendingPosted above only catches collisions against *incoming* txns.
  const recentDiningActivity = collapsePendingPostedDiningDuplicates(
    [...existing.recentDiningActivity, ...newEntries]
      .filter((a) => new Date(a.date) >= cutoff && monthPlanDiningAccountOk(a, jointLabels, personalLabels)),
  ).sort((a, b) => a.date.localeCompare(b.date) || String(a.id || '').localeCompare(String(b.id || '')));

  const places = raw.map((f) => {
    const visits = recentDiningActivity.filter((a) => a.matchedPlace === f.name);
    const visitStats = historyStats[f.name] || null;
    if (visits.length) {
      // Recent (90-day) activity exists — use it as the primary cost signal,
      // since it reflects current pricing more accurately than a 2-year
      // average (menu prices drift).
      const avgSpend = Math.round((visits.reduce((s, v) => s + v.amount, 0) / visits.length) * 100) / 100;
      return {
        ...f,
        observed: {
          tier: tierFromAvg(avgSpend),
          avgSpend,
          visitCount: visits.length,
          lastVisited: visits[visits.length - 1].date,
        },
        visitStats,
      };
    }
    // No recent activity, but the 2-year historical backfill (visitStats) may
    // still have real spend data for this place — fall back to that rather
    // than leaving `observed` null just because nothing happened to fall in
    // the last 90 days. Recent activity (above) still wins when both exist.
    if (visitStats && visitStats.visitCount > 0) {
      return {
        ...f,
        observed: {
          tier: tierFromAvg(visitStats.avgSpend),
          avgSpend: visitStats.avgSpend,
          visitCount: visitStats.visitCount,
          lastVisited: visitStats.lastVisitDate,
        },
        visitStats,
      };
    }
    // Hand planningCost (e.g. Terra/Terroni ~$150) when Monarch has no visits yet —
    // surfaces on the Dining tab and Month Plan cost math. Tier stays mid so
    // the place remains eligible for mid routine slots; avgSpend carries the budget.
    if (typeof f.planningCost === 'number' && f.planningCost > 0) {
      return {
        ...f,
        observed: {
          tier: 'mid',
          avgSpend: f.planningCost,
          visitCount: 0,
          lastVisited: null,
        },
        visitStats,
      };
    }
    return { ...f, observed: null, visitStats };
  });

  writeJson(outPath, {
    meta: { lastRegenerated: isoDate(today), lookbackDays: DINING_LOOKBACK_DAYS },
    places,
    recentDiningActivity,
  });
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function weekBucket(txnDate, cycleStart) {
  const dayIdx = Math.floor((txnDate - cycleStart) / 86400000);
  return Math.floor(dayIdx / 7);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

// Separate code path from the daily cycle-scoped pull below — a one-off/
// occasional deep pull (e.g. 2 years), not wired into run-daily-pull.ps1's
// schedule. Reuses the same McpClient connection lifecycle as the normal
// flow, just against a much wider date range and a different Monarch call
// pattern (build long-term visitStats, not this cycle's category totals).
async function runHistoryBackfill(args, tracking, today) {
  const client = new McpClient({ mcpServerExe: args.mcpServerExe, envFile: args.envFile });
  try {
    await client.initialize();
    const startDateObj = new Date(today);
    startDateObj.setDate(startDateObj.getDate() - args.historyBackfillDays);
    const transactions = await fetchTransactions(client, isoDate(startDateObj), isoDate(today), args.limit);

    const jointLabels = new Set(tracking.mapping.jointAccountLabels || []);
    const favoriteRawPath = path.join(path.dirname(args.outputPath), 'favorite_places_raw.json');
    const historyPath = path.join(path.dirname(args.outputPath), 'favorite_places_history.json');
    const result = computeFavoritePlacesHistory(favoriteRawPath, historyPath, transactions, jointLabels, today, args.historyBackfillDays);

    console.log(JSON.stringify({
      ok: true,
      historyBackfill: true,
      transactionCount: transactions.length,
      placesMatched: result ? Object.keys(result.stats).length : 0,
      historyPath,
    }));
  } catch (error) {
    const stderrTail = client.stderrLines.slice(-5);
    if (stderrTail.length > 0) {
      error.message = `${error.message}${os.EOL}MCP stderr tail:${os.EOL}${stderrTail.join(os.EOL)}`;
    }
    throw error;
  } finally {
    client.close();
  }
}

async function runCycleHistoryBackfill(args, tracking, goals, today) {
  const n = args.cycleHistoryBackfillCycles;
  if (!(n > 0)) throw new Error('cycle-history-backfill-cycles must be a positive integer');
  const currentIso = isoDate(currentCycleStart(today));
  const starts = previousJointCycleStarts(currentIso, n);
  const oldest = starts[starts.length - 1];
  const end = currentCycleStart(today);
  end.setDate(end.getDate() - 1);
  const endIso = isoDate(end);
  const target = jointTargetFromGoals(goals, tracking);
  const closedAt = new Date().toISOString();

  const client = new McpClient({ mcpServerExe: args.mcpServerExe, envFile: args.envFile });
  try {
    await client.initialize();
    const transactions = await fetchTransactions(client, oldest, endIso, args.limit);
    const charges = collectJointCharges(transactions, tracking);
    let history = loadCycleHistory(args.cycleHistoryPath);
    // Insert oldest first so each unshift leaves newest at [0] — habits read
    // cycles[0] as the most recently closed cycle.
    for (let i = starts.length - 1; i >= 0; i -= 1) {
      const cycleStart = starts[i];
      const nextStart = i === 0 ? currentIso : starts[i - 1];
      const snapshot = buildSnapshotFromCharges({
        cycleStart,
        cycleDays: cycleDaysBetween(cycleStart, nextStart),
        target,
        charges,
        closedAt,
      });
      if (cycleStart !== starts[0]) snapshot.closeOutSent = true;
      history = archiveClosedCycle(history, snapshot);
    }
    saveCycleHistory(args.cycleHistoryPath, history);
    try {
      const notifyFn = args.closeOutNotifyFn || defaultCloseOutNotifyFn;
      await deliverCloseOuts(args.cycleHistoryPath, { notifyFn });
    } catch (err) {
      console.error('cycle close-out notify failed (backfill still ok):', sanitize(err.message || err));
    }
    console.log(JSON.stringify({
      ok: true,
      cycleHistoryBackfill: true,
      cycles: starts,
      transactionCount: transactions.length,
      path: args.cycleHistoryPath,
    }));
  } catch (error) {
    const stderrTail = client.stderrLines.slice(-5);
    if (stderrTail.length > 0) {
      error.message = `${error.message}${os.EOL}MCP stderr tail:${os.EOL}${stderrTail.join(os.EOL)}`;
    }
    throw error;
  } finally {
    client.close();
  }
}

// One-off/occasional deep pull that fills the ledger backwards, for the
// cycles that closed before the ledger existed (or while it was broken).
// Deliberately its own mode rather than widening the daily fetch window: the
// daily loop's trip matching, its `b < 0` reassignment fold-in, and
// refreshFavoritePlaces all read the same fetched array, so a wider window
// there would quietly change live tracker numbers. This one touches nothing
// but the ledger.
async function runLedgerBackfill(args, tracking, today) {
  const days = args.ledgerBackfillDays;
  if (!(days > 0)) throw new Error('ledger-backfill-days must be a positive integer');
  const startDateObj = new Date(today);
  startDateObj.setDate(startDateObj.getDate() - days);

  const client = new McpClient({ mcpServerExe: args.mcpServerExe, envFile: args.envFile });
  try {
    await client.initialize();
    const transactions = await fetchTransactions(client, isoDate(startDateObj), isoDate(today), args.limit);
    const rows = ledgerRowsFromTransactions(transactions, tracking, { overrides: loadTransactionOverrides() });
    const ledger = upsertLedgerRows(args.transactionsLedgerPath, rows, { asOf: isoDate(today) });
    console.log(JSON.stringify({
      ok: true,
      ledgerBackfill: true,
      days,
      transactionCount: transactions.length,
      rowsUpserted: rows.length,
      ledgerSize: ledger.meta.transactionCount,
      ledgerPath: args.transactionsLedgerPath,
    }));
  } catch (error) {
    const stderrTail = client.stderrLines.slice(-5);
    if (stderrTail.length > 0) {
      error.message = `${error.message}${os.EOL}MCP stderr tail:${os.EOL}${stderrTail.join(os.EOL)}`;
    }
    throw error;
  } finally {
    client.close();
  }
}

async function maybeNotifyCloseOut(args) {
  try {
    const notifyFn = args.closeOutNotifyFn || defaultCloseOutNotifyFn;
    await deliverCloseOuts(args.cycleHistoryPath, { notifyFn });
  } catch (err) {
    console.error('cycle close-out notify failed (budget pull still ok):', sanitize(err.message || err));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, outputPath: args.outputPath }));
    return;
  }

  const launch = resolveMonarchMcpLaunch(args.mcpServerExe);
  if (!fs.existsSync(args.envFile)) throw new Error(`Missing Monarch env file: ${args.envFile}`);
  if (!fs.existsSync(launch.command)) throw new Error(`Missing signed venv Python: ${launch.command}`);
  if (!fs.existsSync(args.outputPath)) throw new Error(`Missing Finances budget_tracking.json at ${args.outputPath}`);
  if (!fs.existsSync(args.goalsPath)) throw new Error(`Missing Finances goals.json at ${args.goalsPath}`);

  const tracking = JSON.parse(fs.readFileSync(args.outputPath, 'utf8'));
  const goals = JSON.parse(fs.readFileSync(args.goalsPath, 'utf8'));
  const today = new Date();

  if (args.historyBackfillDays) {
    await runHistoryBackfill(args, tracking, today);
    return;
  }

  if (args.cycleHistoryBackfillCycles) {
    await runCycleHistoryBackfill(args, tracking, goals, today);
    return;
  }

  if (args.ledgerBackfillDays) {
    await runLedgerBackfill(args, tracking, today);
    return;
  }

  // Snapshot the closed joint cycle before this run overwrites the live file.
  const newCycleStartIso = isoDate(currentCycleStart(today));
  const rolled = maybeArchiveOnRollover(
    loadCycleHistory(args.cycleHistoryPath),
    tracking,
    newCycleStartIso,
    { target: jointTargetFromGoals(goals, tracking) },
  );
  if (rolled.archived) saveCycleHistory(args.cycleHistoryPath, rolled.history);

  const cycleStart = currentCycleStart(today); // joint cycle
  const personalLabelsByOwnerEarly = tracking.mapping?.personalAccountLabels || {};
  const personalCycleByOwner = {};
  for (const ownerId of Object.keys(personalLabelsByOwnerEarly)) {
    personalCycleByOwner[ownerId] = resolvePersonalCycle(today, ownerId, tracking.mapping);
  }
  // Earliest of joint + each personal statement window. A longer personal
  // window is the real cycle, not a ledger-backfill shortcut (AGENTS.md §2).
  const personalStarts = Object.values(personalCycleByOwner).map((c) => c.start);
  const fetchStart = [cycleStart, ...personalStarts].reduce((earliest, d) => (d < earliest ? d : earliest), cycleStart);
  const startDate = isoDate(fetchStart);
  const endDate = isoDate(today);

  const client = new McpClient({ mcpServerExe: args.mcpServerExe, envFile: args.envFile });
  try {
    await client.initialize();
    const transactions = await fetchTransactions(client, startDate, endDate, args.limit);
    const accounts = await fetchAccounts(client);

    const travelCategories = new Set(tracking.mapping.travelCategoryNames.map((c) => c.toLowerCase()));
    const jointLabels = new Set(tracking.mapping.jointAccountLabels || []);
    const personalLabelsByOwner = tracking.mapping.personalAccountLabels || {};
    const labelToOwnerId = new Map();
    for (const [ownerId, labels] of Object.entries(personalLabelsByOwner)) {
      for (const label of labels || []) labelToOwnerId.set(label, ownerId);
    }

    if (!tracking.personal) tracking.personal = {};

    // Per-owner accumulators for personal trackers.
    const personalState = {};
    const ownerDisplay = Object.fromEntries((goals.owners || []).map((o) => [o.id, o.displayName]));
    for (const ownerId of Object.keys(personalLabelsByOwner)) {
      if (!tracking.personal[ownerId]) {
        const name = ownerDisplay[ownerId] || ownerId;
        tracking.personal[ownerId] = {
          label: `${name} personal`,
          targetExpenseKey: `${name} personal`,
          source: 'monarch',
          weeks: [],
          categories: [],
        };
      }
      personalState[ownerId] = {
        buckets: new Map(),
        categoryTotals: new Map(),
        categoryTransactions: new Map(),
      };
    }

    const jointBuckets = new Map();
    const jointCategoryTotals = new Map();
    const jointCategoryTransactions = new Map();
    // Flights/hotels get booked well ahead of the trip itself — matching only
    // the stay window (startDate..endDate) misses every booking charge. Widen
    // to a lookback before startDate too. If two lookback windows both contain
    // a charge, do not guess — unmatched, unless a tripAssignment pins it.
    const overrides = loadTransactionOverrides();
    const trips = buildTripWindows(goals.travel);
    const tripActuals = new Map(trips.map((t) => [t.id, { actual: 0, transactions: [] }]));
    const unmatched = [];

    for (const txn of transactions) {
      const acct = accountLabel(txn);
      const catDisplay = categoryName(txn, overrides) || 'Uncategorized';
      const cat = catDisplay.toLowerCase();
      const txnDate = new Date(txn.date);
      const reassignment = trackerReassignment(txn, overrides);

      // A pinned charge counts against its trip even when Monarch filed it
      // under an ordinary category (airport parking as Transportation) — see
      // tripReroute. Without this it stays on the joint budget forever.
      if (travelCategories.has(cat) || tripReroute(txn, overrides)) {
        // Net spend toward the trip: Monarch spend is negative, credits
        // positive — travelNetSpend flips the sign so a Lufthansa credit
        // reduces Christmas Zagreb (etc.) instead of vanishing (found live
        // 2026-08-09: +$1,617.83 Lufthansa credit was previously dropped
        // because spendAmount() only keeps debits).
        const net = travelNetSpend(txn.amount);
        if (net === 0) continue;
        const summary = {
          date: txn.date,
          merchant: txn.merchant || txn.plaidName || '',
          amount: Math.abs(net),
          ...(transactionId(txn) ? { id: transactionId(txn) } : {}),
          ...(net < 0 ? { type: 'credit' } : {}),
        };
        const resolved = resolveTravelTrip(txn, trips, overrides);
        if (resolved.skip) continue;
        if (resolved.trip) {
          const bucket = tripActuals.get(resolved.trip.id);
          bucket.actual = Math.round((bucket.actual + net) * 100) / 100;
          bucket.transactions.push(summary);
        } else {
          unmatched.push(resolved.ambiguousBetween
            ? { ...summary, ambiguousBetween: resolved.ambiguousBetween }
            : summary);
        }
        continue; // travel never counts toward joint/personal totals
      }

      if (isBalanceMovement(txn, overrides)) continue;
      const amount = spendAmount(txn, overrides);
      if (amount === 0) continue;
      if (reassignment?.reassignTo === 'exclude') continue;
      const summary = { date: txn.date, merchant: txn.merchant || txn.plaidName || '', amount: Math.round(amount * 100) / 100 };

      // The fetch window starts at the EARLIER of the two cycles (see
      // fetchStart above), so it can include days before the joint cycle's
      // own start. Guarding on `b >= 0` makes week buckets and category
      // totals agree. A reassignment overrides which tracker a charge
      // counts toward (reassignTo: "joint" or an owner id for personal).
      let personalOwnerId = null;
      let routeToJoint = false;
      if (reassignment) {
        if (reassignment.reassignTo === 'joint') routeToJoint = true;
        else personalOwnerId = reassignment.reassignTo;
      } else if (labelToOwnerId.has(acct)) {
        personalOwnerId = labelToOwnerId.get(acct);
      } else if (jointLabels.has(acct)) {
        routeToJoint = true;
      }

      if (personalOwnerId && personalState[personalOwnerId]) {
        const state = personalState[personalOwnerId];
        const ownerCycleStart = personalCycleByOwner[personalOwnerId]?.start || currentMonthStart(today);
        let b = weekBucket(txnDate, ownerCycleStart);
        // One-off reassignments from the joint card can land a few days before
        // the personal calendar-month cycle (e.g. Jul 28–30 charges moved to
        // Hanna personal while personal cycle starts Aug 1). Still count them
        // on the current personal panel — fold into week 0 — so they aren't
        // dropped entirely after leaving joint.
        if (b < 0 && reassignment && reassignment.reassignTo === personalOwnerId) b = 0;
        if (b >= 0) {
          state.buckets.set(b, Math.round(((state.buckets.get(b) || 0) + amount) * 100) / 100);
          state.categoryTotals.set(catDisplay, Math.round(((state.categoryTotals.get(catDisplay) || 0) + amount) * 100) / 100);
          if (!state.categoryTransactions.has(catDisplay)) state.categoryTransactions.set(catDisplay, []);
          state.categoryTransactions.get(catDisplay).push(summary);
        }
      } else if (routeToJoint) {
        const b = weekBucket(txnDate, cycleStart);
        if (b >= 0) {
          jointBuckets.set(b, Math.round(((jointBuckets.get(b) || 0) + amount) * 100) / 100);
          jointCategoryTotals.set(catDisplay, Math.round(((jointCategoryTotals.get(catDisplay) || 0) + amount) * 100) / 100);
          if (!jointCategoryTransactions.has(catDisplay)) jointCategoryTransactions.set(catDisplay, []);
          jointCategoryTransactions.get(catDisplay).push(summary);
        }
      }
      // Unmapped accounts (401k, brokerage, savings) stay ignored. Ally checking
      // is a Kevin spend card when listed in personalAccountLabels.
    }

    applyManualCharges(
      personalState,
      overrides.manualCharges,
      Object.fromEntries(Object.entries(personalCycleByOwner).map(([id, c]) => [id, c.start])),
      {
        buckets: jointBuckets,
        categoryTotals: jointCategoryTotals,
        categoryTransactions: jointCategoryTransactions,
      },
      cycleStart,
    );

    // Keep every fetched line item as durable history before the live cycle
    // view is rebuilt over it. Contained like the other side-effect steps: a
    // ledger failure must never fail the money pull — but it is reported, not
    // swallowed, both here and in this run's result JSON (AGENTS.md §2: a
    // broken integration that still reports success is the worst failure mode
    // this project has had).
    let ledgerRowCount = null;
    try {
      const rows = ledgerRowsFromTransactions(transactions, tracking, { overrides, trips });
      upsertLedgerRows(args.transactionsLedgerPath, rows, { asOf: isoDate(today) });
      ledgerRowCount = rows.length;
    } catch (err) {
      console.error('transaction ledger update failed (budget pull still ok):', sanitize(err.message || err));
    }
    try {
      const skipKeys = new Set();
      for (const trip of tracking.travel.trips || []) {
        if (trip.budgetedAmount != null) continue;
        for (const t of trip.transactions || []) skipKeys.add(tripTxnKey(t));
      }
      mergeLedgerIntoTripBuckets(tripActuals, Object.values(loadLedger(args.transactionsLedgerPath).byId || {}), skipKeys, overrides);
      applyTravelCredits(tripActuals, overrides.travelCredits);
    } catch (err) {
      console.error('travel ledger fold-in failed (budget pull still ok):', sanitize(err.message || err));
    }

    const jointRefunds = detectJointRefunds(transactions, jointLabels, travelCategories, cycleStart);

    function bucketsToWeeks(buckets, refCycleStart) {
      const maxBucket = Math.max(-1, ...buckets.keys());
      const weeks = [];
      for (let b = 0; b <= maxBucket; b += 1) {
        const weekStart = new Date(refCycleStart); weekStart.setDate(weekStart.getDate() + b * 7);
        const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
        const cappedEnd = weekEnd > today ? today : weekEnd;
        const days = Math.floor((cappedEnd - weekStart) / 86400000) + 1;
        const label = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${cappedEnd.toLocaleDateString('en-US', { day: 'numeric' })}` + (days < 7 ? ' (partial)' : '');
        weeks.push({ weekOf: label, actual: buckets.get(b) || 0, days });
      }
      return weeks;
    }

    // Sorted descending by amount — drives the dashboard's spend-by-category
    // drill-down. Each category also carries its own transactions (newest
    // first), for that drill-down's own line-item drill-down.
    function categoryTotalsToArray(totals, transactionsByCategory) {
      return [...totals.entries()]
        .map(([name, amount]) => ({
          name,
          amount,
          transactions: (transactionsByCategory.get(name) || []).slice().sort((a, b) => b.date.localeCompare(a.date)),
        }))
        .sort((a, b) => b.amount - a.amount);
    }

    for (const [ownerId, state] of Object.entries(personalState)) {
      const cycle = personalCycleByOwner[ownerId] || resolvePersonalCycle(today, ownerId, tracking.mapping);
      tracking.personal[ownerId].weeks = bucketsToWeeks(state.buckets, cycle.start);
      tracking.personal[ownerId].categories = categoryTotalsToArray(state.categoryTotals, state.categoryTransactions);
      tracking.personal[ownerId].cycleStart = cycle.cycleStart;
      tracking.personal[ownerId].cycleDays = cycle.cycleDays;
      tracking.personal[ownerId].source = 'monarch';
      tracking.personal[ownerId].cardBalances = cardBalancesForLabels(accounts, personalLabelsByOwner[ownerId]);
    }
    if (jointLabels.size > 0) {
      tracking.joint.weeks = bucketsToWeeks(jointBuckets, cycleStart);
      tracking.joint.categories = categoryTotalsToArray(jointCategoryTotals, jointCategoryTransactions);
      tracking.joint.refunds = jointRefunds;
      tracking.joint.source = 'monarch';
      tracking.joint.cycleStart = isoDate(cycleStart);
      tracking.joint.cycleDays = 30;
      tracking.joint.cardBalances = cardBalancesForLabels(accounts, [...jointLabels]);
    }
    // Household corrections (reconcile_tracker) go on LAST, after the weeks
    // above were rebuilt from Monarch — that rebuild is exactly what would
    // otherwise erase a correction made yesterday, which is why the durable
    // record lives in transaction_overrides.json and is re-applied here every
    // morning. Only entries whose cycleStart matches survive, so a correction
    // stops at its own cycle boundary instead of quietly becoming permanent.
    applyBudgetAdjustmentsToTracking(tracking, overrides.budgetAdjustments);

    // Reset every actively-tracked trip (not just ones this run matched) so a
    // trip excluded from matching this time doesn't keep a stale
    // actual/transactions from a previous run. A trip with budgetedAmount:
    // null is already settled (e.g. Boston) with no live-matching mechanism
    // that could ever correctly repopulate it once matched — its bare stay-
    // dates-only window (see the lookbackDays rule above) means a future run
    // can never re-find those original charges, so overwriting it here would
    // silently zero out real, possibly manually-backfilled data. Leave it
    // exactly as it already is in tracking.travel.trips instead.
    for (const trip of tracking.travel.trips) {
      if (trip.budgetedAmount == null) continue;
      const bucket = tripActuals.get(trip.id);
      trip.actual = bucket ? bucket.actual : 0;
      trip.transactions = bucket ? bucket.transactions : [];
    }
    tracking.travel.unmatched = unmatched;
    tracking.meta.lastRegenerated = isoDate(today);

    const favoriteRawPath = path.join(path.dirname(args.outputPath), 'favorite_places_raw.json');
    const favoritePlacesPath = path.join(path.dirname(args.outputPath), 'favorite_places.json');
    const personalLabels = new Set(Object.values(personalLabelsByOwner).flat());
    refreshFavoritePlaces(favoriteRawPath, favoritePlacesPath, transactions, today, jointLabels, personalLabels);

    writeJson(args.outputPath, tracking);

    await maybeNotifyCloseOut(args);

    const buildScript = path.join(path.dirname(args.outputPath), 'build-data.mjs');
    const result = spawnSync(process.execPath, [buildScript], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`build-data.mjs failed with exit code ${result.status}`);

    console.log(JSON.stringify({
      ok: true,
      transactionCount: transactions.length,
      personalOwners: Object.keys(tracking.personal || {}),
      travelUnmatchedCount: unmatched.length,
      ledgerRowsUpserted: ledgerRowCount,
      jointUpdated: jointLabels.size > 0,
      outputPath: args.outputPath,
    }));
  } catch (error) {
    const stderrTail = client.stderrLines.slice(-5);
    if (stderrTail.length > 0) {
      error.message = `${error.message}${os.EOL}MCP stderr tail:${os.EOL}${stderrTail.join(os.EOL)}`;
    }
    throw error;
  } finally {
    client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(sanitize(error.stack || error.message || error));
    process.exit(1);
  });
}
