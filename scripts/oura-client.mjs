// Shared Oura OAuth helpers — tokens live under ~/.longterm/ (never in the repo).
import fs from 'node:fs';
import path from 'node:path';
import { ouraAppEnvPath, ouraOwnerEnvPath } from './longterm-paths.mjs';

export const OURA_AUTHORIZE_URL = 'https://cloud.ouraring.com/oauth/authorize';
export const OURA_TOKEN_URL = 'https://api.ouraring.com/oauth/token';
export const OURA_API_BASE = 'https://api.ouraring.com/v2/usercollection';

/**
 * Loopback redirect — register this exact URI on the Oura application.
 * Must be the literal hostname "localhost", not "127.0.0.1" — Oura's
 * developer portal rejects the latter with "http protocol is only allowed
 * for localhost" even though they're equivalent (confirmed live, 2026-08-06,
 * registering the real app at developer.ouraring.com).
 */
export const OURA_REDIRECT_PORT = 51824;
export const OURA_REDIRECT_URI = `http://localhost:${OURA_REDIRECT_PORT}/oauth2callback`;

/**
 * All 11 scopes available on the app registration (2026-08-06: Kevin opted
 * into everything rather than the original "first pull" subset, so future
 * pulls/brainstorms aren't blocked on a second re-auth for a scope that
 * wasn't requested). Space-separated short names, matching the developer
 * portal's checkbox labels with their "extapi:" prefix stripped.
 */
export const OURA_SCOPES = 'email personal daily heartrate tag workout session spo2 ring_configuration stress heart_health';

export function parseEnvFile(envFilePath) {
  const vars = {};
  for (const line of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

export function writeEnvFile(envPath, values) {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const body = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(envPath, `${body}\n`, 'utf8');
}

export function loadOuraAppEnv() {
  const envPath = ouraAppEnvPath();
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `Missing ${envPath}\n` +
        'Create an OAuth application at https://cloud.ouraring.com/oauth/applications\n' +
        `Redirect URI must be exactly: ${OURA_REDIRECT_URI}\n` +
        'Then run: node scripts/oura-auth-setup.mjs --owner <id>',
    );
  }
  const env = parseEnvFile(envPath);
  if (!env.OURA_CLIENT_ID || !env.OURA_CLIENT_SECRET) {
    throw new Error(`${envPath} must contain OURA_CLIENT_ID and OURA_CLIENT_SECRET`);
  }
  return env;
}

export function loadOuraOwnerEnv(ownerId) {
  const envPath = ouraOwnerEnvPath(ownerId);
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `No Oura tokens for owner "${ownerId}" at ${envPath}\n` +
        `Run: node scripts/oura-auth-setup.mjs --owner ${ownerId}`,
    );
  }
  return { envPath, env: parseEnvFile(envPath) };
}

async function postToken(params) {
  const res = await fetch(OURA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(`Oura token request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function exchangeCodeForTokens({ clientId, clientSecret, code }) {
  return postToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: OURA_REDIRECT_URI,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

/**
 * Refresh tokens are single-use on Oura — always persist the new refresh_token
 * from the response before using the access_token.
 */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  return postToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });
}

export function saveOwnerTokens(ownerId, tokens, extra = {}) {
  const expiresAt = Date.now() + (Number(tokens.expires_in) || 0) * 1000;
  writeEnvFile(ouraOwnerEnvPath(ownerId), {
    OWNER_ID: ownerId,
    ACCESS_TOKEN: tokens.access_token,
    REFRESH_TOKEN: tokens.refresh_token,
    EXPIRES_AT: String(expiresAt),
    SCOPE: tokens.scope || extra.scope || '',
    ...extra,
  });
}

/** Returns a usable access token, refreshing + rewriting the owner env if needed. */
export async function getValidAccessToken(ownerId) {
  const app = loadOuraAppEnv();
  const { envPath, env } = loadOuraOwnerEnv(ownerId);
  const expiresAt = Number(env.EXPIRES_AT) || 0;
  const skewMs = 60_000;
  if (env.ACCESS_TOKEN && Date.now() < expiresAt - skewMs) {
    return env.ACCESS_TOKEN;
  }
  if (!env.REFRESH_TOKEN) {
    throw new Error(`No REFRESH_TOKEN in ${envPath} — re-run oura-auth-setup for ${ownerId}`);
  }
  const tokens = await refreshAccessToken({
    clientId: app.OURA_CLIENT_ID,
    clientSecret: app.OURA_CLIENT_SECRET,
    refreshToken: env.REFRESH_TOKEN,
  });
  if (!tokens.refresh_token) {
    throw new Error('Oura refresh response missing refresh_token (single-use — re-authorize)');
  }
  saveOwnerTokens(ownerId, tokens, { SCOPE: env.SCOPE || '' });
  return tokens.access_token;
}

export async function ouraGet(accessToken, pathSuffix, query = {}) {
  const url = new URL(`${OURA_API_BASE}/${pathSuffix.replace(/^\//, '')}`);
  for (const [k, v] of Object.entries(query)) {
    if (v != null && v !== '') url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  if (!res.ok) {
    const err = new Error(`Oura GET ${pathSuffix} failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
