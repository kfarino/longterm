#!/usr/bin/env node
// Copy examples/*.example.json → data/* for a fresh clone. Never overwrites
// existing local files (your household data stays yours). Use --force only
// when intentionally resetting a file from the example.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const examplesDir = path.join(root, 'examples');
const dataDir = path.join(root, 'data');

const FORCE = process.argv.includes('--force');

const COPIES = [
  ['goals.example.json', 'goals.json'],
  ['accounts.example.json', 'accounts.json'],
  ['budget_tracking.example.json', 'budget_tracking.json'],
  ['month_plan_events.example.json', 'month_plan_events.json'],
  ['todos.example.json', 'todos.json'],
  ['telegram-owners.example.json', 'telegram-owners.json'],
  ['favorite_places.example.json', 'favorite_places.json'],
  ['favorite_places_raw.example.json', 'favorite_places_raw.json'],
  ['calendar-sync-state.example.json', 'calendar-sync-state.json'],
];

const EMPTY_JSONL = [
  'telegram-conversation-log.jsonl',
  'telegram-recap-log.jsonl',
  'telegram-unparsed.jsonl',
  'telegram-planning-notes.jsonl',
  'goals-changelog.jsonl',
];

const EMPTY_JSON = [
  ['telegram-offset.json', { next_offset: null, updated_at: null }],
  ['telegram-pending-clarifications.json', {}],
  ['dining-routine-overrides.json', {
    family_dinner: null,
    date_night: null,
    weekend_social: null,
  }],
];

function copyExample(srcName, destName) {
  const src = path.join(examplesDir, srcName);
  const dest = path.join(dataDir, destName);
  if (!fs.existsSync(src)) {
    console.warn(`skip missing example: ${srcName}`);
    return;
  }
  if (fs.existsSync(dest) && !FORCE) {
    console.log(`keep existing ${destName}`);
    return;
  }
  fs.copyFileSync(src, dest);
  console.log(`${FORCE && fs.existsSync(dest) ? 'replaced' : 'created'} ${destName}`);
}

function ensureJson(destName, value) {
  const dest = path.join(dataDir, destName);
  if (fs.existsSync(dest) && !FORCE) {
    console.log(`keep existing ${destName}`);
    return;
  }
  fs.writeFileSync(dest, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`${FORCE ? 'replaced' : 'created'} ${destName}`);
}

function ensureEmptyJsonl(destName) {
  const dest = path.join(dataDir, destName);
  if (fs.existsSync(dest) && !FORCE) {
    console.log(`keep existing ${destName}`);
    return;
  }
  fs.writeFileSync(dest, '');
  console.log(`${FORCE ? 'replaced' : 'created'} ${destName}`);
}

fs.mkdirSync(dataDir, { recursive: true });
for (const [src, dest] of COPIES) copyExample(src, dest);
for (const [name, value] of EMPTY_JSON) ensureJson(name, value);
for (const name of EMPTY_JSONL) ensureEmptyJsonl(name);

console.log('\nNext: edit data/goals.json (owners, phases, …), then:');
console.log('  node data/build-data.mjs');
console.log('  node data/build-goal-plan-md.mjs');
console.log('  npm run dev');
