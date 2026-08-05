# Dining + Shows: recap redesign, on-demand shows tool, and dashboard tab

## Context

This session built the foundation: a 2-year historical visit-spend backfill
(`favorite_places_history.json`), a rewritten `recommendForSlot()` ranking that uses it
(`familiarityScore()`), a curated venue-discovery list (`data/venues_to_follow.json`),
and flipped `favorite_places_raw.json` to be the hand-maintained source of truth
(replacing the Google Sheet, per Kevin — simpler than building real two-way sync).

Kevin asked to plan out the remaining features in this space so he can step away and
let them get built: a redesigned Telegram recap, an on-demand "what shows are coming
up" bot capability, and an interactive dashboard tab where he and Hanna can rate
restaurants/venues, with that feedback feeding back into the recommendation ranking.

This spec covers three features, built in this order (each depends on groundwork from
the one before it):

1. **Telegram recap redesign** — structured sections instead of free-form prose.
2. **`get_upcoming_shows` bot tool** — on-demand, live web search against
   `venues_to_follow.json`'s venues, for the next ~14 days. Its results are cached to
   disk so the dashboard tab (below) can display them without a live search on every
   page load.
3. **"Dining + Shows" dashboard tab** — visual breakdown of family dinner / date night
   / weekend social, each with a star-rating control. Ratings write back into
   `favorite_places_raw.json` (restaurants) or `venues_to_follow.json` (venues), and
   `recommendForSlot()` picks up a new rating-informed scoring term.

