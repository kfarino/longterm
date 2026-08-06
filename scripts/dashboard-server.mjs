#!/usr/bin/env node
// Finances/Longterm/scripts/dashboard-server.mjs
// Minimal local HTTP server replacing dashboard_v5.html's old file:// launch.
// Browser JS loaded via file:// cannot fetch() local JSON (a browser security
// restriction, not an oversight) — that's exactly why Month Plan's calendar
// used localStorage before. Serving over http:// lets the dashboard instead
// call this server's small JSON API to read data/month_plan_events.json —
// GET-only, since the dashboard is a pure display now (planning happens via
// the Telegram bot, which reads/writes that file directly; see
// dining-recommendation.mjs / Part 3).
//
// Localhost-only by design (binds 127.0.0.1) — no authentication, since this
// serves real financial data and is not meant to be reachable from the
// network. Launch with `npm run dev` from this directory.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const defaultEventsPath = path.join(repoRoot, 'data', 'month_plan_events.json');
const defaultRoutineOverridesPath = path.join(repoRoot, 'data', 'dining-routine-overrides.json');
const defaultFavoriteRawPath = path.join(repoRoot, 'data', 'favorite_places_raw.json');
const defaultFavoritePlacesPath = path.join(repoRoot, 'data', 'favorite_places.json');
const defaultVenuesToFollowPath = path.join(repoRoot, 'data', 'venues_to_follow.json');
const defaultUpcomingShowsCachePath = path.join(repoRoot, 'data', 'upcoming_shows_cache.json');
const PORT = Number(process.env.PORT) || 4200;
const EMPTY_ROUTINE_OVERRIDES = { family_dinner: null, date_night: null, weekend_social: null };

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css' };

export function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

export function readEvents(eventsPath) {
  if (!fs.existsSync(eventsPath)) return { events: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));
    return { events: parsed.events || {} };
  } catch {
    return { events: {} };
  }
}

// Bot-owned file (see telegram-bot-tools.mjs's set_routine_day) — the
// dashboard only ever reads this live and applies it to D.diningRoutine at
// render time (see dashboard_v5.html's effectiveDiningRoutine()); it never
// writes here itself, so there's no PUT-side validation to add beyond
// staying consistent with the GET shape.
export function readRoutineOverrides(routineOverridesPath) {
  if (!fs.existsSync(routineOverridesPath)) return { ...EMPTY_ROUTINE_OVERRIDES };
  try {
    return { ...EMPTY_ROUTINE_OVERRIDES, ...JSON.parse(fs.readFileSync(routineOverridesPath, 'utf8')) };
  } catch {
    return { ...EMPTY_ROUTINE_OVERRIDES };
  }
}

export function readUpcomingShowsCache(cachePath) {
  if (!fs.existsSync(cachePath)) return { fetchedAt: null, days: null, findings: [] };
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return { fetchedAt: null, days: null, findings: [] };
  }
}

export function readVenuesToFollow(venuesPath) {
  if (!fs.existsSync(venuesPath)) return { venues: [], weekendSocialSpots: {} };
  try {
    return JSON.parse(fs.readFileSync(venuesPath, 'utf8'));
  } catch {
    return { venues: [], weekendSocialSpots: {} };
  }
}

// Live read of favorite_places.json (2026-08-05) — the Dining + Shows
// dashboard tab used to render from D.favoritePlaces, a build-time snapshot
// bundled into data/data.js by build-data.mjs, so a rating written via
// POST /api/rate-place never showed as re-rated until the next nightly
// data.js rebuild. Reading this live means a star rating is visible on the
// very next page reload. Same missing-file/corrupt-file degrade-quietly
// shape as readVenuesToFollow above.
export function readFavoritePlaces(favoritePlacesPath) {
  if (!fs.existsSync(favoritePlacesPath)) return { places: [], recentDiningActivity: [] };
  try {
    return JSON.parse(fs.readFileSync(favoritePlacesPath, 'utf8'));
  } catch {
    return { places: [], recentDiningActivity: [] };
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(raw || '{}')); }
      catch (err) { reject(err); }
    });
    req.on('error', reject);
  });
}

// Patches a `rating` (1-5) field onto the matching entry, by exact name, in
// both the hand-maintained source-of-truth file and its build-time-bundled
// derivative, so the change is visible without needing a full Monarch-driven
// refreshFavoritePlaces regeneration — mirrors telegram-bot-tools.mjs's
// update_phase_expense writing straight into goals.json, no separate review
// gate. Returns true if a match was found and patched, false otherwise
// (caller sends 404).
export function ratePlace(rawPath, favoritePlacesPath, name, rating) {
  if (!fs.existsSync(rawPath)) return false;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(rawPath, 'utf8'));
  } catch {
    return false;
  }
  const rawEntry = raw.find((p) => p.name === name);
  if (!rawEntry) return false;
  rawEntry.rating = rating;
  writeJsonAtomic(rawPath, raw);

  if (fs.existsSync(favoritePlacesPath)) {
    try {
      const fp = JSON.parse(fs.readFileSync(favoritePlacesPath, 'utf8'));
      const place = (fp.places || []).find((p) => p.name === name);
      if (place) place.rating = rating;
      writeJsonAtomic(favoritePlacesPath, fp);
    } catch {
      // The raw file (the real source of truth) was already patched above;
      // a corrupt derivative file just means it stays stale rather than
      // crashing the request — the next full regeneration re-syncs it.
    }
  }
  return true;
}

