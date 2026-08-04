#!/usr/bin/env node
// One-off setup helper — NOT part of the scheduled poll. Run manually once
// after each adult has sent at least one message in the household Telegram
// group, to discover: the group's chat id (TELEGRAM_GROUP_CHAT_ID) and each
// sender's Telegram user id (for data/telegram-owners.json, which maps user
// id → owner id from goals.json owners[]).
import fs from 'node:fs';
import { telegramEnvPath } from './longterm-paths.mjs';

function readLocalEnv(filePath) {
  const values = {};
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return values;
}

async function main() {
  const envPath = process.argv[2] || telegramEnvPath();
  if (!fs.existsSync(envPath)) {
    throw new Error(`Missing env file at ${envPath}. Create it with TELEGRAM_BOT_TOKEN=... first.`);
  }
  const { TELEGRAM_BOT_TOKEN } = readLocalEnv(envPath);
  if (!TELEGRAM_BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN in env file.');

  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`);
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram getUpdates failed: ${JSON.stringify(json)}`);

  if (!json.result.length) {
    console.log('No messages seen yet. Send a message in the group first, then re-run this.');
    return;
  }

  console.log('Seen chats and senders:\n');
  const seenChats = new Set();
  const seenUsers = new Set();
  for (const update of json.result) {
    const msg = update.message;
    if (!msg) continue;
    const chatKey = `${msg.chat.id}|${msg.chat.type}|${msg.chat.title || ''}`;
    if (!seenChats.has(chatKey)) {
      seenChats.add(chatKey);
      console.log(`  Chat: id=${msg.chat.id}  type=${msg.chat.type}  title="${msg.chat.title || ''}"`);
    }
    if (msg.from) {
      const userKey = `${msg.from.id}`;
      if (!seenUsers.has(userKey)) {
        seenUsers.add(userKey);
        console.log(`  Sender: id=${msg.from.id}  name="${msg.from.first_name || ''} ${msg.from.last_name || ''}"  username=@${msg.from.username || '(none)'}`);
      }
    }
  }
  console.log('\nNext: set TELEGRAM_GROUP_CHAT_ID in telegram.env to the group chat id above,');
  console.log('and write data/telegram-owners.json mapping each sender id to an owner id from goals.json owners[].');
}

main().catch((err) => { console.error(err); process.exit(1); });
