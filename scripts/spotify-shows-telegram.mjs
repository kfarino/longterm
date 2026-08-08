#!/usr/bin/env node
// Rebuilds a private Spotify playlist (Kevin's account) from this week's
// taste-matched upcoming LA music shows — see
// docs/superpowers/specs/2026-08-07-spotify-shows-playlist-design.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getValidAccessToken, spotifyGet, spotifyPost, spotifyPut } from './spotify-client.mjs';
import { normalizeArtistName } from './spotify-pull.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

export function defaultMatchDataPath() {
  return path.join(repoRoot, 'data', 'spotify', 'show-matches-latest.json');
}

export function defaultStatePath() {
  return path.join(repoRoot, 'data', 'spotify', 'show-playlist-state.json');
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
    entries.push({ act: s.act, kind: s.kind, date: s.date, venue: s.venue });
  }
  return entries;
}

// A direct track search (artist:"<name>" field filter), not the more obvious
// search-for-artist-id-then-GET-/artists/{id}/top-tracks. Verified live
// (2026-08-07): /artists/{id}/top-tracks returns 403 Forbidden on this app's
// registration — the same class of restriction the design spec already
// flagged for related-artists/recommendations, apparently extending to
// top-tracks too. Track search uses only /search, already confirmed working,
// and Spotify's own relevance ranking puts an artist's well-known songs
// first — same practical result, one API call instead of two.
export async function resolveArtistTracks(accessToken, artistName, { spotifyClient = spotifyGet } = {}) {
  const result = await spotifyClient(accessToken, 'search', { q: `artist:"${artistName}"`, type: 'track', limit: 3 });
  return (result?.tracks?.items || []).slice(0, 3).map((t) => t.uri);
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

export async function buildTrackList(accessToken, artistNames, { spotifyClient = spotifyGet, log = () => {} } = {}) {
  const uris = [];
  for (const name of artistNames) {
    try {
      const trackUris = await resolveArtistTracks(accessToken, name, { spotifyClient });
      if (!trackUris.length) {
        log(`No Spotify catalog match for "${name}" — skipped.`);
        continue;
      }
      uris.push(...trackUris);
    } catch (err) {
      log(`Track lookup failed for "${name}" — skipped. (${err.message})`);
    }
  }
  return [...new Set(uris)];
}

const PLAYLIST_NAME = 'LA Shows — This Week';
const PLAYLIST_DESCRIPTION = 'Auto-updated weekly from taste-matched upcoming LA shows — see the Dining + Shows tab.';

function loadState(statePath) {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}

function saveState(statePath, state) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

// First run: resolves the account's user id, creates a private playlist, and
// persists both. Every later run reuses the saved ids without an extra GET —
// only ensurePlaylist's caller (runPlaylistUpdate) knows to fall back to
// creating a new one if the saved playlist id turns out to be gone (404).
export async function ensurePlaylist(accessToken, {
  spotifyClient = spotifyGet, spotifyPostFn = spotifyPost, statePath = defaultStatePath(),
} = {}) {
  const existing = loadState(statePath);
  if (existing?.playlistId && existing?.userId) {
    return { playlistId: existing.playlistId, userId: existing.userId };
  }
  const userId = existing?.userId || (await spotifyClient(accessToken, 'me', {})).id;
  const created = await spotifyPostFn(accessToken, `users/${userId}/playlists`, {
    name: PLAYLIST_NAME,
    public: false,
    description: PLAYLIST_DESCRIPTION,
  });
  const state = { playlistId: created.id, userId };
  saveState(statePath, state);
  return state;
}

// Spotify's replace-tracks endpoint clears and resets the entire playlist in
// one call — this is what makes "replace entirely" a single request rather
// than a separate remove-then-add. An empty list is a legitimate, intended
// call (clears the playlist for a week with zero qualifying shows), not a
// case to special-case away.
export async function replacePlaylistTracks(accessToken, playlistId, uris, { spotifyPutFn = spotifyPut } = {}) {
  await spotifyPutFn(accessToken, `playlists/${playlistId}/tracks`, { uris });
}

export async function runPlaylistUpdate({
  ownerId = 'kevin',
  matchDataPath = defaultMatchDataPath(),
  statePath = defaultStatePath(),
  accessToken = null,
  spotifyClient = spotifyGet,
  spotifyPostFn = spotifyPost,
  spotifyPutFn = spotifyPut,
  log = console.log,
} = {}) {
  const token = accessToken || (await getValidAccessToken(ownerId));
  const matchData = JSON.parse(fs.readFileSync(matchDataPath, 'utf8'));
  const artists = filterQualifyingShows(matchData);
  const uris = await buildTrackList(token, artists, { spotifyClient, log });

  let { playlistId } = await ensurePlaylist(token, { spotifyClient, spotifyPostFn, statePath });
  try {
    await replacePlaylistTracks(token, playlistId, uris, { spotifyPutFn });
  } catch (err) {
    if (err.status !== 404) throw err;
    // The saved playlist was deleted out from under us (e.g. manually via the
    // Spotify app) — recreate rather than fail the whole weekly run. A 404
    // means the PLAYLIST is gone, not that we've forgotten who the user is:
    // keep the known userId in state (ensurePlaylist already skips its /me
    // call whenever userId is present, even with playlistId missing) so
    // recreating never needs an extra catalog lookup for information we
    // already have.
    log(`Saved playlist ${playlistId} is gone (404) — recreating.`);
    const priorState = loadState(statePath);
    saveState(statePath, { userId: priorState?.userId });
    ({ playlistId } = await ensurePlaylist(token, { spotifyClient, spotifyPostFn, statePath }));
    await replacePlaylistTracks(token, playlistId, uris, { spotifyPutFn });
  }

  return { playlistId, trackCount: uris.length, artistCount: artists.length };
}

async function main() {
  const result = await runPlaylistUpdate({});
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message || err); process.exit(1); });
}
