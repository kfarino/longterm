// Accumulating Oura record store, one JSON file per endpoint.
// Mirrors transactions-store.mjs (meta + byId, upsert by id, never drops rows
// outside the batch, atomic temp-write + rename) with one deviation: sharded
// by endpoint rather than a single flat file. Full-fidelity Oura data across
// all 15 endpoints for two people runs ~10MB/year, concentrated in
// daily_activity (per-minute MET arrays), sleep (5-min phase/HRV arrays) and
// heartrate; one blob would be re-parsed and rewritten every morning and grow
// past 30MB within a few years. Sharding keeps the small collections small and
// drops nothing. See docs/superpowers/specs/2026-08-06-oura-health-signal-design.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Rolling re-fetch window. Oura revises recent days' scores as data lands. */
export const OURA_OVERLAP_DAYS = 30;

/**
 * All 15 v2 endpoints. `date` collections take start_date/end_date; heartrate
 * uniquely takes start_datetime/end_datetime; singletons take neither.
 * Pulling everything is deliberate — see the design doc.
 */
export const OURA_ENDPOINTS = [
  { key: 'daily_sleep', window: 'date' },
  { key: 'daily_readiness', window: 'date' },
  { key: 'daily_activity', window: 'date' },
  { key: 'daily_stress', window: 'date' },
  { key: 'daily_resilience', window: 'date' },
  { key: 'daily_spo2', window: 'date' },
  { key: 'daily_cardiovascular_age', window: 'date' },
  { key: 'vO2_max', window: 'date' },
  { key: 'sleep', window: 'date' },
  { key: 'sleep_time', window: 'date' },
  { key: 'workout', window: 'date' },
  { key: 'session', window: 'date' },
  { key: 'enhanced_tag', window: 'date' },
  { key: 'rest_mode_period', window: 'date' },
  // Oura rejects a heartrate range longer than 30 days outright ("Timerange
  // between start and endtime has to be less than or equal to 30 days", HTTP
  // 400), so a long backfill must be split into chunks. Without this a
  // --backfill-days 730 run silently returns no heart-rate data at all while
  // every other endpoint succeeds.
  { key: 'heartrate', window: 'datetime', maxWindowDays: 30 },
  { key: 'personal_info', window: 'none' },
  { key: 'ring_configuration', window: 'none' },
];

/** Current state, not history — one row per owner, overwritten each pull. */
export const SINGLETON_ENDPOINTS = new Set(['personal_info', 'ring_configuration']);

export function defaultOuraStoreDir() {
  return path.join(repoRoot, 'data', 'oura');
}

export function storePathForEndpoint(endpoint, storeDir = defaultOuraStoreDir()) {
  return path.join(storeDir, `${endpoint}.json`);
}

function writeJson(filePath, data) {
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

export function emptyStore() {
  return {
    meta: {
      description: 'Accumulating Oura records (upsert by id). Never hand-edit; refreshed by oura-pull.mjs.',
      lastUpdated: null,
      recordCount: 0,
    },
    byId: {},
  };
}

export function loadStore(endpoint, storeDir = defaultOuraStoreDir()) {
  const filePath = storePathForEndpoint(endpoint, storeDir);
  if (!fs.existsSync(filePath)) return emptyStore();
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || !parsed.byId) return emptyStore();
    return parsed;
  } catch {
    return emptyStore();
  }
}

/**
 * Three id cases, mirroring transactions-store.mjs's transactionId() fallback:
 * a normal record uses its own uuid; heartrate has no id so it uses its
 * timestamp; singletons key on owner+endpoint alone.
 */
export function ouraRowId(ownerId, endpoint, record) {
  if (SINGLETON_ENDPOINTS.has(endpoint)) return `${ownerId}:${endpoint}`;
  if (record && record.id != null && String(record.id).trim() !== '') {
    return `${ownerId}:${endpoint}:${record.id}`;
  }
  const fallback = record?.timestamp || record?.day || record?.start_datetime || 'unknown';
  return `${ownerId}:${endpoint}:${fallback}`;
}

/** The day a record belongs to — heartrate only carries a timestamp. */
function dayForRecord(record) {
  if (record?.day) return record.day;
  const stamp = record?.timestamp || record?.start_datetime || record?.bedtime_start;
  if (typeof stamp === 'string' && stamp.length >= 10) return stamp.slice(0, 10);
  return null;
}

/** Keeps Oura's record nested under `data` so a record field can't shadow ours. */
export function normalizeRow(ownerId, endpoint, record) {
  return {
    id: ouraRowId(ownerId, endpoint, record),
    ownerId,
    endpoint,
    day: dayForRecord(record),
    data: record,
  };
}

export function upsertOuraRows(endpoint, rows, { storeDir = defaultOuraStoreDir(), asOf = null } = {}) {
  const store = loadStore(endpoint, storeDir);
  if (!store.byId) store.byId = {};
  const now = asOf || new Date().toISOString().slice(0, 10);
  for (const row of rows) {
    if (!row?.id) continue;
    store.byId[row.id] = { ...store.byId[row.id], ...row, updatedAt: now };
  }
  store.meta = store.meta || {};
  store.meta.lastUpdated = now;
  store.meta.recordCount = Object.keys(store.byId).length;
  fs.mkdirSync(storeDir, { recursive: true });
  writeJson(storePathForEndpoint(endpoint, storeDir), store);
  return store;
}

export function queryOura(endpoint, {
  storeDir = defaultOuraStoreDir(), ownerId = null, startDate = null, endDate = null,
} = {}) {
  let rows = Object.values(loadStore(endpoint, storeDir).byId || {});
  if (ownerId) rows = rows.filter((r) => r.ownerId === ownerId);
  if (startDate) rows = rows.filter((r) => r.day && r.day >= startDate);
  if (endDate) rows = rows.filter((r) => r.day && r.day <= endDate);
  rows.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
  return rows;
}
