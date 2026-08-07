// Longterm/data/test-telegram-recap.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// telegram-bot-recap.mjs's signal-gathering (budget/savings/dining/stale-todo
// bundle), the mocked Anthropic composition call, dedup-by-date, and the
// mocked Telegram send (no reply_to_message_id — this isn't a reply to
// anything). Run with:
//   node Longterm/data/test-telegram-recap.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce } from '../scripts/telegram-bot-recap.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-recap-test-'));

async function asyncTest(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

const seedTodos = () => ({
  meta: { description: 'test' },
  items: [
    { title: 'Newer item', owner: 'hanna', dateAdded: '2026-07-28', deadline: null, done: false },
    { title: 'Oldest open item', owner: 'kevin', dateAdded: '2026-07-01', deadline: null, done: false },
  ],
  weeklyGoals: [],
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
  ],
});

const seedFavoritePlaces = () => ({
  places: [
    { name: 'Test Bistro', cuisine: 'French', list: 'go-to', familyFriendly: true, dinnerSpot: true, socialSpot: true, observed: { tier: 'mid', avgSpend: 60 } },
  ],
  recentDiningActivity: [],
});

const seedBudgetTracking = () => ({
  joint: { targetExpenseKey: 'Family budget', weeks: [{ actual: 1000, days: 7 }], cycleDays: 30 },
  personal: {
    kevin: { label: 'Kevin personal', targetExpenseKey: 'Kevin personal', weeks: [{ actual: 900, days: 7 }], cycleDays: 30 },
  },
  travel: { trips: [{ label: 'Test Trip', actual: 500, budgetedAmount: 1000 }] },
});

const seedAccounts = () => ({
  balances: { brokerage: { kevin: { amount: 100000 }, hanna: { amount: 50000 } } },
});

function writeFixture(dir, { todos, goals, favoritePlaces, monthPlanEvents, budgetTracking, accounts, goalsChangelog } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const todosPath = path.join(dir, 'todos.json');
  const goalsPath = path.join(dir, 'goals.json');
  const favoritePlacesPath = path.join(dir, 'favorite_places.json');
  const monthPlanEventsPath = path.join(dir, 'month_plan_events.json');
  const budgetTrackingPath = path.join(dir, 'budget_tracking.json');
  const accountsPath = path.join(dir, 'accounts.json');
  const recapLogPath = path.join(dir, 'telegram-recap-log.jsonl');
  const unparsedPath = path.join(dir, 'telegram-unparsed.jsonl');
  const goalsChangelogPath = path.join(dir, 'goals-changelog.jsonl');
  fs.writeFileSync(todosPath, JSON.stringify(todos ?? seedTodos(), null, 2));
  fs.writeFileSync(goalsPath, JSON.stringify(goals ?? seedGoals(), null, 2));
  fs.writeFileSync(favoritePlacesPath, JSON.stringify(favoritePlaces ?? seedFavoritePlaces(), null, 2));
  fs.writeFileSync(monthPlanEventsPath, JSON.stringify(monthPlanEvents ?? { events: {} }, null, 2));
  fs.writeFileSync(budgetTrackingPath, JSON.stringify(budgetTracking ?? seedBudgetTracking(), null, 2));
  fs.writeFileSync(accountsPath, JSON.stringify(accounts ?? seedAccounts(), null, 2));
  if (goalsChangelog) fs.writeFileSync(goalsChangelogPath, goalsChangelog.map((n) => JSON.stringify(n)).join('\n') + '\n');
  return { todosPath, goalsPath, favoritePlacesPath, monthPlanEventsPath, budgetTrackingPath, accountsPath, recapLogPath, unparsedPath, goalsChangelogPath };
}

function baseOpts(paths, extra = {}) {
  return {
    todosPath: paths.todosPath,
    goalsPath: paths.goalsPath,
    favoritePlacesPath: paths.favoritePlacesPath,
    monthPlanEventsPath: paths.monthPlanEventsPath,
    budgetTrackingPath: paths.budgetTrackingPath,
    accountsPath: paths.accountsPath,
    recapLogPath: paths.recapLogPath,
    unparsedPath: paths.unparsedPath,
    goalsChangelogPath: paths.goalsChangelogPath,
    // Guaranteed-nonexistent by default so a test isn't accidentally reading
    // this machine's real google-calendar.env (2026-08-02: it now genuinely
    // exists). Tests wanting configured-calendar behavior already override
    // via calendarReadClient/calendarReadCalendarIds.
    calendarEnvPath: path.join(path.dirname(paths.todosPath), 'no-such-google-calendar.env'),
    token: 'test-token',
    groupChatId: '-999',
    apiKey: 'test-key',
    dryRun: false,
    ...extra,
  };
}

