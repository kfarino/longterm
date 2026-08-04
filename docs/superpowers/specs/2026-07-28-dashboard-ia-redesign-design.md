# Dashboard IA & Visual Redesign — Design

*2026-07-28*

## Context

`dashboard_v5.html`'s 6-tab structure (Goals & Milestones, Current Position, Phases, Trajectory, Decisions, Month Plan) gives a weekly, action-oriented task and a rarely-checked, reference-oriented task equal visual weight. Kevin (the primary user, checks this weekly with Hanna to decide spend against the joint and personal budgets) confirmed directly during design: the weekly budget check-in — checking joint/personal pace and deciding upcoming spend — is the dashboard's primary job; long-term planning (goals, milestones, phases, trajectory) is secondary and reviewed rarely. Today the actual weekly workflow is split and buried: budget-pace data (`renderBudgetTracking()`) sits as the first section of the first tab, but the tool used to *act* on it — the Month Plan calendar — is tab 6 of 6. Current Position also renders a full grid of every phase's expenses (`expGridHTML`), a verbatim duplicate of what the Phases tab already shows in more depth with expand/collapse — confirmed dead weight, not a deliberate feature.

This is a rendering-layer/IA redesign only. No data model changes: `goals.json`/`accounts.json`/`budget_tracking.json`/`favorite_places*.json`/`build-data.mjs` are untouched. `window.DATA`'s shape is identical before and after.

## Nav & page structure

