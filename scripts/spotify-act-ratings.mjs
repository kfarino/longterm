// Read/write per-owner act suggestion-quality ratings (1–5 stars).
// Stars rate how good OUR suggestion was — they do not set ticket scores.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeArtistName } from './spotify-match.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const defaultTasteDir = path.join(repoRoot, 'data', 'spotify');

export function actRatingsPath(ownerId, tasteDir = defaultTasteDir) {
  return path.join(tasteDir, `${ownerId}-act-ratings.json`);
}

export function emptyRatings(ownerId) {
  return { ownerId, updatedAt: null, acts: {} };
}

export function readActRatings(ownerId, tasteDir = defaultTasteDir) {
  const p = actRatingsPath(ownerId, tasteDir);
  if (!fs.existsSync(p)) return emptyRatings(ownerId);
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      ownerId: data.ownerId || ownerId,
      updatedAt: data.updatedAt || null,
      acts: data.acts && typeof data.acts === 'object' ? data.acts : {},
    };
  } catch {
    return emptyRatings(ownerId);
  }
}

export function getActStars(ratings, actName) {
  if (!ratings?.acts || !actName) return null;
  const key = normalizeArtistName(actName);
  const entry = ratings.acts[key];
  if (!entry || typeof entry.stars !== 'number') return null;
  return entry.stars;
}

/**
 * @returns {{ ok: true, ratings } | { ok: false, error: string }}
 */
export function setActRating(ownerId, displayName, stars, { note = null, tasteDir = defaultTasteDir } = {}) {
  const n = Number(stars);
  if (!Number.isInteger(n) || n < 1 || n > 5) {
    return { ok: false, error: 'stars must be an integer 1–5' };
  }
  if (!displayName || !String(displayName).trim()) {
    return { ok: false, error: 'act name required' };
  }
  const ratings = readActRatings(ownerId, tasteDir);
  const key = normalizeArtistName(displayName);
  ratings.acts[key] = {
    displayName: String(displayName).trim(),
    stars: n,
    ratedAt: new Date().toISOString(),
    note: note != null && String(note).trim() ? String(note).trim().slice(0, 200) : null,
  };
  ratings.updatedAt = new Date().toISOString();
  ratings.ownerId = ownerId;
  fs.mkdirSync(tasteDir, { recursive: true });
  fs.writeFileSync(actRatingsPath(ownerId, tasteDir), `${JSON.stringify(ratings, null, 2)}\n`, 'utf8');
  return { ok: true, ratings, key, entry: ratings.acts[key] };
}

/** Compact list for profile rebuild prompts. */
export function ratingsForProfilePrompt(ratings, limit = 40) {
  const entries = Object.values(ratings?.acts || {})
    .filter((e) => e && typeof e.stars === 'number')
    .sort((a, b) => (b.ratedAt || '').localeCompare(a.ratedAt || ''));
  return entries.slice(0, limit).map((e) => ({
    act: e.displayName,
    stars: e.stars,
    note: e.note || null,
  }));
}
