# Longterm

Household financial planning system: a dashboard, optional Telegram bot, and automation that can sync accounts/budget from Monarch and plans to Google Calendar.

**License:** [MIT](./LICENSE) · **Agents:** [AGENTS.md](./AGENTS.md) · **Security:** [SECURITY.md](./SECURITY.md) · **Publishing:** [docs/publishing.md](./docs/publishing.md)

## New here? Start with setup

→ **[SETUP.md](./SETUP.md)** — clone the repo, then paste one prompt into Cursor / Claude / Grok so an AI can interview you and fill in the local data files.

```bash
npm run seed           # examples → data/ (never overwrites existing local files)
npm run build          # regenerate data.js + goal-plan markdown
npm run dev            # http://localhost:4200/dashboard_v5.html
npm run check:secrets  # fail if household data/secrets are tracked in git
```

Example schemas live in **`examples/`** (fictional household). The AI playbook is **`docs/setup-with-ai.md`**.

## This repo is code only (safe to make public)

**No personal financial or household runtime data is committed.** Local-only files (see `.gitignore`):

- `data/goals.json`, `accounts.json`, `budget_tracking.json` — your plan and balances
- `data/transactions_ledger.json`, `transaction_overrides.json` — spend history + durable routing (when enabled)
- `data/data.js` / `*-goal_plan.md` — generated views
- `data/todos.json`, `month_plan_events.json`, favorites, calendar sync state
- `data/telegram-*.json(l)` — bot bookkeeping

A fresh clone has none of those until you run `npm run seed` (or an AI writes them). Secrets stay in `~/.longterm/` (telegram / google-calendar / monarch env + MCP venv).

Before flipping a GitHub repo to **Public**, follow **[docs/publishing.md](./docs/publishing.md)** and keep CI’s `check:secrets` job green.

## What's actually in the repo

- `examples/` — starter JSON for a new household (safe to commit; fictional numbers).
- `scripts/` — bot, dashboard server, Monarch pulls, Calendar sync, `seed-from-examples.mjs`, `check-no-secrets.mjs`, scheduled-task installers.
- `data/*.mjs` — test suites and build scripts (fixtures only; no real household data).
- `dashboard_v5.html` — pure renderer.
- `docs/` — design specs, setup playbook, publishing checklist.
- `claude.md` — project context for an AI assistant (household identity template — **no dollar figures**).
- `AGENTS.md` — privacy rules + silent-failure footguns for coding agents.
- `LICENSE` — MIT.
