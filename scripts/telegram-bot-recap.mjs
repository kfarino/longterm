#!/usr/bin/env node
// Finances/Longterm/scripts/telegram-bot-recap.mjs
// Sends a dynamically-composed weekly recap into the same Telegram group the
// interactive bot (telegram-bot-poll.mjs) uses — Sun + Thu mornings, via its
// own scheduled task (install-telegram-recap-scheduled-task.ps1). "Dynamic"
// means the message is one Anthropic text completion over the week's raw
// signal, not a filled-in template: a quiet week reads short, an overspend
// or a stale to-do gets more attention, and nothing is mechanically bulleted
// every time. See docs/superpowers/specs/2026-07-31-telegram-bot-design.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { get_dining_plan, listOpenItems } from './telegram-bot-tools.mjs';
import { loadFinancialContext } from './financial-context.mjs';
import { loadHealthContext, defaultHealthOverridesPath } from './health-context.mjs';
import { loadCalendarReadContext, getUpcomingEvents } from './calendar-read.mjs';
import { telegramEnvPath } from './longterm-paths.mjs';
import { defaultOuraStoreDir } from './oura-store.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDataDir = path.join(here, '..', 'data');

const OCCASIONS = ['family_dinner', 'date_night', 'weekend_social'];

function parseArgs(argv) {
  const args = {
    envPath: telegramEnvPath(),
    todosPath: path.join(repoDataDir, 'todos.json'),
    goalsPath: path.join(repoDataDir, 'goals.json'),
    favoritePlacesPath: path.join(repoDataDir, 'favorite_places.json'),
    monthPlanEventsPath: path.join(repoDataDir, 'month_plan_events.json'),
    budgetTrackingPath: path.join(repoDataDir, 'budget_tracking.json'),
    accountsPath: path.join(repoDataDir, 'accounts.json'),
    recapLogPath: path.join(repoDataDir, 'telegram-recap-log.jsonl'),
    unparsedPath: path.join(repoDataDir, 'telegram-unparsed.jsonl'),
    routineOverridesPath: path.join(repoDataDir, 'dining-routine-overrides.json'),
    goalsChangelogPath: path.join(repoDataDir, 'goals-changelog.jsonl'),
    ouraStoreDir: defaultOuraStoreDir(),
    healthOverridesPath: defaultHealthOverridesPath(),
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      i += 1;
      if (key === 'env-path') args.envPath = value;
      else if (key === 'todos-path') args.todosPath = value;
      else if (key === 'goals-path') args.goalsPath = value;
      else if (key === 'favorite-places-path') args.favoritePlacesPath = value;
      else if (key === 'month-plan-events-path') args.monthPlanEventsPath = value;
      else if (key === 'budget-tracking-path') args.budgetTrackingPath = value;
      else if (key === 'accounts-path') args.accountsPath = value;
      else if (key === 'recap-log-path') args.recapLogPath = value;
      else if (key === 'unparsed-path') args.unparsedPath = value;
      else if (key === 'routine-overrides-path') args.routineOverridesPath = value;
      else if (key === 'goals-changelog-path') args.goalsChangelogPath = value;
      else if (key === 'oura-store-dir') args.ouraStoreDir = value;
      else if (key === 'health-overrides-path') args.healthOverridesPath = value;
      else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readLocalEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) throw new Error(`Missing env file: ${filePath}`);
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return values;
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}${os.EOL}`, 'utf8');
}

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Sunday/Thursday are this recap's only real cadence (see the scheduled
// task); any other day is an ad-hoc/manual/test run and still gets a slot
// label, just not one that collides with a real cadence day's dedup entry.
function slotForDay(dayOfWeek) {
  if (dayOfWeek === 0) return 'sunday-morning';
  if (dayOfWeek === 4) return 'thursday-morning';
  return 'ad-hoc';
}

function alreadySentToday(recapLogPath, date) {
  if (!fs.existsSync(recapLogPath)) return false;
  const lines = fs.readFileSync(recapLogPath, 'utf8').split('\n').filter(Boolean);
  return lines.some((line) => JSON.parse(line).date === date);
}

function lastRecapSentAt(recapLogPath) {
  if (!fs.existsSync(recapLogPath)) return null;
  const lines = fs.readFileSync(recapLogPath, 'utf8').split('\n').filter(Boolean);
  if (!lines.length) return null;
  return lines.map((l) => JSON.parse(l).sentAt).sort().pop();
}

// Messages nobody could make sense of since the last recap — surfaced here
// so they don't just sit invisibly in telegram-unparsed.jsonl forever with
// no one aware; capped to a handful so a bad stretch doesn't turn the recap
// into a wall of text. Falls back to a 7-day window on the very first
// recap, when there's no prior sentAt to anchor "since" to.
function loadUnparsedSince(unparsedPath, sinceISO) {
  if (!fs.existsSync(unparsedPath)) return [];
  const since = sinceISO || new Date(Date.now() - 7 * 86400000).toISOString();
  return fs.readFileSync(unparsedPath, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.at > since)
    .slice(-5)
    .map((e) => ({ text: e.text, reason: e.reason }));
}

// update_phase_expense/log_decision write straight into goals.json, no
// review gate — this just surfaces that something changed since the last
// recap, so Kevin/Hanna aren't surprised by a plan edit they didn't see
// happen live. Total count plus the 2 most recent replies, not every one.
function loadRecentPlanChanges(goalsChangelogPath) {
  if (!fs.existsSync(goalsChangelogPath)) return { count: 0, recent: [] };
  try {
    const entries = fs.readFileSync(goalsChangelogPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { count: entries.length, recent: entries.slice(-2).map((e) => e.reply) };
  } catch {
    return { count: 0, recent: [] };
  }
}

// Budget section (2026-08-05 recap redesign): every joint-tracker line item
// over $100 this cycle, not just the aggregate pace number — reuses the same
// financialContext.transactions the interactive bot's search_transactions
// tool reads (see financial-context.mjs's loadTransactionDetail), so the
// recap and an ad-hoc "was X charged" question always agree. Explicitly
// excludes refund rows (type === 'refund') — those get their own
// budgetRefunds field below, not double-counted as a spend line here.
function budgetLineItemsOver100(financialContext) {
  return (financialContext.transactions || [])
    .filter((t) => t.tracker === 'joint' && t.amount > 100 && t.type !== 'refund')
    .sort((a, b) => b.amount - a.amount);
}

// Refunds/credits this cycle (2026-08-05) — see budget-tracking-pull.mjs's
// detectJointRefunds and financial-context.mjs's loadTransactionDetail for
// where these come from. Kevin: "critical change in recap. I want a line
// item for refunds."
function budgetRefundsThisCycle(financialContext) {
  return (financialContext.transactions || [])
    .filter((t) => t.tracker === 'joint' && t.type === 'refund')
    .sort((a, b) => b.amount - a.amount);
}

// Todos section (2026-08-05 recap redesign): every open item, grouped by
// owner — replaces the single-oldest-item summary (oldestStaleTodo), since
// each item already carries dateAdded and the LLM can note aging within the
// full list rather than needing a separate flagged field.
function todosByOwner(todos) {
  const grouped = {};
  for (const item of listOpenItems(todos)) {
    if (!grouped[item.owner]) grouped[item.owner] = [];
    grouped[item.owner].push({ title: item.title, dateAdded: item.dateAdded, deadline: item.deadline });
  }
  return grouped;
}

const EMPTY_ROUTINE_OVERRIDES = { family_dinner: null, date_night: null, weekend_social: null };

// Bot-owned, not goals.json — see telegram-bot-tools.mjs's set_routine_day
// for why. Read-only here (the recap never changes the schedule itself),
// but needs this to report the *current* day, same as the interactive bot.
function loadRoutineOverrides(routineOverridesPath) {
  try {
    return { ...EMPTY_ROUTINE_OVERRIDES, ...JSON.parse(fs.readFileSync(routineOverridesPath, 'utf8')) };
  } catch {
    return { ...EMPTY_ROUTINE_OVERRIDES };
  }
}

function loadDiningContext({ goalsPath, favoritePlacesPath, routineOverridesPath }, calendarEvents = []) {
  let diningRoutine = [];
  let lowKeyHangIdeas = [];
  try {
    const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    diningRoutine = goals.diningRoutine || [];
    lowKeyHangIdeas = goals.lowKeyHangIdeas || [];
  } catch { /* missing/unparseable — dining summary degrades to empty */ }
  let favorites = [];
  let recentDiningActivity = [];
  try {
    const fp = JSON.parse(fs.readFileSync(favoritePlacesPath, 'utf8'));
    favorites = fp.places || [];
    recentDiningActivity = fp.recentDiningActivity || [];
  } catch { /* missing/unparseable — dining summary degrades to empty */ }
  const routineOverrides = loadRoutineOverrides(routineOverridesPath);
  return { diningRoutine, lowKeyHangIdeas, favorites, recentDiningActivity, routineOverrides, calendarEvents };
}

function loadMonthPlanEvents(monthPlanEventsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(monthPlanEventsPath, 'utf8'));
    return { events: parsed.events || {} };
  } catch {
    return { events: {} };
  }
}

// Reuses get_dining_plan's own read-only logic (already-set vs. live
// suggestion) rather than re-deriving it — same reasoning as reusing
// financial-context.mjs: one source of truth for "what's the plan," whether
// asked interactively or summarized in the recap. Threads an accumulating
// exclude set across the 3 occasions (2026-08-02) — without this, each
// occasion's independent call to get_dining_plan has no idea what the other
// two are about to suggest, so all 3 can converge on the same top-scored
// favorite (observed live: all 3 slots suggested "Terra Eataly" in one
// recap). Each occasion's own `date` is included too, not just its reply
// text, so the recap can cross-reference dining days against calendarSummary.
function diningSummary(monthPlanEvents, diningContext, now = null) {
  const summary = {};
  const alreadySuggested = new Set();
  for (const occasion of OCCASIONS) {
    const result = get_dining_plan(monthPlanEvents, { occasion, now }, diningContext, alreadySuggested);
    summary[occasion] = { date: result.date, reply: result.reply };
    if (result.suggestedName) alreadySuggested.add(result.suggestedName);
  }
  return summary;
}

// savingsGoals (life-goal progress %, e.g. "Croatia brokerage 47%")
// deliberately excluded (2026-08-02) — Kevin: "it included longterm goals.
// not wanted in the weekly recaps. just the week." Scoped to the recap only;
// the interactive get_savings_goals tool and the dashboard are unaffected.
function gatherBundle({ todos, monthPlanEvents, diningContext, financialContext, unparsedMessages, calendarSummary, recentPlanChanges, now, healthContext, healthAffectsPlans }) {
  return {
    budgetStatus: financialContext.budgetStatus,
    budgetLineItems: budgetLineItemsOver100(financialContext),
    budgetRefunds: budgetRefundsThisCycle(financialContext),
    decisions: financialContext.decisions,
    dining: diningSummary(monthPlanEvents, diningContext, now),
    todosByOwner: todosByOwner(todos),
    unparsedMessages,
    calendarSummary,
    recentPlanChanges,
    health: healthContext,
    healthAffectsPlans,
  };
}

const RECAP_SYSTEM_PROMPT = `Compose a weekly recap message for a household Telegram group (Kevin & Hanna), using exactly four labeled sections in this order: "Budget:", "Todos:", "Planning:", "Health:". Within each section, write naturally (not a bare data dump) but keep it skimmable — short lines, not paragraphs; a busy person reading on their phone should get the gist of each section in a few seconds.

