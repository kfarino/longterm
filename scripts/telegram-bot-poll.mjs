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
import { add_todo, TOOL_DEFS, TOOL_IMPL, DINING_TOOL_NAMES, FINANCIAL_TOOL_NAMES, FAMILY_EVENT_TOOL_NAMES, ROUTINE_OVERRIDE_TOOL_NAMES, GOALS_TOOL_NAMES, REMINDER_TOOL_NAMES, HEALTH_TOOL_NAMES, TODO_TOOL_NAMES, MANUAL_CHARGE_TOOL_NAMES, CAPABILITY_TOOL_NAMES } from './telegram-bot-tools.mjs';
import { loadFinancialContext } from './financial-context.mjs';
import { applyManualChargesToTracking, loadTransactionOverrides } from './budget-tracking-pull.mjs';
import { spawnDetachedLauncher } from './claude-code-run.mjs';
import { loadHealthContext, defaultHealthOverridesPath } from './health-context.mjs';
import { defaultOuraStoreDir } from './oura-store.mjs';
import {
  runSync as runCalendarSync,
  isGoogleAuthFailure,
  readCalendarAuthPause,
  writeCalendarAuthPause,
  clearCalendarAuthPause,
  isCalendarAuthPauseActive,
  recordCalendarAuthPauseAlert,
} from './calendar-sync.mjs';
import { shouldAlertForPause, buildPauseAlertText, countUnsyncedEvents, pauseAgeHours } from './calendar-sync-alerts.mjs';
import { loadCalendarReadContext, getUpcomingEvents } from './calendar-read.mjs';
import { googleCalendarEnvPath, telegramEnvPath, telegramPollLogPath, calendarSyncAuthPausePath } from './longterm-paths.mjs';
import {
  mergeFindingsPreservingLivenation,
  discoveryShowsFromFindings,
  rebuildShowsWithLivenation,
} from './shows-cache.mjs';

const CALENDAR_ENV_PATH = googleCalendarEnvPath();
const CALENDAR_AUTH_PAUSE_PATH = calendarSyncAuthPausePath();

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
    ouraStoreDir: defaultOuraStoreDir(),
    healthOverridesPath: defaultHealthOverridesPath(),
    favoritePlacesPath: path.join(repoDataDir, 'favorite_places.json'),
    venuesToFollowPath: path.join(repoDataDir, 'venues_to_follow.json'),
    upcomingShowsCachePath: path.join(repoDataDir, 'upcoming_shows_cache.json'),
    monthPlanEventsPath: path.join(repoDataDir, 'month_plan_events.json'),
    remindersPath: path.join(repoDataDir, 'reminders.json'),
    budgetTrackingPath: path.join(repoDataDir, 'budget_tracking.json'),
    accountsPath: path.join(repoDataDir, 'accounts.json'),
    routineOverridesPath: path.join(repoDataDir, 'dining-routine-overrides.json'),
    conversationLogPath: path.join(repoDataDir, 'telegram-conversation-log.jsonl'),
    goalsChangelogPath: path.join(repoDataDir, 'goals-changelog.jsonl'),
    pendingClarificationsPath: path.join(repoDataDir, 'telegram-pending-clarifications.json'),
    messageAttemptsPath: path.join(repoDataDir, 'telegram-message-attempts.json'),
    transactionOverridesPath: path.join(repoDataDir, 'transaction_overrides.json'),
    capabilityRequestsPath: path.join(repoDataDir, 'bot-capability-requests.json'),
    updatesFixture: null,
    dryRun: false,
    once: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg === '--once') { args.once = true; continue; }
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
      else if (key === 'oura-store-dir') args.ouraStoreDir = value;
      else if (key === 'health-overrides-path') args.healthOverridesPath = value;
      else if (key === 'favorite-places-path') args.favoritePlacesPath = value;
      else if (key === 'venues-to-follow-path') args.venuesToFollowPath = value;
      else if (key === 'upcoming-shows-cache-path') args.upcomingShowsCachePath = value;
      else if (key === 'month-plan-events-path') args.monthPlanEventsPath = value;
      else if (key === 'reminders-path') args.remindersPath = value;
      else if (key === 'budget-tracking-path') args.budgetTrackingPath = value;
      else if (key === 'accounts-path') args.accountsPath = value;
      else if (key === 'routine-overrides-path') args.routineOverridesPath = value;
      else if (key === 'conversation-log-path') args.conversationLogPath = value;
      else if (key === 'goals-changelog-path') args.goalsChangelogPath = value;
      else if (key === 'pending-clarifications-path') args.pendingClarificationsPath = value;
      else if (key === 'message-attempts-path') args.messageAttemptsPath = value;
      else if (key === 'transaction-overrides-path') args.transactionOverridesPath = value;
      else if (key === 'capability-requests-path') args.capabilityRequestsPath = value;
      else if (key === 'updates-fixture') args.updatesFixture = value;
      else if (key === 'max-duration-ms') args.maxDurationMs = Number(value);
      else if (key === 'max-iterations') args.maxIterations = Number(value);
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

// Bot-owned (add_reminder/cancel_reminder), not read/written by anything
// else. Missing/unparseable degrades to no reminders, same convention as
// every other loader here.
function loadReminders(remindersPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(remindersPath, 'utf8'));
    return { ...parsed, items: parsed.items || [] };
  } catch {
    return { items: [] };
  }
}

