// Longterm/data/test-telegram-bot.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// telegram-bot-poll.mjs's group-chat gating, owner resolution, deterministic
// parsing, the Anthropic tool-calling fallback (mocked — no real network
// calls), and offset-advance safety. Run with:
//   node Longterm/data/test-telegram-bot.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runOnce } from '../scripts/telegram-bot-poll.mjs';
import { get_dining_plan } from '../scripts/telegram-bot-tools.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-bot-test-'));

function test(name, fn) {
  fn();
  console.log(`  ok - ${name}`);
}

async function asyncTest(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

const seedTodos = () => ({
  meta: { description: 'test' },
  items: [
    { title: 'Existing item', owner: 'kevin', dateAdded: '2026-07-01', deadline: null, done: false },
  ],
  weeklyGoals: [
    { title: 'Consulting outreach', note: 'test', owner: 'kevin', target: 5, unit: 'contacts', weekOf: '2026-07-27', count: 1 },
  ],
});

const seedGoals = () => ({
  owners: [
    { id: 'kevin', displayName: 'Kevin' },
    { id: 'hanna', displayName: 'Hanna' },
  ],
  diningRoutine: [
    { dayOfWeek: 3, tier: 'mid', dynamic: false, requiresTag: 'familyFriendly' },
    { dayOfWeek: 5, tier: 'mid', dynamic: true, requiresTag: 'dinnerSpot' },
    { dayOfWeek: 6, tier: 'mid', dynamic: true, requiresTag: 'socialSpot' },
  ],
  lowKeyHangIdeas: ['Movie night at home'],
  phases: [{ id: 1, expenses: { 'Family budget': 5500, 'Kevin personal': 1000 } }],
  lifeGoals: [
    { name: 'Test Fund', targetAmount: 10000, current: 2500, status: 'active', note: 'test goal' },
  ],
  decisions: [
    { status: 'urgent', title: 'Urgent test decision', body: 'test body', action: 'Do the urgent thing' },
    { status: 'watch', title: 'Watch test decision', body: 'test body', action: 'Keep an eye on it' },
  ],
});

const seedFavoritePlaces = () => ({
  places: [
    { name: 'Test Bistro', cuisine: 'French', list: 'go-to', familyFriendly: true, dinnerSpot: true, socialSpot: true, observed: { tier: 'mid', avgSpend: 60 } },
  ],
  recentDiningActivity: [],
});

const seedBudgetTracking = () => ({
  joint: {
    targetExpenseKey: 'Family budget',
    weeks: [{ actual: 1000, days: 7 }],
    cycleDays: 30,
    categories: [
      { name: 'Insurance', amount: 489.26, transactions: [{ date: '2026-07-26', merchant: 'Geico', amount: 489.26 }] },
      { name: 'Groceries', amount: 115.62, transactions: [{ date: '2026-07-28', merchant: 'Whole Foods', amount: 115.62 }] },
    ],
  },
  personal: {
    kevin: {
      label: 'Kevin personal',
      targetExpenseKey: 'Kevin personal',
      weeks: [{ actual: 900, days: 7 }],
      cycleDays: 30,
      categories: [{ name: 'Coffee Shops', amount: 5, transactions: [{ date: '2026-07-29', merchant: 'Blue Bottle', amount: 5 }] }],
    },
  },
  travel: {
    trips: [{ label: 'Test Trip', actual: 500, budgetedAmount: 1000, transactions: [{ date: '2026-07-27', merchant: 'United Airlines', amount: 500 }] }],
    unmatched: [],
  },
});

const seedAccounts = () => ({
  balances: { brokerage: { kevin: { amount: 100000 }, hanna: { amount: 50000 } } },
});

function writeFixture(dir, { todos, updates, owners, goals, favoritePlaces, monthPlanEvents, budgetTracking, accounts, routineOverrides, conversationLog, pendingClarifications }) {
  fs.mkdirSync(dir, { recursive: true });
  const todosPath = path.join(dir, 'todos.json');
  const updatesPath = path.join(dir, 'updates.json');
  const ownersPath = path.join(dir, 'owners.json');
  const offsetPath = path.join(dir, 'offset.json');
  const unparsedPath = path.join(dir, 'unparsed.jsonl');
  const goalsPath = path.join(dir, 'goals.json');
  const favoritePlacesPath = path.join(dir, 'favorite_places.json');
  const monthPlanEventsPath = path.join(dir, 'month_plan_events.json');
  const budgetTrackingPath = path.join(dir, 'budget_tracking.json');
  const accountsPath = path.join(dir, 'accounts.json');
  const routineOverridesPath = path.join(dir, 'dining-routine-overrides.json');
  const conversationLogPath = path.join(dir, 'conversation-log.jsonl');
  const goalsChangelogPath = path.join(dir, 'goals-changelog.jsonl');
  const pendingClarificationsPath = path.join(dir, 'pending-clarifications.json');
  fs.writeFileSync(todosPath, JSON.stringify(todos ?? seedTodos(), null, 2));
  fs.writeFileSync(updatesPath, JSON.stringify(updates, null, 2));
  fs.writeFileSync(ownersPath, JSON.stringify(owners ?? { '111': 'hanna', '222': 'kevin' }, null, 2));
  fs.writeFileSync(goalsPath, JSON.stringify(goals ?? seedGoals(), null, 2));
  fs.writeFileSync(favoritePlacesPath, JSON.stringify(favoritePlaces ?? seedFavoritePlaces(), null, 2));
  fs.writeFileSync(monthPlanEventsPath, JSON.stringify(monthPlanEvents ?? { events: {} }, null, 2));
  fs.writeFileSync(budgetTrackingPath, JSON.stringify(budgetTracking ?? seedBudgetTracking(), null, 2));
  fs.writeFileSync(accountsPath, JSON.stringify(accounts ?? seedAccounts(), null, 2));
  if (routineOverrides) fs.writeFileSync(routineOverridesPath, JSON.stringify(routineOverrides, null, 2));
  if (conversationLog) fs.writeFileSync(conversationLogPath, conversationLog.map((e) => JSON.stringify(e)).join('\n') + '\n');
  if (pendingClarifications) fs.writeFileSync(pendingClarificationsPath, JSON.stringify(pendingClarifications, null, 2));
  return { todosPath, updatesPath, ownersPath, offsetPath, unparsedPath, goalsPath, favoritePlacesPath, monthPlanEventsPath, budgetTrackingPath, accountsPath, routineOverridesPath, conversationLogPath, goalsChangelogPath, pendingClarificationsPath };
}

function msg(updateId, { fromId = 111, text, replyToBot = false }) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId + 1000,
      from: { id: fromId, first_name: 'Test', is_bot: false },
      chat: { id: -999, type: 'group' },
      text,
      ...(replyToBot ? { reply_to_message: { from: { is_bot: true } } } : {}),
    },
  };
}

function baseOpts(paths, extra = {}) {
  return {
    updatesFixture: paths.updatesPath,
    todosPath: paths.todosPath,
    ownersPath: paths.ownersPath,
    offsetPath: paths.offsetPath,
    unparsedPath: paths.unparsedPath,
    goalsPath: paths.goalsPath,
    favoritePlacesPath: paths.favoritePlacesPath,
    monthPlanEventsPath: paths.monthPlanEventsPath,
    budgetTrackingPath: paths.budgetTrackingPath,
    accountsPath: paths.accountsPath,
    routineOverridesPath: paths.routineOverridesPath,
    conversationLogPath: paths.conversationLogPath,
    goalsChangelogPath: paths.goalsChangelogPath,
    pendingClarificationsPath: paths.pendingClarificationsPath,
    // Points at a guaranteed-nonexistent path by default, so a test isn't
    // accidentally reading this machine's real google-calendar.env (2026-08-02:
    // this file now genuinely exists once Calendar was actually set up, which
    // silently broke "not configured" tests that had relied on its absence).
    // Tests that want configured-calendar behavior already override via
    // calendarReadClient/calendarReadCalendarIds, which take priority over
    // any env file regardless of this default.
    calendarEnvPath: path.join(path.dirname(paths.todosPath), 'no-such-google-calendar.env'),
    groupChatId: '-999',
    botUsername: 'TestBot',
    dryRun: true,
    ...extra,
  };
}

console.log('test-telegram-bot.mjs');

await asyncTest('@mention message is processed (add_todo via deterministic parse)', async () => {
  const dir = path.join(tmpRoot, 'mention');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot new: buy milk' })] },
  });
  const result = await runOnce(baseOpts(paths));
  assert.equal(result.todos.items.length, 2);
  assert.equal(result.todos.items[1].title, 'buy milk');
  assert.equal(result.todos.items[1].owner, 'hanna');
  assert.ok(result.sentReplies[0].includes('Added'));
});

await asyncTest('reply-to-bot message is processed', async () => {
  const dir = path.join(tmpRoot, 'reply');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: 'new: fix the sink', replyToBot: true })] },
  });
  const result = await runOnce(baseOpts(paths));
  assert.equal(result.todos.items.length, 2);
  assert.equal(result.todos.items[1].owner, 'kevin');
});

await asyncTest('a plain message with no @mention is still processed (2026-08-01: the group is dedicated to the bot, no "addressed" gate)', async () => {
  const dir = path.join(tmpRoot, 'no-mention-still-processed');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'new: buy milk' })] },
  });
  const result = await runOnce(baseOpts(paths));
  assert.equal(result.todos.items.length, 2, 'a recognized sender\'s message should be acted on even without @-mentioning the bot');
  assert.ok(result.sentReplies[0].includes('Added'));
});

