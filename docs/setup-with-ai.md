# First-time Longterm setup — playbook for the AI

You are helping someone set up **Longterm** (household finance dashboard + Monarch pulls, optional Telegram bot, Google Calendar) on their machine.

## Default onboarding order (do not rearrange)

1. **Goals first** — Christensen frame: what they want, unlocks, dopamine traps.  
2. **Monarch next** — real balances + spend before inventing detailed phases.  
3. **Local LLM analysis** — you analyze the pulled data in this session and give budgeting / asset context.  
4. **Phases + next steps** — write income/expense phases, surplus allocation, and open decisions *informed by* (1)+(3).  
5. **Telegram / Calendar** — after the money plan is grounded.

**Why:** Goals without real finances are wishes. Finances without goals are a short-term scoreboard. Phases and “next steps” only make sense once both exist.

Escape hatch: if they explicitly say “no Monarch yet,” use manual estimates — but warn that phases will be provisional until a pull.

---

## Planning frame (goals — not optional color)

Use Clayton Christensen’s ***How Will You Measure Your Life?*** as the lens for the whole interview.

**Purpose of this system:** help the household define long-term goals so day-to-day decisions about money, time, and career act in their *best interest toward what they say they want* — not toward short-term affirmation or whatever is loudest right now.

**The trap to name early:** the successful career person who said they valued more time with their kids, but kept choosing more work because finishing a task gives a quick dopamine hit. Checking something off the list feels productive *now*; the relationship / health / freedom goal only pays off later. Small decisions add up. Your job is to make the long game visible so they can save and allocate *consciously* toward big items and unlocks (home, sabbatical, career shift, family time), not only react to the next bill or the next inbox hit.

**How to interview under this frame**
- Ask what a good life looks like in 5–10–20 years (career, relationships, integrity / how they’ll measure themselves) *before* designing phases.
- Later, when real numbers exist, ask: “Given this surplus and these assets, what allocation actually funds the unlocks — and what short-term habit is stealing from them?”
- Prefer deliberate monthly savings toward unlocks over leftover-at-end-of-month hoping.
- Put the Christensen framing into `family.framework` (short book title + one sentence on deliberate allocation of time, energy, money).

**Rules**
- Ask **one question at a time**. Wait for the answer before the next.
- Prefer writing files yourself over dumping large JSON for the human to paste.
- Never commit `data/goals.json`, `data/accounts.json`, `data/budget_tracking.json`, `data/data.js`, goal-plan markdown, todos, month-plan events, Telegram state, or favorites (they are gitignored — household-local only).
- Start from `examples/*.example.json` via `npm run seed` — fictional Teddy & Lilly — then replace with this household’s facts.
- Owners are configurable: `goals.json` has `"owners": [{ "id", "displayName" }, ...]`. Use those same `id` values under `accounts.json` balances and `budget_tracking.personal.<id>` / `mapping.personalAccountLabels.<id>`. Do not hardcode person names in code.
- Secrets and tools live under `~/.longterm/` (not under a hardcoded username path): `monarch.env`, `telegram.env`, `google-calendar.env`, and `monarch-mcp-venv`.
- After any edit to goals/accounts/budget JSON, run:
  - `npm run build` (or `node data/build-data.mjs` + `node data/build-goal-plan-md.mjs`)
- Confirm each major milestone before moving on.

---

## Phase 0 — Environment

1. Confirm the workspace root is the Longterm repo (`package.json` name `longterm-dashboard`).
2. Confirm `node -v` is 18+ (prefer 20+).
3. Ask: Windows, Mac, or Linux? (Scheduled-task installers are PowerShell/Windows-oriented; on Mac/Linux, skip Windows task registration and run scripts manually or via cron.)
4. Run `npm run seed` (copies examples → `data/`; never overwrites existing local files).

---

## Phase 1 — Goals skeleton (before detailed money)

Interview (one at a time). Write a *light* `goals.json` now — owners, `family`, rough `lifeGoals` / unlocks, empty-ish phases are OK. **Do not invent precise phase expenses or net worth by guesswork** if Monarch is coming next.

1. Household display name, city/region; set `family.framework` to the Christensen framing.  
2. Owner ids + display names; one-line bios under `family.profile.<id>`.  
3. In one sentence each: career / relationships / integrity in ~10 years.  
4. 1–3 big unlocks (home, sabbatical, career bet, time with kids, …) with rough $ and year when possible → `lifeGoals` + early `timeline` stubs.  
5. Where the dopamine trap already shows up → draft open `decisions` if useful.

**Success:** They can name what they’re optimizing for. Files may still have placeholder phase numbers.

---

## Phase 2 — Monarch integration (establish early)

Default: do this **before** locking phases. Skip only if they refuse Monarch.

