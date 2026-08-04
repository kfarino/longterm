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
import { loadCalendarReadContext, getUpcomingEvents } from './calendar-read.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDataDir = path.join(here, '..', 'data');

const OCCASIONS = ['family_dinner', 'date_night', 'weekend_social'];

function parseArgs(argv) {
  const args = {
    envPath: 'C:\\Users\\Family\\.longterm\\telegram.env',
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

function daysAgo(dateStr, now) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const then = new Date(dateStr); then.setHours(0, 0, 0, 0);
  return Math.floor((today - then) / 86400000);
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

// The single oldest still-open family to-do, if any — the recap's cue for
// "this has been sitting a while," not a full list (list_todos/the dashboard
// already cover that; the recap should only ever surface the one item worth
// nudging about).
function oldestStaleTodo(todos, now) {
  const open = listOpenItems(todos);
  if (!open.length) return null;
  const oldest = open.reduce((a, b) => (daysAgo(a.dateAdded, now) >= daysAgo(b.dateAdded, now) ? a : b));
  return { title: oldest.title, owner: oldest.owner, daysOld: daysAgo(oldest.dateAdded, now) };
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
function diningSummary(monthPlanEvents, diningContext) {
  const summary = {};
  const alreadySuggested = new Set();
  for (const occasion of OCCASIONS) {
    const result = get_dining_plan(monthPlanEvents, { occasion }, diningContext, alreadySuggested);
    summary[occasion] = { date: result.date, reply: result.reply };
    if (result.suggestedName) alreadySuggested.add(result.suggestedName);
  }
  return summary;
}

// savingsGoals (life-goal progress %, e.g. "Croatia brokerage 47%")
// deliberately excluded (2026-08-02) — Kevin: "it included longterm goals.
// not wanted in the weekly recaps. just the week." Scoped to the recap only;
// the interactive get_savings_goals tool and the dashboard are unaffected.
function gatherBundle({ todos, monthPlanEvents, diningContext, financialContext, now, unparsedMessages, calendarSummary, recentPlanChanges }) {
  return {
    budgetStatus: financialContext.budgetStatus,
    decisions: financialContext.decisions,
    dining: diningSummary(monthPlanEvents, diningContext),
    staleTodo: oldestStaleTodo(todos, now),
    unparsedMessages,
    calendarSummary,
    recentPlanChanges,
  };
}

const RECAP_SYSTEM_PROMPT = `Compose one natural, varied weekly recap message for a household Telegram group (Kevin & Hanna). This recap's main practical purpose is getting this week's dining plans confirmed: each entry in the dining field below (family dinner/date night/weekend social) has a date and reply text describing one of three states — an already-confirmed pick, a live suggestion that hasn't been booked yet, or a note that the slot already looks covered by something on a personal calendar (get_dining_plan checks this itself before generating any suggestion, so this is already decided, not something you need to work out). For a live suggestion, call it out clearly and prompt for a quick reply confirming it (or naming something else) — an unconfirmed dining slot is the single most actionable ask in a typical week, since only a confirmed pick gets pushed to the shared Google Calendar. A "looks already covered" note is a different state, not an unconfirmed suggestion — mention it briefly in passing, don't push for a booking reply on it the way you would a live suggestion. Also cover, when there's something worth saying: budget pace, any urgent decision needing attention, and the single oldest open family to-do if it's been sitting a while — supporting context, not the main ask. This recap is scoped to the current week only — never mention long-term savings goal progress or percentages (that's a different cadence of update, not part of this one). When you mention budget pace, always state the actual dollar figures — amount logged so far, the projected cycle total, and the target (e.g. "$1,270 logged, projected $5,442 vs a $5,500 target") — never a bare adjective like "tracking fine" with no numbers behind it. calendarSummary lists what's on Kevin's personal and Hanna's Google calendars for the coming week, each line tagged "(recurring)" if it's part of a recurring series and otherwise a one-off (null if calendar reading isn't configured yet). Always name any non-recurring event on either calendar this week, by whose calendar it's on and its date — a one-off is the kind of thing worth advance awareness of, unlike a recurring event which doesn't need repeating every week; skip this only if calendarSummary is null or genuinely nothing is on either calendar. If unparsedMessages is non-empty, someone sent the bot something it couldn't understand since the last recap — mention briefly that there are unprocessed messages worth resending or rephrasing (one line is enough; don't quote all of them verbatim). If recentPlanChanges.count is non-zero, the bot directly edited the real financial plan (a cost update, a new decision logged, etc.) since the last recap — mention briefly what changed (using recentPlanChanges.recent for a hint of what, not a full readout), since Kevin/Hanna may not have seen it happen live. Weight your attention to what's actually notable this week — a quiet week (everything already confirmed or covered, nothing overspent, nothing unparsed, nothing notable on the calendars, no recent plan changes) should read short and light; an unconfirmed dining slot, an overspend, an urgent decision, a to-do that's aged, unparsed messages, a non-recurring calendar event, or a recent plan change should get more attention. Do not use a rigid template, headers, or mechanically bullet every category — write like a person giving a quick, friendly update, and skip categories with nothing notable to report. Keep it under ~180 words. Plain text only, no markdown.`;

async function callAnthropicRecap({ apiKey, bundle }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 512,
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

  const recentPlanChanges = loadRecentPlanChanges(args.goalsChangelogPath);

  const bundle = gatherBundle({ todos, monthPlanEvents, diningContext, financialContext, now, unparsedMessages, calendarSummary, recentPlanChanges });

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
