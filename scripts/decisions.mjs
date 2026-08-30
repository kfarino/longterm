// Longterm/scripts/decisions.mjs
//
// The one shared answer to "is this decision still open?" — pure functions
// over goals.json's `decisions` array, no fs, no side effects.
//
// Why this is shared rather than a filter written per-consumer: a decision is
// read by four separate surfaces (the Telegram bot's get_decisions, the Sun/Thu
// recap bundle, the dashboard's Decisions tab via build-data.mjs, and the
// generated goal-plan doc). Until 2026-08-30 nothing could ever close one out —
// log_decision only appended — so a decision that had genuinely been settled
// (an airline refund that already posted) kept getting cited by the weekly
// recap as if it were still pending. resolve_decision (telegram-bot-tools.mjs)
// now marks one `status: "resolved"`, and every one of those surfaces filters
// through here, so closing a decision means it goes quiet everywhere at once
// rather than in whichever place someone remembered to patch.
//
// A resolved decision is *kept* in goals.json, not deleted: the plan's own
// history of what was decided and when is worth more than a shorter file, and
// it lets the bot answer "we already closed that on <date>" instead of
// insisting it never existed.

// Both spellings accepted because both read naturally in a Telegram message
// ("close that out" / "mark it resolved") and there is no value in the bot
// being pedantic about which word it stored.
export const RESOLVED_STATUSES = new Set(['resolved', 'closed']);

export function isResolvedDecision(decision) {
  if (!decision) return false;
  return RESOLVED_STATUSES.has(String(decision.status || '').toLowerCase());
}

// Note the default: a decision with no status at all is OPEN. A missing status
// must never be read as "settled" — silently hiding a decision is exactly the
// failure this module exists to fix, just in the other direction.
export function openDecisions(decisions) {
  return (decisions || []).filter((d) => !isResolvedDecision(d));
}

// Case-insensitive substring match on the title, returning EVERY candidate
// (resolved ones included) with its index into the original array, so a caller
// can mutate in place and can tell "already closed" apart from "no such
// decision". Deliberately never picks a winner — resolve_decision asks which
// one was meant rather than closing a decision nobody asked to close, the same
// rule remove_event follows for an ambiguous date.
export function matchDecisionsByTitle(decisions, title) {
  const needle = String(title || '').trim().toLowerCase();
  if (!needle) return [];
  return (decisions || [])
    .map((decision, index) => ({ decision, index }))
    .filter(({ decision }) => String(decision?.title || '').toLowerCase().includes(needle));
}
