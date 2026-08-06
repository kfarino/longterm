# Oura Health Signal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull all Oura data into an accumulating local store, derive a "who is depleted this week" signal from each person's own rolling baseline, and let that signal shape the weekend dining suggestions in the Thursday Telegram recap.

**Architecture:** A new `oura-store.mjs` (upsert-by-id, sharded one file per endpoint, mirroring `transactions-store.mjs`) fed by a rewritten `oura-pull.mjs`; a read-only `health-context.mjs` (mirroring `financial-context.mjs`) that applies durable overrides and computes depletion; and thin wiring into `telegram-bot-recap.mjs` plus one new read-only bot tool. The existing `oura-client.mjs` / `oura-auth-setup.mjs` OAuth layer is reused unchanged.

**Tech Stack:** Node.js ESM (`.mjs`), hand-rolled `assert/strict` test runners (no test framework), PowerShell for the scheduled-task wrapper — all matching existing conventions in `scripts/`.

**Design doc:** `docs/superpowers/specs/2026-08-06-oura-health-signal-design.md` — read this first for the "why" behind every choice below (personal baseline not absolute threshold, Thursday-only swap, Fri/Sat only, recap-only wiring, sharded store).

## Global Constraints

- **No real household data leaves the machine.** Per `AGENTS.md` §0: no real sleep scores, dates, or figures in any commit, test fixture, example file, commit message, or doc. Invent all fixture values. `npm run check:secrets` must pass before every commit.
- **A missing night is an absent record, never a zero.** A night the ring wasn't worn must never be readable as a bad night. This is the single most important correctness rule in this plan.
- Every loader degrades quietly to an empty default on a missing/unparseable file — the established convention in `financial-context.mjs`, `calendar-read.mjs`, and `telegram-bot-recap.mjs`.
- Every write is atomic: temp file + `fs.renameSync`, copied from `transactions-store.mjs`'s `writeJson`.
- Upsert never deletes ids outside the current batch.
- Tests inject `now` and any client — no real network calls, no reliance on the real clock for date-sensitive assertions.
- Only `telegram-bot-recap.mjs` ever passes `depletion` into `diningContext`. The interactive bot and the dashboard must remain unaffected.
- `data/health_overrides.json` and `data/oura/*` are gitignored (already present in `.gitignore`); `examples/health_overrides.example.json` is committed.
- Owner ids always come from `goals.json`'s `owners[].id` — never hardcoded.

---

### Task 1: `oura-store.mjs` — accumulating per-endpoint store

**Files:**
- Create: `scripts/oura-store.mjs`
- Test: `data/test-oura-store.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `defaultOuraStoreDir()`, `storePathForEndpoint(endpoint, storeDir?)`, `emptyStore()`, `loadStore(endpoint, storeDir?)`, `ouraRowId(ownerId, endpoint, record)`, `normalizeRow(ownerId, endpoint, record)`, `upsertOuraRows(endpoint, rows, { storeDir, asOf })`, `queryOura(endpoint, { storeDir, ownerId, startDate, endDate })`, and the constants `OURA_OVERLAP_DAYS = 30`, `OURA_ENDPOINTS` (array of 15 endpoint descriptors), `SINGLETON_ENDPOINTS` (Set).

- [ ] **Step 1: Write the failing test**

Create `data/test-oura-store.mjs`:

```js
// Longterm/data/test-oura-store.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// oura-store.mjs's upsert/query semantics: merge-by-id without dropping rows
// outside the batch, id synthesis for heartrate + singletons, and revision
// overwrite (Oura re-scores a day as more data lands). Run with:
//   node Longterm/data/test-oura-store.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ouraRowId, normalizeRow, upsertOuraRows, queryOura, loadStore, OURA_OVERLAP_DAYS,
} from '../scripts/oura-store.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
console.log('test-oura-store.mjs');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'oura-store-test-'));
}

test('OURA_OVERLAP_DAYS is 30', () => {
  assert.equal(OURA_OVERLAP_DAYS, 30);
});

test('a normal dated record keys on owner:endpoint:record.id', () => {
  const id = ouraRowId('alex', 'daily_sleep', { id: 'rec-1', day: '2026-01-15' });
  assert.equal(id, 'alex:daily_sleep:rec-1');
});

test('heartrate has no record id, so it keys on its timestamp', () => {
  const id = ouraRowId('alex', 'heartrate', { bpm: 60, timestamp: '2026-01-15T04:05:00+00:00' });
  assert.equal(id, 'alex:heartrate:2026-01-15T04:05:00+00:00');
});

test('a singleton keys on owner:endpoint only — current state, not history', () => {
  assert.equal(ouraRowId('alex', 'personal_info', { id: 'x' }), 'alex:personal_info');
  assert.equal(ouraRowId('alex', 'ring_configuration', { id: 'y' }), 'alex:ring_configuration');
});

test('normalizeRow nests the Oura record under data so no field can shadow ours', () => {
  const row = normalizeRow('alex', 'daily_sleep', { id: 'rec-1', day: '2026-01-15', score: 80, endpoint: 'BOGUS' });
  assert.equal(row.id, 'alex:daily_sleep:rec-1');
  assert.equal(row.ownerId, 'alex');
  assert.equal(row.endpoint, 'daily_sleep');
  assert.equal(row.day, '2026-01-15');
  assert.equal(row.data.score, 80);
  assert.equal(row.data.endpoint, 'BOGUS');
});

test('heartrate rows take their day from the timestamp date part', () => {
  const row = normalizeRow('alex', 'heartrate', { bpm: 61, timestamp: '2026-01-15T04:05:00+00:00' });
  assert.equal(row.day, '2026-01-15');
});

test('upsert keeps rows outside the current batch', () => {
  const dir = tmpDir();
  upsertOuraRows('daily_sleep', [normalizeRow('alex', 'daily_sleep', { id: 'old', day: '2026-01-01', score: 70 })], { storeDir: dir, asOf: '2026-01-01' });
  upsertOuraRows('daily_sleep', [normalizeRow('alex', 'daily_sleep', { id: 'new', day: '2026-02-01', score: 75 })], { storeDir: dir, asOf: '2026-02-01' });
  const store = loadStore('daily_sleep', dir);
  assert.equal(Object.keys(store.byId).length, 2);
  assert.ok(store.byId['alex:daily_sleep:old']);
  assert.ok(store.byId['alex:daily_sleep:new']);
});

