// Closed joint-cycle snapshots + habit heads-ups for the Telegram bot.
// Live cycle stays in budget_tracking.json; this file is the durable
// history the daily pull writes on 25th rollover. No merchant line items.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegramEnvPath } from './longterm-paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CYCLE_HISTORY_PATH = path.join(here, '..', 'data', 'cycle_history.json');

const MAX_CYCLES = 6;
const LAST_WEEK_SPIKE_SHARE = 0.28;
const WATCH_SHARE_DELTA = 0.08;

function fmtMoney(n) {
  return `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

function isoDateLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseLocal(iso) {
  return new Date(`${iso}T12:00:00`);
}

function formatShort(iso) {
  return parseLocal(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function emptyHistory() {
  return { joint: { cycles: [] } };
}

export function loadCycleHistory(filePath = DEFAULT_CYCLE_HISTORY_PATH) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!data?.joint?.cycles) return emptyHistory();
    return data;
  } catch {
    return emptyHistory();
  }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

export function saveCycleHistory(filePath, history) {
  writeJson(filePath, history);
}

export function snapshotFromJointTracker(tracker, { target = null, closedAt = new Date().toISOString() } = {}) {
  const weeks = (tracker.weeks || []).map((w) => ({
    weekOf: w.weekOf,
    actual: Number(w.actual) || 0,
    days: w.days || 7,
  }));
  const total = weeks.reduce((s, w) => s + w.actual, 0);
  const categories = (tracker.categories || [])
    .map((c) => ({ name: c.name, amount: Number(c.amount) || 0 }))
    .sort((a, b) => b.amount - a.amount);
  return {
    cycleStart: tracker.cycleStart,
    cycleDays: tracker.cycleDays || 30,
    target: target == null ? null : Number(target),
    total: Math.round(total * 100) / 100,
    categories,
    weeks,
    closedAt,
    closeOutSent: false,
  };
}

export function archiveClosedCycle(history, snapshot, { maxCycles = MAX_CYCLES } = {}) {
  const existing = (history?.joint?.cycles || []).find((c) => c.cycleStart === snapshot.cycleStart);
  const next = { ...snapshot };
  if (existing?.closeOutSent) next.closeOutSent = true;
  const cycles = [...(history?.joint?.cycles || [])].filter((c) => c.cycleStart !== snapshot.cycleStart);
  cycles.unshift(next);
  return { joint: { cycles: cycles.slice(0, maxCycles) } };
}

export function maybeArchiveOnRollover(history, tracking, newCycleStartIso, { target, closedAt } = {}) {
  const joint = tracking?.joint;
  if (!joint?.cycleStart || joint.cycleStart === newCycleStartIso) {
    return { history: history || emptyHistory(), archived: null };
  }
  const hasData = (joint.weeks || []).length > 0 || (joint.categories || []).length > 0;
  if (!hasData) return { history: history || emptyHistory(), archived: null };
  const archived = snapshotFromJointTracker(joint, { target, closedAt });
  return { history: archiveClosedCycle(history || emptyHistory(), archived), archived };
}

export function deriveJointHabits(cycles) {
  const list = cycles || [];
  if (!list.length) {
    return { sampleSize: 0, lastWeekSpike: false, lastWeekCategory: null, usualShares: {} };
  }
  const last = list[0];
  const total = last.total || 0;
  const weeks = last.weeks || [];
  const lastWeek = weeks[weeks.length - 1];
  const lastWeekShare = total > 0 && lastWeek ? lastWeek.actual / total : 0;
  const lastWeekSpike = weeks.length >= 3 && lastWeekShare >= LAST_WEEK_SPIKE_SHARE;
  const lastWeekCategory = (last.categories && last.categories[0]?.name) || null;

  const sums = {};
  const counts = {};
  for (const cycle of list) {
    const cycleTotal = cycle.total || 0;
    if (!(cycleTotal > 0)) continue;
    for (const cat of cycle.categories || []) {
      sums[cat.name] = (sums[cat.name] || 0) + cat.amount / cycleTotal;
      counts[cat.name] = (counts[cat.name] || 0) + 1;
    }
  }
  const usualShares = {};
  for (const name of Object.keys(sums)) usualShares[name] = sums[name] / counts[name];

  return { sampleSize: list.length, lastWeekSpike, lastWeekCategory, lastWeekShare, usualShares };
}

export function habitHeadsUp(habits) {
  if (!habits?.lastWeekSpike) return null;
  if (habits.lastWeekCategory) {
    return `Last cycle the last week ran hot on ${habits.lastWeekCategory}.`;
  }
  return 'Last cycle the last week was a bigger share of spend than the rest.';
}

export function thisCycleWatchCategory(liveCategories, liveTotal, habits) {
  if (!habits?.sampleSize || !(liveTotal > 0)) return null;
  let best = null;
  let bestDelta = 0;
  for (const cat of liveCategories || []) {
    const share = cat.amount / liveTotal;
    const usual = habits.usualShares[cat.name] || 0;
    const delta = share - usual;
    if (delta >= WATCH_SHARE_DELTA && delta > bestDelta) {
      best = cat.name;
      bestDelta = delta;
    }
  }
  return best;
}

export function closeOutText(snapshot, habits) {
  const start = formatShort(snapshot.cycleStart);
  const endDate = parseLocal(snapshot.cycleStart);
  endDate.setDate(endDate.getDate() + (snapshot.cycleDays || 30) - 1);
  const end = endDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const targetBit = snapshot.target != null ? ` of ${fmtMoney(snapshot.target)} target` : '';
  const hot = snapshot.categories?.[0]?.name;
  const lines = [
    `Joint cycle closed (${start}–${end}): ${fmtMoney(snapshot.total)}${targetBit}.`,
  ];
  if (hot) lines.push(`Hottest category: ${hot}.`);
  if (habits?.lastWeekSpike && habits.lastWeekCategory) {
    lines.push(`Last week ran hot on ${habits.lastWeekCategory} — watch that into the next cycle.`);
  }
  return lines.join(' ');
}

export function newestUnsentCloseOut(history) {
  return (history?.joint?.cycles || []).find((c) => !c.closeOutSent) || null;
}

export function markCloseOutSent(history, cycleStart) {
  const cycles = (history?.joint?.cycles || []).map((c) => (
    c.cycleStart === cycleStart ? { ...c, closeOutSent: true } : c
  ));
  return { joint: { cycles } };
}

export async function deliverCloseOuts(historyPath, { notifyFn } = {}) {
  let history = loadCycleHistory(historyPath);
  const pending = newestUnsentCloseOut(history);
  if (!pending || !notifyFn) return { sent: false };
  const text = closeOutText(pending, deriveJointHabits([pending]));
  try {
    await notifyFn(text);
  } catch {
    return { sent: false, error: true };
  }
  history = markCloseOutSent(history, pending.cycleStart);
  saveCycleHistory(historyPath, history);
  return { sent: true, cycleStart: pending.cycleStart };
}

export function previousJointCycleStarts(currentStartIso, n) {
  const out = [];
  const d = parseLocal(currentStartIso);
  for (let i = 0; i < n; i += 1) {
    d.setMonth(d.getMonth() - 1);
    d.setDate(25);
    out.push(isoDateLocal(d));
  }
  return out;
}

export function cycleDaysBetween(startIso, nextStartIso) {
  const a = parseLocal(startIso);
  const b = parseLocal(nextStartIso);
  return Math.round((b - a) / 86400000);
}

export function buildSnapshotFromCharges({ cycleStart, cycleDays, target, charges, closedAt }) {
  const start = parseLocal(cycleStart);
  const buckets = new Map();
  const categoryTotals = new Map();
  for (const charge of charges || []) {
    const amount = Number(charge.amount) || 0;
    if (!(amount > 0) || !charge.date) continue;
    const txnDate = parseLocal(charge.date);
    const dayIdx = Math.floor((txnDate - start) / 86400000);
    if (dayIdx < 0 || dayIdx >= cycleDays) continue;
    const b = Math.floor(dayIdx / 7);
    buckets.set(b, Math.round(((buckets.get(b) || 0) + amount) * 100) / 100);
    const name = charge.category || 'Uncategorized';
    categoryTotals.set(name, Math.round(((categoryTotals.get(name) || 0) + amount) * 100) / 100);
  }
  const maxBucket = Math.max(-1, ...buckets.keys());
  const weeks = [];
  for (let b = 0; b <= maxBucket; b += 1) {
    const weekStart = new Date(start); weekStart.setDate(weekStart.getDate() + b * 7);
    const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6);
    const cycleEnd = new Date(start); cycleEnd.setDate(cycleEnd.getDate() + cycleDays - 1);
    const cappedEnd = weekEnd > cycleEnd ? cycleEnd : weekEnd;
    const days = Math.floor((cappedEnd - weekStart) / 86400000) + 1;
    const label = `${weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${cappedEnd.toLocaleDateString('en-US', { day: 'numeric' })}`;
    weeks.push({ weekOf: label, actual: buckets.get(b) || 0, days });
  }
  const categories = [...categoryTotals.entries()]
    .map(([name, amount]) => ({ name, amount }))
    .sort((a, b) => b.amount - a.amount);
  const total = weeks.reduce((s, w) => s + w.actual, 0);
  return {
    cycleStart,
    cycleDays,
    target: target == null ? null : Number(target),
    total: Math.round(total * 100) / 100,
    categories,
    weeks,
    closedAt: closedAt || new Date().toISOString(),
    closeOutSent: false,
  };
}

function readLocalEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) return values;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return values;
}

export async function defaultCloseOutNotifyFn(text) {
  const envValues = readLocalEnv(telegramEnvPath());
  const token = envValues.TELEGRAM_BOT_TOKEN;
  const chatId = envValues.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) throw new Error('telegram env missing for cycle close-out');
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  const json = await res.json();
  if (!json.ok) throw new Error('Telegram rejected cycle close-out');
}

export function loadBudgetHabits(cycleHistoryPath, liveCategories, liveTotal) {
  const history = loadCycleHistory(cycleHistoryPath);
  const habits = deriveJointHabits(history.joint.cycles);
  return {
    ...habits,
    headsUp: habitHeadsUp(habits),
    watchCategory: thisCycleWatchCategory(liveCategories, liveTotal, habits),
  };
}