function loadCapabilityRequests(requestsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
    return { ...parsed, items: parsed.items || [] };
  } catch {
    return { items: [] };
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

async function callAnthropicFallback({ apiKey, text, todos, monthPlanEvents, reminders, diningContext, financialContext, recentConversation = [], goals, pendingClarification = null }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      // Sonnet, not Haiku, for tool SELECTION specifically (2026-08-12). This
      // one call picks among ~23 tools with overlapping trigger conditions
      // (add_todo vs add_reminder, get_dining_plan vs set_dinner_plan,
      // update_phase_expense vs log_decision) and is where "the bot can't do
      // simple things" was actually being decided. The cheap rephrase pass
      // (naturalizeBatch) stays on Haiku — it has one easy job.
      model: 'claude-sonnet-5',
      max_tokens: 1024,
      // Explicitly disabled (2026-08-06) -- see telegram-bot-recap.mjs's own
      // comment on this same fix: claude-sonnet-5 defaults extended thinking
      // on, and tool selection here doesn't need it; left enabled, thinking
      // can consume the whole token budget and leave neither a tool_use nor
      // a text block, degrading every such message to the generic helpText
      // fallback instead of a real reply. Load-bearing on this model.
      thinking: { type: 'disabled' },
      tools: TOOL_DEFS,
      system: BOT_SYSTEM_PROMPT,
      messages: [
        { role: 'user', content: `${formatPendingClarification(pendingClarification)}${formatRecentConversation(recentConversation)}Today's date: ${isoToday()}\n\nCurrent to-do state:\n${JSON.stringify(todos, null, 2)}\n\nCurrent month plan events:\n${JSON.stringify(monthPlanEvents, null, 2)}\n\nCurrent reminders:\n${JSON.stringify(reminders.items.filter((r) => !r.sent), null, 2)}\n\nDining routine (for get_dining_plan/set_dinner_plan/set_routine_day — dayOfWeek already reflects any prior reschedule):\n${JSON.stringify(diningContext.diningRoutine, null, 2)}\n\nFinancial context (for get_budget_status/get_savings_goals/get_decisions/search_transactions):\n${JSON.stringify(financialContext, null, 2)}\n\nFinancial plan phases (for update_phase_expense — pick the phaseId(s) this cost applies to; expenses shows current monthly figures):\n${JSON.stringify(phasesSummary(goals), null, 2)}\n\nMessage: ${text}` },
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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      // Explicitly disabled (2026-08-06) -- see telegram-bot-recap.mjs's own
      // comment on this same fix.
      thinking: { type: 'disabled' },
      system: UPCOMING_SHOWS_SYSTEM_PROMPT,
      // allowed_callers: ['direct'] is required for Haiku 4.5 (2026-08-06) --
      // it doesn't support "programmatic" tool calling, which web_search's
      // hosted tool type defaults to requiring; Sonnet/Opus don't need this
      // but it's harmless to always set.
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 8, allowed_callers: ['direct'] }],
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
    let existing = {};
    if (fs.existsSync(upcomingShowsCachePath)) {
      try {
        existing = JSON.parse(fs.readFileSync(upcomingShowsCachePath, 'utf8'));
      } catch {
        existing = {};
      }
    }
    // Preserve Live Nation promoter tags across an on-demand venue refresh —
    // a full overwrite used to wipe them, which is exactly how the dashboard
    // LN badge disappeared mid-week after someone asked the bot for shows.
    const discoveryFindings = text
      ? [{ text, urls, label: 'venues' }]
      : [];
    const findings = mergeFindingsPreservingLivenation(discoveryFindings, existing);
    const discoveryShows = discoveryShowsFromFindings(findings);
    const shows = rebuildShowsWithLivenation(discoveryShows, { findings, shows: existing.shows });
    writeJson(upcomingShowsCachePath, {
      fetchedAt: new Date().toISOString(),
      days: resolvedDays,
      findings,
      shows,
    });
    if (!text) return "Didn't find anything for the next couple weeks at our followed venues — try again closer to the date.";
    const sourcesLine = urls.length ? `\n\nSources:\n${urls.slice(0, 6).join('\n')}` : '';
    return `${text}${sourcesLine}`;
  } catch (err) {
    return "Couldn't check upcoming shows right now — try again shortly.";
  }
}

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
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      // Explicitly disabled (2026-08-06) -- see telegram-bot-recap.mjs's own
      // comment on this same fix.
      thinking: { type: 'disabled' },
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

