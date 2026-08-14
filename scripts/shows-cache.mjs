// Helpers for upcoming_shows_cache.json writers so a Live Nation pull's
// promoter tags survive later spotify/venue refreshes. Without this,
// shows:pull / spotify:find-shows / the bot's get_upcoming_shows rebuild
// findings from text only and silently drop label:'livenation' blocks
// (and the promoter field the LN badge + score boost both key off).
import { dedupeShows, parseShowsFromText } from './show-parse.mjs';

export function livenationFindings(existing) {
  return (existing?.findings || []).filter((f) => f.label === 'livenation');
}

export function showsFromLivenationFindings(findings) {
  const out = [];
  for (const f of findings || []) {
    if (f.label !== 'livenation') continue;
    if (!Array.isArray(f.shows)) continue;
    for (const s of f.shows) out.push({ ...s, label: f.label || s.label || 'livenation' });
  }
  return out;
}

/** Keep prior Live Nation finding blocks when rewriting discovery findings. */
export function mergeFindingsPreservingLivenation(newFindings, existingCache) {
  const base = (newFindings || []).filter((f) => f.label !== 'livenation');
  return [...base, ...livenationFindings(existingCache)];
}

/**
 * Rebuild top-level shows[] from fresh discovery rows, then re-attach any
 * Live Nation promoter tags already known from a prior livenation:pull.
 * Discovery wins for act/venue/date/url (first-seen); dedupeShows fills a
 * missing promoter from a later LN duplicate.
 */
export function rebuildShowsWithLivenation(discoveryShows, existingCache) {
  const lnFromFindings = showsFromLivenationFindings(existingCache?.findings);
  const lnFromShows = (existingCache?.shows || []).filter((s) => s?.promoter);
  return dedupeShows([...(discoveryShows || []), ...lnFromFindings, ...lnFromShows]);
}

/** Parse non-livenation finding text into structured shows (with label). */
export function discoveryShowsFromFindings(findings) {
  return dedupeShows(
    (findings || [])
      .filter((f) => f.label !== 'livenation')
      .flatMap((f) => {
        if (Array.isArray(f.shows) && f.shows.length && !f.text) {
          return f.shows.map((s) => ({ ...s, label: f.label || s.label || null }));
        }
        return parseShowsFromText(f.text, f.urls).map((s) => ({
          ...s,
          label: f.label || null,
        }));
      }),
  );
}
