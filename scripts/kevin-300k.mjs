// Kevin's cash-flow climb: Hero base + Helios hours toward a pre-tax target.
// Pure math — no fs. Hours come from summarizeHeliosHours or a planned
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

function daysAgo(asOf, iso) {
  const [y, m, d] = String(iso || '').split('-').map(Number);
  if (!y || !m || !d) return Infinity;
  const then = new Date(y, m - 1, d);
  const start = new Date(asOf.getFullYear(), asOf.getMonth(), asOf.getDate());
  return (start - then) / 86400000;
}

export function summarizeHeliosHours(log, asOf = new Date()) {
  const entries = Array.isArray(log?.entries) ? log.entries : null;
  if (!entries) {
    return { source: 'missing', hours7: 0, hours28: 0, hoursPerWeek: null };
  }
  let hours7 = 0;
  let hours28 = 0;
  for (const row of entries) {
    const hrs = Number(row?.hours);
    if (!(hrs > 0)) continue;
    const ago = daysAgo(asOf, row.date);
    if (ago < 0 || ago > 28) continue;
    hours28 += hrs;
    if (ago <= 7) hours7 += hrs;
  }
  return {
    source: 'helios',
    hours7: Math.round(hours7 * 100) / 100,
    hours28: Math.round(hours28 * 100) / 100,
    hoursPerWeek: Math.round((hours28 / 4) * 100) / 100,
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
    hours7: hours?.hours7 ?? null,
    hoursSource: hours?.source || 'goals',
  };
}
