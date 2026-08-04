# Dining Recommendations & Month Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dining-recommendation engine and a new "Month Plan" dashboard tab that suggests restaurants (or free hangs) for a weekly family-dinner/date-night/weekend-social routine, sized to actual budget pacing and recent dining history.

**Architecture:** Two new data files (`favorite_places_raw.json`, hand/on-demand-synced; `favorite_places.json`, auto-refreshed daily as a byproduct of the existing Monarch pull) feed two new pure functions in `dashboard_v5.html` (`planRemainingMonth`, `recommendForSlot`) that compute the plan live in the browser, matching the dashboard's existing pattern of never baking projections into static data.

**Tech Stack:** Vanilla JS in a single HTML file (dashboard), Node.js (data-processing scripts), JSON data files. No new dependencies.

## Global Constraints

- Design spec: `Longterm/docs/superpowers/specs/2026-07-26-dining-recommendations-design.md` — follow it exactly; this plan does not deviate from it.
- `dashboard_v5.html` is a pure renderer — no hardcoded figures, everything reads from `window.DATA` (built by `data/build-data.mjs`).
- `data/build-data.mjs` and `Longterm/scripts/budget-tracking-pull.mjs` must keep working for existing data (net worth, joint/personal/travel trackers) — this plan only adds to them.
- Tier vocabulary is exactly `cheap` | `mid` | `high` (favorites/fixed slots) plus `low-key` (dynamic-slot fallback only) — do not introduce other tier names.
- Restaurants & Bars historical share of joint spend is a fixed v1 constant: `0.24`.
- Tier $ thresholds (from observed avg spend): `< 40` → cheap, `40–90` → mid, `> 90` → high. Tier $ midpoints (for cost estimation): cheap=25, mid=75, high=150.
- Dining-activity lookback window: 90 days. Recent-visit exclusion window in `recommendForSlot`: 10 days.
- No additional Monarch API calls beyond what `budget-tracking-pull.mjs` already makes.

---

### Task 1: Reusable dashboard test harness

**Files:**
- Create: `Longterm/data/dashboard-test-harness.mjs`
- Test: (this task's own smoke-test step below)

**Interfaces:**
- Consumes: `Longterm/dashboard_v5.html` (reads and evals its main `<script>` block), `Longterm/data/data.js` (as the default `window.DATA`).
- Produces: `loadDashboard(dataOverride)` — an exported function later tasks import. Returns an object of every function/value listed in `exportNames` below, keyed by name (e.g. `{ D, renderMonthPlan, planRemainingMonth, ... }`). `dataOverride` is a plain object shallow-merged onto the real bundled `DATA` before the dashboard script runs, so tests can override just the pieces they care about (e.g. `{ favoritePlaces: {...} }`) without hand-building the entire dataset.

This extracts the ad hoc Node harness pattern used repeatedly earlier in this project's history (stubbing `document`/`window` well enough to execute the dashboard's script block outside a browser) into a permanent, reusable file.

- [ ] **Step 1: Write the harness**

```js
// Longterm/data/dashboard-test-harness.mjs
// Headless harness for exercising dashboard_v5.html's render functions
// without a browser. Stubs document/window enough for the dashboard's
// <script> block to execute, then hands back every function/value named
// in exportNames so tests can call them directly.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardPath = path.join(here, '..', 'dashboard_v5.html');
const dataJsPath = path.join(here, 'data.js');

class FakeEl {
  constructor() {
    this._html = '';
    this.style = {};
    this.dataset = {};
    this.classList = { add() {}, remove() {}, contains() { return false; } };
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  set textContent(v) { this._text = v; }
  get textContent() { return this._text || ''; }
  addEventListener() {}
  querySelectorAll() { return []; }
  querySelector() { return null; }
  getContext() { return {}; }
}

const exportNames = [
  'D', 'computeProjection', 'phaseIncome', 'phaseExpenses', 'totalNW',
  'renderTrajectory', 'updateP6', 'show',
  'planRemainingMonth', 'recommendForSlot', 'renderMonthPlan', 'cycleEndDate', 'isoDate',
];

export function loadDashboard(dataOverride) {
  const html = fs.readFileSync(dashboardPath, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>\s*<\/body>/);
  if (!match) throw new Error('Could not find main <script> block in dashboard_v5.html');
  const script = match[1];

  const elements = {};
  global.document = {
    getElementById(id) {
      if (!elements[id]) elements[id] = new FakeEl();
      return elements[id];
    },
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };

  const bundled = JSON.parse(
    fs.readFileSync(dataJsPath, 'utf8')
      .replace(/^[\s\S]*?window\.DATA\s*=\s*/, '')
      .replace(/;\s*$/, '')
  );
  global.window = { DATA: dataOverride ? { ...bundled, ...dataOverride } : bundled };
  global.Chart = function (ctx, cfg) { this.data = cfg.data; this.update = () => {}; };

  const exportStatements = exportNames
    .map((n) => `global.__${n} = typeof ${n} !== 'undefined' ? ${n} : undefined;`)
    .join('\n');

  const fn = new Function(script + '\n' + exportStatements);
  fn();

  const result = {};
  for (const name of exportNames) result[name] = global[`__${name}`];
  return { ...result, elements };
}
```

- [ ] **Step 2: Smoke-test the harness**

Run:
```bash
node -e "
import('./Longterm/data/dashboard-test-harness.mjs').then(({ loadDashboard }) => {
  const { D, totalNW } = loadDashboard();
  console.log('D.family.name:', D.family.name);
  console.log('totalNW():', totalNW());
});
"
```
Expected: prints `D.family.name: Kevin & Hanna Farino` and a numeric net worth (no thrown error). If it throws, the regex in Step 1 isn't matching `dashboard_v5.html`'s current structure — open the file and confirm the main script tag still immediately precedes `</body>`.

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/data/dashboard-test-harness.mjs
git commit -m "Add reusable headless test harness for dashboard_v5.html"
```

---

### Task 2: `favorite_places_raw.json` — favorites list snapshot

**Files:**
- Create: `Longterm/data/favorite_places_raw.json`

**Interfaces:**
- Produces: an array of `{ name: string, cuisine: string|null, location: string|null, list: "go-to"|"want-to-go"|"tried", notes: string|null }` objects, plus an optional `familyFriendly: true` field on the four entries tagged for the Wednesday family-dinner slot (Great White, Neighborly, Sugarfish, Terroni — omitted, not `false`, on every other entry). Task 5 reads this file by path; no function interface.

This is a one-time transcription of the Google Sheet content already read into this project (`https://docs.google.com/spreadsheets/d/1-5KiintV2071nkjkF5zb_P-erWYOknn8hWtMLBBlyDM`) as of 2026-07-26. The sheet's "Just drinks" and entertainment-venue sections are intentionally excluded (out of scope per the design spec).

- [ ] **Step 1: Write the file**