// A fixed Sunday (2026-08-02 is a Sunday) so slot resolution and dedup dates are deterministic.
const SUNDAY = new Date(2026, 7, 2, 9, 0, 0);
const THURSDAY = new Date(2026, 7, 6, 9, 0, 0);

console.log('test-telegram-recap.mjs');

await asyncTest('bundle includes budgetLineItems: every joint-tracker charge over $100 this cycle', async () => {
  const dir = path.join(tmpRoot, 'budget-line-items');
  const paths = writeFixture(dir, {
    budgetTracking: {
      joint: {
        targetExpenseKey: 'Family budget',
        weeks: [{ actual: 1000, days: 7 }],
        cycleDays: 30,
        categories: [
          { name: 'Insurance', amount: 489.26, transactions: [{ date: '2026-07-26', merchant: 'Geico', amount: 489.26 }] },
          { name: 'Groceries', amount: 45, transactions: [{ date: '2026-07-28', merchant: 'Whole Foods', amount: 45 }] },
        ],
      },
      personal: { kevin: { label: 'Kevin personal', targetExpenseKey: 'Kevin personal', weeks: [{ actual: 900, days: 7 }], cycleDays: 30 } },
      travel: { trips: [] },
    },
  });
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(capturedBundle.budgetLineItems.length, 1, 'only the >$100 charge should be included');
  assert.equal(capturedBundle.budgetLineItems[0].merchant, 'Geico');
  assert.equal(capturedBundle.budgetLineItems[0].amount, 489.26);
});

await asyncTest('bundle includes budgetRefunds: every joint-tracker refund this cycle, and refunds are excluded from budgetLineItems', async () => {
  const dir = path.join(tmpRoot, 'budget-refunds');
  const paths = writeFixture(dir, {
    budgetTracking: {
      joint: {
        targetExpenseKey: 'Family budget',
        weeks: [{ actual: 1000, days: 7 }],
        cycleDays: 30,
        categories: [
          { name: 'Groceries', amount: 45, transactions: [{ date: '2026-07-28', merchant: 'Whole Foods', amount: 45 }] },
        ],
        refunds: [
          { date: '2026-07-29', merchant: 'Amazon', amount: 150.5, category: 'Shopping' },
        ],
      },
      personal: { kevin: { label: 'Kevin personal', targetExpenseKey: 'Kevin personal', weeks: [{ actual: 900, days: 7 }], cycleDays: 30 } },
      travel: { trips: [] },
    },
  });
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(capturedBundle.budgetRefunds.length, 1);
  assert.equal(capturedBundle.budgetRefunds[0].merchant, 'Amazon');
  assert.equal(capturedBundle.budgetRefunds[0].amount, 150.5);
  assert.equal(capturedBundle.budgetLineItems.length, 0, 'a refund over $100 should not also appear as a budgetLineItems spend line');
});

await asyncTest('bundle includes todosByOwner: every open item grouped by owner, staleTodo is gone', async () => {
  const dir = path.join(tmpRoot, 'todos-by-owner');
  const paths = writeFixture(dir, {
    todos: {
      meta: { description: 'test' },
      items: [
        { title: 'Kevin item 1', owner: 'kevin', dateAdded: '2026-07-01', deadline: null, done: false },
        { title: 'Kevin item 2', owner: 'kevin', dateAdded: '2026-07-20', deadline: null, done: false },
        { title: 'Hanna item', owner: 'hanna', dateAdded: '2026-07-28', deadline: null, done: false },
        { title: 'Done item', owner: 'kevin', dateAdded: '2026-06-01', deadline: null, done: true },
      ],
      weeklyGoals: [],
    },
  });
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(capturedBundle.todosByOwner.kevin.length, 2, 'both open Kevin items, not the done one');
  assert.equal(capturedBundle.todosByOwner.hanna.length, 1);
  assert.equal(capturedBundle.todosByOwner.kevin[0].title, 'Kevin item 1');
  assert.equal(capturedBundle.staleTodo, undefined, 'staleTodo field is superseded by todosByOwner');
});