await asyncTest('message from an unrecognized sender is skipped', async () => {
  const dir = path.join(tmpRoot, 'unknown-sender');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 999, text: '@TestBot new: something' })] },
  });
  const result = await runOnce(baseOpts(paths));
  assert.equal(result.todosChanged, false);
  assert.equal(result.sentReplies.length, 0);
});

await asyncTest('deterministic pattern: "<n> done"', async () => {
  const dir = path.join(tmpRoot, 'done');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot 1 done' })] },
  });
  const result = await runOnce(baseOpts(paths));
  assert.equal(result.todos.items[0].done, true);
});

await asyncTest('deterministic pattern: "<n> +<count>" logs weekly goal progress', async () => {
  const dir = path.join(tmpRoot, 'plus');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot 1 +2' })] },
  });
  const result = await runOnce(baseOpts(paths));
  assert.equal(result.todos.weeklyGoals[0].count, 3);
});

await asyncTest('deterministic pattern: "list" replies without changing todos', async () => {
  const dir = path.join(tmpRoot, 'list');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot list' })] },
  });
  const result = await runOnce(baseOpts(paths));
  assert.equal(result.todosChanged, false);
  assert.ok(result.sentReplies[0].includes('Existing item'));
});

await asyncTest('owner resolved from sender (from.id), not shared group chat id', async () => {
  const dir = path.join(tmpRoot, 'owner-resolution');
  const paths = writeFixture(dir, {
    updates: {
      ok: true,
      result: [
        msg(1, { fromId: 111, text: '@TestBot new: hanna item' }),
        msg(2, { fromId: 222, text: '@TestBot new: kevin item' }),
      ],
    },
  });
  const result = await runOnce(baseOpts(paths));
  assert.equal(result.todos.items[1].owner, 'hanna');
  assert.equal(result.todos.items[2].owner, 'kevin');
});

await asyncTest('LLM fallback: mocked tool-call response executes the right tool', async () => {
  const dir = path.join(tmpRoot, 'llm-fallback');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot please add buy diapers to the list' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_todo', input: { title: 'buy diapers' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todos.items[1].title, 'buy diapers');
  assert.equal(result.todos.items[1].owner, 'hanna');
});

await asyncTest('LLM fallback: a plain text answer (no tool call) is relayed, todos untouched', async () => {
  const dir = path.join(tmpRoot, 'llm-answer');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot how many open items are there?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'text', text: 'There is 1 open item.' }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todosChanged, false);
  assert.equal(result.sentReplies[0], 'There is 1 open item.');
});

await asyncTest('LLM fallback failure logs to unparsed and replies with help text', async () => {
  const dir = path.join(tmpRoot, 'llm-failure');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot ???' })] },
  });
  const mockClient = async () => { throw new Error('simulated API failure'); };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todosChanged, false);
  assert.ok(result.sentReplies[0].includes("Couldn't process"));
  assert.ok(fs.existsSync(paths.unparsedPath), 'unparsed log should have been written');
  const logged = JSON.parse(fs.readFileSync(paths.unparsedPath, 'utf8').trim().split('\n').pop());
  assert.ok(logged.reason.includes('llm_error'));
});

await asyncTest('the failure reply echoes back what was heard, so the sender knows what to rephrase', async () => {
  const dir = path.join(tmpRoot, 'llm-failure-echo');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot blah blah gibberish' })] },
  });
  const mockClient = async () => { throw new Error('simulated API failure'); };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.ok(result.sentReplies[0].includes('blah blah gibberish'), 'the reply should echo the stripped message text');
});

await asyncTest('mark_done with an out-of-range index replies with an error and current list, todos unchanged', async () => {
  const dir = path.join(tmpRoot, 'bad-index');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot 99 done' })] },
  });
  const result = await runOnce(baseOpts(paths));
  assert.equal(result.todosChanged, false);
  assert.ok(result.sentReplies[0].includes('No open item #99'));
});

await asyncTest('delete_todo: removes the item entirely (not just marks it done)', async () => {
  const dir = path.join(tmpRoot, 'delete-todo');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot never mind #1' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'delete_todo', input: { index: 1 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todos.items.length, 0, 'the item should be gone, not just marked done');
  assert.ok(result.sentReplies[0].includes('Deleted ✓'));
});

await asyncTest('delete_todo with an out-of-range index replies with an error, todos unchanged', async () => {
  const dir = path.join(tmpRoot, 'delete-todo-bad-index');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot delete #99' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'delete_todo', input: { index: 99 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todosChanged, false);
  assert.ok(result.sentReplies[0].includes('No open item #99'));
});

// --- remove_event (cancel a dining plan or family event) ---

await asyncTest('remove_event: cancels a confirmed dining pick by occasion, leaving an unrelated family event on the same date untouched', async () => {
  const dir = path.join(tmpRoot, 'remove-event-by-occasion');
  const nextWed = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot cancel family dinner' })] },
    monthPlanEvents: {
      events: {
        [nextWed]: [
          { source: 'manual', kind: 'dining', name: 'Test Bistro', favoriteName: 'Test Bistro', tier: 'mid', cost: 60, time: null },
          { source: 'manual', kind: 'family', name: 'School event', tier: 'low-key', cost: 0, time: null },
        ],
      },
    },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'remove_event', input: { occasion: 'family_dinner' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const events = result.monthPlanEvents.events[nextWed];
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'family', 'the family event should survive');
  assert.ok(result.sentReplies[0].includes('Removed ✓') && result.sentReplies[0].includes('Test Bistro'));
});

await asyncTest('remove_event: an explicit date with only one event removes it without needing a title', async () => {
  const dir = path.join(tmpRoot, 'remove-event-single');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot cancel the 2026-08-10 event' })] },
    monthPlanEvents: { events: { '2026-08-10': [{ source: 'manual', kind: 'family', name: 'Dentist appointment', tier: 'low-key', cost: 0, time: null }] } },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'remove_event', input: { date: '2026-08-10' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.deepEqual(result.monthPlanEvents.events['2026-08-10'], [], 'should tombstone to an empty array, not delete the key');
  assert.ok(result.sentReplies[0].includes('Dentist appointment'));
});

await asyncTest('remove_event: multiple events on a date with no title given asks for disambiguation rather than guessing', async () => {
  const dir = path.join(tmpRoot, 'remove-event-ambiguous');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot cancel something on 2026-08-10' })] },
    monthPlanEvents: {
      events: {
        '2026-08-10': [
          { source: 'manual', kind: 'family', name: 'Dentist appointment', tier: 'low-key', cost: 0, time: null },
          { source: 'manual', kind: 'family', name: 'Piano lesson', tier: 'low-key', cost: 0, time: null },
        ],
      },
    },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'remove_event', input: { date: '2026-08-10' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEventsChanged, false, 'nothing should be removed when the target is ambiguous');
  assert.ok(result.sentReplies[0].includes('Say which one'));
});

await asyncTest('remove_event: a title disambiguates which of several events on a date to remove', async () => {
  const dir = path.join(tmpRoot, 'remove-event-by-title');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot cancel the piano lesson on 2026-08-10' })] },
    monthPlanEvents: {
      events: {
        '2026-08-10': [
          { source: 'manual', kind: 'family', name: 'Dentist appointment', tier: 'low-key', cost: 0, time: null },
          { source: 'manual', kind: 'family', name: 'Piano lesson', tier: 'low-key', cost: 0, time: null },
        ],
      },
    },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'remove_event', input: { date: '2026-08-10', title: 'Piano' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const events = result.monthPlanEvents.events['2026-08-10'];
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'Dentist appointment', 'only the matched title should be removed');
});

await asyncTest('remove_event: nothing set for that date/occasion replies clearly rather than throwing', async () => {
  const dir = path.join(tmpRoot, 'remove-event-nothing-there');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot cancel date night' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'remove_event', input: { occasion: 'date_night' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEventsChanged, false);
  assert.ok(result.sentReplies[0].includes('Nothing set for'));
});

// --- add_family_event recurrence ---

await asyncTest('add_family_event: recurrenceWeeks materializes N independent weekly occurrences', async () => {
  const dir = path.join(tmpRoot, 'family-event-recurring');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot add piano lesson every Tuesday starting 2026-08-11 for 3 weeks' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_family_event', input: { date: '2026-08-11', title: 'Piano lesson', recurrenceWeeks: 3 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEvents.events['2026-08-11'][0].name, 'Piano lesson');
  assert.equal(result.monthPlanEvents.events['2026-08-18'][0].name, 'Piano lesson');
  assert.equal(result.monthPlanEvents.events['2026-08-25'][0].name, 'Piano lesson');
  assert.equal(result.monthPlanEvents.events['2026-08-11'][0].recurrenceId, result.monthPlanEvents.events['2026-08-25'][0].recurrenceId);
  assert.ok(result.sentReplies[0].includes('weekly for 3 weeks'));
});

await asyncTest('add_family_event: an oversized recurrenceWeeks is capped rather than generating a runaway series', async () => {
  const dir = path.join(tmpRoot, 'family-event-recurring-capped');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot add piano lesson every Tuesday starting 2026-08-11 forever' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_family_event', input: { date: '2026-08-11', title: 'Piano lesson', recurrenceWeeks: 999 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const occurrenceCount = Object.values(result.monthPlanEvents.events).filter((evs) => evs.some((e) => e.name === 'Piano lesson')).length;
  assert.equal(occurrenceCount, 52, 'should cap at 52 occurrences, not honor an unbounded count');
});

await asyncTest('add_family_event: recurrenceWeeks omitted (or 1) stays a single one-off event with no recurrenceId', async () => {
  const dir = path.join(tmpRoot, 'family-event-non-recurring');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot add dentist appointment on 2026-08-10' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_family_event', input: { date: '2026-08-10', title: 'Dentist appointment' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEvents.events['2026-08-10'][0].recurrenceId, undefined);
});

await asyncTest('offset advances past every message in a fully-successful batch', async () => {
  const dir = path.join(tmpRoot, 'offset-success');
  const paths = writeFixture(dir, {
    updates: {
      ok: true,
      result: [
        msg(10, { fromId: 111, text: 'unaddressed' }),
        msg(11, { fromId: 111, text: '@TestBot new: a' }),
      ],
    },
  });
  // dryRun:true skips saving the offset file, so run without dryRun (still
  // updatesFixture, so no real Telegram calls happen) to inspect the saved offset.
  await runOnce(baseOpts(paths, { dryRun: false }));
  const offset = JSON.parse(fs.readFileSync(paths.offsetPath, 'utf8'));
  assert.equal(offset.next_offset, 12);
});

// --- One combined Telegram send per poll batch (2026-08-01), not one send per message ---

await asyncTest('a batch of several messages gets exactly one combined sendMessage call, not one per message', async () => {
  const dir = path.join(tmpRoot, 'batch-combined-send');
  const paths = writeFixture(dir, {
    updates: {
      ok: true,
      result: [
        msg(1, { fromId: 111, text: 'new: buy milk' }),
        msg(2, { fromId: 222, text: '1 done' }),
      ],
    },
  });
  const sendCalls = [];
  const mockTelegramClient = async (token, method, body) => { sendCalls.push({ method, body }); return { ok: true }; };
  await runOnce(baseOpts(paths, { dryRun: false, telegramClient: mockTelegramClient }));

  assert.equal(sendCalls.length, 1, 'exactly one sendMessage call should cover the whole batch');
  assert.equal(sendCalls[0].method, 'sendMessage');
  assert.ok(sendCalls[0].body.text.includes('Added'), 'combined text should include the first reply');
  assert.ok(sendCalls[0].body.text.includes('Marked done'), 'combined text should include the second reply');
  assert.equal(sendCalls[0].body.reply_to_message_id, undefined, 'a combined reply to multiple messages should not thread to any single one');
});

await asyncTest('a single-message batch still threads its reply to that message', async () => {
  const dir = path.join(tmpRoot, 'batch-single-still-threaded');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(5, { fromId: 111, text: 'new: buy milk' })] },
  });
  const sendCalls = [];
  const mockTelegramClient = async (token, method, body) => { sendCalls.push({ method, body }); return { ok: true }; };
  await runOnce(baseOpts(paths, { dryRun: false, telegramClient: mockTelegramClient }));

  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].body.reply_to_message_id, 1005, 'the single message\'s own message_id (updateId 5 + 1000, per the msg() helper)');
});

