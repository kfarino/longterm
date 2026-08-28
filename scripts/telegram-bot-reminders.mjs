#!/usr/bin/env node
// Finances/Longterm/scripts/telegram-bot-reminders.mjs
// Sends any one-off reminders that have come due (see dueReminders below for
// the catch-up rules) as a single grouped Telegram message into the same
// group the interactive bot uses, then marks them sent. Sibling to
// telegram-bot-recap.mjs -- same conventions (own callTelegram copy,
// parseArgs/runOnce/main shape) -- but much simpler: no LLM call, no dedup
// log (the item's own `sent` flag is the dedup).
//
// Runs via its own scheduled task (install-telegram-reminders-scheduled-task.ps1),
// every few minutes rather than once each morning as of 2026-08-28, when
// reminders gained an optional time of day -- a once-a-morning job cannot
// deliver a 6am reminder at 6am. A tick with nothing due sends nothing.
// See docs/superpowers/specs/2026-08-05-telegram-reminders-design.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { telegramEnvPath } from './longterm-paths.mjs';
import { DEFAULT_REMINDER_TIME, clockOf, effectiveTime, formatReminderTime, parseReminderTime } from './reminder-time.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDataDir = path.join(here, '..', 'data');

function parseArgs(argv) {
  const args = {
    envPath: telegramEnvPath(),
    remindersPath: path.join(repoDataDir, 'reminders.json'),
    // The hour a reminder with no time of its own goes out at. The job now
    // ticks every few minutes (so a 06:00 reminder can actually fire at
    // 06:00), which would otherwise make a day-level reminder go off at
    // whatever minute the machine first woke up -- 00:15 is not a morning
    // nudge. Overridable so the scheduled task owns the household's hour.
    defaultTime: DEFAULT_REMINDER_TIME,
    dryRun: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') { args.dryRun = true; continue; }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      i += 1;
      if (key === 'env-path') args.envPath = value;
      else if (key === 'reminders-path') args.remindersPath = value;
      else if (key === 'default-time') args.defaultTime = value;
      else throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
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

function isoDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

function loadReminders(remindersPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(remindersPath, 'utf8'));
    return { ...parsed, items: parsed.items || [] };
  } catch {
    return { items: [] };
  }
}

// Due = its moment has arrived and not been sent yet.
//
// A past date fires regardless of the hour -- < today, not <=, so a reminder
// the scheduled task missed entirely (PC asleep, task failure) still goes out
// late on the next successful run instead of being silently dropped, and a
// yesterday-at-18:00 reminder is not made to wait until 18:00 today.
//
// On its own date it waits for its time of day, or for the day-level default
// when it has none. Comparing zero-padded "HH:MM" strings is a plain
// lexicographic compare, and both sides are local wall-clock -- someone who
// says "6am" means 6am where they live.
function dueReminders(reminders, now, defaultTime) {
  const today = isoDate(now);
  const clock = clockOf(now);
  return reminders.items.filter((r) => {
    if (r.sent) return false;
    if (r.date < today) return true;
    if (r.date > today) return false;
    return clock >= effectiveTime(r, defaultTime);
  });
}

// A timed reminder leads with its time, in the same 12-hour form the bot
// confirmed when it was set -- so a wrong am/pm is visible on arrival too.
function formatGroupedMessage(due) {
  const lines = due.map((r) => {
    const time = parseReminderTime(r.time).time;
    return `- ${time ? `${formatReminderTime(time)} — ` : ''}${r.text}${r.owner ? ` (${r.owner})` : ''}`;
  });
  return `⏰ Reminders for today:\n${lines.join('\n')}`;
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

export async function runOnce(opts) {
  const args = { ...parseArgs([]), ...opts };
  const now = args.now || new Date();

  const reminders = loadReminders(args.remindersPath);
  const due = dueReminders(reminders, now, args.defaultTime || DEFAULT_REMINDER_TIME);
  if (!due.length) return { sent: false, reason: 'none_due' };

  const envValues = args.token && args.groupChatId ? {} : readLocalEnv(args.envPath);
  const token = args.token || envValues.TELEGRAM_BOT_TOKEN;
  const groupChatId = args.groupChatId || envValues.TELEGRAM_GROUP_CHAT_ID;
  const text = formatGroupedMessage(due);

  if (!args.dryRun) {
    const telegramClient = args.telegramClient || callTelegram;
    // All-or-nothing: one send call for the whole batch. On failure this
    // throws and propagates -- nothing here is marked sent, so the exact
    // same batch (plus anything newly due) retries next run.
    await telegramClient(token, 'sendMessage', { chat_id: groupChatId, text });
    const dueIds = new Set(due.map((r) => r.id));
    reminders.items = reminders.items.map((r) => (dueIds.has(r.id) ? { ...r, sent: true, sentAt: now.toISOString() } : r));
    writeJson(args.remindersPath, reminders);
  }

  return { sent: true, count: due.length, text, reminders };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = await runOnce(args);
  console.log(JSON.stringify({ ok: true, sent: result.sent, count: result.count || 0, reason: result.reason || null }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
