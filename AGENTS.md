# AGENTS.md

Briefing for coding agents (and humans) working in this repo.

Read this **before** editing money, sync, or bot code. Most of the odd-looking
rules below are load-bearing — each one already bit us once.

Household product context (who Kevin/Hanna are, architecture overview) lives in
`claude.md`. This file is the **privacy + footgun** layer.

---

## 0. Hard rule: real finances never leave the machine

This checkout sits next to a real family's balances, transactions, calendars,
and Telegram history.

Reading and analyzing that data **locally** is fine — that is what Longterm is
for. The rule is about **what escapes**: nothing derived from real household
data may end up in a commit, PR, issue, design doc, test fixture, commit
message, or any message sent off this machine.

### Never commit, publish, or quote outside the local session

These are gitignored. **Do not add exceptions. Do not `git add -f` them.**

| Path / secret | Why |
|---------------|-----|
| `data/goals.json`, `accounts.json`, `budget_tracking.json` | Live plan + balances + cycle spend |
| `data/transactions_ledger.json` | Accumulating Monarch line items (when ledger feature is enabled) |
| `data/transaction_overrides.json` | Personal routing rules (when overrides file is in use) |
| `data/data.js`, `kevin_hanna_goal_plan.md` | Generated views of real numbers |
| `data/todos.json`, `month_plan_events.json`, `reminders.json` | Family ops |
| `data/favorite_places*.json`, `venues_to_follow.json` | Dining/venue habits |
| `data/telegram-*.json(l)`, `goals-changelog.jsonl` | Chat + bot audit trails |
| `budget_ledger.csv` / any bank CSV/XLSX/PDF | Raw statements |
| `~/.longterm/monarch.env`, `telegram.env`, `google-calendar.env`, `oura-*.env`, `spotify-*.env` | **Bearer credentials** — never print, never paste into logs/commits/issues even "just for debugging" |

If you need example data: invent merchants, amounts, and names. Use
`examples/*.example.json` and `npm run seed`. Never copy a real transaction
description out of the ledger — real descriptions contain names, cities, and
partial account numbers.

**Before every commit:** run `git status` and actually read it. If a real
`data/*.json` or `.env` appears staged, unstage it.

---

## 1. What to edit vs what to regenerate

| Want to change… | Edit | Never hand-edit |
|-----------------|------|-----------------|
| Phases, decisions, travel plans, targets | `goals.json` → then `npm run build` | `data.js`, `kevin_hanna_goal_plan.md` |
| Manual balances (unmapped) | `accounts.json` field with `source: "manual"` | Mapped `monarch` amount fields (pull overwrites) |
| Spend routing / category fixes | `transaction_overrides.json` (or Telegram override tools) | `budget_tracking.json`, ledger rows as a "fix" |
| Restaurant list SoT | `favorite_places_raw.json` | Derived `favorite_places.json` |
| Dashboard HTML structure | `dashboard_v5.html` (no live figures) | Embedding dollar amounts in HTML |

After `goals.json` / `accounts.json` edits: `node data/build-data.mjs` and
`node data/build-goal-plan-md.mjs` (or `npm run build`). Bot tools that write
goals already regenerate.

---

## 2. Silent failures — things that look fine and are wrong

These usually do **not** throw. They produce a wrong number or a wrong trip
attribution. Every one has happened (or was one mistake away).

### Two Monarch id schemes
- `accounts.json` mapping → **numeric** ids from `get_accounts`
- `budget_tracking.json` mapping → **display-name labels** from `get_transactions` (e.g. `"CREDIT CARD (...3939)"`)

Do not mix them. Adding Hanna's cards means new mapping entries in the right
file — usually no code change.

### Current-cycle view vs accumulating ledger
- `budget_tracking.json` is **fully rebuilt** each pull for the **current**
  joint/personal/travel windows. Hand-edits there die on the next morning pull.
- When `transactions_ledger.json` exists, it **accumulates** (upsert by Monarch
  id). Prefer that for history search; do not treat the cycle JSON as a ledger.
- Durable spend fixes belong in `transaction_overrides.json` (or Telegram
  override tools) — not hard-coded lists in pull scripts, and not hand-edits to
  regenerated tracker files.

### Travel trip matching
Travel & Vacation charges match `goals.travel` by stay dates + 300-day
lookback — **except** `budgetedAmount: null` (settled trips) get **no**
lookback. Ambiguous or unmatched → `travel.unmatched` (ask a human). Never
guess a trip.

### Refunds vs payments
Joint refunds are positive amounts that are **not** the card's own "Credit
Card Payment" category and **not** travel. Sign/filter bugs silently inflate
or hide spend — see `detectJointRefunds` tests.

### File:// and dual math
Dashboard may load `data.js` via script tag; live Month Plan / ratings use
`dashboard-server.mjs`. `financial-context.mjs` deliberately duplicates
dashboard pacing math — change one, update the other (or tests will lie).

### Secrets and Windows
Monarch MCP runs from `~/.longterm/monarch-mcp-venv` (signed Python), **not**
`uvx` (Smart App Control blocks unsigned uv). Do not "simplify" back to uvx.

Oura refresh tokens are **single-use** — always persist the new refresh token
after a refresh or the next pull breaks.

### Telegram / Calendar
- Hanna's calendar is readable via Kevin's OAuth (`GOOGLE_READ_CALENDAR_IDS`) —
  never tell her the bot lacks access to her schedule.
- Kevin's **work** calendar is deliberately excluded.
- Dining: `set_dinner_plan` only on explicit confirm; questions → `get_dining_plan`.
- Direct `goals.json` edits by the bot are real and immediate — never invent a
  "pending review" step that doesn't exist.

---

## 3. Tests and fixtures

- Tests must pass without real `data/goals.json` / ledger / `.env` files.
- Fixture merchants: invent ("Test Bistro", "Geico" as a fake label is fine in
  existing tests — do not paste live Monarch descriptions).
- Prefer temp dirs (`os.tmpdir()`) over writing into `data/`.
- Point bot tests at a **nonexistent** ledger path when exercising
  `budget_tracking` fallback (see `test-telegram-bot.mjs`), so a developer's
  real ledger does not leak into assertions.

---

## 4. Quick commands

```bash
npm run seed          # examples → data/ (never overwrites existing)
npm run build         # data.js + goal-plan md
npm run dev           # dashboard-server on 127.0.0.1
node scripts/budget-tracking-pull.mjs
node scripts/networth-pull.mjs
node data/test-telegram-bot.mjs
node data/test-budget-tracking-pull.mjs
# plus other data/test-*.mjs suites as present
```

Scheduled Monarch pull: Windows task `LongtermDailyPull` (~09:30).

---

## 5. When unsure

1. Prefer asking Kevin/Hanna over guessing a trip, owner, or dollar amount.
2. Prefer durable overrides / `goals.json` over patching a regenerated file.
3. Prefer inventing fixture data over copying production.
4. If a change would make real balances or txns appear in git history, stop.

---

## License

Code in this repository is MIT-licensed — see [`LICENSE`](./LICENSE). That covers
**software and docs**, not private household data (which must stay local per §0).
