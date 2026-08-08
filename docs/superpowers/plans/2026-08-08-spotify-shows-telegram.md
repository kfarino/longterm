# Spotify Shows via Telegram Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the (permanently 403-blocked) auto-playlist delivery with a weekly Telegram message — one Spotify artist-page link per taste-matched upcoming LA show, music and comedy both — wired into the existing weekly shows pull.

**Architecture:** `scripts/spotify-playlist-shows.mjs` is renamed to `scripts/spotify-shows-telegram.mjs` and rewritten: `filterQualifyingShows` gains comedy and returns `{act, kind, date, venue}` objects instead of bare strings; a new `resolveArtistPageUrl` replaces `resolveArtistTracks`, searching `type=artist` instead of `type=track`; a new `buildArtistLinks` replaces `buildTrackList`; new `formatShowDate`/`formatMessage` build the Telegram text; a new `runOnce`/`main` (mirroring `telegram-bot-reminders.mjs`'s shape — the closest existing sibling: a simple one-shot job that composes and sends one grouped Telegram message, no LLM call) replaces the playlist-specific `ensurePlaylist`/`replacePlaylistTracks`/`runPlaylistUpdate`, which are deleted outright. `data/test-spotify-playlist-shows.mjs` is renamed to `data/test-spotify-shows-telegram.mjs` and its playlist-orchestration tests are replaced with `runOnce` tests. The `playlist-modify-private` scope is removed from `spotify-client.mjs` since it can never be exercised. Every Spotify/Telegram call stays behind an injectable client parameter — no real network calls in the test suite.

**Tech Stack:** Node.js ESM (`.mjs`), hand-rolled `assert/strict` test runners (no framework) — matching every other script/test in this codebase.

**Design docs:**
- `docs/superpowers/specs/2026-08-08-spotify-shows-telegram-design.md` — read first, this is the authoritative "why."
- `docs/superpowers/specs/2026-08-07-spotify-shows-playlist-design.md` — superseded, but documents the two prior 403 findings (`top-tracks`, playlist-write) this plan must not accidentally repeat.

## Global Constraints

- **No real network calls in the test suite.** Every Spotify call goes through an injected `spotifyClient`; every Telegram call through an injected `telegramClient`. Tests never depend on `~/.longterm/*.env` existing — always pass `accessToken`, and either `token`+`groupChatId` directly or nothing (dry-run).
- **Search reliability:** `resolveArtistPageUrl` MUST use the `artist:"<name>"` field-filter query form (`type: 'artist'`), never a bare-name query — a bare query was verified live to return the wrong artist ("Bill Burr" for "Anthony Jeselnik") in one out of two tests, while the field-filter form was correct both times it was tested.
- **An unmatched artist is skipped and logged, never fatal** — one bad lookup must not drop the rest of the week's list. Same convention `resolveArtistTracks`/`buildTrackList` used.
- **Delete, don't leave inert:** `ensurePlaylist`, `replacePlaylistTracks`, `runPlaylistUpdate`, the `data/spotify/show-playlist-state.json` convention (no code references it after this plan), and the `playlist-modify-private` scope entry. Do not comment these out — remove them.
- **`spotifyPost`/`spotifyPut` in `spotify-client.mjs` are left in place**, untouched — they are generic write-HTTP helpers, not playlist-specific, and the spec's deletion list does not name them. (This is a deliberate scope decision for this plan, not an oversight — flagging it so a reviewer doesn't wonder why they survived.)
- **`data/spotify/*` is already gitignored** except `sample-shows.json` — no `.gitignore` change needed anywhere in this plan.
- **Message format** (exact, from the design doc): `${emoji} ${act} — ${MonAbbrev} ${day} @ ${venue}: ${url}`, one line per artist, sorted soonest-first, `🎵` for `kind === 'music'`, `🎤` for `kind === 'comedy'`.
- **Verify against the real Spotify API before Task 3 is considered done** — call `resolveArtistPageUrl` for real against "Counting Crows" (music) and "Anthony Jeselnik" (comedy) using a real token from `getValidAccessToken('kevin')`. This is a manual `node -e` check, not a committed script — record the resolved URLs in the task's own notes when done.
- **Never send a real Telegram message during development.** The `--dry-run` flag composes the message and returns it without calling the Telegram client at all. All send-path verification happens through the injected `telegramClient` in tests, never a real call.
- Follow this codebase's established DI pattern exactly: `someClient = args.someClient || defaultRealImpl`.
- Run `npm run check:secrets` before every commit that touches tracked files (per `AGENTS.md`); none of this plan's files can trip it (no real household data involved), but it's cheap insurance.

---

### Task 1: Rename the script and test file to reflect the new subject

**Files:**
- Rename: `scripts/spotify-playlist-shows.mjs` → `scripts/spotify-shows-telegram.mjs` (no content change in this task)
- Rename: `data/test-spotify-playlist-shows.mjs` → `data/test-spotify-shows-telegram.mjs`
- Modify: `data/test-spotify-shows-telegram.mjs` (fix the import path and header comment only)

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing new — this task only moves files so later tasks edit them at their final path. All current exports (`filterQualifyingShows`, `resolveArtistTracks`, `buildTrackList`, `ensurePlaylist`, `replacePlaylistTracks`, `runPlaylistUpdate`, `defaultMatchDataPath`, `defaultStatePath`) still exist after this task — Task 2 onward is where behavior changes.

- [ ] **Step 1: Rename both files with `git mv`**

```bash
git mv scripts/spotify-playlist-shows.mjs scripts/spotify-shows-telegram.mjs
git mv data/test-spotify-playlist-shows.mjs data/test-spotify-shows-telegram.mjs
```

- [ ] **Step 2: Fix the test file's import path and its top-of-file comments**

In `data/test-spotify-shows-telegram.mjs`, change:
```js
// Longterm/data/test-spotify-playlist-shows.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// spotify-playlist-shows.mjs's filtering/dedup, track resolution, and
// playlist create-vs-replace orchestration — all with injected Spotify
// clients, never a real network call. Run with:
//   node Longterm/data/test-spotify-playlist-shows.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterQualifyingShows, resolveArtistTracks, buildTrackList, ensurePlaylist, replacePlaylistTracks, runPlaylistUpdate } from '../scripts/spotify-playlist-shows.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-spotify-playlist-shows.mjs');
```
to:
```js
// Longterm/data/test-spotify-shows-telegram.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// spotify-shows-telegram.mjs's filtering/dedup, artist-page resolution, and
// message composition/send orchestration — all with injected Spotify/Telegram
// clients, never a real network call. Run with:
//   node Longterm/data/test-spotify-shows-telegram.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterQualifyingShows, resolveArtistTracks, buildTrackList, ensurePlaylist, replacePlaylistTracks, runPlaylistUpdate } from '../scripts/spotify-shows-telegram.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-spotify-shows-telegram.mjs');
```