test('a revised score overwrites in place rather than duplicating', () => {
  const dir = tmpDir();
  upsertOuraRows('daily_sleep', [normalizeRow('alex', 'daily_sleep', { id: 'r1', day: '2026-01-15', score: 70 })], { storeDir: dir, asOf: '2026-01-15' });
  upsertOuraRows('daily_sleep', [normalizeRow('alex', 'daily_sleep', { id: 'r1', day: '2026-01-15', score: 74 })], { storeDir: dir, asOf: '2026-01-16' });
  const store = loadStore('daily_sleep', dir);
  assert.equal(Object.keys(store.byId).length, 1);
  assert.equal(store.byId['alex:daily_sleep:r1'].data.score, 74);
  assert.equal(store.byId['alex:daily_sleep:r1'].updatedAt, '2026-01-16');
});

test('meta tracks lastUpdated and recordCount', () => {
  const dir = tmpDir();
  upsertOuraRows('daily_sleep', [
    normalizeRow('alex', 'daily_sleep', { id: 'a', day: '2026-01-15', score: 70 }),
    normalizeRow('sam', 'daily_sleep', { id: 'b', day: '2026-01-15', score: 90 }),
  ], { storeDir: dir, asOf: '2026-01-15' });
  const store = loadStore('daily_sleep', dir);
  assert.equal(store.meta.lastUpdated, '2026-01-15');
  assert.equal(store.meta.recordCount, 2);
});

test('query filters by owner and date range, newest first', () => {
  const dir = tmpDir();
  upsertOuraRows('daily_sleep', [
    normalizeRow('alex', 'daily_sleep', { id: 'a1', day: '2026-01-10', score: 70 }),
    normalizeRow('alex', 'daily_sleep', { id: 'a2', day: '2026-01-20', score: 72 }),
    normalizeRow('sam', 'daily_sleep', { id: 's1', day: '2026-01-20', score: 90 }),
  ], { storeDir: dir, asOf: '2026-01-20' });

  const alexAll = queryOura('daily_sleep', { storeDir: dir, ownerId: 'alex' });
  assert.equal(alexAll.length, 2);
  assert.equal(alexAll[0].day, '2026-01-20');

  const ranged = queryOura('daily_sleep', { storeDir: dir, ownerId: 'alex', startDate: '2026-01-15', endDate: '2026-01-25' });
  assert.equal(ranged.length, 1);
  assert.equal(ranged[0].data.score, 72);
});

test('a missing store file reads as empty rather than throwing', () => {
  const dir = tmpDir();
  assert.deepEqual(queryOura('daily_sleep', { storeDir: dir, ownerId: 'alex' }), []);
  assert.equal(loadStore('daily_sleep', dir).meta.recordCount, 0);
});

test('a corrupt store file degrades to empty rather than throwing', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'daily_sleep.json'), '{ not json', 'utf8');
  assert.deepEqual(queryOura('daily_sleep', { storeDir: dir, ownerId: 'alex' }), []);
});

