# Smarter Show List Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Widen show discovery, score candidates with existing likeness, show top 15 by max(K,H) with Kevin/Hanna owner colors only (no Us column).

**Architecture:** Keep `spotify-likeness.mjs` scoring as-is. Tighten venue-pull prompts + write structured `shows[]`. Dashboard ranks/slices to 15, drops Us UI, uses stable owner colors shared with Planner todo chips.

**Tech Stack:** Node ESM scripts, Anthropic web_search, `dashboard_v5.html` + `dashboard-server.mjs`, existing likeness cache.

**Spec:** `docs/superpowers/specs/2026-08-06-smarter-show-list-design.md`

## Global Constraints

- Top **15** shows on the tab after ranking by `max(linked K/H scores)`.
- UI columns: **K and H only** — do not render Us.
- Owner colors by id: Kevin `--blue` `#1e4d8c`, Hanna `--p5` `#4a3070` (not list index).
- No score-magnitude green/blue on show % numbers.
- Do not commit unless the user explicitly asks (repo convention).
- Never hand-edit generated `data/data.js` / goal-plan md for this work.

## File map

| File | Responsibility |
|------|----------------|
| `scripts/show-parse.mjs` | Shared line → `{act,venue,date,sourceUrl}` parser (extract from dashboard logic) |
| `scripts/upcoming-shows-pull.mjs` | Wider, diversity-aware venue research; write structured `shows[]` |
| `scripts/dashboard-server.mjs` | Optional `limit` on taste-matches; ensure showsFromCache uses structured + parsed findings |
| `dashboard_v5.html` | Owner color helper, todo chips by id, K/H-only scores, single ranked top-15 list |
| `scripts/telegram-bot-poll.mjs` | Align `UPCOMING_SHOWS_SYSTEM_PROMPT` with venue diversity wording (same product rule) |

---

### Task 1: Shared show line parser

**Files:**
- Create: `scripts/show-parse.mjs`
- Modify: `dashboard_v5.html` (later task imports via duplication avoidance — dashboard stays browser-side copy OR keep parse in HTML and Node imports a Node module only; prefer **Node module + keep HTML parser in sync by moving server-side parse to module**; dashboard already has `parseShowsFromText` — extract Node copy for pulls; do not break browser)

**Interfaces:**
- Produces: `export function parseShowsFromText(text, fallbackUrls = []): Array<{act, venue, date, sourceUrl}>`
- Produces: `export function dedupeShows(shows): same shape` keyed by `normalize(act)|normalize(venue)|date`
- Produces: `export function rankKey(show): number` → `Math.max(...linked numeric scores)` or `-1` if none (used by dashboard/server)

- [ ] **Step 1: Create `scripts/show-parse.mjs`**

Port the date/act/venue/URL extraction logic from `dashboard_v5.html`'s `parseShowsFromText` (around lines 1319–1390) into:

