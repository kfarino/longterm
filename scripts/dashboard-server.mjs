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

export function createServer(eventsPath = defaultEventsPath, routineOverridesPath = defaultRoutineOverridesPath) {
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
