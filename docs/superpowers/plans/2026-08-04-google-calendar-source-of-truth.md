# Google Calendar SoT Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Family Planner Google Calendar is source of truth; Month Plan mirrors Google deletes/edits within one poll cycle, while bot-originated local writes still push.

**Architecture:** Extend `calendar-sync.mjs` with list/get remote events, pull-then-push reconciliation, `googleEventId`-keyed state, and `extendedProperties.private` for dining metadata. Tests in `data/test-calendar-sync.mjs` with a mocked client.

**Tech stack:** Node ESM, Google Calendar REST (existing fetch client), no new deps.

## File map

- `scripts/calendar-sync.mjs` — reconciliation logic
- `data/calendar-sync-state.json` — migrate to googleEventId keys (done by sync on first run)
- `data/month_plan_events.json` — events gain `googleEventId` when synced
- `data/test-calendar-sync.mjs` — regression + new pull cases
- `claude.md` — one-line architecture note (one-way → Google SoT)

## Task 1: Failing tests for pull behavior

- [x] Add mock `listEvents` to test client
- [x] Tests: remote cancel removes local; remote edit updates local; remote-only event imports; dirty local still creates/updates; migrate old `date|index` state
- [x] Run tests — expect failures

## Task 2: Implement reconciliation

- [x] `buildEventBody` writes extendedProperties; parse remote → local fields
- [x] State by googleEventId; migrate legacy keys on load
- [x] `runSync`: list remotes → pull cancels → push dirty → pull upserts → write plan + state
- [x] Pass tests

## Task 3: Smoke + docs

- [x] Run `node scripts/calendar-sync.mjs` once against live calendar
- [x] Update `claude.md` calendar-sync bullet
- [x] Confirm Martha stays absent (Google cancel must not recreate)
