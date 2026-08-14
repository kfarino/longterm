// Hybrid show likeness % — exact Spotify taste floors + Claude ticket estimate.
// Spec: docs/superpowers/specs/2026-08-06-show-likeness-percent-design.md
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTasteIndex, matchActForOwner, normalizeArtistName } from './spotify-match.mjs';
import { telegramEnvPath } from './longterm-paths.mjs';
import { readActRatings, getActStars } from './spotify-act-ratings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const defaultTasteDir = path.join(repoRoot, 'data', 'spotify');
const defaultCachePath = path.join(defaultTasteDir, 'likeness-cache.json');
const defaultVenuesPath = path.join(repoRoot, 'data', 'venues_to_follow.json');

export const SCORE_FLOORS = {
  followed: 92,
  liked: 85,     // 5+ liked tracks; fewer tracks grade lower via gradedSourceFloor
  playlist: 78,  // 5+ playlist tracks
};

/** Max liked tracks from one artist that count toward digest ranking (stops Kanye/Drake pile-ups). */
export const LIKED_TRACK_CAP = 5;

/** Small re-ranker when a show is Live Nation-promoted — Kevin has a
 * personal connection who can often get free/discounted tickets to these.
 * Gated on a real Spotify hit (follow/like/playlist) so it cannot flatten
 * Claude estimates or invert a 1-save over a heavy like. The LN badge is
 * independent of the numeric perk. */
export const LIVE_NATION_BOOST = 4;

const EXACT_SPOTIFY_BASES = new Set(['follow', 'like', 'playlist']);

export function liveNationBoost(promoter, basis) {
  if (promoter !== 'Live Nation') return 0;
  if (!EXACT_SPOTIFY_BASES.has(basis)) return 0;
  return LIVE_NATION_BOOST;
}

/** BM25-style log saturation, cap LIKED_TRACK_CAP.
 * like: 1→68, 2→75, 3→79, 4→82, 5+→85
 * playlist: 1→62 … 5+→78
 * follow stays 92. */
export function gradedSourceFloor(type, trackCount = 1) {
  if (type === 'followed') return SCORE_FLOORS.followed;
  const n = Math.min(Math.max(Number(trackCount) || 1, 1), LIKED_TRACK_CAP);
  const t = Math.log(1 + n) / Math.log(1 + LIKED_TRACK_CAP);
  if (type === 'liked') return Math.round(58 + 27 * t);
  if (type === 'playlist') return Math.round(52 + 26 * t);
  return null;
}

/** Bump when digest/profile scoring prompt changes so old Claude scores re-fetch. */
export const DIGEST_VERSION = 5;

export function buildTasteDigest(taste, {
  followedLimit = 50,
  likedLimit = 60,
  likedTrackCap = LIKED_TRACK_CAP,
} = {}) {
  const artists = taste?.artists || [];
  const followedArtists = artists.filter((a) => (a.sources || []).some((s) => s.type === 'followed'));
  const followed = followedArtists
    .map((a) => a.name)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, followedLimit);
  const followedSet = new Set(followedArtists.map((a) => a.name));
  const playlistSet = new Set(
    artists
      .filter((a) => (a.sources || []).some((s) => s.type === 'playlist'))
      .map((a) => a.name),
  );

  // Cap per-artist liked volume so 142 Kanye tracks ≠ 142× weight.
  // Small bonus if also followed/playlist — still presence, not pile-up.
  const likedHeavy = artists
    .map((a) => {
      const liked = (a.sources || []).filter((s) => s.type === 'liked');
      if (!liked.length) return null;
      const raw = liked.reduce((n, s) => n + (s.trackCount || 1), 0);
      const capped = Math.min(raw, likedTrackCap);
      let weight = capped;
      if (followedSet.has(a.name)) weight += 2;
      if (playlistSet.has(a.name)) weight += 1;
      return { name: a.name, trackCount: capped, weight };
    })
    .filter(Boolean)
    .sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
    .slice(0, likedLimit)
    .map(({ name, trackCount }) => ({ name, trackCount }));

  return {
    ownerId: taste?.ownerId || null,
    followed,
    likedHeavy,
    likedTrackCap,
    digestVersion: DIGEST_VERSION,
    pulledAt: taste?.pulledAt || null,
  };
}

