// Longterm/data/test-dashboard-shows.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// dashboard_v5.html's showRowHTML() Live Nation "LN" badge (2026-08-08) —
// run through the same headless harness test-dashboard-contract.mjs uses.
// Run with:
//   node Longterm/data/test-dashboard-shows.mjs
import assert from 'node:assert/strict';
import { loadDashboard } from './dashboard-test-harness.mjs';

async function test(name, fn) { await fn(); console.log(`  ok - ${name}`); }
console.log('test-dashboard-shows.mjs');

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

console.log('All dashboard-shows tests passed.');
