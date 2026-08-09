#!/usr/bin/env node
// Finances/Longterm/scripts/calendar-sync.mjs
// Reconciles Month Plan ↔ dedicated "Family Planner" Google Calendar.
// Google is source of truth: remote deletes/edits win; bot-originated local
// writes still push. Runs as the last step of the 2-minute LongtermTelegramPoll
// scheduled task.
//
// data/calendar-sync-state.json is keyed by googleEventId → { date, signature }.
// Each synced month_plan event carries googleEventId. Dining metadata (kind/
// tier/cost/source) is stored in Google extendedProperties.private so a
// Calendar title/time edit doesn't wipe budget fields on pull.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { googleCalendarEnvPath } from './longterm-paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDataDir = path.join(here, '..', 'data');

function parseArgs(argv) {
  const args = {
    envPath: googleCalendarEnvPath(),
    monthPlanEventsPath: path.join(repoDataDir, 'month_plan_events.json'),
    statePath: path.join(repoDataDir, 'calendar-sync-state.json'),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      i += 1;
      if (key === 'env-path') args.envPath = value;
      else if (key === 'month-plan-events-path') args.monthPlanEventsPath = value;
      else if (key === 'state-path') args.statePath = value;
      else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readLocalEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) throw new Error(`Missing env file: ${filePath}`);
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return values;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

function loadMonthPlanDoc(monthPlanEventsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(monthPlanEventsPath, 'utf8'));
    return { events: parsed.events || {} };
  } catch {
    return { events: {} };
  }
}

function loadState(statePath) {
  if (!fs.existsSync(statePath)) return {};
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}

function nextDay(dateStr) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function signature(date, event) {
  return JSON.stringify({
    date,
    name: event.favoriteName || event.name || null,
    kind: event.kind ?? null,
    tier: event.tier ?? null,
    cost: event.cost ?? null,
    time: event.time ?? null,
    durationHours: event.durationHours ?? null,
  });
}

const EVENT_TIMEZONE = 'America/Los_Angeles';
const DEFAULT_DURATION_HOURS = 2;

function pad(n) { return String(n).padStart(2, '0'); }

