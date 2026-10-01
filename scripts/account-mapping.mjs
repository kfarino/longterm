// Longterm/scripts/account-mapping.mjs
//
// Which physical card/account feeds which spend tracker — the pure layer
// behind the Telegram bot's `remap_account` tool and the daily pull's
// dangling-mapping check. No fs, no network (same contract as decisions.mjs),
// so both an fs-touching pull script and the deliberately fs-free
// telegram-bot-tools.mjs can share one definition.
//
// The config this operates on is `budget_tracking.json`'s `mapping` section:
// `jointAccountLabels`, `personalAccountLabels[ownerId]`, and
// `personalCycle[ownerId].accountLabel`. That section is the one
// hand-maintained island in an otherwise fully regenerated file — the pull
// loads the file, mutates joint/personal/travel, and writes the same object
// back, so `mapping` survives the morning rebuild. That is what makes a
// mapping edit durable without a transaction_overrides.json entry.
//
// Why a module exists for this at all (2026-10-01): a mapped label that no
// longer matches a real Monarch account is this project's quietest failure.
// The pull routes a charge to a tracker only when the charge's account label
// is in the mapping, so a stale label (card replaced, re-linked, renumbered)
// means those charges land nowhere — no error, no empty category, just a
// tracker that reads lower than reality every day until someone notices.
// Hanna noticed. Hence: resolve what a person said into one real label,
// refuse to guess, and let the pull say when a mapping has gone dangling.
//
// Two id schemes exist and must never be mixed (AGENTS.md §2): `get_accounts`
// returns numeric ids (that is accounts.json's net-worth mapping), while
// `get_transactions` only exposes a display-name label like
// "CREDIT CARD (...3939)". Everything here is the display-name scheme.

const CREDIT_CARD_LABEL = /credit card|mastercard|visa|amex|american express|discover/i;
const CHECKING_LIKE_LABEL = /spending account|checking|savings/i;

export function isCheckingLikeLabel(label) {
  return CHECKING_LIKE_LABEL.test(label || '');
}

export function isCreditCardLikeLabel(label) {
  return CREDIT_CARD_LABEL.test(label || '') && !CHECKING_LIKE_LABEL.test(label || '');
}

/**
 * A bare numeric Monarch account id (the `get_accounts` scheme). Mapping one
 * of these into the spend trackers would match no transaction ever, silently
 * — so it is worth telling apart from a display-name label. A 4-digit card
 * tail is not an id.
 */
export function looksLikeMonarchNumericId(value) {
  return /^\s*\d{8,}\s*$/.test(String(value ?? ''));
}

/** 'joint' first, then every owner that has a personal spend tracker. */
export function trackerKeysFromMapping(mapping) {
  if (!mapping) return [];
  const keys = [];
  if (Array.isArray(mapping.jointAccountLabels)) keys.push('joint');
  for (const ownerId of Object.keys(mapping.personalAccountLabels || {})) keys.push(ownerId);
  return keys;
}

// Words that describe a tracker rather than name one, so "Kevin's personal
// card" and "the joint budget" both resolve.
const TRACKER_FILLER = new Set([
  'personal', 'budget', 'tracker', 'spend', 'spending', 'my', 'our', 'the', 'a',
  'card', 'cards', 'account', 'accounts', 'on', 'for', 'to',
]);

