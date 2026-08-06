# Oura health signal — accumulating store, depletion rule, recap wiring

*Branch: `feature/oura-health-signal` (off `feature/oura-api-sketch`). Approved 2026-08-06 — turn the Oura connect sketch into a durable pull, derive a "depleted this week" signal, and let it shape weekend dining suggestions in the Thursday recap.*

> **No real household data in this document.** Every figure below is illustrative
> (invented), per `AGENTS.md` §0. Real scores/dates stay on the machine.

## Goal

1. **Accumulate** all Oura data in `data/oura/<endpoint>.json` (upsert by record id; never drop rows outside the fetch window).
2. **Durable overrides** in `data/health_overrides.json` — excluded nights + baseline adjustments applied on every read, so a known-bad week (travel, illness, ring off the finger) can't silently cancel a night out.
3. **Depletion rule** in `scripts/health-context.mjs`, tunable from `goals.json`, comparing each person to *their own* rolling baseline.
4. **Thursday recap** reports the week and swaps Fri/Sat dining suggestions to low-key when someone is depleted. **Sunday** reports only.
5. **`get_health_status`** Telegram tool — ask about sleep any day, any range.

## Non-goals

- Health on the dashboard. Nothing renders it, so no generated `health_tracking.json`. If it lands later it gets a `dashboard-server.mjs` `/api/` route, not a build step — the dashboard is served over `http://localhost` now (`dashboard-server.mjs` replaced the old `file://` launch; `claude.md` still describes the old constraint and is stale on this point).
- Proactive daily pings. Depletion surfaces on the recap's existing cadence only.
- Per-day Month Plan reactivity. Oura only knows nights that already happened; the dashboard renders a month forward. Thursday sits adjacent to the days it affects, which is the whole reason the signal is honest there.
- Correlating health against phases/decisions. Separate question, separate cadence.

## Files

| Path | Role |
|------|------|
| `data/oura/<endpoint>.json` | `{ meta, byId: { [id]: row } }` per endpoint — gitignored (`data/oura/*`) |
| `data/health_overrides.json` | `excludedNights` + `baselineRules` — gitignored; seeded from example |
| `examples/health_overrides.example.json` | Committed starter with invented entries |
| `scripts/oura-store.mjs` | load / upsert / query, mirroring `transactions-store.mjs` |
| `scripts/oura-pull.mjs` | **rewritten** from sample-sketch to durable pull |
| `scripts/health-context.mjs` | read-only derivation, mirroring `financial-context.mjs` |
| `scripts/oura-client.mjs`, `oura-auth-setup.mjs` | unchanged from the sketch branch |

## Pull behavior

Rewrites the sketch's snapshot-overwrite (`data/oura/<owner>-latest.json`, 7 endpoints) into a durable pull over **all 15 endpoints**: `daily_sleep`, `daily_readiness`, `daily_activity`, `daily_stress`, `daily_resilience`, `daily_spo2`, `daily_cardiovascular_age`, `vO2_max`, `sleep`, `sleep_time`, `workout`, `session`, `enhanced_tag`, `rest_mode_period`, `heartrate`.

- Window: `today − OURA_OVERLAP_DAYS (30)` → today. `--backfill-days N` for a one-off deep pull, mirroring `budget-tracking-pull.mjs --history-backfill-days`.
- Upsert by id; rows outside the window are never dropped.
- **Sharded by endpoint** — the one deviation from `transactions-store.mjs`'s single flat file. Measured across all 15 endpoints for two people, full fidelity runs ~10 MB/year, concentrated in `daily_activity` (per-minute MET arrays), `sleep` (5-min phase/HRV arrays) and `heartrate`. One blob would be re-parsed and rewritten every morning and would grow past 30 MB within a few years; sharding keeps the small collections small and drops nothing. Identical `meta` + `byId` + merge semantics per file.

Row shape keeps Oura's record nested rather than spread, so a record field can never shadow ours:

```json
{ "id": "<owner>:daily_sleep:<record-uuid>", "ownerId": "<owner>",
  "endpoint": "daily_sleep", "day": "2026-01-15",
  "data": { }, "updatedAt": "2026-01-15" }
```

Three id cases, mirroring `transactionId()`'s synthetic fallback:

| Case | Id |
|------|-----|
| Normal dated record | `<owner>:<endpoint>:<record.id>` |
| `heartrate` — no per-record id, and takes `start_datetime`/`end_datetime` rather than `start_date`/`end_date` | `<owner>:heartrate:<timestamp>` |
| Singletons (`personal_info`, `ring_configuration`) | `<owner>:<endpoint>` — current state, not history |

Upsert matters here beyond surviving daily pulls: **Oura revises a day's scores as more data lands**, so a night first scored in the 70s can read differently a day later. Merge-by-id records the correction; snapshot-overwrite would replace it silently and append would double-count it.

An endpoint returning zero rows is recorded as empty, not as an error — a newly set-up ring returns nothing for `daily_activity`, `sleep` and `heartrate` for days, and Oura needs ~2 weeks before readiness contributors (`hrv_balance`, `sleep_balance`, `activity_balance`) stop coming back `null`.

Wired into `run-daily-pull.ps1` as a third step with the same retry + log treatment. **An Oura failure never fails the net-worth or budget pulls** — the containment rule `calendar-sync.mjs` already follows inside the poll task.

## Overrides

Seeded from the example on first use, exactly like `transaction_overrides.json`:

```json
{
  "excludedNights": [
    { "ownerId": "<owner>", "date": "2026-01-15", "reason": "red-eye flight" }
  ],
  "baselineRules": [
    { "ownerId": "<owner>", "from": "2026-01-01", "to": "2026-01-31",
      "reason": "illness — hold baseline", "excludeFromBaseline": true }
  ]
}
```