async function dispatchMessage({ message, owner, todos, monthPlanEvents, routineOverrides, goals, reminders, transactionOverrides, capabilityRequests, diningContext, financialContext, healthContext, calendarReadContext, recentConversation, pendingClarification, now, botUsername, apiKey, unparsedPath, goalsChangelogPath, anthropicClient, venuesToFollowPath, upcomingShowsCachePath, showsClient, authPausePath }) {
  const rawText = message.text || '';
  const text = stripMention(rawText, botUsername);
  const overridesState = transactionOverrides || { manualCharges: [] };
  const requestsState = capabilityRequests || { items: [] };

  // Multi-turn clarification (2026-08-02): if this sender has a still-live
  // pending question, this message is treated as answering it — skip
  // deterministic parsing entirely and go straight to the LLM with the
  // original ask + question + this reply bundled together (see
  // formatPendingClarification). A stale/expired one is ignored, same as if
  // nothing were pending.
  const livePending = isClarificationLive(pendingClarification, now) ? pendingClarification : null;

  if (!livePending) {
    const detResult = tryDeterministicParse(text, todos, owner);
    if (detResult) return { todos: detResult.todos, monthPlanEvents, routineOverrides, goals, reminders, transactionOverrides: overridesState, capabilityRequests: requestsState, reply: detResult.reply, pendingClarification: null };
  }

  if (!apiKey && !anthropicClient) {
    appendJsonl(unparsedPath, { at: new Date().toISOString(), text: rawText, reason: 'no_api_key' });
    return { todos, monthPlanEvents, routineOverrides, goals, reminders, transactionOverrides: overridesState, capabilityRequests: requestsState, reply: helpText(rawText), pendingClarification: livePending };
  }

  try {
    const client = anthropicClient || callAnthropicFallback;
    const llmResponse = await client({ apiKey, text, todos, monthPlanEvents, reminders, diningContext, financialContext, recentConversation, goals, pendingClarification: livePending });
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
        return { todos, monthPlanEvents, routineOverrides, goals, reminders, transactionOverrides: overridesState, capabilityRequests: requestsState, reply: helpText(rawText), pendingClarification: null };
      }
      // No tool called at all — Claude is asking a (further) clarifying
      // question rather than guessing. originalText anchors back to
      // whatever first triggered this exchange, not just this latest reply,
      // so a multi-round clarification doesn't lose the original ask.
      return {
        todos, monthPlanEvents, routineOverrides, goals, reminders, transactionOverrides: overridesState, capabilityRequests: requestsState,
        reply: textBlock.text,
        pendingClarification: { question: textBlock.text, originalText: livePending ? livePending.originalText : rawText, askedAt: now.toISOString() },
      };
    }

    let newTodos = todos;
    let newMonthPlanEvents = monthPlanEvents;
    let newRoutineOverrides = routineOverrides;
    let newGoals = goals;
    let newReminders = reminders;
    let newOverrides = overridesState;
    let newRequests = requestsState;
    const launchedRequests = [];
    const rawReplies = [];
    let stillNeedsClarification = null;
    // Set when a tool wrote to the Month Plan, i.e. when this turn is about to
    // claim something reached the calendar. runOnce uses it to actually check
    // before saying so, instead of reporting success for an in-memory mutation.
    let touchedCalendar = false;

    for (const toolUse of toolUses) {
      if (toolUse.name === 'get_calendar_events') {
        rawReplies.push(await getCalendarEventsReply(toolUse.input, calendarReadContext));
        continue;
      }
      if (toolUse.name === 'get_upcoming_shows') {
        rawReplies.push(await getUpcomingShowsReply(toolUse.input, { apiKey, venuesToFollowPath, upcomingShowsCachePath, showsClient }));
        continue;
      }
      if (toolUse.name === 'get_sync_status') {
        rawReplies.push(syncStatusReply({ authPausePath, monthPlanEvents: newMonthPlanEvents, now }));
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
        else touchedCalendar = true;
      } else if (FAMILY_EVENT_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(newMonthPlanEvents, toolUse.input);
        newMonthPlanEvents = result.monthPlanEvents;
        rawReplies.push(result.reply);
        if (result.needsClarification) stillNeedsClarification = result.reply;
        else touchedCalendar = true;
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
      } else if (REMINDER_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(newReminders, toolUse.input, owner);
        newReminders = result.reminders;
        rawReplies.push(result.reply);
        if (result.needsClarification) stillNeedsClarification = result.reply;
      } else if (MANUAL_CHARGE_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(newOverrides, toolUse.input, owner);
        newOverrides = result.overrides;
        rawReplies.push(result.reply);
      } else if (CAPABILITY_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(newRequests, toolUse.input, owner);
        newRequests = result.requests;
        rawReplies.push(result.reply);
        if (result.launchedRequest) launchedRequests.push(result.launchedRequest);
      } else if (FINANCIAL_TOOL_NAMES.has(toolUse.name)) {
        // `now` so get_budget_status can say how many days are left in the
        // cycle without reaching for the real clock (tests inject it).
        const result = impl(financialContext, toolUse.input, now);
        rawReplies.push(result.reply);
      } else if (HEALTH_TOOL_NAMES.has(toolUse.name)) {
        // Read-only: answering a question about sleep, never shaping a plan.
        // Deliberately does NOT set diningContext.depletion — only the
        // Thursday recap lets health change a suggestion.
        const result = impl(healthContext);
        rawReplies.push(result.reply);
      } else if (TODO_TOOL_NAMES.has(toolUse.name)) {
        const result = impl(newTodos, toolUse.input, owner);
        newTodos = result.todos;
        rawReplies.push(result.reply);
      } else {
        // Previously the todos branch was the unconditional `else`, so a newly
        // added tool that anyone forgot to put in a name-set would be called
        // with the to-do list as its state and quietly corrupt it. Unroutable
        // is a bug to record, not a to-do to write.
        appendJsonl(unparsedPath, { at: new Date().toISOString(), text: rawText, reason: `unrouted_tool:${toolUse.name}` });
      }
    }

    if (!rawReplies.length) {
      // every tool_use in this turn was unrecognized
      return { todos: newTodos, monthPlanEvents: newMonthPlanEvents, routineOverrides: newRoutineOverrides, goals: newGoals, reminders: newReminders, transactionOverrides: newOverrides, capabilityRequests: newRequests, reply: helpText(rawText), pendingClarification: null };
    }

    // A tool call itself hit an ambiguity it can't resolve (e.g.
    // remove_event's "2+ events that date, no title" case) — same
    // pending-clarification treatment as Claude declining to call a tool at
    // all, so the next message resolves it instead of dead-ending.
    if (stillNeedsClarification) {
      return {
        todos: newTodos, monthPlanEvents: newMonthPlanEvents, routineOverrides: newRoutineOverrides, goals: newGoals, reminders: newReminders, transactionOverrides: newOverrides, capabilityRequests: newRequests,
        reply: rawReplies.join('\n'),
        pendingClarification: { question: stillNeedsClarification, originalText: livePending ? livePending.originalText : rawText, askedAt: now.toISOString() },
        touchedCalendar,
      };
    }

    return { todos: newTodos, monthPlanEvents: newMonthPlanEvents, routineOverrides: newRoutineOverrides, goals: newGoals, reminders: newReminders, transactionOverrides: newOverrides, capabilityRequests: newRequests, launchedRequests, reply: rawReplies.join('\n'), pendingClarification: null, touchedCalendar };
  } catch (err) {
    appendJsonl(unparsedPath, { at: new Date().toISOString(), text: rawText, reason: `llm_error:${err.message}` });
    return { todos, monthPlanEvents, routineOverrides, goals, reminders, transactionOverrides: overridesState, capabilityRequests: requestsState, reply: helpText(rawText), pendingClarification: livePending };
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

// Sectioned rather than one long paragraph (2026-08-12). Same rules as before,
// same wording where the wording was load-bearing — but tool selection happens
// across ~23 tools, and an undifferentiated wall of prose gave every rule equal
// weight, which showed up as the bot picking plausible-but-wrong tools and
// missing the second half of two-part asks. The truthfulness rule is first
// because it is the one that must never lose.
const BOT_SYSTEM_PROMPT = `You manage a shared household's to-do list, weekly goals, dining plan, calendar events, and long-term financial plan, over Telegram, for Kevin and Hanna.

## The rule that outranks everything else
When you reply after taking a real action, state ONLY what actually happened. Never invent or promise a review process, notification, sync, or follow-up mechanism that doesn't exist — your edits are real and immediate, full stop.
Never explain a failure you have not verified. If someone says an event is missing from their calendar, isn't showing up, or that you didn't really add it: call get_sync_status and report what it says. Do NOT guess at causes like calendar visibility settings, app refresh, or a stale event id, and do not re-add an event that is already on the plan to "fix" it.
Do not fabricate data that isn't in the state provided below.

## Reading the message
Today's date, the current state, and the last few exchanges in the group are provided below. Use that recent conversation to resolve references like "that," "it," or unstated context in a follow-up — e.g. if the prior exchange set a dining plan and this message says "actually make it 6pm," apply the time to that same plan.
If the message clearly asks for more than one distinct thing ("add milk to the list and what's the budget status"), call more than one tool in this same turn rather than handling only the first.

## Questions (change nothing)
If the message is a question answerable from current state, call the relevant read-only tool and answer conversationally: list_todos, get_dining_plan, get_budget_status, get_savings_goals, get_decisions, get_calendar_events, get_upcoming_shows, search_transactions, list_reminders, get_sync_status.
- Shows, concerts, comedy nights → get_upcoming_shows (it checks the household's followed venues, not a general search).
- Whether a specific charge/merchant is in a budget, or a category's individual line items → search_transactions, not a guess from aggregate pace numbers. It only covers the current cycle; say so when that matters.
- Anyone's schedule, "my schedule," "what's on the calendar" → get_calendar_events. Hanna's calendar IS readable (shared into Kevin's Google account). Never claim you lack access to it. Kevin's work calendar is deliberately excluded.

## Dining (3 routine occasions: family_dinner, date_night, weekend_social)
Defaults are Wed/Fri/Sat respectively, but see the dining routine in context — they can be rescheduled.
A dining plan has two states: a live suggestion (nothing stored, recomputed each time) and a confirmed pick (stored, pushed to Google Calendar).
- Asked what the plan or suggestion is → get_dining_plan.
- Explicitly confirming or booking a specific choice → set_dinner_plan. Only then.
- If they give a time ("5pm", "7:30") or duration ("for an hour"), pass time/durationHours so the calendar event lands on the right slot instead of a default 2-hour block.
- Moving which weekday a routine occasion falls on ("move family dinner to Thursdays") → set_routine_day. Future scheduling only; it does not touch an already-confirmed plan.

## One-off events (anything that is not one of the 3 dining occasions)
An appointment, school event, trip note, dinner with friends, poker night, any other one-off → add_family_event.
- Resolve relative days ("tomorrow", "Thursday", "next Friday") into an explicit YYYY-MM-DD using today's date as the anchor.
- kind "family" = social/spend (shows on the Month Plan). kind "schedule" = appointments/logistics (Google Calendar only). Classify from the title and pass kind; if genuinely ambiguous, ask.
- Only pass time if they gave an unambiguous one (explicit AM/PM, or 24-hour). A general event has no "always evening" assumption to fall back on.
- If they gave a time range ("7-11"), pass the start as time and the length as durationHours.
- If it repeats weekly, pass recurrenceWeeks.
- Cancelling a dining plan (by occasion) or a family event (by date, plus title if more than one that day) → remove_event. Never guess which event if ambiguous — ask.

## Reminders vs to-dos
"Remind me..." or any request for a reminder → add_reminder, never add_todo.
A to-do sits on the shared Planner list until done. A reminder proactively pings the group once, on its date, and never appears on the Planner list.
"What reminders do we have" → list_reminders. Cancelling one before it fires → cancel_reminder. Never guess which one if several plausibly match — ask.
Use delete_todo (not mark_done) when a to-do is no longer relevant rather than finished.

## Money
Budget and spending questions → get_budget_status. The household cares about **this month's spend**: what's logged, what's left, how many days are left, and whether that's on pace.
Do NOT report travel or trip budgets unless the person explicitly asked about travel, a trip, or a vacation — pass includeTravel only then. Trip budgets are long-horizon and bury the monthly numbers that were actually asked for.
Cash, Venmo, babysitting cash, or any spend that will not come through a credit card / Monarch → add_manual_charge (tracker "joint" or an owner id). That is a real immediate budget line, not a decision note.

## Changing the real financial plan
These tools REALLY change the plan, immediately — there is no review step.
- A change with a specific dollar figure (a cost changing, a new recurring expense, a rent increase) → update_phase_expense. Use the phases list in context to pick the right phaseId(s) and to see current expense labels for renaming.
- There is no way to schedule a cost that changes on a future date. Set today's real current rate and expect to be told again when it actually changes.
- A narrative ask instead of a dollar figure (an open question, a decision to track) → log_decision.
- Cash / out-of-band spend on this cycle's budget → add_manual_charge, never log_decision.

## When you cannot do what they asked
If no existing tool can fulfill a real ask (not a missing dollar amount, not "which of these two events"), call request_capability with the ask, why the current tools fall short, and a proposed code change. That files a request and starts a Claude Code run to add the capability. Do not apologize and stop. Do not dump an unimplemented feature into log_decision.

## Defaults, and the one time to ask instead
Prefer a reasonable default over a question: today's date as anchor, a default duration, an existing label.
Ask only when something you genuinely cannot proceed without is absent — no dollar amount at all for a cost change, no way to tell which of several candidates is meant, no indication which phase applies. Then reply with a short, specific question naming exactly what is missing and call no tool; the answer arrives as a follow-up message with this same context attached, so you can finish the action then.
This is the exception, not the default. Most messages have enough to act on immediately.`;

// How many times one Telegram message may crash dispatch before the batch is
// allowed to move past it. Three is enough to ride out a transient API blip
// while still bounding the damage from a genuinely unprocessable message.
const MAX_MESSAGE_ATTEMPTS = 3;

function bumpMessageAttempts(attemptsPath, updateId) {
  if (!attemptsPath) return 1;
  let counts = {};
  try {
    counts = JSON.parse(fs.readFileSync(attemptsPath, 'utf8'));
  } catch {
    counts = {};
  }
  const next = (Number(counts[updateId]) || 0) + 1;
  counts[updateId] = next;
  // Only the recent tail matters; this file is bookkeeping, not history.
  const keys = Object.keys(counts).sort((a, b) => Number(a) - Number(b));
  if (keys.length > 50) for (const k of keys.slice(0, keys.length - 50)) delete counts[k];
  try {
    writeJson(attemptsPath, counts);
  } catch {
    // Bookkeeping must never be the reason a message fails to process.
  }
  return next;
}

/**
 * Answers "why isn't it on my calendar?" with facts instead of a guess.
 *
 * This tool exists because of a real exchange: told an event wasn't showing up,
 * the bot invented two explanations in a row (check the calendar is visible; a
 * stale event id) while the actual cause — expired Google auth, sync paused for
 * three days — was sitting in a file it never read.
 */
export function syncStatusReply({ authPausePath, monthPlanEvents, now = new Date() }) {
  const pause = readCalendarAuthPause(authPausePath);
  const unsynced = countUnsyncedEvents(monthPlanEvents);
  const backlog = unsynced > 0
    ? ` ${unsynced} saved event${unsynced === 1 ? '' : 's'} ${unsynced === 1 ? 'has' : 'have'} not reached Google yet.`
    : ' Everything saved has reached Google.';

  if (!pause) {
    return `Google Calendar sync is working.${backlog}`;
  }
  const hours = pauseAgeHours(pause, now);
  const downFor = hours >= 24 ? `${Math.round(hours / 24)} day(s)` : `${hours} hour(s)`;
  return [
    `Google Calendar sync is DOWN (auth expired, down for ${downFor}).${backlog}`,
    'Anything I add is saved to the Month Plan but is not reaching your calendars.',
    'Fix on the desktop: node scripts/calendar-auth-setup.mjs --reauth-only',
  ].join(' ');
}

/**
 * Sync right now, for a turn that just wrote an event, so the reply can be
 * about reality. Returns a coarse status rather than the raw result — the
 * reply only needs to know which of three true things to say.
 *
 * Never throws: a calendar problem must not cost the user their reply.
 */
async function syncNowForReply(args) {
  const syncStep = args.calendarSyncStepFn || runCalendarSyncStep;
  try {
    const result = await syncStep({ ...args, logPath: args.logPath || telegramPollLogPath() });
    if (result?.paused) return { state: 'down' };
    if (result?.skipped && result?.error) return { state: 'failed' };
    if (result?.skipped) return { state: 'unconfigured' };
    return { state: 'synced' };
  } catch (err) {
    return { state: 'failed', error: err?.message || String(err) };
  }
}

/**
 * The honest trailing line. `synced` and `unconfigured` add nothing — the
 * former because the tool's own "Added ✓" is now backed by a real write, the
 * latter because a household that never set up Calendar doesn't need to hear
 * about it on every event.
 */
export function calendarCaveatText(status) {
  if (!status) return null;
  if (status.state === 'down') {
    return '⚠️ Saved to the Month Plan, but Google Calendar sync is down right now — this will NOT show up on your calendar until that is fixed. I have flagged it.';
  }
  if (status.state === 'failed') {
    return '⚠️ Saved to the Month Plan, but the sync to Google Calendar did not go through just now. I will retry automatically.';
  }
  return null;
}

export async function runOnce(opts) {
  const args = { ...parseArgs([]), ...opts };
  // Fixture mode skips env entirely. Injected getUpdatesClient tests also
  // pass token/groupChatId explicitly so CI (no ~/.longterm/telegram.env) works.
  const envValues = (args.updatesFixture || args.token != null) ? {} : readLocalEnv(args.envPath);
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
    // timeout defaults to 0 (today's exact short-poll behavior) unless a
    // caller configures a longer one — runPollLoop passes 25.
    const body = { timeout: args.getUpdatesTimeoutSeconds || 0 };
    if (offset != null) body.offset = offset;
    const getUpdatesClient = args.getUpdatesClient || callTelegram;
    updatesResponse = await getUpdatesClient(token, 'getUpdates', body);
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
  let reminders = loadReminders(args.remindersPath);
  const remindersSnapshot = JSON.stringify(reminders);
  let transactionOverrides = loadTransactionOverrides(args.transactionOverridesPath);
  const overridesSnapshot = JSON.stringify(transactionOverrides);
  let capabilityRequests = loadCapabilityRequests(args.capabilityRequestsPath);
  const requestsSnapshot = JSON.stringify(capabilityRequests);
  const pendingLaunches = [];
  const now = args.now || new Date();
  const calendarReadContext = loadCalendarReadContext(args);
  const calendarEventsForDining = await loadCalendarEventsForDining(calendarReadContext);
  const diningContext = loadDiningContext(args, routineOverrides, calendarEventsForDining);
  const financialContext = loadFinancialContext(args);
  // Paths threaded from args, not defaulted — otherwise a test injecting
  // fixture paths would still read this machine's real data/oura/ and
  // goals.json, the same leak calendarEnvPath is guarded against above.
  const healthContext = loadHealthContext({
    now, storeDir: args.ouraStoreDir, overridesPath: args.healthOverridesPath, goalsPath: args.goalsPath,
  });
  let recentConversation = loadRecentConversation(args.conversationLogPath);
  let maxSafeUpdateId = offset != null ? offset - 1 : null;
  const sentReplies = [];
  const processedTexts = [];
  let lastMessageId = null;
  let touchedCalendar = false;

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
        message, owner, todos, monthPlanEvents, routineOverrides, goals, reminders, transactionOverrides, capabilityRequests, diningContext, financialContext, healthContext, calendarReadContext, recentConversation, pendingClarification: pendingClarifications[owner] || null, now, botUsername, apiKey, unparsedPath: args.unparsedPath, goalsChangelogPath: args.goalsChangelogPath, anthropicClient: args.anthropicClient, venuesToFollowPath: args.venuesToFollowPath, upcomingShowsCachePath: args.upcomingShowsCachePath, showsClient: args.showsClient, authPausePath: args.authPausePath || CALENDAR_AUTH_PAUSE_PATH,
      });
      if (result.touchedCalendar) touchedCalendar = true;
      todos = result.todos;
      monthPlanEvents = result.monthPlanEvents;
      // set_routine_day mutates the overrides object in place and
      // slotForOccasion resolves the override live (not from a pre-baked
      // diningRoutine snapshot) — so a reschedule is honored by a later
      // message in the very same batch, not just the next poll cycle.
      routineOverrides = result.routineOverrides;
      goals = result.goals;
      reminders = result.reminders;
      transactionOverrides = result.transactionOverrides || transactionOverrides;
      capabilityRequests = result.capabilityRequests || capabilityRequests;
      if (result.launchedRequests?.length) pendingLaunches.push(...result.launchedRequests);
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
      // Leave the offset before this message so it's retried next run — a
      // failure here must not silently skip a real user message.
      //
      // But "retry forever" is its own failure: this catch used to discard
      // `err` entirely and break, so a message that reliably threw would block
      // every later message indefinitely with no trace anywhere. Record it,
      // and after MAX_MESSAGE_ATTEMPTS give up on that one message and let the
      // batch move past it, rather than wedging the whole bot on it.
      const attempts = bumpMessageAttempts(args.messageAttemptsPath, updateId);
      appendJsonl(args.unparsedPath, {
        at: new Date().toISOString(),
        text: message.text || '',
        reason: `dispatch_error:${err?.message || err}`,
        updateId,
        attempts,
      });
      if (attempts >= MAX_MESSAGE_ATTEMPTS) {
        appendPollLog(args.logPath || telegramPollLogPath(), `giving up on update ${updateId} after ${attempts} failed attempts: ${err?.message || err}`);
        maxSafeUpdateId = updateId; // advance past the poison message
        continue;
      }
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
  // Persisted BEFORE the reply is composed, because the calendar sync below
  // reads this file — and because a reply that says an event is on the
  // calendar has to be a statement about something that actually happened.
  // Previously this write came after the send, and sync ran later still, in
  // the loop; there was no ordering in which "Added ✓" could have been checked.
  const monthPlanEventsChanged = JSON.stringify(monthPlanEvents) !== monthPlanEventsSnapshot;
  if (monthPlanEventsChanged && !args.dryRun) {
    writeJson(args.monthPlanEventsPath, monthPlanEvents);
  }

  // Only for turns that actually wrote an event — a budget question shouldn't
  // pay for a Calendar round-trip.
  let calendarStatus = null;
  if (touchedCalendar && monthPlanEventsChanged && !args.dryRun) {
    calendarStatus = await syncNowForReply(args);
  }

  let combinedReply = null;
  if (sentReplies.length) {
    const items = sentReplies.map((rawReply, i) => ({ userText: processedTexts[i], rawReply }));
    combinedReply = await naturalizeBatch({ apiKey, items, rephraseClient: args.rephraseClient });
    // Appended AFTER naturalizeBatch on purpose: that step rewrites replies
    // through an LLM, and a caveat about a broken integration is exactly the
    // kind of hedge a "make this sound natural" pass likes to smooth away.
    // This sentence has to survive verbatim.
    const caveat = calendarCaveatText(calendarStatus);
    if (caveat) combinedReply = `${combinedReply}\n\n${caveat}`;
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

  // (month_plan_events.json is written earlier, before the reply is composed —
  // see the sync-verified reply block above. No build-data.mjs regen for it:
  // unlike todos.json it's never bundled into data.js; the dashboard reads it
  // live via dashboard-server.mjs's API instead.)

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

  // Bot-owned reminder store -- same atomic write as every other state file
  // here. Delivery (scanning for due reminders and sending them) is a
  // separate daily job (telegram-bot-reminders.mjs); this poller only ever
  // creates/lists/cancels.
  const remindersChanged = JSON.stringify(reminders) !== remindersSnapshot;
  if (remindersChanged && !args.dryRun) {
    writeJson(args.remindersPath, reminders);
  }

  const overridesChanged = JSON.stringify(transactionOverrides) !== overridesSnapshot;
  if (overridesChanged && !args.dryRun) {
    writeJson(args.transactionOverridesPath, transactionOverrides);
    // Patch the live cycle view so get_budget_status / the dashboard see
    // the cash charge before tomorrow's Monarch pull rebuilds this file.
    // Dedup inside applyManualChargesToTracking makes re-applying the full
    // list safe. A missing/unreadable tracking file must not fail the poll.
    try {
      if (fs.existsSync(args.budgetTrackingPath)) {
        const tracking = JSON.parse(fs.readFileSync(args.budgetTrackingPath, 'utf8'));
        applyManualChargesToTracking(tracking, transactionOverrides.manualCharges);
        writeJson(args.budgetTrackingPath, tracking);
        const buildScript = path.join(path.dirname(args.budgetTrackingPath), 'build-data.mjs');
        if (fs.existsSync(buildScript)) spawnSync(process.execPath, [buildScript], { stdio: 'inherit' });
      }
    } catch (err) {
      appendPollLog(args.logPath || telegramPollLogPath(), `manual charge tracking patch failed: ${err.message || err}`);
    }
  }

  const requestsChanged = JSON.stringify(capabilityRequests) !== requestsSnapshot;
  if ((requestsChanged || pendingLaunches.length) && !args.dryRun) {
    for (const item of pendingLaunches) {
      const live = capabilityRequests.items.find((i) => i.id === item.id);
      if (live) live.status = 'launched';
    }
    writeJson(args.capabilityRequestsPath, capabilityRequests);
    const launch = args.capabilityLaunchFn || spawnDetachedLauncher;
    for (const item of pendingLaunches) {
      try {
        launch({ requestId: item.id, requestsPath: args.capabilityRequestsPath });
      } catch (err) {
        appendPollLog(args.logPath || telegramPollLogPath(), `capability launch failed (${item.id}): ${err.message || err}`);
        const live = capabilityRequests.items.find((i) => i.id === item.id);
        if (live) live.status = 'open';
        writeJson(args.capabilityRequestsPath, capabilityRequests);
      }
    }
  }

  if (maxSafeUpdateId != null && !args.dryRun) {
    saveOffset(args.offsetPath, maxSafeUpdateId + 1);
  }

  return { todosChanged, monthPlanEventsChanged, routineOverridesChanged, goalsChanged, pendingClarificationsChanged, remindersChanged, overridesChanged, requestsChanged, sentReplies, combinedReply, todos, monthPlanEvents, routineOverrides, goals, pendingClarifications, reminders, transactionOverrides, capabilityRequests };
}