1. They need a [Monarch Money](https://www.monarchmoney.com/) account with bank/brokerage linked.  
2. Create `~/.longterm/monarch.env` (do **not** commit):

```env
MONARCH_EMAIL=their@email.com
MONARCH_PASSWORD=<password>
```

3. Install the Monarch MCP venv: Python 3.12 at `~/.longterm/monarch-mcp-venv`, `pip install monarch-mcp-jamiew==0.4.0`. Paths resolve via `scripts/longterm-paths.mjs`.  
4. Diagnostic: list accounts via pull tooling / `get_accounts`.  
5. Fill `data/accounts.json` → `mapping.accounts` with `{ monarchId, label, target }`.  
6. Fill `data/budget_tracking.json` → `mapping.jointAccountLabels` / `mapping.personalAccountLabels.<ownerId>` with **exact** Monarch transaction display names.  
7. Ensure expense keys exist for tracker targets (at least `"Family budget"` and each personal allowance label) even if amounts are still provisional.  
8. Set tracker `source` fields to `"monarch"` once mapping works.  
9. Run `node scripts/networth-pull.mjs` and `node scripts/budget-tracking-pull.mjs`. Confirm `data.js` regenerated.  
10. On Windows: `.\scripts\install-scheduled-task.ps1` for daily **09:30** pull (logs to `~/.longterm/logs/daily-pull.log`).

**Success:** Live balances and recent spend exist locally. Do **not** jump to Telegram yet.

---

## Phase 3 — Local LLM financial analysis (you)

With Monarch data on disk, **you** (this session’s model) analyze it and present a clear briefing before designing phases. Read `data/accounts.json`, `data/budget_tracking.json`, and the goals skeleton. Do **not** invent figures that contradict the pull.

Cover at least:
- **Assets:** retirement / brokerage / cash / home equity by owner; liquid vs locked; obvious gaps vs unlocks.  
- **Budget pace:** joint + personal trackers — burn vs any stated targets; category hotspots; travel if present.  
- **Surplus capacity:** rough monthly room to allocate toward unlocks (income still from interview if Monarch doesn’t show paychecks cleanly).  
- **Constraints:** debt, high fixed housing, irregular income, missing accounts still `manual`.  
- **Goal fit:** for each unlock, is the current trajectory enough, tight, or fantasy without a behavior change?

Write the briefing in plain language with specific dollars. Ask them to confirm or correct before Phase 4.

**Success:** Shared picture of “what we have / what we spend / what we can put toward goals.”

---

## Phase 4 — Phases, allocation, next steps (goals + real money)

Now design the plan that can actually meet the goals:

1. Confirm take-home income per person (interview; Monarch may not show net pay cleanly).  
2. Build `phases[]`: current phase first, then optional later phases. Expenses must include exact keys used by budget trackers.  
3. Map surplus `allocation` to unlocks (brokerage / liquid / named funds) — conscious monthly saving, not leftover hope.  
4. Tighten `lifeGoals` `current` from live balances where `trackLiveBrokerage` or similar applies.  
5. Flesh `timeline` and `decisions` / next steps from the analysis (what to change this quarter).  
6. Dining routine if they want Month Plan suggestions (Wed/Fri/Sat defaults OK).  
7. `npm run build`, `npm run dev`, open dashboard; fix render errors.

**Success:** Planner / Position / Goals show *their* household; phases and decisions clearly connect goals ↔ real capacity.

---

## Phase 5 — Telegram bot

Skip if not wanted yet.

1. Create a bot with [@BotFather](https://t.me/BotFather); create/join a household group; add the bot.  
2. Write `~\.longterm\telegram.env` (never commit):

```env
TELEGRAM_BOT_TOKEN=<token from BotFather>
TELEGRAM_GROUP_CHAT_ID=<group chat id>
TELEGRAM_BOT_USERNAME=YourBotUsername
ANTHROPIC_API_KEY=<anthropic api key>
```

3. Run `node scripts/telegram-bot-whoami.mjs` or a single poll to verify auth.  
4. Windows: `.\scripts\install-telegram-scheduled-task.ps1` and `.\scripts\install-telegram-recap-scheduled-task.ps1`.  
5. Seed `data/telegram-owners.json` so each Telegram user id maps to an owner id from `goals.owners`.  
6. Do not reuse another household’s offset / conversation logs.

**Success:** A message like “add PT Thursday 10am” creates a schedule or dining plan event as designed.

---

## Phase 6 — Google Calendar (“Family Planner”)

Skip if not wanted yet.

1. Google Cloud project, enable Calendar API, OAuth Desktop client.  
2. Run `node scripts/calendar-auth-setup.mjs` (interactive) **or** follow `claude.md` / `gws` notes.  
3. Save `~\.longterm\google-calendar.env` with client id/secret, refresh token, calendar id, and `GOOGLE_READ_CALENDAR_IDS` for personal calendars to *read* (not work calendars unless they insist).  
4. Confirm `calendar-sync.mjs` runs at the end of the Telegram poll task.  
5. Remind: Google Family Planner is source of truth; Month Plan shows spend kinds `dining` + `family` only.

**Success:** Confirmed dinner appears on Family Planner within ~2 minutes; deleting it in Google removes it from Month Plan on the next sync.

---

## Phase 7 — Handoff checklist

Ask them to confirm:

- [ ] Goals named under the Christensen frame  
- [ ] Monarch pull succeeded (or they explicitly accepted manual-only)  
- [ ] LLM analysis briefing was reviewed and used to set phases  
- [ ] Phases / allocations / decisions reflect real capacity toward unlocks  
- [ ] `npm run dev` dashboard shows their household  
- [ ] Builds run without errors after a goals edit  
- [ ] (If Telegram) Bot answers in the group  
- [ ] (If Calendar) Event round-trips  
- [ ] They understand not to `git add` real `goals`/`accounts`/`budget_tracking`  
- [ ] They can re-open an AI later with: “Read `claude.md` and help me update our plan — keep the How Will You Measure Your Life? frame.”

If something fails, paste the error, fix the file or env, and re-run the relevant command — don’t restart the whole interview.
