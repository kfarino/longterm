#!/usr/bin/env node
// Comprehensive Live Nation / Ticketmaster events pull for the LA metro —
// a structured API source (Live Nation owns Ticketmaster) that complements
// spotify-find-shows.mjs / upcoming-shows-pull.mjs's best-effort Claude+web-
// search discovery. See
// docs/superpowers/specs/2026-08-08-live-nation-shows-design.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ticketmasterEnvPath } from './longterm-paths.mjs';
import { dedupeShows } from './show-parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const cachePath = path.join(repoRoot, 'data', 'upcoming_shows_cache.json');
const venuesOverridePath = path.join(repoRoot, 'data', 'live-nation-venues.json');

// Brentwood-ish center; radius covers the venues this household actually
// ranges over (Westside through DTLA/Pasadena/Anaheim).
const LA_LATLONG = '34.0489,-118.4735';
const LA_RADIUS_MILES = 50;
const CLASSIFICATIONS = ['Music', 'Comedy'];
// House of Blues Concerts is a real Live Nation subsidiary promoter name
// that shows up in live Ticketmaster responses.
const LIVE_NATION_PROMOTER_RE = /live nation|house of blues concerts/i;

function parseEnvFile(envFilePath) {
  const vars = {};
  if (!fs.existsSync(envFilePath)) return vars;
  for (const line of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

export function loadApiKey(envPath = ticketmasterEnvPath()) {
  const env = parseEnvFile(envPath);
  if (!env.TICKETMASTER_API_KEY) {
    throw new Error(
      `Missing TICKETMASTER_API_KEY in ${envPath} — register a free app at developer.ticketmaster.com, ` +
      `then save TICKETMASTER_API_KEY=<key> there.`,
    );
  }
  return env.TICKETMASTER_API_KEY;
}

export function loadLiveNationVenueNames(filePath = venuesOverridePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return (data.venues || []).map((v) => String(v).toLowerCase());
  } catch {
    return [];
  }
}

export function isLiveNationEvent(event, knownVenueNames = []) {
  const promoterNames = [
    event?.promoter?.name,
    ...((event?.promoters || []).map((p) => p?.name)),
  ].filter(Boolean);
  if (promoterNames.some((name) => LIVE_NATION_PROMOTER_RE.test(name))) return true;
  const venueName = event?._embedded?.venues?.[0]?.name;
  if (venueName && knownVenueNames.includes(String(venueName).toLowerCase())) return true;
  return false;
}

export function mapEventToShow(event, knownVenueNames = []) {
  const act = event?._embedded?.attractions?.[0]?.name || event?.name || null;
  const venue = event?._embedded?.venues?.[0]?.name || null;
  const date = event?.dates?.start?.localDate || null;
  if (!act || !date) return null;
  const show = {
    act,
    venue: venue || '',
    date,
    sourceUrl: event?.url || null,
  };
  if (isLiveNationEvent(event, knownVenueNames)) show.promoter = 'Live Nation';
  return show;
}

export async function fetchClassificationEvents({ apiKey, classificationName, days, fetchImpl = fetch, maxPages = 10 }) {
  const today = new Date();
  const end = new Date(today.getTime() + days * 24 * 60 * 60 * 1000);
  const startDateTime = `${today.toISOString().slice(0, 19)}Z`;
  const endDateTime = `${end.toISOString().slice(0, 19)}Z`;
  const events = [];
  let page = 0;
  for (;;) {
    const params = new URLSearchParams({
      apikey: apiKey,
      latlong: LA_LATLONG,
      radius: String(LA_RADIUS_MILES),
      unit: 'miles',
      classificationName,
      startDateTime,
      endDateTime,
      size: '200',
      page: String(page),
    });
    const res = await fetchImpl(`https://app.ticketmaster.com/discovery/v2/events.json?${params}`);
    if (!res.ok) throw new Error(`Ticketmaster API error: ${res.status} ${await res.text()}`);
    const body = await res.json();
    const pageEvents = body?._embedded?.events || [];
    events.push(...pageEvents);
    const totalPages = body?.page?.totalPages ?? 1;
    page += 1;
    if (page >= totalPages || page >= maxPages || !pageEvents.length) break;
  }
  return events;
}

export async function fetchAllLiveNationEvents({ apiKey, days = 60, fetchImpl = fetch, maxPages = 10 }) {
  const all = [];
  for (const classificationName of CLASSIFICATIONS) {
    const events = await fetchClassificationEvents({ apiKey, classificationName, days, fetchImpl, maxPages });
    all.push(...events);
  }
  const seenIds = new Set();
  return all.filter((e) => {
    if (!e?.id || seenIds.has(e.id)) return false;
    seenIds.add(e.id);
    return true;
  });
}

function mergeIntoCache(shows, cachePathToUse) {
  let existing = { findings: [] };
  if (fs.existsSync(cachePathToUse)) {
    try {
      existing = JSON.parse(fs.readFileSync(cachePathToUse, 'utf8'));
    } catch {
      existing = { findings: [] };
    }
  }
  const findings = (existing.findings || []).filter((f) => f.label !== 'livenation');
  findings.push({ text: '', urls: [], label: 'livenation', shows });

  const allShows = dedupeShows([...(existing.shows || []), ...shows]);

  const cache = {
    ...existing,
    fetchedAt: new Date().toISOString(),
    findings,
    shows: allShows,
  };
  fs.mkdirSync(path.dirname(cachePathToUse), { recursive: true });
  fs.writeFileSync(cachePathToUse, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  return cache;
}

export async function runOnce({
  days = 60,
  fetchImpl = fetch,
  apiKey,
  cachePathOverride = cachePath,
  venuesOverridePathOverride = venuesOverridePath,
  log = console.log,
} = {}) {
  const key = apiKey || loadApiKey();
  const knownVenueNames = loadLiveNationVenueNames(venuesOverridePathOverride);
  const events = await fetchAllLiveNationEvents({ apiKey: key, days, fetchImpl });
  const shows = events.map((e) => mapEventToShow(e, knownVenueNames)).filter(Boolean);
  const liveNationCount = shows.filter((s) => s.promoter === 'Live Nation').length;
  const cache = mergeIntoCache(shows, cachePathOverride);
  log(`Live Nation pull: ${events.length} events fetched, ${shows.length} mapped, ${liveNationCount} flagged Live Nation. Wrote ${cachePathOverride}.`);
  return { eventCount: events.length, showCount: shows.length, liveNationCount, cache };
}

function parseArgs(argv) {
  let days = 60;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) days = Math.max(7, Number(argv[++i]) || 60);
  }
  return { days };
}

async function main() {
  const { days } = parseArgs(process.argv);
  await runOnce({ days });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
