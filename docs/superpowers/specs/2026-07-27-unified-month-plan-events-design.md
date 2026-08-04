# Unified Month Plan Events — Design

*2026-07-27*

## Context

The Month Plan tab (`dashboard_v5.html`) has two mechanisms sharing one calendar today: **routine slots** (Wed/Fri/Sun, driven by `goals.json`'s `diningRoutine`, rendered as a `<select>` via `buildSlotSelect()`, override-only — you can change the pick but can't remove the occasion, and it's shown under a fixed label like "Date night") and **ad-hoc events** (free-form name + manual tier, non-routine days only, fully removable). Kevin wants these unified into a single "event" concept everywhere: removable, editable in place, color-coded by whether it's a live AI suggestion or something a human decided, with cost auto-filled when a real favorite is picked instead of a manual tier guess. Fixed occasion labels disappear from the UI (cells show only the pick), but the day-of-week scheduling and the category-based filtering both stay — they just aren't displayed as named categories anymore. Past days show what the credit card actually confirms happened (Monarch-verified), which always wins over whatever was planned, since plans change.

A second gap surfaced during design: today every occasion pulls from the same undifferentiated favorites pool (tier + `familyFriendly` only). Kevin wants three real categories — stroller-friendly (existing), date-night dinners, and social (bars/drinks/apps/lunches) — actually filtering which favorites are eligible for which occasion, not just budget-tiering the same list three ways. This reuses the existing generic `requiresTag` mechanism (already built for `familyFriendly`) rather than adding new filter code.

This design was worked through in two passes: an initial architecture pass in Claude Code's plan mode (approved, saved at `C:\Users\Family\.claude\plans\what-does-dashboard-use-concurrent-flame.md`), then firmed into concrete signatures here. Decisions below are final; this doc supersedes `2026-07-27-month-plan-interactivity-design.md`'s override/slot model.

## Data model

`localStorage['monthPlan.v1']` collapses to one key (`slotOverrides` and `resolveOverride()` are deleted entirely):

```json
{ "events": {
  "2026-07-31": [ { "source": "manual", "name": "Terroni", "favoriteName": "Terroni", "tier": "mid", "cost": 62 } ],
  "2026-08-02": []
} }
```

- **`source`** is always `"manual"` when stored — there is no `source: "ai"` value in storage. "AI" is a *rendering state*: a routine day (per `diningRoutine`) with **no key present at all** for that date gets a live, unpersisted suggestion computed fresh every render via `recommendForSlot()`. The moment a human saves or removes it, it becomes a real stored `manual` event (or a tombstone, see below) and stops being recomputed.
- **`favoriteName`** — set when the event is linked to a real favorite; enables edit-form pre-fill and drives the cost lookup. Absent for free-text events and low-key picks.
- **`tier`** / **`cost`** — `cost` is the concrete dollar figure used by budget math, resolved once at save time: a linked favorite's `observed.avgSpend` if it has spend history, else `TIER_MIDPOINT[tier]`. A low-key pick has `cost: 0`, no `tier`.
- **An empty array (`[]`) is a meaningful, stored value** — "this routine day's AI suggestion was explicitly dismissed; never regenerate it." Requires changing `removeEvent()`'s current behavior (which deletes the date key once its array empties) to leave `[]` in place instead. For non-routine days this is a no-op change (absent key vs. `[]` render identically there, since neither is a routine day that would otherwise auto-populate).

## `diningRoutine` (goals.json) changes

```json
"diningRoutine": [
  { "dayOfWeek": 3, "tier": "mid", "dynamic": false, "requiresTag": "familyFriendly" },
  { "dayOfWeek": 5, "tier": "mid", "dynamic": true,  "requiresTag": "dinnerSpot" },
  { "dayOfWeek": 6, "tier": "mid", "dynamic": true,  "requiresTag": "socialSpot" }
]
```

Changes from today: `occasion` field dropped (never displayed, no longer needed — a date's routine-day-ness is now determined purely by `dayOfWeek` matching, and `buildEventChip`/live-suggestion logic doesn't need a label string); weekend social moves from `dayOfWeek: 0` (Sunday) to `dayOfWeek: 6` (Saturday); Friday and Saturday both gain a `requiresTag` pointing at a new boolean field.

## Favorites categorization

`favorite_places_raw.json` entries gain up to two new boolean fields, `dinnerSpot` and `socialSpot` (a place can have both, or neither — `familyFriendly` already exists and is unaffected). As part of implementation, do one best-guess categorization pass over all ~90 entries using name/cuisine/notes (sit-down dinner-appropriate → `dinnerSpot`; bars, wine bars, casual apps-and-drinks/lunch spots → `socialSpot`; many will get both) — present the full resulting list to Kevin for review/correction before committing, the same way earlier favorites-list changes this session were spot-checked. `recommendForSlot()`'s filtering logic needs no change beyond the reasoning-string fix below and the cross-render exclusion in the next section — it already does generic `if (slot.requiresTag && !f[slot.requiresTag]) return false;`. One small edit is needed there regardless: its `reasoning` string currently interpolates `slot.occasion` (`` `${slot.occasion}: ${slot.tier} tier...` ``), which no longer exists once `occasion` is dropped from `diningRoutine` — reword to `` `${slot.tier} tier, excluding anything visited in the last ${RECENT_VISIT_EXCLUSION_DAYS} days.` `` (drop the now-meaningless occasion prefix; the empty-picks branch already doesn't reference it).