(The import list still names the soon-to-be-deleted playlist functions — that's fine, Task 6 rewrites this import line along with deleting their tests. This step only has to keep the file loading and passing right now.)

- [ ] **Step 3: Run the full existing suite at its new path to confirm the rename alone didn't break anything**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: `All spotify-playlist-shows tests passed.` (the trailing console.log string inside the file still says this — cosmetic, Task 6 will update it) with every `ok -` line printing, no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/spotify-shows-telegram.mjs data/test-spotify-shows-telegram.mjs
git commit -m "Rename spotify-playlist-shows to spotify-shows-telegram (subject changed, content not yet)."
```

---

### Task 2: `filterQualifyingShows` — comedy inclusion and the new object shape

**Files:**
- Modify: `scripts/spotify-shows-telegram.mjs`
- Test: `data/test-spotify-shows-telegram.mjs`

**Interfaces:**
- Consumes: `normalizeArtistName(name): string` from `spotify-pull.mjs` (already exported, unchanged).
- Produces: `filterQualifyingShows(matchData): Array<{act: string, kind: 'music'|'comedy', date: string, venue: string|undefined}>` — deduplicated by normalized artist name, first occurrence wins, sorted in original encounter order (sorting by date happens later, in `formatMessage`). Task 4 (`buildArtistLinks`) consumes this array directly.

- [ ] **Step 1: Replace the old `filterQualifyingShows` tests with tests for the new shape**

In `data/test-spotify-shows-telegram.mjs`, replace the six existing tests for `filterQualifyingShows` (from `test('keeps only music shows with a real signal (basis !== claude)'...` through `test('empty or missing shows array degrades to an empty list, not a crash'...`) with:

```js
test('keeps music and comedy shows with a real signal (basis !== claude)', () => {
  const shows = [
    show({ act: 'Counting Crows', basis: 'like' }),
    show({ act: 'JAŸ-Z', basis: 'follow' }),
    show({ act: 'Some Playlist Artist', basis: 'playlist' }),
    show({ act: 'Anthony Jeselnik', kind: 'comedy', basis: 'comedy' }),
    show({ act: 'LLM Guess Artist', basis: 'claude' }),
  ];
  const result = filterQualifyingShows({ shows });
  assert.deepEqual(result.map((e) => e.act), ['Counting Crows', 'JAŸ-Z', 'Some Playlist Artist', 'Anthony Jeselnik']);
});

test('returns {act, kind, date, venue} objects, not bare strings', () => {
  const shows = [show({ act: 'Counting Crows', basis: 'like', date: '2026-08-14', venue: 'Hollywood Bowl' })];
  assert.deepEqual(filterQualifyingShows({ shows }), [
    { act: 'Counting Crows', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl' },
  ]);
});

test('excludes a kind other than music or comedy', () => {
  const shows = [{ act: 'Some Festival', kind: 'other', date: '2026-08-10', scores: { kevin: { basis: 'like' } } }];
  assert.deepEqual(filterQualifyingShows({ shows }), []);
});

test('excludes an LLM-guessed comedy show the same as an LLM-guessed music show', () => {
  const shows = [show({ act: 'Guessed Comedian', kind: 'comedy', basis: 'claude' })];
  assert.deepEqual(filterQualifyingShows({ shows }), []);
});

test('deduplicates an artist appearing across multiple tour dates, first occurrence wins', () => {
  const shows = [
    show({ act: 'JAŸ-Z', basis: 'follow', date: '2026-08-10' }),
    show({ act: 'JAŸ-Z', basis: 'follow', date: '2026-08-24' }),
  ];
  const result = filterQualifyingShows({ shows });
  assert.equal(result.length, 1);
  assert.equal(result[0].date, '2026-08-10');
});

test('deduplicates case/whitespace variants of the same artist name', () => {
  const shows = [
    show({ act: 'The Doobie Brothers', basis: 'like' }),
    show({ act: '  the doobie brothers  ', basis: 'follow' }),
  ];
  assert.equal(filterQualifyingShows({ shows }).length, 1);
});

test('an owner with no scores.kevin entry is excluded, not treated as qualifying', () => {
  const shows = [{ act: 'No Score Artist', kind: 'music', date: '2026-08-10', scores: {} }];
  assert.deepEqual(filterQualifyingShows({ shows }), []);
});

test('empty or missing shows array degrades to an empty list, not a crash', () => {
  assert.deepEqual(filterQualifyingShows({ shows: [] }), []);
  assert.deepEqual(filterQualifyingShows({}), []);
});
```

Also update the `show()` fixture helper just above these tests (it currently hardcodes `kind = 'music'` and has no `venue`) to:

```js
function show({ act, kind = 'music', basis = 'like', score = 90, date = '2026-08-10', venue = 'The Wiltern' }) {
  return { act, kind, date, venue, scores: { kevin: { basis, score, linked: true } } };
}
```

- [ ] **Step 2: Run the test file to confirm these new/changed tests fail**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: FAIL — `filterQualifyingShows` still excludes comedy and returns bare strings, so the new assertions don't match (e.g. `AssertionError` comparing `['Counting Crows', ...]` to objects, or comedy missing from the result).

- [ ] **Step 3: Rewrite `filterQualifyingShows` in `scripts/spotify-shows-telegram.mjs`**

Replace:
```js
// Only shows backed by a genuine signal from Kevin's own Spotify library
// (like/follow/playlist) count as "recommended" — basis: 'claude' is an LLM
// guess, not a real taste signal, and the current real match data ranges
// from score 97 down to 18 with everything below 84 being an LLM guess (see
// the design doc). Comedy shows have no Spotify-track equivalent.
export function filterQualifyingShows(matchData) {
  const shows = matchData?.shows || [];
  const seen = new Set();
  const artists = [];
  for (const s of shows) {
    if (s.kind !== 'music') continue;
    const kevinScore = s.scores?.kevin;
    if (!kevinScore || kevinScore.basis === 'claude') continue;
    // Trimmed first: normalizeArtistName's leading-"the"-strip is anchored to
    // the very start of the string, so untrimmed leading whitespace would
    // silently defeat it and produce a different dedup key for an otherwise
    // identical artist name.
    const key = normalizeArtistName(String(s.act || '').trim());
    if (seen.has(key)) continue;
    seen.add(key);
    artists.push(s.act);
  }
  return artists;
}
```
with:
```js
// Only shows backed by a genuine signal count as "recommended" —
// basis: 'claude' is an LLM guess, not a real taste signal (see the design
// doc). Comedy is included as of the Telegram redesign: an artist-*page*
// link (unlike a track) has no music-catalog requirement, and comedy's own
// basis is literally the string 'comedy' (from comedyTaste matching, not an
// LLM guess), so it already passes this same basis !== 'claude' check
// without a comedy-specific branch.
export function filterQualifyingShows(matchData) {
  const shows = matchData?.shows || [];
  const seen = new Set();
  const entries = [];
  for (const s of shows) {
    if (s.kind !== 'music' && s.kind !== 'comedy') continue;
    const kevinScore = s.scores?.kevin;
    if (!kevinScore || kevinScore.basis === 'claude') continue;
    // Trimmed first: normalizeArtistName's leading-"the"-strip is anchored to
    // the very start of the string, so untrimmed leading whitespace would
    // silently defeat it and produce a different dedup key for an otherwise
    // identical artist name.
    const key = normalizeArtistName(String(s.act || '').trim());
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ act: s.act, kind: s.kind, date: s.date, venue: s.venue });
  }
  return entries;
}
```

- [ ] **Step 4: Run the test file to confirm it passes**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: every `filterQualifyingShows` test prints `ok -`. Later tests in the file (track resolution, playlist orchestration) are untouched by this task and still reference the old functions — they should still pass too, since those functions still exist unchanged.

- [ ] **Step 5: Commit**

```bash
git add scripts/spotify-shows-telegram.mjs data/test-spotify-shows-telegram.mjs
git commit -m "filterQualifyingShows: include comedy, return {act,kind,date,venue} objects."
```

---

### Task 3: `resolveArtistPageUrl` — artist-page search, replacing track search

**Files:**
- Modify: `scripts/spotify-shows-telegram.mjs`
- Test: `data/test-spotify-shows-telegram.mjs`

**Interfaces:**
- Consumes: `spotifyGet(accessToken, pathSuffix, query)` from `spotify-client.mjs` (unchanged).
- Produces: `resolveArtistPageUrl(accessToken, artistName, { spotifyClient = spotifyGet } = {}): Promise<string|null>`. Task 4 (`buildArtistLinks`) calls this once per deduplicated artist.

- [ ] **Step 1: Replace the old track-resolution tests with artist-page tests**

In `data/test-spotify-shows-telegram.mjs`, replace the `fakeSpotifyClient` helper and the two `resolveArtistTracks` tests:

```js
// Keyed by the exact `artist:"<name>"` query resolveArtistTracks sends —
// track search directly, not the search-for-id-then-top-tracks shape this
// originally had. /artists/{id}/top-tracks was verified live to return 403
// Forbidden on this app's registration (see resolveArtistTracks's own
// comment); track search only ever needs /search, already proven working.
function fakeSpotifyClient({ tracksByArtist = {} } = {}) {
  return async (token, pathSuffix, query) => {
    if (pathSuffix !== 'search') throw new Error(`Unexpected path in fakeSpotifyClient: ${pathSuffix}`);
    const match = query.q.match(/^artist:"(.+)"$/);
    const name = match ? match[1] : null;
    const uris = (name && tracksByArtist[name]) || [];
    return { tracks: { items: uris.map((uri) => ({ uri })) } };
  };
}

await asyncTest('resolves an artist to up to 3 track URIs via direct track search', async () => {
  const client = fakeSpotifyClient({
    tracksByArtist: { 'Counting Crows': ['spotify:track:a', 'spotify:track:b', 'spotify:track:c', 'spotify:track:d'] },
  });
  const uris = await resolveArtistTracks('token', 'Counting Crows', { spotifyClient: client });
  assert.deepEqual(uris, ['spotify:track:a', 'spotify:track:b', 'spotify:track:c']);
});

await asyncTest('an artist with no search results resolves to an empty list, not a throw', async () => {
  const client = fakeSpotifyClient({});
  const uris = await resolveArtistTracks('token', 'Nobody Findable', { spotifyClient: client });
  assert.deepEqual(uris, []);
});
```

with:

```js
// Keyed by the exact `artist:"<name>"` field-filter query resolveArtistPageUrl
// sends, with type=artist — a bare-name query was verified live to be
// unreliable (returned "Bill Burr" for "Anthony Jeselnik" in one test), so
// only the field-filter form is exercised here.
function fakeArtistSearchClient({ urlByArtist = {} } = {}) {
  return async (token, pathSuffix, query) => {
    if (pathSuffix !== 'search') throw new Error(`Unexpected path in fakeArtistSearchClient: ${pathSuffix}`);
    if (query.type !== 'artist') throw new Error(`Expected type=artist, got ${query.type}`);
    const match = query.q.match(/^artist:"(.+)"$/);
    const name = match ? match[1] : null;
    const url = name ? urlByArtist[name] : null;
    return { artists: { items: url ? [{ name, external_urls: { spotify: url } }] : [] } };
  };
}

await asyncTest('resolves an artist to its Spotify artist-page URL via artist search', async () => {
  const client = fakeArtistSearchClient({
    urlByArtist: { 'Counting Crows': 'https://open.spotify.com/artist/0vEsuISMWAKNctLlUAhSZC' },
  });
  const url = await resolveArtistPageUrl('token', 'Counting Crows', { spotifyClient: client });
  assert.equal(url, 'https://open.spotify.com/artist/0vEsuISMWAKNctLlUAhSZC');
});

await asyncTest('an artist with no search results resolves to null, not a throw', async () => {
  const client = fakeArtistSearchClient({});
  const url = await resolveArtistPageUrl('token', 'Nobody Findable', { spotifyClient: client });
  assert.equal(url, null);
});

await asyncTest('sends the artist:"<name>" field-filter query, never a bare-name query', async () => {
  let seenQuery = null;
  const client = async (token, pathSuffix, query) => { seenQuery = query; return { artists: { items: [] } }; };
  await resolveArtistPageUrl('token', 'Anthony Jeselnik', { spotifyClient: client });
  assert.equal(seenQuery.q, 'artist:"Anthony Jeselnik"');
  assert.equal(seenQuery.type, 'artist');
  assert.equal(seenQuery.limit, 1);
});
```

- [ ] **Step 2: Run the test file to confirm the new tests fail**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: FAIL — `resolveArtistPageUrl` is not exported yet (`SyntaxError`/`TypeError: resolveArtistPageUrl is not a function` or similar import failure).

- [ ] **Step 3: Add `resolveArtistPageUrl` to `scripts/spotify-shows-telegram.mjs`**

Immediately after `resolveArtistTracks` (which still exists at this point — Task 6 deletes it), add:

```js
// Resolves an artist to their Spotify artist-*page* URL (GET /search?type=
// artist), not a track — this needs no scope beyond what was already
// granted, and never needs /artists/{id}/top-tracks (403'd, see below).
// MUST use the artist:"<name>" field-filter form: a bare-name query
// (`q: artistName`, no filter) was verified live to be unreliable — one test
// returned "Bill Burr" for "Anthony Jeselnik" — while the field-filter form
// was retested and correct twice. Comedians with released specials have real
// Spotify artist pages (verified live: Jeselnik, Patton Oswalt, Tig Notaro,
// Pete Holmes all resolve), so this works for both kinds this script handles.
export async function resolveArtistPageUrl(accessToken, artistName, { spotifyClient = spotifyGet } = {}) {
  const result = await spotifyClient(accessToken, 'search', { q: `artist:"${artistName}"`, type: 'artist', limit: 1 });
  const top = result?.artists?.items?.[0];
  return top?.external_urls?.spotify || null;
}
```

- [ ] **Step 4: Run the test file to confirm it passes**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: all `resolveArtistPageUrl` tests print `ok -`.

- [ ] **Step 5: Verify against the real Spotify API (do not skip — this is the discipline that caught both prior 403s)**

Run, from the repo root:
```bash
node -e "
import('./scripts/spotify-client.mjs').then(async ({ getValidAccessToken }) => {
  const { resolveArtistPageUrl } = await import('./scripts/spotify-shows-telegram.mjs');
  const token = await getValidAccessToken('kevin');
  console.log('Counting Crows ->', await resolveArtistPageUrl(token, 'Counting Crows'));
  console.log('Anthony Jeselnik ->', await resolveArtistPageUrl(token, 'Anthony Jeselnik'));
});
"
```
Expected: both print a real `https://open.spotify.com/artist/...` URL, not `null` and not a thrown error. Record both resolved URLs in this task's notes (or the final report) — this is the live-verification evidence the project's process requires before the task counts as done.

- [ ] **Step 6: Commit**

```bash
git add scripts/spotify-shows-telegram.mjs data/test-spotify-shows-telegram.mjs
git commit -m "Add resolveArtistPageUrl: artist-page search via the field-filter query, verified live."
```

---

### Task 4: `buildArtistLinks` — resolve every qualifying artist, skip failures

**Files:**
- Modify: `scripts/spotify-shows-telegram.mjs`
- Test: `data/test-spotify-shows-telegram.mjs`

**Interfaces:**
- Consumes: `resolveArtistPageUrl(accessToken, artistName, {spotifyClient}): Promise<string|null>` (Task 3).
- Produces: `buildArtistLinks(accessToken, entries, { spotifyClient = spotifyGet, log = () => {} } = {}): Promise<Array<{act, kind, date, venue, url}>>` — entries whose artist had no confident match are dropped, not included with a null `url`. Task 6's `runOnce` calls this directly on `filterQualifyingShows`'s output.

- [ ] **Step 1: Replace the old `buildTrackList` tests**

Replace:
```js
await asyncTest('buildTrackList flattens across artists and skips an unresolvable one without failing the run', async () => {
  const client = fakeSpotifyClient({ tracksByArtist: { 'Counting Crows': ['spotify:track:a'] } });
  const logs = [];
  const uris = await buildTrackList('token', ['Counting Crows', 'Nobody Findable'], { spotifyClient: client, log: (m) => logs.push(m) });
  assert.deepEqual(uris, ['spotify:track:a']);
  assert.ok(logs.some((l) => l.includes('Nobody Findable')), 'the skipped artist should be logged');
});

await asyncTest('buildTrackList continues past a client that throws for one artist', async () => {
  const client = async (token, pathSuffix, query) => {
    if (query.q === 'artist:"Throws"') throw new Error('simulated Spotify API failure');
    return { tracks: { items: [{ uri: 'spotify:track:ok' }] } };
  };
  const logs = [];
  const uris = await buildTrackList('token', ['Throws', 'Fine Artist'], { spotifyClient: client, log: (m) => logs.push(m) });
  assert.deepEqual(uris, ['spotify:track:ok']);
  assert.ok(logs.some((l) => l.includes('Throws')));
});
```
with:
```js
await asyncTest('buildArtistLinks resolves each entry to a url and skips an unresolvable artist without failing the run', async () => {
  const entries = [
    { act: 'Counting Crows', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl' },
    { act: 'Nobody Findable', kind: 'music', date: '2026-08-15', venue: 'The Echo' },
  ];
  const client = fakeArtistSearchClient({ urlByArtist: { 'Counting Crows': 'https://open.spotify.com/artist/cc' } });
  const logs = [];
  const linked = await buildArtistLinks('token', entries, { spotifyClient: client, log: (m) => logs.push(m) });
  assert.deepEqual(linked, [
    { act: 'Counting Crows', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl', url: 'https://open.spotify.com/artist/cc' },
  ]);
  assert.ok(logs.some((l) => l.includes('Nobody Findable')), 'the skipped artist should be logged');
});

await asyncTest('buildArtistLinks continues past a client that throws for one artist', async () => {
  const entries = [
    { act: 'Throws', kind: 'music', date: '2026-08-14', venue: 'The Echo' },
    { act: 'Fine Artist', kind: 'comedy', date: '2026-08-15', venue: 'Largo' },
  ];
  const client = async (token, pathSuffix, query) => {
    if (query.q === 'artist:"Throws"') throw new Error('simulated Spotify API failure');
    return { artists: { items: [{ external_urls: { spotify: 'https://open.spotify.com/artist/ok' } }] } };
  };
  const logs = [];
  const linked = await buildArtistLinks('token', entries, { spotifyClient: client, log: (m) => logs.push(m) });
  assert.deepEqual(linked, [
    { act: 'Fine Artist', kind: 'comedy', date: '2026-08-15', venue: 'Largo', url: 'https://open.spotify.com/artist/ok' },
  ]);
  assert.ok(logs.some((l) => l.includes('Throws')));
});

await asyncTest('buildArtistLinks on an empty entries array resolves to an empty array without calling the client', async () => {
  const linked = await buildArtistLinks('token', [], { spotifyClient: async () => { throw new Error('should not be called'); } });
  assert.deepEqual(linked, []);
});
```

- [ ] **Step 2: Run the test file to confirm the new tests fail**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: FAIL — `buildArtistLinks` is not defined.

- [ ] **Step 3: Add `buildArtistLinks` to `scripts/spotify-shows-telegram.mjs`**

Immediately after `resolveArtistPageUrl`, add:

```js
export async function buildArtistLinks(accessToken, entries, { spotifyClient = spotifyGet, log = () => {} } = {}) {
  const linked = [];
  for (const entry of entries) {
    try {
      const url = await resolveArtistPageUrl(accessToken, entry.act, { spotifyClient });
      if (!url) {
        log(`No Spotify artist match for "${entry.act}" — skipped.`);
        continue;
      }
      linked.push({ ...entry, url });
    } catch (err) {
      log(`Artist lookup failed for "${entry.act}" — skipped. (${err.message})`);
    }
  }
  return linked;
}
```

- [ ] **Step 4: Run the test file to confirm it passes**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: all `buildArtistLinks` tests print `ok -`.

- [ ] **Step 5: Commit**

```bash
git add scripts/spotify-shows-telegram.mjs data/test-spotify-shows-telegram.mjs
git commit -m "Add buildArtistLinks: resolve every qualifying entry to a url, skip failures."
```

---

### Task 5: `formatShowDate` and `formatMessage` — the Telegram message text

**Files:**
- Modify: `scripts/spotify-shows-telegram.mjs`
- Test: `data/test-spotify-shows-telegram.mjs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `formatShowDate(isoDate: string): string` (e.g. `"2026-08-14"` → `"Aug 14"`) and `formatMessage(entries: Array<{act, kind, date, venue, url}>): string`. Task 6's `runOnce` calls `formatMessage` on `buildArtistLinks`'s output to get the text it sends.

- [ ] **Step 1: Write the failing tests**

Add these tests to `data/test-spotify-shows-telegram.mjs`, after the `buildArtistLinks` tests from Task 4:

```js
test('formatShowDate turns an ISO date-only string into "Mon D"', () => {
  assert.equal(formatShowDate('2026-08-14'), 'Aug 14');
  assert.equal(formatShowDate('2026-01-05'), 'Jan 5');
  assert.equal(formatShowDate('2026-12-31'), 'Dec 31');
});

test('formatMessage sorts entries soonest-first regardless of input order', () => {
  const entries = [
    { act: 'Later Artist', kind: 'music', date: '2026-08-24', venue: 'The Echo', url: 'https://open.spotify.com/artist/later' },
    { act: 'Sooner Artist', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl', url: 'https://open.spotify.com/artist/sooner' },
  ];
  const text = formatMessage(entries);
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith('🎵 Sooner Artist'), `expected Sooner Artist first, got: ${lines[0]}`);
  assert.ok(lines[1].startsWith('🎵 Later Artist'), `expected Later Artist second, got: ${lines[1]}`);
});

test('formatMessage uses the music note for music and the mic for comedy', () => {
  const entries = [
    { act: 'Counting Crows', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl', url: 'https://open.spotify.com/artist/cc' },
    { act: 'Anthony Jeselnik', kind: 'comedy', date: '2026-08-16', venue: 'Largo', url: 'https://open.spotify.com/artist/aj' },
  ];
  const text = formatMessage(entries);
  assert.equal(
    text,
    '🎵 Counting Crows — Aug 14 @ Hollywood Bowl: https://open.spotify.com/artist/cc\n'
    + '🎤 Anthony Jeselnik — Aug 16 @ Largo: https://open.spotify.com/artist/aj',
  );
});

test('formatMessage falls back to "TBD" when an entry has no venue', () => {
  const entries = [{ act: 'No Venue Artist', kind: 'music', date: '2026-08-14', venue: undefined, url: 'https://open.spotify.com/artist/nv' }];
  assert.equal(formatMessage(entries), '🎵 No Venue Artist — Aug 14 @ TBD: https://open.spotify.com/artist/nv');
});

test('formatMessage on an empty array returns an empty string', () => {
  assert.equal(formatMessage([]), '');
});
```

Also add `formatShowDate, formatMessage` to the existing import line at the top of the file:
```js
import { filterQualifyingShows, resolveArtistTracks, buildTrackList, ensurePlaylist, replacePlaylistTracks, runPlaylistUpdate, resolveArtistPageUrl, buildArtistLinks, formatShowDate, formatMessage } from '../scripts/spotify-shows-telegram.mjs';
```

- [ ] **Step 2: Run the test file to confirm the new tests fail**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: FAIL — `formatShowDate`/`formatMessage` are not exported yet.

- [ ] **Step 3: Add `formatShowDate` and `formatMessage` to `scripts/spotify-shows-telegram.mjs`**

Immediately after `buildArtistLinks`, add:

```js
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Formats a "YYYY-MM-DD" date-only string straight from its parts, not
// through a Date object. A Date built from a bare date string is UTC
// midnight; formatting it back out with a local-timezone method
// (toLocaleDateString) can roll the displayed day back by one anywhere west
// of UTC (e.g. Pacific). Splitting the string sidesteps that entirely.
export function formatShowDate(isoDate) {
  const [, month, day] = String(isoDate || '').split('-').map(Number);
  if (!month || !day) return isoDate || '';
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

const KIND_EMOJI = { music: '🎵', comedy: '🎤' };

// Sorted soonest-first; a plain string sort is safe here because every date
// is "YYYY-MM-DD" and lexicographic order matches chronological order for
// that format.
export function formatMessage(entries) {
  const sorted = [...entries].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return sorted
    .map((e) => `${KIND_EMOJI[e.kind] || '🎵'} ${e.act} — ${formatShowDate(e.date)} @ ${e.venue || 'TBD'}: ${e.url}`)
    .join('\n');
}
```

- [ ] **Step 4: Run the test file to confirm it passes**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: all `formatShowDate`/`formatMessage` tests print `ok -`.

- [ ] **Step 5: Commit**

```bash
git add scripts/spotify-shows-telegram.mjs data/test-spotify-shows-telegram.mjs
git commit -m "Add formatShowDate/formatMessage: the Telegram message text, sorted soonest-first."
```

---

### Task 6: Delete the playlist orchestration; add `runOnce`/`main` for the Telegram send

**Files:**
- Modify: `scripts/spotify-shows-telegram.mjs`
- Modify: `data/test-spotify-shows-telegram.mjs`

**Interfaces:**
- Consumes: `filterQualifyingShows`, `buildArtistLinks`, `formatMessage` (all above), `getValidAccessToken` from `spotify-client.mjs`, `telegramEnvPath` from `longterm-paths.mjs`.
- Produces: `runOnce(opts): Promise<{sent: boolean, reason?: string, text?: string, entryCount?: number}>` — the single function `main()` calls, and what the weekly-pull wiring (Task 8) invokes indirectly via the CLI.
- Removes entirely (no longer exported, no longer defined): `resolveArtistTracks`, `buildTrackList`, `ensurePlaylist`, `replacePlaylistTracks`, `runPlaylistUpdate`, `defaultStatePath`, the `PLAYLIST_NAME`/`PLAYLIST_DESCRIPTION` constants, `loadState`/`saveState`.

This is the largest task in the plan — it deletes the old orchestration and its tests in one step and adds the new orchestration and its tests in the next, rather than interleaving, since the two are mutually exclusive (nothing new can coexist with the old `main()`).

- [ ] **Step 1: Delete the old orchestration's tests**

In `data/test-spotify-shows-telegram.mjs`, delete every test from `tmpStatePath` through the end of the file (i.e. everything after the `buildArtistLinks`/`formatMessage` tests added in Tasks 4–5): `tmpStatePath`, the two `ensurePlaylist` tests, the two `replacePlaylistTracks` tests, `tmpMatchDataPath`, `realisticShows`, and the three `runPlaylistUpdate` tests, through the final `console.log('All spotify-playlist-shows tests passed.');` line. Also delete the now-orphaned `resolveArtistTracks`/`buildTrackList` tests and the `fakeSpotifyClient` helper from Task 3's own deletion if any remnant remains (Task 3 already replaced the two `resolveArtistTracks` tests and swapped `fakeSpotifyClient` for `fakeArtistSearchClient` — confirm no reference to the old track-search fixtures remains).

Update the import line to drop the now-gone names:
```js
import { filterQualifyingShows, resolveArtistPageUrl, buildArtistLinks, formatShowDate, formatMessage } from '../scripts/spotify-shows-telegram.mjs';
```

- [ ] **Step 2: Write the new orchestration tests, replacing the deleted section**

Append to the end of `data/test-spotify-shows-telegram.mjs` (replacing what Step 1 removed):

```js
function tmpMatchDataPath(shows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-shows-telegram-'));
  const p = path.join(dir, 'show-matches-latest.json');
  fs.writeFileSync(p, JSON.stringify({ shows }));
  return p;
}

function realisticShows() {
  return [
    show({ act: 'Counting Crows', basis: 'like', date: '2026-08-14', venue: 'Hollywood Bowl' }),
    show({ act: 'Anthony Jeselnik', kind: 'comedy', basis: 'comedy', date: '2026-08-16', venue: 'Largo' }),
    show({ act: 'LLM Guess Artist', basis: 'claude' }),
  ];
}

await asyncTest('runOnce with no qualifying shows sends nothing and calls neither client', async () => {
  const matchDataPath = tmpMatchDataPath([show({ act: 'LLM Guess Only', basis: 'claude' })]);
  const result = await runOnce({
    matchDataPath, accessToken: 'token',
    spotifyClient: async () => { throw new Error('should not be called'); },
    telegramClient: async () => { throw new Error('should not be called'); },
  });
  assert.deepEqual(result, { sent: false, reason: 'no_qualifying_shows' });
});

await asyncTest('runOnce where every artist fails to resolve sends nothing', async () => {
  const matchDataPath = tmpMatchDataPath([show({ act: 'Nobody Findable', basis: 'like' })]);
  const telegramCalls = [];
  const result = await runOnce({
    matchDataPath, accessToken: 'token',
    spotifyClient: async () => ({ artists: { items: [] } }),
    telegramClient: async (...args) => { telegramCalls.push(args); },
    log: () => {},
  });
  assert.deepEqual(result, { sent: false, reason: 'no_artist_matches' });
  assert.equal(telegramCalls.length, 0);
});

await asyncTest('runOnce --dry-run composes the message but never calls the Telegram client', async () => {
  const matchDataPath = tmpMatchDataPath(realisticShows());
  const client = fakeArtistSearchClient({
    urlByArtist: { 'Counting Crows': 'https://open.spotify.com/artist/cc', 'Anthony Jeselnik': 'https://open.spotify.com/artist/aj' },
  });
  const result = await runOnce({
    matchDataPath, accessToken: 'token', dryRun: true,
    spotifyClient: client,
    telegramClient: async () => { throw new Error('dry-run must never call the Telegram client'); },
    log: () => {},
  });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'dry_run');
  assert.equal(
    result.text,
    '🎵 Counting Crows — Aug 14 @ Hollywood Bowl: https://open.spotify.com/artist/cc\n'
    + '🎤 Anthony Jeselnik — Aug 16 @ Largo: https://open.spotify.com/artist/aj',
  );
});

await asyncTest('runOnce sends the composed message via the injected Telegram client, bypassing the env file when token/groupChatId are passed directly', async () => {
  const matchDataPath = tmpMatchDataPath(realisticShows());
  const client = fakeArtistSearchClient({
    urlByArtist: { 'Counting Crows': 'https://open.spotify.com/artist/cc', 'Anthony Jeselnik': 'https://open.spotify.com/artist/aj' },
  });
  const telegramCalls = [];
  const result = await runOnce({
    matchDataPath, accessToken: 'token',
    token: 'fake-bot-token', groupChatId: 'fake-chat-id',
    spotifyClient: client,
    telegramClient: async (token, method, body) => { telegramCalls.push({ token, method, body }); return { ok: true }; },
    log: () => {},
  });
  assert.equal(result.sent, true);
  assert.equal(result.entryCount, 2);
  assert.equal(telegramCalls.length, 1);
  assert.equal(telegramCalls[0].token, 'fake-bot-token');
  assert.equal(telegramCalls[0].method, 'sendMessage');
  assert.equal(telegramCalls[0].body.chat_id, 'fake-chat-id');
  assert.equal(telegramCalls[0].body.text, result.text);
});

console.log('All spotify-shows-telegram tests passed.');
```

- [ ] **Step 3: Run the test file to confirm it fails**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: FAIL — `runOnce` is not defined, and the old `main()`/playlist code at the bottom of `scripts/spotify-shows-telegram.mjs` still references the now-deleted `defaultStatePath` etc. from the test file's dropped import (a `SyntaxError`/import error is an acceptable form of "fails" here too).

- [ ] **Step 4: Rewrite the bottom half of `scripts/spotify-shows-telegram.mjs`**

Delete everything from `const PLAYLIST_NAME = ...` through the end of the file (i.e. `PLAYLIST_NAME`, `PLAYLIST_DESCRIPTION`, `loadState`, `saveState`, `ensurePlaylist`, `replacePlaylistTracks`, `runPlaylistUpdate`, the old `main()`, and the old `defaultStatePath` export near the top — remove that too, it has no remaining caller). Also delete the now-unused `resolveArtistTracks`/`buildTrackList` functions (Task 3/4 left them in place; this is where they're actually removed) and the `path`-unrelated unused imports if any remain.

The full file should now read:

```js
#!/usr/bin/env node
// Resolves this week's taste-matched upcoming LA shows (music + comedy) to
// Spotify artist-page links and sends one Telegram message, one line per
// artist. Supersedes the auto-playlist approach — see
// docs/superpowers/specs/2026-08-08-spotify-shows-telegram-design.md for why:
// Spotify permanently blocked playlist-write access for this app's
// Development Mode registration (POST /users/{id}/playlists returned 403
// even with playlist-modify-private freshly granted; Extended Quota Mode,
// the only fix, requires a registered org with 250k+ MAU). An artist-*page*
// link needs no such scope — GET /search is, and always was, unrestricted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getValidAccessToken, spotifyGet } from './spotify-client.mjs';
import { normalizeArtistName } from './spotify-pull.mjs';
import { telegramEnvPath } from './longterm-paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export function defaultMatchDataPath() {
  return path.join(repoRoot, 'data', 'spotify', 'show-matches-latest.json');
}

// Only shows backed by a genuine signal count as "recommended" —
// basis: 'claude' is an LLM guess, not a real taste signal (see the design
// doc). Comedy is included as of the Telegram redesign: an artist-*page*
// link (unlike a track) has no music-catalog requirement, and comedy's own
// basis is literally the string 'comedy' (from comedyTaste matching, not an
// LLM guess), so it already passes this same basis !== 'claude' check
// without a comedy-specific branch.
export function filterQualifyingShows(matchData) {
  const shows = matchData?.shows || [];
  const seen = new Set();
  const entries = [];
  for (const s of shows) {
    if (s.kind !== 'music' && s.kind !== 'comedy') continue;
    const kevinScore = s.scores?.kevin;
    if (!kevinScore || kevinScore.basis === 'claude') continue;
    // Trimmed first: normalizeArtistName's leading-"the"-strip is anchored to
    // the very start of the string, so untrimmed leading whitespace would
    // silently defeat it and produce a different dedup key for an otherwise
    // identical artist name.
    const key = normalizeArtistName(String(s.act || '').trim());
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ act: s.act, kind: s.kind, date: s.date, venue: s.venue });
  }
  return entries;
}

