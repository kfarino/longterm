// Longterm/data/test-spotify-match.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// threading trackCount from bestSource through matchActForOwner so likeness
// floors can grade likes/playlists instead of treating any hit as the cap.
import assert from 'node:assert/strict';
import { bestSource, buildTasteIndex, matchActForOwner } from '../scripts/spotify-match.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
console.log('test-spotify-match.mjs');

test('bestSource sums liked trackCount', () => {
  const src = bestSource([
    { type: 'liked', trackCount: 1 },
    { type: 'liked', trackCount: 2 },
  ]);
  assert.equal(src.type, 'liked');
  assert.equal(src.trackCount, 3);
});

test('bestSource sums playlist trackCount', () => {
  const src = bestSource([{ type: 'playlist', playlistName: 'Road Trip', trackCount: 4 }]);
  assert.equal(src.type, 'playlist');
  assert.equal(src.trackCount, 4);
});

test('matchActForOwner threads liked trackCount onto the hit', () => {
  const index = buildTasteIndex({
    artists: [{
      name: 'One Save Act',
      sources: [{ type: 'liked', trackCount: 1 }],
    }],
  });
  const hit = matchActForOwner('One Save Act', index);
  assert.equal(hit.hit, true);
  assert.equal(hit.type, 'liked');
  assert.equal(hit.trackCount, 1);
});

test('matchActForOwner threads playlist trackCount onto the hit', () => {
  const index = buildTasteIndex({
    artists: [{
      name: 'Playlist Act',
      sources: [{ type: 'playlist', playlistName: 'Road Trip', trackCount: 2 }],
    }],
  });
  const hit = matchActForOwner('Playlist Act', index);
  assert.equal(hit.hit, true);
  assert.equal(hit.type, 'playlist');
  assert.equal(hit.trackCount, 2);
});

console.log('All spotify-match tests passed.');