await asyncTest('gathers all signal categories into the bundle handed to the LLM (scoped to the week, no long-term goals)', async () => {
  const dir = path.join(tmpRoot, 'bundle-contents');
  const paths = writeFixture(dir);
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => {
    capturedBundle = bundle;
    return { content: [{ type: 'text', text: 'A quiet week, nothing urgent.' }] };
  };
  const sentMessages = [];
  const mockTelegram = async (token, method, body) => { sentMessages.push({ token, method, body }); return { ok: true }; };
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.ok(capturedBundle, 'the mocked Anthropic client should have been called');
  assert.ok(capturedBundle.budgetStatus.joint, 'bundle should include joint budget pace');
  assert.equal(capturedBundle.savingsGoals, undefined, 'long-term savings goals should not be in the weekly recap bundle');
  assert.ok(capturedBundle.dining.family_dinner.reply, 'bundle should include a dining summary for each occasion');
  assert.ok(capturedBundle.dining.family_dinner.date, 'each occasion should include its resolved date, for calendar cross-referencing');
  assert.ok(capturedBundle.dining.date_night.reply);
  assert.ok(capturedBundle.dining.weekend_social.reply);
  assert.equal(capturedBundle.decisions[0].title, 'Urgent test decision', 'bundle should include open decisions');
  assert.equal(capturedBundle.todosByOwner.kevin[0].title, 'Oldest open item', 'bundle should group every open to-do by owner');
  assert.equal(capturedBundle.todosByOwner.hanna[0].title, 'Newer item');
  assert.deepEqual(capturedBundle.budgetLineItems, [], 'no line item over $100 in the default fixture');
  assert.deepEqual(capturedBundle.budgetRefunds, [], 'no refunds in the default fixture');
});

await asyncTest('dining suggestions across the 3 occasions don\'t all converge on the same restaurant (real bug: all 3 slots suggested "Terra Eataly" in one live recap)', async () => {
  const dir = path.join(tmpRoot, 'dining-no-repeat');
  const paths = writeFixture(dir, {
    favoritePlaces: {
      places: [
        { name: 'Place A', cuisine: 'Italian', list: 'go-to', familyFriendly: true, dinnerSpot: true, socialSpot: true, observed: { tier: 'mid', avgSpend: 60 } },
        { name: 'Place B', cuisine: 'Japanese', list: 'go-to', familyFriendly: true, dinnerSpot: true, socialSpot: true, observed: { tier: 'mid', avgSpend: 60 } },
        { name: 'Place C', cuisine: 'Mexican', list: 'go-to', familyFriendly: true, dinnerSpot: true, socialSpot: true, observed: { tier: 'mid', avgSpend: 60 } },
      ],
      recentDiningActivity: [], // none visited — all 3 tied on score, so without the fix every occasion would pick the same top one
    },
  });
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'Recap.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  const picks = ['family_dinner', 'date_night', 'weekend_social'].map((occ) => capturedBundle.dining[occ].reply.match(/suggestion: ([^.]+)\./)[1]);
  assert.equal(new Set(picks).size, 3, `expected 3 distinct suggestions, got: ${picks.join(', ')}`);
});

