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
import { filterQualifyingShows, resolveArtistTracks, buildTrackList, ensurePlaylist, replacePlaylistTracks } from '../scripts/spotify-playlist-shows.mjs';

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

console.log('All spotify-playlist-shows tests passed.');