function appendPollLog(logPath, message) {
  const line = `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${message}${os.EOL}`;
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, line, 'utf8');
}

// Wraps runOnce() in a long-poll loop instead of the old "one short getUpdates
// call, then exit" cadence. Each iteration passes getUpdatesTimeoutSeconds
// into getUpdates, so Telegram holds the connection open and returns the
// instant a message arrives rather than after a fixed short interval — this
// is the entire mechanism behind "near-instant" pickup.
//
// Exits after maxDurationMs (15 min in production) rather than running
// forever: this project is edited often, and a truly-forever process would
// keep running stale code until someone remembered to restart it by hand.
// Task Scheduler's -MultipleInstances IgnoreNew setting (see
// install-telegram-scheduled-task.ps1) relaunches it within a minute either
// way — clean self-refresh or an unhandled crash look the same to the
// scheduler, and both self-heal without any code here needing to know which
// one happened.
//
// A thrown error in EITHER the message-dispatch step or the calendar-sync
// step is caught, logged, and the loop continues to the next iteration —
// unlike the old short-lived process (where a thrown error just killed that
// invocation and the next 2-minute tick tried again fresh), a persistent
// process cannot let one transient failure cost the whole 15-minute window.
export async function runPollLoop(opts = {}) {
  const {
    maxDurationMs = 15 * 60 * 1000,
    maxIterations = Infinity,
    getUpdatesTimeoutSeconds = 25,
    calendarSyncFn = runCalendarSyncStep,
    logPath = telegramPollLogPath(),
    now = () => Date.now(),
    ...runOnceOpts
  } = opts;

  const startedAt = now();
  let iteration = 0;
  appendPollLog(logPath, `loop start (max ${Math.round(maxDurationMs / 60000)} min)`);

  while (iteration < maxIterations && (now() - startedAt) < maxDurationMs) {
    iteration += 1;
    try {
      const result = await runOnce({ ...runOnceOpts, getUpdatesTimeoutSeconds });
      appendPollLog(logPath, `iteration ${iteration}: ${result.sentReplies.length} repl(y/ies) sent`);
    } catch (err) {
      appendPollLog(logPath, `iteration ${iteration} ERROR: ${err.message || err}`);
    }
    try {
      // runOnceOpts carries the telegram env path / injected clients, which the
      // sync step needs so a pause can actually reach the group chat.
      const calResult = await calendarSyncFn({ ...runOnceOpts, logPath });
      if (!calResult.skipped) {
        appendPollLog(logPath, `iteration ${iteration} calendar sync: +${calResult.created} ~${calResult.updated} -${calResult.deleted}`);
      }
    } catch (err) {
      appendPollLog(logPath, `iteration ${iteration} calendar sync ERROR: ${err.message || err}`);
    }
  }

  appendPollLog(logPath, `loop exiting after ${iteration} iteration${iteration === 1 ? '' : 's'}`);
  return { iterations: iteration };
}

