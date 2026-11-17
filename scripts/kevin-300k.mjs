// Kevin's cash-flow climb: Hero base + Helios hours toward a pre-tax target.
// Pure math — no fs. Hours come from summarizeHeliosHours (Monday–Sunday
// weeks; the average is the last 4 finished weeks) or a planned
// hoursPerWeek fallback on the config. Illiquid equity is not in this number.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function defaultHeliosTimeLogPath() {
  return path.join(here, '..', '..', 'Helios', 'data', 'time-log.json');
}

export function computeKevin300k(cfg, hoursPerWeek) {
  const base = Number(cfg?.basePreTax);
  const target = Number(cfg?.targetPreTax);
  const rate = Number(cfg?.hourlyRate);
  if (!(base > 0) || !(target > base) || !(rate > 0)) return null;
  const hrs = Number(hoursPerWeek);
  const weekly = Number.isFinite(hrs) && hrs >= 0 ? hrs : Number(cfg.hoursPerWeek) || 0;
  const needYear = target - base;
  const overlayYear = weekly * 52 * rate;
  const current = base + overlayYear;
  const billCapMonthly = Number(cfg.billCapMonthly) || 0;
  const billCapYear = billCapMonthly * 12;
  const atBillCap = base + billCapYear;
  const hoursNeedWeek = needYear / (rate * 52);
  const climbPct = Math.min(100, Math.max(0, (overlayYear / needYear) * 100));
  const capPct = needYear > 0 ? Math.min(100, Math.max(0, (billCapYear / needYear) * 100)) : 0;
  return {
    base,
    target,
    rate,
    hoursPerWeek: weekly,
    hoursNeedWeek,
    overlayYear,
    overlayMonthly: overlayYear / 12,
    current,
    billCapMonthly,
    billCapYear,
    atBillCap,
    cleared: current >= target - 0.5,
    gap: target - current,
    climbPct,
    capPct,
  };
}

const FINISHED_WEEKS = 4;

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseIso(iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

function addDays(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() + n);
  return d;
}

/** Monday of the calendar week that contains date. Weeks are Monday–Sunday. */
function mondayOf(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const weekday = d.getDay();
  const back = weekday === 0 ? 6 : weekday - 1;
  d.setDate(d.getDate() - back);
  return d;
}

function roundHours(n) {
  return Math.round(n * 100) / 100;
}

export function summarizeHeliosHours(log, asOf = new Date()) {
  const entries = Array.isArray(log?.entries) ? log.entries : null;
  if (!entries) {
    return { source: 'missing', hoursThisWeek: null, weeks: [], hoursPerWeek: null };
  }
  const today = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  const thisMonday = mondayOf(today);
  const thisKey = isoDate(thisMonday);
  const buckets = new Map();
  for (let i = 1; i <= FINISHED_WEEKS; i++) {
    buckets.set(isoDate(addDays(thisMonday, -7 * i)), 0);
  }
  let hoursThisWeek = 0;
  for (const row of entries) {
    const hrs = Number(row?.hours);
    if (!(hrs > 0)) continue;
    const when = parseIso(row.date);
    if (!when || when > today) continue;
    const key = isoDate(mondayOf(when));
    if (key === thisKey) {
      hoursThisWeek += hrs;
      continue;
    }
    if (buckets.has(key)) buckets.set(key, buckets.get(key) + hrs);
  }
  const weeks = [...buckets.entries()].map(([start, hours]) => ({
    start,
    end: isoDate(addDays(parseIso(start), 6)),
    hours: roundHours(hours),
  }));
  const avg = weeks.reduce((sum, week) => sum + week.hours, 0) / weeks.length;
  return {
    source: 'helios',
    hoursThisWeek: roundHours(hoursThisWeek),
    weeks,
    hoursPerWeek: roundHours(avg),
  };
}

export function heliosTimeLogPath() {
  return process.env.HELIOS_TIME_LOG || defaultHeliosTimeLogPath();
}

export function readHeliosHours(logPath = heliosTimeLogPath(), asOf = new Date()) {
  if (!logPath || !fs.existsSync(logPath)) return summarizeHeliosHours(null, asOf);
  try {
    return summarizeHeliosHours(JSON.parse(fs.readFileSync(logPath, 'utf8')), asOf);
  } catch {
    return summarizeHeliosHours(null, asOf);
  }
}

export function loadKevin300kTracker(goals, hours) {
  const cfg = goals?.kevin300k;
  const weekly = hours?.hoursPerWeek != null ? hours.hoursPerWeek : cfg?.hoursPerWeek;
  const tracker = computeKevin300k(cfg, weekly);
  if (!tracker) return null;
  return {
    ...tracker,
    hoursThisWeek: hours?.hoursThisWeek ?? null,
    weeks: Array.isArray(hours?.weeks) ? hours.weeks : [],
    hoursSource: hours?.source || 'goals',
  };
}
