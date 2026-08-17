#!/usr/bin/env node
// Pulls current account balances/holdings from Monarch and refreshes
// Longterm/data/accounts.json, then regenerates data.js. Speaks JSON-RPC
// over stdio to monarch-mcp-jamiew (calling get_accounts/get_account_holdings),
// authenticates via an out-of-repo credentials file, and writes atomically.
// Part of this project's own self-contained daily pull — see
// run-daily-pull.ps1 and install-scheduled-task.ps1 in this same folder.
//
// Runs monarch-mcp-jamiew from a persistent local venv (~/.longterm/monarch-mcp-venv)
// rather than via `uvx`/`uv` — both are unsigned binaries that Windows Smart App
// Control started blocking outright on 2026-08-02 once it moved from Evaluation to
// Enforce mode (an automatic Windows transition, not something toggled by hand).
// The venv's python.exe is a signed, trusted binary SAC doesn't gate.
// Do NOT spawn Scripts\monarch-mcp-jamiew.exe — that pip console-script stub
// is unsigned; SAC blocked it on 2026-08-17 (dialog may say "monarch.exe").
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { monarchEnvPath, monarchMcpExePath, resolveMonarchMcpLaunch } from './longterm-paths.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = {
    outputPath: path.join(repoRoot, 'data', 'accounts.json'),
    envFile: monarchEnvPath(),
    mcpServerExe: monarchMcpExePath(),
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new Error(`Missing value for ${arg}`);
      }
      i += 1;
      if (key === 'output-path') args.outputPath = value;
      else if (key === 'monarch-env-file') args.envFile = value;
      else if (key === 'mcp-server-exe') args.mcpServerExe = value;
      else throw new Error(`Unknown argument: ${arg}`);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

