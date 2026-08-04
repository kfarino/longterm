# Google Calendar as source of truth (Family Planner)

*Approved 2026-08-04 — Kevin. Supersedes Part D's "one-way push, nothing syncs back" in `2026-07-31-telegram-bot-design.md` for the Family Planner calendar only.*

## Problem

`calendar-sync.mjs` only pushed `month_plan_events.json` → Google. A delete or edit made directly in Google Calendar (e.g. Martha Wooding Birthday) left the Month Plan / dashboard stale, and the next sync would not adopt the Google change — and could even recreate a deleted event if state was cleared carelessly.

## Decision

**Google Family Planner is always source of truth** for what/when. The Month Plan file is a projection the dashboard and bot read; the bot may write the file for snappy UX, but sync reconciles toward Google every ~2 minutes.

## Behavior

On each `LongtermTelegramPoll` calendar-sync step:

1. **Pull cancels** — Google `cancelled` / missing tracked events → remove from `month_plan_events` + state. Never recreate.
2. **Push dirty locals** — local events with no `googleEventId` → create on Google; local signature ≠ last-pushed signature → update Google (bot edits). Local removed but still in state → delete on Google (bot `remove_event`).
3. **Pull confirmed** — Google rename / retimed / moved → update matching local event. Brand-new Google-only events → import as `kind: "schedule"`, `tier: "low-key"`, `cost: 0` (unless `extendedProperties.private` carries kind/dining metadata) so they don't appear on the Month Plan spend view until promoted.

## State & metadata

- State keyed by **`googleEventId`** (not `date|index`) to survive same-day removals without index-shift corruption.
- Each synced local event stores `googleEventId`.
- Bot-created events write `kind` / `tier` / `cost` / `source` into Google `extendedProperties.private` so a Google title/time edit does not wipe dining budget fields on pull.

## Out of scope

- Reading Kevin/Hanna personal calendars into Month Plan (still `calendar-read.mjs` only).
- Two-way sync of personal calendars.
- Changing the 2-minute poll cadence.
