# Transaction ledger + durable overrides

*Branch: `feature/transaction-ledger-overrides`. Approved 2026-08-06 — accumulate Monarch transactions locally; survive human routing/category fixes across daily pulls.*

## Goal

1. **Accumulate** spend/refund facts in `data/transactions_ledger.json` (upsert by Monarch id; never drop rows outside the fetch window).
2. **Durable overrides** in `data/transaction_overrides.json` (category rules + one-off tracker reassignments) applied on every pull — replaces hard-coded lists in `budget-tracking-pull.mjs`.
3. **Telegram `search_transactions`** reads the ledger (with optional date range), falling back to current-cycle `budget_tracking.json` if the ledger is empty.

## Non-goals

- SQLite / FastAPI rewrite  
- Changing how `budget_tracking.json` cycle *views* are built (still regenerated each pull)  
- Bot UI to edit overrides — **done**: Telegram tools `list_spend_overrides`, `add_tracker_reassignment`, `add_category_rule` (patches ledger for immediate search; cycle totals on next pull)

## Files

| Path | Role |
|------|------|
| `data/transactions_ledger.json` | `{ meta, byId: { [monarchId]: row } }` — gitignored |
| `data/transaction_overrides.json` | categoryRules + reassignments — gitignored; seeded from example |
| `examples/transaction_overrides.example.json` | Committed starter (migrated household rules) |
| `scripts/transactions-store.mjs` | load/upsert/query + apply overrides |

## Pull behavior

- Fetch window: `min(jointCycleStart, personalMonthStart, today − 120 days)` → today (overlap so late posts refresh).
- Upsert every processed spend/refund into the ledger with routed `tracker` / `ownerId` / `tripId` / category-after-override.
- Rebuild `budget_tracking.json` as today, using overrides from the JSON file.

## Search

- Prefer ledger; optional `startDate` / `endDate` (default: last 90 days of ledger).
- Fallback: existing current-cycle flatten from `budget_tracking.json`.