An excluded night is dropped from both the week and the baseline. This is the durable place for corrections — hand-editing the store is pointless because the next pull regenerates what it touches, the same reasoning that moved `TRACKER_REASSIGNMENTS` out of `budget-tracking-pull.mjs`.

## The rule

`goals.json` gains a tunable block. All `rule` values are implemented, so changing the rule after a few weeks of real data is a `goals.json` edit, not a code change:

```json
"healthThresholds": {
  "rule": "baselineStress",
  "combine": "either",
  "baselineDays": 30,
  "weekDays": 7,
  "minNightsForBaseline": 14,
  "minNightsInWeek": 3,
  "sleepScoreDropPoints": 5,
  "stressfulDaysInWeek": 3
}
```

- **baseline** — mean `daily_sleep.score` over the trailing `baselineDays`, **excluding the current week**, so this week cannot drag down its own reference.
- **depleted by sleep** — this week's mean sits `sleepScoreDropPoints` or more below that person's own baseline.
- **depleted by stress** — `daily_stress.day_summary === "stressful"` on `stressfulDaysInWeek` or more days in the week.
- `rule`: `"baseline"` | `"stress"` | `"baselineStress"`; `combine` (`either` | `both`) applies only to the last.
- Below `minNightsForBaseline` outside the week or `minNightsInWeek` inside it → `{ depleted: false, reason: "insufficient_data", nights: N }`.

**Personal baseline, not an absolute threshold**, because the two people in this household are very different sleepers. A shared cutoff would fire constantly for one and never for the other, collapsing "whoever is more depleted" into a single person's number permanently. Scoring each against their own norm is the only version where comparing two people means anything.

`loadHealthContext({ storeDir, goalsPath, overridesPath, now })` returns per-owner stats plus `worst`: depleted if **any** owner with sufficient data is depleted, reason carrying real figures (shape: "week averaged N against an M baseline, K stressful days"). Insufficient-data owners never contribute to `worst` but still appear in `perOwner`, so the recap can say whose baseline is still building.

**Cold start is the live state, not an edge case.** A ring set up today produces `insufficient_data` for roughly two weeks; resilience and stress take longer. Whoever already has history drives swaps immediately; the other folds in when their baseline exists. `minNightsForBaseline` is the gate.

## Consumers

**Recap** (`telegram-bot-recap.mjs`) — `gatherBundle` gains `health`, populated on both cadence days. `RECAP_SYSTEM_PROMPT` gains a "Health:" section carrying the same standing rule budget pace has: **real figures, never a bare adjective**, and name whose baseline is still building. Sunday passes `health` but **not** `depletion`; Thursday passes both. One flag, not two code paths.

**The swap** — `loadDiningContext` gains `depletion` from `health.worst`. `get_dining_plan` forces `slot.tier = 'low-key'` before calling `recommendForSlot`, for `date_night` and `weekend_social` only. `family_dinner` is deliberately excluded: `nextDateForDayOfWeek`'s `(dayOfWeek − getDay() + 7) % 7` puts it six days out on a Thursday, which would be forecasting next week from this week's sleep — the horizon problem this design exists to avoid. Date night lands at +1 and weekend social at +2.

**`recommendForSlot` needs a required `lowKeyReason` parameter.** Its low-key branch currently hardcodes *"Budget is tight for this occurrence — a free/low-key hang instead of a paid outing."* Firing that on depletion would report a false cause. The parameter is a correctness fix, not polish.

**Only the recap passes `depletion`.** The interactive bot and dashboard are untouched, which keeps the horizon closed and avoids a second implementation: `recommendForSlot` is **deliberately duplicated** in `dashboard_v5.html` (its inline script cannot import ES modules — see the module header), so anything reaching the dashboard must be written twice and kept in sync.

**`get_health_status`** — new `HEALTH_TOOL_NAMES` set, `TOOL_DEFS` entry, `TOOL_IMPL` entry, and a dispatch branch in `telegram-bot-poll.mjs` beside `FINANCIAL_TOOL_NAMES`. Read-only over `healthContext`, optional `startDate`/`endDate` (default 30 days), reads the store when present and falls back to the current window before the first pull — mirroring `search_transactions`. Reports both owners; the group chat already shares budget and todos the same way. Available any day: answering is not shaping.

## Risk: the swap runs a branch that has never executed

`recommendForSlot`'s low-key branch is currently unreachable from the bot and recap. `get_dining_plan` builds its slot from `slotForOccasion()` → a `goals.json` `diningRoutine` entry, and no entry carries `tier: "low-key"`. The budget-driven low-key path lives only in `dashboard_v5.html`'s `planRemainingMonth`, feeding the dashboard's own inline duplicate. This feature is therefore the **first caller ever** to reach that branch in the recap path — new behavior on untested code, not a second caller of something proven. Tests own it explicitly.

## Testing

`data/test-health-context.mjs` and `data/test-oura-store.mjs`, following the repo's per-module convention:

- Baseline math; current week excluded from its own baseline.
- Each `rule` value; `combine: either` vs `both`.
- Insufficient-data gate, including the one-night cold-start case.
- **A missing night is absent, never a zero** — a gap must not read as catastrophic sleep. Nights not worn are indistinguishable from bad nights without this.
- `excludedNights` removed from both week and baseline; `baselineRules` honored.
- Worse-of-two selection; insufficient-data owners excluded from `worst` but present in `perOwner`.
- Upsert merges by id without dropping rows outside the batch; a revised score overwrites in place.
- Id synthesis for `heartrate` and singletons.
- `family_dinner` never swaps; `date_night`/`weekend_social` do.
- The low-key branch fires with a depletion `lowKeyReason`, not the budget string.

`oura-pull.mjs` gets a `--dry-run` path so it can be exercised without writing.