// Resolves an artist to their Spotify artist-*page* URL (GET /search?type=
// artist), not a track — this needs no scope beyond what was already
// granted, and never needs /artists/{id}/top-tracks (403'd, see below).
// MUST use the artist:"<name>" field-filter form: a bare-name query
// (`q: artistName`, no filter) was verified live to be unreliable — one test
// returned "Bill Burr" for "Anthony Jeselnik" — while the field-filter form
// was retested and correct twice. Comedians with released specials have real
// Spotify artist pages (verified live: Jeselnik, Patton Oswalt, Tig Notaro,
// Pete Holmes all resolve), so this works for both kinds this script handles.
export async function resolveArtistPageUrl(accessToken, artistName, { spotifyClient = spotifyGet } = {}) {
  const result = await spotifyClient(accessToken, 'search', { q: `artist:"${artistName}"`, type: 'artist', limit: 1 });
  const top = result?.artists?.items?.[0];
  return top?.external_urls?.spotify || null;
}

export async function buildArtistLinks(accessToken, entries, { spotifyClient = spotifyGet, log = () => {} } = {}) {
  const linked = [];
  for (const entry of entries) {
    try {
      const url = await resolveArtistPageUrl(accessToken, entry.act, { spotifyClient });
      if (!url) {
        log(`No Spotify artist match for "${entry.act}" — skipped.`);
        continue;
      }
      linked.push({ ...entry, url });
    } catch (err) {
      log(`Artist lookup failed for "${entry.act}" — skipped. (${err.message})`);
    }
  }
  return linked;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Formats a "YYYY-MM-DD" date-only string straight from its parts, not
// through a Date object. A Date built from a bare date string is UTC
// midnight; formatting it back out with a local-timezone method
// (toLocaleDateString) can roll the displayed day back by one anywhere west
// of UTC (e.g. Pacific). Splitting the string sidesteps that entirely.
export function formatShowDate(isoDate) {
  const [, month, day] = String(isoDate || '').split('-').map(Number);
  if (!month || !day) return isoDate || '';
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

const KIND_EMOJI = { music: '🎵', comedy: '🎤' };

// Sorted soonest-first; a plain string sort is safe here because every date
// is "YYYY-MM-DD" and lexicographic order matches chronological order for
// that format.
export function formatMessage(entries) {
  const sorted = [...entries].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return sorted
    .map((e) => `${KIND_EMOJI[e.kind] || '🎵'} ${e.act} — ${formatShowDate(e.date)} @ ${e.venue || 'TBD'}: ${e.url}`)
    .join('\n');
}

function readLocalEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) throw new Error(`Missing env file: ${filePath}`);
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return values;
}