await asyncTest('sends the composed text to the group chat with no reply_to_message_id', async () => {
  const dir = path.join(tmpRoot, 'send-no-reply');
  const paths = writeFixture(dir);
  const mockAnthropic = async () => ({ content: [{ type: 'text', text: 'Recap body here.' }] });
  const sentMessages = [];
  const mockTelegram = async (token, method, body) => { sentMessages.push({ token, method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(result.sent, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].method, 'sendMessage');
  assert.equal(sentMessages[0].body.chat_id, '-999');
  assert.equal(sentMessages[0].body.text, 'Recap body here.');
  assert.equal(sentMessages[0].body.reply_to_message_id, undefined, 'a recap is not a reply to any message');
});

await asyncTest('records a dedup log entry after sending', async () => {
  const dir = path.join(tmpRoot, 'dedup-log-written');
  const paths = writeFixture(dir);
  const mockAnthropic = async () => ({ content: [{ type: 'text', text: 'Recap body here.' }] });
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.ok(fs.existsSync(paths.recapLogPath));
  const logged = JSON.parse(fs.readFileSync(paths.recapLogPath, 'utf8').trim());
  assert.equal(logged.date, '2026-08-02');
  assert.equal(logged.slot, 'sunday-morning');
});

await asyncTest('dedup: a second run the same day does not call the LLM or send again', async () => {
  const dir = path.join(tmpRoot, 'dedup-same-day');
  const paths = writeFixture(dir);
  let callCount = 0;
  const mockAnthropic = async () => { callCount += 1; return { content: [{ type: 'text', text: 'Recap body here.' }] }; };
  let sendCount = 0;
  const mockTelegram = async () => { sendCount += 1; return { ok: true }; };
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));
  const second = await runOnce(baseOpts(paths, { now: new Date(2026, 7, 2, 11, 0, 0), anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(callCount, 1, 'the LLM should not be called again once a recap already went out today');
  assert.equal(sendCount, 1, 'Telegram should not receive a second send for the same day');
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'already_sent_today');
});

await asyncTest('a different cadence day (Thursday) is not deduped against a prior Sunday send', async () => {
  const dir = path.join(tmpRoot, 'different-day-not-deduped');
  const paths = writeFixture(dir);
  const mockAnthropic = async () => ({ content: [{ type: 'text', text: 'Recap body here.' }] });
  let sendCount = 0;
  const mockTelegram = async () => { sendCount += 1; return { ok: true }; };
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));
  const thursdayResult = await runOnce(baseOpts(paths, { now: THURSDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(thursdayResult.sent, true);
  assert.equal(thursdayResult.slot, 'thursday-morning');
  assert.equal(sendCount, 2);
});

await asyncTest('no open to-dos: todosByOwner is empty rather than throwing', async () => {
  const dir = path.join(tmpRoot, 'no-open-todos');
  const paths = writeFixture(dir, { todos: { meta: { description: 'test' }, items: [], weeklyGoals: [] } });
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'All clear.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.deepEqual(capturedBundle.todosByOwner, {});
});

await asyncTest('surfaces unparsed messages logged since the last recap', async () => {
  const dir = path.join(tmpRoot, 'unparsed-since-last-recap');
  const paths = writeFixture(dir);
  fs.writeFileSync(paths.recapLogPath, `${JSON.stringify({ date: '2026-07-30', slot: 'thursday-morning', sentAt: '2026-07-30T16:00:00.000Z' })}\n`);
  fs.writeFileSync(paths.unparsedPath, [
    { at: '2026-07-29T12:00:00.000Z', text: 'too old, before last recap', reason: 'llm_error:x' },
    { at: '2026-08-01T09:00:00.000Z', text: 'blah unrecognized message', reason: 'llm_error:x' },
  ].map((e) => JSON.stringify(e)).join('\n') + '\n');
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'Recap.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(capturedBundle.unparsedMessages.length, 1, 'only messages after the last recap should be included');
  assert.equal(capturedBundle.unparsedMessages[0].text, 'blah unrecognized message');
});

await asyncTest('no unparsed log file yet: unparsedMessages is an empty array, not a crash', async () => {
  const dir = path.join(tmpRoot, 'unparsed-missing-file');
  const paths = writeFixture(dir);
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'Recap.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.deepEqual(capturedBundle.unparsedMessages, []);
});

// --- calendarSummary (Kevin personal + Hanna's Google Calendars) ---

await asyncTest('calendarSummary is null when calendar reading is not configured', async () => {
  const dir = path.join(tmpRoot, 'calendar-summary-not-configured');
  const paths = writeFixture(dir);
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'Recap.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(capturedBundle.calendarSummary, null);
});

await asyncTest('calendarSummary is populated from the configured read calendars when set up', async () => {
  const dir = path.join(tmpRoot, 'calendar-summary-configured');
  const paths = writeFixture(dir);
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'Recap.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  const mockCalendarClient = { listEvents: async () => [{ summary: 'Yoga', start: { dateTime: '2026-08-04T18:00:00-07:00' } }] };
  await runOnce(baseOpts(paths, {
    now: SUNDAY,
    anthropicClient: mockAnthropic,
    telegramClient: mockTelegram,
    calendarReadClient: mockCalendarClient,
    calendarReadCalendarIds: [{ id: 'hanna@email.com', label: 'Hanna' }],
  }));

  assert.ok(capturedBundle.calendarSummary.includes('[Hanna] Yoga'));
});

await asyncTest('a dining occasion already covered by an evening calendar event is reflected directly in the bundle, not just the composed text', async () => {
  const dir = path.join(tmpRoot, 'dining-calendar-coverage');
  const paths = writeFixture(dir);
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'Recap.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  // SUNDAY is 2026-08-02, so family_dinner (Wed) resolves to 2026-08-05.
  const mockCalendarClient = { listEvents: async () => [{ summary: 'Shannon/Ryan Dinner', start: { dateTime: '2026-08-05T17:00:00-07:00' } }] };
  await runOnce(baseOpts(paths, {
    now: SUNDAY,
    anthropicClient: mockAnthropic,
    telegramClient: mockTelegram,
    calendarReadClient: mockCalendarClient,
    calendarReadCalendarIds: [{ id: 'hanna@email.com', label: 'Hanna' }],
  }));

  assert.ok(capturedBundle.dining.family_dinner.reply.includes('looks already covered'), 'the bundle itself should reflect coverage, not rely on the composing LLM to infer it from calendarSummary');
  assert.ok(capturedBundle.dining.family_dinner.reply.includes('Hanna: Shannon/Ryan Dinner'));
});

await asyncTest('a Calendar API failure on every configured calendar still sends the recap (calendarSummary falls back gracefully, not null)', async () => {
  const dir = path.join(tmpRoot, 'calendar-summary-api-failure');
  const paths = writeFixture(dir);
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'Recap.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  // getUpcomingEvents already skips a per-calendar error internally rather
  // than throwing (see test-calendar-read.mjs) — this confirms that
  // behavior holds all the way through the recap: the whole run still
  // succeeds, just with the "nothing found" fallback text.
  const mockCalendarClient = { listEvents: async () => { throw new Error('token expired'); } };
  const result = await runOnce(baseOpts(paths, {
    now: SUNDAY,
    anthropicClient: mockAnthropic,
    telegramClient: mockTelegram,
    calendarReadClient: mockCalendarClient,
    calendarReadCalendarIds: [{ id: 'hanna@email.com', label: 'Hanna' }],
  }));

  assert.equal(result.sent, true, 'the recap itself should still send despite the calendar hiccup');
  assert.ok(capturedBundle.calendarSummary.includes('No events found'));
});

// --- recentPlanChanges (2026-08-02): surfaces update_phase_expense/log_decision's direct goals.json edits ---

await asyncTest('recentPlanChanges is zero-count/empty when the bot has made no direct plan edits', async () => {
  const dir = path.join(tmpRoot, 'plan-changes-none');
  const paths = writeFixture(dir);
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'Recap.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.deepEqual(capturedBundle.recentPlanChanges, { count: 0, recent: [] });
});

await asyncTest('recentPlanChanges reports the total count and the 2 most recent replies', async () => {
  const dir = path.join(tmpRoot, 'plan-changes-present');
  const paths = writeFixture(dir, {
    goalsChangelog: [
      { at: '2026-07-28T00:00:00.000Z', sender: 'kevin', tool: 'log_decision', input: {}, reply: 'Added ✓ to the plan\'s open decisions: "Oldest decision".' },
      { at: '2026-07-29T00:00:00.000Z', sender: 'hanna', tool: 'update_phase_expense', input: {}, reply: 'Updated ✓ Phase 1 (Dual income): "Middle line" = 1,000/mo.' },
      { at: '2026-07-30T00:00:00.000Z', sender: 'kevin', tool: 'update_phase_expense', input: {}, reply: 'Updated ✓ Phase 1 (Dual income): "Au pair" = 3,033/mo.' },
    ],
  });
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'Recap.' }] }; };
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: mockTelegram }));

  assert.equal(capturedBundle.recentPlanChanges.count, 3, 'count should reflect every logged change, not just the recent ones shown');
  assert.equal(capturedBundle.recentPlanChanges.recent.length, 2);
  assert.ok(capturedBundle.recentPlanChanges.recent[1].includes('Au pair'), 'the most recent change should be last in the recent list');
  assert.ok(!capturedBundle.recentPlanChanges.recent.some((r) => r.includes('Oldest decision')), 'only the 2 most recent should be included, not every change verbatim');
});