// Parses a simple KEY=VALUE .env file (no quoting/multi-line support needed —
// monarch.env has never used either) into a plain object.
function parseEnvFile(envFilePath) {
  const vars = {};
  for (const line of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function sanitize(value) {
  return String(value)
    .replace(/(MONARCH_(?:EMAIL|PASSWORD|MFA_SECRET|SESSION_DIR)=)[^\s]+/gi, '$1[redacted]')
    .replace(/(TELEGRAM_[A-Z_]*=)[^\s]+/gi, '$1[redacted]')
    .replace(/(password|secret|token)(["':=\s]+)[^"',\s]+/gi, '$1$2[redacted]');
}

class McpClient {
  constructor({ mcpServerExe, envFile }) {
    this.nextId = 1;
    this.pending = new Map();
    this.stderrLines = [];
    const launch = resolveMonarchMcpLaunch(mcpServerExe);
    this.proc = spawn(launch.command, launch.args, {
      cwd: repoRoot,
      env: { ...process.env, ...parseEnvFile(envFile) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) this.stderrLines.push(sanitize(line).slice(0, 500));
      }
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.handleLine(line));

    this.proc.on('exit', (code, signal) => {
      const error = new Error(`Monarch MCP process exited before completing request: code=${code} signal=${signal || ''}`.trim());
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
    });
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!Object.prototype.hasOwnProperty.call(message, 'id')) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
    } else {
      pending.resolve(message.result);
    }
  }

  request(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: '2.0', id, method, params };
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for MCP response to ${method}`));
      }, 120000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
    });
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    return promise;
  }

  notify(method, params = {}) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async initialize() {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'longterm-networth-pull', version: '0.1.0' },
    });
    this.notify('notifications/initialized');
  }

  async callTool(name, args) {
    const result = await this.request('tools/call', { name, arguments: args });
    return parseToolResult(result);
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

function parseToolResult(result) {
  const text = (result?.content || [])
    .filter((item) => item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
  if (!text) return result;
  let parsed = JSON.parse(text);
  if (typeof parsed === 'string') parsed = JSON.parse(parsed);
  return parsed;
}

function extractAccounts(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.accounts)) return payload.accounts;
  if (Array.isArray(payload?.data?.accounts)) return payload.data.accounts;
  throw new Error('Could not find an accounts array in Monarch MCP response');
}

async function fetchAccounts(client) {
  const payload = await client.callTool('get_accounts', {});
  return extractAccounts(payload);
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}${os.EOL}`, { encoding: 'utf8' });
  fs.renameSync(tempPath, filePath);
}

// Applies mapping.accounts entries to balances. A mapping entry's `target`
// is either "balances.<bucket>.<owner>" (flat) or
// "balances.retirement.kevin.components.<name>" (composite retirement).
// Anything without a mapping entry is left untouched (stays "manual").
function applyMapping(accountsJson, liveAccounts) {
  const byId = new Map(liveAccounts.map((a) => [String(a.id ?? a.account_id ?? a.name), a]));
  let updated = 0;

  for (const entry of accountsJson.mapping.accounts) {
    const live = byId.get(String(entry.monarchId));
    if (!live) continue; // linked in our mapping but not seen in this pull — leave as-is, don't clobber

    const amount = Number(live.balance ?? live.currentBalance ?? live.amount);
    if (!Number.isFinite(amount)) continue;

    const parts = entry.target.split('.');
    if (parts[0] === 'balances' && parts[3] === 'components') {
      const [, bucket, owner, , componentName] = parts;
      const components = accountsJson.balances[bucket][owner].components;
      const component = components.find((c) => c.name === componentName);
      if (!component) continue;
      component.amount = amount;
      component.source = 'monarch';
      accountsJson.balances[bucket][owner].amount = components.reduce((sum, c) => sum + c.amount, 0);
      accountsJson.balances[bucket][owner].source = components.every((c) => c.source === 'monarch') ? 'monarch' : 'mixed';
    } else {
      const [, bucket, owner] = parts;
      accountsJson.balances[bucket][owner].amount = amount;
      accountsJson.balances[bucket][owner].source = 'monarch';
    }
    updated += 1;
  }

  return updated;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, outputPath: args.outputPath }));
    return;
  }

  if (!fs.existsSync(args.envFile)) {
    throw new Error(`Missing Monarch env file: ${args.envFile}`);
  }
  const launch = resolveMonarchMcpLaunch(args.mcpServerExe);
  if (!fs.existsSync(launch.command)) {
    throw new Error(`Missing signed venv Python: ${launch.command}`);
  }
  if (!fs.existsSync(args.outputPath)) {
    throw new Error(`Missing Finances accounts.json at ${args.outputPath}`);
  }

  const client = new McpClient({ mcpServerExe: args.mcpServerExe, envFile: args.envFile });
  try {
    await client.initialize();
    const liveAccounts = await fetchAccounts(client);

    const accountsJson = JSON.parse(fs.readFileSync(args.outputPath, 'utf8'));
    const updated = applyMapping(accountsJson, liveAccounts);
    accountsJson.meta.asOf = new Date().toISOString().slice(0, 10);

    writeJson(args.outputPath, accountsJson);

    // Regenerate data.js so the dashboard picks up the refresh immediately.
    const buildScript = path.join(path.dirname(args.outputPath), 'build-data.mjs');
    const result = spawnSync(process.execPath, [buildScript], { stdio: 'inherit' });
    if (result.status !== 0) {
      throw new Error(`build-data.mjs failed with exit code ${result.status}`);
    }

    console.log(JSON.stringify({
      ok: true,
      liveAccountCount: liveAccounts.length,
      mappedFieldsUpdated: updated,
      unmappedMappingEntries: accountsJson.mapping.accounts.length - updated,
      outputPath: args.outputPath,
    }));
  } catch (error) {
    const stderrTail = client.stderrLines.slice(-5);
    if (stderrTail.length > 0) {
      error.message = `${error.message}${os.EOL}MCP stderr tail:${os.EOL}${stderrTail.join(os.EOL)}`;
    }
    throw error;
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(sanitize(error.stack || error.message || error));
  process.exit(1);
});
