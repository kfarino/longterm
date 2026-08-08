# Live Nation Events Pull + Ticket-Connection Boost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull comprehensive Live Nation/Ticketmaster LA-area event data, factor a "free/discounted ticket via a personal connection" boost into the existing match-percentage scoring, and make Live Nation shows visibly tagged "LN" in both the weekly Telegram message and the dashboard.

**Architecture:** A new script (`scripts/live-nation-pull.mjs`) queries the Ticketmaster Discovery API (structured, comprehensive — no LLM/web-search involved) and merges results into the existing `data/upcoming_shows_cache.json` shape the rest of the pipeline already consumes. A `promoter: 'Live Nation'` field rides through the existing scoring pipeline (`spotify-likeness.mjs`) as a flat +15 score boost, then through to both display surfaces (`spotify-shows-telegram.mjs`'s Telegram message, `dashboard_v5.html`'s Dining + Shows tab).

**Tech Stack:** Node.js ESM (`.mjs`), hand-rolled `assert/strict` tests (`node data/test-*.mjs`, no framework — this codebase's established convention), Ticketmaster Discovery API (REST, JSON).

## Global Constraints

- Real household data, API keys, and test fixtures must never contain real secrets in commits (`npm run check:secrets` must pass before considering any task done) — per `AGENTS.md` §0.
- Every external API call goes through an injectable client/fetch parameter — no real network calls in the test suite, matching every existing script in this codebase (`spotifyGet`, `callTelegram`, etc.).
- New credential file: `~/.longterm/ticketmaster.env` (`TICKETMASTER_API_KEY`), read via a new `ticketmasterEnvPath()` in `scripts/longterm-paths.mjs` — same per-service env-file convention as `telegram.env`/`monarch.env`/`oura-app.env`/`spotify-app.env`.
- Kevin does not have the API key yet ("out now, build it, get key later") — every piece of code must be complete and tested with injected fixtures; only the final live-verification step is blocked pending the key, and that's expected, not a failure.
- Live Nation detection must never false-positive (claim a ticket connection that doesn't exist) — an event with no promoter signal and no venue-list match is **not** tagged, full stop.
- Score boost is a flat `+15`, clamped into the existing `[0, 100]` range, applied identically whether the show reached its score via the follow/like/playlist floor path, the Claude-estimate path, or the comedy path.

---

### Task 1: `ticketmasterEnvPath()` helper

**Files:**
- Modify: `scripts/longterm-paths.mjs`
- Test: `data/test-longterm-paths.mjs` (new)

**Interfaces:**
- Produces: `ticketmasterEnvPath(): string` — returns `path.join(longtermHome(), 'ticketmaster.env')`, exported from `scripts/longterm-paths.mjs`, importable as `import { ticketmasterEnvPath } from './longterm-paths.mjs'`.

- [ ] **Step 1: Write the failing test**

Create `data/test-longterm-paths.mjs`:

```js
// Longterm/data/test-longterm-paths.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Locks
// in the ~/.longterm/<service>.env naming convention every credential-
// reading script in this codebase relies on. Run with:
//   node Longterm/data/test-longterm-paths.mjs
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { longtermHome, ticketmasterEnvPath } from '../scripts/longterm-paths.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
console.log('test-longterm-paths.mjs');

test('ticketmasterEnvPath returns ~/.longterm/ticketmaster.env', () => {
  const expected = path.join(os.homedir(), '.longterm', 'ticketmaster.env');
  assert.equal(ticketmasterEnvPath(), expected);
  assert.equal(ticketmasterEnvPath(), path.join(longtermHome(), 'ticketmaster.env'));
});

console.log('All longterm-paths tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node data/test-longterm-paths.mjs`
Expected: FAIL — `ticketmasterEnvPath is not a function` (not exported yet).

- [ ] **Step 3: Add the helper**

In `scripts/longterm-paths.mjs`, after the existing `spotifyOwnerEnvPath` function (end of file), add:

```js
export function ticketmasterEnvPath() {
  return path.join(longtermHome(), 'ticketmaster.env');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node data/test-longterm-paths.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add scripts/longterm-paths.mjs data/test-longterm-paths.mjs
git commit -m "Add ticketmasterEnvPath() credential-path helper"
```

---

### Task 2: `dedupeShows` preserves a `promoter` tag across duplicate sources

**Files:**
- Modify: `scripts/show-parse.mjs`
- Test: `data/test-show-parse.mjs` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `dedupeShows(shows)` behavior change — when two entries share a dedupe key (`showDedupeKey`: normalized act+venue+date) and the first-seen entry lacks a truthy `.promoter` field but a later duplicate has one, the merged result keeps the first-seen entry's fields but fills in `.promoter` from the later duplicate. Every other field is unaffected (first-seen still wins). Existing callers that never set `.promoter` see no behavior change (both sides `undefined`, so the new branch is a no-op).

This is needed because Task 4's Live Nation pull will often find the *same* show (e.g. "Counting Crows @ Hollywood Bowl") that `spotify-find-shows.mjs`/`upcoming-shows-pull.mjs` already found via web search — without this change, `dedupeShows`'s current first-wins-only-and-discard-the-rest behavior would silently drop the Live Nation tag on exactly the highest-value, best-known shows.

- [ ] **Step 1: Write the failing test**

Create `data/test-show-parse.mjs`:

```js
// Longterm/data/test-show-parse.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// show-parse.mjs's dedupeShows, specifically the promoter-merge behavior
// added for the Live Nation pull (2026-08-08) — a later duplicate can fill
// in a missing .promoter field on the first-seen entry, but never overwrites
// any field the first-seen entry already has. Run with:
//   node Longterm/data/test-show-parse.mjs
import assert from 'node:assert/strict';
import { dedupeShows, showDedupeKey } from '../scripts/show-parse.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
console.log('test-show-parse.mjs');

test('first-seen entry wins when there is no promoter to merge', () => {
  const shows = [
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', sourceUrl: 'https://spotify-found.example' },
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', sourceUrl: 'https://venue-found.example' },
  ];
  const result = dedupeShows(shows);
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceUrl, 'https://spotify-found.example');
  assert.equal(result[0].promoter, undefined);
});

test('a later duplicate fills in a missing promoter field without touching other fields', () => {
  const shows = [
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', sourceUrl: 'https://spotify-found.example' },
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', sourceUrl: 'https://ticketmaster.example', promoter: 'Live Nation' },
  ];
  const result = dedupeShows(shows);
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceUrl, 'https://spotify-found.example', 'first-seen fields must survive unchanged');
  assert.equal(result[0].promoter, 'Live Nation', 'the promoter tag must be filled in from the later duplicate');
});

test('a first-seen entry that already has a promoter is never overwritten', () => {
  const shows = [
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' },
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Some Other Promoter' },
  ];
  const result = dedupeShows(shows);
  assert.equal(result.length, 1);
  assert.equal(result[0].promoter, 'Live Nation');
});

test('distinct shows (different dedupe keys) are both kept', () => {
  const shows = [
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10' },
    { act: 'John Mellencamp', venue: 'Hollywood Bowl', date: '2026-08-10', promoter: 'Live Nation' },
  ];
  const result = dedupeShows(shows);
  assert.equal(result.length, 2);
  assert.equal(showDedupeKey(result[0]) === showDedupeKey(result[1]), false);
});

console.log('All show-parse tests passed.');
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node data/test-show-parse.mjs`
Expected: FAIL on the second test (`result[0].promoter` is `undefined`, expected `'Live Nation'`) — current `dedupeShows` discards every duplicate outright.

- [ ] **Step 3: Update `dedupeShows`**

In `scripts/show-parse.mjs`, replace:

```js
export function dedupeShows(shows) {
  const map = new Map();
  for (const s of shows || []) {
    const k = showDedupeKey(s);
    if (!map.has(k)) map.set(k, s);
  }
  return [...map.values()];
}
```

with:

```js
export function dedupeShows(shows) {
  const map = new Map();
  for (const s of shows || []) {
    const k = showDedupeKey(s);
    const existing = map.get(k);
    if (!existing) {
      map.set(k, s);
      continue;
    }
    // First-seen wins for every field it already has — this only fills a
    // gap (e.g. a Live Nation promoter tag a second source found) rather
    // than letting a later duplicate override anything.
    if (s.promoter && !existing.promoter) {
      map.set(k, { ...existing, promoter: s.promoter });
    }
  }
  return [...map.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node data/test-show-parse.mjs`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add scripts/show-parse.mjs data/test-show-parse.mjs
git commit -m "dedupeShows: let a later duplicate fill in a missing promoter tag"
```

---

### Task 3: Live Nation score boost in `spotify-likeness.mjs`

**Files:**
- Modify: `scripts/spotify-likeness.mjs`
- Test: `data/test-spotify-likeness.mjs` (new)

**Interfaces:**
- Consumes: nothing new from other tasks (this task's boost is pure — it only reads a `promoter` string, doesn't yet care where it comes from).
- Produces: `export const LIVE_NATION_BOOST = 15`, `export function liveNationBoost(promoter): number`, both importable from `./spotify-likeness.mjs`. Every score object `scoreShowsLikeness` returns now carries `liveNation: boolean` and `liveNationBoost: number` fields alongside the existing `venueRating`/`venueBoost`.

- [ ] **Step 1: Write the failing tests**

Create `data/test-spotify-likeness.mjs`:

```js
// Longterm/data/test-spotify-likeness.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// spotify-likeness.mjs's Live Nation ticket-connection boost (2026-08-08) —
// a flat +15 applied on top of the existing follow/like/playlist floors,
// the Claude ticket-estimate path, and the comedy path, whenever a show's
// `promoter` field is 'Live Nation'. Run with:
//   node Longterm/data/test-spotify-likeness.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  LIVE_NATION_BOOST,
  liveNationBoost,
  scoreShowsLikeness,
} from '../scripts/spotify-likeness.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-spotify-likeness.mjs');