// Same idea for venues_to_follow.json — a name can be in the top-level
// `venues` array or nested inside `weekendSocialSpots.<area>`, so this checks
// both shapes rather than assuming one.
export function rateVenue(venuesPath, name, rating) {
  if (!fs.existsSync(venuesPath)) return false;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(venuesPath, 'utf8'));
  } catch {
    return false;
  }
  let entry = (data.venues || []).find((v) => v.name === name);
  if (!entry && data.weekendSocialSpots) {
    for (const area of Object.values(data.weekendSocialSpots)) {
      if (!Array.isArray(area)) continue;
      const found = area.find((v) => v.name === name);
      if (found) { entry = found; break; }
    }
  }
  if (!entry) return false;
  entry.rating = rating;
  writeJsonAtomic(venuesPath, data);
  return true;
}

function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': buf.length });
  res.end(buf);
}

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(req.url.split('?')[0]);
  if (reqPath === '/') reqPath = '/dashboard_v5.html';
  const filePath = path.join(repoRoot, reqPath);
  // Prevent path traversal outside the repo root.
  if (!filePath.startsWith(repoRoot)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

export function createServer(
  eventsPath = defaultEventsPath,
  routineOverridesPath = defaultRoutineOverridesPath,
  favoriteRawPath = defaultFavoriteRawPath,
  favoritePlacesPath = defaultFavoritePlacesPath,
  venuesToFollowPath = defaultVenuesToFollowPath,
  upcomingShowsCachePath = defaultUpcomingShowsCachePath,
) {
  return http.createServer(async (req, res) => {
    const urlPath = req.url.split('?')[0];

    // GET-only — the dashboard no longer edits Month Plan (that happens via
    // the Telegram bot, which writes month_plan_events.json directly), so
    // there is no PUT route here anymore.
    if (urlPath === '/api/month-plan-events' && req.method === 'GET') {
      sendJson(res, 200, readEvents(eventsPath));
      return;
    }

    // Read-only from the dashboard's side — only the bot's set_routine_day
    // writes this file. No PUT route by design.
    if (urlPath === '/api/dining-routine-overrides' && req.method === 'GET') {
      sendJson(res, 200, readRoutineOverrides(routineOverridesPath));
      return;
    }

    if (urlPath === '/api/upcoming-shows-cache' && req.method === 'GET') {
      sendJson(res, 200, readUpcomingShowsCache(upcomingShowsCachePath));
      return;
    }

    if (urlPath === '/api/venues-to-follow' && req.method === 'GET') {
      sendJson(res, 200, readVenuesToFollow(venuesToFollowPath));
      return;
    }

    // Read-only, live — see readFavoritePlaces above for why this exists
    // alongside the build-time D.favoritePlaces snapshot the dashboard used
    // to render from exclusively.
    if (urlPath === '/api/favorite-places' && req.method === 'GET') {
      sendJson(res, 200, readFavoritePlaces(favoritePlacesPath));
      return;
    }

    // The one write route in this server — see ratePlace/rateVenue above for
    // why it patches two files for a restaurant rating but one for a venue.
    if (urlPath === '/api/rate-place' && req.method === 'POST') {
      let body;
      try {
        body = await readJsonBody(req);
      } catch {
        res.writeHead(400); res.end('Invalid JSON body'); return;
      }
      const { name, rating, kind } = body;
      if (!name || typeof name !== 'string' || !Number.isInteger(rating) || rating < 1 || rating > 5 || (kind !== 'restaurant' && kind !== 'venue')) {
        res.writeHead(400); res.end('Body must be { name: string, rating: 1-5 integer, kind: "restaurant"|"venue" }'); return;
      }
      const ok = kind === 'restaurant'
        ? ratePlace(favoriteRawPath, favoritePlacesPath, name, rating)
        : rateVenue(venuesToFollowPath, name, rating);
      if (!ok) { res.writeHead(404); res.end(`No ${kind} found named "${name}"`); return; }
      sendJson(res, 200, { ok: true, name, rating, kind });
      return;
    }

    if (req.method !== 'GET') { res.writeHead(405); res.end('Method not allowed'); return; }
    serveStatic(req, res);
  });
}

function main() {
  const server = createServer();
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Dashboard server running at http://localhost:${PORT}/dashboard_v5.html`);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