Nav collapses from 6 tabs to 3: **Budget | Long-Term Plan | Decisions**, Budget first/default (today's default is `goals`; this changes the initial `.page.active`/`.ntab.active` markup and the eager-render call in the init block).

```html
<div class="nav">
  <div class="ntab active" onclick="show('budget',this)">Budget</div>
  <div class="ntab"        onclick="show('longterm',this)">Long-Term Plan</div>
  <div class="ntab"        onclick="show('decisions',this)">Decisions</div>
</div>

<div class="page active" id="pg-budget"></div>
<div class="page"        id="pg-longterm"></div>
<div class="page"        id="pg-decisions"></div>
```

`pg-monthplan` is **not deleted** — it becomes a nested `<div id="pg-monthplan"></div>` inside `pg-budget`'s rendered content, keeping its literal id so `renderMonthPlan()` and every function it calls (`planRemainingMonth`, `recommendForSlot`, `buildEventChip`, `buildEventForm`, every `on*` handler) needs zero internal changes — they only ever address `pg-monthplan` and ids scoped inside their own innerHTML.

## Budget tab (`renderBudgetTab()` — new)

Writes to `pg-budget`. In order:
1. **Urgent-decision peek** (`renderUrgentPeek()` — new, pure string builder over `D.decisions.filter(d => d.status === 'urgent')`): a clickable banner, present only when at least one urgent decision exists, singular/plural wording (`"1 urgent decision needs attention"` vs `"N urgent decisions need attention"`), `onclick` calls `show('decisions', document.querySelector('.ntab'))`-equivalent — concretely, the Decisions nav tab gets a stable id (`ntab-decisions`) so this can target it directly (`onclick="show('decisions', $('ntab-decisions'))"`) rather than a fragile `querySelector` first-match.
2. **`renderBudgetTracking()`** — unchanged (joint + personal weekly trackers via `renderTracker()`, plus `renderTravelTracker()`).
3. **`renderMonthPlan()`** — unchanged, targets the nested `pg-monthplan` div described above.

Both eagerly rendered at page load (part of the init block, not gated by `show()`'s lazy-render `rendered` Set) since Budget is now the default/first-shown tab — this is the direct inverse of today, where Month Plan is the *lazy* one.

## Long-Term Plan tab (`renderLongTermPlan()` — new)

Writes to `pg-longterm`, one scrolling page with 3 accordion sections, "The Plan" open by default:

### Section 1 — "The Plan" (`renderPlanSection()` — new, replaces `renderPosition()` + `renderPhases()`)

A compact "today" status strip — the genuinely unique content from the old Current Position tab (net worth composition: retirement/brokerage/cash totals, monthly surplus, asset-allocation %, future/illiquid assets) — sitting above phase cards built by `buildPhaseCardsHTML()` (extracted pure-string version of today's `renderPhases()` card builder). Two behavior changes from today's Phases tab:
- **Phase 1's card carries a "current phase" badge** (new `.pc-current` pill, navy solid background/white text — see Visual details below) and **defaults to expanded** (skips the click-to-reveal `exp-toggle` only for the current phase), so today's Position tab's "see Phase 1's expenses without clicking" behavior isn't lost by deleting that separate panel. Phases 2-6 keep the existing click-to-expand behavior unchanged.
- **Phase 2's card gains a `.callout`** folding in what was Position's separate "what's next" panel — comparing Phase 1's current surplus against Phase 2's, in the same wording Position used (`"${p2.name} more than covers the gap — surplus increases/decreases into Phase ${p2.id}."`), placed directly on the card the comparison is about rather than a standalone panel elsewhere.

Current Position's `expGridHTML` (the full duplicate all-phases expense grid) is **deleted outright** — it added nothing the phase cards below don't already show, most of them on demand.

### Section 2 — "Trajectory" (`renderTrajectory()` — unchanged internals, one target-id change)

Everything about this section (chart, 5 sliders, 3 scenario buttons, `initChart()`/`refreshChart()`/`updateStats()`) stays byte-for-byte identical. Only the mount target changes: `$('pg-trajectory')` → `$('acc-body-trajectory')`.

**This section is lazier than any tab is today.** Rationale: `initChart()` only ever runs correctly against a laid-out, visible canvas (`.chart-wrap{height:340px}` + Chart.js `responsive:true` depend on real layout) — this is exactly why today's `rendered` Set defers Trajectory's render until `show('trajectory', ...)` has already made the page `.active`/visible. Nesting Trajectory one level deeper (inside a collapsed accordion body) reintroduces that exact risk unless it's deferred one level further too: a second `renderedSections` Set gates `renderTrajectory()`'s first call behind the Trajectory accordion's first "open" transition (reveal-container-first, then-inject-and-init-chart-second):

```js
const renderedSections = new Set();  // accordion body ids inside Long-Term Plan: currently only 'trajectory' needs this

function toggleAccordion(sectionId) {
  const head = $('acc-head-' + sectionId);
  const body = $('acc-body-' + sectionId);
  const opening = body.style.display !== 'block';
  body.style.display = opening ? 'block' : 'none';
  head.classList.toggle('open', opening);
  if (opening && sectionId === 'trajectory' && !renderedSections.has('trajectory')) {
    renderTrajectory();
    renderedSections.add('trajectory');
  }
}
```

"The Plan" and "Targets" have no such dependency (cheap string builds, same cost class as today's `renderPhases()`) and render eagerly when `renderLongTermPlan()` first runs — deferring them further to their own accordion-open event would add complexity with no payoff.

### Section 3 — "Targets" (`renderTargetsSection()` — new, replaces the milestones+goals+retirement portion of `renderGoals()`)

Life milestones timeline (unchanged from today's markup) + savings-goal progress bars (unchanged). The retirement-projection panel **stops independently re-deriving `computeProjection()` for a static display copy** — instead render a compact stat (`"Retirement 2050: ~$9.5M"`, using the same `fmtM()` helper and baseline `D.chart` params as before) that on click calls a new `jumpToTrajectory()`: opens the Trajectory accordion (`toggleAccordion('trajectory')` if not already open) and scrolls it into view (`el.scrollIntoView && el.scrollIntoView({behavior:'smooth', block:'start'})` — guarded so the harness, which has no `scrollIntoView` stub, needs no change).

## `show()` and the top-level `rendered` Set

```js
const rendered = new Set();  // top-level tab ids

function show(id, el) {
  document.querySelectorAll('.page').forEach(p=>p.classList.remove('active'));
  document.querySelectorAll('.ntab').forEach(t=>t.classList.remove('active'));
  $('pg-'+id).classList.add('active');
  el.classList.add('active');
  if (id === 'longterm' && !rendered.has('longterm')) {
    renderLongTermPlan();   // fills acc-body-plan + acc-body-targets; leaves acc-body-trajectory empty
    rendered.add('longterm');
  }
}
```

Init block: `renderHeader(); renderBudgetTab(); renderDecisions();` — all eager (Decisions is cheap and unchanged, same as today).

## Visual details (via `frontend-design` — additive to the existing design system only, no new visual language)

The existing palette/type system (`--navy #1a2744`, `--gold #7a6230`, `--green #2d6a3f`, `--red #8b2c2c`, `--blue #1e4d8c`, `--rule`/`--rule2` borders, `--bg #f4f2ed`, Source Sans 3) and its established conventions (pill-shaped status badges like `.dec-status`/`.ds-urgent`, the `›` glyph already used as an expand affordance in `.exp-toggle`, the generic `.callout` block) are reused directly — no new colors, no new fonts, no icon library.

```css
/* Peek alert — a widened, clickable version of the existing .ds-urgent palette */
.peek-alert{
  display:flex;justify-content:space-between;align-items:center;
  background:#fef2f2;border:1px solid #fecaca;border-radius:3px;
  padding:12px 16px;margin-bottom:20px;font-size:13px;font-weight:600;color:var(--red);
  cursor:pointer;transition:background .15s,border-color .15s;
}
.peek-alert:hover{background:#fee2e2;border-color:#fca5a5}

/* Accordion — reuses the exp-toggle hover convention and the "›" expand glyph,
   rotated open rather than introducing a new chevron icon */
.accordion-head{
  display:flex;justify-content:space-between;align-items:center;cursor:pointer;
  padding:14px 0;border-bottom:1px solid var(--rule);
  font-size:14px;font-weight:700;color:var(--navy);user-select:none;
}
.acc-chevron{font-size:13px;color:var(--sub);transition:transform .18s ease,color .15s;display:inline-block}
.accordion-head.open .acc-chevron{transform:rotate(90deg);color:var(--navy)}
.accordion-head:hover .acc-chevron{color:var(--navy)}
.accordion-body{display:none;padding-top:6px}

/* Current-phase badge — one new member of the existing pill family (.dec-status),
   deliberately solid navy rather than the pastel-bg/dark-text convention the four
   decision-status pills use, since this is a factual marker, not an alert */
.pc-current{
  display:inline-block;font-size:11px;font-weight:700;letter-spacing:.08em;
  text-transform:uppercase;padding:2px 8px;border-radius:2px;
  background:var(--navy);color:#fff;margin-left:8px;
}
```

No new CSS needed for: the today-strip (`.metrics.m4` reused verbatim), Phase-2's delta callout (`.callout` reused verbatim).

## Functions removed

`renderGoals()`, `renderPosition()` — fully superseded by `renderBudgetTab()`/`renderTargetsSection()`/`renderPlanSection()` above. The old top-level `pg-goals`, `pg-position`, and top-level `pg-trajectory`/`pg-monthplan` page divs are removed from the HTML skeleton (Trajectory and Month Plan become nested elements as described above). `renderPhases()` is refactored into `buildPhaseCardsHTML()` (pure string builder, no longer writes directly to a page div itself).

## Explicitly deferred

Goal-card progressive disclosure (`goals.json`'s `lifeGoals` entries carry `targetYear`/`status` fields that are currently unrendered) — real potential follow-on, not requested for this redesign, not built speculatively.

## Testing

Same headless-harness, throwaway-test-script convention used throughout this project (`Longterm/data/dashboard-test-harness.mjs`'s `loadDashboard()`). None of `renderGoals`, `renderPosition`, `renderPhases`, `renderDecisions`, `renderBudgetTracking`, `renderTravelTracker`, `toggleExpPanel` are in today's `exportNames`, so this redesign changes zero existing exported contracts except `renderTrajectory` (target-id change) and `show` (3-tab id domain, new lazy branch). New functions (`renderBudgetTab`, `renderUrgentPeek`, `renderPlanSection`, `buildPhaseCardsHTML`, `renderTargetsSection`, `renderLongTermPlan`, `toggleAccordion`, `jumpToTrajectory`) get added to `exportNames` as they're built.

Key behaviors to verify: zero/one/N-urgent peek wording; Long-Term Plan's 3 accordion bodies stay empty until `show('longterm', ...)`; the fake `Chart` constructor's call count is 0 before the Trajectory accordion's first open, 1 after, and stays 1 across a close/reopen cycle (no duplicate chart re-init); every preserved interactive behavior still fires post-redesign (`onAddEvent`/`onSaveEvent`/`onRemoveEvent`/`onDismissLiveEvent`, `updateP6()`, `toggleExpPanel()` on Phases 2-6, Trajectory sliders/scenario buttons via `refreshChart`).

Because this is fundamentally a visual/IA redesign, headless tests can only prove the right functions ran in the right order with the right call counts — a required manual real-browser pass with Kevin (all 3 tabs, all 3 accordions, specifically confirming the Trajectory chart renders full-size on first expand rather than squished, the 900px breakpoint, every interactive control) is the actual acceptance check, not optional.
