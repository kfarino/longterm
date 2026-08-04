// Longterm/data/test-calendar-read.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// calendar-read.mjs's read-only summary across multiple Google Calendars
// (Kevin personal + Hanna, work calendar deliberately excluded at the
// config layer) with a mocked calendar client — no real Google network
// calls. Run with:
//   node Longterm/data/test-calendar-read.mjs
import assert from 'node:assert/strict';
import { getUpcomingEvents, parseReadCalendarIds, loadCalendarReadContext } from '../scripts/calendar-read.mjs';

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

async function asyncTest(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

console.log('test-calendar-read.mjs');

test('parseReadCalendarIds: parses comma-separated "id|label" pairs', () => {
  const parsed = parseReadCalendarIds('kevin@personal.com|Kevin,hanna@email.com|Hanna');
  assert.deepEqual(parsed, [
    { id: 'kevin@personal.com', label: 'Kevin' },
    { id: 'hanna@email.com', label: 'Hanna' },
  ]);
});

test('parseReadCalendarIds: a bare id with no label gets a numbered default', () => {
  const parsed = parseReadCalendarIds('kevin@personal.com');
  assert.deepEqual(parsed, [{ id: 'kevin@personal.com', label: 'Calendar 1' }]);
});

test('parseReadCalendarIds: empty/missing value returns no calendars', () => {
  assert.deepEqual(parseReadCalendarIds(''), []);
  assert.deepEqual(parseReadCalendarIds(undefined), []);
});

test('loadCalendarReadContext: reports not configured when no env file exists', () => {
  const ctx = loadCalendarReadContext({ calendarEnvPath: 'C:\\definitely\\does\\not\\exist.env' });
  assert.equal(ctx.configured, false);
  assert.deepEqual(ctx.calendarIds, []);
});

test('loadCalendarReadContext: an injected calendarReadClient bypasses env entirely (test path)', () => {
  const fakeClient = { listEvents: async () => [] };
  const ctx = loadCalendarReadContext({ calendarReadClient: fakeClient, calendarReadCalendarIds: [{ id: 'a', label: 'A' }] });
  assert.equal(ctx.configured, true);
  assert.equal(ctx.calendarClient, fakeClient);
  assert.deepEqual(ctx.calendarIds, [{ id: 'a', label: 'A' }]);
});

await asyncTest('getUpcomingEvents: merges and sorts events from multiple calendars by start time', async () => {
  const calendarIds = [{ id: 'kevin@personal.com', label: 'Kevin' }, { id: 'hanna@email.com', label: 'Hanna' }];
  const mockClient = {
    listEvents: async (calendarId) => {
      if (calendarId === 'kevin@personal.com') {
        return [{ summary: 'Dentist', start: { dateTime: '2026-08-05T09:00:00-07:00' } }];
      }
      return [{ summary: 'Yoga', start: { dateTime: '2026-08-04T18:00:00-07:00' } }];
    },
  };
  const result = await getUpcomingEvents({ calendarIds, calendarClient: mockClient });
  assert.equal(result.count, 2);
  assert.ok(result.summary.indexOf('Yoga') < result.summary.indexOf('Dentist'), 'events should be sorted chronologically across calendars');
  assert.ok(result.summary.includes('[Hanna] Yoga'));
  assert.ok(result.summary.includes('[Kevin] Dentist'));
});

await asyncTest('getUpcomingEvents: an all-day event (date, not dateTime) is still included and labeled', async () => {
  const calendarIds = [{ id: 'kevin@personal.com', label: 'Kevin' }];
  const mockClient = { listEvents: async () => [{ summary: 'Kid\'s birthday', start: { date: '2026-08-06' } }] };
  const result = await getUpcomingEvents({ calendarIds, calendarClient: mockClient });
  assert.ok(result.summary.includes("[Kevin] Kid's birthday — 2026-08-06"));
});

await asyncTest('getUpcomingEvents: no events in range reports a clear "nothing found" message', async () => {
  const calendarIds = [{ id: 'kevin@personal.com', label: 'Kevin' }];
  const mockClient = { listEvents: async () => [] };
  const result = await getUpcomingEvents({ calendarIds, calendarClient: mockClient, days: 3 });
  assert.equal(result.count, 0);
  assert.ok(result.summary.includes('No events found in the next 3 day'));
});

await asyncTest('getUpcomingEvents: one calendar erroring is skipped, not fatal to the whole summary', async () => {
  const calendarIds = [{ id: 'kevin@personal.com', label: 'Kevin' }, { id: 'hanna@email.com', label: 'Hanna' }];
  const mockClient = {
    listEvents: async (calendarId) => {
      if (calendarId === 'hanna@email.com') throw new Error('access revoked');
      return [{ summary: 'Dentist', start: { dateTime: '2026-08-05T09:00:00-07:00' } }];
    },
  };
  const result = await getUpcomingEvents({ calendarIds, calendarClient: mockClient });
  assert.equal(result.count, 1);
  assert.ok(result.summary.includes('Dentist'));
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].label, 'Hanna');
});

await asyncTest('getUpcomingEvents: an event with recurringEventId is labeled "(recurring)"', async () => {
  const calendarIds = [{ id: 'hanna@email.com', label: 'Hanna' }];
  const mockClient = {
    listEvents: async () => [{ summary: 'Yoga', start: { dateTime: '2026-08-04T18:00:00-07:00' }, recurringEventId: 'series123' }],
  };
  const result = await getUpcomingEvents({ calendarIds, calendarClient: mockClient });
  assert.ok(result.summary.includes('[Hanna] Yoga — Tue, Aug 4, 6:00 PM (recurring)'));
});

await asyncTest('getUpcomingEvents: an event with no recurringEventId is left unmarked (a one-off)', async () => {
  const calendarIds = [{ id: 'hanna@email.com', label: 'Hanna' }];
  const mockClient = {
    listEvents: async () => [{ summary: 'Dinner with Sam', start: { dateTime: '2026-08-05T19:00:00-07:00' } }],
  };
  const result = await getUpcomingEvents({ calendarIds, calendarClient: mockClient });
  assert.ok(result.summary.includes('[Hanna] Dinner with Sam — Wed, Aug 5, 7:00 PM'));
  assert.ok(!result.summary.includes('(recurring)'), 'a one-off event should not be tagged recurring');
});

console.log('All tests passed.');
