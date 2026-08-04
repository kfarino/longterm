# Dining Recommendations & Month Plan — Design

*2026-07-26*

## Context

Restaurants & Bars is the largest discretionary line in the joint (Barclays) budget. Kevin and Hanna already run an informal weekly routine — Wednesday takeout, Friday/Saturday date night — and maintain a Google Sheet of favorite/wishlist restaurants (`https://docs.google.com/spreadsheets/d/1-5KiintV2071nkjkF5zb_P-erWYOknn8hWtMLBBlyDM`), but nothing connects that list, their actual spending, and their budget pacing into an actionable plan. This adds a "Month Plan" view to `dashboard_v5.html` covering three occasion types — takeout, date night, and weekend social — that suggests where to go (or whether to stay in) for each, sized to what the month's budget actually allows and informed by what they've eaten recently. The two fixed occasions (takeout, date night) happen every week regardless; the weekend social occasion is *dynamic* — the engine decides whether the remaining budget can support a paid outing or should default to a free/low-key hang, recalculated every time the pacing changes ("reactionary" as the month progresses). The suggestion logic itself stays a single, isolated, swappable unit so it can be upgraded (better heuristics, or an LLM/ML call) later without touching the rest of the system. Calendar integration and reservation-booking are explicitly out of scope for v1 — noted as future work.

## Data model

### `Longterm/data/favorite_places_raw.json` (new, on-demand only)
A snapshot of the Google Sheet. Refreshed only when Kevin/Hanna ask for a resync (requires Drive access only available in a live Claude Code session — the unattended scheduled pull cannot read the sheet itself).

```json
[
  { "name": "Piccolino", "cuisine": "Italian", "location": "WeHo Robertson", "list": "go-to", "notes": null },
  { "name": "Mother Wolf", "cuisine": "Italian", "location": "Hollywood", "list": "want-to-go", "notes": null },
  { "name": "Baltaire", "cuisine": "Steak", "location": "Brentwood", "list": "go-to", "notes": "love to sit at the bar; live music Th-Sat" }
]
```
`list` is one of `go-to` | `want-to-go` | `tried`. The sheet's "Just drinks" and entertainment-venue sections are out of scope for v1 (this is about dining occasions).

### `Longterm/data/favorite_places.json` (new, auto-refreshed daily)
The raw list enriched with observed stats computed from Monarch transaction history, plus the rolling dining-activity log those stats are derived from.

```json
{
  "meta": { "lastRegenerated": "2026-07-26", "lookbackDays": 90 },
  "places": [
    {
      "name": "Piccolino", "cuisine": "Italian", "location": "WeHo Robertson", "list": "go-to", "notes": null,
      "observed": { "tier": "mid", "avgSpend": 84.50, "visitCount": 3, "lastVisited": "2026-07-14" }
    },
    {
      "name": "Mother Wolf", "cuisine": "Italian", "location": "Hollywood", "list": "want-to-go", "notes": null,
      "observed": null
    }
  ],
  "recentDiningActivity": [
    { "date": "2026-07-24", "merchant": "Great White", "amount": 186.84, "matchedPlace": null, "account": "CREDIT CARD (...3939)" },
    { "date": "2026-07-14", "merchant": "Piccolino", "amount": 84.50, "matchedPlace": "Piccolino", "account": " More Mastercard (...9054)" }
  ]
}
```
Tier bucketing (v1, fixed thresholds — tunable): `avgSpend < 40` → cheap, `40–90` → mid, `> 90` → high. A place with no matched transactions in the lookback window has `observed: null` (not a guess). Merchant matching is case-insensitive substring match between the sheet's `name` and Monarch's `merchant`/`plaidName` fields; unmatched Restaurants & Bars transactions still get logged in `recentDiningActivity` with `matchedPlace: null` so they count toward recency/variety even if the specific favorite isn't in the sheet.

