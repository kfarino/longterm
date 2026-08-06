// Finances/Longterm/scripts/dining-recommendation.mjs
// Ported from dashboard_v5.html's inline recommendForSlot() (2026-07-31) so
// the Telegram bot's dining tools can suggest the same picks the dashboard's
// Month Plan calendar would, without a browser. Deliberately a duplicate,
// not a shared import — dashboard_v5.html's script is loaded inline/plain
// (not as a real ES module) so it can't import this file, and vice versa;
// real deduplication would mean switching the dashboard to
// <script type="module">, newly possible now that it's served over http://
// instead of file:// (which blocks module scripts). Left as a known,
// deliberate scope cut — see docs/superpowers/specs for the design note.
export const TIER_MIDPOINT = { cheap: 25, mid: 75, high: 150 };
export const TIER_RANK = { cheap: 0, mid: 1, high: 2 };
export const RECENT_VISIT_EXCLUSION_DAYS = 10;

// Maps a conversational "occasion" name to goals.json's diningRoutine
// dayOfWeek convention (Wed=family dinner, Fri=date night, Sat=weekend
// social — see claude.md's Dining recommendations section).
export const OCCASION_DAY_OF_WEEK = {
  family_dinner: 3,
  date_night: 5,
  weekend_social: 6,
};

// Looks the routine entry up by its goals.json-native (static) day first —
// deliberately not by an already-"moved" array — then overlays the current
// override on the returned slot's dayOfWeek. Resolving fresh from the live
// overrides object on every call (rather than baking an override into a
// diningRoutine snapshot once) means a set_routine_day change is reflected
// immediately, even for a later message in the same poll batch, with no
// stale-snapshot risk.
export function slotForOccasion(occasion, diningRoutine, overrides) {
  const originalDay = OCCASION_DAY_OF_WEEK[occasion];
  if (originalDay == null) return null;
  const entry = diningRoutine.find((r) => r.dayOfWeek === originalDay);
  if (!entry) return null;
  const effectiveDay = (overrides && overrides[occasion] != null) ? overrides[occasion] : originalDay;
  return effectiveDay === originalDay ? entry : { ...entry, dayOfWeek: effectiveDay };
}

// Applies a bot-set day-of-week override (set_routine_day) on top of
// goals.json's hand-maintained diningRoutine, without ever writing to
// goals.json itself — overrides live in their own small file
// (data/dining-routine-overrides.json) so goals.json stays exclusively
// hand-maintained, per claude.md. Moves the matching entry's dayOfWeek
// field to the override, so both slotForOccasion (above) and the
// dashboard's own calendar walk (which only ever matches by dayOfWeek, no
// occasion concept) see a consistent, single "current" day — otherwise the
// bot and dashboard could disagree about which weekday a routine falls on.
export function effectiveDiningRoutine(diningRoutine, overrides) {
  if (!overrides) return diningRoutine;
  return diningRoutine.map((entry) => {
    const occasion = Object.keys(OCCASION_DAY_OF_WEEK).find((occ) => OCCASION_DAY_OF_WEEK[occ] === entry.dayOfWeek);
    if (!occasion || overrides[occasion] == null) return entry;
    return { ...entry, dayOfWeek: overrides[occasion] };
  });
}

// A star rating from the dashboard's Dining + Shows tab (see
// dashboard-server.mjs's ratePlace/rateVenue) is an explicit, direct signal —
// stronger than the implicit visitStats-derived familiarityScore. 3 stars is
// neutral (no term added); each star above/below 3 shifts the score by 6, a
// magnitude comparable to a handful of extra visits under familiarityScore's
// visitCount term, so a strong rating can meaningfully move the ranking
// without completely overriding genuine visit history.
function ratingScore(f) {
  if (!f.rating) return 0;
  return (f.rating - 3) * 6;
}

