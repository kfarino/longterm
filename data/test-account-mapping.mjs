// Longterm/data/test-account-mapping.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// scripts/account-mapping.mjs: the pure "which physical card feeds which
// spend tracker" layer behind the Telegram bot's remap_account tool and the
// daily pull's dangling-mapping check.
//
// Why this exists (2026-10-01): a mapped card label that no longer matches a
// real Monarch account is the quietest failure in this project. The pull only
// routes a charge to a tracker when its account label is in the mapping, so a
// stale label means that card's charges land nowhere — no error, no warning,
// just a tracker that reads lower than reality every single day.
//
// Fixture labels/accounts here are invented (AGENTS.md §3) — never real cards.
// Run with: node Longterm/data/test-account-mapping.mjs
import assert from 'node:assert/strict';
import {
  isCheckingLikeLabel,
  isCreditCardLikeLabel,
  looksLikeMonarchNumericId,
  trackerKeysFromMapping,
  normalizeTrackerKey,
  labelsForTracker,
  trackerForLabel,
  knownAccountLabels,
  resolveAccountLabel,
  remapTrackerLabel,
  accountCatalogFromAccounts,
  mappedLabelsMissingFromMonarch,
  isRetiredAccountLabel,
} from '../scripts/account-mapping.mjs';

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

const seedMapping = () => ({
  jointAccountLabels: ['Household Mastercard (...1111)'],
  travelCategoryNames: ['Travel & Vacation'],
  personalAccountLabels: {
    kevin: ['CREDIT CARD (...2222)', 'CREDIT CARD (...3333)', 'Spending Account (...4444)'],
    hanna: ['CREDIT CARD (...5555)'],
  },
  personalCycle: {
    kevin: { accountLabel: 'CREDIT CARD (...2222)', startDay: 25 },
    hanna: { startDay: 25 },
  },
});

const seedCatalog = () => ({
  asOf: '2026-10-01',
  accounts: [
    { label: 'Household Mastercard (...1111)', type: 'credit' },
    { label: 'CREDIT CARD (...2222)', type: 'credit' },
    { label: 'CREDIT CARD (...3333)', type: 'credit' },
    { label: 'Spending Account (...4444)', type: 'depository' },
    { label: 'CREDIT CARD (...5555)', type: 'credit' },
    { label: 'Test Sapphire Card (...6666)', type: 'credit' },
    { label: 'Test Brokerage (...7777)', type: 'brokerage' },
  ],
});

// --- label shape heuristics (moved here from budget-tracking-pull.mjs so the
// pure tools module can use them without importing an fs-touching script) ---

test('label heuristics still tell a card from a checking account', () => {
  assert.equal(isCreditCardLikeLabel('CREDIT CARD (...2222)'), true);
  assert.equal(isCreditCardLikeLabel('Household Mastercard (...1111)'), true);
  assert.equal(isCreditCardLikeLabel('Spending Account (...4444)'), false);
  assert.equal(isCheckingLikeLabel('Spending Account (...4444)'), true);
  assert.equal(isCheckingLikeLabel('CREDIT CARD (...2222)'), false);
});

test('a bare numeric Monarch id is recognized as the other id scheme', () => {
  // AGENTS.md §2: get_accounts returns numeric ids, get_transactions only
  // display-name labels. Mapping a numeric id into the spend tracker would
  // match no transaction, ever.
  assert.equal(looksLikeMonarchNumericId('900000000000000001'), true);
  assert.equal(looksLikeMonarchNumericId(' 900000000000000002 '), true);
  assert.equal(looksLikeMonarchNumericId('CREDIT CARD (...2222)'), false);
  assert.equal(looksLikeMonarchNumericId('2222'), false, 'a last-4 is not an account id');
});

// --- tracker keys ---

test('trackerKeysFromMapping lists joint plus every owner with personal cards', () => {
  assert.deepEqual(trackerKeysFromMapping(seedMapping()), ['joint', 'kevin', 'hanna']);
  assert.deepEqual(trackerKeysFromMapping(null), []);
});

test('normalizeTrackerKey accepts how a person actually says it', () => {
  const keys = trackerKeysFromMapping(seedMapping());
  assert.equal(normalizeTrackerKey('joint', keys), 'joint');
  assert.equal(normalizeTrackerKey('Joint budget', keys), 'joint');
  assert.equal(normalizeTrackerKey('family budget', keys), 'joint');
  assert.equal(normalizeTrackerKey('Kevin', keys), 'kevin');
  assert.equal(normalizeTrackerKey('kevin personal', keys), 'kevin');
  assert.equal(normalizeTrackerKey("Kevin's personal tracker", keys), 'kevin');
  assert.equal(normalizeTrackerKey('hanna', keys), 'hanna');
  assert.equal(normalizeTrackerKey('barclays', keys), null);
  assert.equal(normalizeTrackerKey('', keys), null);
});

