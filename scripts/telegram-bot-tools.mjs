// Finances/Longterm/scripts/telegram-bot-tools.mjs
// Plain functions operating on a parsed todos.json object. Imported by both
// telegram-bot-poll.mjs's deterministic-parse path and its Anthropic
// tool-calling fallback path — one implementation, two ways to reach it, so
// behavior can never drift between "typed a recognized pattern" and "asked
// in free text and Claude picked the same tool."
//
// Every function takes (todos, args) and returns { todos, reply } — todos is
// the (possibly mutated) object to persist, reply is the Telegram message
// text to send back. Callers own reading/writing the file; these functions
// are pure over the in-memory object so they're trivially testable without
// touching disk.
//
// Dining-planning tools (get_dining_plan/set_dinner_plan, added 2026-07-31)
// follow the same pure-function shape but operate on a monthPlanEvents
// object instead of todos, plus a read-only diningContext bundle
// ({ diningRoutine, favorites, recentDiningActivity, lowKeyHangIdeas }) —
// kept as a distinct call shape rather than forcing them into the todos
// tools' (todos, args, owner) signature, since they genuinely need
// different inputs. telegram-bot-poll.mjs's dispatch branches on which
// shape a given tool name expects.
import { slotForOccasion, recommendForSlot, TIER_MIDPOINT } from './dining-recommendation.mjs';

// Financial Q&A tools (get_budget_status/get_savings_goals/get_decisions,
// added 2026-07-31) are read-only over a financialContext bundle (see
// scripts/financial-context.mjs) — a third distinct call shape alongside
// todos and dining, for the same reason: genuinely different inputs, no
// value in forcing one uniform signature.
function fmtMoney(n) { return '$' + Math.round(n).toLocaleString(); }

function isoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function daysAgo(dateStr) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const then = new Date(dateStr); then.setHours(0, 0, 0, 0);
  return Math.floor((today - then) / 86400000);
}

function fmtItem(item, index) {
  const age = daysAgo(item.dateAdded);
  const ageLabel = age <= 0 ? 'today' : age === 1 ? '1 day ago' : `${age} days ago`;
  const deadline = item.deadline ? `, due ${item.deadline}` : '';
  const status = item.done ? ' [done]' : '';
  return `${index + 1}. ${item.title}${status} (${item.owner}, added ${ageLabel}${deadline})`;
}

function fmtGoal(goal, index) {
  return `G${index + 1}. ${goal.title}: ${goal.count}/${goal.target} ${goal.unit} this week (${goal.owner})`;
}

export function listOpenItems(todos) {
  return todos.items.filter((i) => !i.done);
}

export function add_todo(todos, { title, owner }) {
  if (!title || !title.trim()) {
    return { todos, reply: "Couldn't add that — missing a title." };
  }
  const item = { title: title.trim(), owner, dateAdded: isoToday(), deadline: null, done: false };
  todos.items.push(item);
  return { todos, reply: `Added ✓ (owner: ${owner.charAt(0).toUpperCase() + owner.slice(1)})` };
}

export function mark_done(todos, { index }) {
  const openItems = listOpenItems(todos);
  const item = openItems[index - 1];
  if (!item) {
    const list = openItems.length
      ? openItems.map((i, idx) => fmtItem(i, idx)).join('\n')
      : 'Nothing open right now.';
    return { todos, reply: `No open item #${index}. Current list:\n${list}` };
  }
  item.done = true;
  return { todos, reply: `Marked done ✓: ${item.title}` };
}

// Actually removes the item, unlike mark_done — for "never mind, that's not
// happening" rather than "that's finished." Same 1-indexed-among-open-items
// addressing as mark_done, since that's the list a person is looking at
// when they say "delete #2."
export function delete_todo(todos, { index }) {
  const openItems = listOpenItems(todos);
  const item = openItems[index - 1];
  if (!item) {
    const list = openItems.length
      ? openItems.map((i, idx) => fmtItem(i, idx)).join('\n')
      : 'Nothing open right now.';
    return { todos, reply: `No open item #${index}. Current list:\n${list}` };
  }
  todos.items.splice(todos.items.indexOf(item), 1);
  return { todos, reply: `Deleted ✓: ${item.title}` };
}

export function log_weekly_goal_count(todos, { index, delta }) {
  const goal = todos.weeklyGoals[index - 1];
  if (!goal) {
    const list = todos.weeklyGoals.length
      ? todos.weeklyGoals.map((g, idx) => fmtGoal(g, idx)).join('\n')
      : 'No weekly goals set.';
    return { todos, reply: `No weekly goal #${index}. Current goals:\n${list}` };
  }
  goal.count = Math.max(0, goal.count + delta);
  return { todos, reply: `${goal.title}: ${goal.count}/${goal.target} ${goal.unit} this week` };
}

export function list_todos(todos) {
  const openItems = listOpenItems(todos);
  const itemsText = openItems.length
    ? openItems.map((i, idx) => fmtItem(i, idx)).join('\n')
    : 'Nothing open right now.';
  const goalsText = todos.weeklyGoals.length
    ? todos.weeklyGoals.map((g, idx) => fmtGoal(g, idx)).join('\n')
    : 'No weekly goals set.';
  return { todos, reply: `Open items:\n${itemsText}\n\nWeekly goals:\n${goalsText}` };
}

const OCCASION_LABEL = { family_dinner: 'Family dinner', date_night: 'Date night', weekend_social: 'Weekend social' };