Budget: report the joint tracker's pace using real dollar figures (amount logged so far, projected cycle total, target — e.g. "$1,270 logged, projected $5,442 vs a $5,500 target", from budgetStatus.joint), then list every joint-card line item over $100 this cycle from budgetLineItems (merchant, amount, and its group/category) — if budgetLineItems is empty, say so briefly rather than omitting the line entirely. Always include a refunds line too, from budgetRefunds (merchant and amount for each) — if budgetRefunds is empty, say plainly that there were no refunds this cycle rather than skipping the line; refunds are a standing part of this section, not an optional trailing callout.

Todos: list every open to-do from todosByOwner, grouped by the owner it's under (e.g. "Kevin: ..." then "Hanna: ..."), noting how long ago an item was added only if it's been sitting a while (more than a week or two) — skip an owner's line entirely if they have nothing open, rather than saying "none."

Planning: one line per routine occasion (family dinner / date night / weekend social) from the dining field, same as always — a live suggestion should prompt for a quick confirming reply (only a confirmed pick gets pushed to the shared Google Calendar); an already-confirmed pick or a "looks already covered" note is just mentioned in passing, not pushed for a reply.

Health: one short line per person from health.perOwner — how this week compared to that person's own baseline, using the real figures in their reason string. Never a bare adjective like "poor" or "fine" on its own; the numbers are the point, exactly as with budget pace. If someone's reason is "insufficient_data", say plainly that their baseline is still building and give the night count, rather than implying anything at all about how they slept. If health is null or health.configured is false, skip this section entirely. If healthAffectsPlans is false, report only — do not suggest changing any plan on the basis of health, and do not imply the weekend should be different.

