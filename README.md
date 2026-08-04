# Longterm

Household financial planning system: a dashboard, optional Telegram bot, and automation that can sync accounts/budget from Monarch and plans to Google Calendar.

## New here? Start with setup

→ **[SETUP.md](./SETUP.md)** — clone the repo, then paste one prompt into Cursor / Claude / Grok so an AI can interview you and fill in the local data files.

Example schemas live in **`examples/`** (fictional household). The AI playbook is **`docs/setup-with-ai.md`**.

## This repo is code only

**No personal financial data is committed here.** The following files exist locally on the machine that runs this project but are intentionally excluded from git (see `.gitignore`):

- `data/accounts.json` — real net worth (retirement, brokerage, cash, home equity)
- `data/budget_tracking.json` — real spend tracking (joint card, personal card, travel)
- `data/goals.json` — real income, expenses, savings goals, and planning assumptions
- `data/data.js` — generated bundle of the three files above, loaded by the dashboard
- `kevin_hanna_goal_plan.md` — generated narrative view of the same data

These are the files every script in this project reads and writes at runtime — the bot, the dashboard, and the scheduled Monarch pulls all depend on them existing locally, but none of that is a git dependency. The system runs entirely off local files; git/GitHub here is just a backup of the code and tooling, not part of the running system. A fresh clone needs those files created locally (copy from `examples/` or let an AI walk you through [SETUP.md](./SETUP.md)).

## What's actually in the repo

- `examples/` — starter JSON for a new household (safe to commit; fictional numbers).
- `scripts/` — the Telegram bot (polling, tools, weekly recap), the dashboard's local API server, Google Calendar sync/read, dining recommendations, and scheduled-task installers.
- `data/*.mjs` — the test suites for all of the above (no real data in these, just fixtures).
- `data/build-data.mjs` / `build-goal-plan-md.mjs` — regenerate `data.js` / the goal-plan doc from the 3 real data files after an edit.
- `dashboard_v5.html` — the dashboard itself, a pure renderer with no figures of its own.
- `docs/superpowers/specs/` — design docs for how each part of this system came to be built the way it is.
- `claude.md` — full project context and conventions for an AI assistant working in this repo.

## Runtime state that *is* committed

A handful of `.jsonl`/`.json` files track bot/automation state (Telegram offset, sender ownership, conversation history, recap dedup log, etc.). These aren't financial data — just bookkeeping for the bot's own operation — so they're committed for continuity/debugging, unlike the 5 files above. On a **new** household, replace `month_plan_events.json` / `todos.json` from `examples/` so you don't inherit another family's plan.
