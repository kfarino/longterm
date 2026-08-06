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
2. History purge (done 2026-08-06 on `kfarino/longterm`):
   Rewrote all branches with `git filter-repo` to drop:
   - root household files (`budget_ledger.csv`, todos, month plan, Telegram state, favorites, …)
   - the nested `Finances/` tree (old monorepo snapshot: statements, CSVs, live goals/accounts)
   - `Nikola/` PDFs
   Pre-purge mirror + working-copy snapshot: `~/.longterm/history-purge-2026-08-06/`.
   Re-check anytime:
   ```bash
   git rev-list --objects --all | findstr /i "budget_ledger accounts.json goals.json CreditCard TRANSACTIONS Finances/ Nikola/"
   ```
   Note: GitHub may keep unreachable blobs until their GC; if this repo was ever public or cloned by others, treat old SHAs as potentially still out there.
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
