#!/usr/bin/env node
// Finances/Longterm/scripts/telegram-bot-poll.mjs
// Polls a dedicated Telegram bot (separate from Scrooge's — own token, own
// update queue, no shared-poller conflict) for messages in one group chat.
// The group is dedicated to talking to this bot (2026-08-01: every message
// from a recognized sender is processed, not just @mentions/replies — no
// "only when addressed" gate) — an unrecognized sender is still silently
// skipped, and the bot's own messages are naturally excluded the same way
// (its own Telegram user id was never added to telegram-owners.json). See
// docs/superpowers/specs/2026-07-31-telegram-bot-design.md for the full
// design and why each of these choices was made.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { add_todo, TOOL_DEFS, TOOL_IMPL, DINING_TOOL_NAMES, FINANCIAL_TOOL_NAMES, FAMILY_EVENT_TOOL_NAMES, ROUTINE_OVERRIDE_TOOL_NAMES, GOALS_TOOL_NAMES } from './telegram-bot-tools.mjs';
import { loadFinancialContext } from './financial-context.mjs';
import { runSync as runCalendarSync } from './calendar-sync.mjs';
import { loadCalendarReadContext, getUpcomingEvents } from './calendar-read.mjs';
import { googleCalendarEnvPath, telegramEnvPath } from './longterm-paths.mjs';

const CALENDAR_ENV_PATH = googleCalendarEnvPath();

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDataDir = path.join(here, '..', 'data');