After the four sections, always add one short standing line inviting a follow-up about upcoming shows, worded naturally each time but along these lines: "Curious what's on at our favorite venues? Just ask — I can check the next couple weeks." Include this every time, not conditionally.

Then, only if there's something notable, add one or two short trailing lines for: an urgent open decision (decisions, only flag one with status "urgent" — don't list every open decision), a non-recurring event on either Google calendar this week (calendarSummary — name whose calendar and the date; skip if calendarSummary is null or nothing non-recurring is on either calendar), unprocessed messages since the last recap (unparsedMessages — one line, don't quote them all verbatim), or a recent direct edit to the real financial plan (recentPlanChanges — if count is non-zero, mention briefly what changed using recentPlanChanges.recent as a hint). Skip any of these four with nothing to report — don't force a line just to fill space.

Never mention long-term savings goal progress or percentages — that's a different cadence of update, not part of this one. Do not use markdown formatting (no headers, no bullets, no bold) — plain text with the section labels as the only structure. Keep the whole message focused; the labeled sections plus at most a couple of trailing lines, not a wall of text.`;

async function callAnthropicRecap({ apiKey, bundle }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      // Explicitly disabled (2026-08-06): claude-sonnet-5 defaults extended
      // thinking on even when not requested, and this templated composition
      // task doesn't need it -- left enabled, thinking consumed the entire
      // 512-token budget with stop_reason "max_tokens" and produced NO text
      // block at all, silently killing the Thu/Sun recap (confirmed live:
      // the 9am scheduled run and a manual re-run both hit this).
      thinking: { type: 'disabled' },
      system: RECAP_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(bundle, null, 2) }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  return res.json();
}