// Oura health signal (2026-08-06): health is reported on both cadence days,
// but only Thursday lets it change the weekend's dining suggestions.
// An empty store dir means health degrades to "not configured" without ever
// reading this machine's real data/oura/ — same guard as calendarEnvPath.
function emptyHealthPaths(dir) {
  const storeDir = path.join(dir, 'oura-store');
  fs.mkdirSync(storeDir, { recursive: true });
  return { ouraStoreDir: storeDir, healthOverridesPath: path.join(dir, 'health_overrides.json') };
}

await asyncTest('Thursday puts health in the bundle and lets it shape plans', async () => {
  const dir = path.join(tmpRoot, 'health-thursday');
  const paths = writeFixture(dir, {});
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  await runOnce(baseOpts(paths, {
    now: THURSDAY, anthropicClient: mockAnthropic, telegramClient: async () => ({ ok: true }),
    ...emptyHealthPaths(dir),
  }));

  assert.ok(capturedBundle.health, 'health should be present on Thursday');
  assert.ok('perOwner' in capturedBundle.health);
  assert.equal(capturedBundle.healthAffectsPlans, true);
});

await asyncTest('Sunday reports health but never lets it change suggestions', async () => {
  const dir = path.join(tmpRoot, 'health-sunday');
  const paths = writeFixture(dir, {});
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  await runOnce(baseOpts(paths, {
    now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: async () => ({ ok: true }),
    ...emptyHealthPaths(dir),
  }));

  assert.ok(capturedBundle.health, 'health should be present on Sunday too');
  assert.equal(capturedBundle.healthAffectsPlans, false, 'Sunday must never shape plans');
});

