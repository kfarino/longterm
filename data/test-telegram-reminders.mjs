// Longterm/data/test-telegram-reminders.mjs
//
// Permanent regression test (NOT a temp task script -- do not delete). Covers
// telegram-bot-reminders.mjs's due-vs-not-due filtering (date, time of day,
// and the catch-up behavior for a missed run), the grouped single-message
// send, and the all-or-nothing sent-marking on success vs. failure. Run with:
//   node Longterm/data/test-telegram-reminders.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce } from '../scripts/telegram-bot-reminders.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-reminders-test-'));

async function asyncTest(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

function writeFixture(dir, { items } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const remindersPath = path.join(dir, 'reminders.json');
  fs.writeFileSync(remindersPath, JSON.stringify({ meta: { description: 'test' }, items: items || [] }, null, 2));
  return { remindersPath };
}

function baseOpts(paths, extra = {}) {
  return {
    remindersPath: paths.remindersPath,
    token: 'test-token',
    groupChatId: '-999',
    dryRun: false,
    ...extra,
  };
}

const TODAY = new Date(2026, 7, 6, 8, 0, 0); // 2026-08-06

console.log('test-telegram-reminders.mjs');

await asyncTest('no due reminders: no message sent, nothing marked', async () => {
  const dir = path.join(tmpRoot, 'none-due');
  const paths = writeFixture(dir, {
    items: [{ id: 'r1', text: 'Future thing', date: '2026-08-07', owner: null, createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null }],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'none_due');
  assert.equal(sent.length, 0);
});

await asyncTest('a reminder due exactly today is sent and marked sent', async () => {
  const dir = path.join(tmpRoot, 'due-today');
  const paths = writeFixture(dir, {
    items: [{ id: 'r1', text: 'Call the doctor', date: '2026-08-06', owner: 'kevin', createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null }],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.chat_id, '-999');
  assert.ok(sent[0].body.text.includes('Call the doctor (kevin)'));
  const persisted = JSON.parse(fs.readFileSync(paths.remindersPath, 'utf8'));
  assert.equal(persisted.items[0].sent, true);
  assert.ok(persisted.items[0].sentAt);
});

await asyncTest('a reminder from a missed past date still fires (<=, not ==)', async () => {
  const dir = path.join(tmpRoot, 'missed-past-date');
  const paths = writeFixture(dir, {
    items: [{ id: 'r1', text: 'Overdue thing', date: '2026-08-03', owner: null, createdAt: '2026-08-01T00:00:00.000Z', sent: false, sentAt: null }],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(result.sent, true);
  assert.ok(sent[0].body.text.includes('Overdue thing'));
});

await asyncTest('multiple due reminders are grouped into one message; a null owner has no suffix', async () => {
  const dir = path.join(tmpRoot, 'grouped');
  const paths = writeFixture(dir, {
    items: [
      { id: 'r1', text: 'Call the doctor', date: '2026-08-06', owner: 'kevin', createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
      { id: 'r2', text: 'Fill the water tank', date: '2026-08-05', owner: null, createdAt: '2026-08-04T00:00:00.000Z', sent: false, sentAt: null },
    ],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(sent.length, 1, 'both due reminders should be one message, not two sends');
  assert.ok(sent[0].body.text.includes('Call the doctor (kevin)'));
  assert.ok(sent[0].body.text.includes('Fill the water tank') && !sent[0].body.text.includes('Fill the water tank ('), 'a null owner should have no suffix');
  assert.equal(result.count, 2);
});

await asyncTest('a not-yet-due reminder is left untouched even when another in the same file is due', async () => {
  const dir = path.join(tmpRoot, 'mixed-due-not-due');
  const paths = writeFixture(dir, {
    items: [
      { id: 'r1', text: 'Due today', date: '2026-08-06', owner: null, createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
      { id: 'r2', text: 'Not due yet', date: '2026-08-10', owner: null, createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
    ],
  });
  const mockTelegram = async () => ({ ok: true });
  await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  const persisted = JSON.parse(fs.readFileSync(paths.remindersPath, 'utf8'));
  assert.equal(persisted.items.find((r) => r.id === 'r1').sent, true);
  assert.equal(persisted.items.find((r) => r.id === 'r2').sent, false);
});

await asyncTest('a failed send leaves every due item unmarked -- the whole batch retries next run', async () => {
  const dir = path.join(tmpRoot, 'failed-send');
  const paths = writeFixture(dir, {
    items: [
      { id: 'r1', text: 'Call the doctor', date: '2026-08-06', owner: 'kevin', createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
      { id: 'r2', text: 'Fill the water tank', date: '2026-08-06', owner: null, createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null },
    ],
  });
  const mockTelegram = async () => { throw new Error('Telegram is down'); };
  await assert.rejects(() => runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram })));
  const persisted = JSON.parse(fs.readFileSync(paths.remindersPath, 'utf8'));
  assert.equal(persisted.items[0].sent, false);
  assert.equal(persisted.items[1].sent, false);
});

await asyncTest('a sent reminder is never included again on a later run', async () => {
  const dir = path.join(tmpRoot, 'already-sent-excluded');
  const paths = writeFixture(dir, {
    items: [{ id: 'r1', text: 'Already handled', date: '2026-08-01', owner: null, createdAt: '2026-08-01T00:00:00.000Z', sent: true, sentAt: '2026-08-01T08:00:00.000Z' }],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: TODAY, telegramClient: mockTelegram }));
  assert.equal(result.sent, false);
  assert.equal(sent.length, 0);
});

// --- Time-of-day reminders (2026-08-28) ---
// A reminder may now carry an optional `time` ("HH:MM", 24-hour). Delivery
// runs on a short repeating cadence rather than once a morning, so these
// tests pin the two halves that keeps honest: a timed reminder must not go
// out early, and an untimed one must still behave day-level (waiting for the
// default morning hour) instead of firing at whatever minute the job happens
// to tick first.

function at(hour, minute) {
  return new Date(2026, 7, 6, hour, minute, 0); // 2026-08-06 local
}

function reminder(extra) {
  return {
    id: 'r1', text: 'Turn the water off', date: '2026-08-06', time: null, owner: null,
    createdAt: '2026-08-05T00:00:00.000Z', sent: false, sentAt: null, ...extra,
  };
}

await asyncTest('a timed reminder is not sent before its time of day', async () => {
  const dir = path.join(tmpRoot, 'timed-too-early');
  const paths = writeFixture(dir, { items: [reminder({ time: '06:00' })] });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: at(5, 45), telegramClient: mockTelegram }));
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'none_due');
  assert.equal(sent.length, 0);
  const persisted = JSON.parse(fs.readFileSync(paths.remindersPath, 'utf8'));
  assert.equal(persisted.items[0].sent, false);
});

await asyncTest('a timed reminder is sent once its time arrives, and the message names the time', async () => {
  const dir = path.join(tmpRoot, 'timed-on-time');
  const paths = writeFixture(dir, { items: [reminder({ time: '06:00' })] });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: at(6, 0), telegramClient: mockTelegram }));
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].body.text.includes('Turn the water off'));
  assert.ok(sent[0].body.text.includes('6:00am'), `expected the delivered message to state 6:00am, got: ${sent[0].body.text}`);
});