### `goals.json` — new `diningRoutine` array (hand-maintained)
```json
"diningRoutine": [
  { "dayOfWeek": 3, "occasion": "Takeout night", "tier": "cheap", "dynamic": false },
  { "dayOfWeek": 5, "occasion": "Date night", "tier": "mid", "dynamic": false },
  { "dayOfWeek": 6, "occasion": "Date night", "tier": "mid", "dynamic": false },
  { "dayOfWeek": 0, "occasion": "Weekend social", "tier": "mid", "dynamic": true }
]
```
`dayOfWeek` follows JS convention (0=Sunday..6=Saturday). Adding/removing a slot is a one-line edit here, no code change. `dynamic: false` slots always happen every week at their configured tier. For a `dynamic: true` slot (currently just "Weekend social," Sunday daytime), `tier` is only the tier to use *if* it resolves to a paid outing — whether it actually does, or resolves to a free low-key hang instead, is decided by `planRemainingMonth()` below, based on budget room left after the fixed slots are accounted for.

`goals.json` also gets a small new `lowKeyHangIdeas` array (e.g. `["Host game night", "Walk + coffee at home", "Movie night in"]`) — free/cheap fallback activities for a "Weekend social" occurrence when the budget can't support a paid outing. Hand-maintained, same as everything else in `goals.json`.

## Update mechanism

Two different cadences, matching what's actually able to auto-refresh vs. what needs a person:

