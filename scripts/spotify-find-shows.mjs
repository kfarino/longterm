#!/usr/bin/env node
// Use Spotify taste (followed artists first) + Anthropic web_search to find
// upcoming LA-metro shows, then write data/upcoming_shows_cache.json in the
// same shape the Telegram bot / Dining+Shows tab already reads.
//
// Spotify itself has no concert calendar — this is taste → live web research.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { telegramEnvPath } from './longterm-paths.mjs';
import {
  mergeFindingsPreservingLivenation,
  discoveryShowsFromFindings,
  rebuildShowsWithLivenation,
} from './shows-cache.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tasteDir = path.join(repoRoot, 'data', 'spotify');
const cachePath = path.join(repoRoot, 'data', 'upcoming_shows_cache.json');
const venuesPath = path.join(repoRoot, 'data', 'venues_to_follow.json');

function parseArgs(argv) {
  let owners = null;
  let days = 60;
  let limit = 40;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owners' && argv[i + 1]) owners = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--owner' && argv[i + 1]) owners = [argv[++i]];
    else if (a === '--days' && argv[i + 1]) days = Math.max(7, Number(argv[++i]) || 60);
    else if (a === '--limit' && argv[i + 1]) limit = Math.max(5, Number(argv[++i]) || 40);
  }
  return { owners, days, limit };
}

function parseEnvFile(envFilePath) {
  const vars = {};
  for (const line of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function loadApiKey() {
  const envPath = telegramEnvPath();
  if (!fs.existsSync(envPath)) throw new Error(`Missing ${envPath} (need ANTHROPIC_API_KEY)`);
  const env = parseEnvFile(envPath);
  if (!env.ANTHROPIC_API_KEY) throw new Error(`${envPath} missing ANTHROPIC_API_KEY`);
  return env.ANTHROPIC_API_KEY;
}

function loadTaste(ownerId) {
  const p = path.join(tasteDir, `${ownerId}-taste.json`);
  if (!fs.existsSync(p)) {
    throw new Error(`Missing ${p} — run: node scripts/spotify-pull.mjs --owner ${ownerId}`);
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function followedArtists(taste, limit) {
  const followed = (taste.artists || []).filter((a) =>
    (a.sources || []).some((s) => s.type === 'followed'),
  );
  // Prefer names that also show up in liked/playlist (stronger intentional signal).
  followed.sort((a, b) => {
    const score = (x) =>
      (x.sources || []).reduce((n, s) => {
        if (s.type === 'followed') return n + 100;
        if (s.type === 'liked') return n + Math.min(20, s.trackCount || 1);
        if (s.type === 'playlist') return n + Math.min(10, s.trackCount || 1);
        return n;
      }, 0);
    return score(b) - score(a) || a.name.localeCompare(b.name);
  });
  return followed.slice(0, limit);
}

function venueHintNames() {
  if (!fs.existsSync(venuesPath)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(venuesPath, 'utf8'));
    return (data.venues || []).map((v) => v.name).filter(Boolean).slice(0, 25);
  } catch {
    return [];
  }
}

const SYSTEM_PROMPT =
  'You are researching upcoming live music shows for a Los Angeles household (Brentwood / Westside preferred, but any real LA-metro date is fine). ' +
  'You will get a list of artists the household follows on Spotify and TODAY\'S DATE. Use web search to find real upcoming concerts/tour dates for these artists in the Los Angeles metro (LA, Hollywood, Santa Monica, Inglewood, Pasadena, Anaheim OK). ' +
  'CRITICAL: Only include shows whose date is on or after TODAY. Never list past dates. If a search result shows a 2026 date earlier than today, discard it. ' +
  'For each finding report exactly one line: act — venue — YYYY-MM-DD — source URL. ' +
  'Only report shows you actually found with a credible source — do not invent. Prefer Ticketmaster, venue sites, Songkick, Bandsintown, Live Nation. ' +
  'Do not write preambles, "I\'ll search", or "no shows found" lists for artists with nothing — only the positive findings lines (or a single line saying none found).';

async function callAnthropicArtistShows({ apiKey, artists, days, venueNames }) {
  const today = new Date().toISOString().slice(0, 10);
  const artistList = artists.map((a) => a.name).join('\n');
  const venueHint = venueNames.length
    ? `\n\nHousehold venue shortlist (optional preference, not a hard filter):\n${venueNames.join('\n')}`
    : '';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      thinking: { type: 'disabled' },
      system: SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 10, allowed_callers: ['direct'] }],
      messages: [
        {
          role: 'user',
          content:
            `TODAY is ${today}. Only shows on or after ${today}. Window: next ${days} days (through roughly then).\n\n` +
            `Artists (Spotify follows, strongest first):\n${artistList}` +
            venueHint,
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  const { owners: ownersArg, days, limit } = parseArgs(process.argv);
  const owners = ownersArg || ['kevin'];
  const apiKey = loadApiKey();

  /** @type {Map<string, object>} */
  const byId = new Map();
  for (const ownerId of owners) {
    const taste = loadTaste(ownerId);
    for (const a of followedArtists(taste, limit)) {
      if (!byId.has(a.id)) byId.set(a.id, a);
    }
    console.log(`Loaded taste for ${ownerId}: using up to ${limit} followed artists (merged unique so far: ${byId.size})`);
  }

  const artists = [...byId.values()];
  if (!artists.length) {
    console.error('No followed artists in taste files — follow some artists on Spotify, then re-pull.');
    process.exit(1);
  }

  console.log(`Searching LA shows for ${artists.length} artists over next ${days} days…`);
  const response = await callAnthropicArtistShows({
    apiKey,
    artists,
    days,
    venueNames: venueHintNames(),
  });

  const text = (response.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n')
    .trim();
  const urls = [];
  for (const block of response.content || []) {
    if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
    for (const result of block.content) {
      if (result.url && !urls.includes(result.url)) urls.push(result.url);
    }
  }

  const today = new Date().toISOString().slice(0, 10);
  const cleanedLines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!l || l.startsWith('I\'ll ') || l.startsWith('Based on ') || l.startsWith('Note:')) return false;
      const m = l.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
      if (!m) return false;
      return m[1] >= today;
    });
  const cleanedText = cleanedLines.length
    ? cleanedLines.join('\n')
    : 'No confirmed LA dates on/after today in this window for your followed artists (web results were empty or only past dates).';

  let existing = {};
  if (fs.existsSync(cachePath)) {
    try {
      existing = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    } catch {
      existing = {};
    }
  }
  // Keep prior venue + Live Nation blocks across a mid-week artist re-pull.
  // Weekly order re-runs venues/LN after this step; preserving here stops a
  // lone `spotify:find-shows` from wiping promoter tags the badge needs.
  const priorVenues = (existing.findings || []).filter((f) => f.label === 'venues');
  const discoveryFindings = [
    { text: cleanedText, urls, label: 'spotify' },
    ...priorVenues,
  ];
  const findings = mergeFindingsPreservingLivenation(discoveryFindings, existing);
  const discoveryShows = discoveryShowsFromFindings(findings);
  const shows = rebuildShowsWithLivenation(discoveryShows, { findings, shows: existing.shows });

  const cache = {
    fetchedAt: new Date().toISOString(),
    days,
    source: 'spotify-find-shows',
    owners,
    artistCount: artists.length,
    findings,
    shows,
  };
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${cachePath}`);
  console.log('\n--- findings ---\n');
  console.log(cleanedText);
  if (urls.length) {
    console.log('\n--- sources ---');
    for (const u of urls.slice(0, 8)) console.log(u);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
