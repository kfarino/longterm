# Month Plan Interactivity — Design

*2026-07-27*

## Context

The Month Plan tab (`docs/superpowers/specs/2026-07-26-dining-recommendations-design.md`) renders a calendar of auto-generated dining suggestions for the rest of the budget cycle, but it's read-only: Kevin can't tell it "actually we're going to Terroni, not the suggested place" or add a one-off plan for a day the routine doesn't cover (e.g. a lunch with a friend). This adds:

1. A dropdown on each routine-slot day (Wed family dinner, Fri date night, Sun weekend social) that defaults to the engine's recommendation but lets Kevin override it to any favorite or a low-key idea, saved across reloads.
2. An "add event" control on every other day, for one-off plans with a rough cost tier ($/$$/$$$), also saved.
3. The budget math the tab already does (`planRemainingMonth()`) becomes override-aware: a pricier override or a new ad-hoc event reduces what's implied available for later slots, so the plan stays internally consistent as Kevin fills it in — not just a static assumption computed once from `diningRoutine`.

No backend exists (the dashboard is a static file opened via `file://`), so persistence is browser `localStorage` — single-browser, single-machine, no sync. That's an accepted v1 limitation; multi-device sync would need calendar integration (already scoped as future work in the dining-recommendations spec), not built here.

## Data model

### `localStorage['monthPlan.v1']`
```json
{
  "slotOverrides": {
    "2026-07-31": { "type": "favorite", "name": "Great White" },
    "2026-08-02": { "type": "lowkey", "name": "Host game night" }
  },
  "events": {
    "2026-07-28": [
      { "name": "Cheeky lunch with Sarah", "tier": "cheap" }
    ]
  }
}
```
- `slotOverrides` — one entry per routine-slot date that's been overridden (each routine day has exactly one slot today, per `diningRoutine`'s current 3 entries — Wed/Fri/Sun never collide). `type` is `"favorite"` (value = the favorite's `name`, matched against `D.favoritePlaces.places`) or `"lowkey"` (value = one of `D.lowKeyHangIdeas`). Absent key = no override, engine's rec stands.
- `events` — array per date, only ever written for non-routine days. `tier` is `"cheap"|"mid"|"high"` (existing vocabulary; displayed as $/$$/$$$). Multiple events per day allowed.
- Read once per `renderMonthPlan()` call. Every dropdown/event-form change writes back to `localStorage` and calls `renderMonthPlan()` again — cheap, and keeps a single code path (no partial-DOM-patch logic to maintain).
- A "↺ reset" control on an overridden routine slot deletes its `slotOverrides` entry. A ✕ on an event chip removes it from that date's array (deleting the date's key entirely if the array becomes empty).

## Budget recompute algorithm

`planRemainingMonth()` gains a 4th parameter: `planRemainingMonth(diningRoutine, budgetPacing, today, overrides)`, where `overrides` is the parsed `localStorage['monthPlan.v1']` object (or `{slotOverrides:{}, events:{}}` if absent/corrupt).

Build one combined, date-sorted list covering the rest of the cycle:
- Routine slots from `diningRoutine`, exactly as today (`{date, occasion, tier, dynamic, requiresTag}`).
- Ad-hoc events from `overrides.events`, one pseudo-slot per event: `{date, occasion: event.name, tier: event.tier, dynamic: false, isEvent: true}`.