// visitStats comes from a 2-year historical Monarch backfill (see
// budget-tracking-pull.mjs's computeFavoritePlacesHistory/refreshFavoritePlaces)
// and reflects genuine long-term visit frequency — replaces the old pure
// days-since-last-visit novelty score (2026-08-05), which defaulted an
// unvisited place to the max value (365) and so put every brand-new
// want-to-go entry at the top of every suggestion by default ("never visited
// shouldn't be default highest suggestion" — Kevin). An established favorite
// that's genuinely due for a revisit (visited many times, but not recently)
// can now legitimately outrank a place that's never been tried, while a
// never-visited place still gets a fair, moderate shot at rotation rather
// than either dominating or being buried. A place with no visitStats at all
// (history not yet backfilled, or genuinely never visited) gets the same flat
// "worth trying" score either way — reviving the old 90-day-window signal as
// a fallback would just reintroduce the exact bug this replaces, so this
// deliberately does not fall back to it.
function familiarityScore(f) {
  const vs = f.visitStats;
  if (vs && vs.visitCount > 0) {
    const daysSince = Math.min(365, Math.floor((new Date() - new Date(vs.lastVisitDate)) / 86400000));
    return daysSince + Math.min(vs.visitCount, 10) * 8;
  }
  return 90;
}

// Picks a place (or a low-key idea) for one slot. Ranked, not a plain
// filter-then-array-order pick (2026-08-01): scores each eligible candidate
// by familiarityScore (see above — visit frequency/recency, not pure
// novelty), nudges down a repeat of the most recent cuisine for variety, and
// prefers a proven 'go-to' place over an unproven 'want-to-go' one. Still the
// same input/output shape as before — this remains the swap point for an
// LLM/ML call later (see design docs), just a more reasoned heuristic than a
// plain filter today. Deliberately synchronous/cheap: the dashboard calls
// this once per eligible day across a whole month's render, so a real
// per-call LLM request here would be slow and costly.
export function recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas, alreadyUsedNames) {
  if (slot.tier === 'low-key') {
    const idea = lowKeyHangIdeas[Math.floor(Math.random() * lowKeyHangIdeas.length)];
    return { picks: [idea], reasoning: 'Budget is tight for this occurrence — a free/low-key hang instead of a paid outing.' };
  }

  const ceilingRank = TIER_RANK[slot.tier];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - RECENT_VISIT_EXCLUSION_DAYS);
  const recentNames = new Set(
    recentDiningActivity
      .filter((a) => new Date(a.date) >= cutoff && a.matchedPlace)
      .map((a) => a.matchedPlace)
  );

  let candidates = favorites.filter((f) => {
    if (f.list !== 'go-to' && f.list !== 'want-to-go') return false;
    if (recentNames.has(f.name)) return false;
    if (slot.requiresTag && !f[slot.requiresTag]) return false;
    if (!f.observed) return ceilingRank <= TIER_RANK.mid; // unproven cost: eligible at cheap/mid only
    return TIER_RANK[f.observed.tier] <= ceilingRank;
  });

  // Exclude anything already used elsewhere on this render's calendar, so
  // the month doesn't show the same place for every eligible day — but
  // only if doing so leaves at least one candidate; a repeat beats no
  // suggestion at all.
  const withoutRepeats = candidates.filter((f) => !(alreadyUsedNames || new Set()).has(f.name));
  if (withoutRepeats.length > 0) candidates = withoutRepeats;

  const mostRecent = recentDiningActivity.length
    ? [...recentDiningActivity].sort((a, b) => b.date.localeCompare(a.date))[0]
    : null;
  const recentCuisine = mostRecent && mostRecent.matchedPlace
    ? (favorites.find((f) => f.name === mostRecent.matchedPlace) || {}).cuisine
    : null;

  const scored = candidates
    .map((f) => ({
      f,
      score: familiarityScore(f)
        - (recentCuisine && f.cuisine === recentCuisine ? 50 : 0)
        + (f.list === 'go-to' ? 10 : 0)
        + ratingScore(f),
    }))
    .sort((a, b) => b.score - a.score);

  const picks = scored.slice(0, 3).map((s) => s.f.name);
  const reasoning = picks.length
    ? `${slot.tier} tier, ranked by visit history (favoring established go-to favorites due for a revisit, with new want-to-go picks worked in — excluding anything in the last ${RECENT_VISIT_EXCLUSION_DAYS} days) and a different cuisine than last time.`
    : `No fresh picks — everything eligible was visited in the last ${RECENT_VISIT_EXCLUSION_DAYS} days.`;

  return { picks, reasoning };
}