test('liveNationBoost is LIVE_NATION_BOOST for a Live Nation promoter, 0 otherwise', () => {
  assert.equal(liveNationBoost('Live Nation'), LIVE_NATION_BOOST);
  assert.equal(LIVE_NATION_BOOST, 15);
  assert.equal(liveNationBoost('Some Other Promoter'), 0);
  assert.equal(liveNationBoost(null), 0);
  assert.equal(liveNationBoost(undefined), 0);
});

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTaste(tasteDir, ownerId, { followed = [], liked = [], playlist = [] } = {}) {
  const artists = [
    ...followed.map((name) => ({ id: name, name, sources: [{ type: 'followed' }] })),
    ...liked.map((name) => ({ id: name, name, sources: [{ type: 'liked', trackCount: 3 }] })),
    ...playlist.map((name) => ({ id: name, name, sources: [{ type: 'playlist', trackCount: 3 }] })),
  ];
  fs.writeFileSync(
    path.join(tasteDir, `${ownerId}-taste.json`),
    JSON.stringify({ ownerId, pulledAt: '2026-08-01T00:00:00Z', counts: { artists: artists.length }, artists }),
  );
}

await asyncTest('a playlist-floor show gets +15 added (not clamped) when Live Nation-promoted', async () => {
  // Playlist floor is 78 (SCORE_FLOORS.playlist) — 78 + 15 = 93, comfortably
  // under 100, so this proves the boost actually adds rather than just
  // happening to land on the clamp ceiling (the followed floor, 92, would
  // clamp at 107→100 and mask an off-by-N bug in the addition itself).
  const tasteDir = tmpDir('spotify-likeness-floor-');
  writeTaste(tasteDir, 'kevin', { playlist: ['Counting Crows'] });
  const shows = [
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' },
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-17' }, // no promoter — control
  ];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir, skipClaude: true });
  const [withLN, withoutLN] = payload.shows;
  assert.equal(withLN.scores.kevin.score, 78 + 15, 'playlist floor (78) + Live Nation boost (15)');
  assert.equal(withLN.scores.kevin.liveNation, true);
  assert.equal(withLN.scores.kevin.liveNationBoost, 15);
  assert.equal(withoutLN.scores.kevin.score, 78, 'no promoter tag means no boost');
  assert.equal(withoutLN.scores.kevin.liveNation, false);
  assert.equal(withoutLN.scores.kevin.liveNationBoost, 0);
});

