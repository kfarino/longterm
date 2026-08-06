#!/usr/bin/env node
// Venue-first upcoming-shows pull (same shape as the Telegram get_upcoming_shows
// cache write) — complements spotify-find-shows.mjs (artist-first).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { telegramEnvPath } from './longterm-paths.mjs';

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
  'You are researching upcoming live shows for a household assistant. You will be given venues (name and area). Use web search to find real upcoming shows/events at these venues within the given day window from today. Prioritize venues tagged area "westside" first. For each finding, report: venue name, act/event name, date (YYYY-MM-DD), and a source URL. If a venue has nothing found, do not mention it. Keep the reply a short list — no preamble.';

async function main() {
  const days = Number(process.argv.includes('--days') ? process.argv[process.argv.indexOf('--days') + 1] : 21) || 21;
  const env = parseEnvFile(telegramEnvPath());
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing in ~/.longterm/telegram.env');
  const venuesData = JSON.parse(fs.readFileSync(venuesPath, 'utf8'));
  const venues = venuesData.venues || [];
  if (!venues.length) throw new Error('No venues in venues_to_follow.json');

  const today = new Date().toISOString().slice(0, 10);
  const venueList = venues.map((v) => `${v.name} (${v.area}) — ${v.address}`).join('\n');
  console.log(`Searching ${venues.length} venues for next ${days} days from ${today}…`);

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
      messages: [{ role: 'user', content: `TODAY is ${today}. Only dates on/after today.\n\nVenues:\n${venueList}\n\nDay window: next ${days} days.` }],
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
  const prior = (existing.findings || []).filter((f) => f.label === 'spotify' || f.source === 'spotify' || (existing.source === 'spotify-find-shows' && !f.label));
  // Keep prior Spotify block if present, then venue block.
  const spotifyBlocks = (existing.findings || []).filter((f) => f.label === 'spotify' || existing.source === 'spotify-find-shows');
  const findings = [];
  if (spotifyBlocks.length) {
    for (const f of spotifyBlocks) findings.push({ ...f, label: f.label || 'spotify' });
  } else if (existing.source === 'spotify-find-shows' && existing.findings?.[0]) {
    findings.push({ ...existing.findings[0], label: 'spotify' });
  }
  findings.push(venueFinding);

  const cache = {
    fetchedAt: new Date().toISOString(),
    days,
    source: 'venues-and-spotify',
    findings,
  };
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${cachePath}`);
  console.log(text || '(empty)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
