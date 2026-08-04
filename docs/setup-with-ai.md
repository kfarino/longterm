# First-time Longterm setup — playbook for the AI

You are helping someone set up **Longterm** (household finance dashboard + optional Monarch pulls, Telegram bot, Google Calendar) on their machine.

**Rules**
- Ask **one question at a time**. Wait for the answer before the next.
- Prefer writing files yourself over dumping large JSON for the human to paste.
- Never commit `data/goals.json`, `data/accounts.json`, `data/budget_tracking.json`, `data/data.js`, goal-plan markdown, todos, month-plan events, Telegram state, or favorites (they are gitignored — household-local only).
- Start from `examples/*.example.json` via `npm run seed` — fictional Teddy & Lilly — then replace with this household’s facts.
- Owners are configurable: `goals.json` has `"owners": [{ "id", "displayName" }, ...]`. Use those same `id` values under `accounts.json` balances and `budget_tracking.personal.<id>` / `mapping.personalAccountLabels.<id>`. Do not hardcode person names in code.
- Secrets and tools live under `~/.longterm/` (not under a hardcoded username path): `monarch.env`, `telegram.env`, `google-calendar.env`, and `monarch-mcp-venv`.
- After any edit to goals/accounts/budget JSON, run:
  - `npm run build` (or `node data/build-data.mjs` + `node data/build-goal-plan-md.mjs`)
- Confirm each major milestone (“Dashboard loads with your names”) before moving on.

---

## Phase 0 — Environment

1. Confirm the workspace root is the Longterm repo (`package.json` name `longterm-dashboard`).
2. Confirm `node -v` is 18+ (prefer 20+).
3. Ask: Windows, Mac, or Linux? (Scheduled-task installers are PowerShell/Windows-oriented; on Mac/Linux, skip Windows task registration and run scripts manually or via cron.)

---

## Phase 1 — Dashboard data (required)

### 1A. Seed local data files

```bash
npm run seed
```

This copies `examples/*.example.json` into `data/` and creates empty Telegram/calendar stubs. It **never overwrites** files that already exist (safe on a machine that already has a household). On Windows PowerShell the same command works.

Do **not** hand-copy Kevin/Hanna runtime leftovers — a clean clone has none.

### 1B. Interview (one at a time)

Collect enough to fill the three JSON files:

1. Household display name and city/region  
2. Owner ids + display names for each adult (e.g. `teddy`/`Teddy`, `lilly`/`Lilly`) and one-line bios under `family.profile.<id>`  
3. Today’s monthly take-home (or pre-tax → convert roughly) per person  
4. Major monthly expenses (housing, shared “Family budget”, personal allowances). **One expense key must be exactly** whatever `budget_tracking.joint.targetExpenseKey` is (default `"Family budget"`). Each personal tracker’s `targetExpenseKey` must match a phase-1 expense label too.  
5. How many life phases they want for now (minimum 1 current + optional later). For each phase: name, rough years, income, expenses, and where surplus goes (`allocation` with buckets `brokerage` | `liquid` | similar).  
6. One or two savings goals (name, target $, year, optional `current`)  
7. Rough net worth: retirement / brokerage / cash / home equity per owner id (all `source: "manual"` for now)  
8. Budget cycle: `cycleStart` (YYYY-MM-DD) and `cycleDays`; optional sample week totals if they know recent spend  
9. Dining routine: keep example Wed/Fri/Sat or change `dayOfWeek` (0=Sun … 6=Sat)

### 1C. Write files + build

- Edit `data/goals.json`, `data/accounts.json`, `data/budget_tracking.json` to match answers.
- Keep JSON valid. Preserve structure from the examples.
- Run both build scripts.
- Start `npm run dev` and have them open `http://localhost:4200/dashboard_v5.html`.
- Fix any console/render errors before Phase 2.

**Success:** Budget / Position / Goals tabs show *their* names and numbers, not Teddy & Lilly.

---

## Phase 2 — Monarch (auto balances + spend)

Skip if they say dashboard-only.

