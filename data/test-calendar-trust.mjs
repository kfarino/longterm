// Longterm/data/test-calendar-trust.mjs
//
// Permanent regression test (NOT a temp task script — do not delete).
//
// Covers the "the bot said it added it and it wasn't there" failure: Google auth
// expired, calendar sync paused itself permanently, nothing told anyone, and
// add_family_event kept replying "Added ✓" for writes that never left the
// machine — then stored the event twice when it was asked again.
//
// Everything here is a pure function or a temp-dir file operation: no network,
// no real data/ or ~/.longterm/ reads. Run with:
//   node Longterm/data/test-calendar-trust.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildReauthEnv } from '../scripts/calendar-auth-setup.mjs';
import { add_family_event } from '../scripts/telegram-bot-tools.mjs';
import { syncStatusReply, calendarCaveatText } from '../scripts/telegram-bot-poll.mjs';
import {
  shouldAlertForPause,
  buildPauseAlertText,
  countUnsyncedEvents,
  pauseAgeHours,
} from '../scripts/calendar-sync-alerts.mjs';
import {
  isCalendarAuthPauseActive,
  authRetryBackoffMs,
  writeCalendarAuthPause,
  readCalendarAuthPause,
  recordCalendarAuthPauseAlert,
} from '../scripts/calendar-sync.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calendar-trust-test-'));

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

console.log('test-calendar-trust.mjs');

// ---------------------------------------------------------------- re-auth ---

test('re-auth preserves the calendar id and read calendars, replacing only credentials', () => {
  const existing = {
    GOOGLE_CLIENT_ID: 'old-id',
    GOOGLE_CLIENT_SECRET: 'old-secret',
    GOOGLE_REFRESH_TOKEN: 'dead-token',
    GOOGLE_CALENDAR_ID: 'family-planner-calendar-id',
    GOOGLE_READ_CALENDAR_IDS: 'a@example.com|Adult 1,b@example.com|Adult 2',
  };
  const out = buildReauthEnv(existing, { clientId: 'new-id', clientSecret: 'new-secret', refreshToken: 'fresh-token' });

  // The whole point: re-running plain setup would mint a SECOND "Family Planner"
  // calendar and repoint the bot at it, stranding every already-synced event.
  assert.equal(out.GOOGLE_CALENDAR_ID, 'family-planner-calendar-id');
  assert.equal(out.GOOGLE_READ_CALENDAR_IDS, existing.GOOGLE_READ_CALENDAR_IDS);
  assert.equal(out.GOOGLE_REFRESH_TOKEN, 'fresh-token');
  assert.equal(out.GOOGLE_CLIENT_ID, 'new-id');
});

test('re-auth refuses to run without an existing calendar id to preserve', () => {
  assert.throws(
    () => buildReauthEnv({ GOOGLE_CLIENT_ID: 'x' }, { clientId: 'a', clientSecret: 'b', refreshToken: 'c' }),
    /GOOGLE_CALENDAR_ID/,
  );
});

// --------------------------------------------------------------- back-off ---

test('the auth-retry backoff escalates and then caps', () => {
  const hours = (ms) => ms / (60 * 60 * 1000);
  assert.equal(hours(authRetryBackoffMs(1)), 6);
  assert.equal(hours(authRetryBackoffMs(2)), 12);
  assert.equal(hours(authRetryBackoffMs(3)), 24);
  assert.equal(hours(authRetryBackoffMs(99)), 24, 'never grows past a day');
});

test('a pause is active before retryAfter and expired after it', () => {
  const pause = { retryAfter: '2026-08-12T06:00:00.000Z' };
  assert.equal(isCalendarAuthPauseActive(pause, new Date('2026-08-12T05:00:00Z')), true);
  assert.equal(isCalendarAuthPauseActive(pause, new Date('2026-08-12T07:00:00Z')), false);
});

test('a legacy pause with no retryAfter reads as expired, never as permanent', () => {
  // The exact shape the pre-backoff code wrote. Treating it as active is what
  // kept sync dead for three days with no way out but deleting the file.
  const legacy = { at: '2026-08-09T19:58:16.341Z', reason: 'Google token refresh failed: invalid_grant' };
  assert.equal(isCalendarAuthPauseActive(legacy, new Date('2026-08-12T00:00:00Z')), false);
  assert.equal(isCalendarAuthPauseActive(null, new Date()), false);
});

test('re-arming a pause preserves the outage start and bumps the failure count', () => {
  const pausePath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'pause-')), 'auth-pause.json');
  const first = writeCalendarAuthPause(pausePath, 'invalid_grant', { now: new Date('2026-08-12T00:00:00Z') });
  assert.equal(first.failureCount, 1);

  const second = writeCalendarAuthPause(pausePath, 'invalid_grant', { now: new Date('2026-08-12T07:00:00Z') });
  assert.equal(second.failureCount, 2);
  assert.equal(second.at, first.at, 'outage start is when it BROKE, not when it last retried');
  assert.ok(second.lastFailureAt > first.lastFailureAt);
  assert.equal(readCalendarAuthPause(pausePath).failureCount, 2);
});

// ---------------------------------------------------------------- alerting ---

test('alerting fires on the first failure, then at most once a day', () => {
  const t0 = new Date('2026-08-12T00:00:00Z');
  assert.equal(shouldAlertForPause({ at: t0.toISOString(), lastAlertAt: null }, t0), true);

  const alerted = { at: t0.toISOString(), lastAlertAt: t0.toISOString() };
  assert.equal(shouldAlertForPause(alerted, new Date('2026-08-12T06:00:00Z')), false, 'not every retry');
  assert.equal(shouldAlertForPause(alerted, new Date('2026-08-13T01:00:00Z')), true, 'but not silent forever');
  assert.equal(shouldAlertForPause(null, t0), false);
});

