# Setup Longterm (for humans)

This repo is a household financial planning dashboard plus optional Telegram bot, Monarch money pulls, and Google Calendar sync.

**Your numbers stay local** — `data/goals.json`, `data/accounts.json`, and `data/budget_tracking.json` are gitignored and never pushed.

## Fastest path: let an AI walk you through it

1. Install [Node.js 20+](https://nodejs.org/) and [Git](https://git-scm.com/).
2. Clone this repo and open the folder in [Cursor](https://cursor.com/), Claude Code, ChatGPT with file access, or any coding agent that can edit files.
3. Paste this to the AI:

```text
Read docs/setup-with-ai.md and examples/*.example.json.
Walk me through first-time Longterm setup for my household (full stack: dashboard, Monarch, Telegram, Google Calendar).
Ask one question at a time. Write the real data files yourself from my answers. Do not commit my financial data.
```

4. When the AI says the dashboard is ready, run:

```bash
npm run dev
```

Open [http://localhost:4200/dashboard_v5.html](http://localhost:4200/dashboard_v5.html).

## What you will need (full stack)

| Piece | Required for | What you’ll set up |
|-------|----------------|--------------------|
| Node + Git | Everything | Local tools |
| `data/goals.json` etc. | Dashboard | AI interview fills these from `examples/` |
| Monarch Money account | Auto balances/spend | Email/password in `~\.scrooge\monarch.env` (or path the AI chooses) + account mapping |
| Telegram bot | Chat planning | Bot token + group in `~\.longterm\telegram.env` |
| Google Cloud OAuth | Family Planner calendar | Client + refresh token in `~\.longterm\google-calendar.env` |

You can stop after the dashboard works and add Monarch / Telegram / Calendar later — tell the AI “dashboard only for now.”

## Manual copy (if you are not using an AI)

```bash
cp examples/goals.example.json data/goals.json
cp examples/accounts.example.json data/accounts.json
cp examples/budget_tracking.example.json data/budget_tracking.json
cp examples/month_plan_events.example.json data/month_plan_events.json
cp examples/todos.example.json data/todos.json
node data/build-data.mjs
node data/build-goal-plan-md.mjs
npm run dev
```

Then edit the three JSON files with your real numbers and re-run the two `node data/build-*.mjs` commands.

## Owners (`goals.json` → `owners[]`)

Each adult is an entry in `goals.owners` with a stable `id` (lowercase slug) and `displayName`. The same `id` keys balances in `accounts.json` and personal trackers in `budget_tracking.personal.<id>`. Example household uses `teddy` / `lilly`; you choose your own ids.
