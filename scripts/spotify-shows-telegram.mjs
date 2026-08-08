#!/usr/bin/env node
// Resolves this week's taste-matched upcoming LA shows (music + comedy) to
// Spotify artist-page links and sends one Telegram message, one line per
// artist. Supersedes the auto-playlist approach — see
// docs/superpowers/specs/2026-08-08-spotify-shows-telegram-design.md for why:
// Spotify permanently blocked playlist-write access for this app's
// Development Mode registration (POST /users/{id}/playlists returned 403
// even with playlist-modify-private freshly granted; Extended Quota Mode,
// the only fix, requires a registered org with 250k+ MAU). An artist-*page*
// link needs no such scope — GET /search is, and always was, unrestricted.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getValidAccessToken, spotifyGet } from './spotify-client.mjs';
import { normalizeArtistName } from './spotify-pull.mjs';
import { telegramEnvPath } from './longterm-paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export function defaultMatchDataPath() {
  return path.join(repoRoot, 'data', 'spotify', 'show-matches-latest.json');
}

// Only shows backed by a genuine signal count as "recommended" —
// basis: 'claude' is an LLM guess, not a real taste signal (see the design
// doc). Comedy is included as of the Telegram redesign: an artist-*page*
// link (unlike a track) has no music-catalog requirement, and comedy's own
// basis is literally the string 'comedy' (from comedyTaste matching, not an
// LLM guess), so it already passes this same basis !== 'claude' check
// without a comedy-specific branch.
export function filterQualifyingShows(matchData) {
  const shows = matchData?.shows || [];
  const seen = new Set();
  const entries = [];
  for (const s of shows) {
    if (s.kind !== 'music' && s.kind !== 'comedy') continue;
    const kevinScore = s.scores?.kevin;
    if (!kevinScore || kevinScore.basis === 'claude') continue;
    // Trimmed first: normalizeArtistName's leading-"the"-strip is anchored to
    // the very start of the string, so untrimmed leading whitespace would
    // silently defeat it and produce a different dedup key for an otherwise
    // identical artist name.
    const key = normalizeArtistName(String(s.act || '').trim());
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ act: s.act, kind: s.kind, date: s.date, venue: s.venue, score: kevinScore.score, promoter: s.promoter || null });
  }
  return entries;
}

// Resolves an artist to their Spotify artist-*page* URL (GET /search?type=
// artist), not a track — this needs no scope beyond what was already
// granted, and never needs /artists/{id}/top-tracks (403'd, see below).
// MUST use the artist:"<name>" field-filter form: a bare-name query
// (`q: artistName`, no filter) was verified live to be unreliable — one test
// returned "Bill Burr" for "Anthony Jeselnik" — while the field-filter form
// was retested and correct twice. Comedians with released specials have real
// Spotify artist pages (verified live: Jeselnik, Patton Oswalt, Tig Notaro,
// Pete Holmes all resolve), so this works for both kinds this script handles.
export async function resolveArtistPageUrl(accessToken, artistName, { spotifyClient = spotifyGet } = {}) {
  const result = await spotifyClient(accessToken, 'search', { q: `artist:"${artistName}"`, type: 'artist', limit: 1 });
  const top = result?.artists?.items?.[0];
  return top?.external_urls?.spotify || null;
}

export async function buildArtistLinks(accessToken, entries, { spotifyClient = spotifyGet, log = () => {} } = {}) {
  const linked = [];
  for (const entry of entries) {
    try {
      const url = await resolveArtistPageUrl(accessToken, entry.act, { spotifyClient });
      if (!url) {
        log(`No Spotify artist match for "${entry.act}" — skipped.`);
        continue;
      }
      linked.push({ ...entry, url });
    } catch (err) {
      log(`Artist lookup failed for "${entry.act}" — skipped. (${err.message})`);
    }
  }
  return linked;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Formats a "YYYY-MM-DD" date-only string straight from its parts, not
// through a Date object. A Date built from a bare date string is UTC
// midnight; formatting it back out with a local-timezone method
// (toLocaleDateString) can roll the displayed day back by one anywhere west
// of UTC (e.g. Pacific). Splitting the string sidesteps that entirely.
export function formatShowDate(isoDate) {
  const [, month, day] = String(isoDate || '').split('-').map(Number);
  if (!month || !day) return isoDate || '';
  return `${MONTH_NAMES[month - 1]} ${day}`;
}

const KIND_EMOJI = { music: '🎸', comedy: '🤣' };

// Sorted by match score, strongest first — mirrors the same basis the
// dashboard's own recommendations are filtered/ranked by (scores.kevin.score),
// so "what am I most likely to want to go to" outranks "what's soonest."
// Ties broken by date (soonest first); a plain string comparison is safe
// there because every date is "YYYY-MM-DD" and lexicographic order matches
// chronological order for that format.
export function formatMessage(entries) {
  const sorted = [...entries].sort((a, b) => (b.score - a.score) || String(a.date).localeCompare(String(b.date)));
  return sorted
    .map((e) => {
      const lnTag = e.promoter === 'Live Nation' ? ' [LN]' : '';
      return `${KIND_EMOJI[e.kind] || KIND_EMOJI.music} ${e.act} (${e.score}%)${lnTag} — ${formatShowDate(e.date)} @ ${e.venue || 'TBD'}: ${e.url}`;
    })
    .join('\n');
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

async function callTelegram(token, method, body) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(`Telegram ${method} rejected: ${JSON.stringify(json)}`);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

function parseArgs(argv) {
  const args = {
    envPath: telegramEnvPath(),
    matchDataPath: defaultMatchDataPath(),
    ownerId: 'kevin',
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
      else if (key === 'match-data-path') args.matchDataPath = value;
      else if (key === 'owner') args.ownerId = value;
      else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

export async function runOnce(opts) {
  const args = { ...parseArgs([]), ...opts };
  const log = args.log || (() => {});

  const matchData = JSON.parse(fs.readFileSync(args.matchDataPath, 'utf8'));
  const qualifying = filterQualifyingShows(matchData);
  if (!qualifying.length) return { sent: false, reason: 'no_qualifying_shows' };

  const accessToken = args.accessToken || (await getValidAccessToken(args.ownerId));
  const linked = await buildArtistLinks(accessToken, qualifying, { spotifyClient: args.spotifyClient, log });
  if (!linked.length) return { sent: false, reason: 'no_artist_matches' };

  const text = formatMessage(linked);

  if (args.dryRun) return { sent: false, reason: 'dry_run', text, entryCount: linked.length };

  const envValues = args.token && args.groupChatId ? {} : readLocalEnv(args.envPath);
  const token = args.token || envValues.TELEGRAM_BOT_TOKEN;
  const groupChatId = args.groupChatId || envValues.TELEGRAM_GROUP_CHAT_ID;
  const telegramClient = args.telegramClient || callTelegram;
  await telegramClient(token, 'sendMessage', { chat_id: groupChatId, text });

  return { sent: true, text, entryCount: linked.length };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOnce(args);
  console.log(JSON.stringify({ ok: true, sent: result.sent, reason: result.reason || null, entryCount: result.entryCount || 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
