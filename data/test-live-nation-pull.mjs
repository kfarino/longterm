// Longterm/data/test-live-nation-pull.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// live-nation-pull.mjs's event parsing, Live Nation detection (promoter
// field + venue-list fallback), pagination, and cache-merge — all against an
// injected fetch client, never a real network call. Run with:
//   node Longterm/data/test-live-nation-pull.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isLiveNationEvent,
  mapEventToShow,
  fetchClassificationEvents,
  fetchAllLiveNationEvents,
  runOnce,
  PAGE_SIZE,
  DEFAULT_MAX_PAGES,
  MAX_PAGE_OFFSET,
} from '../scripts/live-nation-pull.mjs';

function test(name, fn) { fn(); console.log(`  ok - ${name}`); }
async function asyncTest(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-live-nation-pull.mjs');

function fakeEvent(overrides = {}) {
  return {
    id: 'evt-1',
    name: 'Counting Crows',
    url: 'https://www.ticketmaster.com/event/evt-1',
    dates: { start: { localDate: '2026-09-10' } },
    _embedded: {
      attractions: [{ name: 'Counting Crows' }],
      venues: [{ name: 'Hollywood Bowl' }],
    },
    ...overrides,
  };
}

test('isLiveNationEvent matches a promoter.name of "Live Nation"', () => {
  const event = fakeEvent({ promoter: { name: 'Live Nation' } });
  assert.equal(isLiveNationEvent(event, []), true);
});

test('isLiveNationEvent matches a promoters[] entry, case-insensitively', () => {
  const event = fakeEvent({ promoters: [{ name: 'LIVE NATION LOS ANGELES' }] });
  assert.equal(isLiveNationEvent(event, []), true);
});

test('isLiveNationEvent matches the House of Blues Concerts subsidiary name', () => {
  const event = fakeEvent({ promoter: { name: 'House of Blues Concerts' } });
  assert.equal(isLiveNationEvent(event, []), true);
});

test('isLiveNationEvent falls back to the hand-maintained venue list when promoter data is missing', () => {
  const event = fakeEvent({ promoter: undefined, promoters: undefined });
  assert.equal(isLiveNationEvent(event, ['hollywood bowl']), true);
  assert.equal(isLiveNationEvent(event, ['the wiltern']), false);
});

test('isLiveNationEvent returns false when neither signal matches — never a false positive', () => {
  const event = fakeEvent({ promoter: { name: 'AEG Presents' } });
  assert.equal(isLiveNationEvent(event, []), false);
});

test('mapEventToShow extracts act/venue/date/sourceUrl and tags promoter when detected', () => {
  const event = fakeEvent({ promoter: { name: 'Live Nation' } });
  assert.deepEqual(mapEventToShow(event, []), {
    act: 'Counting Crows',
    venue: 'Hollywood Bowl',
    date: '2026-09-10',
    sourceUrl: 'https://www.ticketmaster.com/event/evt-1',
    promoter: 'Live Nation',
  });
});

test('mapEventToShow omits the promoter field entirely when not a Live Nation event', () => {
  const event = fakeEvent({ promoter: { name: 'AEG Presents' } });
  const show = mapEventToShow(event, []);
  assert.equal('promoter' in show, false);
});

test('mapEventToShow falls back to event.name when there is no attraction, and to "" when there is no venue', () => {
  const event = fakeEvent({ _embedded: {} });
  const show = mapEventToShow(event, []);
  assert.equal(show.act, 'Counting Crows'); // event.name fallback
  assert.equal(show.venue, '');
});

test('mapEventToShow returns null when the event has no date (cannot build a usable show)', () => {
  const event = fakeEvent({ dates: {} });
  assert.equal(mapEventToShow(event, []), null);
});

await asyncTest('fetchClassificationEvents paginates until totalPages is exhausted', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const page = Number(new URL(url).searchParams.get('page'));
    const events = page < 2 ? [fakeEvent({ id: `evt-${page}` })] : [];
    return {
      ok: true,
      json: async () => ({ _embedded: { events }, page: { totalPages: 2, number: page } }),
    };
  };
  const events = await fetchClassificationEvents({ apiKey: 'k', classificationName: 'Music', days: 60, fetchImpl });
  assert.equal(calls.length, 2, 'should stop once page reaches totalPages');
  assert.equal(events.length, 2);
  assert.ok(calls[0].includes('classificationName=Music'));
  assert.ok(calls[0].includes('apikey=k'));
});

test('default pagination stays under Ticketmaster DIS1035 (page * size < 1000)', () => {
  assert.equal(PAGE_SIZE, 200);
  assert.equal(DEFAULT_MAX_PAGES, 5, 'pages 0–4 only — page 5 with size 200 would be DIS1035');
  assert.ok(
    (DEFAULT_MAX_PAGES - 1) * PAGE_SIZE < MAX_PAGE_OFFSET,
    'highest requested page offset must be < 1000',
  );
  assert.ok(
    DEFAULT_MAX_PAGES * PAGE_SIZE >= MAX_PAGE_OFFSET || DEFAULT_MAX_PAGES === Math.floor(MAX_PAGE_OFFSET / PAGE_SIZE),
    'defaults should use the full safe window (not leave unused pages on the table)',
  );
});

