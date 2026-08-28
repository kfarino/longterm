// Longterm/scripts/reminder-time.mjs
// Time-of-day handling for reminders (2026-08-28), shared by add_reminder in
// telegram-bot-tools.mjs and the delivery job telegram-bot-reminders.mjs.
//
// It lives in its own tiny module precisely because those two must never
// disagree: the ask that prompted this was someone trying to correct an am/pm
// mixup, so the time a reminder confirms back has to be parsed and displayed
// by the same code that later decides when it fires. A second, "obviously
// equivalent" formatter in the delivery job is how you get a reminder that
// says 6:00am and goes off at 6pm.

// The day-level default: a reminder with no time still behaves the way it did
// before this feature -- one morning nudge -- even though the job now ticks
// every few minutes instead of once at 8am.
export const DEFAULT_REMINDER_TIME = '08:00';

const TIME_RE = /^\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?\s*$/i;

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * Parse whatever the model passed as a time into canonical "HH:MM" (24-hour).
 *
 * Returns `{ time, invalid }` rather than a bare string so callers can tell
 * "no time given" (day-level reminder, fine) apart from "a time was given and
 * it made no sense" (must be refused, never silently downgraded to day-level
 * -- the user asked for 6am and would otherwise be told nothing went wrong).
 *
 * Accepts the strict schema form ("06:00", "18:30") plus the 12-hour spellings
 * a model reaches for when the user said "6am" -- deliberately tolerant on the
 * input side, strict on what gets stored.
 */
export function parseReminderTime(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === '') return { time: null, invalid: false };
  const match = TIME_RE.exec(String(raw));
  if (!match) return { time: null, invalid: true };
  let hour = Number(match[1]);
  const minute = match[2] === undefined ? 0 : Number(match[2]);
  const meridiem = match[3] ? match[3][0].toLowerCase() : null;
  if (minute > 59) return { time: null, invalid: true };
  if (meridiem) {
    if (hour < 1 || hour > 12) return { time: null, invalid: true };
    if (meridiem === 'a') hour = hour === 12 ? 0 : hour;
    else if (hour !== 12) hour += 12;
  } else if (hour > 23) {
    return { time: null, invalid: true };
  }
  return { time: `${pad(hour)}:${pad(minute)}`, invalid: false };
}

// "06:00" -> "6:00am". Everything shown to a human is 12-hour, because am/pm
// is the form the mistake happens in and therefore the form worth confirming.
export function formatReminderTime(time) {
  const match = /^(\d{2}):(\d{2})$/.exec(time || '');
  if (!match) return null;
  const hour = Number(match[1]);
  const suffix = hour < 12 ? 'am' : 'pm';
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${match[2]}${suffix}`;
}

// Local wall-clock "HH:MM" for a Date -- the same frame reminder times are
// written in (someone saying "6am" means 6am where they live, not UTC).
export function clockOf(date) {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// The time a reminder actually fires at: its own, or the day-level default.
export function effectiveTime(reminder, defaultTime = DEFAULT_REMINDER_TIME) {
  return parseReminderTime(reminder.time).time || defaultTime;
}
