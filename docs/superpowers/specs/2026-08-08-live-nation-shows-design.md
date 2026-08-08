# Live Nation events pull + ticket-connection scoring boost

*Approved 2026-08-08 (fast-tracked at Kevin's request — he's out and asked to build ahead of getting the Ticketmaster API key).*

## Why

Kevin has a personal connection who can often get free or discounted tickets to Live Nation-promoted shows. Two asks:

1. A genuinely **comprehensive** pull of upcoming Live Nation LA-area events — broader and more reliable than the existing Claude+web-search discovery scripts (`spotify-find-shows.mjs`, `upcoming-shows-pull.mjs`), which are best-effort and scoped to already-known artists/venues.
2. That connection should **factor into the match percentage**, not just be a side note — a free/cheap ticket lowers the bar for "is this worth going to."
3. Live Nation shows must be **visibly tagged "LN"** everywhere a show appears — the weekly Telegram message and the dashboard's Dining + Shows tab.

## Data source: Ticketmaster Discovery API

Live Nation owns Ticketmaster, and Ticketmaster's Discovery API (`app.ticketmaster.com/discovery/v2`) is a real, free-tier, structured public API — register an app at developer.ticketmaster.com for an API key. This replaces the "ask Claude to web-search" pattern for this one source: a direct API query for LA-area events is exhaustive and never hallucinates a date, matching what "comprehensive" actually requires.

