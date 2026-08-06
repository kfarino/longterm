# Making Longterm public (or forking it)

Checklist so the **code** can be open without publishing a household’s money.

## Already true if you followed the architecture

- [ ] Real `data/goals.json`, balances, ledger, Telegram state are **gitignored**
- [ ] Secrets live only under `~/.longterm/*.env` (never in the repo)
- [ ] `examples/` is fictional (Teddy & Lilly — safe to commit)
- [ ] `npm run check:secrets` passes on a clean tree
- [ ] CI `no-secrets` job is green on GitHub

## Before you flip the GitHub repo to Public

1. Run locally:
   ```bash
   npm run check:secrets
   git status   # no real data/ files staged
   ```
2. Search history once (optional but calming):
   ```bash
   git log --all --full-history -- data/goals.json data/accounts.json budget_ledger.csv
   ```
   If those paths ever appear in history with real content, rotate credentials and purge history before going public (this repo previously tracked `budget_ledger.csv` with real spend — it is now gitignored and removed from the index; purge history if you need a clean public cut).
3. Skim tracked docs for accidental pastes of account numbers, tokens, or live dollar tables. `claude.md` may name a household — that is identity context, **not** balances; still rewrite “Who we are” on a public fork if you want anonymity.
4. Confirm `LICENSE` (MIT) and `SECURITY.md` are present.
5. Set the GitHub repo to Public.

## What “open source” means here

| Public | Private (your machine) |
|--------|-------------------------|
| Scripts, dashboard HTML, tests, `examples/` | Your `data/*` runtime JSON |
| Design docs under `docs/` | `~/.longterm/` env files + MCP venv |
| MIT license on the software | Your Monarch/Telegram/Calendar tokens |

Forkers: `npm run seed`, edit `examples` → local `data/`, never push their `data/` back upstream.
