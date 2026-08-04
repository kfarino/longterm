# Dashboard IA v2 — Budget | Current Position | Goals & Decisions — Design

*2026-07-29, revised same day after live feedback*

## Revision note (same-day)

After building the above, Kevin reviewed it live and asked for a further round of changes — the nav is now **Budget | Current Position | Goals | Decisions** (4 tabs, "Goals" split back out from "Goals & Decisions" rather than staying merged):

- **Budget**: dropped the motivator callout and urgent-decision peek entirely (`renderMotivatorCallout()`/`goalProgress()`/`jumpToGoals()`/`renderUrgentPeek()` all removed) — "the 'on pace' feature was missing the mark." Urgency now shows as a red color on the **Decisions** nav tab itself (`.ntab-urgent`, toggled by `renderDecisionsTab()`) instead of a banner. The Month Plan calendar's old 3-box stat-strip ("Dining budget, rest of cycle" / "Planned spend" / "Vs. budget") is gone — that framing moved into the Joint spend tracker itself: `computeMonthPlanProjectedSpend()` re-derives the same remaining-cycle dining figure `renderMonthPlan()` computes, and `renderSpendTracker()` folds it into Joint's note as "$X logged + $Y planned (dining, rest of cycle) = $Z known so far" (Kevin personal keeps the old plain extrapolated-projection wording, unaffected — the calendar only ever knew about dining, so this is presented as a floor, not a full projection, an explicit limitation Kevin flagged and accepted).
- **Current Position → Status**: phase cards moved out entirely (to the new Goals tab) — Status is now just the topline readout (net worth composition, monthly surplus, asset allocation, future assets).
- **Goals** (new top-level tab, `renderGoalsTab()` → `pg-goals`): savings-goal progress bars + retirement stat, then the 6 phase cards, then the merged milestone timeline — all three "why we save / where we are / when things happen" pieces in one place.
- **Decisions** (`renderDecisionsTab()` → `pg-decisions`, reverted from "Goals & Decisions"): back to just decision cards (urgent-this-week | this-quarter, two plain columns) — "like before," no goals, no timeline.

