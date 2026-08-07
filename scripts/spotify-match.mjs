// Shared Spotify taste → show matching (name-first).
// Used by the CLI matcher and the dashboard /api/show-taste-matches route.

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

/** Rank signal strength: followed > liked > playlist. */
export function bestSource(sources) {
  if (!sources?.length) return null;
  const followed = sources.find((s) => s.type === 'followed');
  if (followed) return { type: 'followed', label: 'Follow', score: 3 };
  const liked = sources.filter((s) => s.type === 'liked');
  if (liked.length) {
    const trackCount = liked.reduce((n, s) => n + (s.trackCount || 1), 0);
    return { type: 'liked', label: 'Like', score: 2, trackCount };
  }
  const playlist = sources.filter((s) => s.type === 'playlist');
  if (playlist.length) {
    const trackCount = playlist.reduce((n, s) => n + (s.trackCount || 1), 0);
    return { type: 'playlist', label: 'Playlist', score: 1, trackCount };
  }
  return null;
}

/** Build normalizedName → artist entry index from a taste file payload. */
export function buildTasteIndex(taste) {
  const byName = new Map();
  for (const artist of taste?.artists || []) {
    const key = artist.normalizedName || normalizeArtistName(artist.name);
    if (!key) continue;
    const prev = byName.get(key);
    if (!prev) {
      byName.set(key, artist);
      continue;
    }
    // Keep the entry with the stronger signal if duplicates collide.
    const a = bestSource(prev.sources)?.score || 0;
    const b = bestSource(artist.sources)?.score || 0;
    if (b > a) byName.set(key, artist);
  }
  return byName;
}

/**
 * Candidate act strings from a show billing line.
 * "A with B" / "A & B" / "A and B" / "A, B" → try full string then each side.
 */
export function actCandidates(act) {
  const raw = String(act || '').trim();
  if (!raw) return [];
  const out = [raw];
  const splitters = /\s+with\s+|\s+&\s+|\s+and\s+|,\s+/i;
  if (splitters.test(raw)) {
    for (const part of raw.split(splitters)) {
      const p = part.trim();
      if (p && p.length > 1) out.push(p);
    }
  }
  return out;
}

/**
 * Match one act against one owner's taste index.
 * @returns {null | { connected: true, hit: false }} | { connected: true, hit: true, type, label, score, artistName }}
 * Pass index=null for "not connected".
 */
export function matchActForOwner(act, tasteIndex) {
  if (!tasteIndex) return { connected: false, hit: false };
  for (const candidate of actCandidates(act)) {
    const key = normalizeArtistName(candidate);
    if (!key) continue;
    const artist = tasteIndex.get(key);
    if (!artist) continue;
    const src = bestSource(artist.sources);
    if (!src) continue;
    return {
      connected: true,
      hit: true,
      type: src.type,
      label: src.label,
      score: src.score,
      artistName: artist.name,
      matchedAs: candidate,
    };
  }
  return { connected: true, hit: false };
}

/**
 * @param {Array<{act, venue, date, sourceUrl, label?}>} shows
 * @param {Record<string, Map|null>} ownerIndexes — ownerId → index or null if unlinked
 */
export function matchShows(shows, ownerIndexes) {
  const ownerIds = Object.keys(ownerIndexes);
  return (shows || []).map((show) => {
    const owners = {};
    for (const id of ownerIds) {
      owners[id] = matchActForOwner(show.act || show.name, ownerIndexes[id]);
    }
    const hits = ownerIds.filter((id) => owners[id]?.hit).length;
    const connected = ownerIds.filter((id) => owners[id]?.connected).length;
    let household = 'none';
    if (hits >= 2) household = 'both';
    else if (hits === 1) household = 'one';
    else if (connected === 0) household = 'unknown';
    return { ...show, taste: { owners, household, hitCount: hits } };
  });
}
