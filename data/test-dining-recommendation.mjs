// Longterm/data/test-dining-recommendation.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// recommendForSlot()'s ranking logic directly (2026-08-01 rewrite from a
// plain filter-then-array-order pick to a scored ranking) — variety
// (longest-since-visited wins), go-to preference, cuisine-repeat penalty,
// and the existing recency-exclusion/already-used-elsewhere behavior. Run
// with:
//   node Longterm/data/test-dining-recommendation.mjs
import assert from 'node:assert/strict';
import { recommendForSlot } from '../scripts/dining-recommendation.mjs';

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

console.log('test-dining-recommendation.mjs');

const midSlot = { tier: 'mid', dynamic: false };

// Dates computed relative to the real current time (not hardcoded absolute
// strings) so this suite keeps working no matter when it's actually run —
// recommendForSlot itself reads the real clock (new Date()), same as
// nextDateForDayOfWeek elsewhere in this project's dining tools.
function daysAgoISO(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('ranks by longest-since-visited: a never-visited place beats one visited 20 days ago', () => {
  const favorites = [
    { name: 'Recently Visited', list: 'go-to', cuisine: 'Italian', observed: { tier: 'mid', avgSpend: 50 } },
    { name: 'Never Visited', list: 'go-to', cuisine: 'Thai', observed: { tier: 'mid', avgSpend: 55 } },
  ];
  const recentDiningActivity = [
    { date: daysAgoISO(20), matchedPlace: 'Recently Visited' },
  ];
  const rec = recommendForSlot(midSlot, favorites, recentDiningActivity, [], new Set());
  assert.equal(rec.picks[0], 'Never Visited');
});

test('go-to is preferred over want-to-go when otherwise similar', () => {
  const favorites = [
    { name: 'Want To Go Spot', list: 'want-to-go', cuisine: 'Mexican', observed: { tier: 'mid', avgSpend: 50 } },
    { name: 'Go To Spot', list: 'go-to', cuisine: 'Mexican', observed: { tier: 'mid', avgSpend: 50 } },
  ];
  const rec = recommendForSlot(midSlot, favorites, [], [], new Set());
  assert.equal(rec.picks[0], 'Go To Spot');
});

test('a repeat of the most recent cuisine is ranked down relative to a different cuisine', () => {
  const favorites = [
    { name: 'Same Cuisine As Last Time', list: 'go-to', cuisine: 'Italian', observed: { tier: 'mid', avgSpend: 50 } },
    { name: 'Different Cuisine', list: 'go-to', cuisine: 'Japanese', observed: { tier: 'mid', avgSpend: 50 } },
  ];
  // Most recent activity (by date) was Italian, at a place not itself a candidate here.
  const recentDiningActivity = [{ date: daysAgoISO(2), matchedPlace: 'Some Other Italian Place' }];
  const favoritesWithHistoryPlace = [
    ...favorites,
    { name: 'Some Other Italian Place', list: 'go-to', cuisine: 'Italian', observed: { tier: 'high', avgSpend: 200 } },
  ];
  const rec = recommendForSlot(midSlot, favoritesWithHistoryPlace, recentDiningActivity, [], new Set());
  assert.equal(rec.picks[0], 'Different Cuisine', 'the Italian repeat should rank below the different-cuisine option');
});

test('still excludes anything visited within the recency window, regardless of score', () => {
  const favorites = [
    { name: 'Visited 2 Days Ago', list: 'go-to', cuisine: 'Italian', observed: { tier: 'mid', avgSpend: 50 } },
    { name: 'Only Other Option', list: 'go-to', cuisine: 'Thai', observed: { tier: 'cheap', avgSpend: 20 } },
  ];
  const recentDiningActivity = [{ date: daysAgoISO(2), matchedPlace: 'Visited 2 Days Ago' }];
  const rec = recommendForSlot(midSlot, favorites, recentDiningActivity, [], new Set());
  assert.ok(!rec.picks.includes('Visited 2 Days Ago'));
  assert.ok(rec.picks.includes('Only Other Option'));
});

test('still excludes anything already used elsewhere this render, when an alternative exists', () => {
  const favorites = [
    { name: 'Already Used This Month', list: 'go-to', cuisine: 'Italian', observed: { tier: 'mid', avgSpend: 50 } },
    { name: 'Fresh Alternative', list: 'go-to', cuisine: 'Thai', observed: { tier: 'mid', avgSpend: 50 } },
  ];
  const rec = recommendForSlot(midSlot, favorites, [], [], new Set(['Already Used This Month']));
  assert.ok(!rec.picks.includes('Already Used This Month'));
  assert.ok(rec.picks.includes('Fresh Alternative'));
});

test('low-key slot still picks randomly among lowKeyHangIdeas, unaffected by scoring', () => {
  const rec = recommendForSlot({ tier: 'low-key' }, [], [], ['Movie night at home'], new Set());
  assert.deepEqual(rec.picks, ['Movie night at home']);
});

console.log('All tests passed.');
