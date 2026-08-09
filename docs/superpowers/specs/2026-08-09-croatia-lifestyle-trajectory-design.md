# Croatia lifestyle scenario (Trajectory)

*Approved in conversation 2026-08-09 (Hanna + Kevin). Design only — implementation follows a separate plan after spec review.*

## Goal

Add a fourth **Hanna scenario** on the Trajectory tab — **Croatia** — that models moving to Croatia as an alternate lifestyle path. When selected, it **overwrites normal phase routing** from **2027 onward** and uses Croatia living costs and savings rules. The **sabbatical slider stays** (same control as base path); in the Croatia lifestyle the sabbatical is framed as a different trip (e.g. South America or Asia rather than Europe) — cost/timing still via the existing sabbatical sliders. The existing Croatia **home-purchase slider** also remains so the household can test what they can afford and when (possibly later, e.g. when inheritance is accessible).

## Non-goals (v1)

- Mid-year 2027 split (full years from 2027; no July partial-year math)
- Combining Croatia lifestyle with LexiCo Fail/Neutral/Success in one run (Croatia replaces that axis while active)
- Separate sabbatical UI for Croatia (reuse existing sabbatical cost/year sliders; only copy/framing differs)
- Modeling LA property value / home-equity growth on the chart
- Vacancy, property-management fees, or tax detail on the LA rental beyond a flat net surplus
- Changing Planner spend trackers or live Monarch pulls
- Building until this spec is reviewed and an implementation plan exists

## How Trajectory works today (context)

`computeProjection` does **not** simulate full income→expense ledgers year by year. It:

1. Grows retirement / brokerage / liquid at slider rates  
2. Adds contributions from the active phase’s `allocation` buckets + `chart.annualRetirementContribution`  
3. Applies one-offs: sabbatical liquid draw, Croatia home brokerage draw (`croatiaYear` / `croatiaK`), optional Hanna Success payout  

So lifestyle cash-flow must be expressed as a **planning phase** (income/expenses/allocations) whose allocations feed the chart — with an explicit rule that **Kevin cannot be allocated more than monthly surplus**.

## UX

On Trajectory → **Hanna scenario** button row:

| Button | Behavior |
|--------|----------|
| Fail / Neutral / Success | Unchanged LexiCo paths (Success still injects go payout) |
| **Croatia** | Lifestyle path below; Fail/Neutral/Success inactive while this is selected |

When Croatia is selected, chart foot / note should state: lifestyle from 2027 · sabbatical still applies (different destination framing, e.g. SA/Asia) · home purchase still via Croatia budget slider.

## Croatia lifestyle economics (from 2027, full years)

### Inflows (monthly)

| Line | Amount | Notes |
|------|--------|--------|
| Kevin income | Same as current dual-income phase Kevin line | Not reduced for the move |
| LA rental surplus | **+$1,500** | Net after mortgage; replaces earlier “Hanna $2k income” idea — **not** stacked with a separate Hanna $2k salary |

### Outflows (monthly)

| Line | Amount | Notes |
|------|--------|--------|
| Croatia rent | **$3,000** | On top of budget |
| All-in living budget | **$6,000** | Household + Kevin personal + Hanna personal |
| **Total living burn** | **$9,000** | Rent + budget |

LA mortgage is assumed covered such that the household sees **+$1,500** net from the property, not a mortgage expense line.

### Surplus → savings (hard rule)

```
monthlySurplus = KevinIncome + 1500 - 9000
```

**Kevin’s investment contributions (brokerage and any scenario-specific savings allocations) must not exceed `monthlySurplus`.** Cap allocations at surplus; do not invent a silent deficit. If base-path “Kevin savings stays the same” would exceed surplus, **reduce Kevin’s Croatia-scenario allocation to fit surplus** (surplus is the ceiling).

**Hanna investment contributions = $0** in this scenario.

