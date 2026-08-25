# Joint cycle habits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Snapshot closed joint cycles, teach the bot leftover-days pacing and one habit cue, and send a one-shot close-out when the 25th ticks.

**Architecture:** `scripts/cycle-history.mjs` owns snapshot/habits/close-out text. The daily budget pull archives before rebuild. Recap and `get_budget_status` read derived habits. `computeTrackerPacing` is untouched.

**Tech Stack:** Node ESM, existing Monarch MCP spawn, Telegram `sendMessage`, `data/test-*.mjs`.

**Spec:** `docs/superpowers/specs/2026-08-25-cycle-habits-bot-design.md`

## Global Constraints

- Joint only; no personal trackers; no dining-rec changes.
- Rate silent before halfway; habits may speak earlier; no `$X/wk` when `< 7` days left.
- Gitignore `data/cycle_history.json`; invented fixture merchants/categories only.
- Snapshot before overwrite; Telegram failure must not fail the money pull.

---

### Task 1: cycle-history module + tests

- [x] `data/test-cycle-history.mjs` then `scripts/cycle-history.mjs`

### Task 2: leftover-days + habit copy in status/recap

- [x] `budgetGuidance` leftover fields; `get_budget_status`; recap bundle/prompt

### Task 3: daily pull rollover, close-out, backfill flag

- [x] Archive on 25th; contained Telegram; `--cycle-history-backfill-cycles`

### Task 4: privacy + docs + live backfill

- [x] gitignore, secrets checker, CLAUDE.md/AGENTS.md; run backfill once