await asyncTest('the boost clamps at 100 rather than overflowing', async () => {
  const tasteDir = tmpDir('spotify-likeness-clamp-');
  writeTaste(tasteDir, 'kevin', { followed: ['Counting Crows'] });
  const shows = [{ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' }];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir, skipClaude: true });
  assert.ok(payload.shows[0].scores.kevin.score <= 100);
  assert.equal(payload.shows[0].scores.kevin.score, 100, 'followed floor 92 + 15 = 107, clamps to 100');
});

await asyncTest('an unlinked owner is unaffected by the Live Nation boost (still not linked)', async () => {
  const shows = [{ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' }];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir: tmpDir('spotify-likeness-unlinked-'), skipClaude: true });
  assert.equal(payload.shows[0].scores.kevin.linked, false);
  assert.equal(payload.shows[0].scores.kevin.score, null);
});

await asyncTest('a comedy show gets the Live Nation boost added to its venue-base score, without double-applying a venue-rating boost', async () => {
  const shows = [{ act: 'Anthony Jeselnik', venue: 'Largo', date: '2026-09-10', promoter: 'Live Nation' }];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir: tmpDir('spotify-likeness-comedy-'), skipClaude: true });
  const score = payload.shows[0].scores.kevin;
  assert.equal(score.basis, 'comedy-venue');
  assert.equal(score.venueBoost, 0, 'comedy never gets the venue-rating boost (already baked into its base score)');
  assert.equal(score.liveNation, true);
  assert.equal(score.liveNationBoost, 15);
  assert.equal(score.score, 52 + 15, 'unrated-venue comedy base (52) + Live Nation boost (15)');
});

console.log('All spotify-likeness tests passed.');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-spotify-likeness.mjs`
Expected: FAIL — `liveNationBoost is not a function` (not exported yet), and every score assertion fails since no boost is applied.

- [ ] **Step 3: Add the boost constant/function and wire it into every scoring branch**

In `scripts/spotify-likeness.mjs`, after the existing `LIKED_TRACK_CAP` export (currently line 23), add:

```js
/** Flat score bump when a show is Live Nation-promoted — Kevin has a
 * personal connection who can often get free/discounted tickets to these.
 * A nudge on top of taste fit, not a floor: a show he'd genuinely dislike
 * doesn't jump to "must-go" just because the ticket is free. */
export const LIVE_NATION_BOOST = 15;

export function liveNationBoost(promoter) {
  return promoter === 'Live Nation' ? LIVE_NATION_BOOST : 0;
}
```

Replace the existing `applyVenueBoost` function:

```js
function applyVenueBoost(scoreObj, venueInfo) {
  if (!scoreObj || typeof scoreObj.score !== 'number') return scoreObj;
  const boost = venueRatingBoost(venueInfo?.rating);
  if (!boost) {
    return { ...scoreObj, venueRating: venueInfo?.rating ?? null, venueBoost: 0 };
  }
  const next = Math.max(0, Math.min(100, scoreObj.score + boost));
  return {
    ...scoreObj,
    score: next,
    venueRating: venueInfo.rating,
    venueBoost: boost,
  };
}
```

with a version that also folds in the Live Nation boost in the same clamp (clamping the two boosts separately would lose information when one alone would have pushed the score out of range — e.g. a 2-star venue penalty clamped to 0 first would let a *second* boost start from 0 instead of the true negative subtotal):

```js
function applyVenueBoost(scoreObj, venueInfo, promoter) {
  if (!scoreObj || typeof scoreObj.score !== 'number') return scoreObj;
  const boost = venueRatingBoost(venueInfo?.rating);
  const lnBoost = liveNationBoost(promoter);
  const total = boost + lnBoost;
  const next = total ? Math.max(0, Math.min(100, scoreObj.score + total)) : scoreObj.score;
  return {
    ...scoreObj,
    score: next,
    venueRating: venueInfo?.rating ?? null,
    venueBoost: boost,
    liveNation: lnBoost > 0,
    liveNationBoost: lnBoost,
  };
}
```

Add a second helper right after it, for the comedy paths — comedy intentionally never gets `venueRatingBoost` (it's already baked into `comedyVenueBaseScore`), but it still needs the Live Nation boost:

```js
function applyLiveNationOnlyBoost(scoreObj, promoter) {
  const lnBoost = liveNationBoost(promoter);
  if (!scoreObj) return scoreObj;
  if (!lnBoost || typeof scoreObj.score !== 'number') {
    return { ...scoreObj, liveNation: false, liveNationBoost: 0 };
  }
  return {
    ...scoreObj,
    score: Math.max(0, Math.min(100, scoreObj.score + lnBoost)),
    liveNation: true,
    liveNationBoost: lnBoost,
  };
}
```

Now update every call site inside `scoreShowsLikeness`. First, the floor path (currently):

```js
        const floored = floorFromExactHit(exact);
        if (floored) {
          scores[id] = applyVenueBoost({ ...floored, suggestionStars }, venueInfo);
          continue;
        }
```

becomes:

```js
        const floored = floorFromExactHit(exact);
        if (floored) {
          scores[id] = applyVenueBoost({ ...floored, suggestionStars }, venueInfo, show.promoter);
          continue;
        }
```

Second, the cached-Claude-result branch (currently):

```js
        scores[id] = kind === 'comedy'
          ? { ...base, venueRating: venueInfo?.rating ?? null, venueBoost: 0 }
          : applyVenueBoost(base, venueInfo);
        continue;
```

becomes:

```js
        scores[id] = kind === 'comedy'
          ? applyLiveNationOnlyBoost({ ...base, venueRating: venueInfo?.rating ?? null, venueBoost: 0 }, show.promoter)
          : applyVenueBoost(base, venueInfo, show.promoter);
        continue;
```

Third, the `skipClaude || !key` branch. Currently:

```js
      if (skipClaude || !key) {
        if (kind === 'comedy') {
          const base = comedyVenueBaseScore(venueInfo?.rating);
          scores[id] = {
            linked: true,
            score: base,
            basis: 'comedy-venue',
            label: 'Venue',
            pitch: venueInfo?.rating != null
              ? `${show.venue || 'This room'} is ${venueInfo.rating}★ for you — comedy night worth a look.`
              : 'Comedy at a followed room — score pending deeper act check.',
            suggestionStars,
            venueRating: venueInfo?.rating ?? null,
            venueBoost: 0,
          };
        } else {
          scores[id] = {
            linked: true,
            score: null,
            basis: 'pending',
            label: '?',
            suggestionStars,
            venueRating: venueInfo?.rating ?? null,
            venueBoost: 0,
          };
        }
        continue;
      }
```

becomes:

```js
      if (skipClaude || !key) {
        if (kind === 'comedy') {
          const base = comedyVenueBaseScore(venueInfo?.rating);
          scores[id] = applyLiveNationOnlyBoost({
            linked: true,
            score: base,
            basis: 'comedy-venue',
            label: 'Venue',
            pitch: venueInfo?.rating != null
              ? `${show.venue || 'This room'} is ${venueInfo.rating}★ for you — comedy night worth a look.`
              : 'Comedy at a followed room — score pending deeper act check.',
            suggestionStars,
            venueRating: venueInfo?.rating ?? null,
            venueBoost: 0,
          }, show.promoter);
        } else {
          scores[id] = {
            linked: true,
            score: null,
            basis: 'pending',
            label: '?',
            suggestionStars,
            venueRating: venueInfo?.rating ?? null,
            venueBoost: 0,
            liveNation: false,
            liveNationBoost: 0,
          };
        }
        continue;
      }
```

Fourth, the fresh-Claude-result branch inside `mapPool`. Currently:

```js
        const { score, reason, pitch } = result;
        for (const ref of jobKeyToIndices.get(job.jk) || []) {
          cache[ref.cacheKey] = {
            score,
            reason,
            pitch,
            digestVersion: DIGEST_VERSION,
            profileBuiltAt: job.profileBuiltAt || null,
            kind: job.kind,
            at: new Date().toISOString(),
          };
          cacheDirty = true;
          const base = {
            linked: true,
            score,
            basis: job.kind === 'comedy' ? 'comedy' : 'claude',
            label: job.kind === 'comedy' ? 'Comedy' : 'Estimated',
            reason,
            pitch,
            cached: false,
            suggestionStars: ref.suggestionStars,
          };
          scoredShows[ref.showIdx].scores[ref.ownerId] = job.kind === 'comedy'
            ? { ...base, venueRating: ref.venueInfo?.rating ?? null, venueBoost: 0 }
            : applyVenueBoost(base, ref.venueInfo);
        }
```

becomes (note `scoredShows[ref.showIdx]` is the show object itself, already carrying `.promoter` from the original input — no new plumbing needed to reach it here):

```js
        const { score, reason, pitch } = result;
        for (const ref of jobKeyToIndices.get(job.jk) || []) {
          cache[ref.cacheKey] = {
            score,
            reason,
            pitch,
            digestVersion: DIGEST_VERSION,
            profileBuiltAt: job.profileBuiltAt || null,
            kind: job.kind,
            at: new Date().toISOString(),
          };
          cacheDirty = true;
          const base = {
            linked: true,
            score,
            basis: job.kind === 'comedy' ? 'comedy' : 'claude',
            label: job.kind === 'comedy' ? 'Comedy' : 'Estimated',
            reason,
            pitch,
            cached: false,
            suggestionStars: ref.suggestionStars,
          };
          const promoter = scoredShows[ref.showIdx].promoter;
          scoredShows[ref.showIdx].scores[ref.ownerId] = job.kind === 'comedy'
            ? applyLiveNationOnlyBoost({ ...base, venueRating: ref.venueInfo?.rating ?? null, venueBoost: 0 }, promoter)
            : applyVenueBoost(base, ref.venueInfo, promoter);
        }
```

Fifth, the error-fallback branch. Currently:

```js
      } catch {
        for (const ref of jobKeyToIndices.get(job.jk) || []) {
          if (ref.kind === 'comedy') {
            const base = comedyVenueBaseScore(ref.venueInfo?.rating);
            scoredShows[ref.showIdx].scores[ref.ownerId] = {
              linked: true,
              score: base,
              basis: 'comedy-venue',
              label: 'Venue',
              pitch: 'Comedy night — scored from your venue stars (act check failed).',
              suggestionStars: ref.suggestionStars,
              venueRating: ref.venueInfo?.rating ?? null,
              venueBoost: 0,
            };
          } else {
            scoredShows[ref.showIdx].scores[ref.ownerId] = {
              linked: true,
              score: null,
              basis: 'error',
              label: '?',
              suggestionStars: ref.suggestionStars,
            };
          }
        }
      }
```

becomes:

```js
      } catch {
        for (const ref of jobKeyToIndices.get(job.jk) || []) {
          const promoter = scoredShows[ref.showIdx].promoter;
          if (ref.kind === 'comedy') {
            const base = comedyVenueBaseScore(ref.venueInfo?.rating);
            scoredShows[ref.showIdx].scores[ref.ownerId] = applyLiveNationOnlyBoost({
              linked: true,
              score: base,
              basis: 'comedy-venue',
              label: 'Venue',
              pitch: 'Comedy night — scored from your venue stars (act check failed).',
              suggestionStars: ref.suggestionStars,
              venueRating: ref.venueInfo?.rating ?? null,
              venueBoost: 0,
            }, promoter);
          } else {
            scoredShows[ref.showIdx].scores[ref.ownerId] = {
              linked: true,
              score: null,
              basis: 'error',
              label: '?',
              suggestionStars: ref.suggestionStars,
              liveNation: false,
              liveNationBoost: 0,
            };
          }
        }
      }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-spotify-likeness.mjs`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the full existing test suite to confirm nothing else broke**

Run each of: `node data/test-dashboard-contract.mjs`, `node data/test-spotify-shows-telegram.mjs` (no change expected — `spotify-likeness.mjs` isn't in that file's import graph, this is a sanity check only).
Expected: PASS, unchanged.

- [ ] **Step 6: Commit**

```bash
git add scripts/spotify-likeness.mjs data/test-spotify-likeness.mjs
git commit -m "Add flat +15 Live Nation ticket-connection score boost"
```

---

### Task 4: `scripts/live-nation-pull.mjs` — the Ticketmaster Discovery API pull

**Files:**
- Create: `scripts/live-nation-pull.mjs`
- Create: `data/live-nation-venues.json`
- Modify: `package.json`
- Test: `data/test-live-nation-pull.mjs` (new)

**Interfaces:**
- Consumes: `ticketmasterEnvPath()` from `./longterm-paths.mjs` (Task 1), `dedupeShows` from `./show-parse.mjs` (Task 2, for its promoter-merge behavior).
- Produces: `loadApiKey(envPath?)`, `loadLiveNationVenueNames(filePath?)`, `isLiveNationEvent(event, knownVenueNames)`, `mapEventToShow(event, knownVenueNames)`, `fetchClassificationEvents({ apiKey, classificationName, days, fetchImpl, maxPages })`, `fetchAllLiveNationEvents({ apiKey, days, fetchImpl, maxPages })`, `runOnce({ days, fetchImpl, apiKey, cachePathOverride, venuesOverridePathOverride, log })` — all exported from `scripts/live-nation-pull.mjs`. Writes `data/upcoming_shows_cache.json` with a `promoter: 'Live Nation'` field on qualifying shows — this is what Task 3's boost and Tasks 5/6's "LN" badges key off.

- [ ] **Step 1: Write the failing tests**

Create `data/live-nation-venues.json` first (empty starter list — the hand-maintained fallback for when Ticketmaster's promoter field is missing):

```json
{
  "venues": []
}
```

Create `data/test-live-nation-pull.mjs`:

```js
// Longterm/data/test-live-nation-pull.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// live-nation-pull.mjs's event parsing, Live Nation detection (promoter
// field + venue-list fallback), pagination, and cache-merge — all against an
// injected fetch client, never a real network call. Run with:
//   node Longterm/data/test-live-nation-pull.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isLiveNationEvent,
  mapEventToShow,
  fetchClassificationEvents,
  fetchAllLiveNationEvents,
  runOnce,
} from '../scripts/live-nation-pull.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-live-nation-pull.mjs');

