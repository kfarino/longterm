# Security Policy

## What this project stores

Longterm is a **local-first** household planner. Real balances, transactions,
Telegram history, and OAuth tokens live on the machine that runs it — not in
this git repository.

- **In git (public-safe):** code, fictional `examples/`, docs, tests with invented fixtures.
- **Never in git:** `data/goals.json`, `accounts.json`, `budget_tracking.json`, ledger/overrides, Telegram state, generated `data.js` / goal-plan markdown, bank CSV/PDF exports, anything under `~/.longterm/*.env`.

See [`AGENTS.md`](./AGENTS.md) §0 and [`.gitignore`](./.gitignore).

## Reporting a vulnerability

If you find a way that **secrets or personal financial data could leak into git,
logs, or a public surface**, please email the maintainer privately (see the
GitHub profile for this repo) rather than opening a public issue with sample
payloads.

Please include:

- What escaped (or could escape)
- Steps to reproduce
- Whether any real credential may already have been exposed (so it can be rotated)

## Maintainer checklist after a scare

1. Rotate Monarch / Telegram / Google / Oura / Spotify credentials if they may have leaked.
2. Purge the secret from git history if it was ever committed (`git filter-repo` / BFG) — rotating alone is not enough if history is public.
3. Confirm `.gitignore` still covers the path; extend `scripts/check-no-secrets.mjs` if needed.
