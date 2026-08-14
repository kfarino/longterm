#!/usr/bin/env node
// Pulls current-cycle transactions from Monarch and refreshes
// Longterm/data/budget_tracking.json's joint/Kevin-personal/travel trackers.
// Sibling to networth-pull.mjs in this same folder (same JSON-RPC/auth/
// sanitize/atomic-write pattern), calling get_transactions instead of
// get_accounts. Part of this project's own self-contained daily pull —
// see run-daily-pull.ps1 and install-scheduled-task.ps1 in this same folder.
//
// Runs monarch-mcp-jamiew from a persistent local venv (~/.longterm/monarch-mcp-venv)
// rather than via `uvx`/`uv` — see networth-pull.mjs's header for why.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { monarchEnvPath, monarchMcpExePath } from './longterm-paths.mjs';

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
    this.proc = spawn(mcpServerExe, [], {
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
    out.push({ label, balance: Math.round(balance * 100) / 100 });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
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
  if (!fs.existsSync(filePath)) {
    return { categoryRules: [], reassignments: [], amountRules: [], manualCharges: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      categoryRules: raw.categoryRules || [],
      reassignments: raw.reassignments || [],
      amountRules: raw.amountRules || [],
      // Phantom / not-yet-in-Monarch spend that should still hit a personal
      // tracker (e.g. cash/Venmo RAM buy). Merged after the Monarch loop;
      // skipped when Monarch already has the same date+merchant+amount.
      manualCharges: raw.manualCharges || [],
    };
  } catch {
    return { categoryRules: [], reassignments: [], amountRules: [], manualCharges: [] };
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
  const fromFile = (rules.categoryRules || []).find((o) => merchant.includes(String(o.merchantMatch || '').toLowerCase()));
  if (fromFile?.category) return fromFile.category;
  const fromCode = MERCHANT_CATEGORY_OVERRIDES.find((o) => merchant.includes(o.match));
  if (fromCode) return fromCode.category;
  if (typeof transaction.category === 'string') return transaction.category;
  return transaction.category?.name || '';
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

/**
 * Merge not-yet-in-Monarch personal charges into the per-owner accumulators.
 * Skips when Monarch already logged the same date + merchant + amount on that
 * owner (so a later pull that catches the real charge does not double-count).
 */
export function applyManualCharges(personalState, manualCharges, personalCycleStart) {
  for (const charge of manualCharges || []) {
    const ownerId = charge?.owner;
    const state = ownerId && personalState[ownerId];
    if (!state) continue;
    const amount = Math.round(Math.abs(Number(charge.amount)) * 100) / 100;
    if (!(amount > 0) || !charge.date || !charge.merchant) continue;
    const catDisplay = charge.category || 'Uncategorized';
    const summary = { date: charge.date, merchant: charge.merchant, amount };
    const already = [...state.categoryTransactions.values()].flat().some(
      (t) => t.date === summary.date
        && String(t.merchant).toLowerCase() === String(summary.merchant).toLowerCase()
        && Math.abs(Number(t.amount) - amount) < 0.01,
    );
    if (already) continue;
    const txnDate = new Date(`${charge.date}T12:00:00`);
    const b = weekBucket(txnDate, personalCycleStart);
    if (b < 0) continue;
    state.buckets.set(b, Math.round(((state.buckets.get(b) || 0) + amount) * 100) / 100);
    state.categoryTotals.set(catDisplay, Math.round(((state.categoryTotals.get(catDisplay) || 0) + amount) * 100) / 100);
    if (!state.categoryTransactions.has(catDisplay)) state.categoryTransactions.set(catDisplay, []);
    state.categoryTransactions.get(catDisplay).push(summary);
  }
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

// Kevin's personal Chase cards have no Barclays-style statement-period
// convention to mirror — calendar-month-to-date is the only assumption that
// doesn't arbitrarily exclude real recent spend (e.g. a 25th-cycle boundary
// would cut off spend from the 24th even though it's clearly current).
function currentMonthStart(today) {
  return new Date(today.getFullYear(), today.getMonth(), 1);
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
// but the fetched transaction window can start up to ~24 days earlier than
// cycleStart (it's min(cycleStart, personalCycleStart), and personalCycleStart
// is always the 1st of the month while cycleStart is the 25th) — without this
// filter a refund from the tail end of the PRIOR cycle would leak into "this
// cycle"'s refunds list. Any transaction dated before cycleStart is skipped.
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

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, outputPath: args.outputPath }));
    return;
  }

  if (!fs.existsSync(args.envFile)) throw new Error(`Missing Monarch env file: ${args.envFile}`);
  if (!fs.existsSync(args.mcpServerExe)) throw new Error(`Missing monarch-mcp-jamiew console script: ${args.mcpServerExe}`);
  if (!fs.existsSync(args.outputPath)) throw new Error(`Missing Finances budget_tracking.json at ${args.outputPath}`);
  if (!fs.existsSync(args.goalsPath)) throw new Error(`Missing Finances goals.json at ${args.goalsPath}`);

  const tracking = JSON.parse(fs.readFileSync(args.outputPath, 'utf8'));
  const goals = JSON.parse(fs.readFileSync(args.goalsPath, 'utf8'));
  const today = new Date();

  if (args.historyBackfillDays) {
    await runHistoryBackfill(args, tracking, today);
    return;
  }

  const cycleStart = currentCycleStart(today); // joint cycle
  const personalCycleStart = currentMonthStart(today); // personal trackers (calendar month)
  const fetchStart = cycleStart < personalCycleStart ? cycleStart : personalCycleStart;
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
    // to a lookback before startDate too. Trips here are spaced far enough
    // apart that overlap is rare, but if two lookback windows both contain a
    // charge, attribute it to whichever trip happens soonest (you book your
    // nearest trip first).
    const BOOKING_LOOKBACK_DAYS = 300;
    const trips = goals.travel
      // A trip needs dates to be a match candidate at all. It's still a
      // candidate even with no budgetedAmount (e.g. Boston, already paid) —
      // family-trip charges (on either card) should still route to it
      // instead of polluting joint/personal totals, per Kevin: Boston is a
      // family trip even though it happened to be booked on his own card.
      .filter((t) => t.startDate && t.endDate)
      .map((t) => {
        const start = new Date(t.startDate);
        // A trip with no budgetedAmount is already fully settled (e.g. Boston,
        // "Already paid") — its booking activity is done, so it only matches
        // its own stay dates. Widening its lookback too would make it compete
        // with real upcoming trips (Zagreb, Europe, ...) for every new charge
        // that happens to fall within its broad pre-trip window, exactly the
        // collision that mis-flagged real Zagreb charges as ambiguous.
        const lookbackDays = t.budgetedAmount != null ? BOOKING_LOOKBACK_DAYS : 0;
        const bookingStart = new Date(start); bookingStart.setDate(bookingStart.getDate() - lookbackDays);
        return { ...t, start, end: new Date(t.endDate), bookingStart };
      });
    const tripActuals = new Map(trips.map((t) => [t.id, { actual: 0, transactions: [] }]));
    const unmatched = [];

    for (const txn of transactions) {
      const acct = accountLabel(txn);
      const catDisplay = categoryName(txn) || 'Uncategorized';
      const cat = catDisplay.toLowerCase();
      const txnDate = new Date(txn.date);
      const reassignment = trackerReassignment(txn);

      if (travelCategories.has(cat)) {
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
          ...(net < 0 ? { type: 'credit' } : {}),
        };
        // If more than one trip's window contains this charge, don't guess —
        // flag it for manual review instead of risking silent misattribution.
        const candidates = trips.filter((t) => txnDate >= t.bookingStart && txnDate <= t.end);
        if (candidates.length === 1) {
          const bucket = tripActuals.get(candidates[0].id);
          bucket.actual = Math.round((bucket.actual + net) * 100) / 100;
          bucket.transactions.push(summary);
        } else if (candidates.length > 1) {
          unmatched.push({ ...summary, ambiguousBetween: candidates.map((t) => t.id) });
        } else {
          unmatched.push(summary);
        }
        continue; // travel never counts toward joint/personal totals
      }

      const amount = spendAmount(txn);
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
        let b = weekBucket(txnDate, personalCycleStart);
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
      // Anything else (Ally, Vanguard, Trinet, Ascensus, etc.) isn't a spend card — ignored here.
    }

    const overrides = loadTransactionOverrides();
    applyManualCharges(personalState, overrides.manualCharges, personalCycleStart);

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
    // drill-down. Each category also carries its own transactions (sorted
    // chronologically), for that drill-down's own line-item drill-down.
    function categoryTotalsToArray(totals, transactionsByCategory) {
      return [...totals.entries()]
        .map(([name, amount]) => ({
          name,
          amount,
          transactions: (transactionsByCategory.get(name) || []).slice().sort((a, b) => a.date.localeCompare(b.date)),
        }))
        .sort((a, b) => b.amount - a.amount);
    }

    for (const [ownerId, state] of Object.entries(personalState)) {
      tracking.personal[ownerId].weeks = bucketsToWeeks(state.buckets, personalCycleStart);
      tracking.personal[ownerId].categories = categoryTotalsToArray(state.categoryTotals, state.categoryTransactions);
      tracking.personal[ownerId].cycleStart = isoDate(personalCycleStart);
      tracking.personal[ownerId].cycleDays = daysInMonth(today);
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

    const buildScript = path.join(path.dirname(args.outputPath), 'build-data.mjs');
    const result = spawnSync(process.execPath, [buildScript], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`build-data.mjs failed with exit code ${result.status}`);

    console.log(JSON.stringify({
      ok: true,
      transactionCount: transactions.length,
      personalOwners: Object.keys(tracking.personal || {}),
      travelUnmatchedCount: unmatched.length,
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
