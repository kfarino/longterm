# Health Vitals Reporting + Punchy Bot Replies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `get_health_status` reports readiness, HRV, resilience, and a weekly stress breakdown alongside the existing sleep-baseline line, and the interactive bot's replies stop being verbose prose and start matching the recap's proven short-line style.

**Architecture:** A new `computeOwnerVitals` in `health-context.mjs`, additive and separate from the existing (untouched) `computeOwnerHealth` depletion verdict. `get_health_status` gains a second line per owner. `REPHRASE_SYSTEM_PROMPT` in `telegram-bot-poll.mjs` gets rewritten in place — same function, same call shape, different style instructions.

**Tech Stack:** Node.js ESM (`.mjs`), hand-rolled `assert/strict` test runners — matching every other script in this session's work.

**Design doc:** `docs/superpowers/specs/2026-08-08-health-vitals-reporting-design.md` — read this first for the "why" (Kevin's real per-field degradation case, the search-reliability finding behind the rephrase prompt's illustrative example, why the recap's style — not literal bullets — is the target).

## Global Constraints

- **`computeOwnerHealth`'s depletion verdict is untouched.** The Thursday recap's dining-swap decision depends on it; this work must not risk it. Its existing test suite in `data/test-health-context.mjs` must pass unmodified, not just "still pass with edits."
- **Each vitals field degrades independently.** A missing HRV balance must never suppress an otherwise-present readiness score (Kevin's real case: score 89 present, HRV null, same day). No field's absence collapses the whole vitals line to "no data."
- A night/day with no record, or a record whose specific field is null, is absent — never coerced to zero or to any other placeholder that could be mistaken for a real reading.
- Every new reply line is a short, punchy fact — no filler sentences, no markdown, no bullet glyphs, matching the recap's own established convention.
- Tests inject every dependency (`now`, row arrays, clients) — no real network calls, no reliance on the real system clock.

---

### Task 1: `computeOwnerVitals` — readiness, HRV, resilience, stress breakdown

**Files:**
- Modify: `scripts/health-context.mjs`
- Test: `data/test-health-context.mjs`

**Interfaces:**
- Consumes: nothing new — `queryOura` (already imported) is reused by Task 1's own changes to `loadHealthContext`.
- Produces: `computeOwnerVitals(ownerId, { readinessRows = [], resilienceRows = [], stressRows = [], now = new Date(), recentDays = 7, weekDays = 7 } = {})` returning `{ readinessScore, readinessDay, hrvBalance, resilienceLevel, resilienceDay, stressBreakdown: { normal, stressful, restored } }` — every field independently `null`/`0` when absent, never thrown. `loadHealthContext`'s returned `perOwner[ownerId]` gains a `vitals` key holding this object. Task 2 consumes `perOwner[ownerId].vitals` directly.

- [ ] **Step 1: Write the failing tests**

Add to `data/test-health-context.mjs`, near the existing `computeOwnerHealth` tests (reuse that file's existing `dayBefore`/`NOW` helpers — do not redefine them):

```js
import { computeOwnerHealth, pickWorst, computeOwnerVitals } from '../scripts/health-context.mjs';

function readinessRow(daysAgo, { score = null, hrvBalance = null } = {}) {
  return {
    ownerId: 'alex', endpoint: 'daily_readiness', day: dayBefore(daysAgo),
    data: { score, contributors: { hrv_balance: hrvBalance } },
  };
}

function resilienceRow(daysAgo, level) {
  return { ownerId: 'alex', endpoint: 'daily_resilience', day: dayBefore(daysAgo), data: { level } };
}

function stressDayRow(daysAgo, daySummary) {
  return { ownerId: 'alex', endpoint: 'daily_stress', day: dayBefore(daysAgo), data: { day_summary: daySummary } };
}

test('reports the most recent readiness score and HRV balance within the window', () => {
  const readinessRows = [readinessRow(1, { score: 89, hrvBalance: 82 }), readinessRow(3, { score: 70, hrvBalance: 75 })];
  const v = computeOwnerVitals('alex', { readinessRows, now: NOW });
  assert.equal(v.readinessScore, 89);
  assert.equal(v.hrvBalance, 82);
  assert.equal(v.readinessDay, dayBefore(1));
});

test('Kevin\'s real case: a present readiness score does not get suppressed by a null HRV balance on the same day', () => {
  // Verified live 2026-08-08: Kevin's ring (set up 2026-08-06) had real scores
  // (63, 89) on both recorded days while contributors.hrv_balance was null on
  // both — Oura needs longer history before it computes HRV balance at all.
  const readinessRows = [readinessRow(1, { score: 89, hrvBalance: null }), readinessRow(2, { score: 63, hrvBalance: null })];
  const v = computeOwnerVitals('alex', { readinessRows, now: NOW });
  assert.equal(v.readinessScore, 89, 'the score must still be reported');
  assert.equal(v.hrvBalance, null, 'HRV balance is independently absent, not defaulted to 0 or copied from score');
});

test('HRV balance is found from an older row than the most recent readiness score, when the recent one lacks it', () => {
  const readinessRows = [readinessRow(1, { score: 89, hrvBalance: null }), readinessRow(2, { score: 63, hrvBalance: 75 })];
  const v = computeOwnerVitals('alex', { readinessRows, now: NOW });
  assert.equal(v.readinessScore, 89, 'still the most recent score');
  assert.equal(v.hrvBalance, 75, 'HRV balance is searched independently, so an older row with a real value is used');
});

test('no readiness rows at all reports null, not a throw', () => {
  const v = computeOwnerVitals('alex', { readinessRows: [], now: NOW });
  assert.equal(v.readinessScore, null);
  assert.equal(v.hrvBalance, null);
  assert.equal(v.readinessDay, null);
});

test('a readiness row outside recentDays is ignored', () => {
  const readinessRows = [readinessRow(10, { score: 50, hrvBalance: 50 })];
  const v = computeOwnerVitals('alex', { readinessRows, now: NOW, recentDays: 7 });
  assert.equal(v.readinessScore, null, 'a 10-day-old reading is too stale to call "current"');
});

test('resilience reports the most recent level within the window; zero rows reports null', () => {
  const resilienceRows = [resilienceRow(2, 'exceptional'), resilienceRow(5, 'solid')];
  const v1 = computeOwnerVitals('alex', { resilienceRows, now: NOW });
  assert.equal(v1.resilienceLevel, 'exceptional');
  assert.equal(v1.resilienceDay, dayBefore(2));

  const v2 = computeOwnerVitals('alex', { resilienceRows: [], now: NOW });
  assert.equal(v2.resilienceLevel, null, 'Kevin\'s real case: zero resilience rows so far — needs longer history than readiness');
});

test('stress breakdown counts this week\'s day_summary values by category', () => {
  const stressRows = [
    stressDayRow(1, 'normal'), stressDayRow(2, 'normal'), stressDayRow(3, 'stressful'),
    stressDayRow(4, 'restored'), stressDayRow(5, 'normal'),
  ];
  const v = computeOwnerVitals('alex', { stressRows, now: NOW, weekDays: 7 });
  assert.deepEqual(v.stressBreakdown, { normal: 3, stressful: 1, restored: 1 });
});

test('a stress row with a null day_summary is excluded from every category, not miscounted', () => {
  const stressRows = [stressDayRow(1, null), stressDayRow(2, 'normal')];
  const v = computeOwnerVitals('alex', { stressRows, now: NOW });
  assert.deepEqual(v.stressBreakdown, { normal: 1, stressful: 0, restored: 0 });
});

test('a stress row outside the week window is excluded from the breakdown', () => {
  const stressRows = [stressDayRow(10, 'stressful')];
  const v = computeOwnerVitals('alex', { stressRows, now: NOW, weekDays: 7 });
  assert.deepEqual(v.stressBreakdown, { normal: 0, stressful: 0, restored: 0 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-health-context.mjs`
Expected: FAIL — `computeOwnerVitals` is not exported yet.

- [ ] **Step 3: Implement `computeOwnerVitals`**

In `scripts/health-context.mjs`, add after `computeOwnerHealth` (before `pickWorst`):

```js
function mostRecentWithField(rows, extractFn, sinceDay) {
  const candidates = rows
    .filter((r) => r.day && r.day >= sinceDay)
    .map((r) => ({ day: r.day, value: extractFn(r.data) }))
    .filter((r) => r.value !== null && r.value !== undefined)
    .sort((a, b) => (a.day < b.day ? 1 : -1));
  return candidates[0] || null;
}

// Separate from computeOwnerHealth on purpose — that function's depletion
// verdict feeds the Thursday recap's dining swap and must not change here.
// This is purely additive reporting for get_health_status.
//
// Readiness/resilience are how-are-you-TODAY concepts (Oura presents them as
// daily snapshots, not week averages), so this reports the most recent
// available day within recentDays, not a mean. Each field is searched
// independently: Kevin's real ring (set up 2026-08-06) had a genuine
// readiness score on both its first two days while contributors.hrv_balance
// was null on both — a present score must never be suppressed by an absent
// HRV balance on the same day, and vice versa.
export function computeOwnerVitals(ownerId, {
  readinessRows = [], resilienceRows = [], stressRows = [], now = new Date(), recentDays = 7, weekDays = 7,
} = {}) {
  const sinceDay = isoDaysBefore(now, recentDays);
  const weekStart = isoDaysBefore(now, weekDays);

  const readiness = mostRecentWithField(readinessRows, (d) => (typeof d?.score === 'number' ? d.score : null), sinceDay);
  const hrv = mostRecentWithField(
    readinessRows,
    (d) => (typeof d?.contributors?.hrv_balance === 'number' ? d.contributors.hrv_balance : null),
    sinceDay,
  );
  const resilience = mostRecentWithField(resilienceRows, (d) => (typeof d?.level === 'string' ? d.level : null), sinceDay);

  const stressBreakdown = { normal: 0, stressful: 0, restored: 0 };
  for (const r of stressRows) {
    if (!r.day || r.day < weekStart) continue;
    const summary = r.data?.day_summary;
    if (summary === 'normal' || summary === 'stressful' || summary === 'restored') stressBreakdown[summary] += 1;
  }

  return {
    readinessScore: readiness ? readiness.value : null,
    readinessDay: readiness ? readiness.day : null,
    hrvBalance: hrv ? hrv.value : null,
    resilienceLevel: resilience ? resilience.value : null,
    resilienceDay: resilience ? resilience.day : null,
    stressBreakdown,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-health-context.mjs`
Expected: PASS — all new cases, and every pre-existing `computeOwnerHealth`/`pickWorst` case unchanged.

- [ ] **Step 5: Wire it into `loadHealthContext`**

In `scripts/health-context.mjs`, inside `loadHealthContext`'s `for (const { id: ownerId, displayName } of owners)` loop, replace:

```js
    const sleepRows = queryOura('daily_sleep', { storeDir, ownerId, startDate, endDate });
    const stressRows = queryOura('daily_stress', { storeDir, ownerId, startDate, endDate });
    perOwner[ownerId] = {
      ...computeOwnerHealth(ownerId, { sleepRows, stressRows, thresholds, overrides, now }),
      displayName,
    };
```

with:

```js
    const sleepRows = queryOura('daily_sleep', { storeDir, ownerId, startDate, endDate });
    const stressRows = queryOura('daily_stress', { storeDir, ownerId, startDate, endDate });
    const readinessRows = queryOura('daily_readiness', { storeDir, ownerId, startDate, endDate });
    const resilienceRows = queryOura('daily_resilience', { storeDir, ownerId, startDate, endDate });
    perOwner[ownerId] = {
      ...computeOwnerHealth(ownerId, { sleepRows, stressRows, thresholds, overrides, now }),
      vitals: computeOwnerVitals(ownerId, { readinessRows, resilienceRows, stressRows, now }),
      displayName,
    };
```

- [ ] **Step 6: Verify against the real store**

Run:
```bash
node -e "
import { loadHealthContext } from './scripts/health-context.mjs';
const c = loadHealthContext();
for (const [id, o] of Object.entries(c.perOwner)) console.log(id, JSON.stringify(o.vitals));
"
```
Expected: real, current values for Hanna (readiness score, HRV balance, resilience level, a non-zero stress breakdown); for Kevin, a real readiness score with `hrvBalance: null` and `resilienceLevel: null` (matching his exact real-world case this plan's tests already encode). **Do not paste this output into a commit message or doc** — real household data.

- [ ] **Step 7: Commit**

```bash
npm run check:secrets
git add scripts/health-context.mjs data/test-health-context.mjs
git commit -m "Add computeOwnerVitals: readiness, HRV, resilience, weekly stress breakdown."
```

---

### Task 2: `get_health_status` reports vitals, one short line per owner

**Files:**
- Modify: `scripts/telegram-bot-tools.mjs:653-665`
- Test: `data/test-telegram-bot.mjs`

**Interfaces:**
- Consumes: Task 1's `perOwner[ownerId].vitals` shape (`{ readinessScore, hrvBalance, resilienceLevel, stressBreakdown }`).
- Produces: `get_health_status`'s reply gains one additional line per owner. No signature change — still `get_health_status(healthContext)`.

- [ ] **Step 1: Write the failing tests**

Add to `data/test-telegram-bot.mjs`, near the existing `get_health_status` tests (search for `'get_health_status reports each owner'`):

```js
test('get_health_status reports vitals on a separate short line per owner', () => {
  const healthContext = {
    configured: true,
    perOwner: {
      hanna: {
        ownerId: 'hanna', displayName: 'Hanna', nights: 27, depleted: false,
        reason: 'week averaged 91.9 against a 89.3 baseline',
        vitals: { readinessScore: 87, hrvBalance: 82, resilienceLevel: 'exceptional', stressBreakdown: { normal: 5, stressful: 1, restored: 1 } },
      },
    },
    worst: null,
  };
  const result = get_health_status(healthContext);
  const lines = result.reply.split('\n');
  assert.equal(lines.length, 2, 'one sleep-baseline line plus one vitals line, not merged into one paragraph');
  assert.match(lines[1], /Hanna vitals/);
  assert.match(lines[1], /87\/100/);
  assert.match(lines[1], /HRV 82/);
  assert.match(lines[1], /exceptional/);
  assert.match(lines[1], /5 normal\/1 stressful\/1 restored/);
});

test('get_health_status reports each vitals field as independently unavailable, not one blanket message', () => {
  // Kevin's real case, 2026-08-08: a real readiness score, null HRV balance,
  // zero resilience rows, null-day_summary stress rows.
  const healthContext = {
    configured: true,
    perOwner: {
      kevin: {
        ownerId: 'kevin', displayName: 'Kevin', nights: 2, depleted: false, reason: 'insufficient_data',
        vitals: { readinessScore: 89, hrvBalance: null, resilienceLevel: null, stressBreakdown: { normal: 0, stressful: 0, restored: 0 } },
      },
    },
    worst: null,
  };
  const result = get_health_status(healthContext);
  const vitalsLine = result.reply.split('\n')[1];
  assert.match(vitalsLine, /89\/100/, 'the real score must still be reported');
  assert.match(vitalsLine, /HRV still building/);
  assert.match(vitalsLine, /resilience still building/);
  assert.match(vitalsLine, /stress data still building/);
});

test('get_health_status handles a missing vitals field gracefully (backward compat)', () => {
  // Pre-existing tests in this file construct perOwner entries with no
  // vitals key at all — this must not throw.
  const healthContext = {
    configured: true,
    perOwner: { alex: { ownerId: 'alex', displayName: 'Alex', nights: 1, depleted: false, reason: 'insufficient_data' } },
    worst: null,
  };
  const result = get_health_status(healthContext);
  assert.match(result.reply, /Alex vitals: not available yet\./);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node data/test-telegram-bot.mjs`
Expected: FAIL — the reply currently has no vitals line at all.

- [ ] **Step 3: Implement the vitals line**

In `scripts/telegram-bot-tools.mjs`, replace `get_health_status` in full:

```js
function formatVitalsLine(who, vitals) {
  if (!vitals) return `${who} vitals: not available yet.`;
  const readiness = vitals.readinessScore != null
    ? `readiness ${vitals.readinessScore}/100 (HRV ${vitals.hrvBalance != null ? vitals.hrvBalance : 'still building'})`
    : 'readiness still building';
  const resilience = vitals.resilienceLevel ? `resilience ${vitals.resilienceLevel}` : 'resilience still building';
  const b = vitals.stressBreakdown || { normal: 0, stressful: 0, restored: 0 };
  const stressLine = (b.normal + b.stressful + b.restored) > 0
    ? `${b.normal} normal/${b.stressful} stressful/${b.restored} restored this week`
    : 'stress data still building';
  return `${who} vitals: ${readiness}, ${resilience}, ${stressLine}.`;
}

export function get_health_status(healthContext) {
  if (!healthContext || !healthContext.configured) {
    return { reply: 'No Oura data yet — nothing has been pulled into the store.' };
  }
  const lines = [];
  for (const o of Object.values(healthContext.perOwner)) {
    const who = o.displayName || o.ownerId;
    if (o.reason === 'insufficient_data') {
      lines.push(`${who}: still building a baseline (${o.nights} night${o.nights === 1 ? '' : 's'} recorded).`);
    } else {
      lines.push(`${who}: ${o.depleted ? 'running depleted' : 'in normal range'} — ${o.reason}.`);
    }
    lines.push(formatVitalsLine(who, o.vitals));
  }
  return { reply: lines.join('\n') };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node data/test-telegram-bot.mjs`
Expected: PASS — including every pre-existing `get_health_status` case (they use `assert.match`, not exact-string equality, so the added vitals line doesn't break them).

- [ ] **Step 5: Commit**

```bash
npm run check:secrets
git add scripts/telegram-bot-tools.mjs data/test-telegram-bot.mjs
git commit -m "Report vitals on get_health_status, one short line per owner."
```

---

### Task 3: Punchy interactive-bot replies — retarget `REPHRASE_SYSTEM_PROMPT`

**Files:**
- Modify: `scripts/telegram-bot-poll.mjs:494`
- Test: `data/test-telegram-bot.mjs`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 — independent fix, bundled into this plan only because it surfaced in the same conversation (see spec).
- Produces: `REPHRASE_SYSTEM_PROMPT` becomes an exported constant (currently module-private) so its text is directly assertable — no other module's interface changes.

- [ ] **Step 1: Write the failing test**

Add to `data/test-telegram-bot.mjs`. First add `REPHRASE_SYSTEM_PROMPT` to the existing import from `'../scripts/telegram-bot-poll.mjs'` (alongside `runOnce`):

```js
import { runOnce, REPHRASE_SYSTEM_PROMPT } from '../scripts/telegram-bot-poll.mjs';
```

Then add the test, near the existing `naturalizeBatch` tests:

```js
test('REPHRASE_SYSTEM_PROMPT asks for short transactional lines, not warm flowing prose', () => {
  // Regression guard (2026-08-08): the household's actual live experience was
  // paragraphs like "Good news on sleep — Hanna's tracking well this week
  // at 91.9... If you're noticing a specific pattern... just let me know" —
  // directly caused by this prompt's prior wording ("warm", "flowing
  // reply"). This asserts the instruction genuinely changed, not just that
  // some string exists, so a future edit can't silently drift it back.
  const lower = REPHRASE_SYSTEM_PROMPT.toLowerCase();
  assert.ok(!lower.includes('warm'), 'must not ask for warmth-for-its-own-sake');
  assert.ok(!lower.includes('flowing'), 'must not ask for flowing prose');
  assert.ok(lower.includes('short'), 'must explicitly ask for short lines');
  assert.ok(lower.includes('markdown') && lower.includes('bullet'), 'must still rule out markdown/bullet glyphs, matching the recap convention');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node data/test-telegram-bot.mjs`
Expected: FAIL — `REPHRASE_SYSTEM_PROMPT` is not exported yet (`SyntaxError`), and even once import is fixed, the current text contains "warm" and "flowing".

- [ ] **Step 3: Replace the prompt and export it**

In `scripts/telegram-bot-poll.mjs`, replace:

```js
const REPHRASE_SYSTEM_PROMPT = 'You are a warm, concise family assistant replying in a Telegram group. You\'ll be given one or more (user message, raw system result) pairs from a single batch of messages that just arrived together. Compose ONE natural reply covering all of them — preserve every concrete fact exactly (names, places, dates, times, dollar amounts, percentages). If the items are all on the same topic, blend them into one flowing reply; if they\'re clearly separate, unrelated asks, address each with its own short sentence or line so nothing gets lost or merged into a confusing run-on — the reader should be able to tell distinct things happened. No markdown, no headers, no repeating back "as an AI", no filler.';
```

with:

```js
// Retargeted 2026-08-08 (was "warm, concise... blend into one flowing
// reply") after the household's live experience was verbose, hedging
// paragraphs directly traceable to that wording, even though the raw tool
// replies feeding this step were already terse. The rephrase step's actual
// job — composing a batch of several distinct raw replies into one coherent
// message instead of disconnected template strings — is still worth doing;
// only the style instruction changes, retargeted to match the weekly
// recap's own already-proven convention (RECAP_SYSTEM_PROMPT in
// telegram-bot-recap.mjs): short lines, no markdown, no bullet glyphs, no
// filler. The one-line before/after example is deliberate — this call uses
// claude-haiku-4-5, which follows a concrete example more reliably than
// adjectives alone, and this is the exact failure mode observed live (an
// already-terse fact turned into a paragraph).
export const REPHRASE_SYSTEM_PROMPT = 'You compose the final reply for a household Telegram group — a busy person reading on their phone, expecting a fast transactional answer, not a chat with an assistant. You\'ll be given one or more (user message, raw system result) pairs from a single batch of messages that just arrived together. Preserve every concrete fact exactly (names, places, dates, times, dollar amounts, percentages, scores). Write short, plain lines — one fact or outcome per line, never a paragraph. If the batch is several distinct asks, give each its own line so nothing merges into a run-on; a genuinely single continuous thing still reads better as two short lines than one long sentence. No "Good news", no warmth-for-its-own-sake, no hedging, no restating the question back, no offering further help unless something genuinely needs a follow-up. No markdown, no bullet characters, no headers — plain short lines only, same convention as the weekly recap.\n\nExample — terse in, terse out (not re-inflated):\nRaw result: "Hanna: in normal range — week averaged 91.9 vs 89.3 baseline."\nReply: "Hanna: in normal range, 91.9 vs her 89.3 baseline."';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node data/test-telegram-bot.mjs`
Expected: PASS — including every pre-existing `naturalizeBatch` case (they inject their own `rephraseClient` mocks, so the real prompt text never reaches them and their behavior is unaffected).

- [ ] **Step 5: Verify against a real Anthropic call**

This is a behavioral/tone change, not fully provable by a string-content assertion alone — confirm the actual model output live before considering this done:

```bash
node -e "
import { REPHRASE_SYSTEM_PROMPT } from './scripts/telegram-bot-poll.mjs';
import fs from 'node:fs'; import os from 'node:os';
const env = {};
for (const l of fs.readFileSync(os.homedir()+'/.longterm/telegram.env','utf8').split(/\r?\n/)) {
  const i = l.indexOf('='); if (i>0) env[l.slice(0,i)] = l.slice(i+1);
}
const items = [
  { userText: 'what about stress and recovery', rawReply: 'Hanna: in normal range — week averaged 91.9 against a 89.3 baseline.\nHanna vitals: readiness 87/100 (HRV 82), resilience exceptional, 5 normal/1 stressful/1 restored this week.\nKevin: still building a baseline (2 nights recorded).\nKevin vitals: readiness 89/100 (HRV still building), resilience still building, stress data still building.' },
];
const content = items.map((it, i) => (i+1)+'. User said: \"'+it.userText+'\"\n   Raw result: '+it.rawReply).join('\n\n');
const res = await fetch('https://api.anthropic.com/v1/messages', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
  body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 400, thinking: { type: 'disabled' }, system: REPHRASE_SYSTEM_PROMPT, messages: [{ role: 'user', content }] }),
});
const json = await res.json();
console.log(json.content.find(c => c.type === 'text').text);
"
```
Expected: short, plain lines — not a paragraph, no "Good news," no hedging, no offer to help further unless genuinely warranted. Compare directly against the household's actual prior experience quoted in the spec ("Good news on sleep — Hanna's tracking well this week at 91.9... If you're noticing a specific pattern... just let me know") — the new output must read nothing like that. If it still reads as a paragraph, the prompt needs further tightening before this task is done, not a shrug.

- [ ] **Step 6: Run the full test suite**

Run: `node data/test-telegram-bot.mjs && node data/test-health-context.mjs && node data/test-telegram-recap.mjs`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
npm run check:secrets
git add scripts/telegram-bot-poll.mjs data/test-telegram-bot.mjs
git commit -m "Retarget REPHRASE_SYSTEM_PROMPT to short transactional lines, matching the recap."
```

---

## Self-review

**Spec coverage:** `computeOwnerVitals` with per-field independent degradation, verified against Kevin's exact real-world case (Task 1) · `get_health_status`'s new vitals line, backward-compatible with every existing test fixture (Task 2) · the rephrase prompt retargeted with a direct string assertion plus a live model-output verification, not just a hope that it works (Task 3). The spec's non-goals (no change to the depletion verdict, no week-averaging for readiness/resilience, no unit conversion for stress seconds) correctly have no corresponding task — each is a decision embedded in Task 1's implementation, not a separate deliverable.

**Type consistency:** `computeOwnerVitals`'s return shape (`readinessScore`, `hrvBalance`, `resilienceLevel`, `stressBreakdown`) is exactly what Task 2's `formatVitalsLine` destructures. `loadHealthContext`'s `perOwner[ownerId].vitals` (Task 1, Step 5) is exactly what Task 2's `get_health_status` reads via `o.vitals`. Task 3 is fully independent of Tasks 1–2 — no shared types to drift.
