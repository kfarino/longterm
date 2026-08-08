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

// Only shows backed by a genuine signal from Kevin's own Spotify library
// (like/follow/playlist) count as "recommended" — basis: 'claude' is an LLM
// guess, not a real taste signal, and the current real match data ranges
// from score 97 down to 18 with everything below 84 being an LLM guess (see
// the design doc). Comedy shows have no Spotify-track equivalent.
export function filterQualifyingShows(matchData) {
  const shows = matchData?.shows || [];
  const seen = new Set();
  const artists = [];
  for (const s of shows) {
    if (s.kind !== 'music') continue;
    const kevinScore = s.scores?.kevin;
    if (!kevinScore || kevinScore.basis === 'claude') continue;
    // Trimmed first: normalizeArtistName's leading-"the"-strip is anchored to
    // the very start of the string, so untrimmed leading whitespace would
    // silently defeat it and produce a different dedup key for an otherwise
    // identical artist name.
    const key = normalizeArtistName(String(s.act || '').trim());
    if (seen.has(key)) continue;
    seen.add(key);
    artists.push(s.act);
  }
  return artists;
}

export async function resolveArtistTracks(accessToken, artistName, { spotifyClient = spotifyGet } = {}) {
  const searchResult = await spotifyClient(accessToken, 'search', { q: artistName, type: 'artist', limit: 1 });
  const artistId = searchResult?.artists?.items?.[0]?.id;
  if (!artistId) return [];
  const topTracks = await spotifyClient(accessToken, `artists/${artistId}/top-tracks`, { market: 'US' });
  return (topTracks?.tracks || []).slice(0, 3).map((t) => t.uri);
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