Walk the combined list in date order, maintaining a running `socialBudget` (starts at `impliedRestaurantRoom`, same as today):
- **effectiveCost(slot)** — if `slot.date` has a `slotOverrides` entry: `type:"favorite"` → the favorite's `observed.avgSpend` if it has tracked spend, else `TIER_MIDPOINT[slot.tier]` (unproven-cost fallback, e.g. a want-to-go place never visited); `type:"lowkey"` → `0`. No override → `TIER_MIDPOINT[slot.tier]` (today's behavior, unchanged).
- **Always-happens items** — fixed routine slots (`dynamic:false`), ad-hoc events (`isEvent:true`), and any *dynamic* slot that has an override — unconditionally subtract `effectiveCost(slot)` from `socialBudget` as encountered, no affordability check. A manual choice (routine override or an added event) is never second-guessed by the budget; it just happens, and its real cost reduces room for whatever comes later in date order.
- **Unresolved dynamic slots** (Fri/Sun, no override) — resolve against whatever `socialBudget` remains at that point in the walk: paid at `slot.tier` if `socialBudget >= TIER_MIDPOINT[slot.tier]` (subtract and keep as-is), else resolved to `'low-key'` (today's behavior, unchanged, just now position-in-the-walk-dependent rather than "all fixed first, then all dynamic").

Return value gains one new field: `projectedSpend` — the sum of every `effectiveCost` actually subtracted during the walk (i.e. total planned dining spend for the rest of the cycle: fixed slots + events + resolved-paid dynamic slots; low-key dynamic slots contribute `0`). `fixedRoutineCost` keeps its current meaning (routine-only, unoverridden-tier assumption) for the caption line described below; it does not need to change shape.

A stale override — `slotOverrides` names a favorite no longer in `D.favoritePlaces.places` (e.g. a removed favorite like today's Piccolino) — is treated as no override for that render (falls back to the engine's auto-rec) and is silently dropped from `localStorage` on the next save to that date, rather than erroring or persisting a dangling reference forever.

## UI / interaction

**Routine-slot cells** (Wed/Fri/Sun, today-or-future): the current `<div class="cal-pick">` text becomes a `<select class="cal-pick-select">`. Options, in order: every pick `recommendForSlot()` returns (up to 3, its existing behavior) listed first — the first of these is pre-selected as the default when no override exists — then an `<optgroup>` separator, then every remaining `go-to`/`want-to-go` favorite alphabetically (`D.favoritePlaces.places`, unfiltered by tier/recency — a manual override is intentionally not budget- or recency-gated; favorites already listed as one of the top picks aren't repeated), and — only when `slot.dynamic` — one option per `D.lowKeyHangIdeas` entry. `onchange` writes to `slotOverrides[date]` and re-renders. When an override is active, a small `↺` button appears next to the select; clicking it deletes the override and re-renders.

**Non-routine cells** (any day with no `diningRoutine` match, today-or-future): a small "+ add event" link. Clicking it reveals an inline `<input type="text">` (name) + a 3-way `$`/`$$`/`$$$` tier toggle + a confirm control; submitting appends to `events[date]` and re-renders. Existing events for that date render as small chips (`name · $$`) each with a `✕` to remove.

**Past-day cells**: unchanged — still show actual `recentDiningActivity`, no dropdown/event-adding (a plan for an already-passed day isn't actionable).

## Summary strip (redesign, replaces the current 4-stat layout)

The current four boxes (Restaurants room left / Fixed routine cost / Social budget remaining / Weekend social paid-vs-low-key count) chain one subtraction across four separate numbers and read as confusing (direct user feedback). Replaced with three stat boxes plus a caption:

1. **Dining budget, rest of cycle** — `plan.impliedRestaurantRoom` (same figure as today's "Restaurants room left", renamed).
2. **Planned spend** — `plan.projectedSpend` (new). Caption underneath: `"<N> paid outings, <M> low-key hangs planned"` (N/M computed the same way the old 4th box's count was, just demoted from its own box to a caption).
3. **Vs. budget** — `plan.impliedRestaurantRoom - plan.projectedSpend`, rendered as `"$<abs> under budget"` (green) if ≥ 0, or `"$<abs> over budget"` (red) if negative. This is the number that replaces the mental subtraction the old layout required.

`fixedRoutineCost` remains available on the `plan` object (other code/future callers may want it) but is no longer surfaced as its own stat box.

## Error handling / edge cases

- Corrupt/unparseable `localStorage['monthPlan.v1']` JSON → treat as `{slotOverrides:{}, events:{}}`, don't throw. Matches this project's existing degrade-quietly pattern (`build-data.mjs`, `refreshFavoritePlaces()`).
- Stale favorite-name override (favorite removed from the sheet) → see above, falls back to auto-rec, self-heals on next save.
- `D.favoritePlaces === null` (no sheet sync has ever run) → routine-slot dropdowns can't populate (no favorites list); those cells fall back to today's plain-text engine rec, no select rendered. Ad-hoc events on non-routine days are unaffected (they don't depend on favorites data) and still work.
- `localStorage` unavailable (e.g. private-browsing mode in some browsers, or a `file://` origin with storage disabled) → wrap all `localStorage` reads/writes in try/catch; on failure, the tab still renders (falls back to `{slotOverrides:{}, events:{}}`, effectively read-only for that session) rather than breaking the whole Month Plan tab.
- Removing the last event for a date deletes that date's `events` key entirely rather than leaving an empty array around.

## Testing

Extend `Longterm/data/dashboard-test-harness.mjs` with an in-memory `localStorage` stub (`getItem`/`setItem`/`removeItem`/`clear`, backed by a `Map`, attached to `global.window.localStorage` and `global.localStorage`) so overrides/events can be exercised headlessly — same throwaway-per-task-test-script convention as every prior task in the dining-recommendations plan.

Key behaviors to verify:
- A routine-slot override changes that slot's rendered pick and its `effectiveCost`.
- Overriding an early dynamic slot to a pricier favorite flips a later, still-unoverridden dynamic slot from paid to low-key (the core new recompute behavior).
- An ad-hoc event on a non-routine day between two dynamic slots reduces `socialBudget` for the later one but not the earlier one (chronological-order correctness).
- `projectedSpend` matches the sum of effective costs actually applied during the walk.
- A stale override (favorite name not in the current favorites list) falls back to the auto-rec and doesn't throw.
- Corrupt `localStorage` JSON doesn't throw; tab renders with no overrides/events.
- The summary strip's three stats and caption match hand-computed expectations for a constructed scenario.

## Future work (explicitly not in v1)

- Multi-device sync (would require calendar integration or a real backend — already noted as future work in the dining-recommendations spec).
- Per-slot "why did this flip to low-key" explanation in the UI (the recompute is currently silent about *why* a later slot's resolution changed — visible in the numbers, not narrated).