```js
export function parseShowsFromText(text, fallbackUrls = []) { /* same rules as dashboard */ }
export function showDedupeKey(s) {
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${norm(s.act)}|${norm(s.venue)}|${s.date || ''}`;
}
export function dedupeShows(shows) {
  const map = new Map();
  for (const s of shows || []) {
    const k = showDedupeKey(s);
    if (!map.has(k)) map.set(k, s);
  }
  return [...map.values()];
}
export function maxOwnerScore(show, ownerIds = ['kevin', 'hanna']) {
  const nums = ownerIds
    .map((id) => show.scores?.[id])
    .filter((s) => s?.linked && typeof s.score === 'number')
    .map((s) => s.score);
  return nums.length ? Math.max(...nums) : null;
}
export function takeTopShows(shows, limit = 15, ownerIds) {
  return [...(shows || [])]
    .sort((a, b) => {
      const ma = maxOwnerScore(a, ownerIds);
      const mb = maxOwnerScore(b, ownerIds);
      if (ma == null && mb == null) return (a.date || '').localeCompare(b.date || '');
      if (ma == null) return 1;
      if (mb == null) return -1;
      return mb - ma || (a.date || '').localeCompare(b.date || '') || (a.act || '').localeCompare(b.act || '');
    })
    .slice(0, limit);
}
```

- [ ] **Step 2: Smoke-test parser**

Run:

```bash
node -e "import { parseShowsFromText, dedupeShows } from './scripts/show-parse.mjs'; const s=parseShowsFromText('Mumford & Sons — Kia Forum — 2026-10-06 — https://x.test'); console.log(s); console.log(dedupeShows([...s,...s]).length);"
```

Expected: one show object with act/venue/date/url; dedupe length 1.

---

### Task 2: Venue pull — diversity + structured `shows[]`

**Files:**
- Modify: `scripts/upcoming-shows-pull.mjs`
- Modify: `scripts/telegram-bot-poll.mjs` (`UPCOMING_SHOWS_SYSTEM_PROMPT` only)

**Interfaces:**
- Consumes: `parseShowsFromText`, `dedupeShows` from `show-parse.mjs`
- Produces: cache with `shows: [...]` merged (spotify + venues labels), not text-only

- [ ] **Step 1: Update system prompt**

Replace venue research system string with rules that include:

- Search the **full** venue follow list (westside first, then others).
- **At most 2–3 notable upcoming acts per venue** in the window — do not paste one venue’s entire calendar.
- Prefer coverage across venues over depth at one.
- One line per show: `act — venue — YYYY-MM-DD — source URL`.

Apply the same wording to `UPCOMING_SHOWS_SYSTEM_PROMPT` in `telegram-bot-poll.mjs`.

- [ ] **Step 2: Write structured shows into cache**

After Anthropic returns text:

```js
import { parseShowsFromText, dedupeShows } from './show-parse.mjs';

const venueShows = parseShowsFromText(text, urls).map((s) => ({ ...s, label: 'venues' }));
// Keep prior spotify findings + parse their text into shows with label 'spotify'
const spotifyShows = /* from prior findings text or existing.shows filter label===spotify */;
const shows = dedupeShows([...spotifyShows, ...venueShows]);
// write cache: { fetchedAt, days, source: 'venues-and-spotify', findings, shows }
```

- [ ] **Step 3: Dry-run pull (optional if network OK)**

```bash
node scripts/upcoming-shows-pull.mjs --days 21
```

Expected: `data/upcoming_shows_cache.json` has `shows` array; Troubadour count ≤ ~3 unless few other venues returned anything.

---

### Task 3: API — top-N helpers on taste matches

**Files:**
- Modify: `scripts/dashboard-server.mjs`
- Modify: `scripts/spotify-likeness.mjs` only if sort already duplicates — prefer calling `takeTopShows` at API edge

**Interfaces:**
- Consumes: `scoreShowsLikeness`, `takeTopShows`
- Produces: `GET /api/show-taste-matches?limit=15` (default 15; `limit=0` or `all` = full list for CLI)

- [ ] **Step 1: Wire limit**

In `readShowTasteMatches`:

```js
import { takeTopShows } from './show-parse.mjs';