function fakeEvent(overrides = {}) {
  return {
    id: 'evt-1',
    name: 'Counting Crows',
    url: 'https://www.ticketmaster.com/event/evt-1',
    dates: { start: { localDate: '2026-09-10' } },
    _embedded: {
      attractions: [{ name: 'Counting Crows' }],
      venues: [{ name: 'Hollywood Bowl' }],
    },
    ...overrides,
  };
}

test('isLiveNationEvent matches a promoter.name of "Live Nation"', () => {
  const event = fakeEvent({ promoter: { name: 'Live Nation' } });
  assert.equal(isLiveNationEvent(event, []), true);
});

test('isLiveNationEvent matches a promoters[] entry, case-insensitively', () => {
  const event = fakeEvent({ promoters: [{ name: 'LIVE NATION LOS ANGELES' }] });
  assert.equal(isLiveNationEvent(event, []), true);
});

test('isLiveNationEvent matches the House of Blues Concerts subsidiary name', () => {
  const event = fakeEvent({ promoter: { name: 'House of Blues Concerts' } });
  assert.equal(isLiveNationEvent(event, []), true);
});

test('isLiveNationEvent falls back to the hand-maintained venue list when promoter data is missing', () => {
  const event = fakeEvent({ promoter: undefined, promoters: undefined });
  assert.equal(isLiveNationEvent(event, ['hollywood bowl']), true);
  assert.equal(isLiveNationEvent(event, ['the wiltern']), false);
});

test('isLiveNationEvent returns false when neither signal matches — never a false positive', () => {
  const event = fakeEvent({ promoter: { name: 'AEG Presents' } });
  assert.equal(isLiveNationEvent(event, []), false);
});

test('mapEventToShow extracts act/venue/date/sourceUrl and tags promoter when detected', () => {
  const event = fakeEvent({ promoter: { name: 'Live Nation' } });
  assert.deepEqual(mapEventToShow(event, []), {
    act: 'Counting Crows',
    venue: 'Hollywood Bowl',
    date: '2026-09-10',
    sourceUrl: 'https://www.ticketmaster.com/event/evt-1',
    promoter: 'Live Nation',
  });
});

test('mapEventToShow omits the promoter field entirely when not a Live Nation event', () => {
  const event = fakeEvent({ promoter: { name: 'AEG Presents' } });
  const show = mapEventToShow(event, []);
  assert.equal('promoter' in show, false);
});

test('mapEventToShow falls back to event.name when there is no attraction, and to "" when there is no venue', () => {
  const event = fakeEvent({ _embedded: {} });
  const show = mapEventToShow(event, []);
  assert.equal(show.act, 'Counting Crows'); // event.name fallback
  assert.equal(show.venue, '');
});

test('mapEventToShow returns null when the event has no date (cannot build a usable show)', () => {
  const event = fakeEvent({ dates: {} });
  assert.equal(mapEventToShow(event, []), null);
});

await asyncTest('fetchClassificationEvents paginates until totalPages is exhausted', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const events = page < 2 ? [fakeEvent({ id: `evt-${page}` })] : [];
    return {
      ok: true,
      json: async () => ({ _embedded: { events }, page: { totalPages: 2, number: page } }),
    };
  };
  const events = await fetchClassificationEvents({ apiKey: 'k', classificationName: 'Music', days: 60, fetchImpl });
  assert.equal(calls.length, 2, 'should stop once page reaches totalPages');
  assert.equal(events.length, 2);
  assert.ok(calls[0].includes('classificationName=Music'));
  assert.ok(calls[0].includes('apikey=k'));
});

