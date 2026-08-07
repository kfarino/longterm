// Deterministic Spotify taste inventory for monthly profile builds.
// Caps per-artist liked/playlist volume so mega-saves don't dominate.

/** Keep in sync with spotify-likeness.mjs LIKED_TRACK_CAP */
export const INVENTORY_TRACK_CAP = 5;

function cappedSources(artists, type, likedTrackCap) {
  return (artists || [])
    .map((a) => {
      const src = (a.sources || []).filter((s) => s.type === type);
      if (!src.length) return null;
      const rawCount = src.reduce((n, s) => n + (s.trackCount || 1), 0);
      return {
        name: a.name,
        cappedCount: Math.min(rawCount, likedTrackCap),
        rawCount,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.cappedCount - a.cappedCount || a.name.localeCompare(b.name));
}

/**
 * @param {object} taste — <owner>-taste.json payload
 * @param {{ likedTrackCap?: number }} [opts]
 */
export function buildTasteInventory(taste, { likedTrackCap = INVENTORY_TRACK_CAP } = {}) {
  const artists = taste?.artists || [];
  const followed = artists
    .filter((a) => (a.sources || []).some((s) => s.type === 'followed'))
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b));

  const liked = cappedSources(artists, 'liked', likedTrackCap);
  const playlist = cappedSources(artists, 'playlist', likedTrackCap);

  const followedSet = new Set(followed);
  const likedSet = new Set(liked.map((x) => x.name));
  const playlistSet = new Set(playlist.map((x) => x.name));

  return {
    ownerId: taste?.ownerId || null,
    pulledAt: taste?.pulledAt || null,
    likedTrackCap,
    counts: {
      artists: artists.length,
      followed: followed.length,
      liked: liked.length,
      playlist: playlist.length,
      followedAndLiked: [...followedSet].filter((n) => likedSet.has(n)).length,
      followedAndPlaylist: [...followedSet].filter((n) => playlistSet.has(n)).length,
    },
    followed,
    liked,
    playlist,
  };
}

/** Split name lists into batches for chunked Claude calls. */
export function chunkNames(names, size = 80) {
  const out = [];
  for (let i = 0; i < names.length; i += size) out.push(names.slice(i, i + size));
  return out;
}