await asyncTest('a batch where nothing was processed (all skipped) sends nothing at all', async () => {
  const dir = path.join(tmpRoot, 'batch-nothing-processed');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 999, text: 'hello' })] }, // unrecognized sender
  });
  const sendCalls = [];
  const mockTelegramClient = async (token, method, body) => { sendCalls.push({ method, body }); return { ok: true }; };
  await runOnce(baseOpts(paths, { dryRun: false, telegramClient: mockTelegramClient }));

  assert.equal(sendCalls.length, 0);
});

// --- "Default to intelligence every time" (2026-08-01): naturalizeBatch() composes one reply over the whole batch ---
// `sentReplies` always stays the raw per-message template strings (so the
// exhaustive tool-behavior tests above never needed to change); the
// naturalized, actually-sent text is a separate `combinedReply` field.

await asyncTest('naturalizeBatch: a single deterministically-parsed action gets composed via combinedReply when a rephraseClient is available', async () => {
  const dir = path.join(tmpRoot, 'naturalize-deterministic');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'new: buy milk' })] },
  });
  let capturedItems = null;
  const mockRephraseClient = async ({ items }) => {
    capturedItems = items;
    return { content: [{ type: 'text', text: 'Got it, added that for you!' }] };
  };
  const result = await runOnce(baseOpts(paths, { rephraseClient: mockRephraseClient }));
  assert.equal(capturedItems.length, 1);
  assert.ok(capturedItems[0].rawReply.includes('Added'), 'the rephrase call should see the raw template text');
  assert.equal(capturedItems[0].userText, 'new: buy milk');
  assert.equal(result.combinedReply, 'Got it, added that for you!', 'combinedReply is the composed text, not the raw template');
  assert.ok(result.sentReplies[0].includes('Added'), 'sentReplies stays the raw per-message text, unaffected by naturalization');
  assert.equal(result.todos.items.length, 2, 'the underlying action should still have happened regardless of rephrasing');
});

await asyncTest('naturalizeBatch: an LLM-tool-invoked action also gets composed, not just deterministic ones', async () => {
  const dir = path.join(tmpRoot, 'naturalize-tool-invoked');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'please add buy diapers' })] },
  });
  const mockAnthropic = async () => ({ content: [{ type: 'tool_use', name: 'add_todo', input: { title: 'buy diapers' } }] });
  const mockRephraseClient = async () => ({ content: [{ type: 'text', text: 'Sure thing, diapers are on the list.' }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic, rephraseClient: mockRephraseClient }));
  assert.equal(result.combinedReply, 'Sure thing, diapers are on the list.');
});

await asyncTest('naturalizeBatch: multiple distinct asks in one batch are handed to the LLM together, in one call, not rephrased separately', async () => {
  const dir = path.join(tmpRoot, 'naturalize-multi-distinct');
  const paths = writeFixture(dir, {
    updates: {
      ok: true,
      result: [
        msg(1, { fromId: 111, text: 'new: buy milk' }),
        msg(2, { fromId: 222, text: '1 done' }),
      ],
    },
  });
  let callCount = 0;
  let capturedItems = null;
  const mockRephraseClient = async ({ items }) => {
    callCount += 1;
    capturedItems = items;
    return { content: [{ type: 'text', text: 'Added buy milk to the list, and marked the first item done.' }] };
  };
  const result = await runOnce(baseOpts(paths, { rephraseClient: mockRephraseClient }));
  assert.equal(callCount, 1, 'the whole batch should be composed in exactly one rephrase call, not one per message');
  assert.equal(capturedItems.length, 2);
  assert.ok(capturedItems[0].rawReply.includes('Added'));
  assert.ok(capturedItems[1].rawReply.includes('Marked done'));
  assert.equal(result.combinedReply, 'Added buy milk to the list, and marked the first item done.');
});

await asyncTest('naturalizeBatch: with no apiKey and no rephraseClient, combinedReply falls back to a plain join of the raw replies', async () => {
  const dir = path.join(tmpRoot, 'naturalize-degrades');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'new: buy milk' })] },
  });
  const result = await runOnce(baseOpts(paths));
  assert.ok(result.combinedReply.includes('Added ✓'), 'without any rephrase capability, the raw template string should pass through unchanged');
});

await asyncTest('naturalizeBatch: a rephrase failure falls back to a plain join of the raw replies rather than losing the confirmation', async () => {
  const dir = path.join(tmpRoot, 'naturalize-failure-fallback');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'new: buy milk' })] },
  });
  const mockRephraseClient = async () => { throw new Error('rephrase API down'); };
  const result = await runOnce(baseOpts(paths, { rephraseClient: mockRephraseClient }));
  assert.ok(result.combinedReply.includes('Added ✓'), 'a rephrase failure should never lose the underlying confirmation');
  assert.equal(result.todos.items.length, 2, 'the action itself must still have succeeded');
});

// --- Dining-planning tools (Part 3) — only reachable via the LLM fallback, no deterministic pattern ---

await asyncTest('get_dining_plan: reports a fresh suggestion when nothing is set yet for that occasion', async () => {
  const dir = path.join(tmpRoot, 'dining-get-suggestion');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot what\'s the plan for family dinner?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_dining_plan', input: { occasion: 'family_dinner' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEventsChanged, false, 'a read-only get_dining_plan must not change monthPlanEvents');
  assert.ok(result.sentReplies[0].includes('Test Bistro'), 'should suggest the one seeded favorite matching familyFriendly');
});

// extraExcludeNames is an internal, same-process parameter (used by the
// weekly recap's diningSummary() to avoid all 3 occasions suggesting the
// same place — see telegram-bot-recap.mjs) — nothing in a Telegram message
// or an LLM tool_use call ever supplies it, so these two cases call
// get_dining_plan directly rather than through the runOnce/dispatch pipeline
// every other test here uses.
const diningContextFixture = () => ({
  diningRoutine: [
    { dayOfWeek: 3, tier: 'mid', dynamic: false, requiresTag: 'familyFriendly' },
  ],
  lowKeyHangIdeas: ['Movie night at home'],
  favorites: [
    { name: 'Place A', cuisine: 'Italian', list: 'go-to', familyFriendly: true, observed: { tier: 'mid', avgSpend: 60 } },
    { name: 'Place B', cuisine: 'Japanese', list: 'go-to', familyFriendly: true, observed: { tier: 'mid', avgSpend: 60 } },
  ],
  recentDiningActivity: [],
  routineOverrides: {},
});

await asyncTest('get_dining_plan: extraExcludeNames containing the would-be top pick returns a different suggestion', () => {
  const monthPlanEvents = { events: {} };
  const first = get_dining_plan(monthPlanEvents, { occasion: 'family_dinner' }, diningContextFixture());
  assert.ok(first.suggestedName, 'should suggest one of the two eligible places');
  const second = get_dining_plan(monthPlanEvents, { occasion: 'family_dinner' }, diningContextFixture(), new Set([first.suggestedName]));
  assert.ok(second.suggestedName, 'a second eligible place should still be available');
  assert.notEqual(second.suggestedName, first.suggestedName, 'excluding the first pick should surface the other one');
});

