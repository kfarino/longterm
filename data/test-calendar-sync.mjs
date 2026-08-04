// Longterm/data/test-calendar-sync.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// calendar-sync.mjs reconciliation with Google as source of truth: push of
// new/dirty locals, pull of remote cancels/edits/imports, legacy state
// migration. Mocked Calendar API — no real Google network calls. Run with:
//   node Longterm/data/test-calendar-sync.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSync, signature, migrateLegacyState, parseGoogleEvent, buildEventBody } from '../scripts/calendar-sync.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-sync-test-'));

async function asyncTest(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

function writeFixture(dir, { events, state } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const monthPlanEventsPath = path.join(dir, 'month_plan_events.json');
  const statePath = path.join(dir, 'calendar-sync-state.json');
  fs.writeFileSync(monthPlanEventsPath, JSON.stringify({ events: events ?? {} }, null, 2));
  if (state) fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  return { monthPlanEventsPath, statePath };
}

function mockCalendarClient(initialRemotes = []) {
  const calls = { createEvent: [], updateEvent: [], deleteEvent: [], listEvents: [] };
  let nextId = 1;
  let remotes = [...initialRemotes];
  return {
    calls,
    remotes,
    setRemotes(next) { remotes = next; this.remotes = remotes; },
    client: {
      async listEvents(calendarId, window) {
        calls.listEvents.push({ calendarId, window });
        return remotes;
      },
      async createEvent(calendarId, body) {
        calls.createEvent.push({ calendarId, body });
        const id = `gcal-${nextId++}`;
        const created = { id, status: 'confirmed', summary: body.summary, start: body.start, end: body.end, extendedProperties: body.extendedProperties };
        remotes = [...remotes.filter((r) => r.id !== id), created];
        return created;
      },
      async updateEvent(calendarId, eventId, body) {
        calls.updateEvent.push({ calendarId, eventId, body });
        const updated = { id: eventId, status: 'confirmed', summary: body.summary, start: body.start, end: body.end, extendedProperties: body.extendedProperties };
        remotes = remotes.map((r) => (r.id === eventId ? updated : r));
        return updated;
      },
      async deleteEvent(calendarId, eventId) {
        calls.deleteEvent.push({ calendarId, eventId });
        remotes = remotes.map((r) => (r.id === eventId ? { ...r, status: 'cancelled' } : r));
      },
    },
  };
}

function baseOpts(paths, extra = {}) {
  return {
    monthPlanEventsPath: paths.monthPlanEventsPath,
    statePath: paths.statePath,
    calendarId: 'test-calendar-id',
    dryRun: false,
    now: new Date('2026-08-04T17:00:00-07:00'),
    ...extra,
  };
}

console.log('test-calendar-sync.mjs');

await asyncTest('a new event (no prior state) creates a Calendar event and records its id + signature', async () => {
  const dir = path.join(tmpRoot, 'new-event');
  const paths = writeFixture(dir, {
    events: { '2026-08-05': [{ favoriteName: 'Test Bistro', tier: 'mid', cost: 60, kind: 'dining', source: 'manual' }] },
  });
  const { calls, client } = mockCalendarClient();
  const result = await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(result.created, 1);
  assert.equal(result.updated, 0);
  assert.equal(result.deleted, 0);
  assert.equal(calls.createEvent.length, 1);
  assert.equal(calls.createEvent[0].body.summary, 'Test Bistro ($60)');
  assert.equal(calls.createEvent[0].body.start.date, '2026-08-05');
  assert.ok(calls.createEvent[0].body.extendedProperties.private);
  assert.equal(calls.createEvent[0].body.extendedProperties.private.tier, 'mid');

  const onDisk = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  assert.equal(onDisk['gcal-1'].date, '2026-08-05');
  assert.ok(onDisk['gcal-1'].signature);

  const plan = JSON.parse(fs.readFileSync(paths.monthPlanEventsPath, 'utf8'));
  assert.equal(plan.events['2026-08-05'][0].googleEventId, 'gcal-1');
});

await asyncTest('an edited local event updates the existing Calendar event rather than creating a duplicate', async () => {
  const dir = path.join(tmpRoot, 'edited-event');
  const priorSignature = signature('2026-08-05', { favoriteName: 'Test Bistro', tier: 'mid', cost: 60, time: null, durationHours: null });
  const paths = writeFixture(dir, {
    events: { '2026-08-05': [{ favoriteName: 'Test Bistro', tier: 'mid', cost: 90, kind: 'dining', source: 'manual', googleEventId: 'gcal-existing' }] },
    state: { 'gcal-existing': { date: '2026-08-05', signature: priorSignature } },
  });
  const remote = {
    id: 'gcal-existing',
    status: 'confirmed',
    summary: 'Test Bistro ($60)',
    start: { date: '2026-08-05' },
    end: { date: '2026-08-06' },
    extendedProperties: { private: { kind: 'dining', tier: 'mid', cost: '60', source: 'manual', favoriteName: 'Test Bistro' } },
  };
  const { calls, client } = mockCalendarClient([remote]);
  const result = await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(result.created, 0);
  assert.equal(result.updated, 1);
  assert.equal(calls.createEvent.length, 0, 'must not create a duplicate for an already-tracked event');
  assert.equal(calls.updateEvent.length, 1);
  assert.equal(calls.updateEvent[0].eventId, 'gcal-existing');
  assert.equal(calls.updateEvent[0].body.summary, 'Test Bistro ($90)');
});

await asyncTest('a removed local event deletes the Calendar event and clears its state entry', async () => {
  const dir = path.join(tmpRoot, 'removed-event');
  const priorSignature = signature('2026-08-05', { favoriteName: 'Test Bistro', tier: 'mid', cost: 60 });
  const paths = writeFixture(dir, {
    events: { '2026-08-05': [] },
    state: { 'gcal-existing': { date: '2026-08-05', signature: priorSignature } },
  });
  const { calls, client } = mockCalendarClient([{
    id: 'gcal-existing',
    status: 'confirmed',
    summary: 'Test Bistro ($60)',
    start: { date: '2026-08-05' },
    end: { date: '2026-08-06' },
  }]);
  const result = await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(result.deleted, 1);
  assert.equal(calls.deleteEvent.length, 1);
  assert.equal(calls.deleteEvent[0].eventId, 'gcal-existing');

  const onDisk = JSON.parse(fs.readFileSync(paths.statePath, 'utf8'));
  assert.equal(onDisk['gcal-existing'], undefined);
});

await asyncTest('a sync with matching local+remote makes no create/update/delete calls (still lists)', async () => {
  const dir = path.join(tmpRoot, 'no-changes');
  const event = { favoriteName: 'Test Bistro', tier: 'mid', cost: 60, kind: 'dining', source: 'manual', googleEventId: 'gcal-existing', time: null };
  const sig = signature('2026-08-05', event);
  const paths = writeFixture(dir, {
    events: { '2026-08-05': [event] },
    state: { 'gcal-existing': { date: '2026-08-05', signature: sig } },
  });
  const remote = {
    id: 'gcal-existing',
    status: 'confirmed',
    summary: 'Test Bistro ($60)',
    start: { date: '2026-08-05' },
    end: { date: '2026-08-06' },
    extendedProperties: { private: { kind: 'dining', tier: 'mid', cost: '60', source: 'manual', favoriteName: 'Test Bistro' } },
  };
  const { calls, client } = mockCalendarClient([remote]);
  const result = await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(result.created, 0);
  assert.equal(result.updated, 0);
  assert.equal(result.deleted, 0);
  assert.ok(calls.listEvents.length >= 1);
  assert.equal(calls.createEvent.length, 0);
  assert.equal(calls.updateEvent.length, 0);
  assert.equal(calls.deleteEvent.length, 0);
});

await asyncTest('a timed event creates a Calendar event with a start/end dateTime, not an all-day date', async () => {
  const dir = path.join(tmpRoot, 'timed-event');
  const paths = writeFixture(dir, {
    events: { '2026-08-05': [{ favoriteName: 'Test Bistro', tier: 'mid', cost: 60, time: '17:00' }] },
  });
  const { calls, client } = mockCalendarClient();
  await runSync(baseOpts(paths, { calendarClient: client }));

  const body = calls.createEvent[0].body;
  assert.equal(body.start.dateTime, '2026-08-05T17:00:00');
  assert.equal(body.start.timeZone, 'America/Los_Angeles');
  assert.equal(body.end.dateTime, '2026-08-05T19:00:00', 'defaults to a 2-hour block');
  assert.equal(body.start.date, undefined);
});

await asyncTest('adding a time to a previously untimed event is treated as an update', async () => {
  const dir = path.join(tmpRoot, 'time-added-later');
  const untimedSignature = signature('2026-08-05', { favoriteName: 'Test Bistro', tier: 'mid', cost: 60, time: null });
  const paths = writeFixture(dir, {
    events: { '2026-08-05': [{ favoriteName: 'Test Bistro', tier: 'mid', cost: 60, time: '17:00', googleEventId: 'gcal-existing' }] },
    state: { 'gcal-existing': { date: '2026-08-05', signature: untimedSignature } },
  });
  const { calls, client } = mockCalendarClient([{
    id: 'gcal-existing',
    status: 'confirmed',
    summary: 'Test Bistro ($60)',
    start: { date: '2026-08-05' },
    end: { date: '2026-08-06' },
    extendedProperties: { private: { favoriteName: 'Test Bistro', tier: 'mid', cost: '60', kind: 'dining', source: 'manual' } },
  }]);
  const result = await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(result.updated, 1);
  assert.equal(calls.updateEvent[0].body.start.dateTime, '2026-08-05T17:00:00');
});

await asyncTest('an explicit durationHours overrides the 2-hour default block', async () => {
  const dir = path.join(tmpRoot, 'custom-duration');
  const paths = writeFixture(dir, {
    events: { '2026-08-05': [{ favoriteName: 'Test Bistro', tier: 'mid', cost: 60, time: '17:00', durationHours: 1.5 }] },
  });
  const { calls, client } = mockCalendarClient();
  await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(calls.createEvent[0].body.end.dateTime, '2026-08-05T18:30:00');
});

await asyncTest('multiple events on the same day are created independently', async () => {
  const dir = path.join(tmpRoot, 'multi-event-day');
  const paths = writeFixture(dir, {
    events: {
      '2026-08-08': [
        { favoriteName: 'Test Bistro', tier: 'mid', cost: 60 },
        { name: 'Movie night at home', tier: 'low-key', cost: 0 },
      ],
    },
  });
  const { calls, client } = mockCalendarClient();
  const result = await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(result.created, 2);
  assert.equal(calls.createEvent[0].body.summary, 'Test Bistro ($60)');
  assert.equal(calls.createEvent[1].body.summary, 'Movie night at home');
});

await asyncTest('Google cancel removes the event from the Month Plan and does not recreate it', async () => {
  const dir = path.join(tmpRoot, 'remote-cancel');
  const event = {
    source: 'manual', kind: 'family', name: 'Martha Wooding Birthday', tier: 'low-key', cost: 0,
    time: '12:00', durationHours: 1, googleEventId: 'gcal-martha',
  };
  const sig = signature('2026-08-20', event);
  const paths = writeFixture(dir, {
    events: {
      '2026-08-20': [
        event,
        { source: 'manual', kind: 'family', name: 'Free Press Dinner', tier: 'low-key', cost: 0, time: '18:30', durationHours: 3, googleEventId: 'gcal-freepress' },
      ],
    },
    state: {
      'gcal-martha': { date: '2026-08-20', signature: sig },
      'gcal-freepress': { date: '2026-08-20', signature: signature('2026-08-20', { name: 'Free Press Dinner', tier: 'low-key', cost: 0, time: '18:30', durationHours: 3 }) },
    },
  });
  const remotes = [
    { id: 'gcal-martha', status: 'cancelled', summary: 'Martha Wooding Birthday', start: { dateTime: '2026-08-20T12:00:00-07:00' }, end: { dateTime: '2026-08-20T13:00:00-07:00' } },
    {
      id: 'gcal-freepress', status: 'confirmed', summary: 'Free Press Dinner',
      start: { dateTime: '2026-08-20T18:30:00-07:00' }, end: { dateTime: '2026-08-20T21:30:00-07:00' },
      extendedProperties: { private: { kind: 'family', tier: 'low-key', cost: '0', source: 'manual', name: 'Free Press Dinner' } },
    },
  ];
  const { calls, client } = mockCalendarClient(remotes);
  const result = await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(result.removedFromPlan, 1);
  assert.equal(calls.createEvent.length, 0, 'must not recreate a Google-cancelled event');
  const plan = JSON.parse(fs.readFileSync(paths.monthPlanEventsPath, 'utf8'));
  assert.equal(plan.events['2026-08-20'].length, 1);
  assert.equal(plan.events['2026-08-20'][0].name, 'Free Press Dinner');
  assert.equal(JSON.parse(fs.readFileSync(paths.statePath, 'utf8'))['gcal-martha'], undefined);
});

await asyncTest('Google rename/time edit updates the Month Plan event', async () => {
  const dir = path.join(tmpRoot, 'remote-edit');
  const event = {
    source: 'manual', kind: 'family', name: 'PT', tier: 'low-key', cost: 0,
    time: '09:45', durationHours: 1, googleEventId: 'gcal-pt',
  };
  const sig = signature('2026-08-13', event);
  const paths = writeFixture(dir, {
    events: { '2026-08-13': [event] },
    state: { 'gcal-pt': { date: '2026-08-13', signature: sig } },
  });
  const remotes = [{
    id: 'gcal-pt',
    status: 'confirmed',
    summary: 'Physical Therapy',
    start: { dateTime: '2026-08-13T10:00:00-07:00' },
    end: { dateTime: '2026-08-13T11:00:00-07:00' },
    extendedProperties: { private: { kind: 'family', tier: 'low-key', cost: '0', source: 'manual', name: 'Physical Therapy' } },
  }];
  const { calls, client } = mockCalendarClient(remotes);
  const result = await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(result.editedFromRemote, 1);
  assert.equal(calls.updateEvent.length, 0, 'Google is SoT — do not push over a remote edit');
  const plan = JSON.parse(fs.readFileSync(paths.monthPlanEventsPath, 'utf8'));
  assert.equal(plan.events['2026-08-13'][0].name, 'Physical Therapy');
  assert.equal(plan.events['2026-08-13'][0].time, '10:00');
});

await asyncTest('a Google-only event is imported into the Month Plan', async () => {
  const dir = path.join(tmpRoot, 'remote-import');
  const paths = writeFixture(dir, { events: {} });
  const remotes = [{
    id: 'gcal-new',
    status: 'confirmed',
    summary: 'School open house',
    start: { dateTime: '2026-08-15T18:00:00-07:00' },
    end: { dateTime: '2026-08-15T19:30:00-07:00' },
  }];
  const { client } = mockCalendarClient(remotes);
  const result = await runSync(baseOpts(paths, { calendarClient: client }));

  assert.equal(result.imported, 1);
  const plan = JSON.parse(fs.readFileSync(paths.monthPlanEventsPath, 'utf8'));
  assert.equal(plan.events['2026-08-15'][0].name, 'School open house');
  assert.equal(plan.events['2026-08-15'][0].kind, 'schedule', 'Google-only imports default to schedule (not Month Plan spend)');
  assert.equal(plan.events['2026-08-15'][0].googleEventId, 'gcal-new');
  assert.equal(plan.events['2026-08-15'][0].durationHours, 1.5);
});

await asyncTest('legacy date|index state migrates to googleEventId keys and stamps events', async () => {
  const events = { '2026-08-05': [{ name: 'Dinner', tier: 'mid', cost: 60, time: '17:00' }] };
  const legacy = {
    '2026-08-05|0': {
      googleEventId: 'gcal-legacy',
      signature: signature('2026-08-05', { name: 'Dinner', tier: 'mid', cost: 60, time: '17:00' }),
    },
  };
  const { events: migratedEvents, state: migratedState } = migrateLegacyState(events, legacy);
  assert.equal(migratedEvents['2026-08-05'][0].googleEventId, 'gcal-legacy');
  assert.equal(migratedState['gcal-legacy'].date, '2026-08-05');
  assert.equal(migratedState['2026-08-05|0'], undefined);
});

await asyncTest('parseGoogleEvent preserves dining metadata from extendedProperties', async () => {
  const parsed = parseGoogleEvent({
    id: 'g1',
    status: 'confirmed',
    summary: 'Test Bistro ($75)',
    start: { dateTime: '2026-08-05T17:00:00-07:00' },
    end: { dateTime: '2026-08-05T19:00:00-07:00' },
    extendedProperties: { private: { kind: 'dining', tier: 'mid', cost: '75', source: 'manual', favoriteName: 'Test Bistro' } },
  });
  assert.equal(parsed.event.kind, 'dining');
  assert.equal(parsed.event.tier, 'mid');
  assert.equal(parsed.event.cost, 75);
  assert.equal(parsed.event.favoriteName, 'Test Bistro');
  assert.equal(parsed.event.time, '17:00');
  assert.equal(parsed.event.durationHours, 2);
});

await asyncTest('parseGoogleEvent converts Zulu dateTimes into America/Los_Angeles wall-clock', async () => {
  const parsed = parseGoogleEvent({
    id: 'g1',
    status: 'confirmed',
    summary: 'Evening thing',
    // 18:30 PDT on Aug 20 == 01:30Z on Aug 21
    start: { dateTime: '2026-08-21T01:30:00.000Z' },
    end: { dateTime: '2026-08-21T04:30:00.000Z' },
  });
  assert.equal(parsed.date, '2026-08-20');
  assert.equal(parsed.event.time, '18:30');
  assert.equal(parsed.event.durationHours, 3);
});

await asyncTest('buildEventBody writes extendedProperties.private', async () => {
  const body = buildEventBody('2026-08-05', { name: 'PT', kind: 'schedule', tier: 'low-key', cost: 0, time: '09:45', durationHours: 1, source: 'manual' });
  assert.equal(body.extendedProperties.private.kind, 'schedule');
  assert.equal(body.extendedProperties.private.name, 'PT');
});

console.log('All tests passed.');