function parseEnvFile(envFilePath) {
  const vars = {};
  if (!fs.existsSync(envFilePath)) return vars;
  for (const line of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

export function loadAnthropicKey() {
  const env = parseEnvFile(telegramEnvPath());
  return env.ANTHROPIC_API_KEY || null;
}

function loadLikenessCache(cachePath) {
  if (!fs.existsSync(cachePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return {};
  }
}

function saveLikenessCache(cachePath, cache) {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
}

export function likenessCacheKey(ownerId, act, venue, date, kind = 'music') {
  return [
    ownerId,
    kind === 'comedy' ? 'comedy' : 'music',
    normalizeArtistName(act),
    normalizeArtistName(venue || ''),
    date || '',
  ].join('|');
}

function venueMeta(venuesPath, venueName) {
  if (!venueName || !fs.existsSync(venuesPath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(venuesPath, 'utf8'));
    const want = normalizeArtistName(venueName);
    const hit = (data.venues || []).find((v) => normalizeArtistName(v.name) === want);
    if (!hit) return null;
    return {
      area: hit.area || null,
      category: hit.category || null,
      type: hit.type || null,
      rating: typeof hit.rating === 'number' ? hit.rating : null,
      vibe: hit.vibe || null,
      name: hit.name || venueName,
    };
  } catch {
    return null;
  }
}

/** Household venue stars adjust ticket score after floors/Claude (not act suggestion stars). */
export function venueRatingBoost(rating) {
  if (rating == null || !Number.isFinite(rating)) return 0;
  if (rating >= 5) return 12;
  if (rating >= 4) return 7;
  if (rating >= 3) return 2;
  if (rating >= 2) return -5;
  return -12;
}

function applyVenueBoost(scoreObj, venueInfo, promoter) {
  if (!scoreObj || typeof scoreObj.score !== 'number') return scoreObj;
  const boost = venueRatingBoost(venueInfo?.rating);
  const lnBoost = liveNationBoost(promoter, scoreObj.basis);
  const total = boost + lnBoost;
  // Fold both boosts into one clamp — clamping them separately would lose
  // information whenever one alone pushed the score out of [0,100] (e.g. a
  // 2-star penalty clamped to 0 first would let a second boost start from 0
  // instead of the true negative subtotal).
  const next = total ? Math.max(0, Math.min(100, scoreObj.score + total)) : scoreObj.score;
  return {
    ...scoreObj,
    score: next,
    venueRating: venueInfo?.rating ?? null,
    venueBoost: boost,
    liveNation: promoter === 'Live Nation',
    liveNationBoost: lnBoost,
  };
}

// Comedy never gets venueRatingBoost (already baked into
// comedyVenueBaseScore, so applying it again would double-count). LN badge
// still shows; the numeric perk is gated off for comedy/Claude estimates.
function applyLiveNationOnlyBoost(scoreObj, promoter) {
  const lnBoost = liveNationBoost(promoter, scoreObj?.basis);
  const isLN = promoter === 'Live Nation';
  if (!scoreObj) return scoreObj;
  if (!lnBoost || typeof scoreObj.score !== 'number') {
    return { ...scoreObj, liveNation: isLN, liveNationBoost: 0 };
  }
  return {
    ...scoreObj,
    score: Math.max(0, Math.min(100, scoreObj.score + lnBoost)),
    liveNation: isLN,
    liveNationBoost: lnBoost,
  };
}

function isComedyContext(act, venueInfo) {
  const blob = `${act || ''} ${venueInfo?.type || ''} ${venueInfo?.category || ''} ${venueInfo?.name || ''}`.toLowerCase();
  return /comedy|improv|standup|stand-up|largo|dynasty typewriter|fanatic salon|westside comedy/.test(blob);
}

export function classifyShowKind(act, venue, venueInfo) {
  const actBlob = String(act || '').toLowerCase();
  const venueName = String(venueInfo?.name || venue || '').toLowerCase();
  const typeBlob = String(venueInfo?.type || '').toLowerCase();
  const actLooksComedy = /comedy|improv|standup|stand-up|\bjoke\b/.test(actBlob)
    || /\b(jeselnik|oswalt|notaro|holmes|seinfeld|chappelle|burr|gadsby|minhaj|glazer)\b/.test(actBlob);
  const pureComedyRoom = /dynasty typewriter|westside comedy|fanatic salon/.test(venueName);
  const mixedRoom = /music\s*\/\s*comedy|comedy\s*\/\s*music/.test(typeBlob) || /largo/.test(venueName);
  if (actLooksComedy || pureComedyRoom) return 'comedy';
  if (mixedRoom) return 'music'; // Largo music nights stay on Music unless act is comedy
  if (isComedyContext(act, venueInfo)) return 'comedy';
  return 'music';
}

export function pitchForFloor(hit) {
  const name = hit.artistName || 'This act';
  if (hit.type === 'followed') return `${name} is on your follows.`;
  if (hit.type === 'liked') {
    const n = Math.max(1, hit.trackCount || 1);
    if (n >= LIKED_TRACK_CAP) return `${name} shows up heavy in your likes — worth the ticket.`;
    if (n === 1) return `${name} has 1 saved track in your likes.`;
    return `${name} has ${n} saved tracks in your likes.`;
  }
  if (hit.type === 'playlist') {
    const n = Math.max(1, hit.trackCount || 1);
    if (n === 1) return `${name} has 1 track on your playlists.`;
    return `${name} has ${n} tracks on your playlists.`;
  }
  return null;
}

function floorFromExactHit(hit) {
  if (!hit?.hit) return null;
  const score = gradedSourceFloor(hit.type, hit.trackCount);
  if (score == null) return null;
  return {
    linked: true,
    score,
    basis: hit.type === 'followed' ? 'follow' : hit.type === 'liked' ? 'like' : 'playlist',
    label: hit.label,
    artistName: hit.artistName || null,
    trackCount: hit.trackCount ?? null,
    pitch: pitchForFloor(hit),
  };
}

export function loadTasteProfile(ownerId, tasteDir = defaultTasteDir) {
  const p = path.join(tasteDir, `${ownerId}-profile.json`);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Cache hit usable only with score + pitch + current digest version. */
function readCachedClaude(entry, profileBuiltAt) {
  if (!entry || typeof entry.score !== 'number') return null;
  if (!entry.pitch || typeof entry.pitch !== 'string') return null;
  if (entry.digestVersion !== DIGEST_VERSION) return null;
  if (profileBuiltAt && entry.profileBuiltAt && entry.profileBuiltAt !== profileBuiltAt) return null;
  return entry;
}

async function mapPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  const n = Math.min(concurrency, Math.max(1, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

export function loadComedyTaste(goalsPath = path.join(repoRoot, 'data', 'goals.json')) {
  if (!fs.existsSync(goalsPath)) {
    return { likes: [], dislikes: [], note: null };
  }
  try {
    const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    const ct = goals.comedyTaste || {};
    return {
      likes: Array.isArray(ct.likes) ? ct.likes : [],
      dislikes: Array.isArray(ct.dislikes) ? ct.dislikes : [],
      note: ct.note || null,
    };
  } catch {
    return { likes: [], dislikes: [], note: null };
  }
}

/** Comedy base from household venue stars only — no Spotify music taste. */
export function comedyVenueBaseScore(rating) {
  if (rating == null || !Number.isFinite(rating)) return 52;
  if (rating >= 5) return 78;
  if (rating >= 4) return 68;
  if (rating >= 3) return 58;
  if (rating >= 2) return 38;
  return 22;
}

async function claudeComedyTicketScore({ apiKey, act, venue, date, venueInfo, comedyTaste }) {
  const venueBits = [
    venue || null,
    venueInfo?.area ? `area:${venueInfo.area}` : null,
    venueInfo?.type ? `type:${venueInfo.type}` : null,
    venueInfo?.rating != null ? `householdVenueStars:${venueInfo.rating}/5` : 'householdVenueStars:unrated',
    venueInfo?.vibe || null,
  ].filter(Boolean).join(' · ');

  const likes = (comedyTaste?.likes || []).join(', ') || '(unspecified)';
  const dislikes = (comedyTaste?.dislikes || []).join(', ') || '(unspecified)';
  const base = comedyVenueBaseScore(venueInfo?.rating);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 180,
      thinking: { type: 'disabled' },
      system:
        'You score how likely THIS household is to BUY TICKETS for a COMEDY night out. ' +
        'CRITICAL: Do NOT use music taste, Spotify artists, or band likeness — comedy only. ' +
        'Match the comic/act against the household comedy taste (likes vs dislikes). ' +
        'Strongly penalize acts known for crude / vulgar / shock-sex humor when dislikes include crude. ' +
        'Reward clean, improv, silly, deadpan, and thoughtful story-based comics when those are likes. ' +
        'Also weigh household venue stars (baked into base) and Westside convenience. ' +
        `Venue-only base is ${base} — adjust by at most ±22 for act↔taste fit, then clamp 0–100. ` +
        'Sales pitch should name the comedy style fit (or mismatch), not music. ' +
        'Reply with ONLY JSON: {"score":0-100,"reason":"≤12 words","pitch":"1–2 sentences, ≤40 words"}. No markdown.',
      messages: [{
        role: 'user',
        content:
          `Household comedy likes: ${likes}\n` +
          `Household comedy dislikes: ${dislikes}\n` +
          `Venue-only base: ${base}\n` +
          `Comic/act: ${act}\n` +
          `Venue: ${venueBits || 'unknown'}\n` +
          `Date: ${date || 'unknown'}\n` +
          'Kind: comedy\n',
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Claude reply: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  let score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
  if (!Number.isFinite(score)) throw new Error(`Bad score: ${parsed.score}`);
  score = Math.max(base - 22, Math.min(base + 22, score));
  return {
    score,
    reason: String(parsed.reason || '').slice(0, 80),
    pitch: String(parsed.pitch || parsed.reason || '').slice(0, 220),
  };
}

async function claudeTicketScoreFromProfile({ apiKey, profile, act, venue, date, venueInfo }) {
  const venueBits = [
    venue || null,
    venueInfo?.area ? `area:${venueInfo.area}` : null,
    venueInfo?.category ? `category:${venueInfo.category}` : null,
    venueInfo?.type ? `type:${venueInfo.type}` : null,
    venueInfo?.rating != null ? `householdVenueStars:${venueInfo.rating}/5` : 'householdVenueStars:unrated',
  ].filter(Boolean).join(' · ');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 160,
      thinking: { type: 'disabled' },
      system:
        'You score how likely a person is to BUY TICKETS for a live MUSIC show (night out), using their music taste PROFILE plus household venue star ratings. ' +
        'Household venue stars (1–5) matter — 5-star rooms deserve a bump; 1–2 star rooms a penalty. ' +
        'Respect ticketYes / ticketMaybe / ticketSkip and breadth; do not over-index on a few famous names. ' +
        'This path is MUSIC ONLY — never score comedy here. ' +
        'Also write a short sales pitch. ' +
        'Reply with ONLY JSON: {"score":0-100,"reason":"≤12 words","pitch":"1–2 sentences, ≤40 words"}. No markdown.',
      messages: [{
        role: 'user',
        content:
          `Profile breadth:\n${profile.breadth || '(none)'}\n\n` +
          `Ticket yes: ${(profile.ticketYes || []).join('; ') || '(none)'}\n` +
          `Ticket maybe: ${(profile.ticketMaybe || []).join('; ') || '(none)'}\n` +
          `Ticket skip: ${(profile.ticketSkip || []).join('; ') || '(none)'}\n` +
          `Anchors followed: ${(profile.anchors?.followed || []).join(', ') || '(none)'}\n` +
          `Anchors liked: ${(profile.anchors?.likedDiverse || []).join(', ') || '(none)'}\n` +
          `Anchors playlist: ${(profile.anchors?.playlist || []).join(', ') || '(none)'}\n` +
          `Notes: ${profile.notes || '(none)'}\n\n` +
          `Show act: ${act}\nVenue: ${venueBits || 'unknown'}\nDate: ${date || 'unknown'}\n` +
          'Kind: music\n',
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Claude reply: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
  if (!Number.isFinite(score)) throw new Error(`Bad score: ${parsed.score}`);
  return {
    score,
    reason: String(parsed.reason || '').slice(0, 80),
    pitch: String(parsed.pitch || parsed.reason || '').slice(0, 220),
  };
}

async function claudeTicketScore({ apiKey, digest, act, venue, date, venueInfo }) {
  const followed = (digest.followed || []).join(', ') || '(none)';
  // Names only — never send raw like-counts (they over-index mega-artists).
  const liked = (digest.likedHeavy || []).map((a) => a.name).sort((a, b) => a.localeCompare(b)).join(', ') || '(none)';
  const venueBits = [
    venue || null,
    venueInfo?.area ? `area:${venueInfo.area}` : null,
    venueInfo?.category ? `category:${venueInfo.category}` : null,
    venueInfo?.type ? `type:${venueInfo.type}` : null,
  ].filter(Boolean).join(' · ');

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 160,
      thinking: { type: 'disabled' },
      system:
        'You score how likely a person is to BUY TICKETS for a live show (night out), not headphone listening. ' +
        'Their taste is eclectic — treat the artist lists as an unordered diverse SET. ' +
        'Do NOT over-index on a few famous names (e.g. Drake, Kanye, Bon Iver) just because they are well-known; ' +
        'match the act against the breadth of the set. Presence in the set matters; imaginary volume does not. ' +
        'Household prefers Westside LA / Brentwood-adjacent venues, but good acts elsewhere still score well. ' +
        'Also write a short sales pitch for THAT person — why this night is (or isn\'t) worth it, tied to their breadth of taste. ' +
        'Reply with ONLY a JSON object: {"score":0-100,"reason":"≤12 words","pitch":"1–2 sentences, ≤40 words"}. No markdown.',
      messages: [{
        role: 'user',
        content:
          `Taste — followed artists (set):\n${followed}\n\n` +
          `Taste — liked artists (diverse set, not ranked by volume):\n${liked}\n\n` +
          `Show act: ${act}\n` +
          `Venue: ${venueBits || 'unknown'}\n` +
          `Date: ${date || 'unknown'}\n`,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in Claude reply: ${text.slice(0, 120)}`);
  const parsed = JSON.parse(jsonMatch[0]);
  const score = Math.max(0, Math.min(100, Math.round(Number(parsed.score))));
  if (!Number.isFinite(score)) throw new Error(`Bad score: ${parsed.score}`);
  return {
    score,
    reason: String(parsed.reason || '').slice(0, 80),
    pitch: String(parsed.pitch || parsed.reason || '').slice(0, 220),
  };
}

/**
 * Score shows for multiple owners.
 * @returns {{ owners, shows, matchedAt }}
 */
export async function scoreShowsLikeness({
  shows,
  ownerIds = ['kevin', 'hanna'],
  tasteDir = defaultTasteDir,
  cachePath = defaultCachePath,
  venuesPath = defaultVenuesPath,
  goalsPath = path.join(repoRoot, 'data', 'goals.json'),
  apiKey = null,
  skipClaude = false,
  concurrency = 3,
} = {}) {
  const key = apiKey || loadAnthropicKey();
  const cache = loadLikenessCache(cachePath);
  let cacheDirty = false;
  const comedyTaste = loadComedyTaste(goalsPath);

  const ownersMeta = {};
  const digests = {};
  const indexes = {};
  const profiles = {};
  const ratingsByOwner = {};

  for (const id of ownerIds) {
    const tastePath = path.join(tasteDir, `${id}-taste.json`);
    ratingsByOwner[id] = readActRatings(id, tasteDir);
    profiles[id] = loadTasteProfile(id, tasteDir);
    if (!fs.existsSync(tastePath)) {
      ownersMeta[id] = { connected: false, hasProfile: !!profiles[id] };
      digests[id] = null;
      indexes[id] = null;
      continue;
    }
    try {
      const taste = JSON.parse(fs.readFileSync(tastePath, 'utf8'));
      ownersMeta[id] = {
        connected: true,
        pulledAt: taste.pulledAt || null,
        artists: taste.counts?.artists ?? (taste.artists || []).length,
        hasProfile: !!profiles[id],
        profileBuiltAt: profiles[id]?.builtAt || null,
      };
      digests[id] = buildTasteDigest(taste);
      indexes[id] = buildTasteIndex(taste);
    } catch {
      ownersMeta[id] = { connected: false, hasProfile: !!profiles[id] };
      digests[id] = null;
      indexes[id] = null;
    }
  }

  // Unique Claude jobs: ownerId + act (+ venue/date for cache key)
  const jobs = [];
  const jobKeyToIndices = new Map();

  const scoredShows = (shows || []).map((show, showIdx) => {
    const venueInfo = venueMeta(venuesPath, show.venue);
    const kind = classifyShowKind(show.act || show.name, show.venue, venueInfo);
    const scores = {};
    for (const id of ownerIds) {
      if (!ownersMeta[id]?.connected) {
        scores[id] = {
          linked: false,
          score: null,
          basis: null,
          label: null,
          suggestionStars: getActStars(ratingsByOwner[id], show.act || show.name),
          venueRating: venueInfo?.rating ?? null,
          venueBoost: 0,
        };
        continue;
      }
      const suggestionStars = getActStars(ratingsByOwner[id], show.act || show.name);
      // Comedy never uses Spotify music floors or the music taste profile.
      if (kind !== 'comedy') {
        const exact = matchActForOwner(show.act || show.name, indexes[id]);
        const floored = floorFromExactHit(exact);
        if (floored) {
          scores[id] = applyVenueBoost({ ...floored, suggestionStars }, venueInfo, show.promoter);
          continue;
        }
      }
      const profileBuiltAt = kind === 'comedy' ? 'comedy-taste-v1' : (profiles[id]?.builtAt || null);
      const ck = likenessCacheKey(id, show.act || show.name, show.venue, show.date, kind);
      const cached = readCachedClaude(cache[ck], profileBuiltAt);
      if (cached) {
        const base = {
          linked: true,
          score: cached.score,
          basis: kind === 'comedy' ? 'comedy' : 'claude',
          label: kind === 'comedy' ? 'Comedy' : 'Estimated',
          reason: cached.reason || null,
          pitch: cached.pitch,
          cached: true,
          suggestionStars,
        };
        scores[id] = kind === 'comedy'
          ? applyLiveNationOnlyBoost({ ...base, venueRating: venueInfo?.rating ?? null, venueBoost: 0 }, show.promoter)
          : applyVenueBoost(base, venueInfo, show.promoter);
        continue;
      }
      if (skipClaude || !key) {
        if (kind === 'comedy') {
          const base = comedyVenueBaseScore(venueInfo?.rating);
          scores[id] = applyLiveNationOnlyBoost({
            linked: true,
            score: base,
            basis: 'comedy-venue',
            label: 'Venue',
            pitch: venueInfo?.rating != null
              ? `${show.venue || 'This room'} is ${venueInfo.rating}★ for you — comedy night worth a look.`
              : 'Comedy at a followed room — score pending deeper act check.',
            suggestionStars,
            venueRating: venueInfo?.rating ?? null,
            venueBoost: 0,
          }, show.promoter);
        } else {
          scores[id] = {
            linked: true,
            score: null,
            basis: 'pending',
            label: '?',
            suggestionStars,
            venueRating: venueInfo?.rating ?? null,
            venueBoost: 0,
            liveNation: false,
            liveNationBoost: 0,
          };
        }
        continue;
      }
      const jk = `${kind}::${id}::${normalizeArtistName(show.act || show.name)}`;
      if (!jobKeyToIndices.has(jk)) {
        jobKeyToIndices.set(jk, []);
        jobs.push({
          jk,
          kind,
          ownerId: id,
          act: show.act || show.name,
          venue: show.venue || '',
          date: show.date || '',
          digest: digests[id],
          profile: profiles[id],
          profileBuiltAt,
          venueInfo,
          comedyTaste,
        });
      }
      jobKeyToIndices.get(jk).push({ showIdx, ownerId: id, cacheKey: ck, suggestionStars, venueInfo, kind });
      scores[id] = {
        linked: true,
        score: null,
        basis: 'pending',
        label: '?',
        suggestionStars,
        venueRating: venueInfo?.rating ?? null,
        venueBoost: 0,
      };
    }
    return {
      ...show,
      kind,
      venueRating: venueInfo?.rating ?? null,
      scores,
    };
  });

  if (jobs.length) {
    await mapPool(jobs, concurrency, async (job) => {
      try {
        const result = job.kind === 'comedy'
          ? await claudeComedyTicketScore({
            apiKey: key,
            act: job.act,
            venue: job.venue,
            date: job.date,
            venueInfo: job.venueInfo,
            comedyTaste: job.comedyTaste,
          })
          : job.profile
            ? await claudeTicketScoreFromProfile({
              apiKey: key,
              profile: job.profile,
              act: job.act,
              venue: job.venue,
              date: job.date,
              venueInfo: job.venueInfo,
            })
            : await claudeTicketScore({
              apiKey: key,
              digest: job.digest,
              act: job.act,
              venue: job.venue,
              date: job.date,
              venueInfo: job.venueInfo,
            });
        const { score, reason, pitch } = result;
        for (const ref of jobKeyToIndices.get(job.jk) || []) {
          cache[ref.cacheKey] = {
            score,
            reason,
            pitch,
            digestVersion: DIGEST_VERSION,
            profileBuiltAt: job.profileBuiltAt || null,
            kind: job.kind,
            at: new Date().toISOString(),
          };
          cacheDirty = true;
          const base = {
            linked: true,
            score,
            basis: job.kind === 'comedy' ? 'comedy' : 'claude',
            label: job.kind === 'comedy' ? 'Comedy' : 'Estimated',
            reason,
            pitch,
            cached: false,
            suggestionStars: ref.suggestionStars,
          };
          const promoter = scoredShows[ref.showIdx].promoter;
          scoredShows[ref.showIdx].scores[ref.ownerId] = job.kind === 'comedy'
            ? applyLiveNationOnlyBoost({ ...base, venueRating: ref.venueInfo?.rating ?? null, venueBoost: 0 }, promoter)
            : applyVenueBoost(base, ref.venueInfo, promoter);
        }
      } catch {
        for (const ref of jobKeyToIndices.get(job.jk) || []) {
          const promoter = scoredShows[ref.showIdx].promoter;
          if (ref.kind === 'comedy') {
            const base = comedyVenueBaseScore(ref.venueInfo?.rating);
            scoredShows[ref.showIdx].scores[ref.ownerId] = applyLiveNationOnlyBoost({
              linked: true,
              score: base,
              basis: 'comedy-venue',
              label: 'Venue',
              pitch: 'Comedy night — scored from your venue stars (act check failed).',
              suggestionStars: ref.suggestionStars,
              venueRating: ref.venueInfo?.rating ?? null,
              venueBoost: 0,
            }, promoter);
          } else {
            scoredShows[ref.showIdx].scores[ref.ownerId] = {
              linked: true,
              score: null,
              basis: 'error',
              label: '?',
              suggestionStars: ref.suggestionStars,
              liveNation: false,
              liveNationBoost: 0,
            };
          }
        }
      }
    });
  }

  if (cacheDirty) saveLikenessCache(cachePath, cache);

  // Optimistic Us = max among linked numeric scores
  for (const show of scoredShows) {
    const nums = ownerIds
      .map((id) => show.scores[id])
      .filter((s) => s?.linked && typeof s.score === 'number')
      .map((s) => s.score);
    const linkedCount = ownerIds.filter((id) => show.scores[id]?.linked).length;
    let coverage = 'none';
    if (linkedCount === 1) coverage = 'kevin-only'; // generic: single linked
    if (linkedCount >= 2) coverage = 'both';
    // Prefer explicit coverage label from which ids linked
    const linkedIds = ownerIds.filter((id) => show.scores[id]?.linked);
    if (linkedIds.length === 1) coverage = `${linkedIds[0]}-only`;
    else if (linkedIds.length >= 2) coverage = 'both';

    // Pitch from the highest-scoring linked owner (the ranking voice).
    let pitch = null;
    let pitchOwnerId = null;
    let best = -1;
    for (const id of ownerIds) {
      const s = show.scores[id];
      if (!s?.linked || typeof s.score !== 'number') continue;
      if (s.score > best && s.pitch) {
        best = s.score;
        pitch = s.pitch;
        pitchOwnerId = id;
      }
    }

    show.us = {
      score: nums.length ? Math.max(...nums) : null,
      mode: 'optimistic',
      coverage,
    };
    show.pitch = pitch;
    show.pitchOwnerId = pitchOwnerId;
    // Suggestion-quality stars (feedback) — not used for ranking
    show.suggestionStars = {};
    for (const id of ownerIds) {
      show.suggestionStars[id] = show.scores[id]?.suggestionStars ?? null;
    }
  }

  scoredShows.sort((a, b) => {
    const ua = a.us?.score;
    const ub = b.us?.score;
    if (ua == null && ub == null) return a.date.localeCompare(b.date);
    if (ua == null) return 1;
    if (ub == null) return -1;
    return ub - ua || a.date.localeCompare(b.date) || (a.act || '').localeCompare(b.act || '');
  });

  return {
    matchedAt: new Date().toISOString(),
    mode: 'likeness-hybrid-c',
    owners: ownersMeta,
    comedyTaste,
    shows: scoredShows,
  };
}
