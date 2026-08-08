#!/usr/bin/env node
// Pull intentional Spotify taste for one or all owners who have tokens.
// Writes data/spotify/<ownerId>-taste.json (gitignored) and prints an inventory.
// Signals: followed artists + liked-track artists + owned-playlist artists
// (see docs/superpowers/specs/2026-08-05-spotify-taste-show-matching-design.md).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getValidAccessToken, spotifyGet } from './spotify-client.mjs';
import { spotifyOwnerEnvPath } from './longterm-paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'data', 'spotify');

function parseArgs(argv) {
  let ownerId = null;
  let all = false;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--owner' && argv[i + 1]) ownerId = argv[++i];
    else if (a === '--all') all = true;
  }
  return { ownerId, all };
}

function loadOwnerIdsFromGoals() {
  const goalsPath = path.join(repoRoot, 'data', 'goals.json');
  if (!fs.existsSync(goalsPath)) return [];
  const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  return (goals.owners || []).map((o) => o.id).filter(Boolean);
}

function ownersWithTokens() {
  const fromGoals = loadOwnerIdsFromGoals();
  const ids = fromGoals.length ? fromGoals : ['kevin', 'hanna'];
  return ids.filter((id) => fs.existsSync(spotifyOwnerEnvPath(id)));
}

export function normalizeArtistName(name) {
  return String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/^the\s+/, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function ensureArtist(map, artist) {
  if (!artist?.id || !artist?.name) return;
  let entry = map.get(artist.id);
  if (!entry) {
    entry = {
      id: artist.id,
      name: artist.name,
      normalizedName: normalizeArtistName(artist.name),
      sources: [],
    };
    map.set(artist.id, entry);
  }
  return entry;
}

function addSource(entry, source) {
  if (!entry) return;
  const dup = entry.sources.find((s) => {
    if (s.type !== source.type) return false;
    if (source.type === 'playlist') return s.playlistName === source.playlistName;
    return true;
  });
  if (dup) {
    if (source.trackCount != null) dup.trackCount = (dup.trackCount || 0) + source.trackCount;
    return;
  }
  entry.sources.push(source);
}

async function fetchFollowedArtists(accessToken) {
  const artists = [];
  let after = undefined;
  for (;;) {
    const query = { type: 'artist', limit: 50 };
    if (after) query.after = after;
    const body = await spotifyGet(accessToken, 'me/following', query);
    const page = body?.artists;
    for (const a of page?.items || []) artists.push(a);
    after = page?.cursors?.after;
    if (!after || !(page?.items || []).length) break;
  }
  return artists;
}

async function fetchLikedTrackArtists(accessToken) {
  /** @type {Map<string, { artist: object, trackCount: number }>} */
  const byId = new Map();
  let offset = 0;
  for (;;) {
    const body = await spotifyGet(accessToken, 'me/tracks', { limit: 50, offset });
    const items = body?.items || [];
    for (const item of items) {
      for (const a of item?.track?.artists || []) {
        if (!a?.id) continue;
        const prev = byId.get(a.id);
        if (prev) prev.trackCount += 1;
        else byId.set(a.id, { artist: a, trackCount: 1 });
      }
    }
    if (!body?.next || !items.length) break;
    offset += items.length;
  }
  return [...byId.values()];
}

async function fetchMe(accessToken) {
  return spotifyGet(accessToken, 'me');
}

async function fetchOwnedPlaylistArtists(accessToken, meId) {
  /** @type {Map<string, { artist: object, playlistName: string, trackCount: number }[]>} */
  const hits = new Map();
  let offset = 0;
  const playlists = [];
  for (;;) {
    const body = await spotifyGet(accessToken, 'me/playlists', { limit: 50, offset });
    const items = body?.items || [];
    for (const pl of items) {
      const ownerId = pl?.owner?.id;
      const collab = Boolean(pl?.collaborative);
      if (ownerId === meId || (collab && ownerId)) playlists.push(pl);
    }
    if (!body?.next || !items.length) break;
    offset += items.length;
  }

  for (const pl of playlists) {
    let tOffset = 0;
    try {
      for (;;) {
        // Feb 2026: /playlists/{id}/tracks was removed — use /items
        // (https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide).
        // Only works for playlists the user owns or collaborates on; else 403.
        const body = await spotifyGet(accessToken, `playlists/${pl.id}/items`, {
          limit: 100,
          offset: tOffset,
        });
        const rows = body?.items || [];
        for (const row of rows) {
          const track = row?.item?.type === 'track' ? row.item : row?.track;
          for (const a of track?.artists || []) {
            if (!a?.id) continue;
            const list = hits.get(a.id) || [];
            const existing = list.find((x) => x.playlistName === pl.name);
            if (existing) existing.trackCount += 1;
            else list.push({ artist: a, playlistName: pl.name, trackCount: 1 });
            hits.set(a.id, list);
          }
        }
        if (!body?.next || !rows.length) break;
        tOffset += rows.length;
      }
    } catch (err) {
      // 403 = not owner/collaborator (or still-forbidden edge cases); 429 = rate limit.
      // Skip that playlist; followed + liked still carry the taste signal.
      console.warn(`  skip playlist "${pl.name}" (${err.status || 'err'})`);
      if (err.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  return hits;
}

async function pullOwner(ownerId) {
  console.log(`\n=== Spotify pull: ${ownerId} ===`);
  const accessToken = await getValidAccessToken(ownerId);
  const me = await fetchMe(accessToken);
  const map = new Map();

  const followed = await fetchFollowedArtists(accessToken);
  for (const a of followed) addSource(ensureArtist(map, a), { type: 'followed' });

  const liked = await fetchLikedTrackArtists(accessToken);
  for (const { artist, trackCount } of liked) {
    addSource(ensureArtist(map, artist), { type: 'liked', trackCount });
  }

  const playlistHits = await fetchOwnedPlaylistArtists(accessToken, me.id);
  for (const [, entries] of playlistHits) {
    for (const { artist, playlistName, trackCount } of entries) {
      addSource(ensureArtist(map, artist), { type: 'playlist', playlistName, trackCount });
    }
  }

  const artists = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  const followedCount = artists.filter((a) => a.sources.some((s) => s.type === 'followed')).length;
  const likedCount = artists.filter((a) => a.sources.some((s) => s.type === 'liked')).length;
  const playlistCount = artists.filter((a) => a.sources.some((s) => s.type === 'playlist')).length;

  const payload = {
    ownerId,
    pulledAt: new Date().toISOString(),
    spotifyUser: { id: me.id, displayName: me.display_name || null },
    counts: {
      artists: artists.length,
      followed: followedCount,
      liked: likedCount,
      playlist: playlistCount,
    },
    artists,
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${ownerId}-taste.json`);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(
    `  artists=${artists.length}  followed=${followedCount}  liked=${likedCount}  playlist=${playlistCount}`,
  );
  return payload;
}

async function main() {
  const { ownerId, all } = parseArgs(process.argv);
  let ids;
  if (all) ids = ownersWithTokens();
  else if (ownerId) ids = [ownerId];
  else {
    console.error('Usage: node scripts/spotify-pull.mjs --owner <id> | --all');
    process.exit(1);
  }
  if (!ids.length) {
    console.error('No Spotify owner tokens found under ~/.longterm/spotify-*.env');
    process.exit(1);
  }
  for (const id of ids) await pullOwner(id);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
