# Spotify Shows Playlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A private Spotify playlist under Kevin's account, rebuilt every week from `show-matches-latest.json`'s genuinely taste-matched upcoming LA music shows, wired into the existing weekly shows pull.

**Architecture:** A new `scripts/spotify-playlist-shows.mjs` reads the already-fresh match data, filters to real-signal music recommendations, deduplicates artists, resolves each to top Spotify tracks, and replaces one persistent playlist's entire tracklist in a single call. Two small additions to `spotify-client.mjs` (`spotifyPost`/`spotifyPut`, alongside the existing `spotifyGet`) are the only changes to shared code. Every Spotify call is injectable — no real network calls in tests.

**Tech Stack:** Node.js ESM (`.mjs`), hand-rolled `assert/strict` test runners (no test framework) — matching every other script in this session's work, though this repo's *existing* Spotify scripts (Cursor's) don't yet follow this pattern; this plan introduces it for the new script without retrofitting the others.

**Design doc:** `docs/superpowers/specs/2026-08-07-spotify-shows-playlist-design.md` — read this first for the "why" (the `basis !== 'claude'` filter reasoning, why replace-entirely over accumulate, why Kevin's account only).

## Global Constraints

- **A new OAuth scope (`playlist-modify-private`) is required and does not exist on this machine yet.** Kevin must re-run `npm run spotify:auth -- --owner kevin` to re-consent before the playlist-write path can run for real, against real infrastructure. This plan ships and tests the code; it cannot live-verify the actual playlist create/replace calls, since doing so would require write-scope credentials that don't exist until that manual step happens. Task 6 states this explicitly as a rollout prerequisite, not something any task here can complete.
- Every Spotify API call goes through an injectable client parameter — no test may make a real network call.
- A missing/expired write-scope token fails loudly (must stop the run); any single artist's search/top-tracks lookup failing is logged and skipped, never fatal.
- `data/spotify/*` is already gitignored except `sample-shows.json` — the new `show-playlist-state.json` needs no `.gitignore` change.
- Follow this codebase's established DI pattern exactly: `someClient = args.someClient || defaultRealImpl`, matching `oura-pull.mjs`/`telegram-bot-recap.mjs` from earlier in this session.

---

### Task 1: `spotifyPost`/`spotifyPut` helpers and the new scope

**Files:**
- Modify: `scripts/spotify-client.mjs`

**Interfaces:**
- Consumes: nothing new — mirrors the existing `spotifyGet(accessToken, pathSuffix, query)`.
- Produces: `spotifyPost(accessToken, pathSuffix, body)` and `spotifyPut(accessToken, pathSuffix, body)`, both returning parsed JSON (or `null` for a body-less 2xx response, since `PUT /playlists/{id}/tracks` returns `{snapshot_id}` but some Spotify write endpoints return 204 No Content) and throwing on a non-2xx response with `.status`/`.body` attached, exactly like `spotifyGet` does today. `SPOTIFY_SCOPES` gains `playlist-modify-private`.

No dedicated test for this task — consistent with this codebase's existing convention that the raw HTTP wrapper (`spotifyGet`, `ouraGet`) has no direct test; only its callers, via an injected stand-in, are tested. Task 2 onward is where real coverage starts.

- [ ] **Step 1: Add the two helpers**

In `scripts/spotify-client.mjs`, immediately after the existing `spotifyGet` function:

```js
async function spotifyWrite(method, accessToken, pathSuffix, body) {
  const res = await fetch(`${SPOTIFY_API_BASE}/${pathSuffix.replace(/^\//, '')}`, {
    method,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body || {}),
  });
  const text = await res.text();
  let parsed = null;
  if (text) {
    try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  }
  if (!res.ok) {
    const err = new Error(`Spotify ${method} ${pathSuffix} failed: ${res.status}`);
    err.status = res.status;
    err.body = parsed;
    throw err;
  }
  return parsed;
}

export async function spotifyPost(accessToken, pathSuffix, body) {
  return spotifyWrite('POST', accessToken, pathSuffix, body);
}

