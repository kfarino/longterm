# Longterm Telegram bot (to-do + dining planning) + Month Plan storage migration

*2026-07-31*

## Context

The Planner tab's `todos.json` (items + weekly goals) was built specifically so a Telegram bot could read/write it later — the concrete trigger was Hanna wanting to add "buy Nikolas a car seat carrier" to the list with no way to do that except asking Kevin to ask Claude. A cloud Routine (scheduled push-only recap) was tried first but felt clunky — one-way, no way to take an ad-hoc "add this" the moment someone thinks of it.

The scope grew to include dining planning (family dinner Wed / date night / weekend social) once Kevin asked for it — the same job the dashboard's Month Plan calendar already partly does. That calendar's events lived only in browser `localStorage`, unreachable by anything outside that one browser. Making the bot useful for dining planning meant migrating that storage to a real shared file, which meant the dashboard needed a small local server instead of a static `file://` page (browser JS can't write to disk; that's *why* localStorage was used originally). Kevin accepted this trade-off explicitly ("willing to sacrifice browser app functionality for now") and confirmed it should stay local rather than remotely hosted, given the dashboard holds real financial data.

This is a **new, separate bot from Scrooge** (its own BotFather registration, token, and Telegram group) — Scrooge's existing `read-telegram-replies.ps1`/`send-telegram-*.ps1` scripts are untouched; this is fresh code borrowing only the *pattern* (poll `getUpdates` with an offset cursor) that already works there. A brand-new bot also sidesteps a real constraint: Telegram's `getUpdates` has single-consumer semantics per bot token, so a second independent poller against Scrooge's existing token could cause either poller to miss messages.

## Part 1 — To-do bot

Runs in **one shared Telegram group** (Kevin + Hanna + the bot), not separate private chats:

- **Bot Privacy Mode disabled** (`/setprivacy` in BotFather) so the poller can see every group message — otherwise Telegram only forwards messages explicitly addressed to the bot.
- **Only acts when directly addressed**: `@mention` or a reply to one of the bot's own messages. Everything else is read but silently ignored — no reply, no LLM call, no cost. This is the gate that keeps it quiet during normal conversation.
- **Owner resolved from the sender** (`message.from.id`), not the shared group `chat.id` — `telegram-owners.json` maps each person's Telegram user id to `"kevin"`/`"hanna"`.
- **Windows Scheduled Task**, every 2 minutes (`LongtermTelegramPoll`) — same mechanism as the existing Monarch pulls, no new infrastructure class.
- **Deterministic parsing first** (fast, free, no API call): `new:`/`add:`, `<n> done`, `<n> +<count>`, `list`.
- **Anthropic Messages API fallback** for anything else, including real questions — a small tool set (`add_todo`, `mark_done`, `log_weekly_goal_count`, `list_todos`, plus Part 3's dining tools) lets Claude decide what was meant and call the right tool(s).
- Writes directly to `data/todos.json`, then runs `build-data.mjs` so the dashboard picks up the change immediately.

**Files**: `scripts/telegram-bot-tools.mjs` (pure tool implementations), `scripts/telegram-bot-poll.mjs` (poller/dispatcher), `scripts/telegram-bot-whoami.mjs` (one-off setup helper), `scripts/install-telegram-scheduled-task.ps1`.

## Part 2 — Month Plan storage migration + local server

Browser JS loaded via `file://` cannot write to disk — a real browser security restriction, not an oversight, and exactly why Month Plan used `localStorage` before. For the bot and dashboard to share live dining-plan data, both need to read/write one real file; the dashboard can only do that through a small local HTTP server instead of touching the file itself.

- **`scripts/dashboard-server.mjs`** — minimal Node server: serves `dashboard_v5.html` + `data/*` statically, plus `GET`/`PUT /api/month-plan-events` backed by atomic (temp-file-then-rename) writes to `data/month_plan_events.json`. Binds `127.0.0.1` only — no authentication, not meant to be reachable from the network.
- **`data/month_plan_events.json`** — the persistent store, same `{events: {date: [...]}}` shape localStorage held. Starts empty; whatever was in a browser's localStorage before this migration could not be automatically carried over (no script can read another program's browser storage) — a known, accepted loss.
- **`dashboard_v5.html`**: `loadMonthPlanState()`/`saveMonthPlanState()` became `async`, calling `fetch()` instead of `localStorage`. Every call site — `addEvent`, `removeEvent`, `onAddEvent`, `onRemoveEvent`, `onSaveEvent`, `onDismissLiveEvent`, `computeMonthPlanProjectedSpend`, `renderMonthPlan`, `renderJointKevinTrackers`, `renderBudgetTab` — became `async`/awaited accordingly. The init block stores `renderBudgetTab()`'s promise as `const initReady` so the test harness can await initial-render completion.
- **Launch**: `npm run dev` (via a new `package.json`) starts the server; open `http://localhost:4200/dashboard_v5.html` instead of double-clicking the file.
- **Concurrency**: the bot's dining tools and the dashboard server both write `month_plan_events.json` directly (same atomic pattern), rather than the bot depending on the server's HTTP API — Hanna should be able to text a plan without Kevin having `npm run dev` running. A very small, practically negligible race window is accepted in exchange for that independence.
- No change to `build-data.mjs`'s existing bundling — only Month Plan's live event storage moved off localStorage.

**Testing**: `dashboard-test-harness.mjs`'s `FakeLocalStorage` was replaced with a `FakeMonthPlanApi` (an in-memory `{events}` double for `fetch()`), which also records every `PUT` for assertions. A separate `test-dashboard-server.mjs` exercises the *real* server code (real HTTP, real temp file) — the fake double never touches `dashboard-server.mjs` itself.

## Part 3 — Dining-planning bot tools

Builds on Parts 1 and 2:

- **`scripts/dining-recommendation.mjs`** — `recommendForSlot()` and its tier/recent-visit-exclusion heuristic, ported from `dashboard_v5.html`'s inline copy into a standalone Node module. **Deliberate duplication, not a shared import** — the dashboard's script is loaded as a plain inline `<script>`, not a real ES module, so it can't import this file (and vice versa). Real deduplication would mean switching the dashboard to `<script type="module">` — newly possible now that it's served over `http://` instead of `file://` (which blocks module scripts) — but that's a follow-on cleanup, not required here.
- **`get_dining_plan(occasion)`** — read-only. Maps `occasion` (`family_dinner`/`date_night`/`weekend_social`) to `goals.json`'s `diningRoutine` dayOfWeek convention (Wed/Fri/Sat), finds the next upcoming date for that weekday, and reports either the already-decided event or a fresh suggestion via the ported recommendation logic.
- **`set_dinner_plan(occasion, pick)`** — resolves `pick` against known favorites (auto-filling cost/tier from observed spend, matching `dashboard_v5.html`'s own `resolveEventFields()`) or low-key ideas, and writes it into `month_plan_events.json`.
- Both route through the same @mention/reply-gated LLM fallback Part 1 already built — no new deterministic patterns were added (the plan explicitly allowed skipping this; free-form dining questions are common enough that hardcoded patterns would add little).

## Setup (manual, not automatable — outstanding as of 2026-07-31)

1. Message @BotFather, create the bot, get the token → `C:\Users\Family\.longterm\telegram.env` (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`).
2. `/setprivacy` → select the bot → **Disable**.
3. Create a Telegram group with Kevin, Hanna, and the bot → `TELEGRAM_GROUP_CHAT_ID`.
4. Create an Anthropic Console API key (console.anthropic.com — separate billing from the Claude subscription) → `ANTHROPIC_API_KEY`.
5. Kevin and Hanna each send one message in the group; run `telegram-bot-whoami.mjs` to see both `from.id`s → hand-write `data/telegram-owners.json`.
6. Run `install-telegram-scheduled-task.ps1` to register the 2-minute poll.
7. If real events exist only in a browser's localStorage from before this migration, manually copy them out via devtools first.
8. `npm run dev` from `Finances/Longterm/`, confirm `http://localhost:4200/dashboard_v5.html` loads and Month Plan reads/writes correctly.
9. Send a real test message addressed to the bot and confirm it lands in `todos.json`/the dashboard, replies in the group, and that an unaddressed message produces no reply.
10. Ask the bot for a dining suggestion and confirm it's consistent with what the dashboard would suggest for the same slot; ask it to set a pick and confirm the dashboard shows it after a refresh.

## Verification (Parts 1-3, completed 2026-07-31)

- `node data/test-telegram-bot.mjs` — 18 cases: group gating, owner resolution, deterministic parsing, LLM fallback (mocked, no real API calls), offset-advance safety, and the 5 new dining-tool cases.
- `node data/test-dashboard-contract.mjs` — 20 cases, including Month Plan's async/fetch-based round-trip tests.
- `node data/test-dashboard-server.mjs` — 5 cases against the real server: GET/PUT round-trip, atomic-write safety, malformed-body handling, path-traversal blocking.
- Manual: verified live in Chrome against the running `dashboard-server.mjs` — page loads over `http://localhost:4200`, no console errors, and a real add/remove calendar event round-trips through the new async API correctly.
- Outstanding: the manual setup steps above require real Telegram/Anthropic credentials Kevin needs to create himself — the code is complete and tested, but the live end-to-end bot conversation hasn't been exercised against real Telegram/Anthropic APIs yet.

---

# Extension: family-only scope, dynamic recap, financial Q&A, Calendar sync

*Added 2026-07-31, after asking what would unlock more value from the bot built above.*

Four follow-on pieces, sequenced A → C → B, with D independent:

## Part A — `todos.json` corrected to family-only scope

Kevin corrected the framing mid-review: the to-do list is **family-only**. The existing "Consulting outreach" weekly goal was a work item and didn't belong — Kevin and Hanna each track their own work to-dos separately, outside this system. Fix: removed that entry, set `weeklyGoals: []`, and rewrote `todos.json`'s `meta.description` (and `claude.md`'s matching bullet) to state the scope explicitly, so it isn't silently reintroduced later.

## Part C — Financial Q&A bot tools (built before Part B, since B reuses it)

Three new read-only tools, same `TOOL_DEFS`/`TOOL_IMPL`/LLM-fallback wiring as `get_dining_plan` — a message like "how's our budget pacing?" or "any open decisions?" now routes through the Anthropic tool-calling fallback to:

- **`get_budget_status`** — joint/Kevin-personal pace (logged/projected vs. target, on- or over-pace) plus travel trip actuals vs. budgeted.
- **`get_savings_goals`** — every life goal's current/target/percentage, including the Croatia goal's live-brokerage special case.
- **`get_decisions`** — open decisions, urgent ones surfaced first.

**`scripts/financial-context.mjs`** is the new shared module underneath all three: `computeTrackerPacing()` and the goal-progress math were ported once from `dashboard_v5.html`'s inline script (same deliberate-duplication trade-off as `dining-recommendation.mjs` — the dashboard isn't a real ES module yet) so the dashboard, these bot tools, and Part B's recap all agree on identical numbers rather than re-deriving the math a third time. `loadFinancialContext()` bundles all three, degrading quietly to empty on missing/unparseable files, matching this project's existing "don't crash on a fresh checkout" convention.

**Testing**: `node data/test-telegram-bot.mjs` — 3 new cases (now 21 total) verifying each tool's reply text against fixture data and confirming none of them write anything (`todosChanged`/`monthPlanEventsChanged` stay `false`).

## Part B — Dynamic weekly recap

The earlier cloud-Routine recap attempt died on two problems: push-only (no way to ask a follow-up), and no access to live local files (a Routine only sees git-committed state). Building it into the *existing local bot* instead solves both — same bot, same group, direct filesystem access.

**"Dynamic" means composed, not templated**: `scripts/telegram-bot-recap.mjs` gathers one bundle — budget pace, savings goals, this week's 3 dining slots (via `get_dining_plan`, reused as-is), any open decisions, and the single oldest open family to-do (not a full list — just the one cue worth nudging about) — and hands it to a single Anthropic text completion instructed to compose one natural message, weighting attention toward whatever's actually notable that week rather than mechanically covering every category. No tool-calling needed here, just one text completion.

- **Cadence**: Sunday + Thursday mornings (9am local), via `scripts/install-telegram-recap-scheduled-task.ps1` — a separate scheduled task (`LongtermTelegramRecap`) from the 2-minute interactive poller, since it's a different schedule entirely.
- **Dedup**: `data/telegram-recap-log.jsonl`, one line per date actually sent (`{date, slot, sentAt}`). Checked *before* calling the LLM, so a retried/overlapping run costs nothing — no API calls at all, not just no double-send.
- **Slot labels** (`sunday-morning`/`thursday-morning`/`ad-hoc`) come from the day-of-week at run time — real cadence runs always land on Sun/Thu; anything else (manual/test runs) is labeled `ad-hoc` and still gets its own dedup entry.

**Testing**: `node data/test-telegram-recap.mjs` — 6 cases: the bundle handed to the (mocked) LLM contains all 4 signal categories; the composed text is sent with no `reply_to_message_id` (it isn't a reply to anything); a dedup log entry is recorded after sending; a same-day rerun skips both the LLM call and the send; a different cadence day isn't deduped against a prior day's send; an empty to-do list yields `staleTodo: null` rather than throwing.

## Part D — Google Calendar sync (one-way push, new dedicated calendar)

**Scope, stated explicitly**: one-way only. Confirmed Month Plan events push to Google Calendar; nothing syncs back. Two-way sync is a materially bigger conflict-resolution problem that wasn't asked for.

**Why a local script with its own OAuth, not the account's existing MCP Calendar connector**: that connector could skip new OAuth setup, but a cloud Routine using it only ever sees whatever's last committed to git — not the live `month_plan_events.json` the bot and dashboard write to directly. A local script reads that live file the moment it changes, consistent with how Monarch and Telegram already work in this project.

- **`scripts/calendar-auth-setup.mjs`** — one-off, interactive (Kevin runs this once, after manually creating a Google Cloud project + OAuth client of type Desktop app, and enabling the Calendar API). Opens the consent URL, catches the loopback redirect with a tiny one-shot local HTTP server, exchanges the code for a refresh token, creates the dedicated "Family Planner" calendar, and saves client id/secret/refresh token/calendar id to `C:\Users\Family\.longterm\google-calendar.env` — outside the repo, same convention as `telegram.env`. No npm dependency: raw OAuth2/REST calls via `fetch`, matching how the Telegram and Anthropic integrations already avoid an SDK.
- **`scripts/calendar-sync.mjs`** — reads `data/month_plan_events.json`, diffs it against **`data/calendar-sync-state.json`** (keyed `${date}|${indexInThatDaysEventArray}` → `{googleEventId, signature}`, where `signature` is a plain serialized snapshot of the fields that matter), and creates/updates/deletes Calendar events to match. An unchanged event costs zero API calls (compared via `signature`, not a live fetch of the remote event); an edited event updates the same `googleEventId` rather than duplicating; a removed event (a day tombstoned to `[]`, matching Month Plan's existing convention) deletes its Calendar event and clears its state entry.
- **Folded into the existing 2-minute `LongtermTelegramPoll` task, not a new one**: `telegram-bot-poll.mjs`'s `main()` runs the sync as its last step after the poll itself. Skips quietly if `google-calendar.env` doesn't exist yet (auth setup not yet run), and a Calendar API failure is caught and logged without failing the poll — to-dos/dining are the poll's job and must keep working regardless of Calendar's state.
- The diffing logic (`diffPlanAgainstState()`) is exported as a pure function with no I/O, so the create/update/delete decision is tested independently of any Calendar API client.

**Testing**: `node data/test-calendar-sync.mjs` — 5 cases against a mocked Calendar API client (`createEvent`/`updateEvent`/`deleteEvent` — no real Google network calls, no OAuth token refresh needed for any of these): a new event creates and records `googleEventId`+`signature`; an edited event updates the same id rather than duplicating; a removed event deletes and clears its state entry; a no-change run makes zero API calls *and* never even attempts to resolve a calendar client (so it can't accidentally trigger a token refresh); multiple same-day events are diffed independently by index.

## Setup (manual, outstanding as of 2026-07-31)

In addition to the Part 1-3 setup steps above:

11. Create a Google Cloud project, enable the Calendar API, create an OAuth client (type: Desktop app).
12. Run `node scripts/calendar-auth-setup.mjs`, paste in the client id/secret, approve the consent screen — confirms `google-calendar.env` was written and the "Family Planner" calendar was created.
13. Wait one poll cycle (or run `node scripts/telegram-bot-poll.mjs` manually) and confirm a Month Plan event appears in the new Google Calendar.
14. Run `scripts/install-telegram-recap-scheduled-task.ps1` to register the Sun+Thu recap task; confirm a real recap lands in the group on the next occurrence (or trigger the task manually to check sooner).
15. Ask the bot a real budget/savings/decisions question in the group and cross-check the reply against the dashboard.

## Verification (Parts A/B/C/D, completed 2026-07-31)

- `node data/test-telegram-bot.mjs` — 21 cases (18 from Parts 1-3 plus 3 new financial-tool cases for Part C).
- `node data/test-telegram-recap.mjs` — 6 cases (new, Part B).
- `node data/test-calendar-sync.mjs` — 5 cases (new, Part D).
- `node data/test-dashboard-contract.mjs` / `node data/test-dashboard-server.mjs` — unchanged, still passing (20 + 5 cases).
- Confirmed via `git status` after each part that no unrelated files were touched by test runs.
- Outstanding: Part D's manual setup steps (11-13 above) require Kevin to create a Google Cloud project and OAuth client himself — the sync logic is complete and tested against a mocked Calendar client, but hasn't been exercised against the real Calendar API yet. Same caveat as before for a real recap landing in the group and a real financial question being asked live.

---

# Follow-up: reservation times, confirm-vs-suggest hardening, recap's stated goal

*Added 2026-07-31, after asking whether "confirm dinner at Sugarfish Wed at 5" would reach the calendar and finding two real gaps: the time was silently dropped, and Calendar events were always all-day.*

## Time flows through the whole chain

`set_dinner_plan` gained an optional `time` argument (any loose format — "5pm", "5:30", "17:00"). `parseTimeToHHMM()` in `telegram-bot-tools.mjs` normalizes it to 24-hour `HH:MM`, defaulting a bare hour with no am/pm to evening ("5" → 17:00) since every occasion this tool handles (family dinner/date night/weekend social) is an evening one — an unparseable input is simply dropped (event stays untimed) rather than guessed. The stored event carries `time: "HH:MM" | null`; `get_dining_plan` reports it back in 12-hour form on both the confirmation reply and any later lookup.

`calendar-sync.mjs`'s `buildEventBody()` branches on `event.time`: present, it builds a real `start.dateTime`/`end.dateTime` (fixed 2-hour default block, `America/Los_Angeles` — this only ever runs from the one known household location, same assumption the rest of this project's scheduled scripts make); absent, it falls back to the original all-day `start.date`/`end.date`. `signature()` now includes `time`, so adding/changing just the time on an already-synced event is correctly detected as an update, not skipped as unchanged.

## Confirmed vs. suggested was already structurally true — tightened at the LLM layer

`get_dining_plan` never writes to `monthPlanEvents`; only `set_dinner_plan` does. That means a live suggestion could never reach `calendar-sync.mjs` (which only reads confirmed, stored events) even before this round — the risk was purely at tool-selection time, i.e. the LLM calling `set_dinner_plan` when the user was only asking what the plan/suggestion was. Both `set_dinner_plan`'s tool description and the poller's system prompt (`callAnthropicFallback` in `telegram-bot-poll.mjs`) now state this distinction explicitly: only call `set_dinner_plan` on an explicit confirmation/booking, never on a question.

## The weekly recap's stated goal: get dining plans confirmed

`RECAP_SYSTEM_PROMPT` in `telegram-bot-recap.mjs` now states explicitly that the recap's main practical purpose is driving dining-plan confirmations — for any of the three occasions still showing a live suggestion rather than a confirmed pick, the composed message should call it out and prompt for a reply, since only a confirmed pick reaches the shared Calendar. Budget pace, savings goals, and decisions remain supporting context, not equal-weight categories.

## Scope check: Calendar stays future/confirmed-only

Asked whether Calendar sync should also push past actual (Monarch-verified) dining spend, so the calendar doubles as a spend log rather than just a planner — Kevin confirmed **no**: Calendar stays scoped to future confirmed plans only, as originally built. No change made. (Separately clarified: an earlier comment about "the calendar view" being more useful for seeing past spend than planning referred to the *dashboard's own* Month Plan tab, not Google Calendar — Kevin confirmed that tab is fine as-is, no change needed there either.)

## New tool: `add_family_event` (general, one-off events beyond the 3 dining occasions)

Prompted by the realization that adding a `time` unlocks the bot adding *any* family event, not just dining — "confirm dinner at Sugarfish Wed at 5" only ever covered the 3 fixed routine occasions; there was no way to add an appointment, school event, or trip note.

- **`add_family_event(date, title, time?)`** in `telegram-bot-tools.mjs` — requires an explicit `date` (the LLM resolves any relative day the user gave — "tomorrow," "Thursday," "next Friday" — into `YYYY-MM-DD` itself, using **today's date**, now included in the poller's message content and system prompt for the first time, as the anchor). Stores `{ kind: 'family', name, tier: 'low-key', cost: 0, time }` — `cost: 0`/`tier: 'low-key'` are deliberate: `dashboard_v5.html`'s `planRemainingMonth()` treats *any* stored event on a date as contributing its `cost` (falling back to `TIER_MIDPOINT[tier]` when `cost` isn't a number) to the month's projected social spend, so an untagged appointment would otherwise get wrongly counted as a ~$75 (mid-tier) dining expense.
- **Time parsing is deliberately stricter than the dining tools' `parseTimeToHHMM`**: a new `parseGeneralTimeToHHMM` never assumes AM/PM for a bare hour (dining occasions are always evening, so "5" safely means 5pm there; a general event has no such pattern — "9" could be a school pickup at 9am or a dinner at 9pm, so it's left untimed rather than guessed).
- **Coexistence with dining events on the same date, both directions**: `resolveEventFields()` (the dining-event builder) now tags its output `kind: 'dining'`. `set_dinner_plan` was changed from replacing a date's entire event array to replacing only its own prior `kind: 'dining'` entries, preserving anything else stored there. `add_family_event` appends rather than replaces. So a family event and a dining confirmation can land on the same date without either clobbering the other, in whichever order they're added.
- **Dispatch wiring**: a new `FAMILY_EVENT_TOOL_NAMES` set (mirroring `DINING_TOOL_NAMES`/`FINANCIAL_TOOL_NAMES`) — this tool's call shape is `(monthPlanEvents, args)`, no `diningContext` or `owner` needed.
- **Calendar sync required no changes at all** — `calendar-sync.mjs`'s `buildEventBody()`/`signature()` already only look at `favoriteName || name`, `tier`, `cost`, and `time`, all of which a family event supplies (with `tier`/`cost` as the safe low-key/zero defaults) — a confirmed family event syncs to Google Calendar the same way a dining pick does, timed or all-day depending on whether a time was given.

## Verification

- `node data/test-telegram-bot.mjs` — 29 cases (24 prior + 5 new: `add_family_event` stores correctly with no cost/tier pollution; an explicit unambiguous time is stored while an ambiguous bare hour is not; a missing/invalid date replies with a clear error; a family event and a dining pick coexist on the same date added in either order, regardless of which is added first).

---

# V2 roadmap (audit-driven): undo, visibility, recurrence, smarter picks, editable schedule, calendar Q&A

*2026-08-01. Kevin asked for an audit of what's built plus a v2 roadmap. The audit's headline finding: nothing had been run against real credentials yet (`telegram.env`/`google-calendar.env`/`telegram-owners.json` all still absent) — everything below is built and tested against mocks, none of it live. Five gaps were prioritized (P1-P5); Kevin said "build them all." A sixth item (calendar Q&A) came from a separate follow-up question mid-build.*

## P1 — Undo: `delete_todo` + `remove_event`

Neither existed before — `mark_done` only marks done, and no dining/family event could be removed via the bot at all, only through the dashboard UI.

- **`delete_todo(index)`** — same 1-indexed-among-open-items addressing as `mark_done`, but splices the item out entirely.
- **`remove_event({ occasion?, date?, title? })`** — occasion resolves like `get_dining_plan`/`set_dinner_plan` (next occurrence, `kind:'dining'` entries only, so an unrelated family event on that date survives); otherwise takes an explicit date, with `title` required to disambiguate whenever more than one event sits on that date — it never guesses. Tombstones to `[]`, matching the existing "explicitly dismissed" convention.

## P2 — Surfacing failures instead of letting them sit silent

Two changes: (1) `helpText()` now echoes the original message back (`Couldn't process that (heard: "...")`) so the sender knows what was actually received, not just a generic failure. (2) The weekly recap now reads `telegram-unparsed.jsonl` for anything logged since the *last* recap (falling back to a 7-day window on the very first run), caps it to 5 entries, and includes it in the LLM's bundle so a bad stretch of unparseable messages gets a one-line mention instead of vanishing into a log file nobody looks at.

## P3 — Weekly recurrence for family events

`add_family_event` gained `recurrenceWeeks` — materializes N independent weekly-spaced events (capped at 52) sharing a `recurrenceId` used only for the confirmation message, not read back to reconstruct a rule (Month Plan has no concept of virtual/recurring events, only concrete dated ones). Each occurrence is independently cancelable via `remove_event` afterward.

## P4 — `recommendForSlot()`: scored ranking instead of filter-then-array-order

The dining recommendation heuristic already excluded recently-visited places and de-prioritized a same-cuisine repeat, but its final pick was just "first eligible entry in `favorite_places.json`'s array order" — meaning the same favorite could get suggested repeatedly indefinitely unless something incidentally reordered the list. Replaced with a score per eligible candidate: `daysSinceLastVisit` (capped at 365; never-visited scores the same as long-ago) minus a same-cuisine-as-last-time penalty, plus a small "go-to over want-to-go" bonus. Same input/output shape as before (still the swap point for a real LLM/ML call later) and deliberately still synchronous — this runs once per eligible day across a whole month's dashboard render, so a real per-call LLM request here would be slow and costly. Mirrored identically into `dashboard_v5.html`'s inline duplicate.

## P5 — Configurable duration + bot-editable routine days

**Duration**: `set_dinner_plan`/`add_family_event` gained an optional `durationHours` (clamped 0.25–8h); `calendar-sync.mjs` uses it for the Calendar event's end time instead of the fixed 2-hour default when present.

**Editable routine days** (`set_routine_day(occasion, dayOfWeek)`) was the larger piece. `goals.json`'s `diningRoutine` stays exclusively hand-maintained (per `claude.md`) — the bot never writes there. Instead, a new small file, **`data/dining-routine-overrides.json`** (`{family_dinner, date_night, weekend_social}`, each a dayOfWeek or `null`), is the only thing `set_routine_day` writes. `dining-recommendation.mjs`'s `slotForOccasion()` now resolves the *effective* day fresh on every call — looking the routine entry up by its original static day, then overlaying the current override — rather than baking an override into a pre-computed `diningRoutine` snapshot once; an earlier version of this that pre-transformed the array went stale mid-batch (a reschedule followed by a lookup in the same poll cycle reported the old day) and was caught by a same-batch test before it shipped. A parallel `effectiveDiningRoutine()` (real array transform, needed because the dashboard's own calendar walk matches by raw `dayOfWeek`, not an occasion lookup) is used by `dashboard_v5.html`, which now fetches the override file live via a new **`GET /api/dining-routine-overrides`** route on `dashboard-server.mjs` (read-only from the dashboard's side — only the bot writes it) — so a reschedule shows up on the dashboard without a `data.js` rebuild, the same reasoning as `month_plan_events.json`.

## Calendar Q&A: `get_calendar_events` + recap calendar summary

A separate follow-up ask: "can the bot answer questions about calendars? ... only look at Kevin personal and Hanna, not the shared work kevinfarino@herohealth.com." This reads *existing* Google Calendars (Kevin's personal, Hanna's — shared with Kevin's account), distinct from the "Family Planner" calendar `calendar-sync.mjs` one-way *writes* to.

- **New shared module `scripts/calendar-read.mjs`** — reuses `calendar-sync.mjs`'s OAuth token refresh (exported `getAccessToken`, real code sharing rather than duplication, since both are plain Node modules with no browser boundary) and adds `getUpcomingEvents({ calendarIds, days })`, merging/sorting events across every configured calendar; a single calendar erroring (access revoked, bad id) is skipped rather than failing the whole summary. Which calendars to read is **its own config**, deliberately separate from the write-target: `GOOGLE_READ_CALENDAR_IDS` in `google-calendar.env`, a comma-separated `id|Label` list (e.g. `kevin@personal.com|Kevin,hanna@email.com|Hanna`) — `calendar-auth-setup.mjs` now prompts for this too, with an explicit "don't include a work calendar" reminder.
- **`get_calendar_events({ days })`** is the only bot tool with no `TOOL_IMPL` entry — every other tool is a pure in-memory transform, but this needs a live external API call, so `telegram-bot-poll.mjs`'s dispatch special-cases it before the generic `TOOL_IMPL` lookup, with its own try/catch (a Calendar hiccup replies "couldn't reach Google Calendar," never crashes the poll).
- **Recap**: a new `calendarSummary` bundle field (`null` if not configured), with `RECAP_SYSTEM_PROMPT` instructed to mention it briefly only if something's notable (a busy stretch, a possible conflict with a dining plan) — supporting context, not a full readout, consistent with the recap's existing "quiet week reads short" principle.

## Verification (this round)

- `node data/test-telegram-bot.mjs` — 49 cases (29 prior + 20 new: `delete_todo`/`remove_event` incl. disambiguation and coexistence-preserving cases; duration stored/clamped on both dining and family events; `set_routine_day` incl. the same-batch reschedule-then-lookup case that first caught the staleness bug; `get_calendar_events` incl. not-configured and API-failure replies).
- `node data/test-telegram-recap.mjs` — 11 cases (8 prior + 3 new: unparsed-messages surfacing, `calendarSummary` populated/null/degraded).
- `node data/test-calendar-sync.mjs` — 8 cases (7 prior + 1 new: `durationHours` overrides the default block).
- `node data/test-dining-recommendation.mjs` — new file, 6 cases directly exercising `recommendForSlot()`'s ranking (variety, go-to preference, cuisine penalty, still-excludes-recent, still-excludes-already-used, low-key unaffected).
- `node data/test-calendar-read.mjs` — new file, 9 cases (`parseReadCalendarIds`, `loadCalendarReadContext`, `getUpcomingEvents` incl. multi-calendar merge/sort, all-day events, empty range, one-calendar-errors-skipped).
- `node data/test-dashboard-contract.mjs` — 24 cases (20 prior + 4 new: `effectiveDiningRoutine` moves/passes-through correctly, `loadRoutineOverrides` fetches live/degrades).
- `node data/test-dashboard-server.mjs` — 7 cases (5 prior + 2 new: `/api/dining-routine-overrides` GET defaults/reflects a bot-written file).
- Confirmed via `git status` that the only files touched by test runs were the intended new/edited source and test files — `accounts.json`/`budget_tracking.json`/`favorite_places.json` also showed as modified during this round, verified via `git diff` to be the unrelated, expected daily `LongtermDailyPull` Monarch pull, not test contamination.
- Outstanding: same as every round before — none of this has run against real Telegram/Anthropic/Google credentials yet.

---

# Going live (2026-08-01): real Telegram bot, real bugs, real design changes

*The first real end-to-end session — Telegram bot token, group, and Anthropic key all filled in for the first time. Three things surfaced that only show up under real use, not fixture-based tests.*

## Real bug found: `install-telegram-scheduled-task.ps1`'s `[TimeSpan]::MaxValue`

`Register-ScheduledTask` rejected the trigger with `The task XML contains a value which is incorrectly formatted or out of range` — Task Scheduler's XML duration format can't represent `[TimeSpan]::MaxValue` (~29,247 years; the field overflows). Fixed to `New-TimeSpan -Days 3650` (10 years — effectively indefinite for a task meant to run every 2 minutes forever, and well within the valid range). No test suite catches this class of bug — `Register-ScheduledTask` is a real Windows API call, never mocked — so it only surfaced on the very first real registration attempt.

## Design change: no more "must be addressed" gate

The bot originally only acted on messages that `@mention`ed it or replied to one of its own messages — everything else was read but silently ignored, by design, so it wouldn't interject during normal family conversation. Kevin's actual use case is different: **the whole group is dedicated to talking to the bot** ("they are all for her" — every message in this specific group is meant for it), so `isAddressedToBot()` and its gating check were removed entirely. Every message from a recognized sender (`telegram-owners.json`) is now processed; an unrecognized sender is still silently skipped, and the bot's own messages are naturally excluded the same way (its own Telegram user id was never added to `telegram-owners.json`).

## Design change: one combined reply per poll batch, not one per message

Also surfaced by real use: several messages arriving in the same 2-minute poll window previously each got their own separate `sendMessage` call — a flood of individual reply bubbles. Now every message in a batch is still processed individually (state changes, deterministic parse vs. LLM fallback — all unchanged), but their reply texts are collected and sent as **one** combined Telegram message (joined with blank lines) after the whole batch finishes. Threaded as a reply (`reply_to_message_id`) only when the batch contained exactly one message — with several, threading to any single one would be arbitrary, so it's posted as a fresh message instead. `telegram-bot-poll.mjs` gained its first injectable `telegramClient` (mirroring the recap script's own), needed to test this at all — every prior test bypassed the real send entirely via `dryRun`/`updatesFixture`, so this path had zero coverage before now.

## Design change: "default to intelligence every time" — replies get composed, not templated

The real complaint: replies read like log lines (`Added ✓ (owner: Kevin)`, `Deleted ✓: Buy a kitchen table`) because Claude was only ever used to *decide which tool to call* — the actual reply text was always the tool's own hardcoded string, never composed by Claude.

First cut wrapped each message's raw reply in its own separate rephrase call, then joined the (separately-composed) results with blank lines for the batch send. Kevin's follow-up caught the real gap: "the bot needs to decide if multiple different things were asked" — two independently-rephrased sentences glued together can still read disjointed if the batch held distinct, unrelated asks. Reworked to **`naturalizeBatch()`** — one call covering every raw reply in the whole batch together (not one rephrase per message), so Claude can see the full picture and decide how to present it: blended into one flowing reply if everything's the same topic, or addressed with its own clear sentence per item if they're distinct asks (`REPHRASE_SYSTEM_PROMPT` states this explicitly). `dispatchMessage()` itself no longer touches rephrasing at all — it just returns each message's raw reply, exactly as before this whole feature existed; the composition step lives entirely in `runOnce()`, after the batch loop finishes, right where the old per-message-vs-combined-send logic already was.

The already-natural "plain text answer, no tool call" path is left alone (it's already Claude's own composed text). The genuine failure paths (`no_api_key`, `unknown_tool`, `llm_error`, `no_tool_or_text`) are also left alone — `helpText()` already represents "intelligence wasn't available."

**Test isolation, deliberate**: `naturalizeBatch()` takes its own optional `rephraseClient` (and reads the same `apiKey`), entirely separate from `anthropicClient` (which only ever drives tool *selection*, per message). `sentReplies` (the return value's per-message array) stays the raw template strings exactly as before this feature — the exhaustive tool-behavior suite asserting on exact raw strings never had to change. The composed, actually-sent text is a distinct new field, **`combinedReply`** — computed whenever there's anything to say, independent of `dryRun`, so tests can inspect it without needing a real send. In production, the real `ANTHROPIC_API_KEY` is always present, so every real batch gets composed automatically; a rephrase failure (API hiccup) falls back to a plain join of the raw replies rather than losing any confirmation.

## Verification

- `node data/test-telegram-bot.mjs` — 59 cases total: 51 prior (1 rewritten in place — a plain unaddressed message is now processed, not skipped, matching the new no-gate design) + 3 batch-send cases (combined single send for a multi-message batch, correct threading for a single-message batch, nothing sent when nothing was processed) + 5 `naturalizeBatch()` cases (a single deterministic action composes via `combinedReply`; a single tool-invoked action does too; **two distinct asks in one batch reach the rephrase client in exactly one call**, both raw replies visible in `items`; no-key/no-client degrades `combinedReply` to a plain join; a rephrase failure degrades the same way rather than losing the confirmation).
- Manually verified live: real bot token + group + Anthropic key, `LongtermTelegramPoll`/`LongtermTelegramRecap` both registered and running (`LastTaskResult: 0`), `telegram-bot-whoami.mjs` used to capture both Kevin's and Hanna's real Telegram user ids into `telegram-owners.json`, a real batch of test messages processed end-to-end with one combined, Claude-composed reply sent back into the group.
- Learned live (not from a test): Telegram does not allow "replaying" old updates by rolling the offset back down — once `getUpdates` has been called with an offset past a given update, that update is gone from Telegram's side, not just locally acknowledged. Retrying old messages means resending them from the client, not resetting local state.
- Still outstanding: Google Calendar setup (`calendar-auth-setup.mjs`) — the interactive bot is now fully live, but Calendar sync/read remain untested against the real API.

---

# "Is this bot as intelligent as it can be?" — multi-tool-per-message + short-term conversational memory

*2026-08-01, same evening. Went through plan mode properly for this one (a real code-path audit, not a quick live fix) — see the plan file this was built from for the full context/reasoning trail.*

Two concrete, verified gaps, tackled together per Kevin's choice:

## Multi-tool-per-message

`dispatchMessage()`'s `llmResponse.content.find((c) => c.type === 'tool_use')` only ever picked the *first* tool-use block — a compound ask in one message ("add milk to the list and what's the budget status") silently only did the first thing. Changed to `.filter(...)`, looping over every `tool_use` block Claude returns in that one response and threading state forward across them (a second `add_todo` in the same turn sees the first one's effect, not just the last write) — each branch reads/writes a running `newTodos`/`newMonthPlanEvents`/`newRoutineOverrides` instead of the outer state, and raw replies are joined with newlines into that message's one reply string. An unrecognized tool name among several in the same turn is skipped, not fatal to the others.

**Deliberately NOT a full multi-turn agentic loop** — no `tool_result` is sent back to Claude for a follow-up turn, so genuine sequential reasoning (call A, see A's result, decide to call B) still isn't possible. That would need every one of the ~90 mocked-`anthropicClient` tests to return a *second*, different response after the first; a single-shot mock would otherwise have the loop call it repeatedly with the same fixed tool_use, silently repeating the action. Deferred as its own future round once this simpler, zero-regression win has been live a while.

**Backward compatibility, confirmed**: every existing mock returns exactly one `tool_use` block; `.filter()` on a one-element match is identical to `.find()`. All 59 pre-existing cases in `test-telegram-bot.mjs` passed unmodified.

## Short-term conversational memory

Every message was previously handled in total isolation — a follow-up like "actually make that 6pm" had nothing to resolve "that" against. New **`data/telegram-conversation-log.jsonl`** (append-only, unbounded growth accepted — same tradeoff already made for `telegram-unparsed.jsonl`): one line per processed message, `{at, sender, text, reply}` (that message's own raw reply, logged before the batch-level `naturalizeBatch()` composition, so it stays 1:1 with the message it came from). `loadRecentConversation()` reads the last 6 entries (degrades to `[]` if missing/corrupt) once per `runOnce()`, formatted into `callAnthropicFallback`'s prompt as a "Recent conversation" transcript above the current message — system prompt updated to use it for resolving references. Appended to **in-memory too**, not just on disk, so a second message later in the *same* poll batch already sees the first one's exchange, not just the next poll cycle's.

## Verification

- `node data/test-telegram-bot.mjs` — 66 cases (59 prior + 3 multi-tool cases: two distinct asks both execute and both appear in the reply; two writes in one turn both land, not just the last; one unrecognized tool among several is skipped, not fatal + 4 conversational-memory cases: seeded history reaches the LLM fallback; missing log degrades to `[]`; a written entry round-trips to the next `runOnce()` call; a later message in the *same* batch already sees an earlier one's exchange).
- All other suites (recap, calendar-sync, calendar-read, dining-recommendation, dashboard-contract, dashboard-server) unchanged and still passing — 131 cases total across the project.
- Manually verified live: both scheduled tasks still run clean (`LastTaskResult: 0`) after deploying.

---

# `log_planning_note`: capturing complex financial/planning asks the bot can't act on directly

*2026-08-01, later the same evening. Kevin tried to tell the bot about a real childcare cost change in free text (a weekly cost that changes on a date, an additional monthly budget line, a category relabel) — the bot correctly said it couldn't do that, then unprompted broke the request into three clean bullet points and asked how to log it. Asked for a plan to enable exactly that.*

Checked `data/goals.json`: this is a real, already-known thread — `phases[0].expenses` already has `"Au pair (starts Aug 2026)": 880`, and `openDecisions` already has `"Childcare post-au pair (Aug 2027)": "TBD"`. So the specific ask really is a `goals.json` planning update, just one that doesn't map cleanly onto the single flat figure currently there (the described schedule has two different weekly rates split by a date, plus a separate food-budget line, plus a rename).

**The central decision, not an incidental limitation**: `goals.json` is exclusively hand-maintained (per `claude.md`, with real incident history behind that rule — a >1-year drift from stale hand-typed figures, and a separately-documented missed $1,252.68 charge from trusting a summary over line-by-line review). This session already established the pattern once, for `set_routine_day`: never let the bot write into `goals.json` itself; give it a separate bot-owned file instead, and let a real Claude session fold it in. Same principle applied here — the bot's job is to **capture and structure**, not auto-edit a multi-phase forecast from one free-text message with no review step.

**What "understand natural language" actually meant**: Claude's comprehension was never the gap — the pasted example already broke the request into clean bullet points *unprompted*, with no tool asked for. The missing piece was purely that no tool existed for it to call once it understood something.

## `log_planning_note(summary)`

New file **`data/telegram-planning-notes.jsonl`** — append-only (same convention as `telegram-unparsed.jsonl`: unbounded, no pruning). `telegram-bot-tools.mjs`'s `log_planning_note(planningNotes, { summary, sender })` pushes `{ at, sender, summary }` and replies with an explicit "this won't update the real budget until it's folded into the plan properly" — never implying the number just changed. `sender` is threaded in by the caller the same way `owner` is for `add_todo`, not something Claude supplies.

**The tool description does the real work**: it instructs Claude to compose `summary` itself — extract every concrete detail (amounts, dates, what changes to what) into one structured paragraph, "the same way you'd naturally break the request into bullet points" — rather than passing raw message text through. The tool just durably stores whatever Claude hands it.

**Wiring**: `PLANNING_NOTE_TOOL_NAMES` (mirroring `ROUTINE_OVERRIDE_TOOL_NAMES`'s shape), a new branch in `dispatchMessage()`'s multi-tool loop, and `runOnce()` loads/snapshots/writes `planningNotes` via the exact same pattern already proven for `routineOverrides` (load once, mutate through the batch, write back only if changed) — no new pattern invented.

## Recap: surfacing pending notes

Same reasoning that put `unparsedMessages` in the recap bundle: a captured note shouldn't sit invisibly in a `.jsonl` file forever. `telegram-bot-recap.mjs` gains `pendingPlanningNotes` (`{ count, recent }` — total count plus the 2 most recent summaries, never every one verbatim), and `RECAP_SYSTEM_PROMPT` gains a line to mention it briefly when non-zero.

## Explicit scope cuts

- No auto-write to `goals.json` — the central decision, not a shortcut.
- No "mark reviewed" mechanism — Kevin reads and manually reconciles the file, then can clear/archive it himself, same as `telegram-unparsed.jsonl`'s existing precedent.
- No attempt at a rigid schema for every possible planning-note "type" — a Claude-composed structured-text summary generalizes far better than typed fields for cost schedules vs. category renames vs. brand-new expense lines.

## Verification

- `node data/test-telegram-bot.mjs` — 70 cases (66 prior + 4 new: a note is captured with its composed summary and an explicit "won't change the real budget" confirmation; it persists to disk when not a dry run; a missing summary replies with a clear error and adds nothing; a pre-existing note from a prior session is preserved when a new one is appended, not overwritten).
- `node data/test-telegram-recap.mjs` — 13 cases (11 prior + 2 new: `pendingPlanningNotes` is zero-count/empty with nothing captured; with 3 notes present, count reflects all 3 while `recent` shows only the last 2, most-recent last).
- All other suites unchanged — 137 cases total across the project.
- Manually verified live: both scheduled tasks still run clean (`LastTaskResult: 0`) after deploying. Outstanding: the real childcare message hasn't yet been re-sent to confirm the live capture end-to-end, and the resulting note hasn't yet been manually reconciled into `goals.json`'s phases.

---

# Reversal: `log_planning_note` replaced with direct `goals.json` writes

*2026-08-02, the next day. Kevin actually used the bot live and sent 3 real messages about the childcare cost change (screenshots reviewed directly, not trusted from the bot's own narration). `log_planning_note` captured them correctly as data, but the bot's composed reply included a fabricated line — "I'll flag you when that's done rather than have it silently update" — a promise about a review/notification mechanism that doesn't exist anywhere in the code. When the composed reply included my own explanatory framing ("goals.json is untouched, exactly as designed... sitting in a review file waiting for us to fold them into the plan together"), Kevin rejected the whole design: "i want the bot to change files. i don't want to have to talk to you to do that. this statement worries me that this is built wrong."*

This reverses the central decision of the previous section outright. The "never let the bot write `goals.json`, always require a human/Claude-session review step" principle was my own added caution, not something Kevin asked for — and the previous section's own hallucination (the bot inventing a review mechanism to describe its own capture-only behavior) is exactly the kind of confusion a review gate was supposed to prevent, yet still produced. Kevin's instruction is explicit and durable: the bot changes real files directly; no conversation with Claude is required to finalize a change.

**The one real structural question**: `goals.json`'s `phases[].expenses` is a flat `{label: monthlyDollarAmount}` map — no schedule or date-range concept, and phases only carry a human-readable `period` string, not machine-readable start/end dates. The real ask ("$700/wk through Oct 23, then $275/wk after") doesn't fit a single number with a future-dated change built in. Asked Kevin directly via `AskUserQuestion` rather than guessing or reintroducing a review gate; he chose **"Current rate now"** — set today's real rate, and message the bot again around Oct 23, 2026 when it actually changes. This matches a convention already visible in the data (`"Au pair (starts Aug 2026)": 880` — a single current-or-upcoming figure, not a schedule).

## `update_phase_expense` / `log_decision`: direct writes, no gate

`log_planning_note` and `data/telegram-planning-notes.jsonl` are removed entirely (the 3 already-captured historical notes remain in the file as a historical record only — nothing reads it anymore). Two new tools in `telegram-bot-tools.mjs` write straight into the in-memory `goals` object the same way every other tool here writes into its own state:

- **`update_phase_expense(goals, { phaseId, expenseKey, renameFrom, amount })`** — sets `phase.expenses[expenseKey] = round(amount)`. An optional `renameFrom` deletes the old key first, so a relabel (e.g. "Nanny" → "Au pair") never leaves a stale duplicate line. Clear error replies (goals unchanged) for an unknown `phaseId`, a missing label, or a non-finite/negative amount — same "reply with a clear error, don't throw" convention every other tool follows.
- **`log_decision(goals, { title, summary, status })`** — pushes a new entry onto `goals.decisions` (`status` defaults to `'active'` if not one of `urgent`/`active`/`watch`/`good`). Clear errors for a missing title or summary.

`GOALS_TOOL_NAMES` replaces `PLANNING_NOTE_TOOL_NAMES`. The system prompt tells Claude to call these directly (not compose a "note") whenever a message describes a phase-expense change or a new open decision, states the "current rate now, not a schedule" convention explicitly, and — directly targeting the hallucination that triggered this reversal — instructs: **"When you reply after one of these, only state what you actually did — never invent or promise a review process, notification, or follow-up mechanism that doesn't exist; the change already happened, full stop."** `callAnthropicFallback()` now also passes a `phasesSummary(goals)` (id/name/period/expenses per phase) into the prompt context so Claude can pick the right `phaseId` without guessing.

**Traceability without a gate**: every `update_phase_expense`/`log_decision` call appends `{at, sender, tool, input, reply}` to `data/goals-changelog.jsonl` — an audit trail, explicitly not an approval mechanism, written *after* the edit already happened. `runOnce()` reuses the exact `todos.json`-style regeneration pattern: if `goals` changed during the batch and it's not a dry run, `writeJson()` persists it, then `regenerateFromGoals()` runs `build-data.mjs` and `build-goal-plan-md.mjs` (guarded by `fs.existsSync` off the goals file's own directory, so temp-dir tests never trigger the real regeneration scripts) — the same rule `claude.md` already requires after any hand-made `goals.json` edit.

## Explicit scope cuts

- No review/approval step of any kind — the entire point of this reversal.
- No schema for date-scheduled rate changes — "current rate now, tell the bot again later" is the deliberate, Kevin-chosen convention, not a limitation to fix later.
- The changelog is append-only, same as every other `.jsonl` log in this project — no "mark reviewed"/clearing mechanism, and none needed since there's no review step to clear.

## Verification

- `node data/test-telegram-bot.mjs` — 78 cases (70 prior minus 4 removed `log_planning_note` tests, plus 8 new: `update_phase_expense` basic update + `renameFrom`, persists to disk when not a dry run, unknown `phaseId` errors cleanly, invalid amount errors cleanly, two calls in one message both apply across different phases, an unreadable `goals.json` degrades to a clear reply instead of crashing; `log_decision` basic add, missing title/summary errors cleanly).
- `node data/test-telegram-recap.mjs` — 13 cases (11 prior + `pendingPlanningNotes`'s 2 tests replaced with `recentPlanChanges` equivalents: zero-count/empty with nothing logged, reports total count with only the 2 most recent replies shown).
- `claude.md` and this spec updated to describe the new tools and `data/goals-changelog.jsonl` in place of the removed `log_planning_note`/`telegram-planning-notes.jsonl` references.
- Outstanding: full project-wide suite re-run to confirm zero regressions elsewhere, live scheduled-task deploy check, and the real `data/goals.json` edit applying Kevin's actual current nanny rate (~$3,033/mo from $700/wk) to the real Au pair expense lines in Phase 1 and Phase 2.

---

# Multi-turn clarification: the bot waits for an answer instead of guessing or dead-ending

*2026-08-02, later. Kevin asked for a plain-language walkthrough of the whole system, then said: "let's add in multi-turn if it has ambiguous directions. this is a must have." Today, every message is handled in one shot — one Claude call, whatever tool(s) it picks run immediately, reply goes out. Some logic already detects when it can't safely act (`remove_event` asks "which one?" when a date has 2+ events) but nothing then treats the next message as answering that — it's processed fresh, with only a loose recent-conversation transcript as context, no real waiting.*

**Scope, per Kevin's own framing**: broader than just the cases that already detect ambiguity (like `remove_event`) — any time Claude itself isn't confident it has enough to act safely, e.g. a cost change with no dollar figure or no indication which phase it applies to. But the default stays "bias toward action, handle it the first time" — asking is the exception for genuinely missing information, not a routine confirmation step. Kevin's words: "it's our fault for not giving the bot enough info to act... it should drive towards confirmation if the ask is unclear, but bias towards action."

## Pending clarification: one open question per sender

New state file, `data/telegram-pending-clarifications.json`: `{ kevin: { question, originalText, askedAt } | null, hanna: ... }`. Loaded/saved with the same load-once-per-batch, mutate-through-the-loop, write-back-if-changed pattern already used for `routineOverrides`/`goals`.

**Registering a pending clarification** happens in two places:
1. `dispatchMessage()`'s LLM fallback path: when `callAnthropicFallback` returns no `tool_use` blocks at all, just text — already the natural "I don't have enough to act, here's a question/comment" signal — that text becomes the pending question instead of just being relayed as a dead-end reply.
2. A tool's own internal disambiguation: `remove_event` gains a `needsClarification: true` flag on its return when it hits the "2+ events that date, no title" case (its only such case today). Dispatch checks for this flag on every tool result and registers a pending clarification the same way, using the tool's reply text as the question.

**Resuming**: at the top of per-message dispatch, before `tryDeterministicParse` even runs, check whether the sender has a pending clarification that hasn't expired. If so, skip deterministic parsing and the normal fallback prompt, and make one Claude call with three things bundled in: the original message that triggered the question, the question itself, and this new reply. Claude decides the outcome — no rigid "must match X" logic:
- **Resolved** — Claude calls the right tool(s) with the combined info. Pending state is cleared.
- **Still unclear** — Claude replies with no tool call again (a follow-up question). Pending state is updated with the new question and the expiry timer resets.
- **Unrelated** — Claude recognizes the new message doesn't answer the old question and just handles it as its own fresh request (can still call tools normally). Pending state is cleared either way — a stale question is never carried past one resume attempt where it wasn't the answer.

**Expiry: 3 hours.** Long enough for a real same-day back-and-forth (someone steps away and answers later), short enough that an unrelated message sent the next day isn't misread as answering yesterday's question.

**Per-sender, not global.** If Hanna messages while Kevin has an open question, hers is handled completely normally — never held hostage by his pending state. At most one open question per sender; a new ambiguous moment before the last one's answered just replaces it (no queue).

## Prompt changes

The fallback system prompt currently pushes hard toward action for financial edits ("never just apologize... one of these two tools almost always applies"). That instruction stays for anything with a reasonable default, but gains an explicit carve-out: when something required is genuinely missing — no dollar amount, no clear phase, no way to tell which of several candidates is meant — ask one short, specific question instead of guessing at a number or a target. This mirrors the same "ask, don't guess" instinct `remove_event` already has, extended to the free-text path generally.

## Explicit scope cuts

- No new dedicated "ask" tool — reusing "Claude replied with text, no tool call" as the signal avoids growing the tool list for something the model can already express.
- No queue of multiple pending questions per sender.
- No surfacing of a stale, unanswered question in the weekly recap — out of scope unless it becomes a real problem later.
- No change to the multi-tool-per-message loop itself — resuming a pending clarification still produces zero or more tool calls in one Claude turn, same as any other message.

## Verification

- `node data/test-telegram-bot.mjs` — 86 cases (78 prior + 8 new): a plain-text fallback reply (no tool call) registers a pending clarification and persists it to disk; a follow-up on the next poll resolves it (the resume call receives the original text + question, completes the right tool with combined info, clears the state); an expired pending clarification is ignored, deterministic parsing runs as if nothing were pending; an unrelated follow-up drops the old question rather than misreading it as an answer; `remove_event`'s multi-candidate disambiguation registers a pending clarification instead of dead-ending; its follow-up resolves and removes just the named event; a pending clarification for one sender is untouched by a different sender's message in the same batch.
- All other suites re-run — zero regressions (`test-telegram-recap.mjs`, `test-calendar-sync.mjs`, `test-calendar-read.mjs`, `test-dining-recommendation.mjs`, `test-dashboard-contract.mjs`, `test-dashboard-server.mjs` all still pass unmodified).
- `claude.md` updated with a `data/telegram-pending-clarifications.json` project-files bullet.
- Outstanding: manual live verification — send a genuinely ambiguous message, confirm the bot asks instead of guessing, reply, confirm it completes the original action correctly; deploy check (`LastTaskResult: 0`).

---

# Weekly recap fixes: dining repeats, missing budget numbers, unwanted long-term goals, no calendar heads-up

*2026-08-02, later the same day. Kevin pasted the actual recap the bot sent along with 4 specific complaints, plus a separate question about how the budget projection is calculated.*

Read the real code paths rather than guessing at causes:

1. **All 3 dining slots suggested "Terra Eataly."** `diningSummary()` called `get_dining_plan()` independently per occasion; each call only excludes names already *confirmed* on the calendar, with no idea what the other 2 occasions in the same recap are about to suggest. Checked the real `favorite_places.json` (95 places, 10/53/51 eligible per occasion tag) — plenty of alternatives exist, the bug was purely that 3 independent calls converge on the same top-scored candidate.
2. **No budget numbers, just "tracking ok."** The bundle already carries the real figures (same data `get_budget_status` uses for a full breakdown on demand) — the recap's system prompt never required citing them, so the model chose a vague adjective. Pure prompt gap.
3. **Long-term savings goals in a weekly recap.** The bundle included `savingsGoals` and the prompt explicitly asked for "savings goals progress" — a different cadence of information than a week-scoped recap.
4. **No heads-up for calendar conflicts, and no general callout of one-off events.** `calendarSummary` already has per-person, dated events as text, but the recap never had each occasion's own date to cross-reference against, and never distinguished recurring from one-off events at all.

**The budget projection formula** (`financial-context.mjs`'s `computeTrackerPacing`): `dailyRate = total spent / total days elapsed so far` (weighted by each week-bucket's real day count so a trailing partial week doesn't skew it), then `projected = dailyRate * cycleDays`. A straight-line extrapolation of the current spend rate, no adjustment for known future spend — explains Kevin's $1,270 logged → $5,442 projected (a ~$170/day rate over ~7.5 elapsed days, extrapolated across the ~32-day cycle). No code changed here, just explained directly.

## Fix 1: `get_dining_plan` gains `extraExcludeNames`

A 4th, optional param (`= new Set()`), unioned into the existing `alreadyUsedNames` set before scoring. Also returns `date` and `suggestedName` alongside `reply` — purely additive, no existing caller (which only ever read `.reply`) breaks. `diningSummary()` now threads an accumulating set across its loop over the 3 occasions, adding each pick before moving to the next — the exact mechanism the dashboard's own month-render loop already used to avoid this same problem across days, just never applied across the recap's 3 occasions. Its return shape changed from `{ occasion: replyString }` to `{ occasion: { date, reply } }`.

## Fix 2 & 3: recap prompt — real numbers, no long-term goals

`RECAP_SYSTEM_PROMPT` now requires citing the actual dollar figures whenever budget pace comes up (logged, projected, target) rather than an adjective. `gatherBundle()` no longer includes `savingsGoals` at all, and the prompt's coverage list drops "savings goals progress" — scoped to the recap only; `get_savings_goals` and the dashboard are untouched.

## Fix 4: calendar heads-up — dining-day conflicts and non-recurring callouts

`calendar-read.mjs`'s `getUpcomingEvents`/`formatEventLine` now tag a line " (recurring)" when Google's own `recurringEventId` field is present on the event (an occurrence of a recurring series — absent on a genuine one-off), left unmarked otherwise since one-off is the more common case for a personal calendar. This enriches the shared `calendarSummary` text used by both the interactive `get_calendar_events` tool and the recap. `RECAP_SYSTEM_PROMPT` then does two things with it: always names any non-recurring event on either calendar (advance awareness for the unusual, not the routine), and separately cross-references each dining occasion's date against `calendarSummary` for a specific heads-up (e.g. "Hanna already has a dinner Wed — Kevin's probably solo for family dinner") rather than presenting a suggestion as if nobody has other plans. The recurring/non-recurring distinction is real code (a hard fact from the API); the actual cross-referencing and phrasing is left to the model's judgment, same as the rest of this recap's composition.

## Verification

- `node data/test-telegram-bot.mjs` — 89 cases (86 prior + 3 new: `extraExcludeNames` returns a different suggestion when the top pick is excluded, falls back to a repeat rather than nothing when every candidate is excluded, and a genuinely empty favorites list reports no fresh suggestion).
- `node data/test-telegram-recap.mjs` — 14 cases (12 prior + 2 new: the bundle no longer includes `savingsGoals` and each dining entry includes its `date`; 3 occasions with several eligible candidates don't converge on the same restaurant — reproduces the real "Terra Eataly x3" bug, then disproves it).
- `node data/test-calendar-read.mjs` — 11 cases (9 prior + 2 new: an event with `recurringEventId` is tagged "(recurring)"; one without it is left unmarked).
- All other suites re-run — zero regressions.
- `claude.md` updated: `telegram-bot-recap.mjs`'s and `calendar-read.mjs`'s bullets reflect the new behavior.
- Outstanding: live deploy check (trigger the recap task, read the real sent message) and explaining the projection formula to Kevin directly.

---

# Calendar-aware dining recommendations: check the calendar before suggesting, not after

*2026-08-02, later still. Setting up real Google Calendar access (via `gws`, see below) surfaced a live example of exactly the gap the recap's calendar heads-up was designed for: Kevin told the bot he and Hanna were both attending a dinner already on her personal calendar. Recording that as a fresh confirmed plan via `set_dinner_plan` triggered `calendar-sync.mjs` to push a duplicate onto the shared Family Planner calendar, since the real event already existed on Hanna's. First direction was a `note_external_event` tool to mark a slot "covered, don't sync" — Kevin reversed this: family planning will increasingly happen through the bot going forward, so an occasional duplicate is an acceptable, shrinking edge case. The real ask instead: make dining recommendations themselves smarter about the calendar, not just append a heads-up sentence after the fact — check the calendar *before* deciding whether/what to suggest, every time.*

## Real Google Calendar access, via the already-installed `gws` CLI

Before this feature could be built or tested against real data, Google Calendar needed to actually be enabled — `google-calendar.env` didn't exist on this machine. Per [[feedback_check_existing_tools]], checked for existing tooling before reaching for `calendar-auth-setup.mjs`'s own OAuth flow: `gws` (a general Google Workspace CLI) was already installed and configured against the right Google Cloud project (`family-desktop-cli`, Calendar API already enabled) — its stored token had just expired. Re-authenticated via `gws auth login` (an initial run had requested 88 scopes including Workspace-admin-level access, which Google's own unverified-app warning flagged as likely to fail — that turned out to be a stuck/resubmitted browser tab rather than a fresh invocation; the successful run landed on a reasonable ~11-scope default set that includes `calendar`, not the 88-scope one). Credentials were hand-copied from `gws auth export --unmasked` and `~/.config/gws/client_secret.json` into `google-calendar.env` directly by Kevin — `gws auth export`'s un-redacted output was blocked by Claude Code's own auto-mode classifier, correctly, since it would have printed a live refresh token into the chat. Created the shared "Family Planner" calendar via `gws calendar calendars insert` (no separate OAuth client needed). Both Kevin's (`farinooh@gmail.com`) and Hanna's (`hkamaric@gmail.com`) calendars read correctly once configured, confirmed live — including a real reproduction of the exact conflict this feature addresses (Hanna's "Shannon/Ryan Dinner," Wed 5pm, on the real family_dinner date).

## The mechanism

- `calendar-read.mjs`'s `getUpcomingEvents` gains a structured `items` array — `{ label, title, date, time, isRecurring }` per event — alongside the existing text `summary` (additive; `get_calendar_events`'s reply and the recap's `calendarSummary` text are unaffected). `date` is the event's local calendar date (`YYYY-MM-DD`); `time` is 24-hour `HH:MM` for a timed event, `null` for an all-day one.
- `diningContext` gains an optional `calendarEvents` field (that same structured list). Both `telegram-bot-poll.mjs` and `telegram-bot-recap.mjs` fetch calendar data once per run (if configured) and pass it in — `get_dining_plan` stays a pure, synchronous function; the one async network call happens upstream, same pattern as every other piece of context here (favorites, financial context, etc.).
- `get_dining_plan`'s flow, for an occasion not already confirmed: check `calendarEvents` for any entry on that date with `time >= '16:00'` (an untimed/all-day event, or one earlier than 4pm, doesn't count — a morning appointment shouldn't suppress an evening dining suggestion). If found, skip `recommendForSlot` entirely and report the slot as already covered, naming who and what. Only when nothing evening-timed is found does it proceed to generate an actual restaurant suggestion, exactly as before.
- `recommendForSlot`'s own scoring/picking logic is untouched — this changes *whether* a suggestion gets generated at all, not which place gets picked when one does.
- `RECAP_SYSTEM_PROMPT` gains a small clarification: a "looks already covered" entry is a different state than an unconfirmed suggestion — mention it in passing, don't push for a booking reply the way an actual live suggestion warrants.
- **Recurring events are excluded from coverage**, found live against real data: Kevin has a daily recurring "Eat" calendar block at 4pm — without excluding `isRecurring` events, this wrongly marked *every* evening as "covered," not just genuine one-off commitments. Only a non-recurring, evening-timed event counts.

## Scope cuts

- No change to `recommendForSlot`'s actual algorithm (explicitly considered and declined — Kevin wants the calendar check gating *whether* a suggestion happens, not influencing which place gets picked).
- No attempt to reuse a single calendar fetch across `get_calendar_events`'s on-demand path and the upfront dining-context fetch — a message that triggers both in the same batch costs two Calendar API calls instead of one. Minor, not worth the added complexity now.
- The 4pm threshold is a fixed constant, not configurable — revisit only if it produces a real false positive/negative in practice.

## Verification

- `node data/test-calendar-read.mjs` — 11 cases, unchanged count (structured `items` verified indirectly through the existing recurring-tag tests, plus new coverage below).
- `node data/test-telegram-bot.mjs` — 96 cases (89 prior + 7 new): an evening calendar event on the occasion's date suppresses the suggestion and reports coverage by name; a same-day morning-only event does not; a same-day all-day event does not; an evening event on an unrelated date does not; a *recurring* evening event does not (the real "Eat" block bug); plus the pre-existing extraExcludeNames/no-favorites cases.
- `node data/test-telegram-recap.mjs` — 15 cases (14 prior + 1 new): a dining occasion covered by a real evening calendar event is reflected directly in the bundle's reply text, not inferred by the composing LLM from a separate field.
- Full suite re-run — zero regressions (also caught and fixed a pre-existing test-isolation gap: `test-telegram-bot.mjs`/`test-telegram-recap.mjs`'s `baseOpts()` never pointed `calendarEnvPath` at an isolated path, so a "not configured" test silently started reading this machine's real `google-calendar.env` once it actually existed — fixed by defaulting to a guaranteed-nonexistent path in both files' fixtures).
- Manual, against real data: checked all 3 occasions with nothing confirmed yet. First pass wrongly reported *every* occasion as "covered" — Kevin's daily recurring "Eat" block at 4pm was matching the evening-coverage check. Fixed by excluding `isRecurring` events. Re-checked: family_dinner (2026-08-05) correctly reports covered by Hanna's real "Shannon / Ryan Dinner," while date_night and weekend_social — genuinely nothing on the calendar — get normal restaurant suggestions.
- `claude.md` updated: new `get_dining_plan` bullet describing the calendar-coverage check, `calendar-read.mjs`'s bullet updated for the structured `items` field and the `gws`-based setup, `telegram-bot-recap.mjs`'s bullet updated to reflect that per-occasion coverage now lives in `get_dining_plan`, not the recap's own prompt.
