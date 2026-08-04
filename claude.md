# Claude.md — Kevin & Hanna Financial Planning
*Paste this into Project Instructions so it loads in every chat automatically.*

---

## START OF EVERY SESSION
1. Acknowledge you have loaded this context
2. Offer to review latest files or dive into a specific topic
3. Ask: "What would you like to work on — or any updates to the plan?"
4. If Hanna is chatting: welcome her, all context is shared
5. After any session that changes numbers or goals: edit `data/goals.json` (or `data/accounts.json` for a manual-only balance), then regenerate — never hand-edit `dashboard_v5.html`, `kevin_hanna_goal_plan.md`, or `data/data.js` directly

---

## Who we are
- **Kevin Farino** — Director of PM at Hero (AI home health platform), MIT ME, remote from Brentwood LA.
- **Hanna Farino** — Croatian national, launching a healthtech startup (LexiCo).
- **Framework** — "How Will You Measure Your Life?" — Christensen. Deliberate allocation of time, energy, money across career, relationships, integrity.
- Kevin is not naturally finance-focused — use clear visuals, explicit trade-offs, be solution-oriented and contrarian when warranted.

For current bios, income, expenses, assets, and life goals, **read `data/goals.json` and `data/accounts.json`** — this file intentionally carries no financial figures anymore. It used to, and drifted out of sync with the dashboard and the goal-plan doc for over a year (wrong dates, stale income numbers, disagreeing targets) before that was fixed on 2026-07-26. Don't reintroduce that by copying a number here.

---

## Architecture (fixed 2026-07-26 — see `docs/superpowers/plans/` for the prior, abandoned Google Sheet approach if it resurfaces)

```
Longterm/
  data/
    goals.json            — planning assumptions: phases, life goals, a unified
                             timeline (breakpoints/milestones, merged 2026-07-29
                             with the old separate decision-gates list), decisions,
                             travel, career options, family planning, chart
                             assumptions. Hand-maintained. The ONLY place these
                             numbers/facts are typed.
    accounts.json          — net worth actuals: retirement/brokerage/cash/home-equity
                             per owner, each field tagged source: "monarch" (auto-
                             refreshed) or "manual" (hand-entered, not yet linked in
                             Monarch). Composite accounts (e.g. Kevin's retirement,
                             which spans Trinet 401K + Ascensus + a Vanguard Roth IRA +
                             a Royal London UK pension with no Monarch integration) use
                             a `components` array that sums into a top-level `amount`.
                             A `mapping` section ties Monarch account ids to the field
                             they feed.
    budget_tracking.json   — three separate spend trackers, not hand-edited:
                             `joint` (Barclays family budget, currently generated
                             from budget_ledger.csv — see below), `personal.<ownerId>`
                             (each adult's own cards, auto-pulled from Monarch; owner
                             ids come from goals.json owners[]),
                             and `travel` (per planned trip from goals.json's
                             travel array, any card, Monarch's "Travel & Vacation"
                             category — excluded from the other two even when it
                             lands on the same card). Each of joint/personal.*
                             has its own `source` ("monarch" or "manual") and
                             `cycleStart`/`cycleDays` — they're on independent
                             clocks until Barclays is linked and mapped (see below).
    data.js                — generated: `window.DATA = {...}`, bundles the three JSON
                             files above. dashboard_v5.html is opened as a local file
                             (file://), where fetch() of local JSON is blocked by the
                             browser, so data.js is a plain <script> include instead.
    build-data.mjs          — regenerates data.js. Run after editing goals.json or
                             accounts.json.
    build-goal-plan-md.mjs  — regenerates ../kevin_hanna_goal_plan.md. Run after
                             editing goals.json or accounts.json.
  dashboard_v5.html         — pure renderer. Loads data/data.js. No figures live here.
  kevin_hanna_goal_plan.md  — generated narrative view. Never hand-edited.
  budget_ledger.csv         — single source of truth for weekly budget spend (see below).
```