console.log('All oura-store tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node data/test-oura-store.mjs`
Expected: FAIL — `Cannot find module '../scripts/oura-store.mjs'`

- [ ] **Step 3: Write the implementation**

Create `scripts/oura-store.mjs`:

```js
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
 * All 15 v2 endpoints. `dated` collections take start_date/end_date;
 * heartrate uniquely takes start_datetime/end_datetime; singletons take
 * neither. Pulling everything is deliberate — see the design doc.
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
  { key: 'heartrate', window: 'datetime' },
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node data/test-oura-store.mjs`
Expected: PASS — all cases print `ok - ...`

- [ ] **Step 5: Commit**

```bash
npm run check:secrets
git add scripts/oura-store.mjs data/test-oura-store.mjs
git commit -m "Add accumulating per-endpoint Oura store with upsert-by-id."
```

---

### Task 2: Rewrite `oura-pull.mjs` as a durable pull

**Files:**
- Modify (rewrite): `scripts/oura-pull.mjs`
- Create: `scripts/oura-pull.ps1`
- Modify: `scripts/run-daily-pull.ps1`

**Interfaces:**
- Consumes: Task 1's `OURA_ENDPOINTS`, `SINGLETON_ENDPOINTS`, `OURA_OVERLAP_DAYS`, `normalizeRow`, `upsertOuraRows`, `defaultOuraStoreDir`; and the existing unchanged `getValidAccessToken(ownerId)` / `ouraGet(accessToken, pathSuffix, query)` from `scripts/oura-client.mjs`.
- Produces: `pullOwner(ownerId, { days, storeDir, ouraGetFn, now })` and `runPull({ ownerIds, days, storeDir, dryRun })`, returning `{ ownerId, endpoints: { [key]: { count, upserted, error } } }` per owner.

- [ ] **Step 1: Replace the sketch's body**

Replace the entire contents of `scripts/oura-pull.mjs`. The existing file is a connect-sketch (7 endpoints, snapshot-overwrite to `data/oura/<owner>-latest.json`, prints an inventory and stops). It is being deliberately replaced, not extended.

```js
#!/usr/bin/env node
// Durable daily Oura pull. Replaces the original connect-sketch (which wrote a
// snapshot to data/oura/<owner>-latest.json and existed only to inventory what
// the API returns). Fetches all 15 v2 endpoints over a rolling window and
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

function windowQuery(endpoint, days, now) {
  const end = new Date(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  if (endpoint.window === 'none') return {};
  if (endpoint.window === 'datetime') {
    return { start_datetime: `${ymd(start)}T00:00:00+00:00`, end_datetime: `${ymd(end)}T23:59:59+00:00` };
  }
  return { start_date: ymd(start), end_date: ymd(end) };
}

/** A singleton returns a bare object; a dated collection returns { data: [...] }. */
function recordsFrom(body) {
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
      const body = await get(endpoint.key, windowQuery(endpoint, days, now));
      const records = recordsFrom(body);
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

export async function runPull({ ownerIds = null, days = OURA_OVERLAP_DAYS, storeDir = defaultOuraStoreDir(), dryRun = false, now = new Date() } = {}) {
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
  for (const r of results) {
    const failed = Object.entries(r.endpoints).filter(([, v]) => v.error);
    const total = Object.values(r.endpoints).reduce((s, v) => s + v.upserted, 0);
    console.log(`${r.ownerId}: ${total} record(s) upserted across ${OURA_ENDPOINTS.length} endpoints` +
      (failed.length ? `; ${failed.length} endpoint error(s): ${failed.map(([k]) => k).join(', ')}` : ''));
  }
  if (!results.length) {
    console.error('No owners with Oura tokens found. Run `npm run oura:auth -- --owner <id>` first.');
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
```

- [ ] **Step 2: Verify the dry run works against the real API**

Run: `node scripts/oura-pull.mjs --all --dry-run`
Expected: one line per owner reporting records found, `0 record(s) upserted`, and no files written under `data/oura/`. Endpoints with no data report no error.

- [ ] **Step 3: Do a real pull and confirm accumulation**

Run: `node scripts/oura-pull.mjs --all`
Then: `node -e "const {loadStore}=await import('./scripts/oura-store.mjs'); console.log(loadStore('daily_sleep').meta)"`
Expected: `recordCount` > 0, `lastUpdated` is today. Run the pull a second time and confirm `recordCount` does not double.

- [ ] **Step 4: Create the PowerShell wrapper**

Create `scripts/oura-pull.ps1`, modeled on the existing `budget-tracking-pull.ps1`:

```powershell
param([switch]$DryRun)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$script = Join-Path $PSScriptRoot 'oura-pull.mjs'

$nodeArgs = @($script, '--all')
if ($DryRun) { $nodeArgs += '--dry-run' }

Push-Location $repoRoot
try {
    & node @nodeArgs
    if ($LASTEXITCODE -ne 0) { throw "oura-pull.mjs exited with code $LASTEXITCODE" }
} finally {
    Pop-Location
}
```

- [ ] **Step 5: Add the third step to the daily pull, contained**

In `scripts/run-daily-pull.ps1`, add alongside the existing script path variables:

```powershell
$ouraScript = Join-Path $PSScriptRoot 'oura-pull.ps1'
```

Then, inside the `try` block, after the budget tracking step and before the success log line:

```powershell
    # Health data is a nice-to-have: an Oura outage must never fail the money
    # pulls, the same containment rule calendar-sync follows inside the poll task.
    try {
        Invoke-DailyPullStep -Name 'oura pull' -ScriptPath $ouraScript
    } catch {
        Write-PullLog ('WARN oura pull failed (continuing): {0}' -f $_.Exception.Message)
    }
```

- [ ] **Step 6: Verify containment**

Run: `powershell -File scripts/run-daily-pull.ps1 -DryRun`
Expected: all three steps log; the run reports success. Then temporarily rename `scripts/oura-pull.ps1`, re-run, and confirm the log shows `WARN oura pull failed (continuing)` and the overall run still succeeds. Restore the filename.

- [ ] **Step 7: Commit**

```bash
npm run check:secrets
git add scripts/oura-pull.mjs scripts/oura-pull.ps1 scripts/run-daily-pull.ps1
git commit -m "Rewrite oura-pull as a durable all-endpoint pull; add to daily job."
```

---

### Task 3: Health overrides + `health-context.mjs` depletion rule

**Files:**
- Create: `examples/health_overrides.example.json`
- Create: `scripts/health-context.mjs`
- Modify: `scripts/seed-from-examples.mjs`
- Modify: `data/goals.json` (add `healthThresholds`)
- Modify: `examples/goals.example.json` (add `healthThresholds`)
- Test: `data/test-health-context.mjs`

**Interfaces:**
- Consumes: Task 1's `queryOura`, `defaultOuraStoreDir`.
- Produces: `loadHealthOverrides(overridesPath)`, `computeOwnerHealth(ownerId, { sleepRows, stressRows, thresholds, overrides, now })`, `loadHealthContext({ storeDir, goalsPath, overridesPath, now })` returning `{ configured, thresholds, perOwner: { [ownerId]: {...} }, worst }`. Each `perOwner` entry is `{ ownerId, nights, weekNights, baselineNights, weekMean, baseline, drop, stressfulDays, depleted, reason }`. `worst` is `null` or `{ ownerId, depleted: true, reason }`.

- [ ] **Step 1: Add the thresholds block**

In `data/goals.json` **and** `examples/goals.example.json`, add a top-level key:

```json
"healthThresholds": {
  "rule": "baselineStress",
  "combine": "either",
  "baselineDays": 30,
  "weekDays": 7,
  "minNightsForBaseline": 14,
  "minNightsInWeek": 3,
  "sleepScoreDropPoints": 5,
  "stressfulDaysInWeek": 3
}
```

Then run `npm run build` (required after any `goals.json` edit, per `AGENTS.md` §1).

- [ ] **Step 2: Create the committed example overrides file**

Create `examples/health_overrides.example.json` with invented entries only:

```json
{
  "meta": {
    "description": "Durable health corrections. Excluded nights are dropped from both the week and the baseline. Edit this file — the store is regenerated by the daily pull, so a hand-edit there is overwritten."
  },
  "excludedNights": [
    { "ownerId": "kevin", "date": "2026-01-15", "reason": "example — red-eye flight, ring off" }
  ],
  "baselineRules": [
    { "ownerId": "kevin", "from": "2026-01-01", "to": "2026-01-07", "reason": "example — illness, hold baseline", "excludeFromBaseline": true }
  ]
}
```

In `scripts/seed-from-examples.mjs`, add to the `COPIES` array:

```js
  ['health_overrides.example.json', 'health_overrides.json'],
```

- [ ] **Step 3: Write the failing test**

Create `data/test-health-context.mjs`:

```js
// Longterm/data/test-health-context.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// health-context.mjs's depletion rule: personal rolling baseline (NOT an
// absolute threshold — the two people in this household are very different
// sleepers, so a shared cutoff would fire constantly for one and never for the
// other), the insufficient-data gate that governs a newly set-up ring, and the
// rule that a night not worn is absent rather than zero. Run with:
//   node Longterm/data/test-health-context.mjs
import assert from 'node:assert/strict';
import { computeOwnerHealth, pickWorst } from '../scripts/health-context.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
console.log('test-health-context.mjs');

const NOW = new Date('2026-03-01T12:00:00Z');

const THRESHOLDS = {
  rule: 'baselineStress',
  combine: 'either',
  baselineDays: 30,
  weekDays: 7,
  minNightsForBaseline: 14,
  minNightsInWeek: 3,
  sleepScoreDropPoints: 5,
  stressfulDaysInWeek: 3,
};

function dayBefore(n) {
  const d = new Date(NOW);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Sleep rows in store shape: newest-first is not required by the function. */
function sleepRows(scoresByDaysAgo) {
  return Object.entries(scoresByDaysAgo).map(([ago, score]) => ({
    ownerId: 'alex', endpoint: 'daily_sleep', day: dayBefore(Number(ago)), data: { score },
  }));
}

function stressRows(summariesByDaysAgo) {
  return Object.entries(summariesByDaysAgo).map(([ago, day_summary]) => ({
    ownerId: 'alex', endpoint: 'daily_stress', day: dayBefore(Number(ago)), data: { day_summary },
  }));
}

/** 30 nights at a steady score, so the baseline is unambiguous. */
function steady(score, fromAgo, toAgo) {
  const out = {};
  for (let i = fromAgo; i <= toAgo; i += 1) out[i] = score;
  return out;
}

test('a week meaningfully below the personal baseline is depleted', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(80, 1, 7) });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, true);
  assert.equal(r.baseline, 90);
  assert.equal(r.weekMean, 80);
  assert.equal(r.drop, 10);
  assert.match(r.reason, /80/);
  assert.match(r.reason, /90/);
});

test('a week at the personal baseline is not depleted, even at a low absolute score', () => {
  const rows = sleepRows({ ...steady(62, 8, 30), ...steady(62, 1, 7) });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
  assert.equal(r.drop, 0);
});

test('a drop smaller than sleepScoreDropPoints does not fire', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(87, 1, 7) });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
});

test('the current week is excluded from its own baseline', () => {
  // If the week were included, the baseline would be dragged toward it and
  // the drop would read smaller than it truly is.
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(70, 1, 7) });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.baseline, 90);
});

test('enough stressful days alone fires under combine:either', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 7) });
  const stress = stressRows({ 1: 'stressful', 2: 'stressful', 3: 'stressful', 4: 'normal' });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: stress, thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, true);
  assert.equal(r.stressfulDays, 3);
});

test('combine:both requires sleep AND stress', () => {
  const both = { ...THRESHOLDS, combine: 'both' };
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 7) });
  const stress = stressRows({ 1: 'stressful', 2: 'stressful', 3: 'stressful' });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: stress, thresholds: both, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
});

test('rule:baseline ignores stress entirely', () => {
  const baselineOnly = { ...THRESHOLDS, rule: 'baseline' };
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 7) });
  const stress = stressRows({ 1: 'stressful', 2: 'stressful', 3: 'stressful', 4: 'stressful' });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: stress, thresholds: baselineOnly, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
});

test('a brand-new ring reports insufficient_data, never depleted', () => {
  const rows = sleepRows({ 1: 67 });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.depleted, false);
  assert.equal(r.reason, 'insufficient_data');
  assert.equal(r.nights, 1);
});

test('too few nights inside the week reports insufficient_data', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), 1: 60, 2: 60 });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.reason, 'insufficient_data');
  assert.equal(r.depleted, false);
});

test('a night not worn is absent, not a zero', () => {
  // The single most important correctness rule: gaps must not read as
  // catastrophic sleep. Three missing nights in the week must not produce a
  // depleted verdict on their own.
  const rows = sleepRows({ ...steady(90, 8, 30), 1: 90, 2: 90, 3: 90 });
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides: null, now: NOW });
  assert.equal(r.weekMean, 90);
  assert.equal(r.depleted, false);
});

test('an excluded night is dropped from both the week and the baseline', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 6), 7: 20 });
  const overrides = { excludedNights: [{ ownerId: 'alex', date: dayBefore(7), reason: 'ring off' }] };
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides, now: NOW });
  assert.equal(r.weekMean, 90);
  assert.equal(r.depleted, false);
});

test('a baselineRule range is excluded from the baseline', () => {
  const rows = sleepRows({ ...steady(50, 20, 30), ...steady(90, 8, 19), ...steady(88, 1, 7) });
  const overrides = {
    baselineRules: [{ ownerId: 'alex', from: dayBefore(30), to: dayBefore(20), excludeFromBaseline: true, reason: 'illness' }],
  };
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides, now: NOW });
  assert.equal(r.baseline, 90);
  assert.equal(r.depleted, false);
});

test('an override for a different owner is ignored', () => {
  const rows = sleepRows({ ...steady(90, 8, 30), ...steady(90, 1, 6), 7: 20 });
  const overrides = { excludedNights: [{ ownerId: 'someone-else', date: dayBefore(7) }] };
  const r = computeOwnerHealth('alex', { sleepRows: rows, stressRows: [], thresholds: THRESHOLDS, overrides, now: NOW });
  assert.ok(r.weekMean < 90);
});

test('pickWorst returns the depleted owner and ignores insufficient-data owners', () => {
  const perOwner = {
    alex: { ownerId: 'alex', depleted: false, reason: 'insufficient_data', drop: 0 },
    sam: { ownerId: 'sam', depleted: true, reason: 'week averaged 80 against a 90 baseline', drop: 10 },
  };
  const worst = pickWorst(perOwner);
  assert.equal(worst.ownerId, 'sam');
  assert.equal(worst.depleted, true);
});

test('pickWorst picks the larger drop when both are depleted', () => {
  const perOwner = {
    alex: { ownerId: 'alex', depleted: true, reason: 'a', drop: 6 },
    sam: { ownerId: 'sam', depleted: true, reason: 'b', drop: 12 },
  };
  assert.equal(pickWorst(perOwner).ownerId, 'sam');
});

test('pickWorst returns null when nobody is depleted', () => {
  assert.equal(pickWorst({ alex: { ownerId: 'alex', depleted: false, drop: 0 } }), null);
});

console.log('All health-context tests passed.');
```

- [ ] **Step 4: Run test to verify it fails**

Run: `node data/test-health-context.mjs`
Expected: FAIL — `Cannot find module '../scripts/health-context.mjs'`

- [ ] **Step 5: Write the implementation**

Create `scripts/health-context.mjs`:

```js
// Read-only derivation over the Oura store — the health counterpart to
// financial-context.mjs, so the recap and the bot's on-demand tool agree on one
// set of numbers instead of re-deriving them.
//
// Depletion is measured against each person's OWN rolling baseline, never an
// absolute threshold. The two adults here are very different sleepers; a shared
// cutoff would fire constantly for one and never for the other, collapsing
// "whoever is more depleted" into a single person's number permanently.
// See docs/superpowers/specs/2026-08-06-oura-health-signal-design.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryOura, defaultOuraStoreDir } from './oura-store.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_THRESHOLDS = {
  rule: 'baselineStress',
  combine: 'either',
  baselineDays: 30,
  weekDays: 7,
  minNightsForBaseline: 14,
  minNightsInWeek: 3,
  sleepScoreDropPoints: 5,
  stressfulDaysInWeek: 3,
};

export function defaultHealthOverridesPath() {
  return path.join(repoRoot, 'data', 'health_overrides.json');
}

export function loadHealthOverrides(overridesPath = defaultHealthOverridesPath()) {
  try {
    return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
  } catch {
    return { excludedNights: [], baselineRules: [] };
  }
}

function isoDaysBefore(now, n) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function mean(values) {
  if (!values.length) return null;
  return Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10;
}

function isExcludedNight(ownerId, day, overrides) {
  return (overrides?.excludedNights || []).some((e) => e.ownerId === ownerId && e.date === day);
}

function isExcludedFromBaseline(ownerId, day, overrides) {
  return (overrides?.baselineRules || []).some(
    (r) => r.ownerId === ownerId && r.excludeFromBaseline && day >= r.from && day <= r.to,
  );
}

/**
 * @returns {{ownerId,nights,weekNights,baselineNights,weekMean,baseline,drop,
 *            stressfulDays,depleted,reason}}
 */
export function computeOwnerHealth(ownerId, { sleepRows = [], stressRows = [], thresholds = DEFAULT_THRESHOLDS, overrides = null, now = new Date() } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const weekStart = isoDaysBefore(now, t.weekDays);
  const baselineStart = isoDaysBefore(now, t.baselineDays);

  // A night with no record is simply absent — never coerced to a zero. A ring
  // left on the nightstand must not read as catastrophic sleep.
  const usable = sleepRows.filter(
    (r) => r.day
      && typeof r.data?.score === 'number'
      && r.day >= baselineStart
      && !isExcludedNight(ownerId, r.day, overrides),
  );

  const weekScores = usable.filter((r) => r.day > weekStart).map((r) => r.data.score);
  const baselineScores = usable
    .filter((r) => r.day <= weekStart && !isExcludedFromBaseline(ownerId, r.day, overrides))
    .map((r) => r.data.score);

  const stressfulDays = stressRows.filter(
    (r) => r.day && r.day > weekStart && r.data?.day_summary === 'stressful'
      && !isExcludedNight(ownerId, r.day, overrides),
  ).length;

  const base = {
    ownerId,
    nights: usable.length,
    weekNights: weekScores.length,
    baselineNights: baselineScores.length,
    weekMean: mean(weekScores),
    baseline: mean(baselineScores),
    stressfulDays,
    drop: 0,
  };

  if (baselineScores.length < t.minNightsForBaseline || weekScores.length < t.minNightsInWeek) {
    return { ...base, depleted: false, reason: 'insufficient_data' };
  }

  const drop = Math.round((base.baseline - base.weekMean) * 10) / 10;
  const bySleep = drop >= t.sleepScoreDropPoints;
  const byStress = stressfulDays >= t.stressfulDaysInWeek;

  let depleted;
  if (t.rule === 'baseline') depleted = bySleep;
  else if (t.rule === 'stress') depleted = byStress;
  else depleted = t.combine === 'both' ? (bySleep && byStress) : (bySleep || byStress);

  const parts = [`week averaged ${base.weekMean} against a ${base.baseline} baseline`];
  if (byStress) parts.push(`${stressfulDays} stressful days`);
  return {
    ...base,
    drop,
    depleted,
    reason: depleted ? parts.join(', ') : `within normal range (${parts[0]})`,
  };
}

/** Worse-of-the-two: depleted if ANY owner with sufficient data is. */
export function pickWorst(perOwner) {
  const depleted = Object.values(perOwner).filter((o) => o.depleted);
  if (!depleted.length) return null;
  const worst = depleted.sort((a, b) => (b.drop || 0) - (a.drop || 0))[0];
  return { ownerId: worst.ownerId, depleted: true, reason: worst.reason };
}

export function loadHealthContext({
  storeDir = defaultOuraStoreDir(),
  goalsPath = path.join(repoRoot, 'data', 'goals.json'),
  overridesPath = defaultHealthOverridesPath(),
  now = new Date(),
} = {}) {
  let owners = [];
  let thresholds = DEFAULT_THRESHOLDS;
  try {
    const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    owners = (goals.owners || []).map((o) => o.id).filter(Boolean);
    thresholds = { ...DEFAULT_THRESHOLDS, ...(goals.healthThresholds || {}) };
  } catch { /* missing/unparseable — degrade to empty */ }

  const overrides = loadHealthOverrides(overridesPath);
  const startDate = isoDaysBefore(now, thresholds.baselineDays);
  const endDate = new Date(now).toISOString().slice(0, 10);

  const perOwner = {};
  for (const ownerId of owners) {
    const sleepRows = queryOura('daily_sleep', { storeDir, ownerId, startDate, endDate });
    const stressRows = queryOura('daily_stress', { storeDir, ownerId, startDate, endDate });
    perOwner[ownerId] = computeOwnerHealth(ownerId, { sleepRows, stressRows, thresholds, overrides, now });
  }

  const configured = Object.values(perOwner).some((o) => o.nights > 0);
  return { configured, thresholds, perOwner, worst: pickWorst(perOwner) };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node data/test-health-context.mjs`
Expected: PASS — all cases print `ok - ...`

- [ ] **Step 7: Sanity-check against the real store**

Run: `node -e "const {loadHealthContext}=await import('./scripts/health-context.mjs'); const c=loadHealthContext(); console.log(JSON.stringify({configured:c.configured, worst:c.worst, perOwner:Object.fromEntries(Object.entries(c.perOwner).map(([k,v])=>[k,{nights:v.nights,depleted:v.depleted,reason:v.reason}]))},null,2))"`
Expected: an owner with a newly set-up ring reports `insufficient_data`; an owner with a month of history reports a real week/baseline pair. **Do not paste this output into a commit message or doc.**

- [ ] **Step 8: Commit**

```bash
npm run check:secrets
git status   # confirm data/goals.json and data/health_overrides.json are NOT staged
git add scripts/health-context.mjs data/test-health-context.mjs examples/health_overrides.example.json examples/goals.example.json scripts/seed-from-examples.mjs
git commit -m "Add health-context depletion rule with durable overrides."
```

---

### Task 4: `lowKeyReason` + the depletion gate in `get_dining_plan`

**Files:**
- Modify: `scripts/dining-recommendation.mjs:104-108`
- Modify: `scripts/telegram-bot-tools.mjs:245-270`
- Test: `data/test-dining-recommendation.mjs`, `data/test-telegram-bot.mjs`

**Interfaces:**
- Consumes: Task 3's `perOwner`/`worst` shape (only `{ ownerId, depleted, reason }` is used here).
- Produces: `recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas, alreadyUsedNames, lowKeyReason)` — a sixth parameter; and `get_dining_plan` honoring `diningContext.depletion`.

**Important context:** `recommendForSlot`'s `slot.tier === 'low-key'` branch has **never executed** in the bot or recap path. `get_dining_plan` builds its slot from `slotForOccasion()` → a `goals.json` `diningRoutine` entry, and no entry carries that tier. The budget-driven low-key path exists only in `dashboard_v5.html`'s `planRemainingMonth` feeding its own inline duplicate of this function. This task is the first caller ever to reach that branch here, so the tests own it explicitly.

- [ ] **Step 1: Write the failing tests**

Append to `data/test-dining-recommendation.mjs`, before its final summary log:

```js
test('a low-key slot states the caller-supplied reason, not the budget default', () => {
  // recommendForSlot's low-key branch previously hardcoded "Budget is tight for
  // this occurrence". Firing it on sleep depletion would report a false cause.
  const rec = recommendForSlot(
    { tier: 'low-key', dynamic: false }, [], [], ['Walk to the overlook'], new Set(),
    'Sam is depleted — week averaged 80 against a 90 baseline',
  );
  assert.equal(rec.picks[0], 'Walk to the overlook');
  assert.match(rec.reasoning, /depleted/);
  assert.doesNotMatch(rec.reasoning, /Budget is tight/);
});

test('a low-key slot with no reason supplied keeps the budget default', () => {
  const rec = recommendForSlot({ tier: 'low-key', dynamic: false }, [], [], ['Walk to the overlook'], new Set());
  assert.match(rec.reasoning, /Budget is tight/);
});
```

Append to `data/test-telegram-bot.mjs`, before its final summary log:

```js
test('depletion swaps date_night to a low-key hang with the real cause', () => {
  const diningContext = {
    diningRoutine: [
      { dayOfWeek: 3, tier: 'mid' }, { dayOfWeek: 5, tier: 'high' }, { dayOfWeek: 6, tier: 'mid' },
    ],
    lowKeyHangIdeas: ['Walk to the overlook'],
    favorites: [{ name: 'Fancy Place', list: 'go-to', dinnerSpot: true, observed: { tier: 'high' } }],
    recentDiningActivity: [],
    routineOverrides: { family_dinner: null, date_night: null, weekend_social: null },
    calendarEvents: [],
    depletion: { ownerId: 'sam', depleted: true, reason: 'week averaged 80 against a 90 baseline' },
  };
  const result = get_dining_plan({ events: {} }, { occasion: 'date_night' }, diningContext);
  assert.match(result.reply, /Walk to the overlook/);
  assert.match(result.reply, /90 baseline/);
  assert.doesNotMatch(result.reply, /Budget is tight/);
});

test('depletion never swaps family_dinner — it resolves too far out to be honest', () => {
  const diningContext = {
    diningRoutine: [
      { dayOfWeek: 3, tier: 'mid' }, { dayOfWeek: 5, tier: 'high' }, { dayOfWeek: 6, tier: 'mid' },
    ],
    lowKeyHangIdeas: ['Walk to the overlook'],
    favorites: [{ name: 'Family Spot', list: 'go-to', familyFriendly: true, observed: { tier: 'mid' } }],
    recentDiningActivity: [],
    routineOverrides: { family_dinner: null, date_night: null, weekend_social: null },
    calendarEvents: [],
    depletion: { ownerId: 'sam', depleted: true, reason: 'week averaged 80 against a 90 baseline' },
  };
  const result = get_dining_plan({ events: {} }, { occasion: 'family_dinner' }, diningContext);
  assert.doesNotMatch(result.reply, /Walk to the overlook/);
});

test('no depletion leaves suggestions untouched', () => {
  const diningContext = {
    diningRoutine: [
      { dayOfWeek: 3, tier: 'mid' }, { dayOfWeek: 5, tier: 'high' }, { dayOfWeek: 6, tier: 'mid' },
    ],
    lowKeyHangIdeas: ['Walk to the overlook'],
    favorites: [{ name: 'Fancy Place', list: 'go-to', dinnerSpot: true, observed: { tier: 'high' } }],
    recentDiningActivity: [],
    routineOverrides: { family_dinner: null, date_night: null, weekend_social: null },
    calendarEvents: [],
    depletion: null,
  };
  const result = get_dining_plan({ events: {} }, { occasion: 'date_night' }, diningContext);
  assert.match(result.reply, /Fancy Place/);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-dining-recommendation.mjs` then `node data/test-telegram-bot.mjs`
Expected: FAIL — the reasoning still reads "Budget is tight", and `get_dining_plan` suggests the restaurant regardless of depletion.

- [ ] **Step 3: Add `lowKeyReason` to `recommendForSlot`**

In `scripts/dining-recommendation.mjs`, change the signature and the low-key branch:

```js
export function recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas, alreadyUsedNames, lowKeyReason = null) {
  if (slot.tier === 'low-key') {
    const idea = lowKeyHangIdeas[Math.floor(Math.random() * lowKeyHangIdeas.length)];
    // The cause is supplied by the caller: budget tightness (dashboard's
    // planRemainingMonth) and sleep depletion (the Thursday recap) both land
    // here, and reporting the wrong one would be actively misleading.
    return {
      picks: [idea],
      reasoning: lowKeyReason || 'Budget is tight for this occurrence — a free/low-key hang instead of a paid outing.',
    };
  }
```

- [ ] **Step 4: Add the depletion gate to `get_dining_plan`**

In `scripts/telegram-bot-tools.mjs`, inside `get_dining_plan`, replace the `recommendForSlot` call site:

```js
  // Sleep depletion sends the weekend low-key. Deliberately limited to
  // date_night (+1 day from a Thursday) and weekend_social (+2) —
  // family_dinner resolves six days out, which would be forecasting next
  // week from this week's sleep. Only the recap ever sets depletion; the
  // interactive bot and dashboard pass nothing and are unaffected.
  const depletion = diningContext.depletion;
  const swappable = occasion === 'date_night' || occasion === 'weekend_social';
  const effectiveSlot = (depletion?.depleted && swappable) ? { ...slot, tier: 'low-key' } : slot;
  const lowKeyReason = (depletion?.depleted && swappable)
    ? `${depletion.ownerId} is depleted — ${depletion.reason}. A low-key hang instead of a paid outing.`
    : null;
  const rec = recommendForSlot(effectiveSlot, diningContext.favorites, diningContext.recentDiningActivity, diningContext.lowKeyHangIdeas, alreadyUsedNames, lowKeyReason);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node data/test-dining-recommendation.mjs` then `node data/test-telegram-bot.mjs`
Expected: PASS, including every pre-existing case (the sixth parameter is optional, so all existing callers behave exactly as before).

- [ ] **Step 6: Commit**

```bash
npm run check:secrets
git add scripts/dining-recommendation.mjs scripts/telegram-bot-tools.mjs data/test-dining-recommendation.mjs data/test-telegram-bot.mjs
git commit -m "Let a caller state the low-key cause; gate weekend suggestions on depletion."
```

---

### Task 5: Recap wiring + `get_health_status` bot tool

**Files:**
- Modify: `scripts/telegram-bot-recap.mjs`
- Modify: `scripts/telegram-bot-tools.mjs`
- Modify: `scripts/telegram-bot-poll.mjs`
- Test: `data/test-telegram-recap.mjs`, `data/test-telegram-bot.mjs`

**Interfaces:**
- Consumes: Task 3's `loadHealthContext`, Task 4's `diningContext.depletion`.
- Produces: `get_health_status(healthContext)` (exported), `HEALTH_TOOL_NAMES` (exported `Set`), one `TOOL_DEFS` entry, one `TOOL_IMPL` entry, and `health` in the recap bundle.

- [ ] **Step 1: Write the failing tests**

Append to `data/test-telegram-recap.mjs`, before its final `console.log('All tests passed.')`. Use the file's existing helpers — `asyncTest`, `writeFixture(dir, {...}) → paths`, `baseOpts(paths, extra)`, and the `SUNDAY` / `THURSDAY` date constants — rather than inventing new ones:

```js
// A store dir that exists but is empty: health degrades to "not configured"
// without ever touching this machine's real data/oura/ directory.
function emptyHealthPaths(dir) {
  const storeDir = path.join(dir, 'oura-store');
  fs.mkdirSync(storeDir, { recursive: true });
  return {
    ouraStoreDir: storeDir,
    healthOverridesPath: path.join(dir, 'health_overrides.json'),
  };
}

await asyncTest('Thursday puts health in the bundle and lets it shape plans', async () => {
  const dir = path.join(tmpRoot, 'health-thursday');
  const paths = writeFixture(dir, {});
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  await runOnce(baseOpts(paths, {
    now: THURSDAY, anthropicClient: mockAnthropic, telegramClient: async () => ({ ok: true }),
    ...emptyHealthPaths(dir),
  }));

  assert.ok(capturedBundle.health, 'health should be present on Thursday');
  assert.ok('perOwner' in capturedBundle.health);
  assert.equal(capturedBundle.healthAffectsPlans, true);
});

await asyncTest('Sunday reports health but never lets it change suggestions', async () => {
  const dir = path.join(tmpRoot, 'health-sunday');
  const paths = writeFixture(dir, {});
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  await runOnce(baseOpts(paths, {
    now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: async () => ({ ok: true }),
    ...emptyHealthPaths(dir),
  }));

  assert.ok(capturedBundle.health, 'health should be present on Sunday too');
  assert.equal(capturedBundle.healthAffectsPlans, false, 'Sunday must never shape plans');
});
```

Add `ouraStoreDir` and `healthOverridesPath` to `baseOpts`'s returned object (pointing at the per-test temp dir, exactly as `calendarEnvPath` already guards against reading this machine's real env file), and to `parseArgs`'s defaults in `telegram-bot-recap.mjs` so the same two options are settable from the command line.

