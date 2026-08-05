#!/usr/bin/env node
// Fetch a sample window of Oura v2 data for one or all owners who have tokens.
// Writes data/oura/<ownerId>-latest.json (gitignored) and prints an inventory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getValidAccessToken, ouraGet } from './oura-client.mjs';
import { ouraOwnerEnvPath } from './longterm-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'data', 'oura');

/** Endpoints to sample — failures are recorded, not fatal (scope / membership gaps). */
const ENDPOINTS = [
  { key: 'personal_info', path: 'personal_info', dated: false },
  { key: 'daily_sleep', path: 'daily_sleep', dated: true },
  { key: 'daily_readiness', path: 'daily_readiness', dated: true },
  { key: 'daily_activity', path: 'daily_activity', dated: true },
  { key: 'daily_spo2', path: 'daily_spo2', dated: true },
  { key: 'sleep', path: 'sleep', dated: true },
  { key: 'workout', path: 'workout', dated: true },
];

function parseArgs(argv) {
  let ownerId = null;
  let all = false;
  let days = 14;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owner' && argv[i + 1]) ownerId = argv[++i];
    else if (a === '--all') all = true;
    else if (a === '--days' && argv[i + 1]) days = Math.max(1, Number(argv[++i]) || 14);
  }
  return { ownerId, all, days };
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

function dateWindow(days) {
  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return { start_date: ymd(start), end_date: ymd(end) };
}

function inventoryEntry(body) {
  if (body == null) return { ok: false };
  if (Array.isArray(body.data)) {
    const first = body.data[0];
    return {
      ok: true,
      count: body.data.length,
      sampleKeys: first && typeof first === 'object' ? Object.keys(first) : [],
    };
  }
  if (typeof body === 'object') {
    return { ok: true, count: 1, sampleKeys: Object.keys(body) };
  }
  return { ok: true, count: 0, sampleKeys: [] };
}

function loadOwnerIdsFromGoals() {
  const goalsPath = path.join(repoRoot, 'data', 'goals.json');
  if (!fs.existsSync(goalsPath)) return [];
  const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  return (goals.owners || []).map((o) => o.id).filter(Boolean);
}

async function pullOwner(ownerId, days) {
  const window = dateWindow(days);
  console.log(`\n=== Oura pull: ${ownerId} (${window.start_date} → ${window.end_date}) ===`);

  const accessToken = await getValidAccessToken(ownerId);
  const payload = {
    ownerId,
    pulledAt: new Date().toISOString(),
    window,
    endpoints: {},
    inventory: {},
  };

  for (const ep of ENDPOINTS) {
    try {
      const query = ep.dated ? window : {};
      const body = await ouraGet(accessToken, ep.path, query);
      payload.endpoints[ep.key] = body;
      payload.inventory[ep.key] = inventoryEntry(body);
      const inv = payload.inventory[ep.key];
      console.log(
        `  ✓ ${ep.key}: ${inv.count} record(s)` +
          (inv.sampleKeys?.length ? ` — keys: ${inv.sampleKeys.slice(0, 12).join(', ')}${inv.sampleKeys.length > 12 ? ', …' : ''}` : ''),
      );
    } catch (err) {
      payload.endpoints[ep.key] = null;
      payload.inventory[ep.key] = {
        ok: false,
        status: err.status || null,
        error: err.message,
        body: err.body || null,
      };
      console.log(`  ✗ ${ep.key}: ${err.message}`);
    }
  }

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${ownerId}-latest.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
  return payload;
}

async function main() {
  const { ownerId, all, days } = parseArgs(process.argv);
  if (!ownerId && !all) {
    console.error('Usage:');
    console.error('  node scripts/oura-pull.mjs --owner <id> [--days 14]');
    console.error('  node scripts/oura-pull.mjs --all [--days 14]');
    process.exit(1);
  }

  const ids = all
    ? loadOwnerIdsFromGoals().filter((id) => fs.existsSync(ouraOwnerEnvPath(id)))
    : [ownerId];

  if (all) {
    const fromGoals = loadOwnerIdsFromGoals();
    for (const id of fromGoals) {
      if (!fs.existsSync(ouraOwnerEnvPath(id))) {
        console.log(`Skipping ${id} — no token file at ${ouraOwnerEnvPath(id)}`);
      }
    }
    if (!ids.length) {
      console.error('No owners with Oura tokens found. Run oura-auth-setup per owner first.');
      process.exit(1);
    }
  }

  for (const id of ids) {
    await pullOwner(id, days);
  }
  console.log('\nDone. Inspect data/oura/*-latest.json, then brainstorm product use.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