**accounts.json and budget_tracking.json are refreshed automatically**, not by a manual step, via this project's own scheduled task (moved in from Scrooge on 2026-07-26 to keep Longterm self-contained — Scrooge is set aside for now). `Longterm/scripts/` holds everything: `networth-pull.mjs`/`.ps1` (calls `get_accounts`, applies `accounts.json`'s mapping, regenerates `data.js`), `budget-tracking-pull.mjs`/`.ps1` (calls `get_transactions` for the current cycle, splits by account, routes anything in Monarch's "Travel & Vacation" category away from joint/personal into `travel` tracking), `run-daily-pull.ps1` (runs both back-to-back), and `install-scheduled-task.ps1` (registers/removes the Windows Scheduled Task — `LongtermDailyPull`, daily at 03:00; re-run with `-Uninstall` to remove, or after moving the scripts to re-register against a new path). Both pull scripts only ever touch fields with a mapping entry — everything else stays whatever it was. Monarch credentials are shared with Scrooge's existing setup (`C:\Users\Family\.scrooge\monarch.env`) — same account, no reason to duplicate secrets. Only the Monarch pull was moved — Scrooge's Telegram integration (daily detail prompts, weekly planning/closeout messages, policy proposals, reply-reading) is untouched and still lives there. Kevin explicitly scoped bringing Telegram/notifications into Longterm as possible future work, not built yet — if picked up later, it's a new plan, not an extension of this one. `budget-tracking-pull.mjs`'s `TRACKER_REASSIGNMENTS` (2026-08-02) is a small hand-maintained list for one-off charges that should count toward a different tracker than their card would normally route them to (e.g. a family lunch Kevin covered on his own personal card, which should hit the joint budget) — matched by merchant substring + the exact transaction date, not a standing merchant rule, since `budget_tracking.json` is fully regenerated every pull and a direct edit to it would just be overwritten the next morning. **Both pull scripts run monarch-mcp-jamiew from a persistent local venv, not `uvx`** (fixed 2026-08-02, after a one-day outage: Windows Smart App Control silently flipped from Evaluation to Enforce mode and started blocking `uvx.exe`/`uv.exe` outright — both are unsigned, and SAC has no per-file exception, only an all-or-nothing off switch; this is a known unresolved gap, see `astral-sh/uv#10336`). The fix installs a signed, standalone Python (winget `Python.Python.3.12`, distinct from the unusable Microsoft Store stub that was previously the only `python` on this machine) and a dedicated venv at `C:\Users\Family\.longterm\monarch-mcp-venv` (`pip install monarch-mcp-jamiew==0.4.0`, resolving `monarchmoneycommunity` from its normal PyPI release rather than upstream's git-pinned dev commit — no observed behavior difference, but worth knowing if a future upstream bump ever needs re-checking). Both `.mjs` scripts now spawn `%venv%\Scripts\monarch-mcp-jamiew.exe` directly (a signed-interpreter-hosted console script SAC doesn't gate) and load `monarch.env` into the child's environment themselves (a small inline parser) rather than relying on uvx's `--env-file` flag. To recreate the venv on a fresh machine: `python -m venv C:\Users\Family\.longterm\monarch-mcp-venv` then `.\Scripts\pip install monarch-mcp-jamiew==0.4.0` — no uv/uvx involved anywhere in this project anymore.

**Family-trip matching rule (settled 2026-07-26, after two wrong auto-guesses):** a Travel & Vacation-category charge on *either* the joint card or Kevin's personal card gets checked against `goals.json`'s `travel` array — family trips (Boston, Zagreb, Europe, South America) can end up on either card (e.g. Boston was booked on Kevin's personal United card for points). Matching uses each trip's stay dates plus a 300-day lookback before `startDate` (flights get bought months ahead) — **except** a trip with `budgetedAmount: null` (fully settled/already paid, like Boston) gets no lookback, just its bare stay dates, so it can't compete with real upcoming trips for new charges. If a charge matches more than one trip's window, or none, it's held in `budget_tracking.json`'s `travel.unmatched` (with `ambiguousBetween` listing candidates, if any) rather than guessed — ask Kevin which trip it belongs to (or whether it's not a tracked trip at all, e.g. a personal trip like Yellowstone, in which case it's just ordinary spend on whichever card it hit and doesn't need a `travel` array entry).

**Barclays is linked and mapped** (as of 2026-07-26 — `budget_tracking.json`'s `mapping.jointAccountLabels` holds its transaction display-name label, `" More Mastercard (...9054)"`, and `joint.source` is `"monarch"`). `budget_ledger.csv` and the manual CSV-import workflow below are historical record only — do not append to them going forward. Note `accounts.json`'s mapping is a different id scheme: it calls `get_accounts` (which returns a numeric id), while `budget_tracking.json`'s mapping calls `get_transactions` (which only exposes the display-name label like `"CREDIT CARD (...3939)"`) — don't confuse the two when adding new mappings. The same `get_accounts`/`get_transactions` diagnostic pattern extends to Hanna's accounts once those get linked too — add mapping entries to the relevant file, no code changes needed.

**Regeneration rule:** after editing `goals.json` or `accounts.json`, run both `node data/build-data.mjs` and `node data/build-goal-plan-md.mjs` before considering the change done.

---

## Project files
- `data/goals.json` — planning assumptions (owners, phases, life goals, a unified timeline, decisions, travel, career options, family planning, chart assumptions). Edit this for anything that isn't a live account balance. `owners: [{ id, displayName }]` is the source of truth for adult ids used in accounts + personal budget trackers.
- `data/accounts.json` — net worth actuals. Edit only the `manual`-sourced fields by hand; `monarch`-sourced fields get overwritten by the scheduled pull. Balance keys under each bucket must match `goals.owners[].id`.
- `data/budget_tracking.json` — the spend trackers (joint, `personal.<ownerId>`, travel). Don't hand-edit `personal`/`travel` when Monarch-sourced.
- `data/todos.json` — Planner tab **family/household** action items (`items`) and a shared family weekly goal if one exists (`weeklyGoals`, currently empty), each item tagged `owner` with an id from `goals.owners`. Deliberately family-only — each adult tracks their own work to-dos separately, outside this system; a work item belongs in `goals.json`'s `decisions` as narrative, not as a `weeklyGoals` entry here. Written frequently, including by the Telegram bot (`scripts/telegram-bot-poll.mjs`), which reads/writes it directly — `dateAdded` matters more than `deadline` here, since the bot's weekly recap (`scripts/telegram-bot-recap.mjs`) nudges about family items that have sat a while, not deadline enforcement.
- `data/month_plan_events.json` — Month Plan calendar events, moved off browser localStorage (2026-07-31) onto this shared file so both the dashboard (via `scripts/dashboard-server.mjs`'s local API, `npm run dev`) and the Telegram bot's dining tools can read/write the same live plan. Kinds: `dining` (`set_dinner_plan` routine picks), `family` (social/spend — dinners with friends, etc.), `schedule` (appointments/logistics — PT, pediatrician; Google Cal only). The dashboard Month Plan shows and budgets only `dining` + `family` (2026-08-04); `schedule` syncs to Family Planner but is hidden from the spend view. `add_family_event` classifies via `kind` / `classifyEventKind(title)`.
- `scripts/financial-context.mjs` — read-only budget pace / savings goal / decisions math, ported once from `dashboard_v5.html`'s inline script (2026-07-31) so the dashboard, the bot's on-demand Q&A tools (`get_budget_status`/`get_savings_goals`/`get_decisions`), and the recap script below all agree on the same numbers instead of re-deriving them.
- `scripts/telegram-bot-recap.mjs` — sends a dynamically-composed weekly recap (one Anthropic text completion over that week's budget/dining/stale-todo/decision/calendar signal, not a fixed template) into the same Telegram group, Sun+Thu mornings via `install-telegram-recap-scheduled-task.ps1`. Dedup log: `data/telegram-recap-log.jsonl` (one line per date actually sent, so an overlapping/retried run can't double-send). Deliberately scoped to the current week only (2026-08-02) — no long-term savings-goal progress (that's the dashboard's job, a different cadence); budget pace must always cite real dollar figures, never a bare adjective. `diningSummary()` threads an accumulating exclude set across its 3 occasion calls to `get_dining_plan` (its optional `extraExcludeNames` param) so a week's 3 dining suggestions don't all independently converge on the same top-scored favorite — a real bug this fixed (all 3 slots suggested "Terra Eataly" in one live recap). Fetches calendar data once per run and passes it into `diningContext.calendarEvents` — the recap always names any non-recurring event on either calendar itself, but per-occasion calendar coverage is checked inside `get_dining_plan` (see below), not the recap's own prompt.
- `get_dining_plan` (in `scripts/telegram-bot-tools.mjs`) — calendar-aware (2026-08-02): before generating a restaurant suggestion for an unconfirmed occasion, checks `diningContext.calendarEvents` (structured events from `calendar-read.mjs`, fetched once upstream by both `telegram-bot-poll.mjs` and the recap) for anything timed at 4pm or later on that date. If found, the slot is reported as already covered by name and no suggestion is generated at all — checked *before* deciding whether to suggest, not appended as a heads-up afterward. An untimed/all-day event, or one earlier in the day, doesn't count as coverage (a morning appointment shouldn't suppress an evening dining suggestion). `recommendForSlot`'s own scoring/picking logic is unaffected — this only gates whether it gets called.
- `scripts/calendar-auth-setup.mjs` — one-off, interactive: Kevin runs this once after creating a Google Cloud project + OAuth client (Desktop app type, Calendar API enabled) to exchange consent for a refresh token, create the dedicated "Family Planner" calendar, and save both plus the calendar id to `C:\Users\Family\.longterm\google-calendar.env` (outside the repo, same convention as `telegram.env`).
- `scripts/calendar-sync.mjs` — reconciles `data/month_plan_events.json` ↔ the Family Planner Google Calendar with **Google as source of truth** (2026-08-04): remote deletes/edits/new events pull into the Month Plan; bot-originated local writes still push. State is keyed by `googleEventId` in `data/calendar-sync-state.json`; dining `kind`/`tier`/`cost` ride in Google `extendedProperties.private`. Runs as the last step of `telegram-bot-poll.mjs`'s 2-minute scheduled task — skips quietly until `google-calendar.env` exists, and a Calendar API failure never fails the poll itself.
- `scripts/calendar-read.mjs` — the read-side counterpart (2026-08-01): reports upcoming events across whichever *existing* Google Calendars are configured in `google-calendar.env`'s `GOOGLE_READ_CALENDAR_IDS` (Kevin's personal + Hanna's, deliberately never Kevin's work calendar) — distinct from `calendar-sync.mjs`'s single write-target "Family Planner" calendar. Powers the bot's `get_calendar_events` tool and the recap's `calendarSummary` field; reuses `calendar-sync.mjs`'s OAuth token refresh rather than duplicating it. `getUpcomingEvents()` returns both a text `summary` and a structured `items` array (`{ label, title, date, time, isRecurring }` per event, 2026-08-02) — the text still tags each line "(recurring)" via Google's own `recurringEventId` field; the structured form is what `get_dining_plan`'s calendar-coverage check uses to compare dates/times programmatically. Set up via the already-installed `gws` Workspace CLI (project `family-desktop-cli`, Calendar API already enabled there) rather than a separate OAuth client — see `calendar-auth-setup.mjs`'s own comment for the manual fallback if `gws` isn't available.
- `data/dining-routine-overrides.json` — bot-owned (via `set_routine_day`), never `goals.json` — which weekday each of the 3 routine dining occasions currently falls on, if rescheduled from `goals.json`'s hand-maintained default. Read live by both the bot (`dining-recommendation.mjs`'s `slotForOccasion`) and the dashboard (`dashboard-server.mjs`'s `/api/dining-routine-overrides` route) so a reschedule is never disagreed on.
- `update_phase_expense`/`log_decision` (in `scripts/telegram-bot-tools.mjs`) — direct-write bot tools (2026-08-02, superseding the earlier capture-only `log_planning_note` design): the bot edits `goals.json` itself when a message describes a phase expense change or a new open decision — a cost that changes on a date is stored as today's real current rate (not a future-scheduled figure; the convention is "tell the bot again when it changes," matching e.g. "Au pair (starts Aug 2026)"), and `renameFrom` lets a relabel (e.g. "Nanny" → "Au pair") delete the old key in the same call. No human-review gate — Kevin was explicit that the bot should change files directly, not require a Claude session to fold anything in. Every such edit is appended to `data/goals-changelog.jsonl` (`{at, sender, tool, input, reply}`) as an audit trail, not an approval mechanism, and the weekly recap surfaces a count + the 2 most recent as `recentPlanChanges` so a direct edit doesn't happen invisibly. After any bot-made `goals.json` edit, `regenerateFromGoals()` runs the same `build-data.mjs`/`build-goal-plan-md.mjs` regeneration this file's own rule requires for a hand-made edit.
- `data/telegram-pending-clarifications.json` — bot-owned (2026-08-02, multi-turn clarification): at most one open question per sender. Registered when the LLM fallback replies with no tool call (asking instead of guessing) or when a tool itself hits an unresolvable ambiguity (`remove_event`'s `needsClarification: true` flag). The sender's next message, if within 3 hours, skips deterministic parsing and resumes with the original ask + question + reply bundled into one more Claude call — resolving it, asking again, or dropping the question if the reply is unrelated, entirely by Claude's judgment (no rigid answer-matching). Never surfaced to the dashboard or recap; purely the bot's own short-term memory of what it's waiting to hear back on.
- `dashboard_v5.html` — visual 5-tab dashboard, pure renderer.
- `kevin_hanna_goal_plan.md` — generated narrative view, all scenarios/reasoning.
- `tasks.md` — action list with decision gates.
- `budget_ledger.csv` — single source of truth for weekly budget spend (see below).

## Dining recommendations (Month Plan tab)

- `data/favorite_places_raw.json` — snapshot of the dining Google Sheet (`https://docs.google.com/spreadsheets/d/1-5KiintV2071nkjkF5zb_P-erWYOknn8hWtMLBBlyDM`). On-demand only — ask Claude to resync when the sheet changes; this needs live Drive access that only a live Claude Code session has, not the unattended scheduled pull. Entries carry `familyFriendly`/`dinnerSpot`/`socialSpot` boolean tags (independent of each other) used to filter which favorites are eligible for which routine day.
- `data/favorite_places.json` — auto-refreshed daily by `Longterm/scripts/budget-tracking-pull.mjs`. Holds each favorite's observed spend tier plus a 90-day rolling `recentDiningActivity` log. Never hand-edit.
- `goals.json`'s `diningRoutine` (Wed/Fri/Sat routine days — family dinner, date night, weekend social respectively, matched by `dayOfWeek` only, no displayed label) and `lowKeyHangIdeas` (free-hang fallbacks) — hand-maintained.
- The Month Plan tab is a pure, read-only display (changed 2026-08-03 — previously had its own add/edit/remove UI backed by a PUT route on `dashboard-server.mjs`; removed since planning happens through the Telegram bot instead, which reads/writes `data/month_plan_events.json` directly). Every future day — routine or not — shows plain, non-interactive "event" chips: a stored event's real name/tier, or, for a routine day with nothing yet decided, a live, budget-reactive AI suggestion (blue-accented, recomputed every render via `recommendForSlot()`) rather than a fixed label. `recommendForSlot()` excludes anything already suggested/used elsewhere on the same calendar render, so the month doesn't show one restaurant repeated for every eligible day (a plain exclusion filter, not a ranking change). Past days always show Monarch-verified actual spend, never the plan. `dashboard-server.mjs`'s `/api/month-plan-events` route is GET-only now; the bot's own direct file writes are what `planRemainingMonth()`'s budget math reacts to on the next render. See `docs/superpowers/specs/2026-07-27-unified-month-plan-events-design.md` for the interactive design this superseded (itself superseding the even-older override/slot model in `2026-07-27-month-plan-interactivity-design.md`).

---

## Weekly Budget Ledger Update — Joint (Barclays) tracker only (repeat every time a new CC export lands)

This section is temporary: it only applies to `budget_tracking.json`'s `joint` tracker, and only
until Barclays links in Monarch (see the follow-up note above), at which point
`budget-tracking-pull.mjs` takes over the joint tracker the same way it already handles
`personal` and `travel`.

`budget_ledger.csv` is the **only** place raw transaction data lives for the joint tracker.
`data/budget_tracking.json`'s `joint` field (which feeds both `dashboard_v5.html`'s Joint panel and
`kevin_hanna_goal_plan.md`'s Spend Tracking section) is just a *view* generated from it — never
hand-edit it directly, regenerate it.

1. Load `budget_ledger.csv`, build the dedup key set: `Date + Description + Amount + Card`.
2. Find the newest `CreditCard_*.csv` in Downloads. Parse it, skip `Payment Received`/CREDIT rows
   (not spend) and any row whose dedup key is already in the ledger — this makes overlapping
   export windows safe automatically, no manual date-range reasoning needed.
3. Categorize new rows only (Groceries, Dining, Amazon, Subscriptions, Transportation,
   Entertainment, Retail, Miscellaneous — reuse the merchant patterns in the top-level
   `Finances/CLAUDE.md`; e.g. `SQ *` → Groceries unless clearly a restaurant name, `TST*`/`PX*`/`OLO*`
   → Dining, `CONSERV` → Transportation/gas). Flag anything genuinely ambiguous as "⚠️ Review"
   rather than guessing silently.
4. Append the new rows to `budget_ledger.csv`, tagging each with its `Cycle` (25th→24th, for the
   dashboard) and `CalendarWeek` (for the goal-plan table).
5. Regenerate `data/budget_tracking.json` wholesale from the full ledger (don't patch old entries)
   — 7-day buckets from the cycle start (25th), each with a `days` field so the render function's
   day-weighted average isn't skewed by a trailing partial week — then run
   `node data/build-data.mjs` and `node data/build-goal-plan-md.mjs` so both views pick it up.
6. Report pace vs. `data/goals.json`'s family budget target, days elapsed vs. remaining in the
   cycle, projected cycle total, category breakdown, and any new outliers (>$150) or
   ⚠️-flagged merchants.
