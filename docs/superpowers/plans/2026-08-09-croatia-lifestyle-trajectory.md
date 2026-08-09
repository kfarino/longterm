# Croatia lifestyle Trajectory — Implementation Plan

> **For agentic workers:** Implement as specified. Spec: `docs/superpowers/specs/2026-08-09-croatia-lifestyle-trajectory-design.md`.

**Goal:** Fourth Hanna scenario button **Croatia**; from 2027 overwrite phases; Kevin brokerage capped by surplus; Hanna savings 0; sabbatical + Croatia home sliders remain.

**Files:** `data/goals.json`, `examples/goals.example.json`, `data/build-data.mjs`, `dashboard_v5.html`, optionally `data/build-goal-plan-md.mjs`.

## Task 1: Data in goals.json
Add `lifestyleScenarios.croatia` economics + `chart.hannaScenario` default. Ensure `kevin300kYr` exists (alias `incomeStepYear` if needed).

## Task 2: Projection + UI
Wire `computeProjection` Croatia branch; add Croatia button; lifestyle note; sabbatical label framing when Croatia active.

## Task 3: Build + smoke
`npm run build`; verify surplus math (10815+1500-9000=3315; Kevin brok capped at 3315).