test('labelsForTracker reads the right half of the mapping for each tracker', () => {
  const mapping = seedMapping();
  assert.deepEqual(labelsForTracker(mapping, 'joint'), ['Household Mastercard (...1111)']);
  assert.equal(labelsForTracker(mapping, 'kevin').length, 3);
  assert.deepEqual(labelsForTracker(mapping, 'nobody'), []);
});

test('trackerForLabel says which budget a card currently feeds', () => {
  const mapping = seedMapping();
  assert.equal(trackerForLabel(mapping, 'Household Mastercard (...1111)'), 'joint');
  assert.equal(trackerForLabel(mapping, 'CREDIT CARD (...3333)'), 'kevin');
  assert.equal(trackerForLabel(mapping, 'CREDIT CARD (...5555)'), 'hanna');
  assert.equal(trackerForLabel(mapping, 'Test Sapphire Card (...6666)'), null);
});

// --- what labels are even knowable locally ---

test('knownAccountLabels prefers the pulled catalog and reports it as verifiable', () => {
  const known = knownAccountLabels({ mapping: seedMapping(), accountCatalog: seedCatalog() });
  assert.equal(known.verified, true, 'a real catalog means an unknown card can be refused');
  assert.ok(known.labels.includes('Test Sapphire Card (...6666)'));
  assert.ok(known.labels.includes('CREDIT CARD (...2222)'));
});

test('knownAccountLabels degrades to mapped labels only, and says it cannot verify', () => {
  // A fresh checkout (or any machine where the pull has never run) has no
  // catalog. "I have never seen a list of your accounts" and "that card does
  // not exist" are different answers; only one of them is true here.
  const known = knownAccountLabels({ mapping: seedMapping(), accountCatalog: null });
  assert.equal(known.verified, false);
  assert.deepEqual(known.labels.includes('CREDIT CARD (...2222)'), true);
  assert.equal(known.labels.includes('Test Sapphire Card (...6666)'), false);
});

test('knownAccountLabels treats an empty catalog as no catalog', () => {
  const known = knownAccountLabels({ mapping: seedMapping(), accountCatalog: { asOf: '2026-10-01', accounts: [] } });
  assert.equal(known.verified, false);
});

// --- resolving what someone typed into one real label ---

test('resolveAccountLabel matches an exact label, case-insensitively', () => {
  const labels = seedCatalog().accounts.map((a) => a.label);
  assert.equal(resolveAccountLabel(labels, 'Test Sapphire Card (...6666)').label, 'Test Sapphire Card (...6666)');
  assert.equal(resolveAccountLabel(labels, 'test sapphire card (...6666)').label, 'Test Sapphire Card (...6666)');
});

test('resolveAccountLabel matches on the last four digits alone', () => {
  const labels = seedCatalog().accounts.map((a) => a.label);
  assert.equal(resolveAccountLabel(labels, '6666').label, 'Test Sapphire Card (...6666)');
  assert.equal(resolveAccountLabel(labels, '...3333').label, 'CREDIT CARD (...3333)');
});

test('resolveAccountLabel matches a partial name', () => {
  const labels = seedCatalog().accounts.map((a) => a.label);
  assert.equal(resolveAccountLabel(labels, 'sapphire').label, 'Test Sapphire Card (...6666)');
  assert.equal(resolveAccountLabel(labels, 'Sapphire 6666').label, 'Test Sapphire Card (...6666)');
});

test('resolveAccountLabel asks instead of picking when several cards match', () => {
  const labels = seedCatalog().accounts.map((a) => a.label);
  const result = resolveAccountLabel(labels, 'credit card');
  assert.equal(result.label, undefined, 'never guess which card was meant');
  assert.equal(result.ambiguous.length, 3);
});

test('resolveAccountLabel returns nothing for a card it has never seen', () => {
  const labels = seedCatalog().accounts.map((a) => a.label);
  assert.deepEqual(resolveAccountLabel(labels, 'Imaginary Bank (...9999)'), {});
  assert.deepEqual(resolveAccountLabel(labels, ''), {});
});

// --- the actual remap ---

