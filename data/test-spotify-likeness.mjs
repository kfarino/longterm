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

// Deliberately nonexistent — venueMeta() degrades to no venue info when the
// path doesn't exist, keeping these tests hermetic. Without this override,
// scoreShowsLikeness defaults to the repo's real venues_to_follow.json,
// where "Hollywood Bowl" carries a genuine 5-star rating (+12 venueBoost)
// that would silently contaminate every score assertion below.
function noVenuesPath() {
  return path.join(tmpDir('spotify-likeness-no-venues-'), 'venues_to_follow.json');
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
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir, venuesPath: noVenuesPath(), skipClaude: true });
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
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir, venuesPath: noVenuesPath(), skipClaude: true });
  assert.ok(payload.shows[0].scores.kevin.score <= 100);
  assert.equal(payload.shows[0].scores.kevin.score, 100, 'followed floor 92 + 15 = 107, clamps to 100');
});

await asyncTest('an unlinked owner is unaffected by the Live Nation boost (still not linked)', async () => {
  const shows = [{ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' }];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir: tmpDir('spotify-likeness-unlinked-'), venuesPath: noVenuesPath(), skipClaude: true });
  assert.equal(payload.shows[0].scores.kevin.linked, false);
  assert.equal(payload.shows[0].scores.kevin.score, null);
});

await asyncTest('a comedy show gets the Live Nation boost added to its venue-base score, without double-applying a venue-rating boost', async () => {
  // Comedy scoring never reads the taste artist list, but "connected"
  // (i.e. has a taste.json at all) is still checked before any kind-
  // specific branching — an owner with no taste file gets linked:false
  // regardless of kind, so a taste file must exist even though it's unused here.
  const tasteDir = tmpDir('spotify-likeness-comedy-');
  writeTaste(tasteDir, 'kevin', {});
  const shows = [{ act: 'Anthony Jeselnik', venue: 'Largo', date: '2026-09-10', promoter: 'Live Nation' }];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir, venuesPath: noVenuesPath(), skipClaude: true });
  const score = payload.shows[0].scores.kevin;
  assert.equal(score.basis, 'comedy-venue');
  assert.equal(score.venueBoost, 0, 'comedy never gets the venue-rating boost (already baked into its base score)');
  assert.equal(score.liveNation, true);
  assert.equal(score.liveNationBoost, 15);
  assert.equal(score.score, 52 + 15, 'unrated-venue comedy base (52) + Live Nation boost (15)');
});

console.log('All spotify-likeness tests passed.');