Append to `data/test-telegram-bot.mjs` (its `test()` helper is synchronous; add `get_health_status` to that file's existing import from `../scripts/telegram-bot-tools.mjs`):

```js
test('get_health_status reports each owner, naming who is still building a baseline', () => {
  const healthContext = {
    configured: true,
    perOwner: {
      alex: { ownerId: 'alex', nights: 1, depleted: false, reason: 'insufficient_data', weekMean: null, baseline: null, stressfulDays: 0 },
      sam: { ownerId: 'sam', nights: 28, depleted: true, reason: 'week averaged 80 against a 90 baseline', weekMean: 80, baseline: 90, stressfulDays: 1 },
    },
    worst: { ownerId: 'sam', depleted: true, reason: 'week averaged 80 against a 90 baseline' },
  };
  const result = get_health_status(healthContext);
  assert.match(result.reply, /alex/);
  assert.match(result.reply, /still building/i);
  assert.match(result.reply, /sam/);
  assert.match(result.reply, /90 baseline/);
});

test('get_health_status degrades honestly when nothing has been pulled', () => {
  const result = get_health_status({ configured: false, perOwner: {}, worst: null });
  assert.match(result.reply, /no Oura data/i);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-telegram-recap.mjs` then `node data/test-telegram-bot.mjs`
Expected: FAIL — `get_health_status is not defined`, and `result.bundle.health` is `undefined`.

- [ ] **Step 3: Add the bot tool**

In `scripts/telegram-bot-tools.mjs`, add near the other read-only `get_*` implementations:

```js
// Read-only over a healthContext bundle (see scripts/health-context.mjs) —
// a fourth call shape alongside todos, dining, and financial, for the same
// reason: genuinely different inputs. Reports both owners; the group chat
// already shares budget and todos the same way.
export function get_health_status(healthContext) {
  if (!healthContext || !healthContext.configured) {
    return { reply: 'No Oura data yet — nothing has been pulled into the store.' };
  }
  const lines = Object.values(healthContext.perOwner).map((o) => {
    if (o.reason === 'insufficient_data') {
      return `${o.ownerId}: still building a baseline (${o.nights} night${o.nights === 1 ? '' : 's'} recorded).`;
    }
    const verdict = o.depleted ? 'running depleted' : 'in normal range';
    return `${o.ownerId}: ${verdict} — ${o.reason}.`;
  });
  return { reply: lines.join('\n') };
}

// Read-only over a healthContext bundle — telegram-bot-poll.mjs's dispatch
// branches on this set the same way it does for FINANCIAL_TOOL_NAMES.
export const HEALTH_TOOL_NAMES = new Set(['get_health_status']);
```

Add to `TOOL_DEFS`:

```js
  {
    name: 'get_health_status',
    description: 'Report how each person slept this week against their own personal baseline, including whose baseline is still building. Use this for any question about sleep, rest, readiness, or how the week has felt physically.',
    input_schema: { type: 'object', properties: {} },
  },
```

Add to `TOOL_IMPL`:

```js
  get_health_status: (healthContext) => get_health_status(healthContext),
```

- [ ] **Step 4: Wire the dispatcher**

In `scripts/telegram-bot-poll.mjs`, add `HEALTH_TOOL_NAMES` to the existing import from `./telegram-bot-tools.mjs`, add `import { loadHealthContext } from './health-context.mjs';`, build `const healthContext = loadHealthContext();` alongside the existing `financialContext`, and add a dispatch branch immediately after the `FINANCIAL_TOOL_NAMES` branch:

```js
      } else if (HEALTH_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(healthContext);
        rawReplies.push(result.reply);
```

**Do not** pass `depletion` into the interactive bot's `diningContext` — the interactive path must stay unaffected.

- [ ] **Step 5: Wire the recap**

In `scripts/telegram-bot-recap.mjs`:

Add `import { loadHealthContext } from './health-context.mjs';`.

In `runOnce`, after `financialContext` is built:

```js
  // Health is reported on both cadence days, but only Thursday lets it change
  // the weekend's dining suggestions — Sunday is a summary, not a planner.
  const healthContext = loadHealthContext({
    now, storeDir: args.ouraStoreDir, overridesPath: args.healthOverridesPath, goalsPath: args.goalsPath,
  });
  const healthAffectsPlans = slot === 'thursday-morning';
```

`args.ouraStoreDir` and `args.healthOverridesPath` come from the `parseArgs` defaults added in Step 1 (`defaultOuraStoreDir()` and `defaultHealthOverridesPath()` respectively), so production behavior is unchanged and tests can redirect both.

Pass depletion into the dining context only on Thursday:

```js
  const diningContext = loadDiningContext(args, calendarItems);
  diningContext.depletion = healthAffectsPlans ? healthContext.worst : null;
```

Add both to `gatherBundle`'s call and its returned object (`health: healthContext`, `healthAffectsPlans`).

Add to `RECAP_SYSTEM_PROMPT`, after the Planning paragraph:

```
Health: one short line per person from health.perOwner — how this week compared to that person's own baseline, using the real figures in their reason string, never a bare adjective like "poor" or "fine" on its own. If someone's reason is "insufficient_data", say plainly that their baseline is still building and give the night count rather than implying anything about how they slept. If healthAffectsPlans is false, report only — do not suggest changing any plan on the basis of health.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `node data/test-telegram-recap.mjs` then `node data/test-telegram-bot.mjs`
Expected: PASS, including all pre-existing cases.

- [ ] **Step 7: Verify a real dry-run recap end to end**

Run: `node scripts/telegram-bot-recap.mjs --dry-run`
Expected: a composed recap with a Health section carrying real figures and naming whoever is still building a baseline. **Nothing is sent** (`--dry-run`), and the output must not be pasted into a commit message.

- [ ] **Step 8: Run the whole suite**

Run each of: `node data/test-oura-store.mjs`, `node data/test-health-context.mjs`, `node data/test-dining-recommendation.mjs`, `node data/test-telegram-bot.mjs`, `node data/test-telegram-recap.mjs`, `node data/test-calendar-sync.mjs`, `node data/test-dashboard-contract.mjs`
Expected: all pass.

- [ ] **Step 9: Update the architecture docs**

In `claude.md`, add `data/oura/`, `data/health_overrides.json`, `scripts/oura-store.mjs`, and `scripts/health-context.mjs` to the Project files list, and note the Thursday-swap/Sunday-report split. In `AGENTS.md` §0, add `data/oura/*` and `data/health_overrides.json` to the never-commit table.

While in `claude.md`, correct the stale claim that `dashboard_v5.html` is opened over `file://` — `dashboard-server.mjs` replaced that with `http://localhost` and several panels now fetch live `/api/` routes.

- [ ] **Step 10: Commit**

```bash
npm run check:secrets
git add scripts/telegram-bot-recap.mjs scripts/telegram-bot-tools.mjs scripts/telegram-bot-poll.mjs data/test-telegram-recap.mjs data/test-telegram-bot.mjs claude.md AGENTS.md
git commit -m "Report health in both recaps; let Thursday shape the weekend."
```

---

## Self-review

**Spec coverage:** accumulating store (Task 1) · all 15 endpoints + `--backfill-days` + daily-job containment (Task 2) · durable overrides + `healthThresholds` + personal-baseline rule + cold-start gate (Task 3) · `lowKeyReason` + Fri/Sat-only swap + never-executed-branch tests (Task 4) · Thursday-swap/Sunday-report split + `get_health_status` + docs (Task 5). The spec's "no generated `health_tracking.json`" and "no dashboard changes" are non-goals and correctly have no task.

**Type consistency:** `computeOwnerHealth` returns `drop`, consumed by `pickWorst`'s sort. `worst` is `{ ownerId, depleted, reason }`, consumed by `get_dining_plan`'s `depletion.ownerId`/`.reason`/`.depleted`. `recommendForSlot`'s sixth parameter is `lowKeyReason` in both the definition and every call site. `queryOura(endpoint, {storeDir, ownerId, startDate, endDate})` matches its two callers in `health-context.mjs`.