```json
[
  { "name": "Piccolino", "cuisine": "Italian", "location": "WeHo Robertson", "list": "go-to", "notes": null },
  { "name": "Terra Eataly", "cuisine": "Italian", "location": "Century City", "list": "go-to", "notes": null },
  { "name": "Ippudo ramen", "cuisine": "Ramen", "location": "WeHo Santa Monica", "list": "go-to", "notes": null },
  { "name": "Blossom", "cuisine": "Pho", "location": "Santa Monica", "list": "go-to", "notes": null },
  { "name": "Petit Trois", "cuisine": "French", "location": "Hollywood", "list": "go-to", "notes": "Indoor is cooler than outdoor and vibey; great drinks." },
  { "name": "Bestia", "cuisine": "American", "location": "DTLA", "list": "go-to", "notes": null },
  { "name": "South Beverly Grill", "cuisine": "American & Sushi", "location": "Beverly Hills", "list": "go-to", "notes": null },
  { "name": "R and D Kitchen", "cuisine": "American", "location": "Santa Monica", "list": "go-to", "notes": null },
  { "name": "Daikokuya Sawtelle", "cuisine": "Ramen", "location": "Sawtelle", "list": "go-to", "notes": null },
  { "name": "Kismet", "cuisine": "Middle Eastern", "location": "Silverlake", "list": "go-to", "notes": null },
  { "name": "Rose cafe", "cuisine": "American", "location": "Venice", "list": "go-to", "notes": null },
  { "name": "Marvin", "cuisine": "French", "location": "WeHo", "list": "go-to", "notes": null },
  { "name": "Pace", "cuisine": "Italian / American", "location": "Laurel Canyon", "list": "go-to", "notes": null },
  { "name": "The Little Door", "cuisine": "French", "location": "WeHo", "list": "go-to", "notes": null },
  { "name": "Dudley market", "cuisine": "Fish + Burger", "location": "Venice", "list": "go-to", "notes": null },
  { "name": "Hatchet Hall / Old Man Bar", "cuisine": "American", "location": "Venice", "list": "go-to", "notes": null },
  { "name": "Cassia", "cuisine": "Fusion", "location": "Santa Monica", "list": "go-to", "notes": "Permanently closed." },
  { "name": "Birdie G's", "cuisine": "American", "location": "Santa Monica", "list": "go-to", "notes": null },
  { "name": "Saffy's", "cuisine": "Mediterranean", "location": "Hollywood", "list": "go-to", "notes": null },
  { "name": "Horses", "cuisine": "American", "location": "Hollywood", "list": "go-to", "notes": null },
  { "name": "S! Mon", "cuisine": "Caribbean", "location": "Venice", "list": "go-to", "notes": null },
  { "name": "Baltaire", "cuisine": "Steak", "location": "Brentwood", "list": "go-to", "notes": "Love to sit at the bar; live music Th-Sat." },
  { "name": "Polo Lounge", "cuisine": "Steak", "location": "Beverly Hills", "list": "go-to", "notes": null },
  { "name": "Cobis", "cuisine": "South Asian", "location": "Santa Monica", "list": "go-to", "notes": null },
  { "name": "Irori sushi", "cuisine": "Sushi", "location": "Marina del Rey", "list": "go-to", "notes": null },
  { "name": "Great White", "cuisine": "American", "location": "Venice", "list": "go-to", "notes": null, "familyFriendly": true },
  { "name": "Neighborly", "cuisine": "American", "location": "Brentwood", "list": "go-to", "notes": "Stroller-friendly family dinner spot.", "familyFriendly": true },
  { "name": "Sugarfish", "cuisine": "Sushi", "location": "Brentwood", "list": "go-to", "notes": "Stroller-friendly family dinner spot.", "familyFriendly": true },
  { "name": "Terroni", "cuisine": "Italian", "location": "Brentwood", "list": "go-to", "notes": "Stroller-friendly family dinner spot.", "familyFriendly": true },
  { "name": "Great outdoor", "cuisine": "American", "location": "Santa Monica", "list": "go-to", "notes": null },
  { "name": "Quarter sheets", "cuisine": "Pizza", "location": "Echo Park", "list": "go-to", "notes": null },
  { "name": "La Dolce Vita", "cuisine": "Italian", "location": "Beverly Hills", "list": "go-to", "notes": null },
  { "name": "Din Tai Fung", "cuisine": "Chinese", "location": "Century City", "list": "go-to", "notes": null },
  { "name": "Magal", "cuisine": "Korean", "location": "Ktown", "list": "go-to", "notes": null },
  { "name": "Farmshop", "cuisine": "American", "location": "Brentwood", "list": "go-to", "notes": null },
  { "name": "Not no bar", "cuisine": "Pizza", "location": "Venice", "list": "go-to", "notes": null },
  { "name": "Pizzeria Mozza", "cuisine": "Pizza", "location": "Hollywood", "list": "go-to", "notes": null },
  { "name": "Felix", "cuisine": "Italian", "location": "Santa Monica", "list": "go-to", "notes": "Try your luck as a walk-in at the bar." },
  { "name": "Found Oyster", "cuisine": "Seafood", "location": "Hollywood", "list": "go-to", "notes": null },
  { "name": "Palmeri", "cuisine": "Italian", "location": "Brentwood", "list": "go-to", "notes": null },
  { "name": "Violet Bistro", "cuisine": "French", "location": "Westwood", "list": "go-to", "notes": null },

  { "name": "Stella", "cuisine": "Italian", "location": "Hollywood", "list": "want-to-go", "notes": null },
  { "name": "Mother Wolf", "cuisine": "Italian", "location": "Hollywood", "list": "want-to-go", "notes": null },
  { "name": "Sushi Sasabune", "cuisine": "Sushi", "location": "West LA", "list": "want-to-go", "notes": null },
  { "name": "matu", "cuisine": "Steak", "location": "Beverly Hills", "list": "want-to-go", "notes": null },
  { "name": "Anajak", "cuisine": "Thai", "location": "Valley", "list": "want-to-go", "notes": null },
  { "name": "Donna's", "cuisine": "Italian", "location": "Echo Park", "list": "want-to-go", "notes": null },
  { "name": "Botanica", "cuisine": "American", "location": "Silverlake", "list": "want-to-go", "notes": null },
  { "name": "Violet", "cuisine": "French", "location": "Westwood", "list": "want-to-go", "notes": null },
  { "name": "Dear John's", "cuisine": "Steak", "location": "West LA", "list": "want-to-go", "notes": null },
  { "name": "Marea", "cuisine": "Seafood", "location": "Beverly Hills", "list": "want-to-go", "notes": null },
  { "name": "maru kai", "cuisine": "Steak", "location": "Brentwood", "list": "want-to-go", "notes": null },
  { "name": "Casa", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },
  { "name": "Mr Chow", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },
  { "name": "Lasita", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },
  { "name": "Bicyclette", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },
  { "name": "Caffe delphini", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },
  { "name": "Polo Lounge Beverly Hills hotel", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },
  { "name": "Genwa", "cuisine": "Korean", "location": null, "list": "want-to-go", "notes": null },
  { "name": "Quarters", "cuisine": "Korean", "location": null, "list": "want-to-go", "notes": null },
  { "name": "Berbere", "cuisine": "Ethiopian", "location": "SM", "list": "want-to-go", "notes": null },
  { "name": "Shiku", "cuisine": "Korean", "location": "DT", "list": "want-to-go", "notes": null },
  { "name": "Majordomo", "cuisine": "Chinese", "location": null, "list": "want-to-go", "notes": null },
  { "name": "Jar", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },
  { "name": "Koi", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },
  { "name": "Ospi", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },
  { "name": "Simpand", "cuisine": "South Asian", "location": null, "list": "want-to-go", "notes": null },
  { "name": "The Nice Guy", "cuisine": "Restaurant + club", "location": null, "list": "want-to-go", "notes": null },
  { "name": "Playa Provisions", "cuisine": null, "location": "PDR", "list": "want-to-go", "notes": null },
  { "name": "The Strand", "cuisine": null, "location": "Manhattan Beach", "list": "want-to-go", "notes": null },
  { "name": "Owa", "cuisine": null, "location": "Venice", "list": "want-to-go", "notes": null },
  { "name": "Market", "cuisine": null, "location": "Venice", "list": "want-to-go", "notes": null },
  { "name": "Bar 88", "cuisine": null, "location": null, "list": "want-to-go", "notes": null },

  { "name": "Proper hotel", "cuisine": "American", "location": "Santa Monica", "list": "tried", "notes": "Would go for afternoon drinks, not dinner/food." },
  { "name": "Cha Cha Cha", "cuisine": "Mexican", "location": null, "list": "tried", "notes": "Would go for afternoon drinks, not dinner/food." },
  { "name": "Rustic canyon", "cuisine": "American", "location": null, "list": "tried", "notes": null },
  { "name": "Shirube", "cuisine": "Japanese", "location": null, "list": "tried", "notes": "Bar food, oily." },
  { "name": "Cento", "cuisine": null, "location": null, "list": "tried", "notes": null },
  { "name": "Luv 2 Eat Thai", "cuisine": null, "location": null, "list": "tried", "notes": null },
  { "name": "Upper west", "cuisine": "American", "location": "West LA", "list": "tried", "notes": null },
  { "name": "Rasarumah", "cuisine": null, "location": "Filipinotown", "list": "tried", "notes": null },
  { "name": "Pasjoli", "cuisine": "French", "location": "Santa Monica", "list": "tried", "notes": "PJ martini and apps at the bar." },
  { "name": "Agassi Gopchang", "cuisine": "Korean", "location": "Ktown", "list": "tried", "notes": null },
  { "name": "Genever", "cuisine": "Drinks", "location": "Filipinotown", "list": "tried", "notes": "Permanently closed, replaced by Shim Sham." },
  { "name": "Foodshop", "cuisine": null, "location": null, "list": "tried", "notes": "Invite only; fun." },
  { "name": "Pijja Palace", "cuisine": "Indian", "location": "Silverlake", "list": "tried", "notes": null },
  { "name": "Casablanca Moroccan kitchen", "cuisine": null, "location": null, "list": "tried", "notes": "Very quiet depending on the night." },
  { "name": "Casablanca", "cuisine": "Mexican", "location": "Venice", "list": "tried", "notes": null }
]
```

