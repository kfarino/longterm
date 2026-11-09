// data/test-kevin-300k.mjs
// Kevin's cash-flow climb Hero → $300k. Invented hours and salaries only.
import assert from 'node:assert/strict';
import { computeKevin300k, summarizeHeliosHours } from '../scripts/kevin-300k.mjs';

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

console.log('test-kevin-300k.mjs');

const cfg = {
  basePreTax: 230000,
  targetPreTax: 300000,
  hourlyRate: 180,
  billCapMonthly: 4000,
};

test('9 hr/week at $180 clears $300k', () => {
  const t = computeKevin300k(cfg, 9);
  assert.equal(t.hoursNeedWeek.toFixed(1), '7.5');
  assert.ok(t.cleared, '9 hr/week is past the line');
  assert.ok(t.current >= 300000);
  assert.ok(t.gap < 0, 'gap is negative when ahead');
  assert.equal(t.atBillCap, 230000 + 4000 * 12);
});

test('$4k/mo Bill cap does not clear $300k', () => {
  const hours = (4000 * 12) / (180 * 52);
  const t = computeKevin300k(cfg, hours);
  assert.ok(!t.cleared);
  assert.equal(t.current, t.atBillCap);
});

test('missing config yields a skip, not a fake $0 climb', () => {
  assert.equal(computeKevin300k(null, 9), null);
  assert.equal(computeKevin300k({}, 9), null);
});

test('Helios hours: rolling 7 and 28 days, older rows dropped', () => {
  const asOf = new Date(2026, 10, 8); // Nov 8, 2026
  const s = summarizeHeliosHours({
    entries: [
      { date: '2026-11-07', hours: 2 },
      { date: '2026-11-02', hours: 5 },
      { date: '2026-10-20', hours: 8 },
      { date: '2026-09-01', hours: 40 },
    ],
  }, asOf);
  assert.equal(s.hours7, 7);
  assert.equal(s.hours28, 15);
  assert.equal(s.hoursPerWeek, 15 / 4);
  assert.equal(s.source, 'helios');
});

test('Helios hours: missing log is missing, not zero', () => {
  const s = summarizeHeliosHours(null, new Date(2026, 10, 8));
  assert.equal(s.source, 'missing');
  assert.equal(s.hoursPerWeek, null);
});
