// Longterm/data/test-dashboard-shows.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// dashboard_v5.html's showRowHTML() Live Nation "LN" badge (2026-08-08) and
// display grouping: one row per act with collapsed dates (2026-08-14).
// Run through the same headless harness test-dashboard-contract.mjs uses.
// Run with:
//   node Longterm/data/test-dashboard-shows.mjs
import assert from 'node:assert/strict';
import { loadDashboard } from './dashboard-test-harness.mjs';

async function test(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-dashboard-shows.mjs');

const TODAY = '2026-08-14';

function show(overrides) {
  return {
    act: 'Test Bistro Band',
    venue: 'The Echo',
    date: '2026-08-20',
    kind: 'music',
    scores: { kevin: { linked: true, score: 70 } },
    us: { score: 70 },
    ...overrides,
  };
}

await test('showRowHTML renders the LN badge for a Live Nation show', async () => {
  const d = loadDashboard();
  await d.initReady;
  const html = d.showRowHTML({ act: 'Counting Crows', venue: 'Hollywood Bowl', date: '2026-09-10', promoter: 'Live Nation', scores: {} });
  assert.ok(html.includes('show-ln-badge'), 'expected an LN badge element in the row markup');
  assert.ok(/>LN</.test(html), 'expected the badge text to read "LN"');
});

await test('showRowHTML renders the LN badge from scores.liveNation when promoter was stripped', async () => {
  const d = loadDashboard();
  await d.initReady;
  const html = d.showRowHTML({
    act: 'Counting Crows',
    venue: 'Hollywood Bowl',
    date: '2026-09-10',
    scores: { kevin: { linked: true, score: 97, liveNation: true } },
  });
  assert.ok(html.includes('show-ln-badge'), 'scores.liveNation alone must still render the badge');
});

await test('showRowHTML renders no badge when the show is not Live Nation-promoted', async () => {
  const d = loadDashboard();
  await d.initReady;
  const html = d.showRowHTML({ act: 'Indie Band', venue: 'The Echo', date: '2026-09-10', scores: {} });
  assert.equal(html.includes('show-ln-badge'), false);
});

await test('showRowHTML leads with the artist, not a date column', async () => {
  const d = loadDashboard();
  await d.initReady;
  const html = d.showRowHTML({
    act: 'Counting Crows',
    venue: 'Hollywood Bowl',
    date: '2026-09-10',
    dates: ['2026-08-20', '2026-09-10'],
    scores: {},
  });
  const actAt = html.indexOf('show-act');
  const datesAt = html.indexOf('show-dates');
  assert.ok(actAt !== -1, 'expected .show-act');
  assert.ok(datesAt !== -1, 'expected collapsed .show-dates');
  assert.ok(actAt < datesAt, 'artist must come before the date list');
  assert.equal(html.includes('show-date-mon'), false, 'old left-column date chrome must be gone');
  assert.ok(html.includes('Aug 20') && html.includes('Sep 10'), 'collapsed dates should be listed');
});

await test('groupShowsByAct collapses the same act across dates into one row', async () => {
  const d = loadDashboard();
  await d.initReady;
  const grouped = d.groupShowsByAct([
    show({ act: 'The National', date: '2026-09-03', venue: 'Kia Forum', sourceUrl: 'https://example.test/sep', us: { score: 80 }, scores: { kevin: { linked: true, score: 80 } } }),
    show({ act: 'the national!', date: '2026-08-20', venue: 'Hollywood Bowl', sourceUrl: 'https://example.test/aug', us: { score: 90 }, scores: { kevin: { linked: true, score: 90 } } }),
    show({ act: 'Other Band', date: '2026-08-21', venue: 'The Echo', us: { score: 50 }, scores: { kevin: { linked: true, score: 50 } } }),
  ], TODAY);
  assert.equal(grouped.length, 2);
  const national = grouped.find((s) => /national/i.test(s.act));
  assert.ok(national);
  assert.deepEqual(national.dates, ['2026-08-20', '2026-09-03']);
  assert.equal(national.date, '2026-08-20');
  assert.equal(national.sourceUrl, 'https://example.test/aug', 'tickets must be the soonest date URL');
  assert.equal(national.us.score, 90, 'score/pitch come from the best-scored occurrence');
  assert.ok(national.venue.includes('Hollywood Bowl') && national.venue.includes('Kia Forum'));
});

await test('groupShowsByAct ranks by best Us/Kevin score, not first appearance', async () => {
  const d = loadDashboard();
  await d.initReady;
  const grouped = d.groupShowsByAct([
    show({ act: 'Low Score Act', date: '2026-08-15', us: { score: 40 }, scores: { kevin: { linked: true, score: 40 } } }),
    show({ act: 'High Score Act', date: '2026-09-01', us: { score: 95 }, scores: { kevin: { linked: true, score: 95 } } }),
  ], TODAY);
  assert.equal(grouped[0].act, 'High Score Act');
});

await test('groupShowsByAct shows at most two venues, else soonest only', async () => {
  const d = loadDashboard();
  await d.initReady;
  const two = d.groupShowsByAct([
    show({ act: 'Duo', date: '2026-08-20', venue: 'Hollywood Bowl' }),
    show({ act: 'Duo', date: '2026-09-03', venue: 'Kia Forum' }),
  ], TODAY);
  assert.equal(two[0].venue, 'Hollywood Bowl · Kia Forum');

  const many = d.groupShowsByAct([
    show({ act: 'Residency', date: '2026-08-20', venue: 'Hollywood Bowl' }),
    show({ act: 'Residency', date: '2026-08-21', venue: 'Kia Forum' }),
    show({ act: 'Residency', date: '2026-08-22', venue: 'The Greek' }),
  ], TODAY);
  assert.equal(many[0].venue, 'Hollywood Bowl');
  assert.equal(many[0].venue.includes('Greek'), false);
});

await test('groupShowsByAct falls back to Kevin score when Us is missing', async () => {
  const d = loadDashboard();
  await d.initReady;
  const grouped = d.groupShowsByAct([
    show({ act: 'Fallback', date: '2026-09-01', us: undefined, scores: { kevin: { linked: true, score: 40 } } }),
    show({ act: 'Fallback', date: '2026-08-20', us: undefined, scores: { kevin: { linked: true, score: 88 } }, pitch: 'best night', promoter: 'Live Nation' }),
  ], TODAY);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].scores.kevin.score, 88);
  assert.equal(grouped[0].pitch, 'best night');
  assert.equal(grouped[0].promoter, 'Live Nation');
});

await test('showsFindingsHTML groups before rendering so one act is one row', async () => {
  const d = loadDashboard();
  await d.initReady;
  const html = d.showsFindingsHTML(
    { fetchedAt: '2026-08-14T00:00:00Z', days: 60 },
    {
      byKind: {
        music: [
          show({ act: 'The National', date: '2026-09-03', venue: 'Kia Forum', us: { score: 80 } }),
          show({ act: 'The National', date: '2026-08-20', venue: 'Hollywood Bowl', us: { score: 90 } }),
        ],
      },
    },
    'music',
  );
  assert.equal((html.match(/class="show-row"/g) || []).length, 1);
  assert.ok(html.includes('Best music · 1'), 'block count is acts, not dates');
});

console.log('All dashboard-shows tests passed.');