await asyncTest('get_dining_plan: extraExcludeNames covering every eligible place still suggests one anyway (a repeat beats no suggestion)', () => {
  const monthPlanEvents = { events: {} };
  const context = diningContextFixture();
  const result = get_dining_plan(monthPlanEvents, { occasion: 'family_dinner' }, context, new Set(['Place A', 'Place B']));
  assert.ok(['Place A', 'Place B'].includes(result.suggestedName), 'excluding every candidate should fall back to a repeat, not report nothing — recommendForSlot\'s existing, intentional fallback');
});

await asyncTest('get_dining_plan: no eligible favorites at all reports no fresh suggestion, not a crash', () => {
  const monthPlanEvents = { events: {} };
  const context = { ...diningContextFixture(), favorites: [] };
  const result = get_dining_plan(monthPlanEvents, { occasion: 'family_dinner' }, context);
  assert.equal(result.suggestedName, null);
  assert.ok(result.reply.includes("don't have a fresh suggestion"));
});

// Calendar-coverage (2026-08-02): checked *before* generating a suggestion,
// not appended after — see telegram-bot-tools.mjs's findEveningCalendarCoverage.
// Real bug this fixes: Kevin telling the bot he's joining a dinner Hanna
// already had on her personal calendar still got a fresh Terra Eataly
// suggestion alongside a heads-up, rather than recognizing the slot as covered.
const nextWedForCalendarTests = () => {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

await asyncTest('get_dining_plan: an evening calendar event on the occasion\'s date suppresses the suggestion, reporting the slot as covered', () => {
  const monthPlanEvents = { events: {} };
  const nextWed = nextWedForCalendarTests();
  const context = { ...diningContextFixture(), calendarEvents: [{ label: 'Hanna', title: 'Shannon/Ryan Dinner', date: nextWed, time: '17:00', isRecurring: false }] };
  const result = get_dining_plan(monthPlanEvents, { occasion: 'family_dinner' }, context);
  assert.equal(result.suggestedName, null, 'no suggestion should be generated when the slot looks covered');
  assert.ok(result.reply.includes('looks already covered'));
  assert.ok(result.reply.includes('Hanna: Shannon/Ryan Dinner'));
});

await asyncTest('get_dining_plan: a same-day morning-only calendar event does not suppress the suggestion', () => {
  const monthPlanEvents = { events: {} };
  const nextWed = nextWedForCalendarTests();
  const context = { ...diningContextFixture(), calendarEvents: [{ label: 'Hanna', title: 'PT', date: nextWed, time: '09:00', isRecurring: false }] };
  const result = get_dining_plan(monthPlanEvents, { occasion: 'family_dinner' }, context);
  assert.ok(result.suggestedName, 'a morning appointment should not suppress an evening dining suggestion');
  assert.ok(result.reply.includes('suggestion:'));
});

await asyncTest('get_dining_plan: a same-day all-day calendar event does not suppress the suggestion', () => {
  const monthPlanEvents = { events: {} };
  const nextWed = nextWedForCalendarTests();
  const context = { ...diningContextFixture(), calendarEvents: [{ label: 'Hanna', title: 'Kid\'s birthday', date: nextWed, time: null, isRecurring: false }] };
  const result = get_dining_plan(monthPlanEvents, { occasion: 'family_dinner' }, context);
  assert.ok(result.suggestedName, 'an untimed/all-day event is not clearly dinner-shaped and should not suppress a suggestion');
});

await asyncTest('get_dining_plan: an evening calendar event on a different date does not suppress the suggestion', () => {
  const monthPlanEvents = { events: {} };
  const context = { ...diningContextFixture(), calendarEvents: [{ label: 'Hanna', title: 'Dinner elsewhere', date: '2020-01-01', time: '18:00', isRecurring: false }] };
  const result = get_dining_plan(monthPlanEvents, { occasion: 'family_dinner' }, context);
  assert.ok(result.suggestedName, 'a conflict on an unrelated date should not affect this occasion');
});

await asyncTest('get_dining_plan: a recurring evening calendar block (e.g. a daily routine reminder) does not suppress the suggestion', () => {
  const monthPlanEvents = { events: {} };
  const nextWed = nextWedForCalendarTests();
  const context = { ...diningContextFixture(), calendarEvents: [{ label: 'Kevin', title: 'Eat', date: nextWed, time: '16:00', isRecurring: true }] };
  const result = get_dining_plan(monthPlanEvents, { occasion: 'family_dinner' }, context);
  assert.ok(result.suggestedName, 'a recurring personal-routine block is not a special commitment and should not suppress a suggestion — found live against a real recurring "Eat" reminder');
});

await asyncTest('get_dining_plan: reports an already-decided plan instead of suggesting', async () => {
  const dir = path.join(tmpRoot, 'dining-get-existing');
  // Compute the next Wednesday so the fixture's pre-set event actually lines
  // up with what get_dining_plan will look up.
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7));
  const nextWed = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot what\'s the plan for family dinner?' })] },
    monthPlanEvents: { events: { [nextWed]: [{ name: 'Already Decided Spot', tier: 'mid' }] } },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_dining_plan', input: { occasion: 'family_dinner' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.ok(result.sentReplies[0].includes('Already Decided Spot'), 'should report the pre-set plan rather than a fresh suggestion');
  assert.ok(!result.sentReplies[0].includes('Test Bistro'), 'should not suggest an alternative when one is already set');
});

await asyncTest('set_dinner_plan: writes the chosen pick into monthPlanEvents (persisted, not just replied)', async () => {
  const dir = path.join(tmpRoot, 'dining-set');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot book Test Bistro for date night' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'date_night', pick: 'Test Bistro' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEventsChanged, true, 'set_dinner_plan should mark monthPlanEvents as changed');
  const allEvents = Object.values(result.monthPlanEvents.events).flat();
  assert.equal(allEvents.length, 1);
  assert.equal(allEvents[0].favoriteName, 'Test Bistro', 'a matched favorite should be recorded via favoriteName, with its observed tier/cost resolved');
  assert.equal(allEvents[0].tier, 'mid');
  assert.equal(allEvents[0].cost, 60);
  assert.equal(allEvents[0].time, null, 'no time was mentioned, so the event should stay untimed');
  assert.ok(result.sentReplies[0].includes('Set ✓') && result.sentReplies[0].includes('Test Bistro'));
});

await asyncTest('set_dinner_plan: an explicit time is parsed, stored, and reported back on both the confirmation and a later lookup', async () => {
  const dir = path.join(tmpRoot, 'dining-set-time');
  const paths = writeFixture(dir, {
    updates: {
      ok: true,
      result: [
        msg(1, { fromId: 222, text: '@TestBot book Test Bistro for family dinner at 5pm' }),
        msg(2, { fromId: 111, text: '@TestBot what\'s the plan for family dinner?' }),
      ],
    },
  });
  const mockClient = async ({ text }) => {
    if (text.includes('book')) {
      return { content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'family_dinner', pick: 'Test Bistro', time: '5pm' } }] };
    }
    return { content: [{ type: 'tool_use', name: 'get_dining_plan', input: { occasion: 'family_dinner' } }] };
  };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const allEvents = Object.values(result.monthPlanEvents.events).flat();
  assert.equal(allEvents[0].time, '17:00', 'a "5pm" input should normalize to 24-hour HH:MM');
  assert.ok(result.sentReplies[0].includes('at 5pm'), 'the confirmation reply should show the time in 12-hour form');
  assert.ok(result.sentReplies[1].includes('at 5pm'), 'a later lookup of the same slot should report the stored time too');
});

await asyncTest('set_dinner_plan: a bare hour with no am/pm defaults to evening ("5" -> 17:00)', async () => {
  const dir = path.join(tmpRoot, 'dining-set-bare-hour');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot book Test Bistro for date night at 5' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'date_night', pick: 'Test Bistro', time: '5' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const allEvents = Object.values(result.monthPlanEvents.events).flat();
  assert.equal(allEvents[0].time, '17:00');
});

await asyncTest('set_dinner_plan: an unparseable time is dropped rather than guessed, event stays untimed', async () => {
  const dir = path.join(tmpRoot, 'dining-set-bad-time');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot book Test Bistro for date night sometime soonish' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'date_night', pick: 'Test Bistro', time: 'sometime soonish' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const allEvents = Object.values(result.monthPlanEvents.events).flat();
  assert.equal(allEvents[0].time, null);
});

await asyncTest('set_dinner_plan persists to disk (not just the in-memory return value) when not a dry run', async () => {
  const dir = path.join(tmpRoot, 'dining-set-persisted');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot set weekend social to Test Bistro' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'weekend_social', pick: 'Test Bistro' } }],
  });
  await runOnce(baseOpts(paths, { anthropicClient: mockClient, dryRun: false }));
  const onDisk = JSON.parse(fs.readFileSync(paths.monthPlanEventsPath, 'utf8'));
  const allEvents = Object.values(onDisk.events).flat();
  assert.equal(allEvents.length, 1, 'the write should have landed on disk, not just in the returned in-memory object');
});

await asyncTest('an unrecognized occasion name replies with a clear error rather than throwing', async () => {
  const dir = path.join(tmpRoot, 'dining-bad-occasion');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot what\'s the plan for brunch?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_dining_plan', input: { occasion: 'brunch' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEventsChanged, false);
  assert.ok(result.sentReplies[0].includes("don't recognize"));
});

// --- General family events (add_family_event) — one-off events on any date, not tied to the 3 dining occasions ---

