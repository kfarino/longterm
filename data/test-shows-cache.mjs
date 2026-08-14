// Longterm/data/test-shows-cache.mjs
//
// Permanent regression test — Live Nation promoter tags must survive when
// spotify/venue cache writers rebuild findings (2026-08-13). Without this,
// mid-week shows:pull / bot get_upcoming_shows wipe the LN badge source.
// Run with:
//   node data/test-shows-cache.mjs
import assert from 'node:assert/strict';
import {
  mergeFindingsPreservingLivenation,
  rebuildShowsWithLivenation,
  discoveryShowsFromFindings,
  livenationFindings,
} from '../scripts/shows-cache.mjs';

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

console.log('test-shows-cache.mjs');

test('mergeFindingsPreservingLivenation keeps prior livenation blocks', () => {
  const existing = {
    findings: [
      { label: 'spotify', text: 'old' },
      {
        label: 'livenation',
        shows: [{ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' }],
      },
    ],
  };
  const merged = mergeFindingsPreservingLivenation(
    [{ label: 'venues', text: 'Indie Band — The Echo — 2026-09-11 — https://example.com' }],
    existing,
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[0].label, 'venues');
  assert.equal(merged[1].label, 'livenation');
  assert.equal(merged[1].shows[0].promoter, 'Live Nation');
});

test('rebuildShowsWithLivenation fills promoter onto a matching discovery show', () => {
  const discovery = [
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', sourceUrl: 'https://example.com/cc', label: 'venues' },
  ];
  const existing = {
    findings: [
      {
        label: 'livenation',
        shows: [
          {
            act: 'Counting Crows',
            venue: 'Hollywood Bowl',
            date: '2026-09-10',
            sourceUrl: 'https://ticketmaster.example/cc',
            promoter: 'Live Nation',
          },
        ],
      },
    ],
  };
  const shows = rebuildShowsWithLivenation(discovery, existing);
  assert.equal(shows.length, 1);
  assert.equal(shows[0].promoter, 'Live Nation');
  assert.equal(shows[0].label, 'venues', 'discovery fields win; promoter is filled in');
  assert.equal(shows[0].sourceUrl, 'https://example.com/cc');
});

test('rebuildShowsWithLivenation also recovers promoter from existing.shows when findings were stripped', () => {
  const discovery = [
    { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', label: 'spotify' },
  ];
  const existing = {
    findings: [],
    shows: [
      { act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' },
    ],
  };
  const shows = rebuildShowsWithLivenation(discovery, existing);
  assert.equal(shows[0].promoter, 'Live Nation');
});

test('discoveryShowsFromFindings ignores livenation text-less blocks (uses rebuild for those)', () => {
  const findings = [
    { label: 'venues', text: 'Indie Band — The Echo — 2026-09-11 — https://example.com/indie' },
    {
      label: 'livenation',
      shows: [{ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation' }],
    },
  ];
  const discovery = discoveryShowsFromFindings(findings);
  assert.equal(discovery.length, 1);
  assert.equal(discovery[0].act, 'Indie Band');
  assert.equal(livenationFindings({ findings }).length, 1);
});

console.log('All shows-cache tests passed.');