/** What someone typed ("Kevin's personal", "family budget") → a tracker key. */
export function normalizeTrackerKey(input, keys = []) {
  const words = String(input || '')
    .toLowerCase()
    .replace(/[’']s\b/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => !TRACKER_FILLER.has(w));
  if (!words.length) return null;
  if (words.some((w) => w === 'joint' || w === 'family' || w === 'household')) {
    return keys.includes('joint') ? 'joint' : null;
  }
  for (const word of words) {
    if (keys.includes(word)) return word;
  }
  return null;
}

export function labelsForTracker(mapping, key) {
  if (!mapping || !key) return [];
  if (key === 'joint') return [...(mapping.jointAccountLabels || [])];
  return [...((mapping.personalAccountLabels || {})[key] || [])];
}

/** Which tracker a label currently feeds, or null when nothing claims it. */
export function trackerForLabel(mapping, label) {
  const needle = String(label || '').trim().toLowerCase();
  if (!needle) return null;
  for (const key of trackerKeysFromMapping(mapping)) {
    if (labelsForTracker(mapping, key).some((l) => String(l).trim().toLowerCase() === needle)) return key;
  }
  return null;
}

/**
 * Every account label knowable without a live Monarch call.
 *
 * `verified` is the honest part: with a pulled `accountCatalog` an unknown
 * card can be refused outright, because the full list of real accounts is
 * right there. Without one (fresh checkout, pull never run) all that is known
 * is what is already mapped — "I have never seen a list of your accounts" and
 * "that card does not exist" are different answers, and only one is true,
 * which is the same rule searchStoredHistory follows for an unreachable month.
 */
export function knownAccountLabels({ mapping, accountCatalog } = {}) {
  const catalogLabels = (accountCatalog?.accounts || [])
    .map((a) => String(a?.label || '').trim())
    .filter(Boolean);
  const mapped = [];
  for (const key of trackerKeysFromMapping(mapping)) mapped.push(...labelsForTracker(mapping, key));
  const labels = [];
  for (const label of [...catalogLabels, ...mapped]) {
    if (label && !labels.includes(label)) labels.push(label);
  }
  return { labels, catalogLabels, verified: catalogLabels.length > 0 };
}

/**
 * One label, or an explicit ambiguity — never a guess.
 *
 * Stages, stopping at the first that matches anything: exact, substring of the
 * whole query, the query's digits (a card tail is how people actually refer to
 * a card), then all of its words. A stage that matches more than one card
 * reports those candidates rather than falling through to a looser stage,
 * because a looser stage can only be less certain, not more.
 */
export function resolveAccountLabel(labels, query) {
  const list = (labels || []).map((l) => String(l)).filter(Boolean);
  const raw = String(query || '').trim();
  if (!raw || !list.length) return {};
  const needle = raw.toLowerCase();

  const exact = list.filter((l) => l.trim().toLowerCase() === needle);
  if (exact.length === 1) return { label: exact[0] };
  if (exact.length > 1) return { ambiguous: exact };

  const stages = [];
  stages.push(list.filter((l) => l.toLowerCase().includes(needle)));
  const digits = raw.replace(/\D+/g, '');
  if (digits.length >= 3) stages.push(list.filter((l) => l.replace(/\D+/g, '').includes(digits)));
  const words = needle.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length >= 3);
  if (words.length) stages.push(list.filter((l) => words.every((w) => l.toLowerCase().includes(w))));

  for (const matches of stages) {
    const unique = [...new Set(matches)];
    if (unique.length === 1) return { label: unique[0] };
    if (unique.length > 1) return { ambiguous: unique };
  }
  return {};
}

function cloneMapping(mapping) {
  return JSON.parse(JSON.stringify(mapping || {}));
}

function setLabelsForTracker(mapping, key, list) {
  if (key === 'joint') {
    mapping.jointAccountLabels = list;
    return;
  }
  if (!mapping.personalAccountLabels) mapping.personalAccountLabels = {};
  mapping.personalAccountLabels[key] = list;
}

/**
 * Repoint a tracker at the right card. Pure: returns a new mapping, and the
 * caller decides whether to persist it.
 *
 * `oldLabel` + `newLabel` replaces in place (position matters — it is the
 * fallback the personal statement anchor uses), `newLabel` alone appends,
 * `oldLabel` alone removes. Errors are returned as codes, never thrown, so
 * the bot tool can phrase each one for a person:
 *
 *   already_mapped_elsewhere — one card, one budget. The same label in two
 *     trackers counts its charges twice, and the pull's label→owner index
 *     would silently pick one of them.
 *   would_empty_tracker — a tracker with no labels is not rebuilt by the pull
 *     at all (`if (jointLabels.size > 0)`), so it freezes at its last values
 *     and still looks like a real number.
 */
export function remapTrackerLabel(mapping, { tracker, newLabel, oldLabel } = {}) {
  const next = cloneMapping(mapping);
  const keys = trackerKeysFromMapping(next);
  if (!tracker || !keys.includes(tracker)) return { mapping: next, error: 'unknown_tracker' };

  const addLabel = newLabel ? String(newLabel).trim() : null;
  const removeLabel = oldLabel ? String(oldLabel).trim() : null;
  if (!addLabel && !removeLabel) return { mapping: next, error: 'nothing_to_do' };

  if (addLabel) {
    const holder = trackerForLabel(next, addLabel);
    if (holder && holder !== tracker) return { mapping: next, error: 'already_mapped_elsewhere', conflictTracker: holder };
    if (holder === tracker) return { mapping: next, error: 'already_mapped_here' };
  }

  const list = labelsForTracker(next, tracker);
  let index = -1;
  if (removeLabel) {
    index = list.findIndex((l) => String(l).trim().toLowerCase() === removeLabel.toLowerCase());
    if (index < 0) return { mapping: next, error: 'old_label_not_mapped' };
    if (!addLabel && list.length <= 1) return { mapping: next, error: 'would_empty_tracker' };
  }

  if (removeLabel && addLabel) list[index] = addLabel;
  else if (removeLabel) list.splice(index, 1);
  else list.push(addLabel);
  setLabelsForTracker(next, tracker, list);

  // The personal statement window follows one named card
  // (personalCycleAnchorLabel). An anchor left pointing at a card that is no
  // longer mapped is ignored, and the fallback ("first credit card listed")
  // quietly takes over — a cycle that moves on its own is worse than a
  // mapping nobody fixed, so the anchor moves with the card it named.
  let anchorMoved = false;
  let anchorDropped = false;
  const cycleCfg = tracker !== 'joint' ? (next.personalCycle || {})[tracker] : null;
  if (cycleCfg && removeLabel && String(cycleCfg.accountLabel || '').trim().toLowerCase() === removeLabel.toLowerCase()) {
    // `!isCheckingLikeLabel` on purpose, not `isCreditCardLikeLabel`: that is
    // the exact predicate personalCycleAnchorLabel honors an explicit anchor
    // with, and a real card's display name ("... Sapphire Reserve") often
    // contains none of the words the credit-card regex looks for.
    if (addLabel && !isCheckingLikeLabel(addLabel)) {
      cycleCfg.accountLabel = addLabel;
      anchorMoved = true;
    } else {
      delete cycleCfg.accountLabel;
      anchorDropped = true;
    }
  }

  return {
    mapping: next,
    replaced: removeLabel || null,
    added: addLabel || null,
    anchorMoved,
    anchorDropped,
  };
}

/**
 * The labels Monarch actually has, recorded by the daily pull so a remap can
 * be verified against something real instead of accepted on faith.
 *
 * Labels and account types only — deliberately no balances. This exists to
 * identify a card, and a second copy of every balance in the same file is
 * noise that would eventually disagree with the real one.
 */
export function accountCatalogFromAccounts(accounts, { asOf = null } = {}) {
  const seen = new Set();
  const rows = [];
  for (const account of accounts || []) {
    const label = String(account?.displayName || account?.name || '').trim();
    if (!label || seen.has(label)) continue;
    seen.add(label);
    const rawType = account?.type?.name || account?.type || account?.subtype?.name || account?.subtype;
    rows.push({ label, type: typeof rawType === 'string' && rawType.trim() ? rawType.trim() : null });
  }
  return { asOf, accounts: rows };
}

/**
 * Mapped labels that match no live Monarch account, keyed by tracker.
 *
 * An empty/absent accounts list means the pull got nothing back — an API
 * failure, not "every card is gone". Flagging all of them then would cry wolf
 * on the whole mapping, so it reports nothing.
 */
export function mappedLabelsMissingFromMonarch(mapping, accountLabels) {
  const live = new Set((accountLabels || []).map((l) => String(l).trim().toLowerCase()).filter(Boolean));
  if (!live.size) return {};
  const out = {};
  for (const key of trackerKeysFromMapping(mapping)) {
    const missing = labelsForTracker(mapping, key).filter((l) => !live.has(String(l).trim().toLowerCase()));
    if (missing.length) out[key] = missing;
  }
  return out;
}