await asyncTest('add_family_event: stores a new event on the given date with no cost/tier pollution', async () => {
  const dir = path.join(tmpRoot, 'family-event-add');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot add dentist appointment on 2026-08-10' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_family_event', input: { date: '2026-08-10', title: 'Dentist appointment' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const events = result.monthPlanEvents.events['2026-08-10'];
  assert.equal(events.length, 1);
  assert.equal(events[0].name, 'Dentist appointment');
  assert.equal(events[0].kind, 'schedule', 'appointments classify as schedule (Google Cal, not Month Plan spend)');
  assert.equal(events[0].cost, 0, 'a general event must not be treated as a dining spend by budget math');
  assert.equal(events[0].tier, 'low-key');
  assert.equal(events[0].time, null);
  assert.ok(result.sentReplies[0].includes('Added ✓') && result.sentReplies[0].includes('Dentist appointment'));
  assert.ok(result.sentReplies[0].includes('schedule'));
});

await asyncTest('add_family_event: an unambiguous explicit time is stored; an ambiguous bare hour is not', async () => {
  const dir = path.join(tmpRoot, 'family-event-time');
  const paths = writeFixture(dir, {
    updates: {
      ok: true,
      result: [
        msg(1, { fromId: 111, text: '@TestBot add school pickup on 2026-08-11 at 9am' }),
        msg(2, { fromId: 111, text: '@TestBot add piano lesson on 2026-08-12 at 4' }),
      ],
    },
  });
  const mockClient = async ({ text }) => {
    if (text.includes('pickup')) {
      return { content: [{ type: 'tool_use', name: 'add_family_event', input: { date: '2026-08-11', title: 'School pickup', time: '9am' } }] };
    }
    return { content: [{ type: 'tool_use', name: 'add_family_event', input: { date: '2026-08-12', title: 'Piano lesson', time: '4' } }] };
  };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEvents.events['2026-08-11'][0].time, '09:00', 'explicit am/pm should resolve');
  assert.equal(result.monthPlanEvents.events['2026-08-12'][0].time, null, 'a bare hour with no am/pm must not be guessed for a general event');
});

await asyncTest('add_family_event: missing date or title replies with a clear error rather than throwing', async () => {
  const dir = path.join(tmpRoot, 'family-event-missing-date');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot add a family event sometime' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_family_event', input: { date: 'not-a-date', title: 'Something' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEventsChanged, false);
  assert.ok(result.sentReplies[0].includes('need a specific date'));
});

await asyncTest('add_family_event appends to (rather than replacing) an existing dining pick on the same date, and vice versa', async () => {
  const dir = path.join(tmpRoot, 'family-event-coexists-with-dining');
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7));
  const nextWed = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const paths = writeFixture(dir, {
    updates: {
      ok: true,
      result: [
        msg(1, { fromId: 222, text: '@TestBot book Test Bistro for family dinner' }),
        msg(2, { fromId: 111, text: `@TestBot add a school event on ${nextWed}` }),
      ],
    },
  });
  const mockClient = async ({ text }) => {
    if (text.includes('book')) {
      return { content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'family_dinner', pick: 'Test Bistro' } }] };
    }
    return { content: [{ type: 'tool_use', name: 'add_family_event', input: { date: nextWed, title: 'School event' } }] };
  };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const events = result.monthPlanEvents.events[nextWed];
  assert.equal(events.length, 2, 'both the dining pick and the schedule event should coexist on the same date');
  assert.ok(events.some((e) => e.kind === 'dining' && e.favoriteName === 'Test Bistro'));
  assert.ok(events.some((e) => e.kind === 'schedule' && e.name === 'School event'));
});

await asyncTest('set_dinner_plan replaces only the prior dining pick on a date, preserving a schedule event already there', async () => {
  const dir = path.join(tmpRoot, 'dining-replace-preserves-family-event');
  const nextWed = (() => {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + ((3 - d.getDay() + 7) % 7));
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  })();
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot book Test Bistro for family dinner' })] },
    monthPlanEvents: { events: { [nextWed]: [{ source: 'manual', kind: 'schedule', name: 'School event', tier: 'low-key', cost: 0, time: null }] } },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'family_dinner', pick: 'Test Bistro' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const events = result.monthPlanEvents.events[nextWed];
  assert.equal(events.length, 2);
  assert.ok(events.some((e) => e.kind === 'schedule' && e.name === 'School event'), 'the pre-existing schedule event must survive a dining confirmation on the same date');
  assert.ok(events.some((e) => e.kind === 'dining' && e.favoriteName === 'Test Bistro'));
});

await asyncTest('add_family_event: friend dinner classifies as family (Month Plan spend)', async () => {
  const dir = path.join(tmpRoot, 'family-event-social-dinner');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot add dinner with Sam on 2026-08-14' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_family_event', input: { date: '2026-08-14', title: 'Dinner with Sam' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEvents.events['2026-08-14'][0].kind, 'family');
  assert.ok(result.sentReplies[0].includes('social'));
});

await asyncTest('add_family_event: ambiguous title asks instead of guessing kind', async () => {
  const dir = path.join(tmpRoot, 'family-event-ambiguous');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot add Nikola thing on 2026-08-14' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_family_event', input: { date: '2026-08-14', title: 'Nikola thing' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient, dryRun: false }));
  assert.equal(result.monthPlanEventsChanged, false);
  assert.ok(result.sentReplies[0].includes('Say which'));
  assert.equal(result.pendingClarificationsChanged, true);
  const onDisk = JSON.parse(fs.readFileSync(paths.pendingClarificationsPath, 'utf8'));
  assert.ok(onDisk.hanna?.question?.includes('Nikola thing'));
});

// --- Configurable duration (set_dinner_plan / add_family_event) ---

await asyncTest('set_dinner_plan: an explicit durationHours is stored on the event', async () => {
  const dir = path.join(tmpRoot, 'dining-set-duration');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot book Test Bistro for date night at 6pm for 90 minutes' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'date_night', pick: 'Test Bistro', time: '6pm', durationHours: 1.5 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const allEvents = Object.values(result.monthPlanEvents.events).flat();
  assert.equal(allEvents[0].durationHours, 1.5);
});

await asyncTest('set_dinner_plan: an out-of-range durationHours is clamped rather than stored as-is', async () => {
  const dir = path.join(tmpRoot, 'dining-set-duration-clamped');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot book Test Bistro for date night, all night' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'date_night', pick: 'Test Bistro', durationHours: 40 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const allEvents = Object.values(result.monthPlanEvents.events).flat();
  assert.equal(allEvents[0].durationHours, 8, 'should clamp to the 8-hour ceiling');
});

await asyncTest('add_family_event: an explicit durationHours is stored on the event', async () => {
  const dir = path.join(tmpRoot, 'family-event-duration');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot add a 30 minute dentist appointment on 2026-08-10' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'add_family_event', input: { date: '2026-08-10', title: 'Dentist appointment', durationHours: 0.5 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.monthPlanEvents.events['2026-08-10'][0].durationHours, 0.5);
});

// --- set_routine_day (bot-editable routine days) ---

function nextDateForWeekday(dayOfWeek) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + ((dayOfWeek - d.getDay() + 7) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

await asyncTest('set_routine_day: rescheduling family dinner to Thursday changes which date get_dining_plan reports on', async () => {
  const dir = path.join(tmpRoot, 'routine-day-reschedule');
  const paths = writeFixture(dir, {
    updates: {
      ok: true,
      result: [
        msg(1, { fromId: 222, text: '@TestBot let\'s move family dinner to Thursdays' }),
        msg(2, { fromId: 111, text: '@TestBot what\'s the plan for family dinner?' }),
      ],
    },
  });
  const mockClient = async ({ text }) => {
    if (text.includes('move')) {
      return { content: [{ type: 'tool_use', name: 'set_routine_day', input: { occasion: 'family_dinner', dayOfWeek: 4 } }] };
    }
    return { content: [{ type: 'tool_use', name: 'get_dining_plan', input: { occasion: 'family_dinner' } }] };
  };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.ok(result.sentReplies[0].includes('moved to Thursdays'));
  assert.ok(result.sentReplies[1].includes(nextDateForWeekday(4)), 'the lookup should now resolve against Thursday, not the original Wednesday');
  assert.ok(!result.sentReplies[1].includes(nextDateForWeekday(3)), 'should no longer report against the old Wednesday date');
});

await asyncTest('set_routine_day: persists to disk (not just the in-memory return value) when not a dry run', async () => {
  const dir = path.join(tmpRoot, 'routine-day-persisted');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: '@TestBot move date night to Sunday' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_routine_day', input: { occasion: 'date_night', dayOfWeek: 0 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient, dryRun: false }));
  assert.equal(result.routineOverridesChanged, true);
  const onDisk = JSON.parse(fs.readFileSync(paths.routineOverridesPath, 'utf8'));
  assert.equal(onDisk.date_night, 0);
});

await asyncTest('set_routine_day: an unrecognized occasion replies with a clear error rather than throwing', async () => {
  const dir = path.join(tmpRoot, 'routine-day-bad-occasion');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot move brunch to Sunday' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_routine_day', input: { occasion: 'brunch', dayOfWeek: 0 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.routineOverridesChanged, false);
  assert.ok(result.sentReplies[0].includes("don't recognize"));
});

await asyncTest('set_routine_day: an invalid dayOfWeek replies with a clear error rather than storing garbage', async () => {
  const dir = path.join(tmpRoot, 'routine-day-bad-day');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot move family dinner to someday' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'set_routine_day', input: { occasion: 'family_dinner', dayOfWeek: 9 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.routineOverridesChanged, false);
  assert.ok(result.sentReplies[0].includes('day of week'));
});

await asyncTest('a pre-existing routine override (from a prior session) is honored on a fresh run', async () => {
  const dir = path.join(tmpRoot, 'routine-day-pre-existing-override');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot what\'s the plan for family dinner?' })] },
    routineOverrides: { family_dinner: 4, date_night: null, weekend_social: null },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_dining_plan', input: { occasion: 'family_dinner' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.ok(result.sentReplies[0].includes(nextDateForWeekday(4)), 'should honor the override already on disk, not the goals.json default');
});

