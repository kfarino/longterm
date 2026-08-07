#!/usr/bin/env node
// Venue-first upcoming-shows pull (same shape as the Telegram get_upcoming_shows
// cache write) — complements spotify-find-shows.mjs (artist-first).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegramEnvPath } from './longterm-paths.mjs';
import { parseShowsFromText, dedupeShows } from './show-parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const venuesPath = path.join(repoRoot, 'data', 'venues_to_follow.json');
const cachePath = path.join(repoRoot, 'data', 'upcoming_shows_cache.json');

function parseEnvFile(envFilePath) {
  const vars = {};
  for (const line of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

const SYSTEM =
  'You are researching upcoming live MUSIC and COMEDY shows for a household assistant. ' +
  'You will be given venues with area, type, and household star rating (1–5 if rated). ' +
  'Use web search to find real upcoming shows/events within the day window. ' +
  'MUST cover both music rooms AND comedy rooms (Westside Comedy Theater, Fanatic Salon, Largo, Dynasty Typewriter, etc.) — ' +
  'do not return a music-only list. Prefer higher-rated venues when choosing which shows to report. ' +
  'At most 2–3 notable acts per venue; prioritize westside, then 5-star venues, then others. ' +
  'For each finding, report exactly one line: act — venue — YYYY-MM-DD — source URL. ' +
  'If a venue has nothing found, skip it. Short list only — no preamble.';

async function main() {
  const days = Number(process.argv.includes('--days') ? process.argv[process.argv.indexOf('--days') + 1] : 21) || 21;
  const env = parseEnvFile(telegramEnvPath());
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing in ~/.longterm/telegram.env');
  const venuesData = JSON.parse(fs.readFileSync(venuesPath, 'utf8'));
  const venues = venuesData.venues || [];
  if (!venues.length) throw new Error('No venues in venues_to_follow.json');

  const today = new Date().toISOString().slice(0, 10);
  const venueList = venues
    .map((v) => {
      const bits = [
        v.name,
        v.area ? `area:${v.area}` : null,
        v.type || v.category || null,
        v.rating != null ? `householdStars:${v.rating}/5` : 'householdStars:unrated',
      ].filter(Boolean);
      return bits.join(' · ');
    })
    .join('\n');
  console.log(`Searching ${venues.length} venues (music + comedy) for next ${days} days from ${today}…`);

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      system: SYSTEM,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10, allowed_callers: ['direct'] }],
      messages: [{
        role: 'user',
        content:
          `TODAY is ${today}. Only dates on/after today.\n\n` +
          `Venues (include comedy AND music; favor higher householdStars):\n${venueList}\n\n` +
          `Day window: next ${days} days.\n` +
          `Return a mix — if comedy calendars have dates in-window, include them.`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  const response = await res.json();
  const text = (response.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
  const urls = [];
  for (const block of response.content || []) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result.url && !urls.includes(result.url)) urls.push(result.url);
    }
  }

  let existing = { findings: [] };
  if (fs.existsSync(cachePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      existing = { findings: [] };
    }
  }

  const venueFinding = { text: text || 'No shows found at followed venues in this window.', urls, label: 'venues' };
  // Keep prior Spotify block if present, then venue block.
  const spotifyBlocks = (existing.findings || []).filter((f) => f.label === 'spotify' || existing.source === 'spotify-find-shows');
  const findings = [];
  if (spotifyBlocks.length) {
    for (const f of spotifyBlocks) findings.push({ ...f, label: f.label || 'spotify' });
  } else if (existing.source === 'spotify-find-shows' && existing.findings?.[0]) {
    findings.push({ ...existing.findings[0], label: 'spotify' });
  }
  findings.push(venueFinding);

  const shows = dedupeShows(
    findings.flatMap((f) =>
      parseShowsFromText(f.text, f.urls).map((s) => ({ ...s, label: f.label || null })),
    ),
  );

  const cache = {
    fetchedAt: new Date().toISOString(),
    days,
    source: 'venues-and-spotify',
    findings,
    shows,
  };
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${cachePath} (${shows.length} structured shows)`);
  console.log(text || '(empty)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