await asyncTest('fetchClassificationEvents never requests page*size >= 1000 even if maxPages is too high', async () => {
  const offsets = [];
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const page = Number(params.get('page'));
    const size = Number(params.get('size'));
    offsets.push(page * size);
    return {
      ok: true,
      json: async () => ({
        _embedded: { events: [fakeEvent({ id: `evt-${page}` })] },
        page: { totalPages: 50, number: page },
      }),
    };
  };
  await fetchClassificationEvents({
    apiKey: 'k',
    classificationName: 'Music',
    days: 60,
    fetchImpl,
    maxPages: 10, // would have hit DIS1035 at page 5 with size 200 before the fix
  });
  assert.equal(offsets.length, 5, 'safe max is pages 0–4 at size 200');
  assert.ok(offsets.every((o) => o < MAX_PAGE_OFFSET), 'every request must satisfy page*size < 1000');
  assert.deepEqual(offsets, [0, 200, 400, 600, 800]);
});

await asyncTest('fetchClassificationEvents throws with the response body on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(
    () => fetchClassificationEvents({ apiKey: 'bad', classificationName: 'Music', days: 60, fetchImpl }),
    /401/,
  );
});

await asyncTest('fetchAllLiveNationEvents queries both Music and Comedy and dedupes by event id', async () => {
  const seenClassifications = [];
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const classificationName = params.get('classificationName');
    seenClassifications.push(classificationName);
    // Same event id returned under both classifications, to exercise dedup.
    const events = params.get('page') === '0' ? [fakeEvent({ id: 'shared-evt' })] : [];
    return { ok: true, json: async () => ({ _embedded: { events }, page: { totalPages: 1, number: 0 } }) };
  };
  const events = await fetchAllLiveNationEvents({ apiKey: 'k', days: 60, fetchImpl });
  assert.deepEqual(seenClassifications.sort(), ['Comedy', 'Music']);
  assert.equal(events.length, 1, 'the same event id fetched under both classifications must be deduped');
});

function tmpCachePath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-nation-pull-'));
  return path.join(dir, 'upcoming_shows_cache.json');
}

function tmpVenuesPath(venues) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-nation-venues-'));
  const p = path.join(dir, 'live-nation-venues.json');
  fs.writeFileSync(p, JSON.stringify({ venues }));
  return p;
}

await asyncTest('runOnce writes shows into a fresh cache file, tagging Live Nation ones', async () => {
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const events = params.get('page') === '0' && params.get('classificationName') === 'Music'
      ? [fakeEvent({ id: 'e1', promoter: { name: 'Live Nation' } }), fakeEvent({ id: 'e2', name: 'Indie Band', _embedded: { attractions: [{ name: 'Indie Band' }], venues: [{ name: 'The Echo' }] }, promoter: { name: 'AEG Presents' } })]
      : [];
    return { ok: true, json: async () => ({ _embedded: { events }, page: { totalPages: 1, number: 0 } }) };
  };
  const cachePathOverride = tmpCachePath();
  const venuesOverridePathOverride = tmpVenuesPath([]);
  const result = await runOnce({ days: 60, fetchImpl, apiKey: 'k', cachePathOverride, venuesOverridePathOverride, log: () => {} });
  assert.equal(result.eventCount, 2);
  assert.equal(result.showCount, 2);
  assert.equal(result.liveNationCount, 1);

  const written = JSON.parse(fs.readFileSync(cachePathOverride, 'utf8'));
  const crows = written.shows.find((s) => s.act === 'Counting Crows');
  const indie = written.shows.find((s) => s.act === 'Indie Band');
  assert.equal(crows.promoter, 'Live Nation');
  assert.equal('promoter' in indie, false);
});

await asyncTest('runOnce merges into an existing cache without discarding prior findings, and fills in a promoter on a matching duplicate', async () => {
  const cachePathOverride = tmpCachePath();
  fs.writeFileSync(cachePathOverride, JSON.stringify({
    fetchedAt: '2026-08-01T00:00:00Z',
    findings: [{ text: 'Counting Crows — Hollywood Bowl — 2026-09-10 — https://spotify-found.example', urls: [], label: 'spotify' }],
    shows: [{ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', sourceUrl: 'https://spotify-found.example' }],
  }));
  const fetchImpl = async (url) => {
    const params = new URL(url).searchParams;
    const events = params.get('page') === '0' && params.get('classificationName') === 'Music'
      ? [fakeEvent({ id: 'e1', promoter: { name: 'Live Nation' } })]
      : [];
    return { ok: true, json: async () => ({ _embedded: { events }, page: { totalPages: 1, number: 0 } }) };
  };
  await runOnce({ days: 60, fetchImpl, apiKey: 'k', cachePathOverride, venuesOverridePathOverride: tmpVenuesPath([]), log: () => {} });

  const written = JSON.parse(fs.readFileSync(cachePathOverride, 'utf8'));
  assert.equal(written.shows.length, 1, 'the Ticketmaster duplicate must merge into the existing spotify-found show, not add a second row');
  assert.equal(written.shows[0].sourceUrl, 'https://spotify-found.example', 'first-seen (spotify) fields survive');
  assert.equal(written.shows[0].promoter, 'Live Nation', 'the promoter tag is filled in from the Ticketmaster duplicate');
  assert.ok(written.findings.some((f) => f.label === 'spotify'), 'the prior spotify finding block must survive');
  assert.ok(written.findings.some((f) => f.label === 'livenation'), 'a new livenation finding block must be added');
});

console.log('All live-nation-pull tests passed.');