await asyncTest('a timed reminder whose time passed earlier today still fires on a later run', async () => {
  const dir = path.join(tmpRoot, 'timed-catch-up-same-day');
  const paths = writeFixture(dir, { items: [reminder({ time: '06:00' })] });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: at(9, 30), telegramClient: mockTelegram }));
  assert.equal(result.sent, true);
  assert.equal(sent.length, 1);
});

await asyncTest('an untimed reminder still waits for the day-level default hour', async () => {
  const dir = path.join(tmpRoot, 'untimed-waits-for-default');
  const paths = writeFixture(dir, { items: [reminder({ time: null })] });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: at(0, 15), defaultTime: '08:00', telegramClient: mockTelegram }));
  assert.equal(result.sent, false, 'a day-level reminder must not fire at whatever minute the job first ticks');
  assert.equal(sent.length, 0);
});

await asyncTest('an untimed reminder fires once the day-level default hour arrives', async () => {
  const dir = path.join(tmpRoot, 'untimed-fires-at-default');
  const paths = writeFixture(dir, { items: [reminder({ time: null })] });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: at(8, 0), defaultTime: '08:00', telegramClient: mockTelegram }));
  assert.equal(result.sent, true);
  assert.ok(sent[0].body.text.includes('Turn the water off'));
});

await asyncTest('an overdue timed reminder from a past date fires immediately, whatever the hour', async () => {
  const dir = path.join(tmpRoot, 'timed-overdue-past-date');
  const paths = writeFixture(dir, { items: [reminder({ date: '2026-08-03', time: '18:00' })] });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: at(5, 45), telegramClient: mockTelegram }));
  assert.equal(result.sent, true, 'a missed date must still catch up rather than wait for 18:00 today');
});

await asyncTest('two reminders at different times of the same day are not grouped early', async () => {
  const dir = path.join(tmpRoot, 'timed-not-grouped-early');
  const paths = writeFixture(dir, {
    items: [
      reminder({ id: 'r1', text: 'Turn the water off', time: '06:00' }),
      reminder({ id: 'r2', text: 'Take the bins out', time: '20:00' }),
    ],
  });
  const sent = [];
  const mockTelegram = async (token, method, body) => { sent.push({ method, body }); return { ok: true }; };
  const result = await runOnce(baseOpts(paths, { now: at(6, 5), telegramClient: mockTelegram }));
  assert.equal(result.count, 1);
  assert.ok(sent[0].body.text.includes('Turn the water off'));
  assert.ok(!sent[0].body.text.includes('Take the bins out'), 'a later-in-the-day reminder must not ride along with the morning one');
  const persisted = JSON.parse(fs.readFileSync(paths.remindersPath, 'utf8'));
  assert.equal(persisted.items.find((r) => r.id === 'r2').sent, false);
});

console.log('All tests passed.');