export async function readShowTasteMatches({ ..., limit = 15, skipClaude = false } = {}) {
  const result = await scoreShowsLikeness({ shows, ownerIds, tasteDir, skipClaude });
  const showsOut = limit === 0 || limit === 'all'
    ? result.shows
    : takeTopShows(result.shows, Number(limit) || 15, ownerIds);
  return { ...result, limit: showsOut === result.shows ? null : (Number(limit) || 15), shows: showsOut };
}
```

Parse `limit` query param in the GET handler (`all` → 0).

- [ ] **Step 2: Verify**

```bash
# with server running
# PowerShell:
(Invoke-WebRequest http://localhost:4200/api/show-taste-matches?skipClaude=1 -UseBasicParsing).Content.Substring(0,200)
```

Expected: JSON `mode=likeness-hybrid-c`, `shows.length ≤ 15`.

---

### Task 4: Dashboard — owner colors, K/H only, one ranked list

**Files:**
- Modify: `dashboard_v5.html` (CSS + JS for shows + todo owner chips)

**Interfaces:**
- Consumes: `/api/show-taste-matches` (already limited)
- Produces: UI matching spec layout

- [ ] **Step 1: Owner color CSS + helper**

```css
:root {
  /* existing --blue / --p5 stay */
  --owner-kevin: var(--blue);
  --owner-hanna: var(--p5);
}
.show-score-num.owner-kevin, .show-score-who.owner-kevin { color: var(--owner-kevin); }
.show-score-num.owner-hanna, .show-score-who.owner-hanna { color: var(--owner-hanna); }
.show-score-num.muted { color: var(--sub); }
.todo-owner.owner-kevin { background: var(--owner-kevin); }
.todo-owner.owner-hanna { background: var(--owner-hanna); }
/* remove .show-score-num.hi / .mid usage for show scores */
.show-scores { grid-template-columns: repeat(2, 1fr); }
.show-row { grid-template-columns: 56px minmax(0,1fr) 112px 64px; /* was 168px for 3 cols */ }
```

```js
function ownerColorClass(ownerId) {
  if (ownerId === 'kevin') return 'owner-kevin';
  if (ownerId === 'hanna') return 'owner-hanna';
  return '';
}
```

- [ ] **Step 2: Todo chips by id**

Replace index-based `todo-owner-alt` with:

```js
return `<span class="todo-owner ${ownerColorClass(owner)}">${ownerDisplayName(owner)}</span>`;
```

- [ ] **Step 3: Drop Us cell; color K/H scores**

- Remove `usScoreCellHTML` and its call from `showScoresHTML`.
- In `ownerScoreCellHTML`, apply `ownerColorClass(owner.id)` to who + num when score is numeric; muted when `—`/`?`.
- Remove `scoreNumClass` hi/mid for shows.

- [ ] **Step 4: Single “Best matches” list**

Rewrite `showsFindingsHTML` to:
- Use `tasteMatches.shows` (already top 15 from API).
- Render **one** block: `Best matches · N` (no Spotify/venues section split).
- Update callout: no Us language; mention Kevin blue / Hanna purple briefly or omit (colors speak).

- [ ] **Step 5: Syntax-check dashboard script**

```bash
node -e "const fs=require('fs'); const html=fs.readFileSync('dashboard_v5.html','utf8'); const blocks=[...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)]; for (const b of blocks) new Function(b[1]); console.log('ok');"
```

Expected: `ok`.

---

### Task 5: Re-pull / re-score / verify live UI

**Files:** none new — ops

- [ ] **Step 1: Restart dashboard server** (kill port 4200 if stale, `npm run dev`)

- [ ] **Step 2: Refresh cache + scores**

```bash
node scripts/upcoming-shows-pull.mjs --days 21
npm run spotify:match
```

(If Spotify artist block was wiped by venue pull, also run `npm run spotify:find-shows` then venue pull again, or merge carefully per Task 2.)

- [ ] **Step 3: Hard-refresh** `http://localhost:4200/dashboard_v5.html` → Dining + Shows → Shows

Expected:
- ≤15 rows
- Sorted by fit (Mumford/floors near top)
- Only K and H columns; Hanna `—` in purple chrome when linked later
- Troubadour not ~half the list unless those acts actually score high
- Planner todo Kevin/Hanna chips match show column colors

---

## Spec coverage check

| Spec requirement | Task |
|------------------|------|
| Wide net / diversity in venue research | 2 |
| Score with existing likeness | 3 (uses existing) |
| Top 15 by max(K,H) | 1 + 3 + 4 |
| K/H only, no Us | 4 |
| Owner colors Kevin blue / Hanna purple | 4 |
| One ranked list | 4 |
| Structured shows in cache | 2 |
| Telegram prompt aligned | 2 |

## Placeholder scan

None intentional — prompts and helpers specified above.