test('recording an alert survives a round-trip through the pause file', () => {
  const pausePath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'alert-')), 'auth-pause.json');
  writeCalendarAuthPause(pausePath, 'invalid_grant', { now: new Date('2026-08-12T00:00:00Z') });
  recordCalendarAuthPauseAlert(pausePath, new Date('2026-08-12T00:01:00Z'));
  const pause = readCalendarAuthPause(pausePath);
  assert.equal(pause.lastAlertAt, '2026-08-12T00:01:00.000Z');
  assert.equal(shouldAlertForPause(pause, new Date('2026-08-12T02:00:00Z')), false);
});

test('the alert names the fix and the size of the backlog', () => {
  const pause = { at: '2026-08-09T19:58:00.000Z', reason: 'invalid_grant' };
  const text = buildPauseAlertText(pause, { unsyncedCount: 3, now: new Date('2026-08-12T19:58:00.000Z') });
  assert.match(text, /--reauth-only/, 'plain setup would create a duplicate calendar — the flag is load-bearing');
  assert.match(text, /3 events/);
  assert.match(text, /3 day/);
});

test('pause age is reported in whole hours from the outage start', () => {
  const pause = { at: '2026-08-12T00:00:00.000Z' };
  assert.equal(pauseAgeHours(pause, new Date('2026-08-12T05:00:00Z')), 5);
  assert.equal(pauseAgeHours({}, new Date()), 0, 'a malformed pause reports 0, never NaN');
});

test('unsynced events are counted by missing googleEventId', () => {
  const doc = {
    events: {
      '2026-08-14': [{ name: 'Open — cook / low-key' }],
      '2026-08-18': [
        { name: 'PT', googleEventId: 'abc' },
        { name: 'Poker' },
      ],
    },
  };
  assert.equal(countUnsyncedEvents(doc), 2);
  assert.equal(countUnsyncedEvents({ events: {} }), 0);
  assert.equal(countUnsyncedEvents(null), 0);
});

// ------------------------------------------------------- honest confirmations ---

test('a caveat is added only when sync is actually broken', () => {
  assert.equal(calendarCaveatText({ state: 'synced' }), null);
  assert.equal(calendarCaveatText({ state: 'unconfigured' }), null, 'never set up is not a failure to announce');
  assert.equal(calendarCaveatText(null), null);
  assert.match(calendarCaveatText({ state: 'down' }), /NOT show up on your calendar/);
  assert.match(calendarCaveatText({ state: 'failed' }), /did not go through/);
});

test('get_sync_status reports real state instead of guessing', () => {
  const pausePath = path.join(fs.mkdtempSync(path.join(tmpRoot, 'status-')), 'auth-pause.json');
  const monthPlanEvents = { events: { '2026-08-18': [{ name: 'Poker' }, { name: 'PT', googleEventId: 'x' }] } };

  const healthy = syncStatusReply({ authPausePath: pausePath, monthPlanEvents, now: new Date() });
  assert.match(healthy, /working/);
  assert.match(healthy, /1 saved event/);

  writeCalendarAuthPause(pausePath, 'invalid_grant', { now: new Date('2026-08-12T00:00:00Z') });
  const down = syncStatusReply({ authPausePath: pausePath, monthPlanEvents, now: new Date('2026-08-12T05:00:00Z') });
  assert.match(down, /DOWN/);
  assert.match(down, /5 hour/);
  assert.match(down, /--reauth-only/);
  // The actual failure was inventing "check the calendar is visible" and
  // "stale event id". The reply must carry the real cause instead.
  assert.doesNotMatch(down, /visible|stale/i);
});

// ------------------------------------------------------------------ dedupe ---

test('adding the same event twice stores it once', () => {
  let doc = { events: {} };
  const args = { date: '2026-08-18', title: 'Poker', time: '7pm', durationHours: 4, kind: 'family' };

  const first = add_family_event(doc, { ...args });
  doc = first.monthPlanEvents;
  assert.match(first.reply, /Added ✓/);
  assert.equal(doc.events['2026-08-18'].length, 1);

  // Exactly what happened live: challenged, the model called the tool again.
  const second = add_family_event(doc, { ...args });
  doc = second.monthPlanEvents;
  assert.equal(doc.events['2026-08-18'].length, 1, 'a re-ask must not create a second calendar entry');
  assert.equal(second.duplicate, true);
  assert.match(second.reply, /Already on the plan/);
});

test('dedupe is per name+time, so a genuinely different event still lands', () => {
  let doc = { events: {} };
  doc = add_family_event(doc, { date: '2026-08-18', title: 'Poker', time: '7pm', kind: 'family' }).monthPlanEvents;
  doc = add_family_event(doc, { date: '2026-08-18', title: 'PT', time: '9:45am', kind: 'schedule' }).monthPlanEvents;
  doc = add_family_event(doc, { date: '2026-08-18', title: 'Poker', time: '10pm', kind: 'family' }).monthPlanEvents;
  assert.equal(doc.events['2026-08-18'].length, 3);
});

test('a time range is stored as a start plus a duration', () => {
  const { monthPlanEvents } = add_family_event({ events: {} }, {
    date: '2026-08-18', title: 'Poker', time: '7pm', durationHours: 4, kind: 'family',
  });
  const event = monthPlanEvents.events['2026-08-18'][0];
  assert.equal(event.time, '19:00');
  assert.equal(event.durationHours, 4, '"7-11" must survive as 7pm + 4h, or the calendar block is wrong');
});

console.log('All calendar-trust tests passed.');
