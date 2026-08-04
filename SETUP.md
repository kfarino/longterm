# Setup Longterm (for humans)

This repo is **code + fictional examples only**. Your household numbers, to-dos, calendar sync state, and Telegram bot state stay on your machine under `data/` (gitignored) and secrets under `~/.longterm/`.

## Fastest path: let an AI walk you through it

1. Install [Node.js 20+](https://nodejs.org/) and [Git](https://git-scm.com/).
2. Clone this repo and open the folder in [Cursor](https://cursor.com/), Claude Code, or any coding agent that can edit files.
3. Paste this to the AI:

```text
Read docs/setup-with-ai.md and examples/*.example.json.
Walk me through first-time Longterm setup for my household (full stack: dashboard, Monarch, Telegram, Google Calendar).
Ask one question at a time. Write the real data files yourself from my answers. Do not commit my financial data.
```

4. When the AI says the dashboard is ready, run:

```bash
npm run seed
npm run build
npm run dev
```

Open [http://localhost:4200/dashboard_v5.html](http://localhost:4200/dashboard_v5.html).

## What you will need (full stack)

| Piece | Required for | What you’ll set up |
|-------|----------------|--------------------|
| Node + Git | Everything | Local tools |
| `npm run seed` | Dashboard | Copies `examples/` → local `data/` (skips files that already exist) |
| Monarch Money | Auto balances/spend | `~/.longterm/monarch.env` + account mapping |
| Telegram bot | Chat planning | `~/.longterm/telegram.env` |
| Google Cloud OAuth | Family Planner calendar | `~/.longterm/google-calendar.env` |

You can stop after the dashboard works and add Monarch / Telegram / Calendar later — tell the AI “dashboard only for now.”

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