// Builds a store a depletion verdict can actually be computed from: a long
// steady baseline for `owner`, then a markedly worse current week.
function writeDepletedStore(dir, ownerId, { baselineScore = 90, weekScore = 78 } = {}) {
  const storeDir = path.join(dir, 'oura-store');
  fs.mkdirSync(storeDir, { recursive: true });
  const byId = {};
  const dayBefore = (n) => {
    const d = new Date(THURSDAY);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  for (let ago = 1; ago <= 30; ago += 1) {
    const day = dayBefore(ago);
    const score = ago <= 7 ? weekScore : baselineScore;
    byId[`${ownerId}:daily_sleep:${day}`] = {
      id: `${ownerId}:daily_sleep:${day}`, ownerId, endpoint: 'daily_sleep', day, data: { score },
    };
  }
  fs.writeFileSync(path.join(storeDir, 'daily_sleep.json'),
    JSON.stringify({ meta: { lastUpdated: dayBefore(1), recordCount: Object.keys(byId).length }, byId }, null, 2), 'utf8');
  return { ouraStoreDir: storeDir, healthOverridesPath: path.join(dir, 'health_overrides.json') };
}

await asyncTest('a genuinely depleted week reaches get_dining_plan and swaps the weekend low-key', async () => {
  // The integration the separate unit tests can't prove: health.worst actually
  // arriving in diningContext.depletion on a real Thursday run. This is also
  // the first thing ever to reach recommendForSlot's low-key branch from the
  // recap path — it was unreachable here before this feature.
  const dir = path.join(tmpRoot, 'health-depleted-swap');
  const paths = writeFixture(dir, {});
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  await runOnce(baseOpts(paths, {
    now: THURSDAY, anthropicClient: mockAnthropic, telegramClient: async () => ({ ok: true }),
    ...writeDepletedStore(dir, 'kevin'),
  }));

  assert.ok(capturedBundle.health.worst, 'someone should read as depleted');
  assert.equal(capturedBundle.health.worst.ownerId, 'kevin');
  assert.match(capturedBundle.dining.date_night.reply, /Movie night at home/,
    'date night should fall back to the fixture\'s lowKeyHangIdeas entry');
  assert.match(capturedBundle.dining.date_night.reply, /depleted/);
  assert.doesNotMatch(capturedBundle.dining.date_night.reply, /Budget is tight/,
    'the stated cause must be sleep, not a budget the recap never consulted');
  assert.doesNotMatch(capturedBundle.dining.family_dinner.reply, /Movie night at home/,
    'family dinner resolves six days out and must never swap');
});

await asyncTest('the same depleted week on a Sunday changes no suggestion', async () => {
  const dir = path.join(tmpRoot, 'health-depleted-sunday');
  const paths = writeFixture(dir, {});
  let capturedBundle = null;
  const mockAnthropic = async ({ bundle }) => { capturedBundle = bundle; return { content: [{ type: 'text', text: 'ok' }] }; };
  await runOnce(baseOpts(paths, {
    now: SUNDAY, anthropicClient: mockAnthropic, telegramClient: async () => ({ ok: true }),
    ...writeDepletedStore(dir, 'kevin'),
  }));

  assert.equal(capturedBundle.healthAffectsPlans, false);
  assert.doesNotMatch(capturedBundle.dining.date_night.reply, /Movie night at home/,
    'Sunday reports health but must never send the weekend low-key');
});

console.log('All tests passed.');