async function callTelegram(token, method, body) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(`Telegram ${method} rejected: ${JSON.stringify(json)}`);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

function parseArgs(argv) {
  const args = {
    envPath: telegramEnvPath(),
    matchDataPath: defaultMatchDataPath(),
    ownerId: 'kevin',
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      i += 1;
      if (key === 'env-path') args.envPath = value;
      else if (key === 'match-data-path') args.matchDataPath = value;
      else if (key === 'owner') args.ownerId = value;
      else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function runOnce(opts) {
  const args = { ...parseArgs([]), ...opts };
  const log = args.log || (() => {});

  const matchData = JSON.parse(fs.readFileSync(args.matchDataPath, 'utf8'));
  const qualifying = filterQualifyingShows(matchData);
  if (!qualifying.length) return { sent: false, reason: 'no_qualifying_shows' };

  const accessToken = args.accessToken || (await getValidAccessToken(args.ownerId));
  const linked = await buildArtistLinks(accessToken, qualifying, { spotifyClient: args.spotifyClient, log });
  if (!linked.length) return { sent: false, reason: 'no_artist_matches' };

  const text = formatMessage(linked);

  if (args.dryRun) return { sent: false, reason: 'dry_run', text, entryCount: linked.length };

  const envValues = args.token && args.groupChatId ? {} : readLocalEnv(args.envPath);
  const token = args.token || envValues.TELEGRAM_BOT_TOKEN;
  const groupChatId = args.groupChatId || envValues.TELEGRAM_GROUP_CHAT_ID;
  const telegramClient = args.telegramClient || callTelegram;
  await telegramClient(token, 'sendMessage', { chat_id: groupChatId, text });

  return { sent: true, text, entryCount: linked.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOnce(args);
  console.log(JSON.stringify({ ok: true, sent: result.sent, reason: result.reason || null, entryCount: result.entryCount || 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
```

Note this drops the `defaultMatchDataPath`-adjacent `defaultStatePath` export and the `spotifyPost`/`spotifyPut` imports entirely (this script never writes anything to Spotify anymore).

- [ ] **Step 5: Run the full test file to confirm everything passes**

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: every test prints `ok -`, ending with `All spotify-shows-telegram tests passed.`

- [ ] **Step 6: Confirm no dry-run path ever touches the env file**

Run (from repo root, using a nonexistent env path to prove dry-run truly never reads it):
```bash
node -e "
import('./scripts/spotify-shows-telegram.mjs').then(async (m) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shows-tg-'));
  const matchDataPath = path.join(dir, 'show-matches-latest.json');
  fs.writeFileSync(matchDataPath, JSON.stringify({ shows: [{ act: 'Counting Crows', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl', scores: { kevin: { basis: 'like' } } }] }));
  const result = await m.runOnce({
    matchDataPath, dryRun: true, accessToken: 'token', envPath: path.join(dir, 'does-not-exist.env'),
    spotifyClient: async () => ({ artists: { items: [{ external_urls: { spotify: 'https://open.spotify.com/artist/cc' } }] } }),
  });
  console.log(JSON.stringify(result, null, 2));
});
"
```
Expected: prints `{"sent": false, "reason": "dry_run", "text": "🎵 Counting Crows — Aug 14 @ Hollywood Bowl: https://open.spotify.com/artist/cc", "entryCount": 1}` with no error about a missing env file — proving `--dry-run` short-circuits before `readLocalEnv` is ever called.

- [ ] **Step 7: Commit**

```bash
git add scripts/spotify-shows-telegram.mjs data/test-spotify-shows-telegram.mjs
git commit -m "Delete playlist orchestration; add runOnce/main sending one Telegram message."
```

---

### Task 7: Remove the now-dead `playlist-modify-private` scope

**Files:**
- Modify: `scripts/spotify-client.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `SPOTIFY_SCOPES` (unchanged export name, changed value). No test exercises this constant directly (matching the original plan's own note that the raw scope string has no dedicated test) — verified by a load check instead.

- [ ] **Step 1: Remove the scope**

In `scripts/spotify-client.mjs`, change:
```js
/** Intentional-taste scopes only — see the design spec for why recently-played/top-artists are excluded. */
export const SPOTIFY_SCOPES = 'user-follow-read user-library-read playlist-read-private playlist-read-collaborative playlist-modify-private';
```
to:
```js
/** Intentional-taste scopes only — see the design spec for why recently-played/top-artists are excluded. playlist-modify-private was added and removed in the same week (2026-08-07 → 2026-08-08): Spotify's Development Mode policy permanently blocks playlist writes for this app tier, confirmed live, so the scope can never be exercised — see docs/superpowers/specs/2026-08-08-spotify-shows-telegram-design.md. */
export const SPOTIFY_SCOPES = 'user-follow-read user-library-read playlist-read-private playlist-read-collaborative';
```

- [ ] **Step 2: Verify the file still loads cleanly and no test depends on the old scope string**

Run: `node -e "import('./scripts/spotify-client.mjs').then(m => console.log(m.SPOTIFY_SCOPES))"`
Expected: prints `user-follow-read user-library-read playlist-read-private playlist-read-collaborative` (no `playlist-modify-private`), no error.

Run: `node data/test-spotify-shows-telegram.mjs`
Expected: still `All spotify-shows-telegram tests passed.` (this file never asserted on `SPOTIFY_SCOPES`).

- [ ] **Step 3: Commit**

```bash
git add scripts/spotify-client.mjs
git commit -m "Remove the playlist-modify-private scope — Spotify blocks it forever, never exercised."
```

---

### Task 8: Wire the weekly pull's 4th step to the new script

**Files:**
- Modify: `scripts/run-weekly-shows-pull.ps1`
- Modify: `package.json`

**Interfaces:**
- Consumes: `npm run spotify:notify-shows` (this task defines it).
- Produces: the weekly pull's 4th, isolated step. Nothing downstream consumes this beyond the scheduled task already pointed at `run-weekly-shows-pull.ps1`.

- [ ] **Step 1: Rename the npm script in `package.json`**

Change:
```json
    "spotify:update-show-playlist": "node scripts/spotify-playlist-shows.mjs",
```
to:
```json
    "spotify:notify-shows": "node scripts/spotify-shows-telegram.mjs",
```

- [ ] **Step 2: Update `scripts/run-weekly-shows-pull.ps1`**

Change the `param()` block:
```powershell
param(
    [switch]$SkipFindShows,
    [switch]$SkipVenuePull,
    [switch]$SkipMatch,
    [switch]$SkipPlaylist
)
```
to:
```powershell
param(
    [switch]$SkipFindShows,
    [switch]$SkipVenuePull,
    [switch]$SkipMatch,
    [switch]$SkipShowNotify
)
```

Change the 4th step:
```powershell
    # Isolated from the three steps above, same containment rule
    # run-daily-pull.ps1 already uses for its own Oura step: the playlist is a
    # nice-to-have that must never mark the whole weekly pull as failed. It's
    # also expected to fail loudly on its own until the playlist-modify-private
    # scope is granted (see claude.md) — that failure belongs to this step
    # alone, not to spotify:find-shows/shows:pull/spotify:match, which the
    # dashboard already depends on and which succeed independently of it.
    if (-not $SkipPlaylist) {
        try {
            Invoke-NpmScript 'spotify:update-show-playlist'
        } catch {
            Write-ShowsLog ('WARN spotify:update-show-playlist failed (continuing): {0}' -f $_.Exception.Message)
        }
    }
```
to:
```powershell
    # Isolated from the three steps above, same containment rule
    # run-daily-pull.ps1 already uses for its own Oura step: resolving
    # artists to Spotify links and sending the Telegram message is a
    # nice-to-have that must never mark the whole weekly pull as failed —
    # that failure belongs to this step alone, not to
    # spotify:find-shows/shows:pull/spotify:match, which the dashboard
    # already depends on and which succeed independently of it. (This step
    # replaced the auto-playlist step on 2026-08-08 — see claude.md and
    # docs/superpowers/specs/2026-08-08-spotify-shows-telegram-design.md.)
    if (-not $SkipShowNotify) {
        try {
            Invoke-NpmScript 'spotify:notify-shows'
        } catch {
            Write-ShowsLog ('WARN spotify:notify-shows failed (continuing): {0}' -f $_.Exception.Message)
        }
    }
```

- [ ] **Step 3: Verify the script still parses**

Run: `powershell -NoProfile -Command "$null = Get-Command -Syntax { & './scripts/run-weekly-shows-pull.ps1' -SkipFindShows -SkipVenuePull -SkipMatch -SkipShowNotify }; (Get-Content ./scripts/run-weekly-shows-pull.ps1 -Raw) | Out-Null; Write-Host 'parsed ok'"`

(A simpler and equally sufficient check, since this environment runs PowerShell as the primary shell: just parse the file for syntax errors.)
Run: `powershell -NoProfile -Command "$errors = $null; [System.Management.Automation.PSParser]::Tokenize((Get-Content ./scripts/run-weekly-shows-pull.ps1 -Raw), [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors } else { Write-Host 'no syntax errors' }"`
Expected: `no syntax errors`.

- [ ] **Step 4: Commit**

```bash
git add package.json scripts/run-weekly-shows-pull.ps1
git commit -m "Wire the weekly pull's 4th step to spotify:notify-shows, replacing the playlist step."
```

---

### Task 9: Update `claude.md`'s documentation of this feature

**Files:**
- Modify: `claude.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Update the weekly-scheduled-task line and the feature description**

Change:
```
- `data/upcoming_shows_cache.json` / Spotify match artifacts — refreshed on a **weekly** scheduled task (`LongtermWeeklyShowsPull`, Sunday 10:00 by default via `install-weekly-shows-scheduled-task.ps1` → `run-weekly-shows-pull.ps1`: `spotify:find-shows` → `shows:pull` → `spotify:match` → `spotify:update-show-playlist`). Log: `~/.longterm/logs/weekly-shows.log`. Manual: `npm run shows:weekly`. The Telegram bot's on-demand `get_upcoming_shows` can still refresh mid-week.
- `scripts/spotify-playlist-shows.mjs` — rebuilds a private Spotify playlist under Kevin's account every week (`npm run spotify:update-show-playlist`, the 4th step above) from `show-matches-latest.json`'s genuinely taste-matched music shows (`scores.kevin.basis !== 'claude'` — excludes LLM-guessed recommendations, keeping only shows backed by a real like/follow/playlist signal). Replaces the entire tracklist every run (`PUT /playlists/{id}/tracks`), so a show that's passed or dropped off the list disappears automatically rather than accumulating forever. Track resolution is a direct catalog track search (`artist:"<name>"`), not `/artists/{id}/top-tracks` — that endpoint returns `403 Forbidden` on this app's Spotify registration (confirmed live 2026-08-07), the same class of app-tier restriction already noted for related-artists/recommendations. **Requires the `playlist-modify-private` scope**, added 2026-08-07 — existing Spotify tokens on this machine predate it, so `npm run spotify:auth -- --owner kevin` must be re-run once to re-consent before this step can succeed; until then it fails loudly by design, isolated in its own try/catch in `run-weekly-shows-pull.ps1` (same containment rule `run-daily-pull.ps1` already uses for its own optional Oura step) so the other three steps — which the dashboard already depends on — are never marked failed because of it.
```
to:
```
- `data/upcoming_shows_cache.json` / Spotify match artifacts — refreshed on a **weekly** scheduled task (`LongtermWeeklyShowsPull`, Sunday 10:00 by default via `install-weekly-shows-scheduled-task.ps1` → `run-weekly-shows-pull.ps1`: `spotify:find-shows` → `shows:pull` → `spotify:match` → `spotify:notify-shows`). Log: `~/.longterm/logs/weekly-shows.log`. Manual: `npm run shows:weekly`. The Telegram bot's on-demand `get_upcoming_shows` can still refresh mid-week.
- `scripts/spotify-shows-telegram.mjs` — sends one Telegram message every week (`npm run spotify:notify-shows`, the 4th step above), one line per taste-matched upcoming LA show — music **and comedy** — from `show-matches-latest.json` (`scores.kevin.basis !== 'claude'` — excludes LLM-guessed recommendations; comedy's own basis is literally `'comedy'`, a real signal from `comedyTaste` matching, so it passes the same filter unmodified). Each artist resolves to their Spotify **artist-page** URL via `GET /search?type=artist&q=artist:"<name>"` (the field-filter form — a bare-name query was verified live to be unreliable), sorted soonest-first, `🎵` for music / `🎤` for comedy. Supersedes an auto-playlist approach (`spotify-playlist-shows.mjs`, briefly live 2026-08-07–08): Spotify permanently blocked playlist-write access for this app's Development Mode registration (`POST /users/{id}/playlists` returned `403` even with `playlist-modify-private` freshly granted; the fix, Extended Quota Mode, requires a registered org with 250k+ MAU — not available to a personal household app). An artist-page link needs no such scope; `GET /search` was never restricted. A resolution failure for one artist is logged and skipped, never fatal to the week's message — same containment rule the weekly pull's own isolated try/catch already gives this step (`run-daily-pull.ps1`'s Oura step is the original precedent) so the other three steps, which the dashboard already depends on, are never marked failed because of it. See `docs/superpowers/specs/2026-08-08-spotify-shows-telegram-design.md`.
```

- [ ] **Step 2: Commit**

```bash
git add claude.md
git commit -m "Update claude.md's docs for spotify:notify-shows, replacing the playlist description."
```

---

### Task 10: Full suite run, verification, and merge to master

**Files:** none (verification + git operations only).

- [ ] **Step 1: Run every test file except anything with "harness" in the name**

Run each of (this is every `data/test-*.mjs` file in the repo as of this plan):
```bash
node data/test-budget-tracking-pull.mjs
node data/test-calendar-read.mjs
node data/test-calendar-sync.mjs
node data/test-dashboard-contract.mjs
node data/test-dashboard-server.mjs
node data/test-dining-recommendation.mjs
node data/test-health-context.mjs
node data/test-oura-pull.mjs
node data/test-oura-store.mjs
node data/test-spotify-shows-telegram.mjs
node data/test-telegram-bot.mjs
node data/test-telegram-poll-loop.mjs
node data/test-telegram-recap.mjs
node data/test-telegram-reminders.mjs
```
Expected: every file prints its `All ... tests passed.` (or equivalent) line and exits 0, **except** `data/test-dashboard-contract.mjs`, which is a pre-existing, already-diagnosed failure in a freshly-seeded worktree (the example fixture data lacks fields a dashboard chart needs; it passes against the real `data/goals.json` in the main checkout) — not something this plan's work touches or is responsible for fixing. Confirm the file list matches what's actually present with `ls data/test-*.mjs | grep -v harness` in case a file was added/removed since this plan was written.

- [ ] **Step 2: Run the secrets check**

Run: `npm run check:secrets`
Expected: passes — nothing in this plan touches any real household data file.

- [ ] **Step 3: Confirm nothing still references the deleted playlist code**

Run: `grep -rn "spotify-playlist-shows\|update-show-playlist\|ensurePlaylist\|replacePlaylistTracks\|show-playlist-state\|SkipPlaylist" scripts/ package.json claude.md data/test-spotify-shows-telegram.mjs 2>/dev/null`
Expected: no matches (the only remaining references anywhere in the repo should be inside the two historical/superseded docs, `docs/superpowers/plans/2026-08-07-spotify-shows-playlist.md` and `docs/superpowers/specs/2026-08-07-spotify-shows-playlist-design.md`, which are intentionally left as a historical record and out of scope for this plan).

- [ ] **Step 4: Hand off to superpowers:finishing-a-development-branch**

Use the `superpowers:finishing-a-development-branch` skill to verify tests one more time and merge this work locally into `master` (no push to any remote — local-only merge is this project's current convention), then clean up the worktree/branch per that skill's own process.
