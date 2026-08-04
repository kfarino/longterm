// Finances/Longterm/scripts/calendar-read.mjs
// Read-only summary of upcoming events across specific Google Calendars —
// Kevin's personal calendar and Hanna's (shared with Kevin's Google
// account), deliberately excluding Kevin's work calendar
// (kevinfarino@herohealth.com). Powers both the bot's on-demand
// get_calendar_events tool (telegram-bot-poll.mjs) and the weekly recap's
// calendar section (telegram-bot-recap.mjs) — one shared module, not
// duplicated, since both are plain Node scripts with no browser boundary.
// Reuses calendar-sync.mjs's OAuth token refresh (same Google Cloud OAuth
// client + refresh token calendar-auth-setup.mjs already collects for the
// one-way push to "Family Planner") — reading needs no new scope, just its
// own list of calendar ids, which calendar-auth-setup.mjs also prompts for.
import fs from 'node:fs';
import { getAccessToken } from './calendar-sync.mjs';

const DEFAULT_CALENDAR_ENV_PATH = 'C:\\Users\\Family\\.longterm\\google-calendar.env';

function readLocalEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return values;
}

// GOOGLE_READ_CALENDAR_IDS is a plain comma-separated env value (same
// convention as every other credential in this file), each entry optionally
// tagged "id|Label" (e.g. "kevin@personal.com|Kevin,hanna@email.com|Hanna")
// so replies/recaps can show a human label instead of a raw calendar id.
export function parseReadCalendarIds(envValue) {
  if (!envValue) return [];
  return envValue.split(',').map((part) => part.trim()).filter(Boolean).map((part, i) => {
    const [id, label] = part.split('|');
    return { id: id.trim(), label: (label || `Calendar ${i + 1}`).trim() };
  });
}

// Resolves what get_calendar_events/the recap need to actually make calls:
// either a fully mocked calendarClient + pre-parsed calendarIds (test
// injection, bypassing real env/OAuth entirely — mirrors the
// anthropicClient/telegramClient injection convention used elsewhere), or
// the real config read from google-calendar.env. `configured: false` means
// "nothing to read yet" (no env file, or no GOOGLE_READ_CALENDAR_IDS set) —
// callers should degrade to a quiet "not set up" reply/skip, never throw.
export function loadCalendarReadContext(opts = {}) {
  if (opts.calendarReadClient) {
    return { calendarIds: opts.calendarReadCalendarIds || [], calendarClient: opts.calendarReadClient, configured: true };
  }
  const envPath = opts.calendarEnvPath || DEFAULT_CALENDAR_ENV_PATH;
  if (!fs.existsSync(envPath)) return { calendarIds: [], calendarClient: null, configured: false };
  try {
    const values = readLocalEnv(envPath);
    const calendarIds = parseReadCalendarIds(values.GOOGLE_READ_CALENDAR_IDS);
    if (!calendarIds.length) return { calendarIds: [], calendarClient: null, configured: false };
    return {
      calendarIds,
      configured: true,
      clientId: values.GOOGLE_CLIENT_ID,
      clientSecret: values.GOOGLE_CLIENT_SECRET,
      refreshToken: values.GOOGLE_REFRESH_TOKEN,
    };
  } catch {
    return { calendarIds: [], calendarClient: null, configured: false };
  }
}

function defaultCalendarReadClient(accessToken) {
  const base = 'https://www.googleapis.com/calendar/v3';
  return {
    async listEvents(calendarId, timeMinISO, timeMaxISO) {
      const url = new URL(`${base}/calendars/${encodeURIComponent(calendarId)}/events`);
      url.searchParams.set('timeMin', timeMinISO);
      url.searchParams.set('timeMax', timeMaxISO);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) throw new Error(`Calendar listEvents failed for ${calendarId}: ${res.status} ${await res.text()}`);
      const json = await res.json();
      return json.items || [];
    },
  };
}

// recurringEventId (2026-08-02) is Google's own signal that this event
// instance belongs to a recurring series — present only on occurrences of a
// recurring event, absent on a genuine one-off. Left unmarked when it's a
// one-off (the more common case for a personal calendar) so the tag only
// appears on the exception, not the default — the weekly recap uses this to
// call out one-off events specifically, since those are the ones worth
// advance awareness of.
function formatEventLine(label, event) {
  const title = event.summary || '(untitled)';
  const when = event.start && event.start.dateTime
    ? new Date(event.start.dateTime).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : (event.start && event.start.date);
  const recurringTag = event.recurringEventId ? ' (recurring)' : '';
  return `[${label}] ${title} — ${when}${recurringTag}`;
}

// Machine-comparable per-event shape (2026-08-02) — alongside the text
// summary above, used by get_dining_plan's calendar-coverage check (see
// telegram-bot-tools.mjs) to compare an occasion's date against the
// calendar without re-parsing the display string. `date`/`time` are in
// local time (not the raw ISO string) since that's what the rest of this
// project's date handling already assumes (see isoToday() elsewhere).
// `time` is null for an all-day event — deliberately not "00:00", so a
// caller can't mistake an all-day event for a midnight-timed one.
function toStructuredItem(label, event) {
  const isRecurring = !!event.recurringEventId;
  const title = event.summary || '(untitled)';
  if (event.start && event.start.dateTime) {
    const d = new Date(event.start.dateTime);
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return { label, title, date, time, isRecurring };
  }
  return { label, title, date: (event.start && event.start.date) || null, time: null, isRecurring };
}

// Fetches upcoming events across every configured calendar and returns both
// a plain-text summary (for a Telegram reply or the recap bundle) and the
// raw per-calendar results. A single calendar erroring (e.g. Hanna revokes
// sharing, a bad calendar id) is skipped rather than failing the whole
// summary — reported in `errors` for visibility, not silently swallowed.
export async function getUpcomingEvents({ calendarIds, days = 7, now = new Date(), calendarClient, clientId, clientSecret, refreshToken }) {
  const client = calendarClient || defaultCalendarReadClient(await getAccessToken({ clientId, clientSecret, refreshToken }));
  const timeMin = now.toISOString();
  const timeMax = new Date(now.getTime() + days * 86400000).toISOString();

  const items = [];
  const errors = [];
  for (const { id, label } of calendarIds) {
    try {
      const events = await client.listEvents(id, timeMin, timeMax);
      for (const event of events) items.push({ label, event, start: (event.start && (event.start.dateTime || event.start.date)) || '' });
    } catch (err) {
      errors.push({ label, error: err.message });
    }
  }
  items.sort((a, b) => a.start.localeCompare(b.start));

  const summary = items.length
    ? items.map((i) => formatEventLine(i.label, i.event)).join('\n')
    : `No events found in the next ${days} day(s).`;

  return { summary, items: items.map((i) => toStructuredItem(i.label, i.event)), count: items.length, errors };
}
