// Longterm/data/test-spotify-likeness.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// spotify-likeness.mjs scoring: graded like/playlist floors (BM25-style log
// saturation, cap 5), honest pitch copy, and a small Live Nation re-ranker
// gated on real Spotify hits (follow/like/playlist) — not Claude/comedy
// estimates. Run with:
//   node Longterm/data/test-spotify-likeness.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DIGEST_VERSION,
  LIVE_NATION_BOOST,
  SCORE_FLOORS,
  gradedSourceFloor,
  likenessCacheKey,
  liveNationBoost,
  pitchForFloor,
  scoreShowsLikeness,
} from '../scripts/spotify-likeness.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-spotify-likeness.mjs');

test('LIVE_NATION_BOOST is a small gated perk, not a flattening +15', () => {
  assert.equal(LIVE_NATION_BOOST, 4);
  assert.equal(liveNationBoost('Live Nation', 'follow'), LIVE_NATION_BOOST);
  assert.equal(liveNationBoost('Live Nation', 'like'), LIVE_NATION_BOOST);
  assert.equal(liveNationBoost('Live Nation', 'playlist'), LIVE_NATION_BOOST);
  assert.equal(liveNationBoost('Live Nation', 'claude'), 0);
  assert.equal(liveNationBoost('Live Nation', 'comedy'), 0);
  assert.equal(liveNationBoost('Live Nation', 'comedy-venue'), 0);
  assert.equal(liveNationBoost('Some Other Promoter', 'follow'), 0);
  assert.equal(liveNationBoost(null, 'like'), 0);
  assert.equal(liveNationBoost(undefined, 'follow'), 0);
});

test('graded like floors saturate at 5 tracks (1→68, 2→75, 3→79, 4→82, 5+→85)', () => {
  assert.equal(gradedSourceFloor('liked', 1), 68);
  assert.equal(gradedSourceFloor('liked', 2), 75);
  assert.equal(gradedSourceFloor('liked', 3), 79);
  assert.equal(gradedSourceFloor('liked', 4), 82);
  assert.equal(gradedSourceFloor('liked', 5), 85);
  assert.equal(gradedSourceFloor('liked', 12), 85);
  assert.equal(SCORE_FLOORS.liked, 85);
});

test('graded playlist floors saturate at 5 tracks (1→62, 5+→78)', () => {
  assert.equal(gradedSourceFloor('playlist', 1), 62);
  assert.equal(gradedSourceFloor('playlist', 5), 78);
  assert.equal(gradedSourceFloor('playlist', 9), 78);
  assert.equal(SCORE_FLOORS.playlist, 78);
});

test('follow floor stays 92 regardless of trackCount', () => {
  assert.equal(gradedSourceFloor('followed', 1), 92);
  assert.equal(gradedSourceFloor('followed', 5), 92);
  assert.equal(SCORE_FLOORS.followed, 92);
});

test('pitch names the evidence and does not say heavy for 1–2 likes', () => {
  const one = pitchForFloor({ type: 'liked', artistName: 'Test Bistro Band', trackCount: 1 });
  const two = pitchForFloor({ type: 'liked', artistName: 'Test Bistro Band', trackCount: 2 });
  const five = pitchForFloor({ type: 'liked', artistName: 'Test Bistro Band', trackCount: 5 });
  const follow = pitchForFloor({ type: 'followed', artistName: 'Test Bistro Band' });
  assert.match(one, /1 saved track/i);
  assert.doesNotMatch(one, /heavy/i);
  assert.match(two, /2 saved tracks/i);
  assert.doesNotMatch(two, /heavy/i);
  assert.match(five, /heavy/i);
  assert.match(follow, /follow/i);
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

function asEntry(entry, type) {
  if (typeof entry === 'string') {
    const src = { type };
    if (type !== 'followed') src.trackCount = 3;
    return { id: entry, name: entry, sources: [src] };
  }
  const src = { type };
  if (entry.trackCount != null) src.trackCount = entry.trackCount;
  return { id: entry.name, name: entry.name, sources: [src] };
}

function writeTaste(tasteDir, ownerId, { followed = [], liked = [], playlist = [] } = {}) {
  const artists = [
    ...followed.map((e) => asEntry(e, 'followed')),
    ...liked.map((e) => asEntry(e, 'liked')),
    ...playlist.map((e) => asEntry(e, 'playlist')),
  ];
  fs.writeFileSync(
    path.join(tasteDir, `${ownerId}-taste.json`),
    JSON.stringify({ ownerId, pulledAt: '2026-08-01T00:00:00Z', counts: { artists: artists.length }, artists }),
  );
}

await asyncTest('a 5-track playlist-floor show gets +4 when Live Nation-promoted', async () => {
  const tasteDir = tmpDir('spotify-likeness-floor-');
  writeTaste(tasteDir, 'kevin', { playlist: [{ name: 'Counting Crows', trackCount: 5 }] });
  const shows = [
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' },
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-17' }, // no promoter — control
  ];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir, venuesPath: noVenuesPath(), skipClaude: true });
  const [withLN, withoutLN] = payload.shows;
  assert.equal(withLN.scores.kevin.score, 78 + 4, 'playlist floor (78) + Live Nation boost (4)');
  assert.equal(withLN.scores.kevin.liveNation, true);
  assert.equal(withLN.scores.kevin.liveNationBoost, 4);
  assert.equal(withoutLN.scores.kevin.score, 78, 'no promoter tag means no boost');
  assert.equal(withoutLN.scores.kevin.liveNation, false);
  assert.equal(withoutLN.scores.kevin.liveNationBoost, 0);
});