**Query shape:** `GET /discovery/v2/events.json` with:
- `apikey` — from a new `~/.longterm/ticketmaster.env` (`TICKETMASTER_API_KEY`), same per-service env-file convention as `telegram.env`/`monarch.env`/`oura-app.env`/`spotify-app.env` (`ticketmasterEnvPath()` added to `longterm-paths.mjs`).
- `latlong` — Brentwood/Westside LA coordinates, `radius=50` miles (covers the LA metro the household already ranges over, per the venues-to-follow area tags).
- `classificationName=music,comedy` — matches the two kinds this pipeline already scores. (Ticketmaster files comedy under Arts & Theatre; both are queried.)
- `startDateTime`/`endDateTime` — `--days` window, default 60 (matches `spotify-find-shows.mjs`'s default), from today.
- Paginated (`size=200`, follow `page` until exhausted or a safety cap) — genuinely comprehensive, not a top-N sample.

## Live Nation detection

Ticketmaster's event object carries a `promoter`/`promoters[]` field, but it isn't always populated. Two-tier detection:

1. **Primary:** `promoter.name` (or any entry in `promoters[]`) matching `/live nation|house of blues concerts/i` (House of Blues Concerts is a Live Nation subsidiary promoter name that shows up in real API responses).
2. **Fallback:** a new hand-maintained `data/live-nation-venues.json` — a flat list of venue names Kevin knows are Live Nation venues/rooms, checked when promoter data is missing. This follows the same "API data is imperfect, keep a durable correction file" pattern already established by `data/health_overrides.json` and `budget-tracking-pull.mjs`'s `TRACKER_REASSIGNMENTS` — starts empty, Kevin adds venue names by hand as he notices gaps.

An event matching neither signal is treated as **not** Live Nation — false negatives (missing the badge on a real LN show) are the safe failure mode; false positives (claiming a ticket connection that doesn't exist) are not.

## Pipeline integration

New script `scripts/live-nation-pull.mjs` (→ `npm run livenation:pull`):
- Fetches and paginates as above.
- Maps each event to the existing show shape (`act`, `venue`, `date` as `YYYY-MM-DD` from `dates.start.localDate`, `sourceUrl` from the event's `url`), plus a new `promoter: 'Live Nation'` field (or omitted/`null` when not detected).
- Merges into `data/upcoming_shows_cache.json` the same way `upcoming-shows-pull.mjs` already merges venue findings on top of Spotify findings — appended as a `label: 'livenation'` block in `findings`, plus contributing to the flat `shows[]` array via the existing `dedupeShows()` (shared `show-parse.mjs` helper, dedup key already ignores `promoter` so a Live-Nation-sourced event correctly merges with the same show found via another source rather than duplicating).

`spotify-match-shows.mjs` / `spotify-likeness.mjs` need no change to *find* these shows — they already consume `cache.shows`. They do need to **carry `promoter` through** scoring (currently `scoredShows` spreads `...show`, which already preserves unknown fields — verified against `spotify-likeness.mjs:493-601`, no code change needed there beyond the boost itself).

## Scoring boost

In `spotify-likeness.mjs`, alongside `venueRatingBoost`:

```js
export const LIVE_NATION_BOOST = 15;

export function liveNationBoost(promoter) {
  return promoter === 'Live Nation' ? LIVE_NATION_BOOST : 0;
}
```

Applied at the same point as the venue-rating boost (inside `applyVenueBoost`'s call sites, for both the music floor path and the Claude-estimate path — **not** the comedy path's separate `applyVenueBoost`-free branches, which get the boost added directly since comedy already skips `applyVenueBoost`). Clamped into the existing `Math.max(0, Math.min(100, ...))` range. The resulting score object gains `liveNation: true` and `liveNationBoost: 15` fields (mirroring `venueRating`/`venueBoost`) for transparency in the existing per-show debug print in `spotify-match-shows.mjs`.

+15 sits between the existing 4-star (+7) and 5-star (+12) venue boosts: a free/cheap ticket meaningfully lowers the bar without acting as a hard floor. A show Kevin would genuinely dislike doesn't jump to "must-go" just because the ticket is free — this is a nudge on top of taste fit, not a replacement for it.

## "LN" visibility

**Telegram (`scripts/spotify-shows-telegram.mjs`):** `filterQualifyingShows` gains a `promoter` field (threaded through the same way `score` was just added). `formatMessage` inserts `[LN]` right after the score when `entry.promoter === 'Live Nation'`:

```
🎸 Counting Crows (97%) [LN] — Aug 7 @ Hollywood Bowl: https://open.spotify.com/artist/...
```

**Dashboard (`dashboard_v5.html`):** `showRowHTML()` renders a small badge next to the act name when `show.promoter === 'Live Nation'`:

```html
<div class="show-act">Counting Crows <span class="show-ln-badge" title="Live Nation — ticket connection possible">LN</span></div>
```

New CSS (near the other `.show-*` rules, using the existing `--gold` accent already used for star ratings):

```css
.show-ln-badge{display:inline-block;margin-left:6px;padding:1px 5px;font-size:9px;font-weight:700;letter-spacing:.04em;color:#000;background:var(--gold);border-radius:3px;vertical-align:middle}
```

## Wiring into the weekly pull

`run-weekly-shows-pull.ps1` gains a step calling `livenation:pull`, run before `spotify:match` (which needs its output merged into the cache first) — same isolated `try`/`catch` + `-SkipLiveNation` switch pattern as every other step, so a Ticketmaster outage or a still-missing API key never fails the three steps the dashboard already depends on.

## Credential rollout (manual, one-time)

Kevin doesn't have a Ticketmaster API key yet. The code ships complete; until the key exists:
- `live-nation-pull.mjs` fails loudly with a clear "missing ~/.longterm/ticketmaster.env" message, contained by the weekly-pull step's own try/catch (same as every other missing-credential case in this codebase — e.g. `oura-pull.mjs` before OAuth setup).
- Registration steps (to hand to Kevin when he's back): go to developer.ticketmaster.com → create a free account → create an "App" → copy the Consumer Key as `TICKETMASTER_API_KEY` → save into `~/.longterm/ticketmaster.env` as `TICKETMASTER_API_KEY=<key>`.

## Non-goals

- No change to the existing Claude+web-search discovery scripts — this is an additive third source, not a replacement.
- No UI beyond the plain-text `[LN]` tag / dashboard badge — no separate "free ticket" filter or sort.
- No attempt to actually claim/request a ticket through the connection — this only surfaces the possibility; acting on it is manual, same as always.

## Testing

`data/test-live-nation-pull.mjs` (new): API response parsing/pagination (injected fetch client, no real network calls), promoter-field detection regex, fallback-venue-list matching, merge-into-cache shape. `data/test-spotify-likeness.mjs` (new — no test file currently covers `spotify-likeness.mjs`) covers `liveNationBoost` directly (applies/no-op, clamps at 100) plus its integration into `scoreShowsLikeness`: applies for the music floor path, the Claude-estimate path, and the comedy path (which skips `applyVenueBoost` entirely, so the boost must be added on that branch too), and is a no-op when `promoter` is absent/null. `data/test-spotify-shows-telegram.mjs` gains a `[LN]` formatting case. Live-verify `live-nation-pull.mjs` against the real API once Kevin has the key, same live-verification discipline as every other integration in this codebase.