// --- Financial Q&A tools (Part C) — read-only over financialContext, only reachable via the LLM fallback ---

await asyncTest('get_budget_status: reports joint/personal pace and travel actuals, no writes', async () => {
  const dir = path.join(tmpRoot, 'financial-budget-status');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot how are we pacing on budget?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_budget_status', input: {} }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todosChanged, false, 'a read-only financial tool must not change todos');
  assert.equal(result.monthPlanEventsChanged, false, 'a read-only financial tool must not change monthPlanEvents');
  assert.ok(result.sentReplies[0].includes('Joint:'), 'should report joint pace');
  assert.ok(result.sentReplies[0].includes('Kevin personal:'), 'should report personal pace');
  assert.ok(result.sentReplies[0].includes('Test Trip'), 'should report the seeded travel trip');
});

await asyncTest('get_savings_goals: reports each goal\'s current/target/percentage', async () => {
  const dir = path.join(tmpRoot, 'financial-savings-goals');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot how are our savings goals doing?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_savings_goals', input: {} }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todosChanged, false);
  assert.ok(result.sentReplies[0].includes('Test Fund'), 'should report the seeded life goal by name');
  assert.ok(result.sentReplies[0].includes('25%'), '2500/10000 should compute to 25%');
});

await asyncTest('get_decisions: lists open decisions, urgent ones first', async () => {
  const dir = path.join(tmpRoot, 'financial-decisions');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot any open decisions?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_decisions', input: {} }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todosChanged, false);
  const reply = result.sentReplies[0];
  assert.ok(reply.includes('[urgent] Urgent test decision — Do the urgent thing'));
  assert.ok(reply.includes('[watch] Watch test decision — Keep an eye on it'));
  assert.ok(reply.indexOf('Urgent test decision') < reply.indexOf('Watch test decision'), 'urgent decisions should be listed first');
});

await asyncTest('search_transactions: finds a matching current-cycle line item by merchant, with its category and tracker', async () => {
  const dir = path.join(tmpRoot, 'financial-search-transactions-match');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot does the joint include a geico charge?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'search_transactions', input: { merchant: 'Geico' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todosChanged, false, 'a read-only financial tool must not change todos');
  assert.equal(result.monthPlanEventsChanged, false, 'a read-only financial tool must not change monthPlanEvents');
  const reply = result.sentReplies[0];
  assert.ok(reply.includes('Geico'), 'should include the matching merchant');
  assert.ok(reply.includes('$489'), 'should include the amount (fmtMoney rounds to the nearest dollar)');
  assert.ok(reply.includes('Insurance'), 'should include the category grouping');
  assert.ok(reply.includes('joint'), 'should include the tracker');
  assert.ok(!reply.includes('Whole Foods'), 'should not include non-matching merchants');
});

await asyncTest('search_transactions: an unmatched merchant replies with a clear no-match message', async () => {
  const dir = path.join(tmpRoot, 'financial-search-transactions-no-match');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot was there a Nonexistent charge?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'search_transactions', input: { merchant: 'Nonexistent' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  assert.equal(result.todosChanged, false);
  assert.equal(result.monthPlanEventsChanged, false);
  assert.ok(result.sentReplies[0].includes('No matching current-cycle transactions found.'));
});

await asyncTest('search_transactions: tracker filter restricts to that tracker only', async () => {
  const dir = path.join(tmpRoot, 'financial-search-transactions-tracker-filter');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot what\'s in the travel spending this cycle?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'search_transactions', input: { tracker: 'travel' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient }));
  const reply = result.sentReplies[0];
  assert.ok(reply.includes('United Airlines'), 'should include the travel line item');
  assert.ok(!reply.includes('Geico'), 'should not include the joint line item');
  assert.ok(!reply.includes('Blue Bottle'), 'should not include the personal line item');
});

// --- get_calendar_events (Kevin personal + Hanna's Google Calendars, read-only) ---

await asyncTest('get_calendar_events: reports events from the configured read calendars, no writes', async () => {
  const dir = path.join(tmpRoot, 'calendar-events-basic');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot what\'s on the calendar this week?' })] },
  });
  const mockAnthropic = async () => ({ content: [{ type: 'tool_use', name: 'get_calendar_events', input: {} }] });
  const mockCalendarClient = { listEvents: async (calendarId) => (calendarId === 'kevin@personal.com' ? [{ summary: 'Dentist', start: { dateTime: '2026-08-05T09:00:00-07:00' } }] : []) };
  const result = await runOnce(baseOpts(paths, {
    anthropicClient: mockAnthropic,
    calendarReadClient: mockCalendarClient,
    calendarReadCalendarIds: [{ id: 'kevin@personal.com', label: 'Kevin' }, { id: 'hanna@email.com', label: 'Hanna' }],
  }));
  assert.equal(result.todosChanged, false);
  assert.equal(result.monthPlanEventsChanged, false);
  assert.ok(result.sentReplies[0].includes('[Kevin] Dentist'));
});

await asyncTest('get_calendar_events: not configured yet replies clearly rather than throwing', async () => {
  const dir = path.join(tmpRoot, 'calendar-events-not-configured');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot what\'s on the calendar?' })] },
  });
  const mockAnthropic = async () => ({ content: [{ type: 'tool_use', name: 'get_calendar_events', input: {} }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.ok(result.sentReplies[0].includes("isn't set up yet"));
});

await asyncTest('get_calendar_events: a Calendar API failure replies clearly rather than crashing the poll', async () => {
  const dir = path.join(tmpRoot, 'calendar-events-api-failure');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot what\'s on the calendar?' })] },
  });
  const mockAnthropic = async () => ({ content: [{ type: 'tool_use', name: 'get_calendar_events', input: {} }] });
  const mockCalendarClient = { listEvents: async () => { throw new Error('token expired'); } };
  const result = await runOnce(baseOpts(paths, {
    anthropicClient: mockAnthropic,
    calendarReadClient: mockCalendarClient,
    calendarReadCalendarIds: [{ id: 'kevin@personal.com', label: 'Kevin' }],
  }));
  // A per-calendar error is swallowed by getUpcomingEvents itself (skipped,
  // not fatal) — with only one configured calendar erroring, the reply
  // should be the "no events found" fallback, not a thrown exception.
  assert.ok(result.sentReplies[0].includes('No events found'));
});

// --- get_upcoming_shows (live web search against venues_to_follow.json, mocked) ---

function writeVenuesFixture(dir, venues) {
  fs.mkdirSync(dir, { recursive: true });
  const venuesPath = path.join(dir, 'venues_to_follow.json');
  fs.writeFileSync(venuesPath, JSON.stringify({ venues, weekendSocialSpots: {} }, null, 2));
  return venuesPath;
}

await asyncTest('get_upcoming_shows: reports findings and writes them to the cache file', async () => {
  const dir = path.join(tmpRoot, 'upcoming-shows-basic');
  const venuesPath = writeVenuesFixture(dir, [{ name: 'Largo at the Coronet', area: 'central', address: '366 N La Cienega Blvd' }]);
  const cachePath = path.join(dir, 'upcoming_shows_cache.json');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot any good shows coming up?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_upcoming_shows', input: {} }],
  });
  const mockShowsClient = async () => ({
    content: [
      { type: 'text', text: 'Largo at the Coronet has a show Aug 20.' },
      { type: 'web_search_tool_result', content: [{ url: 'https://example.com/show' }] },
    ],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient, showsClient: mockShowsClient, venuesToFollowPath: venuesPath, upcomingShowsCachePath: cachePath }));
  assert.ok(result.sentReplies[0].includes('Largo at the Coronet has a show Aug 20.'));
  assert.ok(result.sentReplies[0].includes('https://example.com/show'));

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cache.days, 14);
  assert.equal(cache.findings.length, 1);
  assert.ok(cache.fetchedAt);
});

await asyncTest('get_upcoming_shows: a failed live call degrades cleanly and leaves any existing cache untouched', async () => {
  const dir = path.join(tmpRoot, 'upcoming-shows-failure');
  const venuesPath = writeVenuesFixture(dir, [{ name: 'Largo at the Coronet', area: 'central', address: '366 N La Cienega Blvd' }]);
  const cachePath = path.join(dir, 'upcoming_shows_cache.json');
  fs.writeFileSync(cachePath, JSON.stringify({ fetchedAt: '2026-08-01T00:00:00.000Z', days: 14, findings: [{ text: 'old finding', urls: [] }] }));
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: '@TestBot any shows soon?' })] },
  });
  const mockClient = async () => ({
    content: [{ type: 'tool_use', name: 'get_upcoming_shows', input: {} }],
  });
  const mockShowsClient = async () => { throw new Error('network down'); };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockClient, showsClient: mockShowsClient, venuesToFollowPath: venuesPath, upcomingShowsCachePath: cachePath }));
  assert.ok(result.sentReplies[0].includes("couldn't check upcoming shows" ) || result.sentReplies[0].toLowerCase().includes("couldn't check upcoming shows"));

  const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  assert.equal(cache.findings[0].text, 'old finding', 'a failed call should not clear the existing cache');
});

// --- Multi-tool-per-message (2026-08-01): a single message can trigger more than one tool call ---