async function callTelegram(token, method, body) {
  const maxAttempts = 3;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(`Telegram ${method} rejected: ${JSON.stringify(json)}`);
      return json;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
    }
  }
  throw lastErr;
}

export async function runOnce(opts) {
  const args = { ...parseArgs([]), ...opts };
  const now = args.now || new Date();
  const date = isoDate(now);
  const slot = slotForDay(now.getDay());

  if (alreadySentToday(args.recapLogPath, date)) {
    return { sent: false, reason: 'already_sent_today', date, slot };
  }

  const envValues = args.token && args.groupChatId ? {} : readLocalEnv(args.envPath);
  const token = args.token || envValues.TELEGRAM_BOT_TOKEN;
  const groupChatId = args.groupChatId || envValues.TELEGRAM_GROUP_CHAT_ID;
  const apiKey = args.apiKey || envValues.ANTHROPIC_API_KEY;

  const todos = JSON.parse(fs.readFileSync(args.todosPath, 'utf8'));
  const monthPlanEvents = loadMonthPlanEvents(args.monthPlanEventsPath);
  const financialContext = loadFinancialContext(args);

  const unparsedMessages = loadUnparsedSince(args.unparsedPath, lastRecapSentAt(args.recapLogPath));

  // One fetch, reused two ways (2026-08-02): the text summary still goes
  // straight into the bundle for the "any non-recurring event" instruction,
  // and the same structured items now also feed diningContext so
  // get_dining_plan can check calendar coverage before recommending, not
  // just have the recap's own prompt notice a conflict after the fact.
  const calendarReadContext = loadCalendarReadContext(args);
  let calendarSummary = null;
  let calendarItems = [];
  if (calendarReadContext.configured) {
    try {
      const result = await getUpcomingEvents({ ...calendarReadContext, days: 7, now });
      calendarSummary = result.summary;
      calendarItems = result.items;
    } catch {
      calendarSummary = null; // a Calendar hiccup must not fail the whole recap
    }
  }
  const diningContext = loadDiningContext(args, calendarItems);

  // Health is reported on both cadence days, but only Thursday lets it change
  // the weekend's dining suggestions — Sunday is a summary, not a planner.
  const healthContext = loadHealthContext({
    now, storeDir: args.ouraStoreDir, overridesPath: args.healthOverridesPath, goalsPath: args.goalsPath,
  });
  const healthAffectsPlans = slot === 'thursday-morning';
  diningContext.depletion = healthAffectsPlans ? healthContext.worst : null;

  const recentPlanChanges = loadRecentPlanChanges(args.goalsChangelogPath);

  const bundle = gatherBundle({ todos, monthPlanEvents, diningContext, financialContext, unparsedMessages, calendarSummary, recentPlanChanges, now, healthContext, healthAffectsPlans });

  const client = args.anthropicClient || callAnthropicRecap;
  const llmResponse = await client({ apiKey, bundle });
  const textBlock = llmResponse.content.find((c) => c.type === 'text');
  const recapText = textBlock ? textBlock.text : null;
  if (!recapText) return { sent: false, reason: 'no_text_in_response', date, slot };

  if (!args.dryRun) {
    const telegramClient = args.telegramClient || callTelegram;
    await telegramClient(token, 'sendMessage', { chat_id: groupChatId, text: recapText });
    appendJsonl(args.recapLogPath, { date, slot, sentAt: now.toISOString() });
  }

  return { sent: true, date, slot, text: recapText, bundle };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOnce(args);
  console.log(JSON.stringify({ ok: true, sent: result.sent, reason: result.reason || null }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
