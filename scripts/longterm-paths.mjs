// scripts/longterm-paths.mjs
// Portable defaults for secrets/tools under ~/.longterm (never hardcoded to a
// specific Windows username).
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

export function monarchEnvPath() {
  return path.join(longtermHome(), 'monarch.env');
}

export function monarchMcpExePath() {
  const exe = process.platform === 'win32' ? 'monarch-mcp-jamiew.exe' : 'monarch-mcp-jamiew';
  return path.join(longtermHome(), 'monarch-mcp-venv', process.platform === 'win32' ? 'Scripts' : 'bin', exe);
}

export function ouraAppEnvPath() {
  return path.join(longtermHome(), 'oura-app.env');
}

/** Per-owner Oura OAuth tokens — ownerId matches goals.owners[].id */
export function ouraOwnerEnvPath(ownerId) {
  if (!ownerId || /[^a-z0-9_-]/i.test(ownerId)) {
    throw new Error(`Invalid Oura owner id: ${ownerId}`);
  }
  return path.join(longtermHome(), `oura-${ownerId}.env`);
}