await asyncTest('a message asking for two distinct things triggers both tool calls, both reflected in state and the reply', async () => {
  const dir = path.join(tmpRoot, 'multi-tool-two-distinct');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'add milk to the list and what\'s the budget status' })] },
  });
  const mockAnthropic = async () => ({
    content: [
      { type: 'tool_use', name: 'add_todo', input: { title: 'buy milk' } },
      { type: 'tool_use', name: 'get_budget_status', input: {} },
    ],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(result.todos.items.length, 2, 'the add_todo call should have landed');
  assert.ok(result.sentReplies[0].includes('Added'), 'the reply should include the add_todo confirmation');
  assert.ok(result.sentReplies[0].includes('Joint:'), 'the reply should also include the budget status');
});

await asyncTest('two write actions in the same turn both apply (second sees the first\'s effect, not just the last)', async () => {
  const dir = path.join(tmpRoot, 'multi-tool-two-writes');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'add buy milk and add buy eggs' })] },
  });
  const mockAnthropic = async () => ({
    content: [
      { type: 'tool_use', name: 'add_todo', input: { title: 'buy milk' } },
      { type: 'tool_use', name: 'add_todo', input: { title: 'buy eggs' } },
    ],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(result.todos.items.length, 3, 'both new items should have been added, not just the last one');
  assert.ok(result.todos.items.some((i) => i.title === 'buy milk'));
  assert.ok(result.todos.items.some((i) => i.title === 'buy eggs'));
});

await asyncTest('one unrecognized tool name among several in the same turn is skipped, not fatal to the others', async () => {
  const dir = path.join(tmpRoot, 'multi-tool-one-unknown');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'add milk and do something weird' })] },
  });
  const mockAnthropic = async () => ({
    content: [
      { type: 'tool_use', name: 'add_todo', input: { title: 'buy milk' } },
      { type: 'tool_use', name: 'not_a_real_tool', input: {} },
    ],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(result.todos.items.length, 2, 'the valid tool call should still have gone through');
  assert.ok(result.sentReplies[0].includes('Added'));
});

// --- Short-term conversational memory (2026-08-01) ---

await asyncTest('recent conversation history from a prior session is passed to the LLM fallback', async () => {
  const dir = path.join(tmpRoot, 'conversation-memory-seeded');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: 'actually make that 6pm' })] },
    conversationLog: [
      { at: '2026-08-01T15:00:00.000Z', sender: 'kevin', text: 'book Test Bistro for date night', reply: 'Set ✓ Date night (2026-08-07): Test Bistro' },
    ],
  });
  let capturedConversation = null;
  const mockAnthropic = async ({ recentConversation }) => {
    capturedConversation = recentConversation;
    return { content: [{ type: 'text', text: 'Updated to 6pm.' }] };
  };
  await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(capturedConversation.length, 1);
  assert.equal(capturedConversation[0].sender, 'kevin');
  assert.ok(capturedConversation[0].text.includes('Test Bistro'));
});

await asyncTest('no conversation log yet: an empty history is passed rather than throwing', async () => {
  const dir = path.join(tmpRoot, 'conversation-memory-missing');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'what\'s the plan?' })] },
  });
  let capturedConversation = null;
  const mockAnthropic = async ({ recentConversation }) => {
    capturedConversation = recentConversation;
    return { content: [{ type: 'text', text: 'Nothing notable.' }] };
  };
  await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.deepEqual(capturedConversation, []);
});

await asyncTest('a processed message is written to the conversation log and read back on the next run', async () => {
  const dir = path.join(tmpRoot, 'conversation-memory-roundtrip');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: 'new: buy milk' })] },
  });
  await runOnce(baseOpts(paths)); // deterministic parse, no anthropicClient needed
  const onDisk = fs.readFileSync(paths.conversationLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(onDisk.length, 1);
  assert.equal(onDisk[0].sender, 'kevin');
  assert.ok(onDisk[0].reply.includes('Added'));

  // Second run, different update id, same log file — should see the first run's exchange.
  const paths2 = { ...paths, updatesPath: paths.updatesPath };
  fs.writeFileSync(paths.updatesPath, JSON.stringify({ ok: true, result: [msg(2, { fromId: 222, text: 'what did I just add?' })] }, null, 2));
  let capturedConversation = null;
  const mockAnthropic = async ({ recentConversation }) => {
    capturedConversation = recentConversation;
    return { content: [{ type: 'text', text: 'You added buy milk.' }] };
  };
  await runOnce(baseOpts(paths2, { anthropicClient: mockAnthropic }));
  assert.equal(capturedConversation.length, 1);
  assert.ok(capturedConversation[0].text.includes('buy milk'));
});

await asyncTest('within the same batch, a later message already sees an earlier message\'s exchange', async () => {
  const dir = path.join(tmpRoot, 'conversation-memory-same-batch');
  const paths = writeFixture(dir, {
    updates: {
      ok: true,
      result: [
        msg(1, { fromId: 222, text: 'book Test Bistro for date night' }),
        msg(2, { fromId: 111, text: 'actually make that 6pm' }),
      ],
    },
  });
  const capturedConversations = [];
  const mockAnthropic = async ({ recentConversation }) => {
    capturedConversations.push(recentConversation);
    return { content: [{ type: 'tool_use', name: 'set_dinner_plan', input: { occasion: 'date_night', pick: 'Test Bistro' } }] };
  };
  await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(capturedConversations[0].length, 0, 'the first message in the batch has no prior history yet');
  assert.equal(capturedConversations[1].length, 1, 'the second message should already see the first one\'s exchange');
  assert.ok(capturedConversations[1][0].text.includes('Test Bistro'));
});

// --- update_phase_expense / log_decision (2026-08-02): direct writes to goals.json, no review gate ---

await asyncTest('update_phase_expense: directly updates an existing expense line and confirms the real change', async () => {
  const dir = path.join(tmpRoot, 'phase-expense-update');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'the nanny is now $700/week' })] },
  });
  const mockAnthropic = async () => ({
    content: [{ type: 'tool_use', name: 'update_phase_expense', input: { phaseId: 1, expenseKey: 'Nanny (cash)', renameFrom: 'Kevin personal', amount: 3033 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(result.goals.phases[0].expenses['Nanny (cash)'], 3033);
  assert.equal(result.goals.phases[0].expenses['Kevin personal'], undefined, 'renameFrom should remove the old key');
  assert.equal(result.goals.phases[0].expenses['Family budget'], 5500, 'unrelated expense lines should be untouched');
  assert.ok(result.sentReplies[0].includes('Updated ✓'));
  assert.ok(result.sentReplies[0].includes('Nanny (cash)'));
  assert.ok(result.sentReplies[0].includes('3,033'));
});

await asyncTest('update_phase_expense: persists to disk (not just the in-memory return value) when not a dry run', async () => {
  const dir = path.join(tmpRoot, 'phase-expense-persisted');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 222, text: 'update the budget' })] },
  });
  const mockAnthropic = async () => ({
    content: [{ type: 'tool_use', name: 'update_phase_expense', input: { phaseId: 1, expenseKey: 'New line', amount: 200 } }],
  });
  await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic, dryRun: false }));
  const onDisk = JSON.parse(fs.readFileSync(paths.goalsPath, 'utf8'));
  assert.equal(onDisk.phases[0].expenses['New line'], 200, 'the write should have landed on disk, not just in the returned in-memory object');
});

await asyncTest('update_phase_expense: an unknown phaseId replies with a clear error rather than throwing', async () => {
  const dir = path.join(tmpRoot, 'phase-expense-bad-phase');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'update phase 99' })] },
  });
  const mockAnthropic = async () => ({
    content: [{ type: 'tool_use', name: 'update_phase_expense', input: { phaseId: 99, expenseKey: 'Something', amount: 100 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(result.goalsChanged, false);
  assert.ok(result.sentReplies[0].includes("Couldn't find phase 99"));
});

await asyncTest('update_phase_expense: an invalid amount replies with a clear error rather than storing garbage', async () => {
  const dir = path.join(tmpRoot, 'phase-expense-bad-amount');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'update the budget to nonsense' })] },
  });
  const mockAnthropic = async () => ({
    content: [{ type: 'tool_use', name: 'update_phase_expense', input: { phaseId: 1, expenseKey: 'Something', amount: -50 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(result.goalsChanged, false);
  assert.ok(result.sentReplies[0].includes('valid monthly dollar amount'));
});

await asyncTest('update_phase_expense: two calls in one message (one per phase) both apply — the real childcare-cost use case', async () => {
  const dir = path.join(tmpRoot, 'phase-expense-multi-phase');
  const goals = {
    ...seedGoals(),
    phases: [
      { id: 1, name: 'Phase 1', expenses: { 'Au pair (starts Aug 2026)': 880 } },
      { id: 2, name: 'Phase 2', expenses: { 'Au pair (year 1)': 880 } },
    ],
  };
  const paths = writeFixture(dir, {
    goals,
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'nanny is $700/week now, update both phases' })] },
  });
  const mockAnthropic = async () => ({
    content: [
      { type: 'tool_use', name: 'update_phase_expense', input: { phaseId: 1, expenseKey: 'Nanny (cash)', renameFrom: 'Au pair (starts Aug 2026)', amount: 3033 } },
      { type: 'tool_use', name: 'update_phase_expense', input: { phaseId: 2, expenseKey: 'Nanny (cash)', renameFrom: 'Au pair (year 1)', amount: 3033 } },
    ],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(result.goals.phases[0].expenses['Nanny (cash)'], 3033);
  assert.equal(result.goals.phases[1].expenses['Nanny (cash)'], 3033);
  assert.equal(result.goals.phases[0].expenses['Au pair (starts Aug 2026)'], undefined);
  assert.equal(result.goals.phases[1].expenses['Au pair (year 1)'], undefined);
});

await asyncTest('update_phase_expense: an unreadable goals.json degrades to a clear reply rather than crashing', async () => {
  const dir = path.join(tmpRoot, 'phase-expense-unreadable-goals');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'update the budget' })] },
  });
  fs.writeFileSync(paths.goalsPath, 'not valid json{{{');
  const mockAnthropic = async () => ({
    content: [{ type: 'tool_use', name: 'update_phase_expense', input: { phaseId: 1, expenseKey: 'Something', amount: 100 } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.ok(result.sentReplies[0].includes("isn't readable"));
});

await asyncTest('log_decision: directly adds a narrative decision to the real plan', async () => {
  const dir = path.join(tmpRoot, 'log-decision-basic');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'we need to decide on the au pair visa sponsor' })] },
  });
  const mockAnthropic = async () => ({
    content: [{ type: 'tool_use', name: 'log_decision', input: { title: 'Au pair visa sponsor', summary: 'Need to pick a sponsor agency before the Oct 23 start date.', status: 'urgent' } }],
  });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  const added = result.goals.decisions.find((d) => d.title === 'Au pair visa sponsor');
  assert.ok(added, 'the decision should have been appended to goals.decisions');
  assert.equal(added.status, 'urgent');
  assert.ok(added.body.includes('Oct 23'));
  assert.ok(result.sentReplies[0].includes('Added ✓'));
});

