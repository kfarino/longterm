// Shared Spotify OAuth helpers — tokens live under ~/.longterm/ (never in the repo).
import fs from 'node:fs';
import path from 'node:path';
import { spotifyAppEnvPath, spotifyOwnerEnvPath } from './longterm-paths.mjs';

export const SPOTIFY_AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
export const SPOTIFY_TOKEN_URL = 'https://accounts.spotify.com/api/token';
export const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';

/**
 * Loopback redirect — register this exact URI on the Spotify application.
 * Unlike Oura (which requires the literal hostname "localhost" -- see
 * oura-client.mjs's own comment on that), Spotify requires the loopback IP
 * literal "127.0.0.1" per RFC 8252 and does NOT accept "localhost" as a
 * redirect URI host. Confirmed by this project's own approved design spec
 * (2026-08-05) -- don't "fix" this to localhost by analogy with the Oura
 * bug; the two providers want opposite things here.
 */
export const SPOTIFY_REDIRECT_PORT = 51825;
export const SPOTIFY_REDIRECT_URI = `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}/oauth2callback`;

/** Intentional-taste scopes only — see the design spec for why recently-played/top-artists are excluded. */
export const SPOTIFY_SCOPES = 'user-follow-read user-library-read playlist-read-private playlist-read-collaborative';

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

export function loadSpotifyAppEnv() {
  const envPath = spotifyAppEnvPath();
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `Missing ${envPath}\n` +
        'Create an app at https://developer.spotify.com/dashboard\n' +
        `Redirect URI must be exactly: ${SPOTIFY_REDIRECT_URI}\n` +
        'Then run: node scripts/spotify-auth-setup.mjs --owner <id>',
    );
  }
  const env = parseEnvFile(envPath);
  if (!env.SPOTIFY_CLIENT_ID || !env.SPOTIFY_CLIENT_SECRET) {
    throw new Error(`${envPath} must contain SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET`);
  }
  return env;
}

export function loadSpotifyOwnerEnv(ownerId) {
  const envPath = spotifyOwnerEnvPath(ownerId);
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `No Spotify tokens for owner "${ownerId}" at ${envPath}\n` +
        `Run: node scripts/spotify-auth-setup.mjs --owner ${ownerId}`,
    );
  }
  return { envPath, env: parseEnvFile(envPath) };
}

function basicAuthHeader(clientId, clientSecret) {
  return `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`;
}

async function postToken(clientId, clientSecret, params) {
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(clientId, clientSecret),
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(`Spotify token request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

export async function exchangeCodeForTokens({ clientId, clientSecret, code }) {
  return postToken(clientId, clientSecret, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
  });
}

/**
 * Spotify refresh tokens are long-lived and NOT guaranteed to rotate on
 * every use (unlike Oura's single-use refresh tokens — see oura-client.mjs)
 * — the response may omit refresh_token entirely, in which case the
 * existing one on file is still valid and must be kept, not discarded.
 */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  return postToken(clientId, clientSecret, {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

export function saveOwnerTokens(ownerId, tokens, extra = {}) {
  const expiresAt = Date.now() + (Number(tokens.expires_in) || 0) * 1000;
  const refreshToken = tokens.refresh_token || extra.REFRESH_TOKEN || '';
  writeEnvFile(spotifyOwnerEnvPath(ownerId), {
    OWNER_ID: ownerId,
    ACCESS_TOKEN: tokens.access_token,
    REFRESH_TOKEN: refreshToken,
    EXPIRES_AT: String(expiresAt),
    SCOPE: tokens.scope || extra.SCOPE || '',
  });
}

/** Returns a usable access token, refreshing + rewriting the owner env if needed. */
export async function getValidAccessToken(ownerId) {
  const app = loadSpotifyAppEnv();
  const { envPath, env } = loadSpotifyOwnerEnv(ownerId);
  const expiresAt = Number(env.EXPIRES_AT) || 0;
  const skewMs = 60_000;
  if (env.ACCESS_TOKEN && Date.now() < expiresAt - skewMs) {
    return env.ACCESS_TOKEN;
  }
  if (!env.REFRESH_TOKEN) {
    throw new Error(`No REFRESH_TOKEN in ${envPath} — re-run spotify-auth-setup for ${ownerId}`);
  }
  const tokens = await refreshAccessToken({
    clientId: app.SPOTIFY_CLIENT_ID,
    clientSecret: app.SPOTIFY_CLIENT_SECRET,
    refreshToken: env.REFRESH_TOKEN,
  });
  saveOwnerTokens(ownerId, tokens, { REFRESH_TOKEN: env.REFRESH_TOKEN, SCOPE: env.SCOPE || '' });
  return tokens.access_token;
}

export async function spotifyGet(accessToken, pathSuffix, query = {}) {
  const url = new URL(`${SPOTIFY_API_BASE}/${pathSuffix.replace(/^\//, '')}`);
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
    const err = new Error(`Spotify GET ${pathSuffix} failed: ${res.status}`);
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}