export async function spotifyPut(accessToken, pathSuffix, body) {
  return spotifyWrite('PUT', accessToken, pathSuffix, body);
}
```

- [ ] **Step 2: Add the new scope**

Change:
```js
export const SPOTIFY_SCOPES = 'user-follow-read user-library-read playlist-read-private playlist-read-collaborative';
```
to:
```js
export const SPOTIFY_SCOPES = 'user-follow-read user-library-read playlist-read-private playlist-read-collaborative playlist-modify-private';
```

- [ ] **Step 3: Verify the file still loads cleanly**

Run: `node -e "import('./scripts/spotify-client.mjs').then(m => console.log(Object.keys(m)))"`
Expected: prints a list including `spotifyGet`, `spotifyPost`, `spotifyPut`, `SPOTIFY_SCOPES`, with no error.

- [ ] **Step 4: Commit**

```bash
git add scripts/spotify-client.mjs
git commit -m "Add spotifyPost/spotifyPut helpers and the playlist-modify-private scope."
```

---

### Task 2: Filtering and deduplication — `filterQualifyingShows`

**Files:**
- Create: `scripts/spotify-playlist-shows.mjs`
- Modify: `scripts/spotify-pull.mjs:40` (export `normalizeArtistName`)
- Test: `data/test-spotify-playlist-shows.mjs`

**Interfaces:**
- Consumes: `normalizeArtistName(name): string`, exported from `spotify-pull.mjs` (already exists, just needs the `export` keyword — reused here rather than duplicated, so artist-name normalization can never drift between the two scripts).
- Produces: `filterQualifyingShows(matchData): string[]` — an array of **deduplicated, original-cased** artist names, ready for track resolution. Task 3 consumes this array directly.

- [ ] **Step 1: Export the shared normalizer**

In `scripts/spotify-pull.mjs`, change:
```js
function normalizeArtistName(name) {
```
to:
```js
export function normalizeArtistName(name) {
```

- [ ] **Step 2: Write the failing test**

Create `data/test-spotify-playlist-shows.mjs`:

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
import { filterQualifyingShows } from '../scripts/spotify-playlist-shows.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-spotify-playlist-shows.mjs');

function show({ act, kind = 'music', basis = 'like', score = 90 }) {
  return { act, kind, date: '2026-08-10', scores: { kevin: { basis, score, linked: true } } };
}

test('keeps only music shows with a real signal (basis !== claude)', () => {
  const shows = [
    show({ act: 'Counting Crows', basis: 'like' }),
    show({ act: 'JAŸ-Z', basis: 'follow' }),
    show({ act: 'Some Playlist Artist', basis: 'playlist' }),
    show({ act: 'LLM Guess Artist', basis: 'claude' }),
  ];
  assert.deepEqual(filterQualifyingShows({ shows }), ['Counting Crows', 'JAŸ-Z', 'Some Playlist Artist']);
});

test('excludes comedy shows even with a real signal', () => {
  const shows = [show({ act: 'Some Comedian', kind: 'comedy', basis: 'like' })];
  assert.deepEqual(filterQualifyingShows({ shows }), []);
});

test('deduplicates an artist appearing across multiple tour dates', () => {
  const shows = [
    show({ act: 'JAŸ-Z', basis: 'follow' }),
    { ...show({ act: 'JAŸ-Z', basis: 'follow' }), date: '2026-08-11' },
  ];
  assert.deepEqual(filterQualifyingShows({ shows }), ['JAŸ-Z']);
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

console.log('All spotify-playlist-shows tests passed.');
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node data/test-spotify-playlist-shows.mjs`
Expected: FAIL — `spotify-playlist-shows.mjs` does not exist yet.

- [ ] **Step 4: Implement `filterQualifyingShows`**

Create `scripts/spotify-playlist-shows.mjs`:

```js
#!/usr/bin/env node
// Rebuilds a private Spotify playlist (Kevin's account) from this week's
// taste-matched upcoming LA music shows — see
// docs/superpowers/specs/2026-08-07-spotify-shows-playlist-design.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getValidAccessToken, spotifyGet, spotifyPost, spotifyPut } from './spotify-client.mjs';
import { normalizeArtistName } from './spotify-pull.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export function defaultMatchDataPath() {
  return path.join(repoRoot, 'data', 'spotify', 'show-matches-latest.json');
}

export function defaultStatePath() {
  return path.join(repoRoot, 'data', 'spotify', 'show-playlist-state.json');
}

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
    const key = normalizeArtistName(s.act);
    if (seen.has(key)) continue;
    seen.add(key);
    artists.push(s.act);
  }
  return artists;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node data/test-spotify-playlist-shows.mjs`
Expected: PASS — all 7 cases print `ok - ...`.

- [ ] **Step 6: Commit**

```bash
npm run check:secrets
git add scripts/spotify-pull.mjs scripts/spotify-playlist-shows.mjs data/test-spotify-playlist-shows.mjs
git commit -m "Add filterQualifyingShows: real-signal-only music show filtering and dedup."
```

---

### Task 3: Track resolution — `resolveArtistTracks` / `buildTrackList`

**Files:**
- Modify: `scripts/spotify-playlist-shows.mjs`
- Test: `data/test-spotify-playlist-shows.mjs`

**Interfaces:**
- Consumes: Task 2's `filterQualifyingShows` output (an array of artist name strings).
- Produces: `resolveArtistTracks(accessToken, artistName, { spotifyClient = spotifyGet } = {}): Promise<string[]>` — up to 3 Spotify track URIs for that artist, or `[]` if no confident match. `buildTrackList(accessToken, artistNames, { spotifyClient, log = () => {} } = {}): Promise<string[]>` — the deduplicated, flattened URI list across all artists, skipping (and logging) any artist that fails to resolve. Task 4 consumes `buildTrackList`'s output directly as the tracklist to write.

- [ ] **Step 1: Write the failing tests**

Append to `data/test-spotify-playlist-shows.mjs`, before its final `console.log`:

```js
import { resolveArtistTracks, buildTrackList } from '../scripts/spotify-playlist-shows.mjs';

function fakeSpotifyClient({ searchResults = {}, topTracks = {} } = {}) {
  return async (token, pathSuffix, query) => {
    if (pathSuffix === 'search') {
      const name = query.q;
      const items = searchResults[name] ? [{ id: searchResults[name] }] : [];
      return { artists: { items } };
    }
    const match = pathSuffix.match(/^artists\/([^/]+)\/top-tracks$/);
    if (match) {
      const tracks = topTracks[match[1]] || [];
      return { tracks: tracks.map((uri) => ({ uri })) };
    }
    throw new Error(`Unexpected path in fakeSpotifyClient: ${pathSuffix}`);
  };
}

await asyncTest('resolves an artist to up to 3 top-track URIs', async () => {
  const client = fakeSpotifyClient({
    searchResults: { 'Counting Crows': 'artist-1' },
    topTracks: { 'artist-1': ['spotify:track:a', 'spotify:track:b', 'spotify:track:c', 'spotify:track:d'] },
  });
  const uris = await resolveArtistTracks('token', 'Counting Crows', { spotifyClient: client });
  assert.deepEqual(uris, ['spotify:track:a', 'spotify:track:b', 'spotify:track:c']);
});

await asyncTest('an artist with no search results resolves to an empty list, not a throw', async () => {
  const client = fakeSpotifyClient({});
  const uris = await resolveArtistTracks('token', 'Nobody Findable', { spotifyClient: client });
  assert.deepEqual(uris, []);
});

await asyncTest('buildTrackList flattens across artists and skips an unresolvable one without failing the run', async () => {
  const client = fakeSpotifyClient({
    searchResults: { 'Counting Crows': 'artist-1' },
    topTracks: { 'artist-1': ['spotify:track:a'] },
  });
  const logs = [];
  const uris = await buildTrackList('token', ['Counting Crows', 'Nobody Findable'], { spotifyClient: client, log: (m) => logs.push(m) });
  assert.deepEqual(uris, ['spotify:track:a']);
  assert.ok(logs.some((l) => l.includes('Nobody Findable')), 'the skipped artist should be logged');
});

await asyncTest('buildTrackList continues past a client that throws for one artist', async () => {
  const client = async (token, pathSuffix, query) => {
    if (pathSuffix === 'search' && query.q === 'Throws') throw new Error('simulated Spotify API failure');
    if (pathSuffix === 'search') return { artists: { items: [{ id: 'ok-artist' }] } };
    return { tracks: [{ uri: 'spotify:track:ok' }] };
  };
  const logs = [];
  const uris = await buildTrackList('token', ['Throws', 'Fine Artist'], { spotifyClient: client, log: (m) => logs.push(m) });
  assert.deepEqual(uris, ['spotify:track:ok']);
  assert.ok(logs.some((l) => l.includes('Throws')));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-spotify-playlist-shows.mjs`
Expected: FAIL — `resolveArtistTracks`/`buildTrackList` are not exported yet.

- [ ] **Step 3: Implement both functions**

Append to `scripts/spotify-playlist-shows.mjs`:

```js
export async function resolveArtistTracks(accessToken, artistName, { spotifyClient = spotifyGet } = {}) {
  const searchResult = await spotifyClient(accessToken, 'search', { q: artistName, type: 'artist', limit: 1 });
  const artistId = searchResult?.artists?.items?.[0]?.id;
  if (!artistId) return [];
  const topTracks = await spotifyClient(accessToken, `artists/${artistId}/top-tracks`, { market: 'US' });
  return (topTracks?.tracks || []).slice(0, 3).map((t) => t.uri);
}

export async function buildTrackList(accessToken, artistNames, { spotifyClient = spotifyGet, log = () => {} } = {}) {
  const uris = [];
  for (const name of artistNames) {
    try {
      const trackUris = await resolveArtistTracks(accessToken, name, { spotifyClient });
      if (!trackUris.length) {
        log(`No Spotify catalog match for "${name}" — skipped.`);
        continue;
      }
      uris.push(...trackUris);
    } catch (err) {
      log(`Track lookup failed for "${name}" — skipped. (${err.message})`);
    }
  }
  return [...new Set(uris)];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-spotify-playlist-shows.mjs`
Expected: PASS — all cases including Task 2's pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/spotify-playlist-shows.mjs data/test-spotify-playlist-shows.mjs
git commit -m "Add resolveArtistTracks/buildTrackList: artist-to-top-tracks resolution."
```

---

### Task 4: Playlist create-or-replace — `ensurePlaylist` / `replacePlaylistTracks`

**Files:**
- Modify: `scripts/spotify-playlist-shows.mjs`
- Test: `data/test-spotify-playlist-shows.mjs`

**Interfaces:**
- Consumes: Task 3's `buildTrackList` output (a URI array) as the tracklist to write.
- Produces: `ensurePlaylist(accessToken, { spotifyClient = spotifyGet, spotifyPostFn = spotifyPost, statePath = defaultStatePath() } = {}): Promise<{ playlistId, userId }>` — reads/creates the persistent state file. `replacePlaylistTracks(accessToken, playlistId, uris, { spotifyPutFn = spotifyPut } = {}): Promise<void>`. `runPlaylistUpdate({...})` (Task 5) composes these three (`ensurePlaylist`, `buildTrackList`, `replacePlaylistTracks`) plus the 404-recreate fallback.

- [ ] **Step 1: Write the failing tests**

Append to `data/test-spotify-playlist-shows.mjs`:

```js
import { ensurePlaylist, replacePlaylistTracks } from '../scripts/spotify-playlist-shows.mjs';

function tmpStatePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-playlist-state-'));
  return path.join(dir, 'show-playlist-state.json');
}

await asyncTest('ensurePlaylist creates a new private playlist on first run and saves its id', async () => {
  const statePath = tmpStatePath();
  const postCalls = [];
  const client = async (token, pathSuffix) => {
    if (pathSuffix === 'me') return { id: 'spotify-user-123' };
    throw new Error(`Unexpected GET in this test: ${pathSuffix}`);
  };
  const postFn = async (token, pathSuffix, body) => {
    postCalls.push({ pathSuffix, body });
    return { id: 'new-playlist-id' };
  };
  const result = await ensurePlaylist('token', { spotifyClient: client, spotifyPostFn: postFn, statePath });

  assert.equal(result.playlistId, 'new-playlist-id');
  assert.equal(result.userId, 'spotify-user-123');
  assert.equal(postCalls.length, 1);
  assert.equal(postCalls[0].pathSuffix, 'users/spotify-user-123/playlists');
  assert.equal(postCalls[0].body.public, false, 'the playlist must be private');
  assert.equal(postCalls[0].body.name, 'LA Shows — This Week');

  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.playlistId, 'new-playlist-id');
  assert.equal(saved.userId, 'spotify-user-123');
});

