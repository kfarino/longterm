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
