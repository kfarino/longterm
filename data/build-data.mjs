#!/usr/bin/env node
// Reads goals.json + accounts.json and writes data.js as `window.DATA = {...}`.
// dashboard_v5.html is opened as a local file (file://), where fetch() of local
// JSON is blocked by the browser — data.js is a plain <script> include instead.
// Run this after editing goals.json/accounts.json, or let networth-pull.mjs /
// budget-tracking-pull.mjs (in ../scripts/) call it automatically after
// refreshing accounts.json / budget_tracking.json.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const goals = JSON.parse(readFileSync(join(here, 'goals.json'), 'utf8'));
const accountsRaw = JSON.parse(readFileSync(join(here, 'accounts.json'), 'utf8'));
const budgetTracking = JSON.parse(readFileSync(join(here, 'budget_tracking.json'), 'utf8'));

const favoritePlacesPath = join(here, 'favorite_places.json');
const favoritePlaces = existsSync(favoritePlacesPath)
  ? JSON.parse(readFileSync(favoritePlacesPath, 'utf8'))
  : null;

const todosPath = join(here, 'todos.json');
const todos = existsSync(todosPath)
  ? JSON.parse(readFileSync(todosPath, 'utf8'))
  : { items: [], weeklyGoals: [] };

function flattenOwnerAmounts(bucket) {
  return {
    kevin: bucket.kevin.amount,
    hanna: bucket.hanna.amount,
  };
}

const accounts = {
  asOf: accountsRaw.meta.asOf,
  assets: {
    retirement: flattenOwnerAmounts(accountsRaw.balances.retirement),
    brokerage: flattenOwnerAmounts(accountsRaw.balances.brokerage),
    cash: flattenOwnerAmounts(accountsRaw.balances.cash),
    homeEquity: flattenOwnerAmounts(accountsRaw.balances.homeEquity),
  },
  futureAssets: accountsRaw.futureAssets,
};

const DATA = {
  family: goals.family,
  assets: accounts.assets,
  futureAssets: accounts.futureAssets,
  accountsAsOf: accounts.asOf,
  phases: goals.phases,
  goals: goals.lifeGoals,
  timeline: goals.timeline,
  decisions: goals.decisions,
  travel: goals.travel,
  chart: goals.chart,
  favoritePlaces,
  todos: { items: todos.items || [], weeklyGoals: todos.weeklyGoals || [] },
  diningRoutine: goals.diningRoutine || [],
  lowKeyHangIdeas: goals.lowKeyHangIdeas || [],
  budgetTracking: {
    // target is derived from the current phase's expense line, never a
    // separately hand-typed number — goals.json is the only place it's typed.
    joint: { ...budgetTracking.joint, target: goals.phases[0].expenses[budgetTracking.joint.targetExpenseKey] },
    kevinPersonal: { ...budgetTracking.kevinPersonal, target: goals.phases[0].expenses[budgetTracking.kevinPersonal.targetExpenseKey] },
    travel: budgetTracking.travel,
  },
};

const out = `// GENERATED FILE — do not hand-edit. Run build-data.mjs after changing
// goals.json or accounts.json (networth-pull.mjs does this automatically
// after refreshing accounts.json from Monarch).
window.DATA = ${JSON.stringify(DATA, null, 2)};
`;

writeFileSync(join(here, 'data.js'), out, 'utf8');
console.log('Wrote data.js (accounts asOf ' + accounts.asOf + ')');