**Retirement maxing:** keep `chart.annualRetirementContribution` on the base path as today unless it would violate the surplus ceiling when combined with Kevin’s brokerage allocation — in that case, document the split in implementation (prefer: brokerage allocation absorbs the cap first, or pro-rate; call out in plan). Default intent: “Kevin savings” means his **discretionary brokerage/liquid allocations**; 401k maxing policy should be stated explicitly in the implementation plan once Phase 1 Kevin income is read from `goals.json` and surplus is computed.

### One-offs

| Event | Croatia scenario |
|-------|------------------|
| Sabbatical (`sabbaticalK` / `sabbaticalYear`) | **Keep the sliders** — same mechanics as base path (liquid draw in that year). Framing/copy when Croatia is selected: sabbatical is a different kind of year away (e.g. South America or Asia), not a European add-on to Croatia living. Defaults may stay as today; user adjusts cost/year to taste. |
| Croatia home purchase (`croatiaK` / `croatiaYear`) | **Slider remains**; use to explore affordability / timing (may move later toward inheritance access) |
| Hanna Success / go payout | **N/A** while Croatia scenario is selected |

## Data model (proposed)

Hand-maintained in `goals.json` (only place these numbers are typed), e.g.:

```json
"lifestyleScenarios": {
  "croatia": {
    "label": "Croatia",
    "startYear": 2027,
    "skipSabbatical": false,
    "sabbaticalFraming": "Alternate sabbatical (e.g. South America or Asia) — same sliders as base path",
    "income": {
      "Kevin": null,
      "LA rental surplus": 1500
    },
    "expenses": {
      "Croatia rent": 3000,
      "Living budget (incl. personals)": 6000
    },
    "allocation": [
      { "label": "Kevin brokerage", "amount": null, "bucket": "brokerage", "note": "min(base Kevin brokerage, monthlySurplus); Hanna 0" }
    ],
    "notes": "..."
  }
}
```

- `income.Kevin: null` means “copy from phases[0] (or current dual-income phase) Kevin income at build/render time.”  
- Allocation amounts may be derived at projection time from surplus rather than hard-coded, as long as the surplus ceiling is enforced.  
- `chart.hannaScenario` gains value `"croatia"` alongside `"fail"` | `"neutral"` | `"go"`.

Exact JSON shape can be adjusted in the implementation plan; the economics and rules above are load-bearing.

## Projection behavior

In `computeProjection` (and any mirrored note/copy):

1. If `hannaScenario !== 'croatia'` → existing behavior.  
2. If `hannaScenario === 'croatia'`:  
   - For `yr < 2027`: same as Neutral base (phase routing + contributions).  
   - For `yr >= 2027`: use Croatia lifestyle allocations (Kevin capped by surplus; Hanna 0); **still apply** sabbatical year draw when that year hits (same slider values); **do** apply Croatia home draw if that year/amount is set on the sliders.  
3. Growth rates unchanged (same sliders).

## Phases tab / goal-plan narrative

- Prefer a visible Croatia lifestyle block (or generated note) so surplus math is auditable — not chart-only magic.  
- `build-goal-plan-md.mjs` should mention the scenario when regenerating, once data exists.  
- Do not replace the existing multi-phase timeline for the base path; Croatia is an **alternate** path selected on Trajectory.

## Success criteria

- [ ] Fourth Hanna scenario button **Croatia** on Trajectory  
- [ ] Selecting it changes the chart from 2027 (full years)  
- [ ] Sabbatical slider still applies under Croatia (copy/framing notes alternate destination; same draw mechanics)  
- [ ] Croatia home slider still works  
- [ ] Kevin contributions ≤ monthly surplus; Hanna contributions 0  
- [ ] Economics (1.5k LA surplus, 3k rent, 6k budget) live in `goals.json`, not hardcoded only in HTML  
- [ ] Short note on chart explains the lifestyle assumptions  

## Open items for implementation plan (not blockers for this spec)

- Exact Kevin income source phase when copying `null` (Phase 1 vs Phase 2 chart convention)  
- Whether `annualRetirementContribution` is inside or outside the surplus cap  
- Default `croatiaYear` / `croatiaK` when switching to Croatia (keep user slider values vs suggest later year)  