function parseArgs(argv) {
  const args = {
    envPath: telegramEnvPath(),
    todosPath: path.join(repoDataDir, 'todos.json'),
    ownersPath: path.join(repoDataDir, 'telegram-owners.json'),
    offsetPath: path.join(repoDataDir, 'telegram-offset.json'),
    unparsedPath: path.join(repoDataDir, 'telegram-unparsed.jsonl'),
    goalsPath: path.join(repoDataDir, 'goals.json'),
    favoritePlacesPath: path.join(repoDataDir, 'favorite_places.json'),
    venuesToFollowPath: path.join(repoDataDir, 'venues_to_follow.json'),
    upcomingShowsCachePath: path.join(repoDataDir, 'upcoming_shows_cache.json'),
    monthPlanEventsPath: path.join(repoDataDir, 'month_plan_events.json'),
    budgetTrackingPath: path.join(repoDataDir, 'budget_tracking.json'),
    accountsPath: path.join(repoDataDir, 'accounts.json'),
    routineOverridesPath: path.join(repoDataDir, 'dining-routine-overrides.json'),
    conversationLogPath: path.join(repoDataDir, 'telegram-conversation-log.jsonl'),
    goalsChangelogPath: path.join(repoDataDir, 'goals-changelog.jsonl'),
    pendingClarificationsPath: path.join(repoDataDir, 'telegram-pending-clarifications.json'),
    updatesFixture: null,
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
      else if (key === 'owners-path') args.ownersPath = value;
      else if (key === 'offset-path') args.offsetPath = value;
      else if (key === 'unparsed-path') args.unparsedPath = value;
      else if (key === 'goals-path') args.goalsPath = value;
      else if (key === 'favorite-places-path') args.favoritePlacesPath = value;
      else if (key === 'venues-to-follow-path') args.venuesToFollowPath = value;
      else if (key === 'upcoming-shows-cache-path') args.upcomingShowsCachePath = value;
      else if (key === 'month-plan-events-path') args.monthPlanEventsPath = value;
      else if (key === 'budget-tracking-path') args.budgetTrackingPath = value;
      else if (key === 'accounts-path') args.accountsPath = value;
      else if (key === 'routine-overrides-path') args.routineOverridesPath = value;
      else if (key === 'conversation-log-path') args.conversationLogPath = value;
      else if (key === 'goals-changelog-path') args.goalsChangelogPath = value;
      else if (key === 'pending-clarifications-path') args.pendingClarificationsPath = value;
      else if (key === 'updates-fixture') args.updatesFixture = value;
      else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

const EMPTY_ROUTINE_OVERRIDES = { family_dinner: null, date_night: null, weekend_social: null };

// Bot-owned, not goals.json — see set_routine_day's own comment for why.
// Missing/unparseable degrades to "no overrides," same convention as the
// dining/financial context loaders.
function loadRoutineOverrides(routineOverridesPath) {
  try {
    return { ...EMPTY_ROUTINE_OVERRIDES, ...JSON.parse(fs.readFileSync(routineOverridesPath, 'utf8')) };
  } catch {
    return { ...EMPTY_ROUTINE_OVERRIDES };
  }
}

// goals.json is loaded here as a genuinely mutable object (2026-08-02:
// direct writes, not a side review file — see update_phase_expense/
// log_decision in telegram-bot-tools.mjs). Missing/unparseable degrades to
// null — callers must treat that as "goals-editing tools unavailable this
// run" rather than crash, same convention as every other loader here, but
// note this is a much bigger deal than a missing dining-routine-overrides
// file: with no goals object, update_phase_expense/log_decision simply
// aren't dispatched (see dispatchMessage's goals-tool branch).
function loadGoalsForEditing(goalsPath) {
  try {
    return JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
  } catch {
    return null;
  }
}

// Every bot-made goals.json edit is appended here — not a review gate (the
// edit has already happened by the time this is written), just a
// traceable record of what changed and when, so a change is never a
// mystery later. Same append-only convention as telegram-unparsed.jsonl.
function appendGoalsChangelog(goalsChangelogPath, entry) {
  appendJsonl(goalsChangelogPath, entry);
}

// Multi-turn clarification (2026-08-02): at most one open question per
// sender, keyed by owner. Missing/unparseable degrades to "nothing
// pending," same convention as every other loader here. { question,
// originalText, askedAt } per sender, or absent/null if nothing's open.
function loadPendingClarifications(pendingClarificationsPath) {
  try {
    return JSON.parse(fs.readFileSync(pendingClarificationsPath, 'utf8'));
  } catch {
    return {};
  }
}

// 3 hours: long enough for a real same-day back-and-forth (someone steps
// away and replies later), short enough that an unrelated message sent
// tomorrow isn't misread as answering today's question.
const CLARIFICATION_EXPIRY_MS = 3 * 60 * 60 * 1000;

function isClarificationLive(entry, now) {
  return !!entry && (now.getTime() - new Date(entry.askedAt).getTime()) < CLARIFICATION_EXPIRY_MS;
}

// Regenerates data.js and the narrative goal-plan doc after a real
// goals.json edit — the same "Regeneration rule" claude.md already states
// for any hand edit. Derived from goalsPath's own directory (not this
// script's fixed location), so a test run against a temp goalsPath (with no
// build-data.mjs of its own) safely no-ops, exactly mirroring the existing
// todos.json -> build-data.mjs regeneration guard below.
function regenerateFromGoals(goalsPath) {
  const dataDir = path.dirname(goalsPath);
  const buildDataScript = path.join(dataDir, 'build-data.mjs');
  if (fs.existsSync(buildDataScript)) spawnSync(process.execPath, [buildDataScript], { stdio: 'inherit' });
  const buildGoalPlanScript = path.join(dataDir, 'build-goal-plan-md.mjs');
  if (fs.existsSync(buildGoalPlanScript)) spawnSync(process.execPath, [buildGoalPlanScript], { stdio: 'inherit' });
}

// Short-term conversational memory (2026-08-01): the last few (sender,
// message, raw reply) exchanges, so a natural follow-up like "actually make
// that 6pm" has something to resolve "that" against — every message was
// previously handled in total isolation. Read-only here; entries are
// appended by runOnce() after each message is processed. Same "degrade to
// empty rather than throw" convention as every other context loader in this
// file — a missing/corrupt log just means no history this run, not a crash.
// Unbounded growth accepted, same tradeoff already made for
// telegram-unparsed.jsonl (revisit only if it becomes an actual problem).
function loadRecentConversation(conversationLogPath, limit = 6) {
  if (!fs.existsSync(conversationLogPath)) return [];
  try {
    return fs.readFileSync(conversationLogPath, 'utf8').split('\n').filter(Boolean)
      .map((line) => JSON.parse(line))
      .slice(-limit);
  } catch {
    return [];
  }
}

// Fetched once per poll run (2026-08-02), not per dining-tool call — same
// "load context once, pass into pure functions" pattern as favorites/
// financialContext. get_dining_plan uses this to check whether a personal
// calendar already covers an occasion's evening *before* generating a
// suggestion, not just to mention a conflict after the fact. Degrades to an
// empty list — not configured, or a live API hiccup — rather than failing
// the poll; a calendar-awareness feature must never be why the rest of the
// bot stops working.
async function loadCalendarEventsForDining(calendarReadContext) {
  if (!calendarReadContext.configured) return [];
  try {
    return (await getUpcomingEvents({ ...calendarReadContext, days: 7 })).items;
  } catch {
    return [];
  }
}

// Read-only context for the dining tools — tolerates missing files (e.g. a
// test's temp directory that doesn't set these up, or a fresh checkout
// before favorite_places.json has ever been synced) by degrading to an
// empty context rather than throwing; dining tools simply report "no
// suggestion" in that case, same "degrade quietly" convention used
// elsewhere in this project (build-data.mjs, refreshFavoritePlaces()).
// diningRoutine stays the *raw* goals.json routine, deliberately not
// pre-transformed by any override — slotForOccasion resolves the current
// override live from routineOverrides on every call instead, so a
// set_routine_day change is visible immediately even to a later message in
// the same poll batch, not just the next poll cycle.
function loadDiningContext({ goalsPath, favoritePlacesPath }, routineOverrides, calendarEvents = []) {
  let diningRoutine = [];
  let lowKeyHangIdeas = [];
  try {
    const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    diningRoutine = goals.diningRoutine || [];
    lowKeyHangIdeas = goals.lowKeyHangIdeas || [];
  } catch {
    // missing/unparseable goals.json — dining tools just won't have routine slots to match.
  }
  let favorites = [];
  let recentDiningActivity = [];
  try {
    const fp = JSON.parse(fs.readFileSync(favoritePlacesPath, 'utf8'));
    favorites = fp.places || [];
    recentDiningActivity = fp.recentDiningActivity || [];
  } catch {
    // missing/unparseable favorite_places.json — recommendations degrade to "no fresh picks."
  }
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

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

function appendJsonl(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(obj)}${os.EOL}`, 'utf8');
}

function readOffset(offsetPath) {
  if (!fs.existsSync(offsetPath)) return null;
  const state = JSON.parse(fs.readFileSync(offsetPath, 'utf8'));
  return typeof state.next_offset === 'number' ? state.next_offset : null;
}

function saveOffset(offsetPath, nextOffset) {
  writeJson(offsetPath, { next_offset: nextOffset, updated_at: new Date().toISOString() });
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

// Deterministic patterns, tried before any LLM call — fast, free, and the
// vast majority of real usage (adding an item, checking one off) fits one
// of these exactly. Anything that doesn't match falls through to the
// Anthropic tool-calling path in dispatchMessage().
function tryDeterministicParse(text, todos, owner) {
  const trimmed = text.trim();

  let m = trimmed.match(/^(?:new|add):\s*(.+)$/i);
  if (m) return add_todo(todos, { title: m[1], owner });

  m = trimmed.match(/^(\d+)\s+done$/i) || trimmed.match(/^done\s+(\d+)$/i);
  if (m) return TOOL_IMPL.mark_done(todos, { index: parseInt(m[1], 10) });

  m = trimmed.match(/^(\d+)\s*\+(\d+)$/);
  if (m) return TOOL_IMPL.log_weekly_goal_count(todos, { index: parseInt(m[1], 10), delta: parseInt(m[2], 10) });

  if (/^list$/i.test(trimmed) || /^what'?s open$/i.test(trimmed)) {
    return TOOL_IMPL.list_todos(todos, {});
  }

  return null;
}

// Strips the bot's own @mention out of the text so it doesn't confuse
// deterministic parsing (e.g. "@Bot new: buy milk" should parse the same as
// "new: buy milk") — reply-to-message addressing has no such prefix to strip.
function stripMention(text, botUsername) {
  if (!botUsername) return text;
  const re = new RegExp(`@${botUsername}\\b`, 'gi');
  return text.replace(re, '').trim();
}

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Renders recent (sender, message, raw reply) triples as a short transcript
// so Claude can resolve references a follow-up message makes to the prior
// exchange (e.g. "actually make that 6pm" after a dining confirmation).
// Empty string (not a placeholder block) when there's no history yet, so
// the prompt reads the same as before this feature existed.
function formatRecentConversation(entries) {
  if (!entries.length) return '';
  const lines = entries.flatMap((e) => [`[${e.sender}] ${e.text}`, `[Bot] ${e.reply}`]);
  return `Recent conversation (most recent last):\n${lines.join('\n')}\n\n`;
}

// The minimal slice of goals.json's phases relevant to update_phase_expense
// (id/name/period/current expenses) — not the whole file (life goals, chart
// assumptions, etc. aren't needed for this and would just bloat the prompt).
function phasesSummary(goals) {
  if (!goals || !goals.phases) return null;
  return goals.phases.map((p) => ({ id: p.id, name: p.name, period: p.period, expenses: p.expenses }));
}

// Rendered when this message is a reply to a still-open clarifying question
// (see the pending-clarification mechanism in dispatchMessage/runOnce).
// Bundles the original ask, the question, and this new reply so Claude can
// resolve it in one more call — no rigid "must literally answer X" check;
// Claude judges whether this actually answers it, still isn't enough, or is
// really a new, unrelated request. Empty string when nothing's pending, so
// the prompt reads exactly as before this feature existed.
function formatPendingClarification(pendingClarification) {
  if (!pendingClarification) return '';
  return `You previously asked a clarifying question in response to this same conversation: "${pendingClarification.question}" — asked because of their earlier message: "${pendingClarification.originalText}". Decide what their new message below means for that: if it answers your question, call the appropriate tool(s) now using the combined information (don't ask again for something they already told you). If it's still not enough to act safely, ask one more short, specific follow-up question (reply with text only, no tool call). If it's clearly unrelated to your question, ignore the question and just handle the new message on its own.\n\n`;
}

async function callAnthropicFallback({ apiKey, text, todos, monthPlanEvents, diningContext, financialContext, recentConversation = [], goals, pendingClarification = null }) {
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
      tools: TOOL_DEFS,
      system: 'You manage a shared household to-do list, weekly goals, dining plan (family_dinner=Wed, date_night=Fri, weekend_social=Sat by default — see the current dining routine below, since these can be rescheduled), one-off events via add_family_event (kind family=social/spend on Month Plan; kind schedule=appointments Google-Cal-only — classify from the title and pass kind; if ambiguous ask instead of guessing), can answer financial questions (budget pace, savings goals, open decisions), can report what\'s on Kevin\'s and Hanna\'s Google calendars via get_calendar_events (Hanna\'s calendar is shared into Kevin\'s Google account and is already wired for reading — when Hanna asks about her schedule / "my schedule," or Kevin asks about hers, call get_calendar_events; never say you lack access to Hanna\'s calendar; Kevin\'s work calendar is deliberately excluded), and can directly edit the real long-term financial plan (goals.json) over Telegram. The user\'s message is below, along with the current state, today\'s date, and (when available) the last few exchanges in the group — use that recent conversation to resolve references like "that," "it," or unstated context in a follow-up (e.g. if the prior exchange set a specific dining plan and this message says "actually make it 6pm," apply the time to that same plan). Decide which tool (if any) to call. If the message is a question you can answer from the current state without changing anything, call the relevant read-only tool (list_todos, get_dining_plan, get_budget_status, get_savings_goals, get_decisions, get_calendar_events, get_upcoming_shows, search_transactions) and answer conversationally in your final text — do not fabricate data not present in the provided state. If the message asks about upcoming shows, concerts, or comedy nights, call get_upcoming_shows — it checks the household\'s followed venues, not a general search. If asked whether a specific charge/merchant is included in a budget, or for a category\'s individual line items (not just its total), call search_transactions rather than guessing from the aggregate pace numbers alone — it only covers the current cycle, so say so if that is relevant to the answer. Dining plans have two distinct states: a live suggestion (nothing stored, recomputed every time) and a confirmed pick (stored, and eventually pushed to the shared Google Calendar). Only call set_dinner_plan when the user is explicitly confirming or booking a specific choice — never just because they asked what the plan or suggestion is, which is get_dining_plan\'s job. If they mention a time (e.g. "5pm", "7:30") or duration (e.g. "for an hour"), pass them as set_dinner_plan\'s time/durationHours arguments so the Calendar event lands on the right slot instead of a default all-day/2-hour one. For anything that is not one of the 3 dining occasions — an appointment, school event, trip note, dinner with friends, any other one-off — call add_family_event instead, resolving any relative day they gave ("tomorrow", "Thursday", "next Friday") into an explicit YYYY-MM-DD using today\'s date as the anchor; pass kind \"family\" for social/spend plans (shows on Month Plan) or kind \"schedule\" for appointments/logistics (Google Cal only); only pass its time argument if they gave an unambiguous one (explicit AM/PM or 24-hour), since a general event has no "always evening" assumption to fall back on; if they mention it repeats weekly, pass recurrenceWeeks. If they want to reschedule which weekday a routine occasion falls on (e.g. "let\'s move family dinner to Thursdays"), call set_routine_day — this only changes future scheduling, not any already-confirmed plan. Use delete_todo (not mark_done) when the user says a to-do is no longer relevant rather than finished. Use remove_event to cancel a dining plan (by occasion) or a family event (by date, plus a title if more than one event is on that date) — never guess which event they mean if it\'s ambiguous; ask instead. If the message clearly asks for more than one distinct thing (e.g. "add milk to the list and what\'s the budget status"), call more than one tool in this same turn rather than only handling the first. If the message describes a financial/family-planning change with a specific dollar figure (a cost changing, a new recurring expense, a rent increase), call update_phase_expense directly — this REALLY changes the plan, immediately, not a note for later review; use the phases list in context to pick the right phaseId(s) and see current expense labels for renaming. There is no way to store a cost that changes on a future date as a schedule — just set today\'s real current rate, and expect to be asked again when it actually changes. If the ask is narrative rather than a dollar figure (an open question, a decision to track), call log_decision instead. Never just apologize that you can\'t do something financial — one of these two tools almost always applies, and a reasonable default (today\'s date as anchor, a default duration, an existing label) should be used rather than asked about. The one exception: if something you genuinely cannot proceed without is simply absent from the message — no dollar amount at all for a cost change, no way to tell which of several candidates is meant, no indication which phase a change applies to — don\'t guess at it. Reply with a short, specific question naming exactly what\'s missing, and don\'t call any tool yet; you\'ll get the answer as a follow-up message with this same context attached, so you can complete the action then. This is the exception, not the default — most messages have enough to act on immediately. When you reply after taking a real action, only state what you actually did — never invent or promise a review process, notification, or follow-up mechanism that doesn\'t exist; the change already happened, full stop.',
      messages: [
        { role: 'user', content: `${formatPendingClarification(pendingClarification)}${formatRecentConversation(recentConversation)}Today's date: ${isoToday()}\n\nCurrent to-do state:\n${JSON.stringify(todos, null, 2)}\n\nCurrent month plan events:\n${JSON.stringify(monthPlanEvents, null, 2)}\n\nDining routine (for get_dining_plan/set_dinner_plan/set_routine_day — dayOfWeek already reflects any prior reschedule):\n${JSON.stringify(diningContext.diningRoutine, null, 2)}\n\nFinancial context (for get_budget_status/get_savings_goals/get_decisions/search_transactions):\n${JSON.stringify(financialContext, null, 2)}\n\nFinancial plan phases (for update_phase_expense — pick the phaseId(s) this cost applies to; expenses shows current monthly figures):\n${JSON.stringify(phasesSummary(goals), null, 2)}\n\nMessage: ${text}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// get_calendar_events is the only tool that needs a live external API call
// (Google Calendar), so it's handled here rather than via TOOL_IMPL's pure
// in-memory functions. Degrades to a clear, non-crashing reply if reading
// isn't configured yet or the API call fails — a Calendar hiccup must not
// break the rest of the bot's replies.
async function getCalendarEventsReply({ days }, calendarReadContext) {
  if (!calendarReadContext.configured) {
    return "Calendar reading isn't set up yet — run calendar-auth-setup.mjs and configure GOOGLE_READ_CALENDAR_IDS.";
  }
  try {
    const { summary } = await getUpcomingEvents({ ...calendarReadContext, days: days || 7 });
    return summary;
  } catch (err) {
    return "Couldn't reach Google Calendar right now — try again shortly.";
  }
}

const UPCOMING_SHOWS_SYSTEM_PROMPT = 'You are researching upcoming live shows for a household assistant Telegram bot. You will be given a list of specific venues (name and area) the household follows. Use web search to find real upcoming shows/events at these venues within the given day window from today. Prioritize venues tagged area "westside" first, since the household prefers closer options, but include any real find at any venue. For each finding, report: venue name, act/event name, date, and a source URL. If a venue has nothing found, do not mention it — only report what you actually find. If nothing at all turns up, say so plainly. Keep the reply concise — a short list, not prose paragraphs.';

async function callAnthropicUpcomingShows({ apiKey, venues, days }) {
  const venueList = venues.map((v) => `${v.name} (${v.area}) — ${v.address}`).join('\n');
  const today = new Date().toISOString().slice(0, 10);
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      system: UPCOMING_SHOWS_SYSTEM_PROMPT,
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8 }],
      messages: [{ role: 'user', content: `Venues:\n${venueList}\n\nDay window: next ${days} days from today (${today}).` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// get_upcoming_shows is a live external call (a second Anthropic request with
// the hosted web_search tool, scoped to venues_to_follow.json's venue list) —
// same category as get_calendar_events, special-cased in the dispatcher
// rather than a TOOL_IMPL entry. On success, caches the raw findings to disk
// so the dashboard's Dining + Shows tab can display them without making its
// own live search; a failed call leaves any existing cache file untouched
// (stale-but-present beats empty). Degrades to a clear, non-crashing reply on
// failure so a shows-lookup hiccup never breaks the rest of the bot's
// replies.
async function getUpcomingShowsReply({ days }, { apiKey, venuesToFollowPath, upcomingShowsCachePath, showsClient }) {
  let venuesData;
  try {
    venuesData = JSON.parse(fs.readFileSync(venuesToFollowPath, 'utf8'));
  } catch {
    return "Don't have a venue list to check yet — data/venues_to_follow.json is missing or unreadable.";
  }
  const venues = venuesData.venues || [];
  if (!venues.length) return 'No venues on the follow list yet.';
  const resolvedDays = days || 14;
  try {
    const client = showsClient || callAnthropicUpcomingShows;
    const response = await client({ apiKey, venues, days: resolvedDays });
    const text = (response.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    const urls = [];
    for (const block of response.content || []) {
      if (block.type !== 'web_search_tool_result' || !Array.isArray(block.content)) continue;
      for (const result of block.content) {
        if (result.url && !urls.includes(result.url)) urls.push(result.url);
      }
    }
    writeJson(upcomingShowsCachePath, { fetchedAt: new Date().toISOString(), days: resolvedDays, findings: text ? [{ text, urls }] : [] });
    if (!text) return "Didn't find anything for the next couple weeks at our followed venues — try again closer to the date.";
    const sourcesLine = urls.length ? `\n\nSources:\n${urls.slice(0, 6).join('\n')}` : '';
    return `${text}${sourcesLine}`;
  } catch (err) {
    return "Couldn't check upcoming shows right now — try again shortly.";
  }
}

const REPHRASE_SYSTEM_PROMPT = 'You are a warm, concise family assistant replying in a Telegram group. You\'ll be given one or more (user message, raw system result) pairs from a single batch of messages that just arrived together. Compose ONE natural reply covering all of them — preserve every concrete fact exactly (names, places, dates, times, dollar amounts, percentages). If the items are all on the same topic, blend them into one flowing reply; if they\'re clearly separate, unrelated asks, address each with its own short sentence or line so nothing gets lost or merged into a confusing run-on — the reader should be able to tell distinct things happened. No markdown, no headers, no repeating back "as an AI," no filler.';

async function callAnthropicRephrase({ apiKey, items }) {
  const content = items.map((item, i) => `${i + 1}. User said: "${item.userText}"\n   Raw result: ${item.rawReply}`).join('\n\n');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 400,
      system: REPHRASE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// "Default to intelligence every time" (2026-08-01): the whole batch's raw
// replies — one per processed message, whether reached via a fast
// deterministic pattern or an LLM tool call — get composed into ONE natural
// reply together, rather than shown as each tool's raw template string
// (e.g. "Added ✓ (owner: Kevin)") glued together with blank lines. A single
// batch-level call (not one rephrase per message) lets Claude notice
// whether the batch was several distinct asks or one continuous thing and
// address it accordingly — see REPHRASE_SYSTEM_PROMPT. Degrades to a plain
// join of the raw replies, not a thrown error, when no key/client is
// available or the rephrase call itself fails — the underlying actions
// already succeeded; a wording hiccup must never block or obscure that.
// Deliberately a separate, optional rephraseClient/apiKey pathway from
// anthropicClient (which only drives tool *selection*, per-message) so the
// exhaustive tool-behavior test suite can keep asserting on exact raw
// strings (via `sentReplies`, one per message) without needing to mock this
// batch-composition step too.
async function naturalizeBatch({ apiKey, items, rephraseClient }) {
  if (!items.length) return null;
  const plainJoin = () => items.map((i) => i.rawReply).join('\n\n');
  if (!apiKey && !rephraseClient) return plainJoin();
  try {
    const client = rephraseClient || callAnthropicRephrase;
    const llmResponse = await client({ apiKey, items });
    const textBlock = llmResponse.content.find((c) => c.type === 'text');
    return textBlock ? textBlock.text : plainJoin();
  } catch {
    return plainJoin();
  }
}

async function dispatchMessage({ message, owner, todos, monthPlanEvents, routineOverrides, goals, diningContext, financialContext, calendarReadContext, recentConversation, pendingClarification, now, botUsername, apiKey, unparsedPath, goalsChangelogPath, anthropicClient, venuesToFollowPath, upcomingShowsCachePath, showsClient }) {
  const rawText = message.text || '';
  const text = stripMention(rawText, botUsername);

  // Multi-turn clarification (2026-08-02): if this sender has a still-live
  // pending question, this message is treated as answering it — skip
  // deterministic parsing entirely and go straight to the LLM with the
  // original ask + question + this reply bundled together (see
  // formatPendingClarification). A stale/expired one is ignored, same as if
  // nothing were pending.
  const livePending = isClarificationLive(pendingClarification, now) ? pendingClarification : null;

  if (!livePending) {
    const detResult = tryDeterministicParse(text, todos, owner);
    if (detResult) return { todos: detResult.todos, monthPlanEvents, routineOverrides, goals, reply: detResult.reply, pendingClarification: null };
  }

  if (!apiKey && !anthropicClient) {
    appendJsonl(unparsedPath, { at: new Date().toISOString(), text: rawText, reason: 'no_api_key' });
    return { todos, monthPlanEvents, routineOverrides, goals, reply: helpText(rawText), pendingClarification: livePending };
  }

  try {
    const client = anthropicClient || callAnthropicFallback;
    const llmResponse = await client({ apiKey, text, todos, monthPlanEvents, diningContext, financialContext, recentConversation, goals, pendingClarification: livePending });
    // Every tool_use block Claude returned, not just the first — a single
    // message can ask for more than one distinct thing ("add milk to the
    // list and what's the budget status"), and Claude can already express
    // that as multiple tool_use blocks in one response; nothing previously
    // read past the first. Still one request/response turn, not a
    // multi-turn round-trip within a single message — genuine sequential
    // reasoning (call A, react to A's result, decide to call B) is still a
    // deliberate scope cut. "Multi-turn" here means across messages: a
    // clarifying question this turn, resolved by the next message.
    const toolUses = llmResponse.content.filter((c) => c.type === 'tool_use');
    if (!toolUses.length) {
      const textBlock = llmResponse.content.find((c) => c.type === 'text');
      if (!textBlock) {
        appendJsonl(unparsedPath, { at: new Date().toISOString(), text: rawText, reason: 'no_tool_or_text' });
        return { todos, monthPlanEvents, routineOverrides, goals, reply: helpText(rawText), pendingClarification: null };
      }
      // No tool called at all — Claude is asking a (further) clarifying
      // question rather than guessing. originalText anchors back to
      // whatever first triggered this exchange, not just this latest reply,
      // so a multi-round clarification doesn't lose the original ask.
      return {
        todos, monthPlanEvents, routineOverrides, goals,
        reply: textBlock.text,
        pendingClarification: { question: textBlock.text, originalText: livePending ? livePending.originalText : rawText, askedAt: now.toISOString() },
      };
    }

    let newTodos = todos;
    let newMonthPlanEvents = monthPlanEvents;
    let newRoutineOverrides = routineOverrides;
    let newGoals = goals;
    const rawReplies = [];
    let stillNeedsClarification = null;

    for (const toolUse of toolUses) {
      if (toolUse.name === 'get_calendar_events') {
        rawReplies.push(await getCalendarEventsReply(toolUse.input, calendarReadContext));
        continue;
      }
      if (toolUse.name === 'get_upcoming_shows') {
        rawReplies.push(await getUpcomingShowsReply(toolUse.input, { apiKey, venuesToFollowPath, upcomingShowsCachePath, showsClient }));
        continue;
      }
      const impl = TOOL_IMPL[toolUse.name];
      if (!impl) {
        appendJsonl(unparsedPath, { at: new Date().toISOString(), text: rawText, reason: `unknown_tool:${toolUse.name}` });
        continue; // an unrecognized tool in one call of a multi-tool turn shouldn't block the others
      }
      // Each branch reads/writes the running new* state (not the outer
      // todos/monthPlanEvents/routineOverrides) so a second tool call in
      // the same turn sees the first one's effect — e.g. two add_todo
      // calls in one message both land, not just the last.
      if (DINING_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(newMonthPlanEvents, toolUse.input, diningContext);
        newMonthPlanEvents = result.monthPlanEvents;
        rawReplies.push(result.reply);
        if (result.needsClarification) stillNeedsClarification = result.reply;
      } else if (FAMILY_EVENT_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(newMonthPlanEvents, toolUse.input);
        newMonthPlanEvents = result.monthPlanEvents;
        rawReplies.push(result.reply);
        if (result.needsClarification) stillNeedsClarification = result.reply;
      } else if (ROUTINE_OVERRIDE_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(newRoutineOverrides, toolUse.input);
        newRoutineOverrides = result.overrides;
        rawReplies.push(result.reply);
      } else if (GOALS_TOOL_NAMES.has(toolUse.name)) {
        if (!newGoals) {
          rawReplies.push("Couldn't update the plan — goals.json isn't readable right now.");
          continue;
        }
        const result = impl(newGoals, toolUse.input);
        newGoals = result.goals;
        rawReplies.push(result.reply);
        // Traceability, not a review gate — the edit has already happened;
        // this just records what changed and when so it's never a mystery
        // looking back, same reasoning as every git commit message.
        appendGoalsChangelog(goalsChangelogPath, { at: new Date().toISOString(), sender: owner, tool: toolUse.name, input: toolUse.input, reply: result.reply });
      } else if (FINANCIAL_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(financialContext, toolUse.input);
        rawReplies.push(result.reply);
      } else {
        const result = impl(newTodos, toolUse.input, owner);
        newTodos = result.todos;
        rawReplies.push(result.reply);
      }
    }

    if (!rawReplies.length) {
      // every tool_use in this turn was unrecognized
      return { todos: newTodos, monthPlanEvents: newMonthPlanEvents, routineOverrides: newRoutineOverrides, goals: newGoals, reply: helpText(rawText), pendingClarification: null };
    }

    // A tool call itself hit an ambiguity it can't resolve (e.g.
    // remove_event's "2+ events that date, no title" case) — same
    // pending-clarification treatment as Claude declining to call a tool at
    // all, so the next message resolves it instead of dead-ending.
    if (stillNeedsClarification) {
      return {
        todos: newTodos, monthPlanEvents: newMonthPlanEvents, routineOverrides: newRoutineOverrides, goals: newGoals,
        reply: rawReplies.join('\n'),
        pendingClarification: { question: stillNeedsClarification, originalText: livePending ? livePending.originalText : rawText, askedAt: now.toISOString() },
      };
    }

    return { todos: newTodos, monthPlanEvents: newMonthPlanEvents, routineOverrides: newRoutineOverrides, goals: newGoals, reply: rawReplies.join('\n'), pendingClarification: null };
  } catch (err) {
    appendJsonl(unparsedPath, { at: new Date().toISOString(), text: rawText, reason: `llm_error:${err.message}` });
    return { todos, monthPlanEvents, routineOverrides, goals, reply: helpText(rawText), pendingClarification: livePending };
  }
}

// Echoes the original text back so the sender knows what was actually
// received (helps them tell whether it's worth rephrasing vs. a real bug) —
// previously this was a generic message with no indication of what the bot
// thought it heard.
function helpText(rawText) {
  const heard = rawText ? ` (heard: "${rawText}")` : '';
  return `Couldn't process that${heard} — try \`new: <title>\`, \`<n> done\`, \`<n> +<count>\`, \`list\`, or ask a question.`;
}

export async function runOnce(opts) {
  const args = { ...parseArgs([]), ...opts };
  const envValues = args.updatesFixture ? {} : readLocalEnv(args.envPath);
  const token = args.token || envValues.TELEGRAM_BOT_TOKEN;
  const groupChatId = args.groupChatId || envValues.TELEGRAM_GROUP_CHAT_ID;
  const botUsername = args.botUsername || envValues.TELEGRAM_BOT_USERNAME;
  const apiKey = args.apiKey || envValues.ANTHROPIC_API_KEY;

  const owners = fs.existsSync(args.ownersPath) ? JSON.parse(fs.readFileSync(args.ownersPath, 'utf8')) : {};
  const offset = readOffset(args.offsetPath);

  let updatesResponse;
  if (args.updatesFixture) {
    updatesResponse = JSON.parse(fs.readFileSync(args.updatesFixture, 'utf8'));
  } else {
    const body = { timeout: 0 };
    if (offset != null) body.offset = offset;
    updatesResponse = await callTelegram(token, 'getUpdates', body);
  }

  let todos = JSON.parse(fs.readFileSync(args.todosPath, 'utf8'));
  const todosSnapshot = JSON.stringify(todos);
  let monthPlanEvents = loadMonthPlanEvents(args.monthPlanEventsPath);
  const monthPlanEventsSnapshot = JSON.stringify(monthPlanEvents);
  let routineOverrides = loadRoutineOverrides(args.routineOverridesPath);
  const routineOverridesSnapshot = JSON.stringify(routineOverrides);
  let goals = loadGoalsForEditing(args.goalsPath);
  const goalsSnapshot = JSON.stringify(goals);
  let pendingClarifications = loadPendingClarifications(args.pendingClarificationsPath);
  const pendingClarificationsSnapshot = JSON.stringify(pendingClarifications);
  const now = args.now || new Date();
  const calendarReadContext = loadCalendarReadContext(args);
  const calendarEventsForDining = await loadCalendarEventsForDining(calendarReadContext);
  const diningContext = loadDiningContext(args, routineOverrides, calendarEventsForDining);
  const financialContext = loadFinancialContext(args);
  let recentConversation = loadRecentConversation(args.conversationLogPath);
  let maxSafeUpdateId = offset != null ? offset - 1 : null;
  const sentReplies = [];
  const processedTexts = [];
  let lastMessageId = null;

  for (const update of updatesResponse.result) {
    const updateId = update.update_id;
    const message = update.message;

    if (!message || !message.chat || String(message.chat.id) !== String(groupChatId)) {
      maxSafeUpdateId = updateId;
      continue;
    }

    const senderId = message.from ? String(message.from.id) : null;
    const owner = senderId ? owners[senderId] : null;
    if (!owner) {
      maxSafeUpdateId = updateId;
      continue; // unrecognized sender — silently skip rather than guess an owner
    }

    try {
      const result = await dispatchMessage({
        message, owner, todos, monthPlanEvents, routineOverrides, goals, diningContext, financialContext, calendarReadContext, recentConversation, pendingClarification: pendingClarifications[owner] || null, now, botUsername, apiKey, unparsedPath: args.unparsedPath, goalsChangelogPath: args.goalsChangelogPath, anthropicClient: args.anthropicClient, venuesToFollowPath: args.venuesToFollowPath, upcomingShowsCachePath: args.upcomingShowsCachePath, showsClient: args.showsClient,
      });
      todos = result.todos;
      monthPlanEvents = result.monthPlanEvents;
      // set_routine_day mutates the overrides object in place and
      // slotForOccasion resolves the override live (not from a pre-baked
      // diningRoutine snapshot) — so a reschedule is honored by a later
      // message in the very same batch, not just the next poll cycle.
      routineOverrides = result.routineOverrides;
      goals = result.goals;
      // Same load-mutate-writeback pattern as everything else above — a
      // second message from the same sender later in this very same batch
      // already sees the first one's pending question (or its resolution),
      // not just the next poll cycle.
      pendingClarifications = { ...pendingClarifications, [owner]: result.pendingClarification || null };

      const strippedText = stripMention(message.text || '', botUsername);
      sentReplies.push(result.reply);
      processedTexts.push(strippedText);
      lastMessageId = message.message_id;
      maxSafeUpdateId = updateId;

      // Written unconditionally (like telegram-unparsed.jsonl), not gated
      // behind dryRun — and appended in-memory too, so a second message
      // later in this very same batch already sees the first one's
      // exchange, not just the next poll cycle's.
      const conversationEntry = { at: new Date().toISOString(), sender: owner, text: strippedText, reply: result.reply };
      appendJsonl(args.conversationLogPath, conversationEntry);
      recentConversation = [...recentConversation, conversationEntry].slice(-6);
    } catch (err) {
      // Leave the offset before this message so it's retried next run —
      // a failure here must not silently skip a real user message.
      break;
    }
  }

  // One Telegram message per poll batch, not one per processed message, and
  // composed as ONE naturalizeBatch call over every raw reply together
  // (not each message rephrased separately then glued together) — so
  // several distinct asks in the same batch get addressed clearly rather
  // than reading like disjointed, separately-generated sentences. Computed
  // whenever there's anything to say, independent of dryRun, so tests can
  // inspect `combinedReply` without needing a real send; only the actual
  // Telegram call itself is gated. Threaded as a reply only when there was
  // exactly one message (unambiguous); with several, a combined reply isn't
  // "in response to" any one of them specifically, so it's posted as a
  // fresh message instead.
  let combinedReply = null;
  if (sentReplies.length) {
    const items = sentReplies.map((rawReply, i) => ({ userText: processedTexts[i], rawReply }));
    combinedReply = await naturalizeBatch({ apiKey, items, rephraseClient: args.rephraseClient });
  }

  // `args.telegramClient || !args.updatesFixture` mirrors every other
  // injectable-client convention in this project: a fixture-based test can
  // still exercise this real send path by injecting a mock client, but
  // fixture mode with no mock (the common case for tests that don't care
  // about the send itself) never risks a real network call.
  if (combinedReply && !args.dryRun && (args.telegramClient || !args.updatesFixture)) {
    const telegramClient = args.telegramClient || callTelegram;
    await telegramClient(token, 'sendMessage', {
      chat_id: groupChatId,
      text: combinedReply,
      ...(sentReplies.length === 1 ? { reply_to_message_id: lastMessageId } : {}),
    });
  }

  const todosChanged = JSON.stringify(todos) !== todosSnapshot;
  if (todosChanged && !args.dryRun) {
    writeJson(args.todosPath, todos);
    // Derived from todosPath's own directory, not this script's fixed
    // location — so a test run against a temp todosPath (with no
    // build-data.mjs of its own) safely no-ops here instead of silently
    // regenerating the *real* project's data.js from unrelated real data.
    const buildScript = path.join(path.dirname(args.todosPath), 'build-data.mjs');
    if (fs.existsSync(buildScript)) spawnSync(process.execPath, [buildScript], { stdio: 'inherit' });
  }

  // No build-data.mjs regen for month_plan_events.json — unlike todos.json,
  // it's never bundled into data.js; the dashboard reads it live via
  // dashboard-server.mjs's API instead (see Part 2's design). The dashboard
  // server and this poller both write with the same atomic temp-file-then-
  // rename pattern and neither depends on the other running.
  const monthPlanEventsChanged = JSON.stringify(monthPlanEvents) !== monthPlanEventsSnapshot;
  if (monthPlanEventsChanged && !args.dryRun) {
    writeJson(args.monthPlanEventsPath, monthPlanEvents);
  }

  // Read live by the dashboard too (see dashboard-server.mjs's own
  // /api/dining-routine-overrides route) so a bot-side reschedule shows up
  // there without a data.js rebuild — same reasoning as month_plan_events.json.
  const routineOverridesChanged = JSON.stringify(routineOverrides) !== routineOverridesSnapshot;
  if (routineOverridesChanged && !args.dryRun) {
    writeJson(args.routineOverridesPath, routineOverrides);
  }

  // Direct write to the real plan (2026-08-02) — writeJson here is the same
  // atomic temp-file-then-rename write every other file in this project
  // uses; regenerateFromGoals() then follows claude.md's own regeneration
  // rule (build-data.mjs + build-goal-plan-md.mjs) so the dashboard and the
  // narrative doc never drift from what the bot just changed.
  const goalsChanged = goals && JSON.stringify(goals) !== goalsSnapshot;
  if (goalsChanged && !args.dryRun) {
    writeJson(args.goalsPath, goals);
    regenerateFromGoals(args.goalsPath);
  }

  // Not read by the dashboard or anything else — purely the bot's own
  // memory of what it's waiting to hear back on, same atomic write as every
  // other state file here.
  const pendingClarificationsChanged = JSON.stringify(pendingClarifications) !== pendingClarificationsSnapshot;
  if (pendingClarificationsChanged && !args.dryRun) {
    writeJson(args.pendingClarificationsPath, pendingClarifications);
  }

  if (maxSafeUpdateId != null && !args.dryRun) {
    saveOffset(args.offsetPath, maxSafeUpdateId + 1);
  }

  return { todosChanged, monthPlanEventsChanged, routineOverridesChanged, goalsChanged, pendingClarificationsChanged, sentReplies, combinedReply, todos, monthPlanEvents, routineOverrides, goals, pendingClarifications };
}

// Runs as the last step of the same scheduled task, right after the poll —
// one Windows Scheduled Task, not two — so a Month Plan change (via the bot
// or the dashboard) reaches Google Calendar within the same short interval.
// Skips quietly until calendar-auth-setup.mjs has been run once (no env
// file yet), and never lets a Calendar API problem fail the poll itself —
// to-dos/dining are the poll's job and must keep working either way.
async function runCalendarSyncStep() {
  if (!fs.existsSync(CALENDAR_ENV_PATH)) return { skipped: true };
  try {
    return await runCalendarSync({});
  } catch (err) {
    console.error('calendar-sync step failed (poll itself still succeeded):', err.message);
    return { skipped: true, error: err.message };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOnce(args);
  console.log(JSON.stringify({ ok: true, todosChanged: result.todosChanged, repliesSent: result.sentReplies.length }));
  const calendarResult = await runCalendarSyncStep();
  if (!calendarResult.skipped) {
    console.log(JSON.stringify({ ok: true, calendarCreated: calendarResult.created, calendarUpdated: calendarResult.updated, calendarDeleted: calendarResult.deleted }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
