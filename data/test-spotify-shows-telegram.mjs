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
import { filterQualifyingShows, resolveArtistPageUrl, buildArtistLinks, formatShowDate, formatMessage, runOnce } from '../scripts/spotify-shows-telegram.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-spotify-shows-telegram.mjs');

function show({ act, kind = 'music', basis = 'like', score = 90, date = '2026-08-10', venue = 'The Wiltern', promoter = undefined }) {
  const s = { act, kind, date, venue, scores: { kevin: { basis, score, linked: true } } };
  if (promoter) s.promoter = promoter;
  return s;
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

test('formatMessage sorts entries by score, strongest first, regardless of input order', () => {
  const entries = [
    { act: 'Weaker Match', kind: 'music', date: '2026-08-14', venue: 'The Echo', url: 'https://open.spotify.com/artist/weaker', score: 60 },
    { act: 'Stronger Match', kind: 'music', date: '2026-08-24', venue: 'Hollywood Bowl', url: 'https://open.spotify.com/artist/stronger', score: 95 },
  ];
  const text = formatMessage(entries);
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith('🎸 Stronger Match'), `expected Stronger Match first, got: ${lines[0]}`);
  assert.ok(lines[1].startsWith('🎸 Weaker Match'), `expected Weaker Match second, got: ${lines[1]}`);
});

test('formatMessage breaks a score tie by soonest date', () => {
  const entries = [
    { act: 'Later Artist', kind: 'music', date: '2026-08-24', venue: 'The Echo', url: 'https://open.spotify.com/artist/later', score: 92 },
    { act: 'Sooner Artist', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl', url: 'https://open.spotify.com/artist/sooner', score: 92 },
  ];
  const text = formatMessage(entries);
  const lines = text.split('\n');
  assert.ok(lines[0].startsWith('🎸 Sooner Artist'), `expected Sooner Artist first, got: ${lines[0]}`);
  assert.ok(lines[1].startsWith('🎸 Later Artist'), `expected Later Artist second, got: ${lines[1]}`);
});

test('formatMessage uses the guitar for music, the laughing face for comedy, and shows the score', () => {
  const entries = [
    { act: 'Counting Crows', kind: 'music', date: '2026-08-14', venue: 'Hollywood Bowl', url: 'https://open.spotify.com/artist/cc', score: 97 },
    { act: 'Anthony Jeselnik', kind: 'comedy', date: '2026-08-16', venue: 'Largo', url: 'https://open.spotify.com/artist/aj', score: 56 },
  ];
  const text = formatMessage(entries);
  assert.equal(
    text,
    '🎸 Counting Crows (97%) — Aug 14 @ Hollywood Bowl: https://open.spotify.com/artist/cc\n'
    + '🤣 Anthony Jeselnik (56%) — Aug 16 @ Largo: https://open.spotify.com/artist/aj',
  );
});

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

test('formatMessage falls back to "TBD" when an entry has no venue', () => {
  const entries = [{ act: 'No Venue Artist', kind: 'music', date: '2026-08-14', venue: undefined, url: 'https://open.spotify.com/artist/nv', score: 90 }];
  assert.equal(formatMessage(entries), '🎸 No Venue Artist (90%) — Aug 14 @ TBD: https://open.spotify.com/artist/nv');
});

test('formatMessage on an empty array returns an empty string', () => {
  assert.equal(formatMessage([]), '');
});

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
    '🎸 Counting Crows (90%) — Aug 14 @ Hollywood Bowl: https://open.spotify.com/artist/cc\n'
    + '🤣 Anthony Jeselnik (90%) — Aug 16 @ Largo: https://open.spotify.com/artist/aj',
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