// Accepts whatever loose time string the LLM passes through ("5", "5pm",
// "5:30", "17:00") and normalizes to 24-hour "HH:MM", or null if it can't be
// parsed at all (a booking without a clear time just stays untimed — an
// all-day Calendar event, not a failure). Every occasion this tool handles
// is an evening one, so a bare hour with no am/pm ("5", "7") is assumed PM —
// nobody is booking family dinner at 5am.
function parseTimeToHHMM(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const period = m[3] ? m[3].toLowerCase() : null;
  if (period === 'pm' && hour < 12) hour += 12;
  else if (period === 'am' && hour === 12) hour = 0;
  else if (!period && hour >= 1 && hour <= 11) hour += 12;
  if (hour > 23 || hour < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// Same shape as parseTimeToHHMM but never assumes am/pm for a bare hour —
// general family events have no "always evening" pattern the way dining
// occasions do, so an ambiguous "9" (could be 9am or 9pm) is left untimed
// rather than risking the wrong half of the day. Only an explicit am/pm, or
// an hour already unambiguous in 24-hour form (13-23, or 0 for midnight),
// resolves to a time.
function parseGeneralTimeToHHMM(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  const period = m[3] ? m[3].toLowerCase() : null;
  if (period === 'pm' && hour < 12) hour += 12;
  else if (period === 'am' && hour === 12) hour = 0;
  else if (!period && !(hour === 0 || hour >= 13)) return null;
  if (hour > 23 || hour < 0 || minute > 59) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// Clamped to a sane range (15 min .. 8 hours) so a stray/misread value from
// the LLM can't produce a degenerate or day-spanning Calendar block;
// undefined/unparseable falls through to calendar-sync.mjs's own 2-hour
// default rather than storing a bad value.
function parseDurationHours(input) {
  if (input == null) return undefined;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(8, Math.max(0.25, n));
}

function formatHHMMForDisplay(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'pm' : 'am';
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}${period}` : `${h12}:${String(m).padStart(2, '0')}${period}`;
}

// The next upcoming date (today or later) landing on the given weekday —
// mirrors planRemainingMonth()'s own forward-walk convention in
// dashboard_v5.html, so "what's the plan for Wednesday" always means the
// nearest one, never a past occurrence.
function nextDateForDayOfWeek(dayOfWeek, from = new Date()) {
  const d = new Date(from); d.setHours(0, 0, 0, 0);
  const delta = (dayOfWeek - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Mirrors dashboard_v5.html's resolveEventFields(): a matched favorite auto-
// fills cost/tier from its own observed spend (or the manual fallback tier
// if unproven); a matched low-key idea costs 0; free text falls back to
// TIER_MIDPOINT for a manually-implied tier (defaulting to 'mid' since the
// bot's set_dinner_plan tool doesn't collect an explicit tier from the LLM).
// kind: 'dining' tags every event this produces so set_dinner_plan can tell
// its own picks apart from an unrelated add_family_event on the same date
// (see set_dinner_plan below) — dashboard_v5.html's own resolveEventFields()
// has no such tag, since the dashboard only ever manages dining events today.
function resolveEventFields(name, favorites, lowKeyHangIdeas) {
  const favorite = favorites.find((f) => f.name === name);
  if (favorite) {
    const cost = favorite.observed ? favorite.observed.avgSpend : TIER_MIDPOINT.mid;
    const tier = favorite.observed ? favorite.observed.tier : 'mid';
    return { source: 'manual', kind: 'dining', name, favoriteName: name, tier, cost };
  }
  if (lowKeyHangIdeas.includes(name)) {
    return { source: 'manual', kind: 'dining', name, tier: 'low-key', cost: 0 };
  }
  return { source: 'manual', kind: 'dining', name, tier: 'mid', cost: TIER_MIDPOINT.mid };
}

// A personal-calendar event only counts as "covering" a dining occasion if
// it's timed at or after this hour (2026-08-02) — an untimed/all-day event,
// or one earlier in the day (e.g. a 9am appointment), doesn't mean the
// evening is spoken for, and shouldn't suppress a real dining suggestion.
const EVENING_COVERAGE_HOUR = 16;

// Checked *before* generating a suggestion, not appended after — Kevin was
// explicit this shouldn't just be a heads-up bolted onto a suggestion that
// gets made regardless. Returns the matching calendar entries (one-off,
// evening, same date) or null. calendarEvents is diningContext's optional
// structured list from calendar-read.mjs's getUpcomingEvents; omitted
// entirely (or no match) behaves exactly as before this feature existed.
// Recurring events are excluded (2026-08-02, found against real data): a
// daily/weekly personal-routine block (e.g. a standing "Eat" reminder every
// evening) isn't a special commitment that should suppress a dining
// suggestion — only a genuine one-off evening event counts as coverage.
function findEveningCalendarCoverage(date, calendarEvents) {
  if (!calendarEvents || !calendarEvents.length) return null;
  const matches = calendarEvents.filter((e) => e.date === date && !e.isRecurring && e.time && parseInt(e.time.split(':')[0], 10) >= EVENING_COVERAGE_HOUR);
  return matches.length ? matches : null;
}

// Read-only — reports the already-decided event for the next occurrence of
// this occasion if one exists, otherwise a live suggestion (same heuristic
// the dashboard's own calendar uses, via the ported recommendForSlot()).
// extraExcludeNames (2026-08-02): lets a caller generating several
// suggestions in one pass — e.g. the weekly recap's diningSummary(), which
// calls this once per occasion — exclude names it already suggested for a
// different occasion moments ago, so all 3 occasions don't independently
// converge on the same top-scored favorite. Purely additive: any existing
// caller that omits it behaves exactly as before.
export function get_dining_plan(monthPlanEvents, { occasion, now = null }, diningContext, extraExcludeNames = new Set()) {
  const slot = slotForOccasion(occasion, diningContext.diningRoutine, diningContext.routineOverrides);
  if (!slot) return { monthPlanEvents, reply: `I don't recognize "${occasion}" as a dining occasion.` };
  const label = OCCASION_LABEL[occasion] || occasion;
  // `now` defaults to the real clock, but a caller that pins a date (the recap,
  // and any test injecting a fixed `now`) needs it to reach the date math, not
  // just the surrounding bundle.
  const date = nextDateForDayOfWeek(slot.dayOfWeek, now || new Date());
  const existing = monthPlanEvents.events[date];
  if (existing && existing.length) {
    const names = existing.map((e) => `${e.name || e.favoriteName}${e.time ? ` at ${formatHHMMForDisplay(e.time)}` : ''}`).join(', ');
    return { monthPlanEvents, reply: `${label} (${date}) is already set: ${names}`, date, suggestedName: null };
  }
  const coverage = findEveningCalendarCoverage(date, diningContext.calendarEvents);
  if (coverage) {
    const names = coverage.map((c) => `${c.label}: ${c.title}`).join('; ');
    return { monthPlanEvents, reply: `${label} (${date}) looks already covered — ${names} that evening. No fresh suggestion generated — say the word if you still want one.`, date, suggestedName: null };
  }
  const alreadyUsedNames = new Set([
    ...Object.values(monthPlanEvents.events).flat().map((e) => e.favoriteName || e.name).filter(Boolean),
    ...extraExcludeNames,
  ]);
  // Sleep depletion sends the weekend low-key. Deliberately limited to
  // date_night (+1 day from a Thursday) and weekend_social (+2) —
  // family_dinner resolves six days out, which would be forecasting next week
  // from this week's sleep. Only the recap ever sets depletion; the
  // interactive bot and the dashboard pass nothing and are unaffected.
  const { depletion } = diningContext;
  const swappable = occasion === 'date_night' || occasion === 'weekend_social';
  const depleted = Boolean(depletion?.depleted) && swappable;
  const effectiveSlot = depleted ? { ...slot, tier: 'low-key' } : slot;
  const lowKeyReason = depleted
    ? `${depletion.displayName || depletion.ownerId} is depleted — ${depletion.reason}. A low-key hang instead of a paid outing.`
    : null;
  const rec = recommendForSlot(effectiveSlot, diningContext.favorites, diningContext.recentDiningActivity, diningContext.lowKeyHangIdeas, alreadyUsedNames, lowKeyReason);
  const pick = rec.picks[0];
  const reply = pick
    ? `${label} (${date}) isn't set yet — suggestion: ${pick}. (${rec.reasoning})`
    : `${label} (${date}) isn't set yet, and I don't have a fresh suggestion — ${rec.reasoning}`;
  return { monthPlanEvents, reply, date, suggestedName: pick || null };
}

// Writes the chosen pick into monthPlanEvents for the next occurrence of
// this occasion (or an explicit date, if given) — same file
// dashboard-server.mjs's API reads, so a dashboard refresh shows it
// immediately. Replaces any existing *dining* event(s) on that date (kind:
// 'dining', matching the dashboard's own single-event-per-slot convention
// for routine days) but preserves anything else already stored there — e.g.
// a add_family_event entry for the same date shouldn't vanish just because
// a dining plan was confirmed for that day too. This is the only dining
// tool that ever writes — get_dining_plan's suggestions are never
// persisted, so a suggestion can never accidentally reach the shared
// Calendar; only a call here (an explicit confirmation) can. An optional
// time (any loose format — "5pm", "17:00") becomes the Calendar event's
// actual time slot via calendar-sync.mjs; omitted, the event stays an
// untimed all-day entry.
export function set_dinner_plan(monthPlanEvents, { occasion, date, pick, time, durationHours }, diningContext) {
  const slot = slotForOccasion(occasion, diningContext.diningRoutine, diningContext.routineOverrides);
  if (!slot) return { monthPlanEvents, reply: `I don't recognize "${occasion}" as a dining occasion.` };
  if (!pick || !pick.trim()) return { monthPlanEvents, reply: "Couldn't set that — missing a place/plan name." };
  const label = OCCASION_LABEL[occasion] || occasion;
  const resolvedDate = date || nextDateForDayOfWeek(slot.dayOfWeek);
  const resolvedTime = parseTimeToHHMM(time);
  const resolvedDuration = parseDurationHours(durationHours);
  const event = { ...resolveEventFields(pick.trim(), diningContext.favorites, diningContext.lowKeyHangIdeas), time: resolvedTime, ...(resolvedDuration ? { durationHours: resolvedDuration } : {}) };
  const keptNonDining = (monthPlanEvents.events[resolvedDate] || []).filter((e) => e.kind !== 'dining');
  monthPlanEvents.events[resolvedDate] = [...keptNonDining, event];
  const timeLabel = resolvedTime ? ` at ${formatHHMMForDisplay(resolvedTime)}` : '';
  return { monthPlanEvents, reply: `Set ✓ ${label} (${resolvedDate}${timeLabel}): ${pick.trim()}` };
}

// Classify one-off events as schedule (appointments — Google Cal / not on
// Month Plan spend view) vs family (social/spend-relevant — shows on Month
// Plan). Returns null when ambiguous so the bot asks instead of guessing
// into the budget calendar.
export function classifyEventKind(title) {
  const t = String(title || '').toLowerCase();
  if (!t.trim()) return null;
  const schedulePatterns = [
    /\bpt\b/, /physical therapy/, /pediatrician/, /dentist/, /doctor/, /appointment/,
    /\bpickup\b/, /\bdrop[- ]?off\b/, /\bschool\b/, /\bucla\b/, /\bstudy\b/,
    /\blesson\b/, /\bclass\b/, /vaccine/, /checkup/, /check-up/, /orthodont/,
    /\btherapy\b/, /specialist/, /\bexam\b/, /\bhearing\b/, /\bvision\b/,
    /\bhaircut\b/, /\boil change\b/, /\bdmv\b/, /\bpassport\b/,
  ];
  const familyPatterns = [
    /\bdinner\b/, /\blunch\b/, /\bbrunch\b/, /\bpizza\b/, /\bbirthday\b/,
    /\bparty\b/, /\bdrinks\b/, /\bhang\b/, /\bbbq\b/, /\bcookout\b/,
    /\bfriends\b/, /\bcoffee\b/, /\bbreakfast\b/,
  ];
  const isSchedule = schedulePatterns.some((p) => p.test(t));
  const isFamily = familyPatterns.some((p) => p.test(t));
  if (isSchedule && !isFamily) return 'schedule';
  if (isFamily && !isSchedule) return 'family';
  return null;
}

// General one-off (or weekly-recurring) events beyond the 3 dining occasions.
// kind 'family' = social/spend (Month Plan + Google); kind 'schedule' =
// appointment/logistics (Google only — hidden from Month Plan budget view).
// Always cost:0/tier:'low-key' so appointments never inflate social budget
// even if somehow shown. Recurrence materializes N concrete weekly events.
export function add_family_event(monthPlanEvents, { date, title, time, recurrenceWeeks, durationHours, kind }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { monthPlanEvents, reply: "Couldn't add that — need a specific date (YYYY-MM-DD)." };
  }
  if (!title || !title.trim()) {
    return { monthPlanEvents, reply: "Couldn't add that — missing a title." };
  }
  const trimmedTitle = title.trim();
  let resolvedKind = kind === 'schedule' || kind === 'family' ? kind : null;
  if (!resolvedKind) resolvedKind = classifyEventKind(trimmedTitle);
  if (!resolvedKind) {
    return {
      monthPlanEvents,
      reply: `Is "${trimmedTitle}" a social/spend plan (shows on Month Plan) or just scheduling (Google Cal only)? Say which and I'll add it.`,
      needsClarification: true,
    };
  }
  const resolvedTime = parseGeneralTimeToHHMM(time);
  const resolvedDuration = parseDurationHours(durationHours);
  const weeks = Math.max(1, Math.min(52, parseInt(recurrenceWeeks, 10) || 1));
  const recurrenceId = weeks > 1 ? `${date}|${trimmedTitle.toLowerCase()}` : null;
  let lastDate = date;
  for (let w = 0; w < weeks; w += 1) {
    const d = new Date(`${date}T00:00:00`);
    d.setDate(d.getDate() + w * 7);
    const occDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const event = { source: 'manual', kind: resolvedKind, name: trimmedTitle, tier: 'low-key', cost: 0, time: resolvedTime, ...(resolvedDuration ? { durationHours: resolvedDuration } : {}), ...(recurrenceId ? { recurrenceId } : {}) };
    monthPlanEvents.events[occDate] = [...(monthPlanEvents.events[occDate] || []), event];
    lastDate = occDate;
  }
  const timeLabel = resolvedTime ? ` at ${formatHHMMForDisplay(resolvedTime)}` : '';
  const kindLabel = resolvedKind === 'schedule' ? 'schedule' : 'social';
  const reply = weeks > 1
    ? `Added ✓ ${trimmedTitle}${timeLabel} (${kindLabel}), weekly for ${weeks} weeks starting ${date} (through ${lastDate})`
    : `Added ✓ ${trimmedTitle} (${date}${timeLabel}, ${kindLabel})`;
  return { monthPlanEvents, reply };
}

// Cancels a dining plan or family event. Occasion resolves like
// get_dining_plan/set_dinner_plan (next occurrence's date, kind:'dining'
// entries only, so an unrelated family event on that date survives).
// Otherwise an explicit date is required; a title narrows which event on
// that date to remove (substring match), and is required whenever more than
// one event sits on that date — this never guesses which one the user
// meant. Leaves events[date] = [] once emptied (the existing "explicitly
// dismissed, don't regenerate" tombstone convention), never deletes the key.
export function remove_event(monthPlanEvents, { occasion, date, title }, diningContext) {
  let resolvedDate = date;
  let onlyKind = null;
  if (occasion) {
    const slot = slotForOccasion(occasion, diningContext.diningRoutine, diningContext.routineOverrides);
    if (!slot) return { monthPlanEvents, reply: `I don't recognize "${occasion}" as a dining occasion.` };
    resolvedDate = nextDateForDayOfWeek(slot.dayOfWeek);
    onlyKind = 'dining';
  }
  if (!resolvedDate) return { monthPlanEvents, reply: "Couldn't remove that — need a date or occasion." };

  const events = monthPlanEvents.events[resolvedDate] || [];
  const eligible = events.map((e, i) => ({ e, i })).filter(({ e }) => !onlyKind || e.kind === onlyKind);
  if (!eligible.length) {
    const label = occasion ? (OCCASION_LABEL[occasion] || occasion) : 'that date';
    return { monthPlanEvents, reply: `Nothing set for ${label} (${resolvedDate}) to remove.` };
  }

  let toRemove;
  if (title && title.trim()) {
    const needle = title.trim().toLowerCase();
    toRemove = eligible.filter(({ e }) => (e.favoriteName || e.name || '').toLowerCase().includes(needle));
    if (!toRemove.length) {
      const names = eligible.map(({ e }) => e.favoriteName || e.name).join(', ');
      return { monthPlanEvents, reply: `Couldn't find "${title}" on ${resolvedDate}. Current: ${names}` };
    }
  } else if (eligible.length === 1) {
    toRemove = eligible;
  } else {
    const names = eligible.map(({ e }) => e.favoriteName || e.name).join(', ');
    return { monthPlanEvents, reply: `Multiple events on ${resolvedDate}: ${names}. Say which one to remove.`, needsClarification: true };
  }

  const removeIndexes = new Set(toRemove.map(({ i }) => i));
  const removedNames = toRemove.map(({ e }) => e.favoriteName || e.name).join(', ');
  monthPlanEvents.events[resolvedDate] = events.filter((_, i) => !removeIndexes.has(i));
  return { monthPlanEvents, reply: `Removed ✓ ${removedNames} (${resolvedDate})` };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Changes which weekday a routine dining occasion falls on. Writes to a
// small, bot-owned override object (persisted to
// data/dining-routine-overrides.json by the caller) rather than goals.json
// itself — goals.json stays exclusively hand-maintained (per claude.md);
// this is the one place the bot is allowed to change an operational
// schedule detail. dining-recommendation.mjs's effectiveDiningRoutine()
// applies this override everywhere a day-of-week matters (the bot's own
// tools, the weekly recap, and the dashboard's calendar, which fetches this
// same file live) so all three never disagree about which day is which.
export function set_routine_day(overrides, { occasion, dayOfWeek }) {
  if (!(occasion in OCCASION_LABEL)) {
    return { overrides, reply: `I don't recognize "${occasion}" as a dining occasion.` };
  }
  if (typeof dayOfWeek !== 'number' || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return { overrides, reply: "Couldn't set that — need a day of week (0=Sunday .. 6=Saturday)." };
  }
  overrides[occasion] = dayOfWeek;
  return { overrides, reply: `${OCCASION_LABEL[occasion]} moved to ${DAY_NAMES[dayOfWeek]}s.` };
}

// Directly updates (or adds) one expense line item in one phase of
// goals.json's planning assumptions — e.g. a childcare cost changing from
// $700/wk to $275/wk, a rent increase, a new recurring cost. Writes
// straight into goals.json (2026-08-02: Kevin explicitly rejected the
// earlier "capture to a side file for manual review" design — he wants the
// bot changing real files directly, not routed through a person). Amount is
// always a flat monthly dollar figure, matching every existing expense line
// in this file (there's no schedule/date-range concept in the schema — a
// rate that changes mid-phase just means updating the figure again when it
// changes, same "current rate, not a projection" convention already used
// for e.g. "Au pair (starts Aug 2026)"). `renameFrom`, if given, removes the
// old key so a label change (e.g. "Nanny" -> "Au pair") doesn't leave a
// stale duplicate line behind. The caller (telegram-bot-poll.mjs) is
// responsible for persisting goals, regenerating data.js/the goal-plan doc
// (the same regeneration rule every other goals.json edit follows), and
// appending to data/goals-changelog.jsonl for traceability — this function
// only mutates the in-memory object.
export function update_phase_expense(goals, { phaseId, expenseKey, renameFrom, amount }) {
  const phase = goals.phases.find((p) => p.id === phaseId);
  if (!phase) {
    return { goals, reply: `Couldn't find phase ${phaseId}. Valid phase ids: ${goals.phases.map((p) => p.id).join(', ')}.` };
  }
  if (!expenseKey || !expenseKey.trim()) {
    return { goals, reply: "Couldn't update that — missing an expense label." };
  }
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    return { goals, reply: "Couldn't update that — need a valid monthly dollar amount." };
  }
  if (renameFrom && renameFrom !== expenseKey && phase.expenses[renameFrom] != null) {
    delete phase.expenses[renameFrom];
  }
  const rounded = Math.round(amount);
  phase.expenses[expenseKey.trim()] = rounded;
  return { goals, reply: `Updated ✓ Phase ${phaseId} (${phase.name}): "${expenseKey.trim()}" = $${rounded.toLocaleString()}/mo.` };
}

// Directly appends a narrative decision/open-question to goals.json's
// `decisions` array — for a financial/family-planning ask that isn't a
// specific dollar figure (update_phase_expense's job) but still needs to
// live in the real plan, not a side file. Same direct-write principle as
// update_phase_expense. `summary` is expected to already be Claude's own
// structured extraction of the concrete details — this just stores it.
export function log_decision(goals, { title, summary, status }) {
  if (!title || !title.trim()) {
    return { goals, reply: "Couldn't add that — missing a short title." };
  }
  if (!summary || !summary.trim()) {
    return { goals, reply: "Couldn't add that — missing a summary of what this decision is about." };
  }
  const resolvedStatus = ['urgent', 'active', 'watch', 'good'].includes(status) ? status : 'active';
  goals.decisions.push({ status: resolvedStatus, title: title.trim(), body: summary.trim(), action: 'Review and refine as part of the real plan.' });
  return { goals, reply: `Added ✓ to the plan's open decisions: "${title.trim()}".` };
}

// --- Reminders (2026-08-05) ---
// A one-off timed nudge the bot proactively announces once, on its date --
// NOT a persistent household chore (see todos.json's own family-only scope).
// Call shape (reminders, args, owner?), a new distinct shape alongside
// todos/monthPlanEvents/overrides/goals/financialContext -- see
// REMINDER_TOOL_NAMES below for how telegram-bot-poll.mjs's dispatcher
// routes to it. Delivery itself (scanning for due reminders and sending
// them) lives in the separate scripts/telegram-bot-reminders.mjs daily job
// -- these functions only ever create/list/cancel, never send.

function nextReminderId(reminders) {
  const max = reminders.items.reduce((m, r) => {
    const n = parseInt(String(r.id).slice(1), 10);
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `r${max + 1}`;
}

export function add_reminder(reminders, { text, date, owner }) {
  if (!text || !text.trim()) {
    return { reminders, reply: "Couldn't set that reminder — missing what to remind you about." };
  }
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { reminders, reply: "Couldn't set that reminder — need a specific date (YYYY-MM-DD)." };
  }
  const item = { id: nextReminderId(reminders), text: text.trim(), date, owner: owner || null, createdAt: new Date().toISOString(), sent: false, sentAt: null };
  reminders.items.push(item);
  return { reminders, reply: `Reminder set ✓ for ${date}: ${item.text}` };
}

export function list_reminders(reminders) {
  const open = reminders.items.filter((r) => !r.sent).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!open.length) return { reminders, reply: 'No upcoming reminders.' };
  const lines = open.map((r) => `${r.date}: ${r.text}${r.owner ? ` (${r.owner})` : ''}`);
  return { reminders, reply: `Upcoming reminders:\n${lines.join('\n')}` };
}

// Matches by case-insensitive substring on text (+ exact date if given, to
// disambiguate) -- same shape as remove_event's own matching, including the
// same "never guess, ask instead" handling for more than one match.
export function cancel_reminder(reminders, { text, date }) {
  if (!text || !text.trim()) {
    return { reminders, reply: "Couldn't cancel that — missing which reminder you mean." };
  }
  const needle = text.trim().toLowerCase();
  const open = reminders.items.filter((r) => !r.sent);
  const matches = open.filter((r) => r.text.toLowerCase().includes(needle) && (!date || r.date === date));
  if (!matches.length) {
    return { reminders, reply: `Couldn't find an upcoming reminder like "${text}".` };
  }
  if (matches.length > 1) {
    const names = matches.map((r) => `${r.date}: ${r.text}`).join(', ');
    return { reminders, reply: `Multiple reminders match "${text}": ${names}. Say which one to cancel.`, needsClarification: true };
  }
  const [match] = matches;
  reminders.items = reminders.items.filter((r) => r.id !== match.id);
  return { reminders, reply: `Cancelled ✓: ${match.text} (was ${match.date})` };
}

// Tool names whose implementation operates on a reminders object, not
// todos/monthPlanEvents/overrides/goals/financialContext -- a distinct call
// shape telegram-bot-poll.mjs's dispatch branches on the same way it already
// does for ROUTINE_OVERRIDE_TOOL_NAMES/GOALS_TOOL_NAMES.
export const REMINDER_TOOL_NAMES = new Set(['add_reminder', 'list_reminders', 'cancel_reminder']);

// Read-only — reports joint/personal pace (on/over, and by how much) plus
// travel trip actuals-vs-budgeted. financialContext.budgetStatus is
// pre-computed by scripts/financial-context.mjs (loadBudgetStatus), the
// same math the dashboard's Joint/personal trackers use.
export function get_budget_status(financialContext) {
  const { joint, personal, travel } = financialContext.budgetStatus;
  const paceLine = (label, t) => {
    if (!t) return `${label}: no data yet.`;
    const pace = t.variance > 0 ? 'over pace' : 'on pace';
    return `${label}: ${fmtMoney(t.total)} logged, projected ${fmtMoney(t.projected)} vs ${fmtMoney(t.target)} target (${pace}, ${t.variance >= 0 ? '+' : ''}${fmtMoney(t.variance)}).`;
  };
  const personalLines = Object.values(personal || {})
    .map((p) => paceLine(p.label || p.displayName || 'Personal', p))
    .join('\n');
  const travelLines = (travel || []).length
    ? travel.map((t) => `${t.label}: ${fmtMoney(t.actual)}${t.budgetedAmount != null ? ` / ${fmtMoney(t.budgetedAmount)}` : ' (already paid)'}`).join('\n')
    : 'No active trips.';
  return { reply: `${paceLine(joint?.label || 'Joint', joint)}${personalLines ? `\n${personalLines}` : ''}\n\nTravel:\n${travelLines}` };
}

// Read-only — reports every savings goal's progress percentage.
// financialContext.savingsGoals is pre-computed by financial-context.mjs
// (loadSavingsGoals), including the live-brokerage special case for the
// Croatia goal.
export function get_savings_goals(financialContext) {
  const lines = financialContext.savingsGoals.map(
    (g) => `${g.name}: ${fmtMoney(g.current)} / ${fmtMoney(g.targetAmount)} (${g.pct}%)`
  );
  return { reply: lines.length ? lines.join('\n') : 'No savings goals found.' };
}

// Read-only — reports open decisions, urgent ones first.
export function get_decisions(financialContext) {
  const decisions = financialContext.decisions || [];
  const urgent = decisions.filter((d) => d.status === 'urgent');
  const other = decisions.filter((d) => d.status !== 'urgent');
  const fmt = (d) => `[${d.status}] ${d.title} — ${d.action}`;
  const lines = [...urgent, ...other].map(fmt);
  return { reply: lines.length ? lines.join('\n') : 'No open decisions.' };
}

// Read-only — looks up individual current-cycle line items by merchant
// and/or tracker. financialContext.transactions is pre-flattened by
// scripts/financial-context.mjs (loadTransactionDetail) from the same
// per-category/per-trip detail budget_tracking.json already carries for the
// current cycle — no older history, no live Monarch call. The reply always
// states that scope explicitly so the bot never implies it checked further
// back than it did.
export function search_transactions(financialContext, { merchant, tracker } = {}) {
  let rows = financialContext.transactions || [];
  if (merchant && merchant.trim()) {
    const needle = merchant.trim().toLowerCase();
    rows = rows.filter((r) => r.merchant && r.merchant.toLowerCase().includes(needle));
  }
  if (tracker) {
    rows = rows.filter((r) => (tracker === 'personal' ? r.tracker.startsWith('personal:') : r.tracker === tracker));
  }
  const header = 'Current-cycle line items only (no earlier history):';
  if (!rows.length) return { reply: `${header}\nNo matching current-cycle transactions found.` };
  // A refund/credit row (financial-context.mjs's loadTransactionDetail tags
  // these with type: 'refund') is stored as a positive amount just like a
  // spend row — marked distinctly here (a "+" prefix and a trailing
  // "(refund)") so the reply never reads as if money went out when it
  // actually came back.
  const lines = rows.map((r) => (r.type === 'refund'
    ? `${r.group} (${r.tracker}): ${r.merchant} — +${fmtMoney(r.amount)} (refund) on ${r.date}`
    : `${r.group} (${r.tracker}): ${r.merchant} — ${fmtMoney(r.amount)} on ${r.date}`));
  return { reply: `${header}\n${lines.join('\n')}` };
}

// Tool names whose implementation is read-only over a financialContext
// bundle (budget pace, savings goals, decisions, transaction line items) —
// telegram-bot-poll.mjs's dispatch branches on this set the same way it
// already does for DINING_TOOL_NAMES.
export const FINANCIAL_TOOL_NAMES = new Set(['get_budget_status', 'get_savings_goals', 'get_decisions', 'search_transactions']);

// Read-only over a healthContext bundle (see scripts/health-context.mjs) — a
// fourth distinct call shape alongside todos, dining and financial, for the
// same reason as the others: genuinely different inputs, no value in forcing
// one uniform signature. Reports both owners; this is a shared group chat that
// already surfaces budget and todos the same way.
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

// telegram-bot-poll.mjs's dispatch branches on this set the same way it
// already does for FINANCIAL_TOOL_NAMES.
export const HEALTH_TOOL_NAMES = new Set(['get_health_status']);

// Tool names whose implementation writes to monthPlanEvents directly by an
// explicit date, with no diningContext/occasion involved — a third distinct
// call shape from DINING_TOOL_NAMES's (monthPlanEvents, args, diningContext).
export const FAMILY_EVENT_TOOL_NAMES = new Set(['add_family_event']);

// Tool names whose implementation writes to a small dining-routine-overrides
// object (persisted to data/dining-routine-overrides.json by the caller,
// never to goals.json — see set_routine_day) — a fifth distinct call shape,
// (overrides, args), with no todos/monthPlanEvents/diningContext involved.
export const ROUTINE_OVERRIDE_TOOL_NAMES = new Set(['set_routine_day']);

// Tool names whose implementation writes directly into goals.json (2026-08-02:
// direct writes, not a side review file — see update_phase_expense's own
// comment) — call shape (goals, args), no todos/monthPlanEvents/diningContext
// involved. The caller persists goals.json, regenerates data.js/the goal-plan
// doc, and appends to goals-changelog.jsonl.
export const GOALS_TOOL_NAMES = new Set(['update_phase_expense', 'log_decision']);

// Tool definitions in Anthropic Messages API shape, for the LLM-fallback
// path. Kept alongside the implementations so the two can't drift apart
// (a new tool always needs both an entry here and a case in TOOL_IMPL).
export const TOOL_DEFS = [
  {
    name: 'add_todo',
    description: 'Add a new action item to the shared to-do list.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The to-do item text.' },
      },
      required: ['title'],
    },
  },
  {
    name: 'mark_done',
    description: 'Mark an existing open to-do item as done, by its 1-indexed position in the current open-items list.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '1-indexed position among currently open items.' },
      },
      required: ['index'],
    },
  },
  {
    name: 'delete_todo',
    description: 'Permanently remove an open to-do item (not just mark it done) — use when the user says it\'s no longer relevant, e.g. "never mind #2" or "delete the AC one," rather than finished.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '1-indexed position among currently open items.' },
      },
      required: ['index'],
    },
  },
  {
    name: 'log_weekly_goal_count',
    description: 'Add to (or subtract from) a weekly goal\'s progress count, by its 1-indexed position in the weekly goals list.',
    input_schema: {
      type: 'object',
      properties: {
        index: { type: 'integer', description: '1-indexed position among weekly goals.' },
        delta: { type: 'integer', description: 'Amount to add (can be negative to correct a mistake).' },
      },
      required: ['index', 'delta'],
    },
  },
  {
    name: 'list_todos',
    description: 'List all currently open to-do items and weekly goal progress.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_dining_plan',
    description: 'Report the dining plan for the next occurrence of a routine occasion (family dinner, date night, or weekend social) — either what\'s already decided, or a fresh suggestion if nothing is set yet.',
    input_schema: {
      type: 'object',
      properties: {
        occasion: { type: 'string', enum: ['family_dinner', 'date_night', 'weekend_social'], description: 'Which routine dining occasion to report on.' },
      },
      required: ['occasion'],
    },
  },
  {
    name: 'set_dinner_plan',
    description: 'Confirm/book the dining plan for the next occurrence of a routine occasion at a specific place or plan. Only call this when the user is explicitly confirming or booking a choice (e.g. "let\'s do X", "book X", "confirm X for Wednesday") — never merely because they asked what the plan or suggestion is; use get_dining_plan for that. A confirmed plan here is what gets pushed to the shared Google Calendar — a suggestion from get_dining_plan never is.',
    input_schema: {
      type: 'object',
      properties: {
        occasion: { type: 'string', enum: ['family_dinner', 'date_night', 'weekend_social'], description: 'Which routine dining occasion to set.' },
        pick: { type: 'string', description: 'The place name or plan to set (matched against known favorites if it names one).' },
        time: { type: 'string', description: 'Time of day for the reservation/plan, if the user gave one (e.g. "5pm", "5:30", "17:00"). Omit if no time was mentioned — the plan is then untimed (an all-day Calendar entry) rather than guessed.' },
        durationHours: { type: 'number', description: 'How long the reservation/plan runs, in hours (e.g. 1.5 for 90 minutes), if the user gave one. Omit for the default 2-hour Calendar block.' },
      },
      required: ['occasion', 'pick'],
    },
  },
  {
    name: 'add_family_event',
    description: 'Add a one-off event on a specific date that is NOT one of the 3 routine dining occasions (use set_dinner_plan for those). Classify with kind: "family" = social/spend (dinner with friends, birthday party — shows on Month Plan budget calendar); "schedule" = appointment/logistics (PT, pediatrician, school pickup — Google Calendar only, hidden from Month Plan). Prefer passing kind yourself from the user\'s wording; if truly ambiguous, omit kind and the tool will ask. Requires an explicit date: resolve relative days ("tomorrow", "Thursday") into YYYY-MM-DD using today from context.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'The event date as YYYY-MM-DD, resolved from whatever the user said using the current date in context.' },
        title: { type: 'string', description: 'A short description of the event.' },
        kind: { type: 'string', enum: ['family', 'schedule'], description: 'family = social/spend (Month Plan); schedule = appointment (Google Cal only). Omit only if ambiguous — the tool will ask rather than guess.' },
        time: { type: 'string', description: 'Time of day, only if the user gave an unambiguous one (explicit AM/PM, e.g. "9am", or 24-hour like "14:30"). Omit entirely if ambiguous (e.g. a bare "9") or not mentioned — do not guess AM/PM for a general event.' },
        recurrenceWeeks: { type: 'integer', description: 'If the user said this repeats weekly (e.g. "every Tuesday for the next 2 months"), how many weekly occurrences to create starting from date. Omit entirely for a one-off event.' },
        durationHours: { type: 'number', description: 'How long the event runs, in hours (e.g. 0.5 for 30 minutes), if the user gave one. Omit for the default 2-hour Calendar block.' },
      },
      required: ['date', 'title'],
    },
  },
  {
    name: 'set_routine_day',
    description: 'Change which weekday one of the 3 routine dining occasions falls on (e.g. move family dinner from Wednesday to Thursday). This only changes the schedule going forward, not any already-confirmed plan.',
    input_schema: {
      type: 'object',
      properties: {
        occasion: { type: 'string', enum: ['family_dinner', 'date_night', 'weekend_social'], description: 'Which routine occasion to reschedule.' },
        dayOfWeek: { type: 'integer', description: 'The new day of week: 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.' },
      },
      required: ['occasion', 'dayOfWeek'],
    },
  },
  {
    name: 'update_phase_expense',
    description: 'Directly set (or add) one monthly expense line item in a specific phase of the real long-term financial plan (goals.json\'s phases) — e.g. a childcare cost changing rate, a rent increase, a new recurring cost. This is a REAL, immediate change to the plan, not a note for later review. The current phases (with their current expense figures) are given in context below — pick the phaseId(s) this cost actually applies to right now (a rate that will change again on a future date should just be set to today\'s real current rate; you\'ll be asked to update it again when it actually changes — there\'s no way to store a future scheduled change, only the current figure). Use renameFrom when relabeling an existing line (e.g. "Nanny" becoming "Au pair") so the old key doesn\'t linger alongside the new one. If a cost applies across more than one phase, call this tool once per phase.',
    input_schema: {
      type: 'object',
      properties: {
        phaseId: { type: 'integer', description: 'Which phase this expense belongs to, from the phases list in context.' },
        expenseKey: { type: 'string', description: 'The expense line\'s label, e.g. "Nanny (cash)" or "Food budget increase (from Oct 23, 2026)".' },
        renameFrom: { type: 'string', description: 'If this replaces an existing line under a different label, its old exact key — so the stale key gets removed. Omit for a brand-new line.' },
        amount: { type: 'number', description: 'The monthly dollar amount for this line (a weekly rate should be converted to monthly: weekly * 52 / 12).' },
      },
      required: ['phaseId', 'expenseKey', 'amount'],
    },
  },
  {
    name: 'log_decision',
    description: 'Directly add a narrative open decision/question to the real long-term plan (goals.json\'s decisions list) — for a financial/family-planning ask that isn\'t a specific dollar figure (use update_phase_expense for that) but still needs to be part of the real plan, not a side note. Compose title and summary yourself: extract and structure the concrete detail, the same way you\'d naturally break a request into bullet points.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'A short title for this decision/open question.' },
        summary: { type: 'string', description: 'A clear, structured summary of what this is about, with every concrete detail preserved.' },
        status: { type: 'string', enum: ['urgent', 'active', 'watch', 'good'], description: 'How pressing this is. Defaults to "active" if unclear.' },
      },
      required: ['title', 'summary'],
    },
  },
  {
    name: 'remove_event',
    description: 'Cancel/remove a dining plan or family event. For a routine dining occasion, pass occasion (removes the confirmed pick for its next occurrence, if any). Otherwise pass an explicit date; add title to disambiguate if more than one event sits on that date — never guess which one if it\'s ambiguous.',
    input_schema: {
      type: 'object',
      properties: {
        occasion: { type: 'string', enum: ['family_dinner', 'date_night', 'weekend_social'], description: 'Which routine dining occasion to cancel, if that\'s what this is.' },
        date: { type: 'string', description: 'The event date as YYYY-MM-DD, if not using occasion.' },
        title: { type: 'string', description: 'Which event to remove, if more than one is on that date (matched by substring).' },
      },
    },
  },
  {
    name: 'get_budget_status',
    description: 'Report joint and Kevin-personal budget pace this cycle (logged/projected vs target, on or over pace), plus travel trip actuals vs budgeted.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_health_status',
    description: 'Report how each person slept this week measured against their own personal baseline, including whose baseline is still building. Use this for any question about sleep, rest, readiness, recovery, or how the week has felt physically.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_savings_goals',
    description: 'Report progress on every savings goal (current amount vs target, percentage).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_decisions',
    description: 'List open decisions/action items (urgent ones first) with what needs to happen next.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'search_transactions',
    description: 'Look up individual current-cycle transaction line items (date, merchant, amount, category/trip) by merchant name and/or tracker — e.g. "was there a Geico charge in the joint budget" or "what\'s in the joint dining category this cycle". Also surfaces refunds/credits (e.g. "was there a refund from Amazon"), marked distinctly from regular spend in the reply. Current cycle only (joint\'s current ~4-week cycle, personal\'s current month, current travel trips) — cannot see older cycles or history further back.',
    input_schema: {
      type: 'object',
      properties: {
        merchant: { type: 'string', description: 'Substring to search for in the merchant name (case-insensitive), e.g. "Geico". Omit to not filter by merchant.' },
        tracker: { type: 'string', enum: ['joint', 'personal', 'travel'], description: 'Restrict to one tracker. Omit to search across all of them.' },
      },
    },
  },
  {
    name: 'get_upcoming_shows',
    description: 'Report real upcoming shows/events (comedy, music) at the venues in venues_to_follow.json over roughly the next 2 weeks — live web search, Westside-weighted per the household\'s location preference. Only call this when the user actually asks about upcoming shows/events; it is not part of the automatic recap.',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days ahead to look. Defaults to 14 if not given.' },
      },
    },
  },
  {
    name: 'get_calendar_events',
    description: "Report upcoming events from the household's readable Google calendars: Kevin's personal (farinooh@gmail.com) and Hanna's (hkamaric@gmail.com, shared into Kevin's Google account so this OAuth can read it). Use this whenever Kevin or Hanna asks about their schedule, her schedule, his schedule, or what's on the calendar — Hanna's calendar IS available; never claim you can't see her schedule. Kevin's work calendar is deliberately excluded. Read-only.",
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'How many days ahead to look, starting today. Defaults to 7 if not given.' },
      },
    },
  },
  {
    name: 'add_reminder',
    description: 'Set a one-off reminder that proactively pings the household Telegram group on a specific date (day-level only -- no specific time-of-day support). Use this, and never add_todo, whenever the user says "remind me..." or asks for a reminder: a to-do sits on the shared Planner list until done, a reminder proactively announces itself once on its date and never appears on the Planner list.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to be reminded about.' },
        date: { type: 'string', description: 'The date to fire on, as YYYY-MM-DD, resolved from whatever the user said ("tomorrow", "Friday") using today\'s date from context.' },
      },
      required: ['text', 'date'],
    },
  },
  {
    name: 'list_reminders',
    description: 'List every upcoming (not yet sent) reminder.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel an upcoming reminder before it fires, matched by substring on its text (and its date, if given, to disambiguate). Never guess which one if more than one matches -- ask instead.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Substring to match against the reminder\'s text.' },
        date: { type: 'string', description: 'The reminder\'s date (YYYY-MM-DD), if known -- narrows an ambiguous match.' },
      },
      required: ['text'],
    },
  },
];