await asyncTest('log_decision: missing title or summary replies with a clear error and adds nothing', async () => {
  const dir = path.join(tmpRoot, 'log-decision-missing-fields');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'log a decision' })] },
  });
  const mockAnthropic = async () => ({ content: [{ type: 'tool_use', name: 'log_decision', input: { title: 'Something' } }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic }));
  assert.equal(result.goalsChanged, false);
  assert.ok(result.sentReplies[0].includes('missing a summary'));
});

// --- Multi-turn clarification (2026-08-02): the bot waits for an answer instead of guessing or dead-ending ---

await asyncTest('a plain-text fallback reply (no tool call) registers a pending clarification and persists it to disk', async () => {
  const dir = path.join(tmpRoot, 'clarify-register-plain-text');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'update the childcare cost' })] },
  });
  const mockAnthropic = async () => ({ content: [{ type: 'text', text: 'What\'s the new monthly amount, and which phase does it apply to?' }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic, dryRun: false }));
  assert.equal(result.sentReplies[0], 'What\'s the new monthly amount, and which phase does it apply to?');
  const onDisk = JSON.parse(fs.readFileSync(paths.pendingClarificationsPath, 'utf8'));
  assert.equal(onDisk.hanna.question, 'What\'s the new monthly amount, and which phase does it apply to?');
  assert.equal(onDisk.hanna.originalText, 'update the childcare cost');
});

await asyncTest('a follow-up reply on the next poll resolves a pending clarification and completes the original action', async () => {
  const dir = path.join(tmpRoot, 'clarify-resolve-next-poll');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'update the childcare cost' })] },
  });
  const mockAsk = async () => ({ content: [{ type: 'text', text: 'What\'s the new monthly amount, and which phase?' }] });
  await runOnce(baseOpts(paths, { anthropicClient: mockAsk, dryRun: false }));

  fs.writeFileSync(paths.updatesPath, JSON.stringify({ ok: true, result: [msg(2, { fromId: 111, text: '$3,033/mo, phase 1' })] }));
  let capturedPending = null;
  const mockAnswer = async ({ pendingClarification }) => {
    capturedPending = pendingClarification;
    return { content: [{ type: 'tool_use', name: 'update_phase_expense', input: { phaseId: 1, expenseKey: 'Nanny (cash)', amount: 3033 } }] };
  };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnswer, dryRun: false }));

  assert.ok(capturedPending, 'the resume call should receive the pending clarification context');
  assert.equal(capturedPending.originalText, 'update the childcare cost');
  assert.equal(capturedPending.question, 'What\'s the new monthly amount, and which phase?');
  assert.equal(result.goals.phases[0].expenses['Nanny (cash)'], 3033);
  const onDisk = JSON.parse(fs.readFileSync(paths.pendingClarificationsPath, 'utf8'));
  assert.equal(onDisk.hanna, null, 'the pending question should be cleared once resolved');
});

await asyncTest('an expired pending clarification is ignored — the next message is treated fresh via deterministic parsing', async () => {
  const dir = path.join(tmpRoot, 'clarify-expired');
  const fourHoursAgo = new Date('2026-08-01T10:00:00.000Z');
  const paths = writeFixture(dir, {
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'new: buy milk' })] },
    pendingClarifications: { hanna: { question: 'Stale question?', originalText: 'stale ask', askedAt: fourHoursAgo.toISOString() } },
  });
  const mockAnthropic = async () => { throw new Error('should not reach the LLM — deterministic parse should have handled this'); };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic, now: new Date('2026-08-01T14:00:01.000Z') }));
  assert.ok(result.todos.items.some((i) => i.title === 'buy milk'), 'deterministic add_todo should have run, proving the stale pending question was ignored');
});

await asyncTest('an unrelated follow-up drops the old pending question instead of misreading it as an answer', async () => {
  const dir = path.join(tmpRoot, 'clarify-unrelated-followup');
  const paths = writeFixture(dir, {
    pendingClarifications: { hanna: { question: 'Which phase does the rent increase apply to?', originalText: 'rent went up', askedAt: '2026-08-01T10:00:00.000Z' } },
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'never mind, what\'s the budget status' })] },
  });
  const mockAnthropic = async () => ({ content: [{ type: 'tool_use', name: 'get_budget_status', input: {} }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic, now: new Date('2026-08-01T11:00:00.000Z'), dryRun: false }));
  assert.ok(result.sentReplies[0].length > 0);
  const onDisk = JSON.parse(fs.readFileSync(paths.pendingClarificationsPath, 'utf8'));
  assert.equal(onDisk.hanna, null, 'the old question should be dropped once a new action was handled instead');
});

await asyncTest('remove_event\'s multi-candidate disambiguation registers a pending clarification instead of dead-ending', async () => {
  const dir = path.join(tmpRoot, 'clarify-remove-event-ambiguous');
  const paths = writeFixture(dir, {
    monthPlanEvents: { events: { '2026-08-12': [{ kind: 'family', name: 'Dentist', cost: 0, tier: 'low-key' }, { kind: 'family', name: 'Dinner with Sam', cost: 0, tier: 'low-key' }] } },
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'remove the event on the 12th' })] },
  });
  const mockAnthropic = async () => ({ content: [{ type: 'tool_use', name: 'remove_event', input: { date: '2026-08-12' } }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic, dryRun: false }));
  assert.ok(result.sentReplies[0].includes('Say which one to remove'));
  const onDisk = JSON.parse(fs.readFileSync(paths.pendingClarificationsPath, 'utf8'));
  assert.ok(onDisk.hanna.question.includes('Dentist'));
});

await asyncTest('remove_event\'s pending clarification resolves on the next message, removing just the named event', async () => {
  const dir = path.join(tmpRoot, 'clarify-remove-event-resolve');
  const paths = writeFixture(dir, {
    monthPlanEvents: { events: { '2026-08-12': [{ kind: 'family', name: 'Dentist', cost: 0, tier: 'low-key' }, { kind: 'family', name: 'Dinner with Sam', cost: 0, tier: 'low-key' }] } },
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'remove the event on the 12th' })] },
  });
  const mockAsk = async () => ({ content: [{ type: 'tool_use', name: 'remove_event', input: { date: '2026-08-12' } }] });
  await runOnce(baseOpts(paths, { anthropicClient: mockAsk, dryRun: false }));

  fs.writeFileSync(paths.updatesPath, JSON.stringify({ ok: true, result: [msg(2, { fromId: 111, text: 'the dentist one' })] }));
  const mockAnswer = async () => ({ content: [{ type: 'tool_use', name: 'remove_event', input: { date: '2026-08-12', title: 'Dentist' } }] });
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnswer, dryRun: false }));

  assert.equal(result.monthPlanEvents.events['2026-08-12'].length, 1);
  assert.equal(result.monthPlanEvents.events['2026-08-12'][0].name, 'Dinner with Sam');
  const onDisk = JSON.parse(fs.readFileSync(paths.pendingClarificationsPath, 'utf8'));
  assert.equal(onDisk.hanna, null);
});

await asyncTest('a pending clarification for one sender does not affect a different sender\'s message in the same batch', async () => {
  const dir = path.join(tmpRoot, 'clarify-per-sender');
  const paths = writeFixture(dir, {
    pendingClarifications: { kevin: { question: 'Which phase?', originalText: 'rent went up', askedAt: '2026-08-01T10:00:00.000Z' } },
    updates: { ok: true, result: [msg(1, { fromId: 111, text: 'new: buy milk' })] }, // 111 = hanna, not kevin
  });
  const mockAnthropic = async () => { throw new Error('should not reach the LLM — deterministic parse should have handled hanna\'s message'); };
  const result = await runOnce(baseOpts(paths, { anthropicClient: mockAnthropic, now: new Date('2026-08-01T11:00:00.000Z'), dryRun: false }));
  assert.ok(result.todos.items.some((i) => i.title === 'buy milk'));
  const onDisk = JSON.parse(fs.readFileSync(paths.pendingClarificationsPath, 'utf8'));
  assert.equal(onDisk.kevin.question, 'Which phase?', 'kevin\'s pending question should be untouched — no message from kevin in this batch');
});

console.log('All tests passed.');