await asyncTest('fetchClassificationEvents throws with the response body on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(
    () => fetchClassificationEvents({ apiKey: 'bad', classificationName: 'Music', days: 60, fetchImpl }),
    /401/,
  );
});

await asyncTest('fetchAllLiveNationEvents queries both Music and Comedy and dedupes by event id', async () => {
  const seenClassifications = [];
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const classificationName = params.get('classificationName');
    seenClassifications.push(classificationName);
    // Same event id returned under both classifications, to exercise dedup.
    const events = params.get('page') === '0' ? [fakeEvent({ id: 'shared-evt' })] : [];
    return { ok: true, json: async () => ({ _embedded: { events }, page: { totalPages: 1, number: 0 } }) };
  };
  const events = await fetchAllLiveNationEvents({ apiKey: 'k', days: 60, fetchImpl });
  assert.deepEqual(seenClassifications.sort(), ['Comedy', 'Music']);
  assert.equal(events.length, 1, 'the same event id fetched under both classifications must be deduped');
});

function tmpCachePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-nation-pull-'));
  return path.join(dir, 'upcoming_shows_cache.json');
}

function tmpVenuesPath(venues) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-nation-venues-'));
  const p = path.join(dir, 'live-nation-venues.json');
  fs.writeFileSync(p, JSON.stringify({ venues }));
  return p;
}

await asyncTest('runOnce writes shows into a fresh cache file, tagging Live Nation ones', async () => {
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const events = params.get('page') === '0' && params.get('classificationName') === 'Music'
      ? [fakeEvent({ id: 'e1', promoter: { name: 'Live Nation' } }), fakeEvent({ id: 'e2', name: 'Indie Band', _embedded: { attractions: [{ name: 'Indie Band' }], venues: [{ name: 'The Echo' }] }, promoter: { name: 'AEG Presents' } })]
      : [];
    return { ok: true, json: async () => ({ _embedded: { events }, page: { totalPages: 1, number: 0 } }) };
  };
  const cachePathOverride = tmpCachePath();
  const venuesOverridePathOverride = tmpVenuesPath([]);
  const result = await runOnce({ days: 60, fetchImpl, apiKey: 'k', cachePathOverride, venuesOverridePathOverride, log: () => {} });
  assert.equal(result.eventCount, 2);
  assert.equal(result.showCount, 2);
  assert.equal(result.liveNationCount, 1);

  const written = JSON.parse(fs.readFileSync(cachePathOverride, 'utf8'));
  const crows = written.shows.find((s) => s.act === 'Counting Crows');
  const indie = written.shows.find((s) => s.act === 'Indie Band');
  assert.equal(crows.promoter, 'Live Nation');
  assert.equal('promoter' in indie, false);
});