// get_calendar_events has no TOOL_IMPL entry — unlike every other tool
// here, it needs a live Google Calendar API call (via
// scripts/calendar-read.mjs), not a pure in-memory transform, so
// telegram-bot-poll.mjs's dispatch handles it as a special case before
// falling through to the TOOL_IMPL lookup below.

// Tool names whose implementation operates on monthPlanEvents + a read-only
// diningContext bundle, not on todos + owner — telegram-bot-poll.mjs's
// dispatch branches on this set to know which arguments to pass.
export const DINING_TOOL_NAMES = new Set(['get_dining_plan', 'set_dinner_plan', 'remove_event']);

// Tool names whose implementation is read-only over a financialContext
// bundle — see the FINANCIAL_TOOL_NAMES definition above (kept there,
// alongside the get_*/financial function implementations themselves).

// owner is threaded in by the caller (resolved from the Telegram sender),
// not something the LLM/deterministic parser supplies — a message can only
// ever add a todo on behalf of whoever sent it.
export const TOOL_IMPL = {
  add_todo: (todos, args, owner) => add_todo(todos, { title: args.title, owner }),
  mark_done: (todos, args) => mark_done(todos, { index: args.index }),
  delete_todo: (todos, args) => delete_todo(todos, { index: args.index }),
  log_weekly_goal_count: (todos, args) => log_weekly_goal_count(todos, { index: args.index, delta: args.delta }),
  list_todos: (todos) => list_todos(todos),
  get_dining_plan: (monthPlanEvents, args, diningContext) => get_dining_plan(monthPlanEvents, { occasion: args.occasion }, diningContext),
  set_dinner_plan: (monthPlanEvents, args, diningContext) => set_dinner_plan(monthPlanEvents, { occasion: args.occasion, date: args.date, pick: args.pick, time: args.time, durationHours: args.durationHours }, diningContext),
  remove_event: (monthPlanEvents, args, diningContext) => remove_event(monthPlanEvents, { occasion: args.occasion, date: args.date, title: args.title }, diningContext),
  get_budget_status: (financialContext) => get_budget_status(financialContext),
  get_health_status: (healthContext) => get_health_status(healthContext),
  get_savings_goals: (financialContext) => get_savings_goals(financialContext),
  get_decisions: (financialContext) => get_decisions(financialContext),
  search_transactions: (financialContext, args) => search_transactions(financialContext, { merchant: args.merchant, tracker: args.tracker }),
  add_family_event: (monthPlanEvents, args) => add_family_event(monthPlanEvents, { date: args.date, title: args.title, time: args.time, recurrenceWeeks: args.recurrenceWeeks, durationHours: args.durationHours, kind: args.kind }),
  set_routine_day: (overrides, args) => set_routine_day(overrides, { occasion: args.occasion, dayOfWeek: args.dayOfWeek }),
  update_phase_expense: (goals, args) => update_phase_expense(goals, { phaseId: args.phaseId, expenseKey: args.expenseKey, renameFrom: args.renameFrom, amount: args.amount }),
  log_decision: (goals, args) => log_decision(goals, { title: args.title, summary: args.summary, status: args.status }),
  add_reminder: (reminders, args, owner) => add_reminder(reminders, { text: args.text, date: args.date, owner }),
  list_reminders: (reminders) => list_reminders(reminders),
  cancel_reminder: (reminders, args) => cancel_reminder(reminders, { text: args.text, date: args.date }),
};
