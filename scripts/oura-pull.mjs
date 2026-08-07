#!/usr/bin/env node
// Durable daily Oura pull. Replaces the original connect-sketch (which wrote a
// snapshot to data/oura/<owner>-latest.json and existed only to inventory what
// the API returns). Fetches every v2 endpoint (15 dated collections plus the 2
// singletons — see OURA_ENDPOINTS) over a rolling window and
// upserts into the per-endpoint accumulating store, so a day Oura later
// re-scores is corrected in place rather than duplicated or silently replaced.
//
// Usage:
//   node scripts/oura-pull.mjs --all
//   node scripts/oura-pull.mjs --owner <id> --backfill-days 730
//   node scripts/oura-pull.mjs --all --dry-run
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getValidAccessToken, ouraGet } from './oura-client.mjs';
import { ouraOwnerEnvPath } from './longterm-paths.mjs';
import {
  OURA_ENDPOINTS, OURA_OVERLAP_DAYS, defaultOuraStoreDir, normalizeRow, upsertOuraRows,
} from './oura-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

function ymd(d) { return d.toISOString().slice(0, 10); }

function loadOwnerIdsFromGoals() {
  const goalsPath = path.join(repoRoot, 'data', 'goals.json');
  if (!fs.existsSync(goalsPath)) return [];
  try {
    return (JSON.parse(fs.readFileSync(goalsPath, 'utf8')).owners || []).map((o) => o.id).filter(Boolean);
  } catch {
    return [];
  }
}

export function windowQuery(endpoint, days, now) {
  const end = new Date(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  if (endpoint.window === 'none') return {};
  if (endpoint.window === 'datetime') {
    return { start_datetime: `${ymd(start)}T00:00:00+00:00`, end_datetime: `${ymd(end)}T23:59:59+00:00` };
  }
  return { start_date: ymd(start), end_date: ymd(end) };
}

/**
 * Splits a request window into as many chunks as the endpoint's own server-side
 * limit requires. Most endpoints have none and yield a single query; heartrate
 * caps at 30 days and would otherwise 400 for any longer backfill, losing every
 * heart-rate record while the rest of the pull looks perfectly healthy.
 * @returns {object[]} one query object per request to make, oldest window last
 */
export function windowChunks(endpoint, days, now) {
  const max = endpoint.maxWindowDays;
  if (!max || days <= max) return [windowQuery(endpoint, days, now)];

  const chunks = [];
  let remaining = days;
  let chunkEnd = new Date(now);
  while (remaining > 0) {
    const size = Math.min(max, remaining);
    chunks.push(windowQuery(endpoint, size, chunkEnd));
    chunkEnd = new Date(chunkEnd);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() - size);
    remaining -= size;
  }
  return chunks;
}

/** A singleton returns a bare object; a dated collection returns { data: [...] }. */
export function recordsFrom(body) {
  if (body == null) return [];
  if (Array.isArray(body.data)) return body.data;
  if (typeof body === 'object') return [body];
  return [];
}

export async function pullOwner(ownerId, {
  days = OURA_OVERLAP_DAYS,
  storeDir = defaultOuraStoreDir(),
  ouraGetFn = null,
  accessToken = null,
  now = new Date(),
  dryRun = false,
} = {}) {
  const token = accessToken || (ouraGetFn ? null : await getValidAccessToken(ownerId));
  const get = ouraGetFn || ((suffix, query) => ouraGet(token, suffix, query));
  const asOf = ymd(new Date(now));
  const result = { ownerId, endpoints: {} };

  for (const endpoint of OURA_ENDPOINTS) {
    try {
      const records = [];
      for (const query of windowChunks(endpoint, days, now)) {
        records.push(...recordsFrom(await get(endpoint.key, query)));
      }
      const rows = records.map((r) => normalizeRow(ownerId, endpoint.key, r));
      // An endpoint with nothing to return is empty, not an error — a newly
      // set-up ring reports zero for daily_activity/sleep/heartrate for days.
      if (!dryRun && rows.length) upsertOuraRows(endpoint.key, rows, { storeDir, asOf });
      result.endpoints[endpoint.key] = { count: records.length, upserted: dryRun ? 0 : rows.length, error: null };
    } catch (err) {
      result.endpoints[endpoint.key] = { count: 0, upserted: 0, error: err.message || String(err) };
    }
  }
  return result;
}

export async function runPull({
  ownerIds = null, days = OURA_OVERLAP_DAYS, storeDir = defaultOuraStoreDir(), dryRun = false, now = new Date(),
} = {}) {
  const ids = ownerIds || loadOwnerIdsFromGoals().filter((id) => fs.existsSync(ouraOwnerEnvPath(id)));
  const results = [];
  for (const id of ids) {
    results.push(await pullOwner(id, { days, storeDir, dryRun, now }));
  }
  return results;
}

function parseArgs(argv) {
  const args = { ownerId: null, all: false, days: OURA_OVERLAP_DAYS, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--owner' && argv[i + 1]) args.ownerId = argv[++i];
    else if (a === '--all') args.all = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--backfill-days' && argv[i + 1]) args.days = Math.max(1, Number(argv[++i]) || OURA_OVERLAP_DAYS);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.ownerId && !args.all) {
    console.error('Usage: node scripts/oura-pull.mjs --all [--backfill-days N] [--dry-run]');
    console.error('       node scripts/oura-pull.mjs --owner <id> [--backfill-days N] [--dry-run]');
    process.exit(1);
  }
  const results = await runPull({
    ownerIds: args.ownerId ? [args.ownerId] : null,
    days: args.days,
    dryRun: args.dryRun,
  });
  if (!results.length) {
    console.error('No owners with Oura tokens found. Run `npm run oura:auth -- --owner <id>` first.');
    process.exit(1);
  }
  for (const r of results) {
    const failed = Object.entries(r.endpoints).filter(([, v]) => v.error);
    const found = Object.values(r.endpoints).reduce((s, v) => s + v.count, 0);
    const total = Object.values(r.endpoints).reduce((s, v) => s + v.upserted, 0);
    console.log(`${r.ownerId}: ${found} record(s) found, ${total} upserted across ${OURA_ENDPOINTS.length} endpoints`
      + (failed.length ? `; ${failed.length} endpoint error(s): ${failed.map(([k]) => k).join(', ')}` : ''));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
