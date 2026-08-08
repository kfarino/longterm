# Health vitals reporting + punchy interactive-bot replies

*Approved 2026-08-08 — two tightly coupled fixes surfaced by the same conversation: `get_health_status` currently answers "how did you sleep" and nothing else, and separately, the interactive bot's replies are verbose/hedging prose rather than the recap's proven short-line style. Both get fixed together since the vitals output only matters if it isn't immediately re-inflated by the reply-composition step.*

## Problem

Asked "what about stress and recovery" in the household Telegram group, the bot (configured display name "Georgina") answered that it doesn't have access to HRV or readiness data and to check the Oura app directly. That's wrong about the data — `data/oura/daily_readiness.json`, `daily_resilience.json`, and `daily_stress.json` are pulled daily and, for Hanna, contain 600+ days of real values (HRV balance, resilience level, stress/recovery). It's accurate about the *tool*: `get_health_status` only ever reads `daily_sleep` and a bare count of stressful days from `daily_stress` — it was purpose-built for the Thursday depletion-swap decision, not general Oura Q&A, and its own description overpromises relative to what it returns.

## Goal

Extend `get_health_status` to report each owner's most recent readiness score, HRV balance, resilience level, and this week's stress-day breakdown (normal/stressful/restored counts) — real numbers, not vague words, matching the standing rule the recap's Health section already follows.

## Non-goals