await asyncTest('ensurePlaylist reuses the saved playlist id on a later run, without creating a new one', async () => {
  const statePath = tmpStatePath();
  fs.writeFileSync(statePath, JSON.stringify({ playlistId: 'existing-id', userId: 'spotify-user-123' }));
  let postCalled = false;
  const result = await ensurePlaylist('token', {
    spotifyClient: async () => { throw new Error('should not need GET /me when state already has a userId'); },
    spotifyPostFn: async () => { postCalled = true; return {}; },
    statePath,
  });
  assert.equal(result.playlistId, 'existing-id');
  assert.equal(postCalled, false);
});

await asyncTest('replacePlaylistTracks PUTs the full URI list to the playlist tracks endpoint', async () => {
  const putCalls = [];
  const putFn = async (token, pathSuffix, body) => { putCalls.push({ pathSuffix, body }); };
  await replacePlaylistTracks('token', 'playlist-abc', ['spotify:track:a', 'spotify:track:b'], { spotifyPutFn: putFn });
  assert.equal(putCalls.length, 1);
  assert.equal(putCalls[0].pathSuffix, 'playlists/playlist-abc/tracks');
  assert.deepEqual(putCalls[0].body.uris, ['spotify:track:a', 'spotify:track:b']);
});

await asyncTest('replacePlaylistTracks with an empty list still PUTs (clears the playlist), never skips the call', async () => {
  const putCalls = [];
  const putFn = async (token, pathSuffix, body) => { putCalls.push({ pathSuffix, body }); };
  await replacePlaylistTracks('token', 'playlist-abc', [], { spotifyPutFn: putFn });
  assert.equal(putCalls.length, 1, 'an empty qualifying-shows week must clear the playlist, not silently leave stale tracks');
  assert.deepEqual(putCalls[0].body.uris, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-spotify-playlist-shows.mjs`
Expected: FAIL — `ensurePlaylist`/`replacePlaylistTracks` not exported yet.

- [ ] **Step 3: Implement both functions**

Append to `scripts/spotify-playlist-shows.mjs`:

```js
const PLAYLIST_NAME = 'LA Shows — This Week';
const PLAYLIST_DESCRIPTION = 'Auto-updated weekly from taste-matched upcoming LA shows — see the Dining + Shows tab.';

function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// First run: resolves the account's user id, creates a private playlist, and
// persists both. Every later run reuses the saved ids without an extra GET —
// only ensurePlaylist's caller (runPlaylistUpdate, Task 5) knows to fall back
// to creating a new one if the saved playlist id turns out to be gone (404).
export async function ensurePlaylist(accessToken, {
  spotifyClient = spotifyGet, spotifyPostFn = spotifyPost, statePath = defaultStatePath(),
} = {}) {
  const existing = loadState(statePath);
  if (existing?.playlistId && existing?.userId) {
    return { playlistId: existing.playlistId, userId: existing.userId };
  }
  const userId = existing?.userId || (await spotifyClient(accessToken, 'me', {})).id;
  const created = await spotifyPostFn(accessToken, `users/${userId}/playlists`, {
    name: PLAYLIST_NAME,
    public: false,
    description: PLAYLIST_DESCRIPTION,
  });
  const state = { playlistId: created.id, userId };
  saveState(statePath, state);
  return state;
}

// Spotify's replace-tracks endpoint clears and resets the entire playlist in
// one call — this is what makes "replace entirely" a single request rather
// than a separate remove-then-add. An empty list is a legitimate, intended
// call (clears the playlist for a week with zero qualifying shows), not a
// case to special-case away.
export async function replacePlaylistTracks(accessToken, playlistId, uris, { spotifyPutFn = spotifyPut } = {}) {
  await spotifyPutFn(accessToken, `playlists/${playlistId}/tracks`, { uris });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-spotify-playlist-shows.mjs`
Expected: PASS — all cases from Tasks 2–4.

- [ ] **Step 5: Commit**

```bash
git add scripts/spotify-playlist-shows.mjs data/test-spotify-playlist-shows.mjs
git commit -m "Add ensurePlaylist/replacePlaylistTracks: create-once, replace-every-run."
```

---

### Task 5: Top-level orchestration, 404-recreate fallback, and CLI

**Files:**
- Modify: `scripts/spotify-playlist-shows.mjs`
- Modify: `package.json`
- Test: `data/test-spotify-playlist-shows.mjs`

**Interfaces:**
- Consumes: Tasks 2–4's `filterQualifyingShows`, `buildTrackList`, `ensurePlaylist`, `replacePlaylistTracks`.
- Produces: `runPlaylistUpdate({ ownerId = 'kevin', matchDataPath = defaultMatchDataPath(), statePath = defaultStatePath(), accessToken = null, spotifyClient = spotifyGet, spotifyPostFn = spotifyPost, spotifyPutFn = spotifyPut, log = console.log } = {}): Promise<{ playlistId, trackCount, artistCount }>` — the single function `main()` calls, and what Task 6's `-SkipPlaylist`-gated pull step invokes indirectly via the CLI.

- [ ] **Step 1: Write the failing tests**

Append to `data/test-spotify-playlist-shows.mjs`:

```js
import { runPlaylistUpdate } from '../scripts/spotify-playlist-shows.mjs';

function tmpMatchDataPath(shows) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spotify-match-data-'));
  const p = path.join(dir, 'show-matches-latest.json');
  fs.writeFileSync(p, JSON.stringify({ shows }));
  return p;
}

function realisticShows() {
  return [
    show({ act: 'Counting Crows', basis: 'like' }),
    show({ act: 'JAŸ-Z', basis: 'follow' }),
    { ...show({ act: 'JAŸ-Z', basis: 'follow' }), date: '2026-08-24' },
    show({ act: 'LLM Guess Artist', basis: 'claude' }),
    show({ act: 'Some Comedian', kind: 'comedy', basis: 'like' }),
  ];
}

await asyncTest('runPlaylistUpdate end to end: filters, resolves tracks, creates, and replaces', async () => {
  const matchDataPath = tmpMatchDataPath(realisticShows());
  const statePath = tmpStatePath();
  const putCalls = [];
  const client = fakeSpotifyClient({
    searchResults: { 'Counting Crows': 'artist-cc', 'JAŸ-Z': 'artist-jz' },
    topTracks: { 'artist-cc': ['spotify:track:cc1'], 'artist-jz': ['spotify:track:jz1', 'spotify:track:jz2'] },
  });
  const wrappedClient = async (token, pathSuffix, query) => {
    if (pathSuffix === 'me') return { id: 'spotify-user-123' };
    return client(token, pathSuffix, query);
  };
  const postFn = async () => ({ id: 'created-playlist-id' });
  const putFn = async (token, pathSuffix, body) => { putCalls.push({ pathSuffix, body }); };

  const result = await runPlaylistUpdate({
    matchDataPath, statePath, accessToken: 'token',
    spotifyClient: wrappedClient, spotifyPostFn: postFn, spotifyPutFn: putFn, log: () => {},
  });

  assert.equal(result.artistCount, 2, 'Counting Crows + JAŸ-Z once each — comedy and claude-basis excluded, JAŸ-Z deduped');
  assert.equal(result.trackCount, 3);
  assert.equal(putCalls.length, 1);
  assert.deepEqual(new Set(putCalls[0].body.uris), new Set(['spotify:track:cc1', 'spotify:track:jz1', 'spotify:track:jz2']));
});

await asyncTest('runPlaylistUpdate recreates the playlist when the saved id 404s', async () => {
  const matchDataPath = tmpMatchDataPath([show({ act: 'Counting Crows', basis: 'like' })]);
  const statePath = tmpStatePath();
  fs.writeFileSync(statePath, JSON.stringify({ playlistId: 'gone-id', userId: 'spotify-user-123' }));
  const client = fakeSpotifyClient({ searchResults: { 'Counting Crows': 'artist-cc' }, topTracks: { 'artist-cc': ['spotify:track:cc1'] } });
  let putAttempts = 0;
  const putFn = async (token, pathSuffix) => {
    putAttempts += 1;
    if (putAttempts === 1) { const e = new Error('not found'); e.status = 404; throw e; }
  };
  const postFn = async () => ({ id: 'recreated-playlist-id' });

  const result = await runPlaylistUpdate({
    matchDataPath, statePath, accessToken: 'token',
    spotifyClient: client, spotifyPostFn: postFn, spotifyPutFn: putFn, log: () => {},
  });

  assert.equal(result.playlistId, 'recreated-playlist-id');
  assert.equal(putAttempts, 2, 'first PUT 404s against the stale id, second succeeds against the recreated one');
  const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(saved.playlistId, 'recreated-playlist-id');
});

await asyncTest('an empty qualifying-shows week still clears the playlist rather than skipping the run', async () => {
  const matchDataPath = tmpMatchDataPath([show({ act: 'LLM Guess Only', basis: 'claude' })]);
  const statePath = tmpStatePath();
  fs.writeFileSync(statePath, JSON.stringify({ playlistId: 'existing-id', userId: 'spotify-user-123' }));
  const putCalls = [];
  const result = await runPlaylistUpdate({
    matchDataPath, statePath, accessToken: 'token',
    spotifyClient: async () => { throw new Error('should not be called'); },
    spotifyPostFn: async () => { throw new Error('should not create when state already has ids'); },
    spotifyPutFn: async (t, p, body) => { putCalls.push(body); },
    log: () => {},
  });
  assert.equal(result.trackCount, 0);
  assert.equal(putCalls.length, 1);
  assert.deepEqual(putCalls[0].uris, []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-spotify-playlist-shows.mjs`
Expected: FAIL — `runPlaylistUpdate` not exported yet.

- [ ] **Step 3: Implement `runPlaylistUpdate` and the CLI entry point**

Append to `scripts/spotify-playlist-shows.mjs`:

```js
export async function runPlaylistUpdate({
  ownerId = 'kevin',
  matchDataPath = defaultMatchDataPath(),
  statePath = defaultStatePath(),
  accessToken = null,
  spotifyClient = spotifyGet,
  spotifyPostFn = spotifyPost,
  spotifyPutFn = spotifyPut,
  log = console.log,
} = {}) {
  const token = accessToken || (await getValidAccessToken(ownerId));
  const matchData = JSON.parse(fs.readFileSync(matchDataPath, 'utf8'));
  const artists = filterQualifyingShows(matchData);
  const uris = await buildTrackList(token, artists, { spotifyClient, log });

  let { playlistId } = await ensurePlaylist(token, { spotifyClient, spotifyPostFn, statePath });
  try {
    await replacePlaylistTracks(token, playlistId, uris, { spotifyPutFn });
  } catch (err) {
    if (err.status !== 404) throw err;
    // The saved playlist was deleted out from under us (e.g. manually via the
    // Spotify app) — recreate rather than fail the whole weekly run.
    log(`Saved playlist ${playlistId} is gone (404) — recreating.`);
    fs.rmSync(statePath, { force: true });
    ({ playlistId } = await ensurePlaylist(token, { spotifyClient, spotifyPostFn, statePath }));
    await replacePlaylistTracks(token, playlistId, uris, { spotifyPutFn });
  }

  return { playlistId, trackCount: uris.length, artistCount: artists.length };
}

async function main() {
  const result = await runPlaylistUpdate({});
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-spotify-playlist-shows.mjs`
Expected: PASS — all cases across every task in this file.

- [ ] **Step 5: Add the npm script**

In `package.json`, alongside the existing `"spotify:match": "node scripts/spotify-match-shows.mjs",` line, add:
```json
    "spotify:update-show-playlist": "node scripts/spotify-playlist-shows.mjs",
```

- [ ] **Step 6: Verify the read-only parts against the real Spotify catalog (search + top-tracks only — no write)**

This is possible today without the new scope, since catalog search and top-tracks are public data. Run:
```bash
node -e "
import { resolveArtistTracks } from './scripts/spotify-playlist-shows.mjs';
import { getValidAccessToken } from './scripts/spotify-client.mjs';
const token = await getValidAccessToken('kevin');
const uris = await resolveArtistTracks(token, 'Counting Crows');
console.log(uris);
"
```
Expected: an array of up to 3 real `spotify:track:...` URIs, no error. **Do not** attempt to run `runPlaylistUpdate`/`main()` against the real API yet — the write scope (Task 1) is not yet granted on this machine; that call will fail with an insufficient-scope error until Kevin completes the manual re-consent step (Task 6 of this plan documents this as a rollout prerequisite, not something to force through here).

- [ ] **Step 7: Commit**

```bash
npm run check:secrets
git add scripts/spotify-playlist-shows.mjs package.json data/test-spotify-playlist-shows.mjs
git commit -m "Add runPlaylistUpdate orchestration, 404-recreate fallback, and the CLI entry point."
```

---

### Task 6: Wire into the weekly pull; document the manual re-consent step

**Files:**
- Modify: `scripts/run-weekly-shows-pull.ps1`
- Modify: `claude.md`

**Interfaces:**
- Consumes: `npm run spotify:update-show-playlist` (Task 5).
- Produces: nothing consumed elsewhere — this is the final wiring/documentation task.

- [ ] **Step 1: Add the fourth step and `-SkipPlaylist` switch**

In `scripts/run-weekly-shows-pull.ps1`, change the `param()` block:
```powershell
param(
    [switch]$SkipFindShows,
    [switch]$SkipVenuePull,
    [switch]$SkipMatch,
    [switch]$SkipPlaylist
)
```

And in the `try` block, after the existing three steps:
```powershell
    if (-not $SkipFindShows) { Invoke-NpmScript 'spotify:find-shows' }
    if (-not $SkipVenuePull) { Invoke-NpmScript 'shows:pull' }
    if (-not $SkipMatch) { Invoke-NpmScript 'spotify:match' }
    if (-not $SkipPlaylist) { Invoke-NpmScript 'spotify:update-show-playlist' }
    Write-ShowsLog '=== Longterm weekly shows pull success ==='
```

- [ ] **Step 2: Verify the script still parses**

Run (PowerShell):
```powershell
$errors = $null
[System.Management.Automation.Language.Parser]::ParseFile('scripts/run-weekly-shows-pull.ps1', [ref]$null, [ref]$errors) | Out-Null
if ($errors) { $errors } else { 'Parses OK' }
```
Expected: `Parses OK`.

- [ ] **Step 3: Document the manual rollout step and the new script in `claude.md`**

Add a bullet near the existing Spotify/dining documentation in `claude.md`:
```
- `scripts/spotify-playlist-shows.mjs` — rebuilds a private Spotify playlist under Kevin's account every week (`npm run spotify:update-show-playlist`, wired as the 4th step of `run-weekly-shows-pull.ps1`) from `show-matches-latest.json`'s genuinely taste-matched music shows (`scores.kevin.basis !== 'claude'` — excludes LLM-guessed recommendations, keeping only shows backed by a real like/follow/playlist signal). Replaces the entire tracklist every run (`PUT /playlists/{id}/tracks`), so a show that's passed or dropped off the list disappears automatically rather than accumulating forever. **Requires the `playlist-modify-private` scope**, added 2026-08-07 — existing Spotify tokens on this machine predate it, so `npm run spotify:auth -- --owner kevin` must be re-run once to re-consent before this step can succeed; until then it fails loudly (by design) rather than silently no-op'ing.
```

- [ ] **Step 4: Run the full test suite one more time**

Run: `node data/test-spotify-playlist-shows.mjs && node data/test-telegram-recap.mjs && node data/test-oura-pull.mjs`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
npm run check:secrets
git add scripts/run-weekly-shows-pull.ps1 claude.md
git commit -m "Wire the show playlist into the weekly pull; document the required re-consent."
```

- [ ] **Step 6: Report the outstanding manual step to the user**

This plan cannot complete end-to-end verification of the actual playlist write path — that requires Kevin to run `npm run spotify:auth -- --owner kevin` to grant `playlist-modify-private`, which is outside this implementation. State this plainly when the plan is done: the code is tested and ready, but the feature stays dark (failing loudly, per design) until that one manual step happens.

---

## Self-review

**Spec coverage:** `spotifyPost`/`spotifyPut` + new scope (Task 1) · filtering/dedup with the `basis !== 'claude'` reasoning verified against real data (Task 2) · track resolution with skip-on-failure (Task 3) · create-once/replace-every-run + empty-list-still-clears (Task 4) · 404-recreate fallback + CLI (Task 5) · weekly-pull wiring + the manual re-consent documented as a rollout prerequisite, not something any task claims to complete (Task 6). The spec's non-goals (Hanna's account, comedy shows, accumulating playlist, manual curation UI) correctly have no corresponding task.

**Type consistency:** `filterQualifyingShows` returns artist name strings, consumed by `buildTrackList`'s `artistNames` parameter. `resolveArtistTracks`/`buildTrackList` both accept `{ spotifyClient }`, matching the single client Task 5 threads through `runPlaylistUpdate`. `ensurePlaylist` returns `{ playlistId, userId }`; `replacePlaylistTracks` takes `playlistId` positionally — both consumed correctly in Task 5's `runPlaylistUpdate`. `spotifyPostFn`/`spotifyPutFn` naming (not `spotifyPost`/`spotifyPut`, which are the real, imported defaults) is consistent across Tasks 4 and 5 to avoid shadowing the real functions.
