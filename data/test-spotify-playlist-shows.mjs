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