test('remapTrackerLabel swaps the wrong card for the right one, in place', () => {
  const mapping = seedMapping();
  const result = remapTrackerLabel(mapping, {
    tracker: 'kevin',
    newLabel: 'Test Sapphire Card (...6666)',
    oldLabel: 'CREDIT CARD (...2222)',
  });
  assert.deepEqual(result.mapping.personalAccountLabels.kevin, [
    'Test Sapphire Card (...6666)',
    'CREDIT CARD (...3333)',
    'Spending Account (...4444)',
  ], 'replaced at the same position — order decides the default cycle anchor');
  assert.equal(result.replaced, 'CREDIT CARD (...2222)');
  assert.equal(result.added, 'Test Sapphire Card (...6666)');
});

test('remapTrackerLabel is pure — the caller decides whether to persist', () => {
  const mapping = seedMapping();
  remapTrackerLabel(mapping, { tracker: 'kevin', newLabel: 'Test Sapphire Card (...6666)', oldLabel: 'CREDIT CARD (...2222)' });
  assert.deepEqual(mapping.personalAccountLabels.kevin[0], 'CREDIT CARD (...2222)', 'the input object is untouched');
});

test('remapTrackerLabel moves the statement-cycle anchor with the card it names', () => {
  // mapping.personalCycle[owner].accountLabel decides the personal statement
  // window. Leaving it pointed at a card that is no longer mapped silently
  // changes which window the tracker runs on (personalCycleAnchorLabel falls
  // back to "first credit card listed") — a cycle that quietly moves is worse
  // than a mapping that was never fixed.
  const result = remapTrackerLabel(seedMapping(), {
    tracker: 'kevin',
    newLabel: 'Test Sapphire Card (...6666)',
    oldLabel: 'CREDIT CARD (...2222)',
  });
  assert.equal(result.mapping.personalCycle.kevin.accountLabel, 'Test Sapphire Card (...6666)');
  assert.equal(result.mapping.personalCycle.kevin.startDay, 25, 'the statement day is unchanged');
  assert.equal(result.anchorMoved, true);
});

test('remapTrackerLabel leaves the anchor alone when another card was replaced', () => {
  const result = remapTrackerLabel(seedMapping(), {
    tracker: 'kevin',
    newLabel: 'Test Sapphire Card (...6666)',
    oldLabel: 'CREDIT CARD (...3333)',
  });
  assert.equal(result.mapping.personalCycle.kevin.accountLabel, 'CREDIT CARD (...2222)');
  assert.equal(result.anchorMoved, false);
});

test('remapTrackerLabel drops a dangling anchor rather than anchoring on checking', () => {
  // Ally checking never defines the statement window (isCheckingLikeLabel).
  // Pointing the anchor at it would be ignored downstream anyway, so the
  // explicit anchor is removed and the fallback picks a real card.
  const result = remapTrackerLabel(seedMapping(), {
    tracker: 'kevin',
    newLabel: 'Second Spending Account (...8888)',
    oldLabel: 'CREDIT CARD (...2222)',
  });
  assert.equal(result.mapping.personalCycle.kevin.accountLabel, undefined);
  assert.equal(result.mapping.personalCycle.kevin.startDay, 25);
});

test('remapTrackerLabel can add a card without removing one', () => {
  const result = remapTrackerLabel(seedMapping(), {
    tracker: 'hanna',
    newLabel: 'Test Sapphire Card (...6666)',
    oldLabel: null,
  });
  assert.deepEqual(result.mapping.personalAccountLabels.hanna, [
    'CREDIT CARD (...5555)',
    'Test Sapphire Card (...6666)',
  ]);
  assert.equal(result.replaced, null);
});

test('remapTrackerLabel swaps the joint card too', () => {
  const result = remapTrackerLabel(seedMapping(), {
    tracker: 'joint',
    newLabel: 'Test Sapphire Card (...6666)',
    oldLabel: 'Household Mastercard (...1111)',
  });
  assert.deepEqual(result.mapping.jointAccountLabels, ['Test Sapphire Card (...6666)']);
});

test('remapTrackerLabel refuses to leave a tracker with no cards at all', () => {
  // jointAccountLabels empty means the pull skips rebuilding the joint
  // tracker entirely — it would freeze at its last values and look fine.
  const result = remapTrackerLabel(seedMapping(), {
    tracker: 'joint',
    newLabel: null,
    oldLabel: 'Household Mastercard (...1111)',
  });
  assert.equal(result.error, 'would_empty_tracker');
  assert.deepEqual(result.mapping.jointAccountLabels, ['Household Mastercard (...1111)']);
});

