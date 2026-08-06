# Architecture learnings: nssharpe/finance-dashboard vs Longterm

*Branch: `research/nssharpe-finance-dashboard-arch`. Reviewed 2026-08-06 against [nssharpe/finance-dashboard](https://github.com/nssharpe/finance-dashboard) (clone inspected locally). Kevin asked for best options, not mandatory changes.*

**Naming note:** the bank feed is **SimpleFIN Bridge** (protocol + paid bridge at ~$1.50/mo), not “SimplBridge.”

## What each project optimizes for

| | **nssharpe/finance-dashboard** | **Longterm** |
|--|--------------------------------|--------------|
| Core job | Local **transaction ledger + spend analysis** | Household **planning, budget pace, ops** (goals, phases, Telegram, calendar, dining) |
| Money SoT | Local SQLite (`finance.db`) | Monarch (live) + JSON mirrors (`accounts.json`, `budget_tracking.json`) + hand `goals.json` |
| Bank path | SimpleFIN Bridge → upsert | Monarch MCP → mapped field overwrite / tracker rebuild |
| Planning | Almost none (net worth + YoY insights) | Rich (phases, decisions, travel, owners) |
| Multi-writer | You + Refresh | You + daily pulls + Telegram bot + calendar sync |

They are complementary, not substitutes. The transferable ideas are mostly about **how to store and protect mutable money facts**, not about replacing Longterm’s planning layer.

## Decisions worth stealing (ranked)

### 1. Explicit raw → derived → override layers (highest leverage)

His schema keeps:

- `raw_description` / `base_category` — import-time originals  
- `description` / `category` — live display (merchant rules may rewrite)  
- `category_overrides` / `description_overrides` + flags — survive refresh  

Re-sync **never clobbers** human judgment; deleting a merchant rule can restore originals without re-running ambiguous categorize logic.

**Longterm today:** Monarch pull rebuilds trackers wholesale; one-offs live in code (`TRACKER_REASSIGNMENTS`). Manual account fields are safer (`source: manual`), but spend/travel exceptions are fragile.

**Best option:** adopt the *pattern* even without SQLite — e.g. a small `overrides.json` (or table) keyed by stable txn id / merchant+date, applied after every pull. Same idea for travel trip assignment once unmatched charges grow.

### 2. Stable idempotent transaction identity

SimpleFIN native ids as PRIMARY KEY; statement imports use content hash (`syn_` + SHA1) with salt for same-day duplicates. Overlapping sync windows are safe.

**Longterm today:** trackers are aggregated weeks + recent line items regenerated from Monarch; less of a durable ledger.

**Best option:** if you ever want “search this charge forever / override forever,” persist Monarch transaction ids in a local ledger (SQLite or JSONL) rather than only cycle buckets. You already have `search_transactions` — a ledger makes overrides and history durable.

### 3. Local queryable store + HTTP API (vs `data.js` + ad-hoc files)

He runs FastAPI on `127.0.0.1`, SQLite with WAL, vanilla JS `fetch('/api/...')`. Analysis endpoints are SQL. Agents can query one file.

**Longterm today:** many JSON files; `data.js` for file://; `dashboard-server.mjs` already for live Month Plan / ratings — halfway there.

**Best option:** keep JSON for *planning* documents (`goals.json` stays human-editable). Consider SQLite (or expand the local API) for *high-churn transactional* data: transactions, overrides, balance snapshots. Don’t force phases/decisions into SQL unless you want migration pain for bot edits.

### 4. Layered deterministic categorization

1. Generic regex (`rules.py`)  
2. Personal regex gitignored (`rules_local.py`)  
3. DB merchant rules (UI)  
4. Per-txn override  

No LLM drift on categories. Spec warns that statement-import precedence differs from live categorize — documented footgun.

**Longterm today:** trusts Monarch categories (+ travel routing + reassignments).

**Best option:** only worth building if Monarch categories fight you often. Merchant-rule UX (fix once → apply to all past/future) is the part worth copying if you do.

### 5. Privacy / agent discipline as architecture

`AGENTS.md`: never commit/quote real txns; invent fixtures; access URL is bearer; `no-secrets` CI; tests pass on fresh clone.

**Longterm today:** strong `.gitignore` + examples seed; CLAUDE.md privacy notes. Less formal “silent failures” list.

**Best option:** add an `AGENTS.md` (or tighten CLAUDE.md) with a **silent failures** section (travel ambiguity, two Monarch id schemes, don’t hand-edit `budget_tracking`, refresh token single-use for Oura, etc.) and “invent merchants in tests.”

### 6. Balance snapshots + reconstructed history

Daily `balance_snapshots`; cash/credit series walked backward from current balance + txns; investments use snapshots.

**Longterm today:** point-in-time net worth from Monarch accounts; weaker historical NW curve unless Monarch/history is pulled separately.

**Best option:** if NW-over-time matters on the dashboard, snapshot `accounts.json` totals daily into a small time series (JSONL or SQLite) — cheap win without SimpleFIN.

### 7. SimpleFIN Bridge as an alternate bank feed

Read-only aggregator, claim setup token → access URL, ~90-day windows, client requests 2y first then ~120d overlap.

**vs Monarch:** you already pay complexity/integration cost for Monarch (budget categories, holdings, Travel & Vacation). SimpleFIN is simpler protocol, weaker “product” intelligence, another subscription.

**Best option:** **stay on Monarch** unless you want to leave Monarch or need a second feed for accounts Monarch botches. Architectural lesson is “pull into *your* store,” which you already do — his store is just thicker.

## What not to copy blindly

- **Replacing Longterm with a pure ledger app** — you’d lose goals/phases/Telegram/calendar/dining, which is most of the product.  
- **Full rewrite to Python/FastAPI** — sustainability for *him* (one language, one DB); for you, Node + JSON already matches the bot/dashboard stack. SQLite via `better-sqlite3` would fit without a language switch.  
- **Putting `goals.json` into SQLite first** — planning docs benefit from hand-edit + bot JSON patch + changelog; relational schema is overhead until query pain is real.  
- **His dual categorize precedence** — don’t invent two conflicting category pipelines.  
- **Ceremony-free schema version** — if you adopt SQLite, prefer numbered migrations from day one.

## Recommended option set (if picking a short list)

1. **Override layer that survives pulls** (pattern #1) — highest ROI for Longterm as it exists.  
2. **`AGENTS.md` silent-failures + privacy checklist** (#5) — cheap, prevents agent damage.  
3. **Daily net-worth snapshot file** (#6) — if you want charts like his.  
4. **Optional SQLite ledger for transactions only** (#2–3) — when JSON cycle views aren’t enough for search/overrides/history.  
5. **Skip SimpleFIN** unless Monarch is the bottleneck.

## Sources

- Repo: https://github.com/nssharpe/finance-dashboard  
- Local clone inspected: `%TEMP%\finance-dashboard-nssharpe` (`README.md`, `AGENTS.md`, `app/db.py`, `app/simplefin.py`, `app/main.py`, merchant rules design under `docs/superpowers/specs/`)  
- Longterm current architecture: main-tree `CLAUDE.md`, `data/`, `scripts/*-pull.mjs`, `dashboard-server.mjs`
