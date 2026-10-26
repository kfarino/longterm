// Trajectory math: today's investable balances compound; optional monthly
// savings start in a chosen year; Croatia is a one-time brokerage draw.
// Invented balances only — never copy live accounts into this file.
import assert from 'node:assert/strict';
import { loadDashboard } from './dashboard-test-harness.mjs';

console.log('test-trajectory.mjs');

const FIXTURE_ASSETS = {
  retirement: { kevin: 100000, hanna: 0 },
  brokerage: { kevin: 50000, hanna: 0 },
  cash: { kevin: 10000, hanna: 0 },
  homeEquity: { kevin: 200000, hanna: 0 },
};

function load() {
  const d = loadDashboard({ assets: FIXTURE_ASSETS });
  return d;
}

const d = load();
const YEARS = [2026,2027,2028,2029,2030,2031,2032,2033,2034,2035,2036,2039,2040,2045,2050];
function at(p, yr) {
  const i = YEARS.indexOf(yr);
  return { ret: p.ret[i], brok: p.brok[i], liq: p.liq[i], tot: p.tot[i] };
}

{
  const p = d.computeProjection(0.07, 0.02, 0, 0, 2027, 2033);
  const now = at(p, 2026);
  assert.equal(now.ret, 100000, '2026 retirement is the current balance');
  assert.equal(now.brok, 50000, '2026 brokerage is the current balance');
  assert.equal(now.liq, 10000, '2026 cash is the current balance');
  assert.equal(now.tot, 160000, '2026 total is investable only (no home equity)');
  const y27 = at(p, 2027);
  assert.equal(y27.ret, Math.round(100000 * 1.07));
  assert.equal(y27.brok, Math.round(50000 * 1.07));
  assert.equal(y27.liq, Math.round(10000 * 1.02));
  console.log('  ok - 2026 is current balances; 2027 compounds with no extra savings');
}

{
  const p = d.computeProjection(0.07, 0.02, 0, 1000, 2028, 2033);
  const y27 = at(p, 2027);
  const y28 = at(p, 2028);
  assert.equal(y27.brok, Math.round(50000 * 1.07), 'savings do not start before the chosen year');
  assert.equal(y28.brok, Math.round(y27.brok * 1.07 + 12000), 'from the start year, 12 months land in brokerage');
  console.log('  ok - monthly savings begin in the start year and go to brokerage');
}

{
  const p = d.computeProjection(0, 0, 100, 0, 2027, 2033);
  const pre = at(p, 2032);
  const post = at(p, 2033);
  assert.equal(pre.brok, 50000, 'zero growth keeps brokerage flat until the draw');
  assert.equal(post.brok, 0, 'Croatia draw cannot take brokerage below zero (100k on a 50k balance)');
  const p2 = d.computeProjection(0, 0, 10, 0, 2027, 2033);
  assert.equal(at(p2, 2033).brok, 40000, 'a $10k Croatia budget subtracts $10,000 from brokerage');
  console.log('  ok - Croatia budget is a one-time brokerage draw');
}

{
  const p = d.computeProjection(0.10, 0.10, 0, 5000, 2026, 2033);
  const now = at(p, 2026);
  assert.equal(now.tot, 160000, 'even with savings set to start in 2026, the 2026 point stays today');
  const y27 = at(p, 2027);
  assert.equal(y27.brok, Math.round(50000 * 1.10 + 60000), '2026 start year first adds a full year in 2027');
  console.log('  ok - 2026 chart point is never a projected year');
}
