# Setup Longterm (for humans)

This repo is **code + fictional examples only**. Your household numbers, to-dos, calendar sync state, and Telegram bot state stay on your machine under `data/` (gitignored) and secrets under `~/.longterm/`.

## Fastest path: let an AI walk you through it

1. Install [Node.js 20+](https://nodejs.org/) and [Git](https://git-scm.com/).
2. Clone this repo and open the folder in [Cursor](https://cursor.com/), Claude Code, or any coding agent that can edit files.
3. Paste this to the AI:

```text
Read docs/setup-with-ai.md and examples/*.example.json.
Walk me through first-time Longterm setup for my household (full stack: dashboard, Monarch, Telegram, Google Calendar).

Order matters:
1. Goals first — use Clayton Christensen’s “How Will You Measure Your Life?” to define what we actually want (career, relationships, integrity) and the big unlocks we’d regret not funding. Call out the trap from the book: the successful person who said they valued more time with kids, but kept choosing more work because checking a task off the list gives a quick dopamine hit. Small decisions add up.
2. Monarch next — wire real balances and spend before inventing detailed phases. Do not guess net worth or budgets when Monarch can tell us.
3. Then analyze — use this chat (local LLM) to review the pulled accounts/transactions and give a clear financial picture: assets, spend pace, surplus capacity, and constraints. That analysis is the context for budgeting and asset decisions.
4. Only then write phases, surplus allocation, and next-step decisions so the plan can actually meet the goals given our real money — conscious saving toward unlocks, not reacting to what’s in front of us.

Ask one question at a time. Write the real data files yourself from my answers. Do not commit my financial data.
```

4. When the AI says the dashboard is ready, run:

```bash
npm run seed
npm run build
npm run dev
```

Open [http://localhost:4200/dashboard_v5.html](http://localhost:4200/dashboard_v5.html).

## What you will need (recommended path)

| Piece | When | What you’ll set up |
|-------|------|--------------------|
| Node + Git | Start | Local tools |
| `npm run seed` | Start | Copies `examples/` → local `data/` |
| Life goals interview | First | Christensen frame → `goals.json` skeleton |
| Monarch Money | Right after goals | `~/.longterm/monarch.env` + account mapping + first pull |
| AI financial analysis | After first pull | Budget/asset context for phases |
| Telegram bot | Later | `~/.longterm/telegram.env` |
| Google Cloud OAuth | Later | `~/.longterm/google-calendar.env` |

You can say **“dashboard only / no Monarch yet”** if you must — the AI will use rough manual numbers — but the default path is **goals → Monarch → analysis → phases**.

## Manual copy (if you are not using an AI)

```bash
npm run seed
# edit data/goals.json, accounts.json, budget_tracking.json
npm run build
npm run dev
```

## Owners (`goals.json` → `owners[]`)

Each adult is an entry in `goals.owners` with a stable `id` (lowercase slug) and `displayName`. The same `id` keys balances in `accounts.json` and personal trackers in `budget_tracking.personal.<id>`. Example household uses `teddy` / `lilly`; you choose your own ids.

## Secrets location

All credentials live outside the repo under `~/.longterm/` (Windows: `%USERPROFILE%\.longterm\`). Never commit `.env` files.