## Cross-render repetition exclusion

Real-data testing surfaced a separate problem, not fixed by the dinner/social split above: `recommendForSlot()` has no memory across the days it's called for in one render, so a favorite that never gets "visited" (no real transaction ever triggers the 10-day recency exclusion) wins every eligible slot for the whole month — e.g. the same restaurant showing up for every single Friday. `recommendForSlot()` gains one more parameter, `alreadyUsedNames` (a `Set<string>`), applied in the same candidate-filtering phase as the existing recency exclusion: `if (alreadyUsedNames.has(f.name)) return false;` (skip if that would leave zero candidates for the slot — in that case, don't filter, allow the repeat rather than showing nothing). This is a plain exclusion filter, not a ranking/scoring heuristic — deliberately minimal, because the actual picking logic inside `recommendForSlot()` is the intended future swap point for a real AI/LLM call (already noted in that function's existing comment), and this exclusion is designed to keep working unchanged at that point: the AI would receive the same already-filtered candidate list, this rule doesn't need reimplementing.

`planRemainingMonth()`'s per-day walk accumulates `alreadyUsedNames` as it resolves each day — every live suggestion's picked name (and every stored event's `favoriteName`, if set) gets added to the set before moving to the next day, so later days in the same walk see what earlier days already claimed. Only live (unpersisted) suggestions call `recommendForSlot()`; stored events don't need re-filtering since they're already a human's explicit decision.

## Budget math (`planRemainingMonth`)

New signature: `planRemainingMonth(diningRoutine, budgetPacing, today, events, favorites, lowKeyHangIdeas)` — `events` replaces `overrides` (the `{slotOverrides, events}` wrapper is gone; this is just the `events` map). One per-day resolution replaces the old three-source reconciliation (`routineSlots` generation + `eventSlots` read + `resolveOverride()`), walked chronologically exactly as today (fixed cost order matters — an event/edit earlier in the month affects only later, not earlier, resolution):

```js
const alreadyUsedNames = new Set();
for (const dayEvents of Object.values(events)) {
  for (const ev of dayEvents) { if (ev.favoriteName) alreadyUsedNames.add(ev.favoriteName); }
}
for (let d = today; d <= cycleEnd; d.setDate(d.getDate()+1)) {
  const dISO = isoDate(d);
  if (events[dISO]) {
    // Stored (possibly []). Each event contributes its own `cost`
    // unconditionally — a human decided this, budget adapts around it.
    for (const ev of events[dISO]) { socialBudget -= ev.cost; projectedSpend += ev.cost; resolvedSlots.push({date: dISO, ...ev}); }
    continue;
  }
  const routineEntry = diningRoutine.find((r) => r.dayOfWeek === d.getDay());
  if (!routineEntry) continue; // non-routine, untouched: nothing
  const rec = recommendForSlot({tier: routineEntry.tier, dynamic: routineEntry.dynamic, requiresTag: routineEntry.requiresTag}, favorites, recentDiningActivity, lowKeyHangIdeas, alreadyUsedNames);
  if (rec.picks[0]) alreadyUsedNames.add(rec.picks[0]); // claim it so later days in this same walk don't repeat it
  // fixed (dynamic:false): always happens, same cost-and-subtract as before.
  // dynamic (dynamic:true): resolve paid-vs-low-key against remaining socialBudget, same as today's unoverridden-dynamic-slot logic.
}
```

Return shape unchanged (`slots`, `impliedRestaurantRoom`, `fixedRoutineCost`, `socialBudgetRemaining`, `projectedSpend`) — `fixedRoutineCost` keeps meaning "routine-day fixed cost," now computed inline in the same loop rather than a separate pass.

## Rendering (`renderMonthPlan`)

Every future-day cell — routine or not — renders through one path: existing event chips (from `events[dISO]`, or the single live AI suggestion when the key is absent on a routine day) + an "+ add" control. `isRoutineDay`/`buildSlotSelect` branching is deleted.

**Chip markup:** `<div class="cal-event-chip {ai-accent-class-if-live}">{name} · {tier symbol or ''}<button onclick="onEditEvent(...)">✎</button><button onclick="onRemoveEvent(...) or onDismissLiveEvent(...)">✕</button></div>` — clicking the chip (or a pencil icon) opens the edit form pre-filled with current name/favoriteName/tier; clicking ✕ removes/dismisses without opening the form.

**Search field / edit form**, one shared component for add and edit:
```html
<input list="favorites-list-{date}" id="event-name-{date}" value="{current name, if editing}">
<datalist id="favorites-list-{date}">{one <option> per favorite name + per lowKeyHangIdeas entry}</datalist>
<select id="event-tier-{date}">...</select>  <!-- shown/enabled only when no exact favorite/low-key match -->
<button onclick="onSaveEvent(...) or onSaveLiveEvent(...)">Save</button>
```
`onchange` on the name input checks for an exact match against `favorites`/`lowKeyHangIdeas`; a favorite match auto-fills `tier`/`cost` from `observed` (or `tier:'mid'` if unproven) and hides the manual tier picker; a `lowKeyHangIdeas` match sets `cost:0`, hides the tier picker; no match shows the tier picker for a manual pick (defaults `cheap`, matching today's ad-hoc form).

**Handlers:**
- `onShowEventForm(date, index)` — opens the shared add/edit form for a *stored* event, pre-filled from `events[date][index]`. Replaces today's `onShowEventForm(date)` (which only ever opened a blank add-form); `index` is `null`/omitted for a brand-new event on a non-routine day (blank form).
- `onShowLiveEventForm(date)` — opens the same form for a *live, unpersisted* AI suggestion, pre-filled from that suggestion's current pick (name/tier), reached by clicking the live-suggestion chip itself.
- `onSaveEvent(date, index, name, tier)` — edits an already-stored event in place (replaces the array entry at `index`), resolving `favoriteName`/`cost` the same way `onAddEvent` does today.
- `onSaveLiveEvent(date, name, tier)` — materializes a previously-live AI suggestion: writes `events[date] = [{source:'manual', ...}]`.
- `onRemoveEvent(date, index)` — unchanged signature; now leaves `[]` instead of deleting the key when the array empties.
- `onDismissLiveEvent(date)` — removes a live (never-stored) AI suggestion: writes `events[date] = []` directly (tombstone, no index to act on).
- `onAddEvent(date, name, tier)` — unchanged for non-routine days (appends a new event to an existing or new array); reachable via `onShowEventForm(date, null)`'s blank form.

**Color accent:** a live AI suggestion (nothing stored for that date, routine day) renders with a `var(--blue)` left-border accent on its chip; anything stored (human-created or human-edited, `source: 'manual'`) renders with no accent. `.cal-lowkey`'s existing `var(--green)` for low-key resolution is untouched and can combine with the AI accent (a live, budget-flipped-to-low-key suggestion is still "AI" until touched).

**Past-day cells** (`isPast` branch): render `recentDiningActivity` matches through the same chip markup, but showing the **real dollar amount** (`fmt(a.amount)`, the actual Monarch-verified spend) instead of a tier symbol — this is a hard requirement, not cosmetic: a tier symbol is a budget-planning estimate, the past-day chip's whole purpose is to show what was *actually* spent. No edit/remove buttons (read-only history). Replaces the current bespoke two-line HTML with the same chip component used elsewhere, just with cost-display swapped from tier-symbol to real-amount. No new color needed; `.cal-past{opacity:.55}` on the whole cell already distinguishes history from plan. This is a visual-consistency change only — the underlying behavior (actual spend always wins for past dates, regardless of what was planned) is unchanged from today.

## Functions removed

`resolveOverride()`, `buildSlotSelect()`, `optionHTML()`, `onRoutineSlotChange()`, `onRoutineSlotReset()`, `setSlotOverride()`, `clearSlotOverride()` — all deleted, fully superseded by the unified event model above.

## Error handling / edge cases

- Corrupt/missing `localStorage` — same degrade-quietly pattern as today (`loadMonthPlanState()` try/catch, default `{events: {}}`).
- A stored event's `favoriteName` references a favorite since removed from the sheet (e.g. today's Piccolino closure) — render the stored `name`/`tier`/`cost` as-is (it's still a valid, human-decided plan; the favorite link is only used for edit-form pre-fill convenience, not required for display). No fallback-to-recommendation needed since there's no "override" concept anymore to fall back from.
- `D.favoritePlaces === null` (no sheet sync yet) — routine days can't produce a live AI suggestion (no favorites to recommend from) and fall back to an empty cell with just the "+ add" control; non-routine day events are unaffected (same as today's `!fp` guard, generalized).
- Removing the last event via `onRemoveEvent` always leaves `[]`, never deletes the key — this is a deliberate behavior change from the current `removeEvent()` (documented above), needed so a dismissed routine-day suggestion doesn't reappear.

## Testing

Same headless-harness, throwaway-test-script convention used throughout this project. Key behaviors to verify: an untouched routine day's live suggestion recomputes on every render (reactive to budget pacing) and is never persisted; saving an edit to a live suggestion materializes it as `source: manual` and it stops recomputing; dismissing a live suggestion leaves `[]` and it never regenerates; a non-routine day's event with a matched favorite gets the right auto-filled cost, and an unmatched free-text one requires/respects the manual tier pick; the chronological budget-walk ordering still holds (an earlier event/edit affects only later unresolved dynamic days); Friday (`dinnerSpot`) and Saturday (`socialSpot`, moved from Sunday) recommendations are correctly filtered once favorites are tagged; a past day renders actual spend regardless of any stored/live plan for that date; `alreadyUsedNames` exclusion — construct a fixture where fewer eligible favorites exist than eligible slots in the render, confirm each gets a distinct pick until candidates run out, then confirm a repeat is allowed (not an empty pick) rather than showing nothing.

## Future work (carried over, still not in v1)

Calendar integration / reservations (already noted in the original dining-recommendations spec) — unaffected by this redesign.