await asyncTest('follow + LN is 96, not clamped to 100', async () => {
  const tasteDir = tmpDir('spotify-likeness-clamp-');
  writeTaste(tasteDir, 'kevin', { followed: ['Counting Crows'] });
  const shows = [{ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' }];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir, venuesPath: noVenuesPath(), skipClaude: true });
  assert.ok(payload.shows[0].scores.kevin.score <= 100);
  assert.equal(payload.shows[0].scores.kevin.score, 96, 'followed floor 92 + 4 = 96');
});

await asyncTest('1-like + LN does not pin at 100 and does not outrank 5+ like without LN', async () => {
  const tasteDir = tmpDir('spotify-likeness-grade-rank-');
  writeTaste(tasteDir, 'kevin', {
    liked: [
      { name: 'One Save Act', trackCount: 1 },
      { name: 'Heavy Like Act', trackCount: 5 },
    ],
  });
  const shows = [
    { act: 'One Save Act', venue: 'The Wiltern', date: '2026-09-10', promoter: 'Live Nation' },
    { act: 'Heavy Like Act', venue: 'The Wiltern', date: '2026-09-17' },
  ];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir, venuesPath: noVenuesPath(), skipClaude: true });
  const oneSave = payload.shows.find((s) => s.act === 'One Save Act').scores.kevin;
  const heavy = payload.shows.find((s) => s.act === 'Heavy Like Act').scores.kevin;
  assert.equal(oneSave.score, 68 + 4);
  assert.ok(oneSave.score < 100, '1-like + LN must not pin at 100');
  assert.equal(heavy.score, 85);
  assert.ok(oneSave.score < heavy.score, 'LN must not invert a 1-save over a 5+ like');
  assert.match(oneSave.pitch, /1 saved track/i);
  assert.doesNotMatch(oneSave.pitch, /heavy/i);
});

await asyncTest('follow without LN outranks 1-like + LN', async () => {
  const tasteDir = tmpDir('spotify-likeness-follow-rank-');
  writeTaste(tasteDir, 'kevin', {
    followed: ['Followed Act'],
    liked: [{ name: 'One Save Act', trackCount: 1 }],
  });
  const shows = [
    { act: 'Followed Act', venue: 'The Wiltern', date: '2026-09-10' },
    { act: 'One Save Act', venue: 'The Wiltern', date: '2026-09-17', promoter: 'Live Nation' },
  ];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir, venuesPath: noVenuesPath(), skipClaude: true });
  const follow = payload.shows.find((s) => s.act === 'Followed Act').scores.kevin;
  const oneSaveLN = payload.shows.find((s) => s.act === 'One Save Act').scores.kevin;
  assert.equal(follow.score, 92);
  assert.equal(oneSaveLN.score, 72);
  assert.ok(follow.score > oneSaveLN.score);
});

await asyncTest('Claude + LN keeps the badge but gets boost 0', async () => {
  const tasteDir = tmpDir('spotify-likeness-claude-ln-');
  const cachePath = path.join(tasteDir, 'likeness-cache.json');
  writeTaste(tasteDir, 'kevin', {});
  const act = 'Unknown Estimated Act';
  const venue = 'The Wiltern';
  const date = '2026-09-10';
  const key = likenessCacheKey('kevin', act, venue, date, 'music');
  fs.writeFileSync(cachePath, JSON.stringify({
    [key]: {
      score: 70,
      pitch: 'Estimated fit from profile.',
      reason: 'test',
      digestVersion: DIGEST_VERSION,
      profileBuiltAt: null,
    },
  }));
  const shows = [{ act, venue, date, promoter: 'Live Nation' }];
  const payload = await scoreShowsLikeness({
    shows,
    ownerIds: ['kevin'],
    tasteDir,
    cachePath,
    venuesPath: noVenuesPath(),
    skipClaude: true,
  });
  const score = payload.shows[0].scores.kevin;
  assert.equal(score.basis, 'claude');
  assert.equal(score.liveNation, true, 'LN badge stays on Claude estimates');
  assert.equal(score.liveNationBoost, 0);
  assert.equal(score.score, 70, 'Claude + LN must not receive the perk');
});

await asyncTest('an unlinked owner is unaffected by the Live Nation boost (still not linked)', async () => {
  const shows = [{ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' }];
  const payload = await scoreShowsLikeness({ shows, ownerIds: ['kevin'], tasteDir: tmpDir('spotify-likeness-unlinked-'), venuesPath: noVenuesPath(), skipClaude: true });
  assert.equal(payload.shows[0].scores.kevin.linked, false);
  assert.equal(payload.shows[0].scores.kevin.score, null);
});

await asyncTest('a comedy show keeps the LN badge but does not get the boost', async () => {
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
  assert.equal(score.liveNation, true, 'LN badge stays on comedy');
  assert.equal(score.liveNationBoost, 0);
  assert.equal(score.score, 52, 'unrated-venue comedy base (52) + no LN perk');
});

console.log('All spotify-likeness tests passed.');