1. They need a [Monarch Money](https://www.monarchmoney.com/) account with bank/brokerage linked.
2. Create credentials file (do **not** commit it):

`~/.longterm/monarch.env` (Windows: `%USERPROFILE%\.longterm\monarch.env`)

Suggested contents:

```env
MONARCH_EMAIL=their@email.com
MONARCH_PASSWORD=their-password
```

3. Defaults already resolve via `scripts/longterm-paths.mjs` to `~/.longterm/…`. Override with `--monarch-env-file` / `--mcp-server-exe` only if needed.
4. Install the Monarch MCP venv: Python 3.12 venv at `~/.longterm/monarch-mcp-venv`, `pip install monarch-mcp-jamiew==0.4.0`.
5. Run a dry diagnostic: call `get_accounts` via the pull tooling or a one-off script; list account ids/labels.
6. Fill `data/accounts.json` → `mapping.accounts` with `{ monarchId, label, target }` paths.
7. Fill `data/budget_tracking.json` → `mapping.jointAccountLabels` / `mapping.personalAccountLabels.<ownerId>` with **exact** Monarch transaction account display names.
8. Set tracker `source` fields to `"monarch"` once mapping works.
9. Run `node scripts/networth-pull.mjs` and `node scripts/budget-tracking-pull.mjs` (or the `.ps1` wrappers). Confirm `data.js` regenerated.
10. On Windows, from `scripts/`: `.\install-scheduled-task.ps1` for the daily 03:00 pull.

**Success:** Position tab balances update from Monarch; Budget joint/personal weeks refill without hand-editing.

---

## Phase 3 — Telegram bot

Skip if not wanted yet.

1. Create a bot with [@BotFather](https://t.me/BotFather); create/join a household group; add the bot.
2. Write `~\.longterm\telegram.env` (never commit):

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_GROUP_CHAT_ID=...
TELEGRAM_BOT_USERNAME=YourBotUsername
ANTHROPIC_API_KEY=...
```

(Exact keys read by `scripts/telegram-bot-poll.mjs` — keep this list in sync if the poller gains more env vars.)

3. Run `node scripts/telegram-bot-whoami.mjs` or a single poll to verify auth.
4. Windows: `.\scripts\install-telegram-scheduled-task.ps1` and `.\scripts\install-telegram-recap-scheduled-task.ps1`.
5. Seed `data/telegram-owners.json` (from `npm run seed` it’s `{}`) so each Telegram user id maps to an owner id from `goals.owners` — run `node scripts/telegram-bot-whoami.mjs` after each adult messages the group.
6. Do not reuse another household’s `telegram-offset.json` / conversation logs; seed creates empty stubs.

**Success:** A message in the group like “add PT Thursday 10am” creates a `schedule` or dining plan event as designed.

---

## Phase 4 — Google Calendar (“Family Planner”)

Skip if not wanted yet.

1. Google Cloud project, enable Calendar API, OAuth Desktop client.
2. Run `node scripts/calendar-auth-setup.mjs` (interactive) **or** follow its header comments / `gws` flow documented in `claude.md`.
3. Save `~\.longterm\google-calendar.env` with client id/secret, refresh token, calendar id, and `GOOGLE_READ_CALENDAR_IDS` for personal calendars to *read* (never a work calendar unless they insist).
4. Confirm `calendar-sync.mjs` runs at the end of the Telegram poll task (already wired on Windows once Telegram poll is installed).
5. Remind: Google Family Planner is source of truth for synced events; Month Plan dashboard shows only `dining` + `family` (spend), not `schedule`.

**Success:** A confirmed dinner appears on Family Planner within ~2 minutes; deleting it in Google removes it from the Month Plan on the next sync.

---

## Phase 5 — Handoff checklist

Ask them to confirm:

- [ ] `npm run dev` dashboard shows their household  
- [ ] Builds run without errors after a goals edit  
- [ ] (If Monarch) Pull scripts succeed once  
- [ ] (If Telegram) Bot answers in the group  
- [ ] (If Calendar) Event round-trips  
- [ ] They understand not to `git add` real `goals`/`accounts`/`budget_tracking`  
- [ ] They can re-open an AI later with: “Read `claude.md` and help me update our plan.”

If something fails, paste the error, fix the file or env, and re-run the relevant command — don’t restart the whole interview.