// Runs as the last step of the same scheduled task, right after the poll —
// one Windows Scheduled Task, not two — so a Month Plan change (via the bot
// or the dashboard) reaches Google Calendar within the same short interval.
// Skips quietly until calendar-auth-setup.mjs has been run once (no env
// file yet), and never lets a Calendar API problem fail the poll itself —
// to-dos/dining are the poll's job and must keep working either way.
//
// invalid_grant / revoked refresh tokens back off rather than stopping dead: we
// write a pause file under ~/.longterm/ carrying a `retryAfter`, so we're not
// hammering Google every ~25s (which flashed a node.exe window), but sync still
// retries on an escalating 6h/12h/24h schedule and heals itself the moment the
// token works again. The previous version checked the pause *before* every
// attempt and cleared it only *after* a success, which made it unreachable by
// construction — sync stayed dead for three days and told nobody.
//
// Two things must therefore always happen on a pause: it must expire, and it
// must be audible (Telegram alert on first failure, then at most daily).
export async function runCalendarSyncStep(opts = {}) {
  const envPath = opts.envPath || CALENDAR_ENV_PATH;
  const pausePath = opts.authPausePath || CALENDAR_AUTH_PAUSE_PATH;
  const logPath = opts.logPath || telegramPollLogPath();
  const syncFn = opts.syncFn || (() => runCalendarSync({}));
  const now = opts.now instanceof Date ? opts.now : new Date();
  const alertFn = opts.alertFn || defaultPauseAlert;

  if (!fs.existsSync(envPath)) return { skipped: true };

  const existingPause = readCalendarAuthPause(pausePath);
  if (isCalendarAuthPauseActive(existingPause, now)) {
    // Logged every time, not once ever. The single "PAUSED" line the old code
    // wrote scrolled out of a log that appends a heartbeat every 25 seconds,
    // so "is sync working?" had no answer anywhere.
    appendPollLog(logPath, `calendar sync paused until ${existingPause.retryAfter} (auth): ${existingPause.reason}`);
    await maybeAlertPaused({ pause: existingPause, pausePath, logPath, alertFn, now, opts });
    return { skipped: true, paused: true, retryAfter: existingPause.retryAfter };
  }

  try {
    const result = await syncFn();
    if (existingPause) appendPollLog(logPath, 'calendar sync RECOVERED — auth working again, pause cleared');
    clearCalendarAuthPause(pausePath);
    return result;
  } catch (err) {
    const message = err?.message || String(err);
    if (isGoogleAuthFailure(err)) {
      const pause = writeCalendarAuthPause(pausePath, message, { now, previous: existingPause });
      appendPollLog(logPath, `calendar sync PAUSED (auth, failure #${pause.failureCount}, retry after ${pause.retryAfter}): ${message} — fix with: node scripts/calendar-auth-setup.mjs --reauth-only`);
      await maybeAlertPaused({ pause, pausePath, logPath, alertFn, now, opts });
      return { skipped: true, paused: true, error: message, retryAfter: pause.retryAfter };
    }
    appendPollLog(logPath, `calendar sync ERROR: ${message}`);
    return { skipped: true, error: message };
  }
}