**Explicitly not in this pass** (noted so it's not silently forgotten): a fully
*proactive* show-suggestion engine (automatically slotting a show into date night /
weekend social the way `recommendForSlot` does for restaurants) is superseded for now
by the on-demand ask-and-cache model in #2 — Kevin's own framing ("we can chat with you
about upcoming shows... that can be a followup") was for on-demand, not automatic.
Revisit proactive suggestions later if the on-demand version proves too passive.

## 1. Telegram recap redesign

`scripts/telegram-bot-recap.mjs`'s `RECAP_SYSTEM_PROMPT` currently instructs free-form
prose with no headers ("do not use a rigid template"). Replace with three fixed
sections, still composed by the same single Anthropic call (Claude fills in the wording
within each section — not a fully mechanical template):

- **Budget**: joint tracker only — amount logged / projected / target (existing
  `bundle.budgetStatus.joint`), plus every line item over $100 this cycle. New bundle
  field needed: filter `financialContext.transactions` (from the `search_transactions`
  work) to `tracker === 'joint' && amount > 100`, sorted by amount descending.
- **Todos**: every open item, grouped by owner — not just the single oldest stale item
  as today. New bundle field: group `listOpenItems(todos)` by `owner`.
- **Planning**: the three routine occasions, one line each (existing `dining` bundle
  field, unchanged — already benefits from the improved `familiarityScore` ranking).
- **Standing footer line** (always present, not conditional): a short pointer that
  `get_upcoming_shows` (#2 below) exists — e.g. "Curious what's on at our favorite
  venues? Just ask — I can check the next couple weeks."
- **Everything else today's recap covers** (a non-recurring calendar event, unparsed
  messages, a recent direct plan edit) stays, demoted to optional trailing lines shown
  only when notable — same conditionality as today, just visually secondary to the
  three fixed sections now.

`gatherBundle()` gains the new `budgetLineItems`/`todosByOwner` fields; the prompt is
rewritten to describe the fixed section skeleton instead of "no rigid template."

## 2. `get_upcoming_shows` bot tool

New tool, same "live external call, special-cased in the dispatcher" shape as
`get_calendar_events` (`telegram-bot-poll.mjs`) — not a `TOOL_IMPL` entry.

- **Trigger**: conversational — "what shows are coming up," "anything good at Largo
  soon," etc. Add to the system prompt's read-only tool list with guidance on when to
  call it.
- **Implementation** (`callAnthropicUpcomingShows` in `telegram-bot-poll.mjs`, mirroring
  `callAnthropicFallback`'s shape): one Anthropic request, `model: 'claude-sonnet-5'`,
  `tools: [{type: 'web_search_20260209', name: 'web_search', max_uses: 8}]`. System
  prompt gives the model `venues_to_follow.json`'s venue list (name + area) and asks it
  to search for real upcoming shows/events at these venues in the next N days (default
  14, optional `days` tool input), Westside-weighted per the `location-venue-preferences`
  memory, reporting venue + act/event + date + a source URL per finding; explicitly told
  to say plainly when nothing turns up rather than guess.
- **Caching**: after a successful call, write the raw findings to
  `data/upcoming_shows_cache.json` (`{ fetchedAt, days, findings: [...] }`) — this is
  what the dashboard tab (#3) reads, so it never needs to make a live search itself.
  Overwritten on every successful call; a failed call leaves the existing cache in place
  rather than clearing it (stale-but-present beats empty).
- **Degrades gracefully**: network/API failure → clear "couldn't check upcoming shows
  right now" reply, never crashes, matching every other live-call tool in this file.

## 3. "Dining + Shows" dashboard tab

New tab in `dashboard_v5.html`'s nav, alongside the existing tabs (check current tab
list/naming before adding — match the established pattern, e.g. `Planner`/`Month Plan`).

**Layout** — three sections, one per routine occasion:

- **Family Dinner**: current `recommendForSlot()` pick/suggestion (same computation the
  Month Plan tab already does for this slot) — no shows, just the restaurant angle,
  per Kevin's own framing ("Fam dinner" has no shows column).
- **Date Night**: restaurant suggestion (same as above) *and* a shows sub-section, fed
  from `upcoming_shows_cache.json` (if present and not stale — show its `fetchedAt`
  date; if missing/empty, a plain "ask the bot about upcoming shows to populate this"
  empty state, not a broken-looking blank).
- **Weekend Social**: same shows sub-section as Date Night, plus `venues_to_follow.json`'s
  `weekendSocialSpots` (Marina/Venice/Larchmont hangout ideas) as a browsable list
  alongside whatever the routine's restaurant suggestion is.

**Star rating (interactive, writes back)**:

- Each restaurant/venue card gets a simple 1–5 star click control (plain inline SVG
  stars, no new dependency — matches this dashboard's existing style of hand-rolled
  visuals, not a library).
- New `dashboard-server.mjs` route, `POST /api/rate-place` — body `{ name, rating }` —
  writes the rating directly onto the matching entry in `favorite_places_raw.json`
  (restaurants) or `data/venues_to_follow.json` (venues/weekendSocialSpots entries),
  matched by an **exact** (not fuzzy) name match — the frontend is always rating an
  entry it just rendered from the same JSON, so it already has the literal stored name
  string; this is a different matching need than `matchFavorite`'s fuzzy merchant-name
  matching in `budget-tracking-pull.mjs`, which exists to match loose bank-transaction
  merchant strings, not this. An unmatched name (shouldn't happen, but the route should
  still handle it) returns a clear 404-style error rather than silently no-op'ing. This
  is a genuine write
  to the hand-maintained source-of-truth file, same category of action as
  `update_phase_expense` writing directly to `goals.json` — no separate review gate,
  the rating just lands.
- `recommendForSlot()` gains a small new scoring term: `+((f.rating || 0) - 3) * 6` (a
  3-star rating is neutral/no effect; 5 stars gives a modest boost comparable to a
  handful of extra visits; 1 star gives a comparable penalty) — layered onto the
  existing `familiarityScore` + cuisine-repeat + go-to bonus, not replacing them. Only
  applies when `rating` is present; absent/never-rated stays neutral (no term added).

**Read path**: the tab's initial render reuses the same data the Month Plan tab already
loads (`favorite_places.json`, `dining-routine-overrides.json`,
`month_plan_events.json`) via `dashboard-server.mjs`'s existing routes, plus a new
`GET /api/upcoming-shows-cache` route (read-only) for the shows cache file, plus the new
`POST /api/rate-place` for the write-back. No new bot-side plumbing needed beyond the
rating write route and reading the shows cache — this tab is a renderer, same philosophy
as the rest of `dashboard_v5.html`.

## Verification

- Recap: extend `data/test-telegram-recap.mjs` — assert the composed bundle carries
  `budgetLineItems`/`todosByOwner`, and that the mocked LLM call receives them (same
  pattern the existing recap tests already use for `dining`/`calendarSummary`).
- `get_upcoming_shows`: new tests in `data/test-telegram-bot.mjs`, same
  `researchClient`-style injectable-mock pattern already established for live-call
  tools in this file — a successful call writes the cache file and returns a formatted
  reply; a failed call degrades cleanly and leaves any existing cache untouched.
- Rating write-back: extend `data/test-dashboard-server.mjs` for the new
  `POST /api/rate-place` route (writes to the right file/entry, rejects an unmatched
  name clearly rather than silently no-op'ing); extend `data/test-dining-recommendation.mjs`
  for the new rating scoring term (a 5-star place outranks an unrated one, all else
  equal; a 1-star place ranks below).
- Dashboard tab: manually run `npm run dev` and visually check the new tab renders,
  the star control writes back (confirm via re-reading the JSON file after a click),
  and the empty-state for an unpopulated shows cache reads clearly rather than looking
  broken.
