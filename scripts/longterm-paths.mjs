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

/** Written when Google refresh returns invalid_grant — poll skips sync until cleared. */
export function calendarSyncAuthPausePath() {
  return path.join(longtermHome(), 'calendar-sync-auth-pause.json');
}

export function monarchEnvPath() {
  return path.join(longtermHome(), 'monarch.env');
}

export function telegramPollLogPath() {
  return path.join(longtermHome(), 'logs', 'telegram-poll.log');
}

export function monarchMcpPythonPath() {
  const exe = process.platform === 'win32' ? 'python.exe' : 'python';
  return path.join(longtermHome(), 'monarch-mcp-venv', process.platform === 'win32' ? 'Scripts' : 'bin', exe);
}

export function monarchMcpLaunchArgs() {
  return ['-c', 'from server import run; run()'];
}

const UNSIGNED_MCP_STUBS = new Set(['monarch-mcp-jamiew.exe', 'monarch-mcp-jamiew']);

// SAC blocks the unsigned pip console-script stub (Windows dialog may
// shorten monarch-mcp-jamiew.exe to "monarch.exe"). Spawn signed venv
// python instead. An explicit non-python override is left as-is for tests.
export function resolveMonarchMcpLaunch(mcpServerExe) {
  const base = path.basename(mcpServerExe || '').toLowerCase();
  if (!mcpServerExe || UNSIGNED_MCP_STUBS.has(base) || base === 'python.exe' || base === 'python') {
    return { command: monarchMcpPythonPath(), args: monarchMcpLaunchArgs() };
  }
  return { command: mcpServerExe, args: [] };
}

/** @deprecated Use resolveMonarchMcpLaunch — this is the signed venv python, not the jamiew stub. */
export function monarchMcpExePath() {
  return monarchMcpPythonPath();
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

export function spotifyAppEnvPath() {
  return path.join(longtermHome(), 'spotify-app.env');
}

/** Per-owner Spotify OAuth tokens — ownerId matches goals.owners[].id */
export function spotifyOwnerEnvPath(ownerId) {
  if (!ownerId || /[^a-z0-9_-]/i.test(ownerId)) {
    throw new Error(`Invalid Spotify owner id: ${ownerId}`);
  }
  return path.join(longtermHome(), `spotify-${ownerId}.env`);
}

export function ticketmasterEnvPath() {
  return path.join(longtermHome(), 'ticketmaster.env');
}