1. **Favorites list** (`favorite_places_raw.json`) — on-demand. Kevin/Hanna ask ("resync my favorites"), I re-read the Google Sheet via Drive access and rewrite the file.
2. **Observed stats + recent activity** (`favorite_places.json`) — automatic, daily. `budget-tracking-pull.mjs` (runs daily via this project's own scheduled task) already fetches every transaction needed to compute the joint/Kevin-personal totals. Extend it to also: filter that same fetched batch for Restaurants & Bars-category transactions, append any not already in `recentDiningActivity` (dedup key: date+merchant+amount+account, same pattern as `budget_ledger.csv`), drop entries older than `lookbackDays` (90), fuzzy-match each against `favorite_places_raw.json`, and recompute every place's `observed` block. **No additional Monarch calls** — this reuses data the script already pulls. Writes `favorite_places.json`, then `build-data.mjs` (already invoked at the end of every pull) bundles it into `data.js` alongside `diningRoutine`.

This means the recommendations get smarter every day as real dining transactions come in, without anyone asking — only the underlying list of places needs an occasional manual nudge.

## The recommendation engine (isolated, swappable unit)

Two functions, both called live by the dashboard each time the Month Plan tab renders (same pattern as the existing Trajectory tab's `computeProjection()` — always current, never a stale baked artifact, and naturally "reactionary": every render reflects however much of the month's budget has actually been spent so far).

### `planRemainingMonth` — decides what happens on which remaining day

```js
// Inputs: plain data already in DATA. Output: one slot per remaining fixed
// occurrence, plus a decision (paid | low-key) for each remaining dynamic
// occurrence. This is the "fill out the remainder of the month" logic.
function planRemainingMonth(diningRoutine, budgetPacing, today) {
  // returns: [{ date, occasion, tier: 'cheap'|'mid'|'high'|'low-key', dynamic }]
}
```
1. Walk every remaining day in the current budget cycle (today → cycle end). Every `dynamic: false` routine day gets its configured tier, unconditionally — takeout and date night always happen.
2. Sum the expected cost of those fixed occurrences using each tier's midpoint $ estimate (cheap≈$25, mid≈$75, high≈$150 — v1 constants, tunable) to get `fixedRoutineCost` for the rest of the cycle.
3. `socialBudget = max(0, impliedRestaurantRoom - fixedRoutineCost)` (`impliedRestaurantRoom` computed the same way as before: remaining joint budget room × 0.24 historical share).
4. For each remaining `dynamic: true` occurrence (in date order), decide **paid** (assign it the configured tier and subtract that tier's midpoint estimate from `socialBudget`) if `socialBudget` can cover it, otherwise decide **low-key** (assign tier `low-key`, subtract $0). This naturally spends down the running pool across the remaining weekends rather than committing it all up front.

### `recommendForSlot` — picks a place (or a low-key idea) for one slot

```js
function recommendForSlot(slot, favorites, recentDiningActivity, lowKeyHangIdeas) {
  // returns: { picks: [...up to 3 places, or 1 low-key idea], reasoning: string }
}
```
- If `slot.tier === 'low-key'`: skip the favorites list entirely and return one pick from `lowKeyHangIdeas` (a small new static list in `goals.json`, e.g. "Host game night," "Walk + coffee at home," "Movie night in" — not restaurant data, so it doesn't belong in `favorite_places.json`). Rotate to avoid repeating the same idea as last time.
- Otherwise: candidates are places in `favorites` whose `list` is `go-to` or `want-to-go`, whose `observed.tier` (if any) is at or under `slot.tier` — places with no observed data default to eligible at `cheap`/`mid` only, not `high` (unproven cost, don't risk it) — and whose `name` doesn't appear in `recentDiningActivity` within the last 10 days. Deprioritize (don't exclude) any cuisine matching the single most recent `recentDiningActivity` entry. Return the top 3 remaining (or fewer if the list is short).

Both functions are plain heuristics on purpose — the function boundaries are the point. A v2 could replace either body with a scoring model or a call to Claude with the same inputs/output shape, without the other function or the calendar UI needing to change.

## Month Plan tab (6th dashboard tab)

- Calendar grid for the current budget cycle (25th→24th, matching the joint tracker's cycle).
- For each remaining day, `planRemainingMonth()` determines whether it's a routine day at all, and if so, what tier (including whether a given Sunday's social slot resolved to paid or low-key). Each such date renders a card: occasion label, tier/estimated cost, and the live `recommendForSlot()` output (a shortlist of places, or a low-key idea).
- Past dates instead show what `recentDiningActivity` says actually happened that day, if anything matched.
- A summary strip at the top: current Restaurants pacing (reusing `D.budgetTracking.joint`), how much of `impliedRestaurantRoom` is left, and how many of the remaining "Weekend social" occurrences are projected paid vs. low-key under the current plan.
- Non-routine, non-social days render as plain empty calendar cells.

## Future work (explicitly not in v1)

- **Calendar integration** — syncing planned occasions to an actual calendar (Google Calendar or similar) for further social planning. This is also the real fix for date night's Friday/Saturday ambiguity below — reading the actually-scheduled day from the calendar instead of guessing.
- **Reservations** — using the calendar integration above to actually book/hold reservations for planned date-night or social outings, rather than just suggesting where to go.

Noted here so the v1 data shapes (`slot`, `occasion`, dates) don't need to be redesigned later to support them, but neither is built now.

## Error handling / edge cases

- No Google Sheet sync has ever run → `favorite_places_raw.json` doesn't exist → Month Plan tab shows a callout ("no favorites synced yet — ask Claude to sync your dining list") instead of erroring.
- A slot has zero eligible candidates after filtering (e.g., everything's been visited recently) → `picks: []`, `reasoning` explains why, tab shows "no fresh picks — everything eligible was visited in the last 10 days."
- `socialBudget` goes negative before all dynamic occurrences are planned (fixed routine alone already exceeds room) → every remaining "Weekend social" occurrence for the rest of the cycle resolves to low-key; summary strip says so plainly rather than showing a confusing $0-ish paid suggestion.
- Merchant fuzzy-matching is inherently imperfect (e.g. "TST*GREAT WHITE" vs. sheet's "Great White") — matches are substring-based and case-insensitive; a real mismatch just means that visit logs as `matchedPlace: null` (still counts for recency/variety of *some* dining-out event, just not attributed to a specific favorite) rather than crashing or silently attaching to the wrong place.
- In real life, date night lands on Friday *or* Saturday, not both — the v1 `diningRoutine` models it as a single dynamic Friday slot rather than building day-alternation logic with no real signal to base it on. Same rationale as above: the real fix is calendar integration (see Future work), not a heuristic for picking which day.

## Testing

- Unit-style: run `planRemainingMonth()` and `recommendForSlot()` headlessly (same Node harness pattern already used to test the dashboard this session) against hand-built scenarios — plenty of room, tight/already-over budget, no observed data, everything recently visited, a cycle where fixed routine cost alone exceeds `impliedRestaurantRoom` — and check the returned plan/tiers/picks/reasoning make sense in each case.
- Integration: run the extended `budget-tracking-pull.mjs` against live Monarch data once, confirm `favorite_places.json` populates with real observed stats and `recentDiningActivity` matches known recent transactions (e.g. the already-confirmed Piccolino/Great White history).
- Visual: open the dashboard, click into Month Plan, confirm the calendar renders, fixed slots always appear, dynamic Sunday slots resolve sensibly given current pacing, and the summary strip matches the Joint tracker shown on the Goals tab.