// A failure to alert must never fail the poll, and must never fail the sync
// step either — same containment rule the sync step itself lives under.
async function maybeAlertPaused({ pause, pausePath, logPath, alertFn, now, opts }) {
  if (!shouldAlertForPause(pause, now)) return;
  try {
    const monthPlanDoc = readMonthPlanForAlert(opts.monthPlanEventsPath);
    const text = buildPauseAlertText(pause, { unsyncedCount: countUnsyncedEvents(monthPlanDoc), now });
    await alertFn(text, opts);
    recordCalendarAuthPauseAlert(pausePath, now);
    appendPollLog(logPath, 'calendar sync pause alert sent to Telegram');
  } catch (err) {
    appendPollLog(logPath, `calendar sync pause alert FAILED to send: ${err?.message || err}`);
  }
}

function readMonthPlanForAlert(monthPlanEventsPath) {
  const target = monthPlanEventsPath || path.join(repoDataDir, 'month_plan_events.json');
  try {
    return JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    return { events: {} };
  }
}

// Resolves the bot token the same way runOnce does (the telegram env file),
// rather than process.env — the scheduled task doesn't export these.
async function defaultPauseAlert(text, opts = {}) {
  const envValues = opts.updatesFixture ? {} : readLocalEnv(opts.envPath || telegramEnvPath());
  const token = opts.token || envValues.TELEGRAM_BOT_TOKEN;
  const chatId = opts.groupChatId || envValues.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) throw new Error('no telegram token/chat id available for pause alert');
  const client = opts.telegramClient || callTelegram;
  await client(token, 'sendMessage', { chat_id: chatId, text });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.once) {
    const result = await runOnce(args);
    console.log(JSON.stringify({ ok: true, todosChanged: result.todosChanged, repliesSent: result.sentReplies.length }));
    const calendarResult = await runCalendarSyncStep();
    if (!calendarResult.skipped) {
      console.log(JSON.stringify({ ok: true, calendarCreated: calendarResult.created, calendarUpdated: calendarResult.updated, calendarDeleted: calendarResult.deleted }));
    }
    return;
  }
  const loopResult = await runPollLoop(args);
  console.log(JSON.stringify({ ok: true, iterations: loopResult.iterations }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
