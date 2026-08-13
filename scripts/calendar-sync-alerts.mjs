// Telling the humans when Google Calendar sync is down.
//
// Why this exists: the pause file used to be written once, logged once, and
// then never mentioned again. Sync stayed dead for three days while the bot
// kept replying "Added ✓" to every event — the local write really did succeed,
// so nothing in the reply path was lying, it just had no idea the push to
// Google had stopped. A log line nobody reads is not a notification.
//
// The alerting policy is deliberately pure and separate from the sending, so
// the "when do we speak up" rule is testable without a network or a clock.

const ALERT_REPEAT_MS = 24 * 60 * 60 * 1000;

/**
 * Speak up on the first failure, then at most once a day while it stays broken.
 *
 * Repeating matters: an alert sent while nobody is looking at their phone is
 * the same as no alert, and this failure mode is silent from the user's side —
 * events keep "saving" fine. But repeating every retry would train everyone to
 * ignore it, which is how the original spam concern turned into total silence.
 */
export function shouldAlertForPause(pause, now = new Date()) {
  if (!pause) return false;
  if (!pause.lastAlertAt) return true;
  const lastAlert = Date.parse(pause.lastAlertAt);
  if (Number.isNaN(lastAlert)) return true;
  return now.getTime() - lastAlert >= ALERT_REPEAT_MS;
}

/** Hours a pause has been in effect, for "down since" phrasing. */
export function pauseAgeHours(pause, now = new Date()) {
  const startedAt = Date.parse(pause?.at || '');
  if (Number.isNaN(startedAt)) return 0;
  return Math.max(0, Math.round((now.getTime() - startedAt) / (60 * 60 * 1000)));
}

/**
 * The message says three things on purpose: what is broken, what it means for
 * things you already asked for (they are saved, not lost), and the exact
 * command that fixes it. `--reauth-only` is load-bearing in that command —
 * plain calendar-auth-setup.mjs creates a second "Family Planner" calendar
 * and orphans every already-synced event.
 */
export function buildPauseAlertText(pause, { unsyncedCount = 0, now = new Date() } = {}) {
  const hours = pauseAgeHours(pause, now);
  const downFor = hours >= 24 ? `${Math.round(hours / 24)} day(s)` : `${hours} hour(s)`;
  const stranded = unsyncedCount > 0
    ? `\n${unsyncedCount} event${unsyncedCount === 1 ? '' : 's'} ${unsyncedCount === 1 ? 'is' : 'are'} saved in the planner but not on your calendars yet — they'll sync automatically once this is fixed.`
    : '';
  return [
    '⚠️ Google Calendar sync is down.',
    `Google auth stopped working (down for ${downFor}). Anything I add is still saved to the Month Plan, but it is NOT reaching your Google Calendar.${stranded}`,
    '',
    'Fix on the desktop:',
    'node scripts/calendar-auth-setup.mjs --reauth-only',
  ].join('\n');
}

/** Events written locally that never got a googleEventId — the real backlog. */
export function countUnsyncedEvents(monthPlanDoc) {
  const byDate = monthPlanDoc?.events || {};
  let count = 0;
  for (const list of Object.values(byDate)) {
    if (!Array.isArray(list)) continue;
    for (const event of list) if (!event?.googleEventId) count += 1;
  }
  return count;
}