- [ ] **Step 2: Validate**

Run: `node -e "JSON.parse(require('fs').readFileSync('Longterm/data/favorite_places_raw.json','utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/data/favorite_places_raw.json
git commit -m "Add favorite_places_raw.json snapshot from the dining Google Sheet"
```

---

### Task 3: `goals.json` — `diningRoutine` and `lowKeyHangIdeas`

**Files:**
- Modify: `Longterm/data/goals.json`

**Interfaces:**
- Produces: `goals.diningRoutine` — array of `{ dayOfWeek: 0-6, occasion: string, tier: "cheap"|"mid"|"high", dynamic: boolean, requiresTag?: string }`. `requiresTag`, when present, names a boolean field on a favorite place (e.g. `"familyFriendly"`) that Task 7's `recommendForSlot` uses to restrict candidates for this slot to only tagged favorites. `goals.lowKeyHangIdeas` — array of strings. Task 4 reads both by key name.

- [ ] **Step 1: Add the two keys**

Open `Longterm/data/goals.json` and add these two top-level keys (place them after the existing `"chart"` block, before the closing `}` of the file — i.e. change the file's ending from:

```json
  "chart": {
    "growthRate": 0.07,
    "liquidRate": 0.02,
    "croatiaK": 1000,
    "kevin300kYr": 2027,
    "sabbaticalK": 150,
    "sabbaticalYear": 2036,
    "croatiaYear": 2033,
    "hannaScenario": "neutral",
    "goPayoutYear": 2034,
    "goPayout": 3000000,
    "annualRetirementContribution": 46000
  }
}
```

to:

```json
  "chart": {
    "growthRate": 0.07,
    "liquidRate": 0.02,
    "croatiaK": 1000,
    "kevin300kYr": 2027,
    "sabbaticalK": 150,
    "sabbaticalYear": 2036,
    "croatiaYear": 2033,
    "hannaScenario": "neutral",
    "goPayoutYear": 2034,
    "goPayout": 3000000,
    "annualRetirementContribution": 46000
  },

  "diningRoutine": [
    { "dayOfWeek": 3, "occasion": "Family dinner (stroller-friendly)", "tier": "mid", "dynamic": false, "requiresTag": "familyFriendly" },
    { "dayOfWeek": 5, "occasion": "Date night", "tier": "mid", "dynamic": false },
    { "dayOfWeek": 6, "occasion": "Date night", "tier": "mid", "dynamic": false },
    { "dayOfWeek": 0, "occasion": "Weekend social", "tier": "mid", "dynamic": true }
  ],

  "lowKeyHangIdeas": [
    "Host game night",
    "Walk + coffee at home",
    "Movie night in",
    "Cook a new recipe together"
  ]
}
```

- [ ] **Step 2: Validate**

Run: `node -e "const g = JSON.parse(require('fs').readFileSync('Longterm/data/goals.json','utf8')); console.log(g.diningRoutine.length, g.lowKeyHangIdeas.length)"`
Expected: `4 4`

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/data/goals.json
git commit -m "Add diningRoutine and lowKeyHangIdeas to goals.json"
```

---

### Task 4: `build-data.mjs` bundles favorites data into `data.js`

**Files:**
- Modify: `Longterm/data/build-data.mjs`

**Interfaces:**
- Consumes: `Longterm/data/favorite_places.json` (may not exist yet — Task 5 creates it; must handle absence gracefully), `goals.diningRoutine`, `goals.lowKeyHangIdeas` (from Task 3).
- Produces: `DATA.favoritePlaces` (the full parsed contents of `favorite_places.json`, or `null` if the file doesn't exist), `DATA.diningRoutine`, `DATA.lowKeyHangIdeas` — new top-level keys in the bundled `window.DATA` object that `dashboard_v5.html` reads.

- [ ] **Step 1: Add the import and read**

In `Longterm/data/build-data.mjs`, change the import line:
```js
import { readFileSync, writeFileSync } from 'node:fs';
```
to:
```js
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
```

Then, directly below the existing `const budgetTracking = ...` line, add:
```js
const favoritePlacesPath = join(here, 'favorite_places.json');
const favoritePlaces = existsSync(favoritePlacesPath)
  ? JSON.parse(readFileSync(favoritePlacesPath, 'utf8'))
  : null;
```

- [ ] **Step 2: Bundle into `DATA`**

In the `const DATA = { ... }` object, add three keys after the existing `chart: goals.chart,` line:
```js
  chart: goals.chart,
  favoritePlaces,
  diningRoutine: goals.diningRoutine || [],
  lowKeyHangIdeas: goals.lowKeyHangIdeas || [],
  budgetTracking: {
```
(This just inserts the three new lines between the existing `chart:` line and the existing `budgetTracking: {` line — nothing else in the file changes.)

- [ ] **Step 3: Run it and verify**

Run:
```bash
node Longterm/data/build-data.mjs
node -e "
const d = JSON.parse(require('fs').readFileSync('Longterm/data/data.js','utf8').replace(/^[\s\S]*?window\.DATA\s*=\s*/, '').replace(/;\s*\$/, ''));
console.log('favoritePlaces:', d.favoritePlaces);
console.log('diningRoutine length:', d.diningRoutine.length);
console.log('lowKeyHangIdeas length:', d.lowKeyHangIdeas.length);
"
```
Expected: `favoritePlaces: null` (Task 5 hasn't run yet), `diningRoutine length: 4`, `lowKeyHangIdeas length: 4`.

- [ ] **Step 4: Commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/data/build-data.mjs Longterm/data/data.js
git commit -m "Bundle favoritePlaces/diningRoutine/lowKeyHangIdeas into data.js"
```

---

### Task 5: Extend `budget-tracking-pull.mjs` to self-update `favorite_places.json`

**Files:**
- Modify: `C:\Users\Family\Documents\Family\Finances\Longterm\scripts\budget-tracking-pull.mjs`

**Interfaces:**
- Consumes: `Longterm/data/favorite_places_raw.json` (Task 2). Uses the `transactions` array already fetched in `main()` (no new Monarch calls), and the already-defined `spendAmount`, `categoryName`, `accountLabel`, `isoDate`, `writeJson` helper functions.
- Produces: `Longterm/data/favorite_places.json` matching the shape: `{ meta: { lastRegenerated, lookbackDays }, places: [{ ...raw fields, observed: { tier, avgSpend, visitCount, lastVisited } | null }], recentDiningActivity: [{ date, merchant, amount, matchedPlace, account }] }`.

- [ ] **Step 1: Add the dining-matching and tier-bucketing helpers**

In `Longterm/scripts/budget-tracking-pull.mjs`, directly below the existing `daysInMonth` function (before `function isoDate(d) {`), add:

```js
const DINING_CATEGORY_NAMES = new Set(['restaurants & bars']);
const DINING_LOOKBACK_DAYS = 90;

function matchFavorite(merchant, favorites) {
  const m = merchant.toLowerCase();
  if (!m) return null;
  return favorites.find((f) => {
    const name = f.name.toLowerCase();
    return m.includes(name) || name.includes(m);
  }) || null;
}

function tierFromAvg(avg) {
  if (avg < 40) return 'cheap';
  if (avg <= 90) return 'mid';
  return 'high';
}
```

- [ ] **Step 2: Add `refreshFavoritePlaces`**

Directly below the helpers from Step 1, add:

```js
// Self-updates favorite_places.json from transactions budget-tracking-pull.mjs
// already fetched this run — zero additional Monarch calls. Silently does
// nothing if favorite_places_raw.json hasn't been synced yet (Task 2 of the
// dining-recommendations plan) rather than erroring the whole pull.
function refreshFavoritePlaces(rawPath, outPath, transactions, today) {
  if (!fs.existsSync(rawPath)) return;
  const raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  const existing = fs.existsSync(outPath)
    ? JSON.parse(fs.readFileSync(outPath, 'utf8'))
    : { recentDiningActivity: [] };
  const existingKeys = new Set(
    existing.recentDiningActivity.map((a) => `${a.date}|${a.merchant}|${a.amount}|${a.account}`)
  );

  const newEntries = [];
  for (const txn of transactions) {
    const amount = spendAmount(txn);
    if (amount === 0) continue;
    const cat = categoryName(txn).toLowerCase();
    if (!DINING_CATEGORY_NAMES.has(cat)) continue;
    const merchant = txn.merchant || txn.plaidName || '';
    const account = accountLabel(txn);
    const roundedAmount = Math.round(amount * 100) / 100;
    const key = `${txn.date}|${merchant}|${roundedAmount}|${account}`;
    if (existingKeys.has(key)) continue;
    const match = matchFavorite(merchant, raw);
    newEntries.push({
      date: txn.date,
      merchant,
      amount: roundedAmount,
      matchedPlace: match ? match.name : null,
      account,
    });
    existingKeys.add(key);
  }

  const cutoff = new Date(today);
  cutoff.setDate(cutoff.getDate() - DINING_LOOKBACK_DAYS);
  const recentDiningActivity = [...existing.recentDiningActivity, ...newEntries]
    .filter((a) => new Date(a.date) >= cutoff)
    .sort((a, b) => a.date.localeCompare(b.date));

  const places = raw.map((f) => {
    const visits = recentDiningActivity.filter((a) => a.matchedPlace === f.name);
    if (!visits.length) return { ...f, observed: null };
    const avgSpend = Math.round((visits.reduce((s, v) => s + v.amount, 0) / visits.length) * 100) / 100;
    return {
      ...f,
      observed: {
        tier: tierFromAvg(avgSpend),
        avgSpend,
        visitCount: visits.length,
        lastVisited: visits[visits.length - 1].date,
      },
    };
  });

  writeJson(outPath, {
    meta: { lastRegenerated: isoDate(today), lookbackDays: DINING_LOOKBACK_DAYS },
    places,
    recentDiningActivity,
  });
}
```

- [ ] **Step 3: Call it from `main()`**

In `main()`, directly below the existing block:
```js
    tracking.travel.unmatched = unmatched;
    tracking.meta.lastRegenerated = isoDate(today);

    writeJson(args.outputPath, tracking);
```
add a call before `writeJson`:
```js
    tracking.travel.unmatched = unmatched;
    tracking.meta.lastRegenerated = isoDate(today);

    const favoriteRawPath = path.join(path.dirname(args.outputPath), 'favorite_places_raw.json');
    const favoritePlacesPath = path.join(path.dirname(args.outputPath), 'favorite_places.json');
    refreshFavoritePlaces(favoriteRawPath, favoritePlacesPath, transactions, today);

    writeJson(args.outputPath, tracking);
```

- [ ] **Step 4: Run it against live Monarch data**

Run:
```powershell
cd "C:\Users\Family\Documents\Family\Finances\Longterm\scripts"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\budget-tracking-pull.ps1
```
Expected: exits with the usual `{"ok":true,...}` JSON line (no new fields needed in that output — this task doesn't change the script's stdout contract). Then run:
```bash
node -e "
const f = JSON.parse(require('fs').readFileSync('C:/Users/Family/Documents/Family/Finances/Longterm/data/favorite_places.json','utf8'));
console.log('places:', f.places.length);
console.log('recentDiningActivity:', f.recentDiningActivity.length);
console.log('Great White entry:', f.places.find(p => p.name === 'Great White'));
"
```
Expected: `places: 88` (matching Task 2's list length), `recentDiningActivity` at least 1, and the Great White entry shows a non-null `observed` block (Great White has confirmed real spend on 2026-07-24 per this project's transaction history) — if `observed` is `null` for Great White specifically, the merchant-matching in Step 2 needs debugging before moving on.

- [ ] **Step 5: Regenerate `data.js` and confirm it's no longer null**

Run:
```bash
node "C:\Users\Family\Documents\Family\Finances\Longterm\data\build-data.mjs"
node -e "
const d = JSON.parse(require('fs').readFileSync('C:/Users/Family/Documents/Family/Finances/Longterm/data/data.js','utf8').replace(/^[\s\S]*?window\.DATA\s*=\s*/, '').replace(/;\s*\$/, ''));
console.log('favoritePlaces is null:', d.favoritePlaces === null);
"
```
Expected: `favoritePlaces is null: false`

- [ ] **Step 6: Commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/scripts/budget-tracking-pull.mjs Longterm/data/favorite_places.json Longterm/data/data.js
git commit -m "Self-update favorite_places.json from the daily Monarch pull"
```

---

### Task 6: `planRemainingMonth()` in `dashboard_v5.html`

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Test: `Longterm/data/test-plan-remaining-month.mjs` (new, temporary test script — deleted at the end of this task after passing, per this repo's convention of no test files left in the shipped dashboard folder beyond the data pipeline scripts)

**Interfaces:**
- Consumes: `D.diningRoutine` (Task 3), `D.budgetTracking.joint` (existing: `{ target, weeks: [{actual, days}], cycleStart, cycleDays }`).
- Produces: `isoDate(date) -> string`, `cycleEndDate(cycleStartISO, cycleDays) -> Date`, `planRemainingMonth(diningRoutine, budgetPacing, today) -> { slots: [{date, occasion, tier, dynamic, requiresTag}], impliedRestaurantRoom, fixedRoutineCost, socialBudgetRemaining }` — all three are new global functions in the dashboard's script, consumed by Task 8's `renderMonthPlan()`. `requiresTag` (optional, e.g. `"familyFriendly"`) passes through unchanged from the matching `diningRoutine` entry — `planRemainingMonth` doesn't interpret it, only `recommendForSlot` (Task 7) does.

- [ ] **Step 1: Add `isoDate` helper**

In `Longterm/dashboard_v5.html`, find the existing helpers block:
```js
const $ = id => document.getElementById(id);
const fmt  = n => '$' + Math.round(n).toLocaleString();
const fmtM = n => n >= 1000000 ? '~$' + (n/1000000).toFixed(1) + 'M' : n >= 1000 ? '~$' + Math.round(n/1000) + 'K' : fmt(n);
```
and add a line directly after it:
```js
const $ = id => document.getElementById(id);
const fmt  = n => '$' + Math.round(n).toLocaleString();
const fmtM = n => n >= 1000000 ? '~$' + (n/1000000).toFixed(1) + 'M' : n >= 1000 ? '~$' + Math.round(n/1000) + 'K' : fmt(n);
const isoDate = d => d.toISOString().slice(0, 10);
```

- [ ] **Step 2: Write the failing test**

Create `Longterm/data/test-plan-remaining-month.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const { planRemainingMonth } = loadDashboard();
assert.ok(planRemainingMonth, 'planRemainingMonth should be defined');

const diningRoutine = [
  { dayOfWeek: 3, occasion: 'Family dinner (stroller-friendly)', tier: 'mid', dynamic: false, requiresTag: 'familyFriendly' },
  { dayOfWeek: 5, occasion: 'Date night', tier: 'mid', dynamic: false },
  { dayOfWeek: 6, occasion: 'Date night', tier: 'mid', dynamic: false },
  { dayOfWeek: 0, occasion: 'Weekend social', tier: 'mid', dynamic: true },
];

// Scenario A: plenty of room (target far exceeds actual-to-date) — dynamic
// slots should resolve to their configured tier (paid), not low-key.
const plentyOfRoom = { target: 5500, weeks: [{ actual: 100, days: 7 }], cycleStart: '2026-07-25', cycleDays: 30 };
const today = new Date('2026-07-26');
const resultA = planRemainingMonth(diningRoutine, plentyOfRoom, today);
const dynamicSlotsA = resultA.slots.filter((s) => s.dynamic);
assert.ok(dynamicSlotsA.length > 0, 'expected at least one dynamic slot in a 30-day cycle starting 7/25');
assert.ok(dynamicSlotsA.every((s) => s.tier === 'mid'), 'plenty of room should keep dynamic slots at their configured tier');

// Scenario B: fixed routine cost alone already exceeds the implied room —
// every dynamic slot should resolve to low-key.
const noRoom = { target: 100, weeks: [{ actual: 100, days: 7 }], cycleStart: '2026-07-25', cycleDays: 30 };
const resultB = planRemainingMonth(diningRoutine, noRoom, today);
const dynamicSlotsB = resultB.slots.filter((s) => s.dynamic);
assert.ok(dynamicSlotsB.length > 0, 'expected at least one dynamic slot');
assert.ok(dynamicSlotsB.every((s) => s.tier === 'low-key'), 'no budget room should force every dynamic slot to low-key');

// Fixed slots (family dinner, date night) must always appear regardless of budget.
const fixedCountA = resultA.slots.filter((s) => !s.dynamic).length;
const fixedCountB = resultB.slots.filter((s) => !s.dynamic).length;
assert.equal(fixedCountA, fixedCountB, 'fixed slot count must not depend on budget pacing');
assert.ok(fixedCountA > 0, 'expected at least one fixed slot in a 30-day cycle');

console.log('All planRemainingMonth tests passed.');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node Longterm/data/test-plan-remaining-month.mjs`
Expected: throws `planRemainingMonth should be defined` (or similar `AssertionError`) — the function doesn't exist in `dashboard_v5.html` yet.

- [ ] **Step 4: Implement `planRemainingMonth`**

In `Longterm/dashboard_v5.html`, directly above the line `function renderBudgetTracking() {`, add:

```js
/* ═══════════════════════════════
   DINING RECOMMENDATIONS — MONTH PLAN
   ═══════════════════════════════ */
const TIER_MIDPOINT = { cheap: 25, mid: 75, high: 150 };
const TIER_RANK = { cheap: 0, mid: 1, high: 2 };
const RESTAURANTS_HISTORICAL_SHARE = 0.24;
const RECENT_VISIT_EXCLUSION_DAYS = 10;

function cycleEndDate(cycleStartISO, cycleDays) {
  const start = new Date(cycleStartISO);
  const end = new Date(start);
  end.setDate(end.getDate() + cycleDays - 1);
  return end;
}

// Decides what happens on every remaining day of the current cycle. Fixed
// routine slots (dynamic:false) always happen at their configured tier.
// Dynamic slots (currently just "Weekend social") get resolved to either
// their configured tier (paid) or 'low-key' (free), by spending down
// whatever budget room is left after the fixed slots are accounted for —
// this is the "fill out the remainder of the month toward budget" logic.
function planRemainingMonth(diningRoutine, budgetPacing, today) {
  const cycleEnd = cycleEndDate(budgetPacing.cycleStart, budgetPacing.cycleDays);
  const slots = [];
  for (let d = new Date(today); d <= cycleEnd; d.setDate(d.getDate() + 1)) {
    const dow = d.getDay();
    for (const entry of diningRoutine.filter((r) => r.dayOfWeek === dow)) {
      slots.push({ date: isoDate(d), occasion: entry.occasion, tier: entry.tier, dynamic: entry.dynamic, requiresTag: entry.requiresTag });
    }
  }

  const fixedSlots = slots.filter((s) => !s.dynamic);
  const dynamicSlots = slots.filter((s) => s.dynamic);
  const fixedRoutineCost = fixedSlots.reduce((sum, s) => sum + (TIER_MIDPOINT[s.tier] || 0), 0);

  const actualToDate = budgetPacing.weeks.reduce((s, w) => s + w.actual, 0);
  const remainingJointRoom = Math.max(0, budgetPacing.target - actualToDate);
  const impliedRestaurantRoom = remainingJointRoom * RESTAURANTS_HISTORICAL_SHARE;

  let socialBudget = Math.max(0, impliedRestaurantRoom - fixedRoutineCost);
  const resolvedDynamic = dynamicSlots.map((s) => {
    const cost = TIER_MIDPOINT[s.tier] || 0;
    if (socialBudget >= cost) {
      socialBudget -= cost;
      return s;
    }
    return { ...s, tier: 'low-key' };
  });

  const allSlots = [...fixedSlots, ...resolvedDynamic].sort((a, b) => a.date.localeCompare(b.date));
  return {
    slots: allSlots,
    impliedRestaurantRoom: Math.round(impliedRestaurantRoom),
    fixedRoutineCost: Math.round(fixedRoutineCost),
    socialBudgetRemaining: Math.round(socialBudget),
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node Longterm/data/test-plan-remaining-month.mjs`
Expected: `All planRemainingMonth tests passed.`

- [ ] **Step 6: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-plan-remaining-month.mjs
git add Longterm/dashboard_v5.html
git commit -m "Add planRemainingMonth() to dashboard_v5.html"
```

---

### Task 7: `recommendForSlot()` in `dashboard_v5.html`

**Files:**
- Modify: `Longterm/dashboard_v5.html`
- Test: `Longterm/data/test-recommend-for-slot.mjs` (new, temporary — deleted after passing, same as Task 6)

**Interfaces:**
- Consumes: `slot` (one element of `planRemainingMonth()`'s `.slots` array), `favorites` (`D.favoritePlaces.places`), `recentDiningActivity` (`D.favoritePlaces.recentDiningActivity`), `lowKeyHangIdeas` (`D.lowKeyHangIdeas`).
- Produces: `recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas) -> { picks: string[], reasoning: string }` — a new global function, consumed by Task 8's `renderMonthPlan()`. When `slot.requiresTag` is set (e.g. `"familyFriendly"`), candidates are additionally restricted to favorites where `favorite[slot.requiresTag]` is truthy.

- [ ] **Step 1: Write the failing test**

Create `Longterm/data/test-recommend-for-slot.mjs`:
```js
import { loadDashboard } from './dashboard-test-harness.mjs';
import assert from 'node:assert/strict';

const { recommendForSlot } = loadDashboard();
assert.ok(recommendForSlot, 'recommendForSlot should be defined');

const favorites = [
  { name: 'Cheap Eats', cuisine: 'Mexican', list: 'go-to', observed: { tier: 'cheap', avgSpend: 20, visitCount: 5, lastVisited: '2026-06-01' } },
  { name: 'Mid Place', cuisine: 'Italian', list: 'go-to', observed: { tier: 'mid', avgSpend: 70, visitCount: 3, lastVisited: '2026-06-15' } },
  { name: 'Fancy Spot', cuisine: 'Steak', list: 'want-to-go', observed: { tier: 'high', avgSpend: 150, visitCount: 1, lastVisited: '2026-05-01' } },
  { name: 'Unproven Wishlist', cuisine: 'Thai', list: 'want-to-go', observed: null },
  { name: 'Family Spot', cuisine: 'American', list: 'go-to', observed: { tier: 'mid', avgSpend: 65, visitCount: 4, lastVisited: '2026-06-20' }, familyFriendly: true },
];

// Low-key slot: should return one of lowKeyHangIdeas, not a restaurant.
const lowKeyIdeas = ['Host game night', 'Walk + coffee at home'];
const lowKeyResult = recommendForSlot({ occasion: 'Weekend social', tier: 'low-key' }, favorites, [], lowKeyIdeas);
assert.equal(lowKeyResult.picks.length, 1, 'low-key slot should return exactly one idea');
assert.ok(lowKeyIdeas.includes(lowKeyResult.picks[0]), 'low-key pick should come from lowKeyHangIdeas, not favorites');

// Cheap-tier slot: includes the cheap place AND the unproven-cost wishlist
// place (unproven places are eligible at cheap/mid, excluded only at high —
// see the high-tier case below), but never mid/high-observed places.
const cheapResult = recommendForSlot({ occasion: 'Casual dinner', tier: 'cheap' }, favorites, [], lowKeyIdeas);
assert.deepEqual(cheapResult.picks, ['Cheap Eats', 'Unproven Wishlist'], 'cheap tier should surface the cheap-tier place plus the unproven-cost place, not mid/high');

// High-tier slot with no recent activity: cheap+mid+high all eligible, but
// the unproven wishlist place (observed: null) should NOT appear at high tier.
const highResult = recommendForSlot({ occasion: 'Date night', tier: 'high' }, favorites, [], lowKeyIdeas);
assert.ok(!highResult.picks.includes('Unproven Wishlist'), 'unproven (observed: null) places should not surface at high tier');
assert.ok(highResult.picks.includes('Fancy Spot'), 'the actual high-tier place should surface at high tier');

// Recent-visit exclusion: a place visited yesterday should not be suggested today.
const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
const recentActivity = [{ date: yesterday.toISOString().slice(0, 10), merchant: 'Cheap Eats', amount: 20, matchedPlace: 'Cheap Eats', account: 'x' }];
const excludedResult = recommendForSlot({ occasion: 'Casual dinner', tier: 'cheap' }, favorites, recentActivity, lowKeyIdeas);
assert.ok(!excludedResult.picks.includes('Cheap Eats'), 'a place visited yesterday should be excluded from today\'s suggestion');

// requiresTag: a slot tagged 'familyFriendly' should only surface places with
// that flag set true, even though other mid-tier places would otherwise be eligible.
const familySlotResult = recommendForSlot({ occasion: 'Family dinner (stroller-friendly)', tier: 'mid', requiresTag: 'familyFriendly' }, favorites, [], lowKeyIdeas);
assert.deepEqual(familySlotResult.picks, ['Family Spot'], 'requiresTag should restrict candidates to only tagged places, excluding untagged Mid Place');

console.log('All recommendForSlot tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node Longterm/data/test-recommend-for-slot.mjs`
Expected: throws `recommendForSlot should be defined`.

- [ ] **Step 3: Implement `recommendForSlot`**

In `Longterm/dashboard_v5.html`, directly below the `planRemainingMonth` function added in Task 6 (still above `function renderBudgetTracking() {`), add:

```js
// Picks a place (or a low-key idea) for one slot. Deliberately a plain
// heuristic — this function's input/output shape is the swap point for a
// smarter algorithm or an LLM/ML call later, without touching callers.
function recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas) {
  if (slot.tier === 'low-key') {
    const idea = lowKeyHangIdeas[Math.floor(Math.random() * lowKeyHangIdeas.length)];
    return { picks: [idea], reasoning: 'Budget is tight for this occurrence — a free/low-key hang instead of a paid outing.' };
  }

  const ceilingRank = TIER_RANK[slot.tier];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECENT_VISIT_EXCLUSION_DAYS);
  const recentNames = new Set(
    recentDiningActivity
      .filter((a) => new Date(a.date) >= cutoff && a.matchedPlace)
      .map((a) => a.matchedPlace)
  );

  let candidates = favorites.filter((f) => {
    if (f.list !== 'go-to' && f.list !== 'want-to-go') return false;
    if (recentNames.has(f.name)) return false;
    if (slot.requiresTag && !f[slot.requiresTag]) return false;
    if (!f.observed) return ceilingRank <= TIER_RANK.mid; // unproven cost: eligible at cheap/mid only
    return TIER_RANK[f.observed.tier] <= ceilingRank;
  });

  const mostRecent = recentDiningActivity.length
    ? [...recentDiningActivity].sort((a, b) => b.date.localeCompare(a.date))[0]
    : null;
  if (mostRecent && mostRecent.matchedPlace) {
    const recentPlace = favorites.find((f) => f.name === mostRecent.matchedPlace);
    const recentCuisine = recentPlace ? recentPlace.cuisine : null;
    if (recentCuisine) {
      candidates = [
        ...candidates.filter((f) => f.cuisine !== recentCuisine),
        ...candidates.filter((f) => f.cuisine === recentCuisine),
      ];
    }
  }

  const picks = candidates.slice(0, 3).map((f) => f.name);
  const reasoning = picks.length
    ? `${slot.occasion}: ${slot.tier} tier, excluding anything visited in the last ${RECENT_VISIT_EXCLUSION_DAYS} days.`
    : `No fresh picks — everything eligible was visited in the last ${RECENT_VISIT_EXCLUSION_DAYS} days.`;

  return { picks, reasoning };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node Longterm/data/test-recommend-for-slot.mjs`
Expected: `All recommendForSlot tests passed.`

- [ ] **Step 5: Delete the temporary test file and commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
rm Longterm/data/test-recommend-for-slot.mjs
git add Longterm/dashboard_v5.html
git commit -m "Add recommendForSlot() to dashboard_v5.html"
```

---

### Task 8: "Month Plan" tab — CSS, HTML, `renderMonthPlan()`, navigation wiring

**Files:**
- Modify: `Longterm/dashboard_v5.html`

**Interfaces:**
- Consumes: `planRemainingMonth` and `recommendForSlot` (Tasks 6–7), `D.favoritePlaces`, `D.diningRoutine`, `D.lowKeyHangIdeas`, `D.budgetTracking.joint`, existing helpers `$`, `fmt`, `isoDate`, existing `rendered` Set and `show()` function.
- Produces: `renderMonthPlan()` — a new global function; a new nav tab and page div (`pg-monthplan`); `show()` is modified to lazily call `renderMonthPlan()` on first visit, matching the existing Trajectory-tab pattern.

- [ ] **Step 1: Add calendar CSS**

In `Longterm/dashboard_v5.html`, directly above the closing `</style>` tag's preceding media-query block:
```css
@media(max-width:900px){
  .content{padding:20px}
  .g2,.g3{grid-template-columns:1fr}
  .m4,.m3{grid-template-columns:1fr 1fr}
  .chart-controls{grid-template-columns:1fr 1fr}
  .stat-strip{grid-template-columns:1fr 1fr}
}
```
add the new calendar rules directly before it:
```css
.cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-bottom:20px}
.cal-cell{background:#fff;border:1px solid var(--rule);border-radius:3px;padding:8px;min-height:88px;font-size:12px}
.cal-cell.cal-empty{background:transparent;border:none}
.cal-cell.cal-head{background:transparent;border:none;min-height:auto;padding:0 8px 6px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--sub)}
.cal-cell.cal-past{opacity:.55}
.cal-daynum{font-weight:700;color:var(--navy);margin-bottom:4px}
.cal-occasion{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.03em;color:var(--sub);margin-top:6px}
.cal-occasion:first-of-type{margin-top:0}
.cal-pick{font-size:12px;color:var(--mid);line-height:1.4}
.cal-lowkey{color:var(--green)}

@media(max-width:900px){
  .content{padding:20px}
  .g2,.g3{grid-template-columns:1fr}
  .m4,.m3{grid-template-columns:1fr 1fr}
  .chart-controls{grid-template-columns:1fr 1fr}
  .stat-strip{grid-template-columns:1fr 1fr}
  .cal-grid{grid-template-columns:repeat(7,minmax(36px,1fr));font-size:10px}
}
```

- [ ] **Step 2: Add the nav tab and page div**

Find:
```html
<div class="nav">
  <div class="ntab active"  onclick="show('goals',this)">Goals &amp; Milestones</div>
  <div class="ntab"         onclick="show('position',this)">Current Position</div>
  <div class="ntab"         onclick="show('phases',this)">Phases</div>
  <div class="ntab"         onclick="show('trajectory',this)">Trajectory</div>
  <div class="ntab"         onclick="show('decisions',this)">Decisions</div>
</div>

<!-- pages filled by JS -->
<div class="page active" id="pg-goals"></div>
<div class="page"        id="pg-position"></div>
<div class="page"        id="pg-phases"></div>
<div class="page"        id="pg-trajectory"></div>
<div class="page"        id="pg-decisions"></div>
```
Replace with:
```html
<div class="nav">
  <div class="ntab active"  onclick="show('goals',this)">Goals &amp; Milestones</div>
  <div class="ntab"         onclick="show('position',this)">Current Position</div>
  <div class="ntab"         onclick="show('phases',this)">Phases</div>
  <div class="ntab"         onclick="show('trajectory',this)">Trajectory</div>
  <div class="ntab"         onclick="show('decisions',this)">Decisions</div>
  <div class="ntab"         onclick="show('monthplan',this)">Month Plan</div>
</div>

<!-- pages filled by JS -->
<div class="page active" id="pg-goals"></div>
<div class="page"        id="pg-position"></div>
<div class="page"        id="pg-phases"></div>
<div class="page"        id="pg-trajectory"></div>
<div class="page"        id="pg-decisions"></div>
<div class="page"        id="pg-monthplan"></div>
```

- [ ] **Step 3: Implement `renderMonthPlan()`**

Directly below the `recommendForSlot` function added in Task 7 (still above `function renderBudgetTracking() {`), add:

```js
function renderMonthPlan() {
  const joint = D.budgetTracking.joint;
  const fp = D.favoritePlaces;

  if (!fp) {
    $('pg-monthplan').innerHTML = `
      <div class="content">
        <div class="slabel">Month Plan</div>
        <div class="callout">No favorites synced yet — ask Claude to sync your dining list from the Google Sheet.</div>
      </div>`;
    return;
  }

  const favorites = fp.places;
  const recentDiningActivity = fp.recentDiningActivity;
  const diningRoutine = D.diningRoutine;
  const lowKeyHangIdeas = D.lowKeyHangIdeas;

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const plan = planRemainingMonth(diningRoutine, joint, today);
  const slotByDate = {};
  plan.slots.forEach((s) => { (slotByDate[s.date] = slotByDate[s.date] || []).push(s); });

  const cycleStart = new Date(joint.cycleStart);
  const cycleEnd = cycleEndDate(joint.cycleStart, joint.cycleDays);
  const leadingBlanks = cycleStart.getDay();
  const totalDays = Math.floor((cycleEnd - cycleStart) / 86400000) + 1;

  const cells = [];
  for (let i = 0; i < leadingBlanks; i += 1) cells.push('<div class="cal-cell cal-empty"></div>');
  for (let i = 0; i < totalDays; i += 1) {
    const day = new Date(cycleStart); day.setDate(day.getDate() + i);
    const dISO = isoDate(day);
    const isPast = day < today;
    let body = '';
    if (isPast) {
      const matched = recentDiningActivity.filter((a) => a.date === dISO);
      body = matched.map((a) =>
        `<div class="cal-occasion">${a.matchedPlace || a.merchant}</div><div class="cal-pick">${fmt(a.amount)}</div>`
      ).join('');
    } else {
      body = (slotByDate[dISO] || []).map((s) => {
        const rec = recommendForSlot(s, favorites, recentDiningActivity, lowKeyHangIdeas);
        const cls = s.tier === 'low-key' ? 'cal-lowkey' : '';
        return `<div class="cal-occasion ${cls}">${s.occasion}</div><div class="cal-pick ${cls}">${rec.picks.join(', ') || '—'}</div>`;
      }).join('');
    }
    cells.push(`<div class="cal-cell${isPast ? ' cal-past' : ''}"><div class="cal-daynum">${day.getDate()}</div>${body}</div>`);
  }

  const nextDynamic = plan.slots.find((s) => diningRoutine.some((r) => r.occasion === s.occasion && r.dynamic));
  const nextReasoning = nextDynamic
    ? (nextDynamic.tier === 'low-key'
      ? 'Next weekend social: budget\'s tight — suggesting a low-key hang.'
      : `Next weekend social: $${plan.socialBudgetRemaining} left in the implied restaurant budget — a paid outing fits.`)
    : 'No upcoming weekend social occasions this cycle.';

  $('pg-monthplan').innerHTML = `
    <div class="content">
      <div class="slabel">Month Plan</div>
      <div class="stat-strip">
        <div class="stat-box"><div class="sb-label">Restaurants room left</div><div class="sb-val">${fmt(plan.impliedRestaurantRoom)}</div><div class="sb-note">Of joint budget, ~24% historical share</div></div>
        <div class="stat-box"><div class="sb-label">Fixed routine cost</div><div class="sb-val">${fmt(plan.fixedRoutineCost)}</div><div class="sb-note">Family dinner + date night, rest of cycle</div></div>
        <div class="stat-box"><div class="sb-label">Social budget remaining</div><div class="sb-val">${fmt(plan.socialBudgetRemaining)}</div><div class="sb-note">After fixed routine</div></div>
        <div class="stat-box"><div class="sb-label">Next weekend social</div><div class="sb-val" style="font-size:13px;line-height:1.4">${nextReasoning}</div></div>
      </div>
      <div class="cal-grid">
        <div class="cal-cell cal-head">Sun</div><div class="cal-cell cal-head">Mon</div><div class="cal-cell cal-head">Tue</div><div class="cal-cell cal-head">Wed</div><div class="cal-cell cal-head">Thu</div><div class="cal-cell cal-head">Fri</div><div class="cal-cell cal-head">Sat</div>
        ${cells.join('')}
      </div>
    </div>`;
}
```

- [ ] **Step 4: Wire into `show()`**

Find:
```js
function show(id, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('active'));
  $('pg-'+id).classList.add('active');
  el.classList.add('active');
  if (!rendered.has(id)) {
    if (id==='trajectory') renderTrajectory();
    rendered.add(id);
  }
}
```
Replace the `if` block with:
```js
  if (!rendered.has(id)) {
    if (id==='trajectory') renderTrajectory();
    if (id==='monthplan') renderMonthPlan();
    rendered.add(id);
  }
```

- [ ] **Step 5: Headless render test**

Run:
```bash
node -e "
import('./Longterm/data/dashboard-test-harness.mjs').then(({ loadDashboard }) => {
  const { renderMonthPlan, elements } = loadDashboard();
  renderMonthPlan();
  const html = elements['pg-monthplan'].innerHTML;
  console.log('has cal-grid:', html.includes('cal-grid'));
  console.log('has Restaurants room left:', html.includes('Restaurants room left'));
  console.log('length:', html.length);
});
"
```
Expected: `has cal-grid: true`, `has Restaurants room left: true`, `length` greater than 500 (a real calendar rendered, not an empty callout — this requires Task 5 to have already produced a real `favorite_places.json`; if it prints the "No favorites synced yet" callout instead, re-run Task 5's Step 4 first).

- [ ] **Step 6: Visual check**

Open `Longterm/dashboard_v5.html` directly in a browser (double-click, or `start Longterm/dashboard_v5.html` from the Finances directory). Click the new "Month Plan" tab. Confirm: the calendar renders with the correct number of days for the current cycle, Wednesday cells show "Family dinner (stroller-friendly)" with 2-3 suggested places drawn only from the family-friendly-tagged favorites (Great White, Neighborly, Sugarfish, Terroni — not e.g. Baltaire, which is mid-tier but not tagged), Friday/Saturday cells show "Date night," Sunday cells show "Weekend social" (either a paid suggestion or a low-key idea, in green), and the summary strip's numbers are internally consistent (fixed routine cost + social budget remaining ≤ restaurants room left).

- [ ] **Step 7: Commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/dashboard_v5.html
git commit -m "Add Month Plan tab: calendar, dining suggestions, budget-aware pacing"
```

---

### Task 9: Document the new architecture in `claude.md`

**Files:**
- Modify: `Longterm/claude.md`

**Interfaces:** None (documentation only).

- [ ] **Step 1: Note what wasn't ported from Scrooge**

In `Longterm/claude.md`, find this existing sentence (part of the automation paragraph added during the 2026-07-27 Scrooge migration):
```
Monarch credentials are shared with Scrooge's existing setup (`C:\Users\Family\.scrooge\monarch.env`) — same account, no reason to duplicate secrets.
```
Add directly after it, in the same paragraph:
```
 Only the Monarch pull was moved — Scrooge's Telegram integration (daily detail prompts, weekly planning/closeout messages, policy proposals, reply-reading) is untouched and still lives there. Kevin explicitly scoped bringing Telegram/notifications into Longterm as possible future work, not built yet — if picked up later, it's a new plan, not an extension of this one.
```

- [ ] **Step 2: Add a new section**

In `Longterm/claude.md`, directly after the existing `## Project files` section's bullet list (before the next `---`), add:

```markdown
## Dining recommendations (Month Plan tab)

- `data/favorite_places_raw.json` — snapshot of the dining Google Sheet (`https://docs.google.com/spreadsheets/d/1-5KiintV2071nkjkF5zb_P-erWYOknn8hWtMLBBlyDM`). On-demand only — ask Claude to resync when the sheet changes; this needs live Drive access that only a live Claude Code session has, not the unattended scheduled pull.
- `data/favorite_places.json` — auto-refreshed daily by `Longterm/scripts/budget-tracking-pull.mjs` (same run that updates the joint/Kevin-personal trackers, zero extra Monarch calls). Holds each favorite's observed spend tier plus a 90-day rolling `recentDiningActivity` log. Never hand-edit.
- `goals.json`'s `diningRoutine` (weekly family-dinner/date-night/weekend-social slots) and `lowKeyHangIdeas` (free-hang fallbacks) — hand-maintained, same as everything else in `goals.json`.
- `dashboard_v5.html`'s Month Plan tab computes suggestions live via two isolated functions, `planRemainingMonth()` (decides paid-vs-low-key for the rest of the cycle's dynamic slots, based on budget pacing) and `recommendForSlot()` (picks specific places). Both are deliberately simple v1 heuristics — see `docs/superpowers/specs/2026-07-26-dining-recommendations-design.md` for the full design and the intended upgrade path (a v2 could swap either function's body for a smarter model without touching the calendar UI).
```

- [ ] **Step 3: Commit**

```bash
cd "C:\Users\Family\Documents\Family\Finances"
git add Longterm/claude.md
git commit -m "Document the dining recommendations architecture and Scrooge-migration scope in claude.md"
```