test('remapTrackerLabel reports an old label that is not actually mapped', () => {
  const result = remapTrackerLabel(seedMapping(), {
    tracker: 'kevin',
    newLabel: 'Test Sapphire Card (...6666)',
    oldLabel: 'CREDIT CARD (...5555)',
  });
  assert.equal(result.error, 'old_label_not_mapped');
});

test('remapTrackerLabel reports a card that already feeds another tracker', () => {
  // One card, one budget. Mapping the same label into two trackers counts its
  // charges twice — the pull's label→owner index would also silently pick one.
  const result = remapTrackerLabel(seedMapping(), {
    tracker: 'kevin',
    newLabel: 'CREDIT CARD (...5555)',
    oldLabel: 'CREDIT CARD (...2222)',
  });
  assert.equal(result.error, 'already_mapped_elsewhere');
  assert.equal(result.conflictTracker, 'hanna');
});

test('remapTrackerLabel reports a no-op when the card already feeds this tracker', () => {
  const result = remapTrackerLabel(seedMapping(), {
    tracker: 'kevin',
    newLabel: 'CREDIT CARD (...3333)',
    oldLabel: 'CREDIT CARD (...2222)',
  });
  assert.equal(result.error, 'already_mapped_here');
});

// --- the pull-side halves: a catalog to verify against, and the dangling check ---

test('accountCatalogFromAccounts keeps labels and types, never balances', () => {
  const catalog = accountCatalogFromAccounts([
    { displayName: 'Test Sapphire Card (...6666)', type: { name: 'credit' }, currentBalance: -1234.56 },
    { name: 'Test Checking (...4444)', type: 'depository', balance: 987.65 },
    { displayName: '', type: 'credit' },
  ], { asOf: '2026-10-01' });

  assert.equal(catalog.asOf, '2026-10-01');
  assert.deepEqual(catalog.accounts, [
    { label: 'Test Sapphire Card (...6666)', type: 'credit' },
    { label: 'Test Checking (...4444)', type: 'depository' },
  ], 'nameless accounts are dropped; no balance ever lands in the catalog');
  const serialized = JSON.stringify(catalog);
  assert.doesNotMatch(serialized, /1234|987/, 'the catalog is for identifying cards, not for balances');
});

test('mappedLabelsMissingFromMonarch finds the card a mapping points at that is gone', () => {
  const mapping = seedMapping();
  mapping.personalAccountLabels.kevin = ['CREDIT CARD (...9999)', 'CREDIT CARD (...3333)'];
  const missing = mappedLabelsMissingFromMonarch(mapping, [
    'Household Mastercard (...1111)',
    'CREDIT CARD (...3333)',
    'Spending Account (...4444)',
    'CREDIT CARD (...5555)',
  ]);
  assert.deepEqual(missing, { kevin: ['CREDIT CARD (...9999)'] });
});

test('mappedLabelsMissingFromMonarch finds a dangling joint card', () => {
  const missing = mappedLabelsMissingFromMonarch(seedMapping(), [
    'CREDIT CARD (...2222)', 'CREDIT CARD (...3333)', 'Spending Account (...4444)', 'CREDIT CARD (...5555)',
  ]);
  assert.deepEqual(missing, { joint: ['Household Mastercard (...1111)'] });
});

test('mappedLabelsMissingFromMonarch reports nothing when every mapped card exists', () => {
  const missing = mappedLabelsMissingFromMonarch(seedMapping(), seedCatalog().accounts.map((a) => a.label));
  assert.deepEqual(missing, {});
});

test('mappedLabelsMissingFromMonarch stays silent when Monarch returned no accounts', () => {
  // An empty accounts response is an API failure, not "every card is gone".
  // Flagging every mapping on a bad pull would cry wolf on all of them.
  assert.deepEqual(mappedLabelsMissingFromMonarch(seedMapping(), []), {});
  assert.deepEqual(mappedLabelsMissingFromMonarch(seedMapping(), null), {});
});

test('a retired card is not flagged as missing even if it is still in the mapping', () => {
  const mapping = seedMapping();
  mapping.personalAccountLabels.kevin.push('CREDIT CARD (...9999)');
  mapping.retiredAccountLabels = ['CREDIT CARD (...9999)'];
  assert.equal(isRetiredAccountLabel(mapping, 'CREDIT CARD (...9999)'), true);
  const live = seedCatalog().accounts.map((a) => a.label);
  assert.deepEqual(mappedLabelsMissingFromMonarch(mapping, live), {});
});

console.log('All account-mapping tests passed.');
