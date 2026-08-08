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
import { filterQualifyingShows, resolveArtistTracks, buildTrackList, ensurePlaylist, replacePlaylistTracks, runPlaylistUpdate, resolveArtistPageUrl, buildArtistLinks, formatShowDate, formatMessage } from '../scripts/spotify-shows-telegram.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-spotify-shows-telegram.mjs');

function show({ act, kind = 'music', basis = 'like', score = 90, date = '2026-08-10', venue = 'The Wiltern' }) {
  return { act, kind, date, venue, scores: { kevin: { basis, score, linked: true } } };
}

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
    tracksByArtist: { 'Counting Crows': ['spotify:track:cc1'], 'JAŸ-Z': ['spotify:track:jz1', 'spotify:track:jz2'] },
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
  const client = fakeSpotifyClient({ tracksByArtist: { 'Counting Crows': ['spotify:track:cc1'] } });
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

console.log('All spotify-playlist-shows tests passed.');