function toWallClockString(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`;
}

function timedEventSpan(date, time, durationHours) {
  const start = new Date(`${date}T${time}:00`);
  const hours = typeof durationHours === 'number' && durationHours > 0 ? durationHours : DEFAULT_DURATION_HOURS;
  const end = new Date(start.getTime() + hours * 60 * 60 * 1000);
  return {
    start: { dateTime: toWallClockString(start), timeZone: EVENT_TIMEZONE },
    end: { dateTime: toWallClockString(end), timeZone: EVENT_TIMEZONE },
  };
}

function privateProps(event) {
  const props = {
    kind: event.kind || 'schedule',
    tier: String(event.tier ?? 'low-key'),
    cost: String(typeof event.cost === 'number' ? event.cost : 0),
    source: event.source || 'manual',
  };
  if (event.favoriteName) props.favoriteName = event.favoriteName;
  if (event.name) props.name = event.name;
  if (event.recurrenceId) props.recurrenceId = event.recurrenceId;
  return props;
}

export function buildEventBody(date, event) {
  const name = event.favoriteName || event.name || 'Plan';
  const cost = typeof event.cost === 'number' && event.cost > 0 ? ` ($${Math.round(event.cost)})` : '';
  const summary = `${name}${cost}`;
  const body = event.time
    ? { summary, ...timedEventSpan(date, event.time, event.durationHours) }
    : { summary, start: { date }, end: { date: nextDay(date) } };
  body.extendedProperties = { private: privateProps(event) };
  return body;
}

function parseDurationHours(startMs, endMs) {
  const hours = (endMs - startMs) / (60 * 60 * 1000);
  if (!Number.isFinite(hours) || hours <= 0) return null;
  return Math.round(hours * 100) / 100;
}

function stripCostSuffix(summary) {
  if (!summary) return 'Plan';
  return summary.replace(/\s*\(\$\d+(?:\.\d+)?\)\s*$/, '').trim() || 'Plan';
}

/** Convert a Google dateTime to America/Los_Angeles wall-clock (host TZ independent). */
function wallClockInZone(dateTime, timeZone = EVENT_TIMEZONE) {
  const d = new Date(dateTime);
  if (Number.isNaN(d.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d).map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

/** Pure: Google Calendar event → Month Plan fields (+ id/status). */
export function parseGoogleEvent(gEvent) {
  const id = gEvent.id;
  const status = gEvent.status || 'confirmed';
  const priv = gEvent.extendedProperties?.private || {};
  let date;
  let time = null;
  let durationHours = null;

  if (gEvent.start?.date) {
    date = gEvent.start.date;
  } else if (gEvent.start?.dateTime) {
    const wall = wallClockInZone(gEvent.start.dateTime);
    if (!wall) return null;
    date = wall.date;
    time = wall.time;
    if (gEvent.end?.dateTime) {
      durationHours = parseDurationHours(
        new Date(gEvent.start.dateTime).getTime(),
        new Date(gEvent.end.dateTime).getTime(),
      );
    }
  } else {
    return null;
  }

  const favoriteName = priv.favoriteName || null;
  const name = priv.name || favoriteName || stripCostSuffix(gEvent.summary);
  const costRaw = priv.cost !== undefined ? Number(priv.cost) : 0;
  // Google-only imports default to schedule so they don't land on the
  // budget Month Plan until explicitly promoted to family/dining.
  const event = {
    source: priv.source || 'manual',
    kind: priv.kind || 'schedule',
    name,
    tier: priv.tier || 'low-key',
    cost: Number.isFinite(costRaw) ? costRaw : 0,
    time,
    googleEventId: id,
  };
  if (favoriteName) event.favoriteName = favoriteName;
  if (durationHours != null) event.durationHours = durationHours;
  if (priv.recurrenceId) event.recurrenceId = priv.recurrenceId;

  return { id, status, date, event };
}

function isoDate(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

export function syncWindow(events, state, now = new Date()) {
  const today = isoDate(now);
  let min = addDays(today, -7);
  let max = addDays(today, 120);
  for (const date of Object.keys(events)) {
    if (date < min) min = date;
    if (date > max) max = date;
  }
  for (const entry of Object.values(state)) {
    if (entry?.date && entry.date < min) min = entry.date;
    if (entry?.date && entry.date > max) max = entry.date;
  }
  return {
    timeMin: `${min}T00:00:00-07:00`,
    timeMax: `${addDays(max, 1)}T00:00:00-07:00`,
  };
}

/** Stamp googleEventId from state onto matching local events (signature / sole un-ided). */
function stampIdsFromState(events, state) {
  const next = structuredClone(events);
  for (const [id, entry] of Object.entries(state)) {
    if (!entry?.date) continue;
    const day = next[entry.date];
    if (!Array.isArray(day) || !day.length) continue;
    let idx = day.findIndex((e) => e.googleEventId === id);
    if (idx < 0) idx = day.findIndex((e) => !e.googleEventId && signature(entry.date, e) === entry.signature);
    if (idx < 0) {
      const unided = day.map((e, i) => [e, i]).filter(([e]) => !e.googleEventId);
      if (unided.length === 1) idx = unided[0][1];
    }
    if (idx >= 0) day[idx] = { ...day[idx], googleEventId: id };
  }
  return next;
}

/** Migrate legacy `date|index` state → googleEventId keys; stamp ids onto events. */
export function migrateLegacyState(events, state) {
  const nextEvents = structuredClone(events);
  const nextState = {};

  for (const [key, entry] of Object.entries(state)) {
    if (!entry) continue;
    if (key.includes('|') && entry.googleEventId) {
      const [date, indexStr] = key.split('|');
      const index = Number(indexStr);
      const day = nextEvents[date];
      if (Array.isArray(day) && day[index]) {
        day[index] = { ...day[index], googleEventId: entry.googleEventId };
      }
      nextState[entry.googleEventId] = {
        date: entry.date || date,
        signature: entry.signature,
      };
    } else if (!key.includes('|')) {
      nextState[key] = {
        date: entry.date,
        signature: entry.signature,
      };
    }
  }

  return { events: stampIdsFromState(nextEvents, nextState), state: nextState };
}

function flattenEvents(events) {
  const out = [];
  for (const [date, dayEvents] of Object.entries(events)) {
    (dayEvents || []).forEach((event, index) => {
      out.push({ date, index, event });
    });
  }
  return out;
}

function removeEventByGoogleId(events, googleEventId) {
  const next = { ...events };
  for (const [date, dayEvents] of Object.entries(next)) {
    if (!Array.isArray(dayEvents)) continue;
    const filtered = dayEvents.filter((e) => e.googleEventId !== googleEventId);
    if (filtered.length !== dayEvents.length) {
      next[date] = filtered;
    }
  }
  return next;
}

function upsertEvent(events, date, event) {
  const next = { ...events };
  const day = [...(next[date] || [])];
  const idx = day.findIndex((e) => e.googleEventId && e.googleEventId === event.googleEventId);
  if (idx >= 0) day[idx] = event;
  else day.push(event);
  next[date] = day;
  return next;
}

export async function getAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Google token refresh failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.access_token;
}

/** True for revoked/expired refresh tokens — not a transient Calendar blip. */
export function isGoogleAuthFailure(err) {
  const msg = String(err?.message || err || '');
  return /invalid_grant|expired or revoked|unauthorized_client/i.test(msg);
}

export function readCalendarAuthPause(pausePath) {
  if (!pausePath || !fs.existsSync(pausePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pausePath, 'utf8'));
  } catch {
    return null;
  }
}

export function writeCalendarAuthPause(pausePath, reason) {
  fs.mkdirSync(path.dirname(pausePath), { recursive: true });
  fs.writeFileSync(pausePath, `${JSON.stringify({
    at: new Date().toISOString(),
    reason: String(reason || 'Google auth failed'),
  }, null, 2)}\n`, 'utf8');
}

export function clearCalendarAuthPause(pausePath) {
  if (pausePath && fs.existsSync(pausePath)) fs.unlinkSync(pausePath);
}

function defaultCalendarClient(accessToken) {
  const base = 'https://www.googleapis.com/calendar/v3';
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` };
  return {
    async listEvents(calendarId, { timeMin, timeMax }) {
      const items = [];
      let pageToken;
      do {
        const params = new URLSearchParams({
          singleEvents: 'true',
          showDeleted: 'true',
          timeMin,
          timeMax,
          maxResults: '2500',
        });
        if (pageToken) params.set('pageToken', pageToken);
        const res = await fetch(`${base}/calendars/${encodeURIComponent(calendarId)}/events?${params}`, { headers });
        if (!res.ok) throw new Error(`Calendar listEvents failed: ${res.status} ${await res.text()}`);
        const json = await res.json();
        items.push(...(json.items || []));
        pageToken = json.nextPageToken;
      } while (pageToken);
      return items;
    },
    async createEvent(calendarId, body) {
      const res = await fetch(`${base}/calendars/${encodeURIComponent(calendarId)}/events`, { method: 'POST', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Calendar createEvent failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async updateEvent(calendarId, eventId, body) {
      const res = await fetch(`${base}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'PUT', headers, body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`Calendar updateEvent failed: ${res.status} ${await res.text()}`);
      return res.json();
    },
    async deleteEvent(calendarId, eventId) {
      const res = await fetch(`${base}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 410) throw new Error(`Calendar deleteEvent failed: ${res.status} ${await res.text()}`);
    },
  };
}

/** @deprecated Prefer runSync reconciliation. Kept for compatibility. */
export function diffPlanAgainstState(events, state) {
  const { events: migratedEvents, state: migratedState } = migrateLegacyState(events, state);
  const creates = [];
  const updates = [];
  const seenIds = new Set();
  for (const { date, event } of flattenEvents(migratedEvents)) {
    const sig = signature(date, event);
    if (!event.googleEventId) {
      creates.push({ date, event, signature: sig });
      continue;
    }
    seenIds.add(event.googleEventId);
    const existing = migratedState[event.googleEventId];
    if (!existing) creates.push({ date, event, signature: sig });
    else if (existing.signature !== sig) {
      updates.push({ date, event, signature: sig, googleEventId: event.googleEventId });
    }
  }
  const deletes = Object.keys(migratedState)
    .filter((id) => !seenIds.has(id))
    .map((id) => ({ googleEventId: id }));
  return { creates, updates, deletes };
}

export async function runSync(opts) {
  const args = { ...parseArgs([]), ...opts };
  const doc = loadMonthPlanDoc(args.monthPlanEventsPath);
  let { events, state } = migrateLegacyState(doc.events, loadState(args.statePath));

  let calendarClient = args.calendarClient;
  let calendarId = args.calendarId;
  if (!calendarClient) {
    const envValues = readLocalEnv(args.envPath);
    calendarId = calendarId || envValues.GOOGLE_CALENDAR_ID;
    const accessToken = await getAccessToken({
      clientId: args.clientId || envValues.GOOGLE_CLIENT_ID,
      clientSecret: args.clientSecret || envValues.GOOGLE_CLIENT_SECRET,
      refreshToken: args.refreshToken || envValues.GOOGLE_REFRESH_TOKEN,
    });
    calendarClient = defaultCalendarClient(accessToken);
  }

  const window = syncWindow(events, state, args.now);
  let remotes = args.remoteEvents || await calendarClient.listEvents(calendarId, window);
  const remoteById = new Map(remotes.map((r) => [r.id, r]));

  let removedFromPlan = 0;
  let imported = 0;
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let editedFromRemote = 0;

  // 1) Pull cancels — Google deleted → drop local (never recreate).
  for (const id of [...Object.keys(state)]) {
    const remote = remoteById.get(id);
    if (!remote || remote.status === 'cancelled') {
      events = removeEventByGoogleId(events, id);
      delete state[id];
      removedFromPlan += 1;
    }
  }
  for (const remote of remotes) {
    if (remote.status !== 'cancelled') continue;
    const before = flattenEvents(events).length;
    events = removeEventByGoogleId(events, remote.id);
    if (flattenEvents(events).length !== before) {
      delete state[remote.id];
      removedFromPlan += 1;
    }
  }

  // 2) Push dirty locals
  for (const { date, index, event } of flattenEvents(events)) {
    const sig = signature(date, event);
    if (!event.googleEventId) {
      const createdRemote = await calendarClient.createEvent(calendarId, buildEventBody(date, event));
      const stamped = { ...event, googleEventId: createdRemote.id };
      const day = [...(events[date] || [])];
      day[index] = stamped;
      events = { ...events, [date]: day };
      state[createdRemote.id] = { date, signature: sig };
      created += 1;
      continue;
    }
    const existing = state[event.googleEventId];
    if (!existing || existing.signature !== sig) {
      await calendarClient.updateEvent(calendarId, event.googleEventId, buildEventBody(date, event));
      state[event.googleEventId] = { date, signature: sig };
      updated += 1;
    }
  }

  const localIds = new Set(flattenEvents(events).map(({ event }) => event.googleEventId).filter(Boolean));
  for (const id of [...Object.keys(state)]) {
    if (localIds.has(id)) continue;
    await calendarClient.deleteEvent(calendarId, id);
    delete state[id];
    deleted += 1;
  }

  // 3) Re-list when we pushed, so pull sees fresh remotes
  if (created || updated || deleted) {
    remotes = args.remoteEventsAfterPush || await calendarClient.listEvents(calendarId, window);
  }

  // 4) Pull confirmed — Google edits + brand-new Google-only events
  for (const remote of remotes) {
    if (remote.status && remote.status !== 'confirmed') continue;
    const parsed = parseGoogleEvent(remote);
    if (!parsed) continue;

    const existing = flattenEvents(events).find(({ event }) => event.googleEventId === parsed.id);
    if (existing) {
      const merged = { ...existing.event, ...parsed.event, googleEventId: parsed.id };
      // Keep local dining metadata when Google has no extended props yet
      // (events created before this change).
      if (!remote.extendedProperties?.private) {
        if (existing.event.kind) merged.kind = existing.event.kind;
        if (existing.event.tier != null) merged.tier = existing.event.tier;
        if (existing.event.cost != null) merged.cost = existing.event.cost;
        if (existing.event.source) merged.source = existing.event.source;
        if (existing.event.favoriteName) merged.favoriteName = existing.event.favoriteName;
        if (existing.event.name && existing.event.kind === 'dining') merged.name = existing.event.name;
      }
      const remoteSig = signature(parsed.date, merged);
      const localSig = signature(existing.date, existing.event);
      if (remoteSig !== localSig || existing.date !== parsed.date) {
        if (existing.date !== parsed.date) {
          events = removeEventByGoogleId(events, parsed.id);
        }
        events = upsertEvent(events, parsed.date, merged);
        editedFromRemote += 1;
      }
      const finalFlat = flattenEvents(events).find(({ event }) => event.googleEventId === parsed.id);
      if (finalFlat) {
        state[parsed.id] = { date: finalFlat.date, signature: signature(finalFlat.date, finalFlat.event) };
      }
    } else {
      events = upsertEvent(events, parsed.date, parsed.event);
      state[parsed.id] = { date: parsed.date, signature: signature(parsed.date, parsed.event) };
      imported += 1;
    }
  }

  if (!args.dryRun) {
    writeJson(args.statePath, state);
    writeJson(args.monthPlanEventsPath, { events });
  }

  return {
    created,
    updated,
    deleted,
    imported,
    removedFromPlan,
    editedFromRemote,
    state,
    events,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runSync(args);
  console.log(JSON.stringify({
    ok: true,
    created: result.created,
    updated: result.updated,
    deleted: result.deleted,
    imported: result.imported,
    removedFromPlan: result.removedFromPlan,
    editedFromRemote: result.editedFromRemote,
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