await asyncTest('runOnce merges into an existing cache without discarding prior findings, and fills in a promoter on a matching duplicate', async () => {
  const cachePathOverride = tmpCachePath();
  fs.writeFileSync(cachePathOverride, JSON.stringify({
    fetchedAt: '2026-08-01T00:00:00Z',
    findings: [{ text: 'Counting Crows — Hollywood Bowl — 2026-09-10 — https://spotify-found.example', urls: [], label: 'spotify' }],
    shows: [{ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', sourceUrl: 'https://spotify-found.example' }],
  }));
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const events = params.get('page') === '0' && params.get('classificationName') === 'Music'
      ? [fakeEvent({ id: 'e1', promoter: { name: 'Live Nation' } })]
      : [];
    return { ok: true, json: async () => ({ _embedded: { events }, page: { totalPages: 1, number: 0 } }) };
  };
  await runOnce({ days: 60, fetchImpl, apiKey: 'k', cachePathOverride, venuesOverridePathOverride: tmpVenuesPath([]), log: () => {} });

  const written = JSON.parse(fs.readFileSync(cachePathOverride, 'utf8'));
  assert.equal(written.shows.length, 1, 'the Ticketmaster duplicate must merge into the existing spotify-found show, not add a second row');
  assert.equal(written.shows[0].sourceUrl, 'https://spotify-found.example', 'first-seen (spotify) fields survive');
  assert.equal(written.shows[0].promoter, 'Live Nation', 'the promoter tag is filled in from the Ticketmaster duplicate');
  assert.ok(written.findings.some((f) => f.label === 'spotify'), 'the prior spotify finding block must survive');
  assert.ok(written.findings.some((f) => f.label === 'livenation'), 'a new livenation finding block must be added');
});

console.log('All live-nation-pull tests passed.');
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-live-nation-pull.mjs`
Expected: FAIL — `Cannot find module '../scripts/live-nation-pull.mjs'` (doesn't exist yet).

- [ ] **Step 3: Create `scripts/live-nation-pull.mjs`**

```js
#!/usr/bin/env node
// Comprehensive Live Nation / Ticketmaster events pull for the LA metro —
// a structured API source (Live Nation owns Ticketmaster) that complements
// spotify-find-shows.mjs / upcoming-shows-pull.mjs's best-effort Claude+web-
// search discovery. See
// docs/superpowers/specs/2026-08-08-live-nation-shows-design.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ticketmasterEnvPath } from './longterm-paths.mjs';
import { dedupeShows } from './show-parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cachePath = path.join(repoRoot, 'data', 'upcoming_shows_cache.json');
const venuesOverridePath = path.join(repoRoot, 'data', 'live-nation-venues.json');

// Brentwood-ish center; radius covers the venues this household actually
// ranges over (Westside through DTLA/Pasadena/Anaheim).
const LA_LATLONG = '34.0489,-118.4735';
const LA_RADIUS_MILES = 50;
const CLASSIFICATIONS = ['Music', 'Comedy'];
// House of Blues Concerts is a real Live Nation subsidiary promoter name
// that shows up in live Ticketmaster responses.
const LIVE_NATION_PROMOTER_RE = /live nation|house of blues concerts/i;

function parseEnvFile(envFilePath) {
  const vars = {};
  if (!fs.existsSync(envFilePath)) return vars;
  for (const line of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

export function loadApiKey(envPath = ticketmasterEnvPath()) {
  const env = parseEnvFile(envPath);
  if (!env.TICKETMASTER_API_KEY) {
    throw new Error(
      `Missing TICKETMASTER_API_KEY in ${envPath} — register a free app at developer.ticketmaster.com, ` +
      `then save TICKETMASTER_API_KEY=<key> there.`,
    );
  }
  return env.TICKETMASTER_API_KEY;
}

export function loadLiveNationVenueNames(filePath = venuesOverridePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return (data.venues || []).map((v) => String(v).toLowerCase());
  } catch {
    return [];
  }
}

export function isLiveNationEvent(event, knownVenueNames = []) {
  const promoterNames = [
    event?.promoter?.name,
    ...((event?.promoters || []).map((p) => p?.name)),
  ].filter(Boolean);
  if (promoterNames.some((name) => LIVE_NATION_PROMOTER_RE.test(name))) return true;
  const venueName = event?._embedded?.venues?.[0]?.name;
  if (venueName && knownVenueNames.includes(String(venueName).toLowerCase())) return true;
  return false;
}

export function mapEventToShow(event, knownVenueNames = []) {
  const act = event?._embedded?.attractions?.[0]?.name || event?.name || null;
  const venue = event?._embedded?.venues?.[0]?.name || null;
  const date = event?.dates?.start?.localDate || null;
  if (!act || !date) return null;
  const show = {
    act,
    venue: venue || '',
    date,
    sourceUrl: event?.url || null,
  };
  if (isLiveNationEvent(event, knownVenueNames)) show.promoter = 'Live Nation';
  return show;
}

export async function fetchClassificationEvents({ apiKey, classificationName, days, fetchImpl = fetch, maxPages = 10 }) {
  const today = new Date();
  const end = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
  const startDateTime = `${today.toISOString().slice(0, 19)}Z`;
  const endDateTime = `${end.toISOString().slice(0, 19)}Z`;
  const events = [];
  let page = 0;
  for (;;) {
    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: LA_LATLONG,
      radius: String(LA_RADIUS_MILES),
      unit: 'miles',
      classificationName,
      startDateTime,
      endDateTime,
      size: '200',
      page: String(page),
    });
    const res = await fetchImpl(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
    if (!res.ok) throw new Error(`Ticketmaster API error: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const pageEvents = body?._embedded?.events || [];
    events.push(...pageEvents);
    const totalPages = body?.page?.totalPages ?? 1;
    page += 1;
    if (page >= totalPages || page >= maxPages || !pageEvents.length) break;
  }
  return events;
}

export async function fetchAllLiveNationEvents({ apiKey, days = 60, fetchImpl = fetch, maxPages = 10 }) {
  const all = [];
  for (const classificationName of CLASSIFICATIONS) {
    const events = await fetchClassificationEvents({ apiKey, classificationName, days, fetchImpl, maxPages });
    all.push(...events);
  }
  const seenIds = new Set();
  return all.filter((e) => {
    if (!e?.id || seenIds.has(e.id)) return false;
    seenIds.add(e.id);
    return true;
  });
}

function mergeIntoCache(shows, cachePathToUse) {
  let existing = { findings: [] };
  if (fs.existsSync(cachePathToUse)) {
    try {
      existing = JSON.parse(fs.readFileSync(cachePathToUse, 'utf8'));
    } catch {
      existing = { findings: [] };
    }
  }
  const findings = (existing.findings || []).filter((f) => f.label !== 'livenation');
  findings.push({ text: '', urls: [], label: 'livenation', shows });

  const allShows = dedupeShows([...(existing.shows || []), ...shows]);

  const cache = {
    ...existing,
    fetchedAt: new Date().toISOString(),
    findings,
    shows: allShows,
  };
  fs.mkdirSync(path.dirname(cachePathToUse), { recursive: true });
  fs.writeFileSync(cachePathToUse, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  return cache;
}

export async function runOnce({
  days = 60,
  fetchImpl = fetch,
  apiKey,
  cachePathOverride = cachePath,
  venuesOverridePathOverride = venuesOverridePath,
  log = console.log,
} = {}) {
  const key = apiKey || loadApiKey();
  const knownVenueNames = loadLiveNationVenueNames(venuesOverridePathOverride);
  const events = await fetchAllLiveNationEvents({ apiKey: key, days, fetchImpl });
  const shows = events.map((e) => mapEventToShow(e, knownVenueNames)).filter(Boolean);
  const liveNationCount = shows.filter((s) => s.promoter === 'Live Nation').length;
  const cache = mergeIntoCache(shows, cachePathOverride);
  log(`Live Nation pull: ${events.length} events fetched, ${shows.length} mapped, ${liveNationCount} flagged Live Nation. Wrote ${cachePathOverride}.`);
  return { eventCount: events.length, showCount: shows.length, liveNationCount, cache };
}

function parseArgs(argv) {
  let days = 60;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) days = Math.max(7, Number(argv[++i]) || 60);
  }
  return { days };
}

async function main() {
  const { days } = parseArgs(process.argv);
  await runOnce({ days });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-live-nation-pull.mjs`
Expected: PASS (14 tests).

- [ ] **Step 5: Add the npm script**

In `package.json`, insert `"livenation:pull": "node scripts/live-nation-pull.mjs",` right after the `"shows:pull"` line:

```json
    "shows:pull": "node scripts/upcoming-shows-pull.mjs",
    "livenation:pull": "node scripts/live-nation-pull.mjs",
    "shows:weekly": "powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-weekly-shows-pull.ps1",
```

- [ ] **Step 6: Run `npm run check:secrets`**

Run: `npm run check:secrets`
Expected: `check-no-secrets: ok` — confirms the new files (including the empty `live-nation-venues.json`) introduce no secrets.

- [ ] **Step 7: Commit**

```bash
git add scripts/live-nation-pull.mjs data/live-nation-venues.json data/test-live-nation-pull.mjs package.json
git commit -m "Add scripts/live-nation-pull.mjs: comprehensive Ticketmaster Discovery API pull"
```

---

### Task 5: Thread `promoter` through the Telegram message, tag "[LN]"

**Files:**
- Modify: `scripts/spotify-shows-telegram.mjs`
- Modify: `data/test-spotify-shows-telegram.mjs`

**Interfaces:**
- Consumes: `show.promoter` (set by Task 4's pull, carried through Task 3's scoring — `filterQualifyingShows` already receives the full scored show object from `show-matches-latest.json`, so `s.promoter` is already there; this task only needs to read and forward it).
- Produces: `filterQualifyingShows` entries gain a `promoter` field (mirroring how `score` was added in the prior session). `formatMessage` inserts `[LN]` after the score for a Live-Nation-tagged entry.

- [ ] **Step 1: Update the failing/changed tests first**

In `data/test-spotify-shows-telegram.mjs`, update the `show()` helper to optionally carry a promoter, and add new test cases. Replace:

```js
function show({ act, kind = 'music', basis = 'like', score = 90, date = '2026-08-10', venue = 'The Wiltern' }) {
  return { act, kind, date, venue, scores: { kevin: { basis, score, linked: true } } };
}
```

with:

```js
function show({ act, kind = 'music', basis = 'like', score = 90, date = '2026-08-10', venue = 'The Wiltern', promoter = undefined }) {
  const s = { act, kind, date, venue, scores: { kevin: { basis, score, linked: true } } };
  if (promoter) s.promoter = promoter;
  return s;
}
```

Then update the `'returns {act, kind, date, venue, score} objects, not bare strings'` test's name and body to also cover the promoter field. Replace:

```js
test('returns {act, kind, date, venue, score} objects, not bare strings', () => {
  const shows = [show({ act: 'Counting Crows', basis: 'like', date: '2026-08-14', venue: 'Hollywood Bowl', score: 97 })];
  assert.deepEqual(filterQualifyingShows({ shows }), [
    { act: 'Counting Crows', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl', score: 97 },
  ]);
});
```

with:

```js
test('returns {act, kind, date, venue, score} objects, not bare strings', () => {
  const shows = [show({ act: 'Counting Crows', basis: 'like', date: '2026-08-14', venue: 'Hollywood Bowl', score: 97 })];
  assert.deepEqual(filterQualifyingShows({ shows }), [
    { act: 'Counting Crows', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl', score: 97, promoter: null },
  ]);
});

test('carries a Live Nation promoter tag through when present', () => {
  const shows = [show({ act: 'Counting Crows', basis: 'like', score: 97, promoter: 'Live Nation' })];
  const [entry] = filterQualifyingShows({ shows });
  assert.equal(entry.promoter, 'Live Nation');
});
```

Then add a formatMessage test — insert this after the existing `'formatMessage uses the guitar for music, the laughing face for comedy, and shows the score'` test:

```js
test('formatMessage tags a Live Nation show with [LN] right after the score', () => {
  const entries = [
    { act: 'Counting Crows', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl', url: 'https://open.spotify.com/artist/cc', score: 97, promoter: 'Live Nation' },
    { act: 'Anthony Jeselnik', kind: 'comedy', date: '2026-08-16', venue: 'Largo', url: 'https://open.spotify.com/artist/aj', score: 56 },
  ];
  const text = formatMessage(entries);
  assert.equal(
    text,
    '🎸 Counting Crows (97%) [LN] — Aug 14 @ Hollywood Bowl: https://open.spotify.com/artist/cc\n'
    + '🤣 Anthony Jeselnik (56%) — Aug 16 @ Largo: https://open.spotify.com/artist/aj',
  );
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: FAIL — `filterQualifyingShows` doesn't yet return a `promoter` field, and `formatMessage` doesn't emit `[LN]`.

- [ ] **Step 3: Update `filterQualifyingShows` and `formatMessage`**

In `scripts/spotify-shows-telegram.mjs`, change:

```js
    entries.push({ act: s.act, kind: s.kind, date: s.date, venue: s.venue, score: kevinScore.score });
```

to:

```js
    entries.push({ act: s.act, kind: s.kind, date: s.date, venue: s.venue, score: kevinScore.score, promoter: s.promoter || null });
```

Change `formatMessage`:

```js
export function formatMessage(entries) {
  const sorted = [...entries].sort((a, b) => (b.score - a.score) || String(a.date).localeCompare(String(b.date)));
  return sorted
    .map((e) => `${KIND_EMOJI[e.kind] || KIND_EMOJI.music} ${e.act} (${e.score}%) — ${formatShowDate(e.date)} @ ${e.venue || 'TBD'}: ${e.url}`)
    .join('\n');
}
```

to:

```js
export function formatMessage(entries) {
  const sorted = [...entries].sort((a, b) => (b.score - a.score) || String(a.date).localeCompare(String(b.date)));
  return sorted
    .map((e) => {
      const lnTag = e.promoter === 'Live Nation' ? ' [LN]' : '';
      return `${KIND_EMOJI[e.kind] || KIND_EMOJI.music} ${e.act} (${e.score}%)${lnTag} — ${formatShowDate(e.date)} @ ${e.venue || 'TBD'}: ${e.url}`;
    })
    .join('\n');
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: PASS (26 tests — 24 prior + 2 new).

Note: the `buildArtistLinks`/`runOnce` tests construct entries manually without a `promoter` field — `e.promoter === 'Live Nation'` is `false` for `undefined`, so those existing tests are unaffected and need no edits.

- [ ] **Step 5: Commit**

```bash
git add scripts/spotify-shows-telegram.mjs data/test-spotify-shows-telegram.mjs
git commit -m "Tag Live Nation shows [LN] in the weekly Telegram message"
```

---

### Task 6: "LN" badge on the dashboard's Dining + Shows tab

**Files:**
- Modify: `dashboard_v5.html`
- Modify: `data/dashboard-test-harness.mjs`
- Test: `data/test-dashboard-shows.mjs` (new)

**Interfaces:**
- Consumes: `show.promoter` (same field, already flowing through `show-matches-latest.json` by this point).
- Produces: `showRowHTML(show)` (already defined in `dashboard_v5.html`) renders a `.show-ln-badge` span next to the act name when `show.promoter === 'Live Nation'`. Exposed to tests via the harness's `exportNames` list, callable as `d.showRowHTML(show)`.

- [ ] **Step 1: Expose `showRowHTML` from the test harness**

In `data/dashboard-test-harness.mjs`, add `'showRowHTML'` to the `exportNames` array (it currently ends with `'toggleExpPanel', 'initReady',`):

```js
  'computeTrackerPacing', 'renderCategoryDrilldown', 'toggleDrilldown',
  'renderSpendTracker', 'renderTravelSummary', 'renderJointKevinTrackers',
  'toggleExpPanel', 'initReady', 'showRowHTML',
];
```

- [ ] **Step 2: Write the failing test**

Create `data/test-dashboard-shows.mjs`:

```js
// Longterm/data/test-dashboard-shows.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// dashboard_v5.html's showRowHTML() Live Nation "LN" badge (2026-08-08) —
// run through the same headless harness test-dashboard-contract.mjs uses.
// Run with:
//   node Longterm/data/test-dashboard-shows.mjs
import assert from 'node:assert/strict';
import { loadDashboard } from './dashboard-test-harness.mjs';

async function test(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-dashboard-shows.mjs');

await test('showRowHTML renders the LN badge for a Live Nation show', async () => {
  const d = loadDashboard();
  await d.initReady;
  const html = d.showRowHTML({ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation', scores: {} });
  assert.ok(html.includes('show-ln-badge'), 'expected an LN badge element in the row markup');
  assert.ok(/>LN</.test(html), 'expected the badge text to read "LN"');
});

await test('showRowHTML renders no badge when the show is not Live Nation-promoted', async () => {
  const d = loadDashboard();
  await d.initReady;
  const html = d.showRowHTML({ act: 'Indie Band', venue: 'The Echo', date: '2026-09-10', scores: {} });
  assert.equal(html.includes('show-ln-badge'), false);
});

console.log('All dashboard-shows tests passed.');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node data/test-dashboard-shows.mjs`
Expected: FAIL — no `show-ln-badge` in the rendered HTML yet.

- [ ] **Step 4: Add the CSS and update `showRowHTML`**

In `dashboard_v5.html`, in the CSS block, right after the existing `.show-act{...}` rule (currently `.show-act{font-size:14px;font-weight:600;color:var(--navy);line-height:1.3}`), add:

```css
.show-act{font-size:14px;font-weight:600;color:var(--navy);line-height:1.3}
.show-ln-badge{display:inline-block;margin-left:6px;padding:1px 5px;font-size:9px;font-weight:700;letter-spacing:.04em;color:#000;background:var(--gold);border-radius:3px;vertical-align:middle}
```

Then update `showRowHTML` — currently:

```js
function showRowHTML(show) {
  const parts = formatShowDateParts(show.date);
  const dateHtml = parts
    ? `<div class="show-date"><span class="show-date-mon">${parts.mon}</span><span class="show-date-day">${parts.day}</span></div>`
    : `<div class="show-date"><span class="show-date-mon">—</span><span class="show-date-day">?</span></div>`;
  const link = show.sourceUrl
    ? `<a class="show-link" href="${escapeHtml(show.sourceUrl)}" target="_blank" rel="noopener">Tickets</a>`
    : `<span class="show-link"></span>`;
  return `<div class="show-row">
    ${dateHtml}
    <div>
      <div class="show-act">${escapeHtml(show.act || 'Show')}</div>
      ${show.venue ? `<div class="show-venue">${escapeHtml(show.venue)}</div>` : ''}
      ${showPitchHTML(show)}
      ${suggestionStarsHTML(show)}
    </div>
    ${showScoresHTML(show)}
    ${link}
  </div>`;
}
```

becomes:

```js
function showRowHTML(show) {
  const parts = formatShowDateParts(show.date);
  const dateHtml = parts
    ? `<div class="show-date"><span class="show-date-mon">${parts.mon}</span><span class="show-date-day">${parts.day}</span></div>`
    : `<div class="show-date"><span class="show-date-mon">—</span><span class="show-date-day">?</span></div>`;
  const link = show.sourceUrl
    ? `<a class="show-link" href="${escapeHtml(show.sourceUrl)}" target="_blank" rel="noopener">Tickets</a>`
    : `<span class="show-link"></span>`;
  const lnBadge = show.promoter === 'Live Nation'
    ? `<span class="show-ln-badge" title="Live Nation — ticket connection possible">LN</span>`
    : '';
  return `<div class="show-row">
    ${dateHtml}
    <div>
      <div class="show-act">${escapeHtml(show.act || 'Show')}${lnBadge}</div>
      ${show.venue ? `<div class="show-venue">${escapeHtml(show.venue)}</div>` : ''}
      ${showPitchHTML(show)}
      ${suggestionStarsHTML(show)}
    </div>
    ${showScoresHTML(show)}
    ${link}
  </div>`;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node data/test-dashboard-shows.mjs`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the existing dashboard contract test to confirm no regression**

Run: `node data/test-dashboard-contract.mjs`
Expected: PASS, unchanged (the badge is purely additive and empty-string when absent).

- [ ] **Step 7: Manually verify in a browser**

Run `npm run dev`, open the dashboard, go to Dining + Shows, and confirm the tab renders normally (existing shows still show correctly; the badge only appears once real `promoter: 'Live Nation'` data exists, which requires Task 4's live pull — expected to be empty/absent until Kevin adds the API key).

- [ ] **Step 8: Commit**

```bash
git add dashboard_v5.html data/dashboard-test-harness.mjs data/test-dashboard-shows.mjs
git commit -m "Add LN badge to the dashboard's Dining + Shows tab"
```

---

### Task 7: Wire into the weekly pull, update docs

**Files:**
- Modify: `scripts/run-weekly-shows-pull.ps1`
- Modify: `claude.md`

**Interfaces:**
- Consumes: `npm run livenation:pull` (Task 4).
- Produces: nothing new consumed by later tasks — this is the final integration/documentation task.

- [ ] **Step 1: Add the `livenation:pull` step**

In `scripts/run-weekly-shows-pull.ps1`, add a new switch parameter. Change:

```powershell
param(
    [switch]$SkipFindShows,
    [switch]$SkipVenuePull,
    [switch]$SkipMatch,
    [switch]$SkipShowNotify
)
```

to:

```powershell
param(
    [switch]$SkipFindShows,
    [switch]$SkipVenuePull,
    [switch]$SkipLiveNation,
    [switch]$SkipMatch,
    [switch]$SkipShowNotify
)
```

Then insert the step between `shows:pull` and `spotify:match`. Change:

```powershell
    if (-not $SkipFindShows) { Invoke-NpmScript 'spotify:find-shows' }
    if (-not $SkipVenuePull) { Invoke-NpmScript 'shows:pull' }
    if (-not $SkipMatch) { Invoke-NpmScript 'spotify:match' }
```

to:

```powershell
    if (-not $SkipFindShows) { Invoke-NpmScript 'spotify:find-shows' }
    if (-not $SkipVenuePull) { Invoke-NpmScript 'shows:pull' }
    # Isolated the same way the spotify:notify-shows step below already is:
    # a missing Ticketmaster API key (expected until Kevin registers one) or
    # an API outage must never fail spotify:find-shows/shows:pull, which
    # already ran successfully, or block spotify:match from running on
    # whatever the cache already has.
    if (-not $SkipLiveNation) {
        try {
            Invoke-NpmScript 'livenation:pull'
        } catch {
            Write-ShowsLog ('WARN livenation:pull failed (continuing): {0}' -f $_.Exception.Message)
        }
    }
    if (-not $SkipMatch) { Invoke-NpmScript 'spotify:match' }
```

- [ ] **Step 2: Verify the script still parses and runs end-to-end as a no-op**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-weekly-shows-pull.ps1 -SkipFindShows -SkipVenuePull -SkipLiveNation -SkipMatch -SkipShowNotify`
Expected: logs `=== Longterm weekly shows pull begin ===` then `=== Longterm weekly shows pull success ===` with every step skipped — confirms the new switch parses correctly and the control flow is intact.

- [ ] **Step 3: Update `claude.md`**

Update the `data/upcoming_shows_cache.json` bullet. Change:

```
- `data/upcoming_shows_cache.json` / Spotify match artifacts — refreshed on a **weekly** scheduled task (`LongtermWeeklyShowsPull`, Sunday 10:00 by default via `install-weekly-shows-scheduled-task.ps1` → `run-weekly-shows-pull.ps1`: `spotify:find-shows` → `shows:pull` → `spotify:match` → `spotify:notify-shows`). Log: `~/.longterm/logs/weekly-shows.log`. Manual: `npm run shows:weekly`. The Telegram bot's on-demand `get_upcoming_shows` can still refresh mid-week.
```

to:

```
- `data/upcoming_shows_cache.json` / Spotify match artifacts — refreshed on a **weekly** scheduled task (`LongtermWeeklyShowsPull`, Sunday 10:00 by default via `install-weekly-shows-scheduled-task.ps1` → `run-weekly-shows-pull.ps1`: `spotify:find-shows` → `shows:pull` → `livenation:pull` → `spotify:match` → `spotify:notify-shows`). Log: `~/.longterm/logs/weekly-shows.log`. Manual: `npm run shows:weekly`. The Telegram bot's on-demand `get_upcoming_shows` can still refresh mid-week.
- `scripts/live-nation-pull.mjs` (2026-08-08, → `npm run livenation:pull`) — a structured, comprehensive LA-area events pull via the Ticketmaster Discovery API (Live Nation owns Ticketmaster), complementing the two Claude+web-search discovery scripts above rather than replacing them. Detects Live Nation-promoted shows via the API's own `promoter`/`promoters[]` field (matched against `/live nation|house of blues concerts/i`), falling back to a hand-maintained `data/live-nation-venues.json` venue-name list when that field is missing — never a false positive, only a possible missed tag. Requires `TICKETMASTER_API_KEY` in `~/.longterm/ticketmaster.env` (register free at developer.ticketmaster.com), same per-service env-file convention as the other integrations; missing/invalid, it fails loudly but is contained by the weekly pull's own isolated try/catch, same as the `spotify:notify-shows` step. A show's `promoter: 'Live Nation'` field survives into `spotify-likeness.mjs`'s scoring as a flat `LIVE_NATION_BOOST` (+15, alongside the existing venue-rating boost) — Kevin has a personal connection who can often get free/discounted tickets to these — and is surfaced as an "LN" tag/badge everywhere a show appears: `[LN]` in the weekly Telegram message (`spotify-shows-telegram.mjs`) and a small badge next to the act name on the dashboard's Dining + Shows tab (`showRowHTML()`'s `.show-ln-badge`).
```

- [ ] **Step 4: Run the full test suite one more time**

Run each: `node data/test-longterm-paths.mjs`, `node data/test-show-parse.mjs`, `node data/test-spotify-likeness.mjs`, `node data/test-live-nation-pull.mjs`, `node data/test-spotify-shows-telegram.mjs`, `node data/test-dashboard-shows.mjs`, `node data/test-dashboard-contract.mjs`.
Expected: all PASS.

- [ ] **Step 5: Run `npm run check:secrets`**

Run: `npm run check:secrets`
Expected: `check-no-secrets: ok`.

- [ ] **Step 6: Commit**

```bash
git add scripts/run-weekly-shows-pull.ps1 claude.md
git commit -m "Wire livenation:pull into the weekly shows pull; document the feature"
```

---

## After all tasks: hand back to Kevin

Once Kevin has a Ticketmaster API key (`~/.longterm/ticketmaster.env`, `TICKETMASTER_API_KEY=<key>`), run `npm run livenation:pull` once by hand to live-verify against the real API (per this codebase's live-verification discipline for every integration) before relying on the scheduled weekly run.
