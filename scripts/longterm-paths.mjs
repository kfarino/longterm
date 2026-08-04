// scripts/longterm-paths.mjs
// Portable defaults for secrets/tools under ~/.longterm (never hardcoded to a
// specific Windows username). Monarch credentials may still live at the legacy
// ~/.scrooge/monarch.env path on machines that set that up first — resolve
// prefers ~/.longterm, then falls back.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function longtermHome() {
  return path.join(os.homedir(), '.longterm');
}

export function telegramEnvPath() {
  return path.join(longtermHome(), 'telegram.env');
}

export function googleCalendarEnvPath() {
  return path.join(longtermHome(), 'google-calendar.env');
}

export function monarchMcpExePath() {
  const exe = process.platform === 'win32' ? 'monarch-mcp-jamiew.exe' : 'monarch-mcp-jamiew';
  return path.join(longtermHome(), 'monarch-mcp-venv', process.platform === 'win32' ? 'Scripts' : 'bin', exe);
}

/** Prefer ~/.longterm/monarch.env; fall back to legacy ~/.scrooge/monarch.env if present. */
export function monarchEnvPath() {
  const preferred = path.join(longtermHome(), 'monarch.env');
  if (fs.existsSync(preferred)) return preferred;
  const legacy = path.join(os.homedir(), '.scrooge', 'monarch.env');
  if (fs.existsSync(legacy)) return legacy;
  return preferred;
}