- **No change to the depletion verdict.** `computeOwnerHealth` (sleep-baseline comparison, feeding the Thursday recap's dining swap) is untouched. This is purely additive reporting on a separate code path — the working, tested swap logic is not something to risk for a Q&A feature.
- **No week-long averaging for readiness/resilience.** Sleep is compared against a rolling baseline because "sleep debt" is inherently a multi-night concept. Readiness and resilience are how-are-you-*today* concepts — Oura itself presents them as daily snapshots, not weekly averages — so this reports the most recent available day for each, not a week mean.
- **No unit conversion for stress_high/recovery_high** (raw seconds). `daily_stress.day_summary` (normal/stressful/restored) is already a categorical, human-readable signal; a weekly count of each is more useful than converting an arbitrary seconds value that Oura's own app doesn't surface directly either.

## Data & degradation

Real data confirmed live (2026-08-08): Hanna has deep history across all fields. Kevin's ring, set up 2026-08-06, has 2 days of `daily_readiness` with a real top-level `score` (63, 89) but `contributors.hrv_balance: null` (Oura needs longer history to compute it), zero `daily_resilience` rows at all (needs even more history), and `daily_stress` present but `day_summary: null` on the most recent day.

**Each field degrades independently, not as an all-or-nothing block per owner.** Kevin's case proves this matters: his readiness *score* is real and worth reporting even though the *same day's* HRV balance is still null. A field with no usable value in the recency window reports "still building," not silence and not a zero.

## Implementation shape

New `computeOwnerVitals(ownerId, { readinessRows, resilienceRows, stressRows, now, recentDays = 7 } = {})` in `health-context.mjs`, alongside (not inside) `computeOwnerHealth`:

- **Readiness**: the most recent row within `recentDays` with a numeric `data.score`. Reports `{ readinessScore, readinessDay }` or `null` if none.
- **HRV balance**: the most recent row within `recentDays` with a numeric `data.contributors.hrv_balance` — independently searched, since it can be null on a day the readiness score itself is present.
- **Resilience**: the most recent row within `recentDays` with a `data.level` string. Reports `{ resilienceLevel, resilienceDay }` or `null`.
- **Stress breakdown**: counts of `day_summary` values (`normal`/`stressful`/`restored`) across rows in the current week window (reusing the same `weekStart` concept `computeOwnerHealth` already uses, for consistency) — rows with a null `day_summary` are excluded from the count, not counted as any category.

`loadHealthContext` queries `daily_readiness` and `daily_resilience` (new `queryOura` calls, same pattern as the existing `daily_sleep`/`daily_stress` queries) and merges `computeOwnerVitals`'s output into each owner's entry in `perOwner`, alongside the existing depletion fields.

## Reporting

`get_health_status` gets one additional short line per owner — not an appended sentence stitched onto the existing prose with "and"/commas, a genuinely separate line, matching the terse, one-fact-per-line convention this spec's second half establishes bot-wide:

```
Hanna: in normal range — week averaged 91.9 vs 89.3 baseline.
Hanna vitals: readiness 87/100 (HRV 82), resilience exceptional, 5 normal/1 stressful/1 restored this week.
Kevin: still building a baseline (1 night recorded).
Kevin vitals: readiness 89/100 (HRV still building), resilience still building.
```

Every field that degraded independently says so in place, rather than omitting the whole line — consistent with how "insufficient_data" is already handled for sleep.

The tool's existing description (*"Use this for any question about sleep, rest, readiness, recovery, or how the week has felt physically"*) already promised this scope — it doesn't need editing, since after this change it becomes accurate rather than aspirational.

## Interactive-bot reply style (bot-wide, not health-specific)

Separate root cause, same conversation: the verbose, hedging tone in the household's actual experience (*"Good news on sleep — Hanna's tracking well this week at 91.9 against a 89.3 baseline, and Kevin's still building his baseline... If you're noticing a specific pattern with stress or recovery — like either of you consistently undersleeping or feeling overextended — just let me know..."*) isn't coming from the tools. `get_health_status`'s raw output is already terse. It's coming from `telegram-bot-poll.mjs`'s `REPHRASE_SYSTEM_PROMPT` — a second Anthropic call (`naturalizeBatch`) that takes every batch of raw tool replies and explicitly instructs the model to produce a "warm," "flowing, natural reply." That instruction is directly why terse facts become paragraphs.

**The rephrase step itself stays — its actual job is legitimate and worth keeping**: composing a batch of several distinct raw replies (e.g. two different tool calls from one multi-part message) into one coherent message, so the user doesn't see disconnected template strings glued together with blank lines. What changes is only the *style* instruction, retargeted to match the recap's own already-proven convention (`RECAP_SYSTEM_PROMPT`: short lines, not paragraphs, no markdown, no filler, a busy person on their phone gets the gist in a few seconds) — confirmed with the user this means the recap's actual style specifically (plain short lines, no bullet glyphs), not literal `•` bullets, which the recap doesn't use either.

New prompt, replacing `REPHRASE_SYSTEM_PROMPT` in full:

```
You compose the final reply for a household Telegram group — a busy person reading on their phone, expecting a fast transactional answer, not a chat with an assistant. You'll be given one or more (user message, raw system result) pairs from a single batch of messages that just arrived together. Preserve every concrete fact exactly (names, places, dates, times, dollar amounts, percentages, scores). Write short, plain lines — one fact or outcome per line, never a paragraph. If the batch is several distinct asks, give each its own line so nothing merges into a run-on; a genuinely single continuous thing still reads better as two short lines than one long sentence. No "Good news," no warmth-for-its-own-sake, no hedging, no restating the question back, no offering further help unless something genuinely needs a follow-up. No markdown, no bullet characters, no headers — plain short lines only, same convention as the weekly recap.

Example — terse in, terse out (not re-inflated):
Raw result: "Hanna: in normal range — week averaged 91.9 vs 89.3 baseline."
Reply: "Hanna: in normal range, 91.9 vs her 89.3 baseline."
```

The one-line illustrative example is deliberate: `claude-haiku-4-5` (the model this call already uses) follows a concrete before/after more reliably than adjectives alone, and this is exactly the failure mode observed live — an already-terse raw fact turned into a paragraph.

## Testing

`computeOwnerVitals` gets its own test cases: real recent data for all four fields; Kevin's exact real-world case (readiness score present, HRV balance null, zero resilience rows, stress day_summary null) reported field-by-field rather than collapsed to a single "no data" message; a gap day excluded from the stress breakdown count rather than miscounted; `computeOwnerHealth`'s existing test suite re-run unmodified to confirm the depletion verdict is genuinely untouched.

The rephrase prompt change is behavioral, not unit-testable in the usual sense (it's a live LLM call) — verified two ways: (1) a test asserting `naturalizeBatch`'s injected `rephraseClient` receives the new `REPHRASE_SYSTEM_PROMPT` text, so a future edit can't silently regress it back toward "warm/flowing" without a test noticing the string changed; (2) a real, live Anthropic call during implementation with realistic raw replies (including a multi-owner vitals batch) to confirm the actual output reads like the recap, not like the screenshots that prompted this fix.
