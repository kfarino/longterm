#!/usr/bin/env node
// Detached Claude Code run for a bot capability request.
// The Telegram poller must NOT wait on this — it spawnDetachedLauncher()s
// and unrefs, because the poller self-exits every ~15 minutes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { telegramEnvPath, longtermHome } from './longterm-paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

export function buildCapabilityPrompt(item) {
  return `You are updating the Longterm household planner repo at ${repoRoot}.

A Telegram user asked the household bot to do something it cannot do yet. Implement the missing capability.

Ask: ${item.ask || '(none)'}
Why the bot can't: ${item.whyCant || '(not specified)'}
Proposed change: ${item.proposedChange || '(not specified)'}

Rules:
- Read AGENTS.md and CLAUDE.md first.
- Tests first (data/test-*.mjs). Invent fixture merchants; never copy real transactions or quote real balances.
- Do not commit gitignored data files or secrets (AGENTS.md §0).
- When the code change is done: commit and push CODE only (this repo has commit/push autonomy).
- Do not change the Telegram poller's 15-minute self-refresh unless the ask is specifically about that.

When you finish, this launcher will mark the request done and Telegram the group.`;
}

export function spawnDetachedLauncher({
  execPath = process.execPath,
  launcherPath = fileURLToPath(import.meta.url),
  requestId,
  requestsPath,
  spawnFn = spawn,
} = {}) {
  const args = [launcherPath, '--request-id', String(requestId), '--requests-path', String(requestsPath)];
  const child = spawnFn(execPath, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: repoRoot,
  });
  if (typeof child.unref === 'function') child.unref();
  return { pid: child.pid };
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

function readLocalEnv(filePath) {
  const values = {};
  if (!fs.existsSync(filePath)) return values;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) continue;
    values[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
  }
  return values;
}

async function defaultClaudeFn({ prompt, repoRoot: cwd, claudeBin }) {
  const bin = claudeBin || process.env.CLAUDE_BIN || 'claude';
  return await new Promise((resolve) => {
    const child = spawn(bin, ['-p', '--dangerously-skip-permissions', prompt], {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => resolve({ ok: false, error: err.message || String(err) }));
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: stderr.trim() || `exit ${code}` });
    });
  });
}

async function defaultNotifyFn(text) {
  const envValues = readLocalEnv(telegramEnvPath());
  const token = envValues.TELEGRAM_BOT_TOKEN;
  const chatId = envValues.TELEGRAM_GROUP_CHAT_ID;
  if (!token || !chatId) return;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function runCapabilityRequest({
  requestId,
  requestsPath,
  repoRoot: cwd = repoRoot,
  claudeFn,
  notifyFn,
  claudeBin,
} = {}) {
  const data = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  const item = (data.items || []).find((i) => i.id === requestId);
  if (!item) throw new Error(`capability request not found: ${requestId}`);
  item.status = 'running';
  writeJson(requestsPath, data);

  const run = claudeFn || ((opts) => defaultClaudeFn(opts));
  const notify = notifyFn || defaultNotifyFn;
  let result;
  try {
    result = await run({ prompt: buildCapabilityPrompt(item), repoRoot: cwd, claudeBin });
  } catch (err) {
    result = { ok: false, error: err.message || String(err) };
  }

  const latest = JSON.parse(fs.readFileSync(requestsPath, 'utf8'));
  const live = (latest.items || []).find((i) => i.id === requestId) || item;
  if (result?.ok) {
    live.status = 'done';
    live.resolvedAt = new Date().toISOString();
    delete live.error;
    await notify(`Code update finished for: ${live.ask}. The bot will pick it up within about 15 minutes.`);
  } else {
    live.status = 'failed';
    live.error = result?.error || 'unknown error';
    await notify(`Code update failed for: ${live.ask}. It's still on the open-request list.`);
  }
  const idx = (latest.items || []).findIndex((i) => i.id === requestId);
  if (idx >= 0) latest.items[idx] = live;
  writeJson(requestsPath, latest);
  return live;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--request-id') { args.requestId = argv[++i]; continue; }
    if (argv[i] === '--requests-path') { args.requestsPath = argv[++i]; continue; }
  }
  return args;
}

function appendLog(message) {
  const logPath = path.join(longtermHome(), 'logs', 'claude-code-run.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${message}${os.EOL}`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.requestId || !args.requestsPath) {
    throw new Error('usage: claude-code-run.mjs --request-id <id> --requests-path <file>');
  }
  appendLog(`start ${args.requestId}`);
  const live = await runCapabilityRequest(args);
  appendLog(`${args.requestId} ${live.status}${live.error ? ` ${live.error}` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    appendLog(`ERROR ${err.message || err}`);
    console.error(err);
    process.exit(1);
  });
}