A fresh on-demand Monarch pull (`node scripts/budget-tracking-pull.mjs --output-path ... --goals-path ...` pointed at this worktree's own `data/` files) populated real `categories` data for Joint and Kevin personal, confirming the category drill-down (which had only ever shown a "no data yet" fallback in testing) renders correctly against live data — resolving what looked like an asymmetry with Travel's drill-down (which had data because trip transactions were already being collected; Joint/Kevin's `categories` field simply hadn't been populated by a real run yet).

## Original context (2026-07-29, first pass)

The 2026-07-28 redesign (`2026-07-28-dashboard-ia-redesign-design.md`) collapsed 6 tabs into 3 (Budget | Long-Term Plan | Decisions) and was fully implemented on this worktree branch. Kevin tried it live and it still wasn't right: the Budget tab led with dense week-by-week numeric rows instead of the actual weekly workflow tool (the Month Plan calendar), and the Long-Term Plan tab's click-to-expand accordion was awkward to use. Iterating from there, Kevin landed on a different top-level split — **Budget | Current Position | Goals & Decisions** — and asked for savings goals and milestones to move out of "the plan" entirely and sit with Decisions instead, since milestones/decision-gates/decision-cards all describe the same breakpoints and were previously split across two tabs in two shapes.

This supersedes the 6-tab-to-3-tab **nav structure and Long-Term-Plan/Decisions split** from the 2026-07-28 spec. The Budget tab's groundwork from that pass (urgent peek, Month Plan calendar as a nested mount point) is reused as-is.

## Nav & page structure

```html
<div class="nav">
  <div class="ntab active" id="ntab-budget"          onclick="show('budget',this)">Budget</div>
  <div class="ntab"        id="ntab-position"        onclick="show('position',this)">Current Position</div>
  <div class="ntab"        id="ntab-goals-decisions" onclick="show('goals-decisions',this)">Goals &amp; Decisions</div>
</div>
<div class="page active" id="pg-budget"></div>
<div class="page"        id="pg-position"></div>
<div class="page"        id="pg-goals-decisions"></div>
```

Budget and Goals & Decisions render eagerly at init (both cheap string builds). Current Position renders lazily on first `show('position', ...)`, same lazy-init convention as before.

## Budget tab (`renderBudgetTab()`)

In order: urgent-decision peek (unchanged) → **motivator callout** (new) → Month Plan calendar (unchanged, now leads instead of trailing) → Joint/Kevin spend bars + category drill-downs (new, replaces the old week-row list) → Travel summary + per-trip drill-down (new, replaces the old plain actual/budgeted list).

- **`renderMotivatorCallout()`** picks whichever `D.goals` entry is closest to its target (`goalProgress()`) and phrases on-pace/over-pace wording based on the Joint tracker's projected-vs-target math (`computeTrackerPacing()`, shared with `renderSpendTracker()` so both agree). Click → `jumpToGoals()`.
- **`renderSpendTracker(label, tracker, drillId)`** replaces `renderTracker()`: a single fill bar (reusing `.goal-bar`/`.goal-fill`, the exact same visual language as the savings-goals list — no new CSS) plus a one-line pacing note, and a click-to-expand "Spend by category" row (reusing the `.exp-toggle`/`.exp-lines` convention from the Phases cards) revealing `renderCategoryDrilldown()`.
- **`renderTravelSummary(travel)`** replaces `renderTravelTracker()`: per-trip bar (or an "already paid" line for a trip with no `budgetedAmount`), click-through reveals that trip's real transactions.
- **`toggleDrilldown(id)`** is a small generic show/hide toggle shared by both drill-down kinds — decoupled from the phase-card-specific `toggleExpPanel()`, which manipulates a `.tv` amount label that neither spend bars nor travel bars have.

## Current Position tab — 2 sub-tabs (`renderPositionTab()`, `showPosition()`)

Replaces the 3-section accordion entirely with a `.subnav`/`.subtab`/`.subpage` pattern — visually and behaviorally the same interaction as the top-level nav, one level down (real CSS classes drive visibility, no inline `style.display` toggling, matching how the top-level `show()` already worked):

- **Status** (default) — `renderStatusSection()`, verbatim today's readout (net worth composition, monthly surplus) + all 6 phase cards. This is unchanged from the prior pass's `renderPlanSection()`, just retargeted and renamed — it never included goals/milestones to begin with.
- **Trajectory** — unchanged internals (chart, sliders, scenario buttons). Keeps the lazy-render-on-first-open behavior (`renderedSections` Set), now triggered by `showPosition('trajectory', ...)` instead of an accordion-open event — `initChart()` still only runs once, against an already-active container.

## Goals & Decisions tab (`renderGoalsDecisions()`)

One flowing page, in order:
1. **`renderGoalsSection()`** — savings-goal progress bars + retirement-projection stat, moved here verbatim from the old `renderTargetsSection()` (minus its milestones sub-list — see below). Wrapped in `id="goals-block"`, the scroll target for `jumpToGoals()`.
2. Decision cards, unchanged layout (urgent-this-week | this-quarter + timeline, two columns).
3. **Merged timeline** replaces the old plain "Decision gates" row list in the right column: `goals.json`'s `milestones` and `decisionGates` — two lists describing mostly the same breakpoints, in two different shapes — collapse into one canonical `timeline` array (14 entries), rendered with the same `.milestone`/`.ms-spine`/`.ms-dot` visual the old Goals tab already had.

`jumpToTrajectory()` (called from the retirement stat above) is now a genuine cross-tab jump: `show('position', ...)` → `showPosition('trajectory', ...)` → scroll into view, since Trajectory no longer lives on the same tab as Goals.

## Data model change

`goals.json`: `milestones` (rich: year/title/detail/dotColor) and `decisionGates` (terse: `[label, description]` pairs) → one `timeline` array. `build-data.mjs` bundles it as `D.timeline`; `build-goal-plan-md.mjs`'s "Decision Gates" table becomes a "Timeline" table sourced from the same field. `milestoneLines()` (drives the Trajectory chart's dashed milestone lines) reads `D.timeline` instead of `D.milestones` — unchanged filtering logic, now sees a few more gate-only entries (au pair starts, LexiCo fail-case fallback, etc.) as additional dashed lines; worth a visual check that the chart doesn't get too busy.

`budget_tracking.json`'s `joint`/`kevinPersonal` gain a `categories: [{name, amount}]` field (sorted descending by amount), populated by a new parallel accumulator in `budget-tracking-pull.mjs`'s existing per-transaction loop (`categoryTotalsToArray()`, sibling to the existing `bucketsToWeeks()`). Real data populates on the next Monarch pull; until then `renderCategoryDrilldown()` shows a fallback message.

## Testing

`data/test-dashboard-contract.mjs` rewritten for the new IA: lazy-render boundaries (`pg-position`/`sub-status`/`sub-trajectory` untouched before `show('position', ...)`), Chart constructed exactly once across `showPosition('trajectory', ...)` switch-away-and-back, `jumpToTrajectory()`/`jumpToGoals()` cross-tab behavior, merged-timeline render order, `computeTrackerPacing()` variance sign, `renderCategoryDrilldown()` sorting/fallback, `renderMotivatorCallout()` goal-selection and pace-wording. `dashboard-test-harness.mjs`'s `FakeEl.classList` was upgraded from a no-op stub to an actually-tracking Set, since the new sub-nav (like the top-level nav) relies purely on classList + CSS rather than inline `style.display` — the old stub couldn't observe that.

Manual browser verification (required — this is a visual/IA change, headless tests only prove call order/counts): see the accompanying task plan.
