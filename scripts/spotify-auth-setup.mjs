#!/usr/bin/env node
// Interactive Spotify OAuth for one owner (goals.owners[].id).
// App credentials → ~/.longterm/spotify-app.env
// Per-owner tokens → ~/.longterm/spotify-<ownerId>.env
//
// One-time: register an app at https://developer.spotify.com/dashboard
// with redirect URI exactly http://127.0.0.1:51825/oauth2callback
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  SPOTIFY_AUTHORIZE_URL,
  SPOTIFY_REDIRECT_PORT,
  SPOTIFY_REDIRECT_URI,
  SPOTIFY_SCOPES,
  exchangeCodeForTokens,
  loadSpotifyAppEnv,
  parseEnvFile,
  saveOwnerTokens,
  writeEnvFile,
} from './spotify-client.mjs';
import { spotifyAppEnvPath, spotifyOwnerEnvPath } from './longterm-paths.mjs';

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

function parseArgs(argv) {
  let ownerId = null;
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--owner' && argv[i + 1]) {
      ownerId = argv[++i];
    }
  }
  return { ownerId };
}

function waitForAuthCode(expectedState) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${SPOTIFY_REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        error
          ? `Authorization failed: ${error}. You can close this tab.`
          : 'Spotify authorization received — close this tab and return to the terminal.',
      );
      server.close();
      if (error) reject(new Error(`Spotify OAuth error: ${error}`));
      else if (!code) reject(new Error('No code in Spotify callback'));
      else if (expectedState && state !== expectedState) reject(new Error('OAuth state mismatch'));
      else resolve({ code });
    });
    server.on('error', reject);
    // The registered redirect URI's host is the loopback IP literal
    // 127.0.0.1 (Spotify's own requirement — see spotify-client.mjs's
    // SPOTIFY_REDIRECT_URI comment), so bind explicitly there to match
    // exactly. Unlike Oura's auth-setup (which binds all interfaces because
    // Oura's redirect URI uses the hostname "localhost").
    server.listen(SPOTIFY_REDIRECT_PORT, '127.0.0.1');
  });
}

async function ensureAppEnv() {
  const envPath = spotifyAppEnvPath();
  if (fs.existsSync(envPath)) {
    const existing = parseEnvFile(envPath);
    if (existing.SPOTIFY_CLIENT_ID && existing.SPOTIFY_CLIENT_SECRET) {
      console.log(`Using app credentials from ${envPath}`);
      return existing;
    }
  }
  console.log('Create a Spotify app at:');
  console.log('  https://developer.spotify.com/dashboard');
  console.log(`Redirect URI (exact): ${SPOTIFY_REDIRECT_URI}`);
  console.log('');
  const clientId = await prompt('SPOTIFY_CLIENT_ID: ');
  const clientSecret = await prompt('SPOTIFY_CLIENT_SECRET: ');
  if (!clientId || !clientSecret) throw new Error('Client ID and secret are required');
  writeEnvFile(envPath, {
    SPOTIFY_CLIENT_ID: clientId,
    SPOTIFY_CLIENT_SECRET: clientSecret,
    SPOTIFY_REDIRECT_URI: SPOTIFY_REDIRECT_URI,
  });
  console.log(`Wrote ${envPath}`);
  return { SPOTIFY_CLIENT_ID: clientId, SPOTIFY_CLIENT_SECRET: clientSecret };
}

async function main() {
  const { ownerId } = parseArgs(process.argv);
  if (!ownerId) {
    console.error('Usage: node scripts/spotify-auth-setup.mjs --owner <id>');
    console.error('  <id> matches goals.owners[].id (e.g. kevin, hanna)');
    process.exit(1);
  }
  if (/[^a-z0-9_-]/i.test(ownerId)) {
    throw new Error(`Invalid owner id: ${ownerId}`);
  }

  console.log(`Spotify auth setup for owner "${ownerId}"`);
  console.log(`Tokens will be saved to ${spotifyOwnerEnvPath(ownerId)}\n`);

  const app = await ensureAppEnv();
  // Re-load in case ensureAppEnv just wrote the file
  const creds = loadSpotifyAppEnv();
  const clientId = creds.SPOTIFY_CLIENT_ID || app.SPOTIFY_CLIENT_ID;
  const clientSecret = creds.SPOTIFY_CLIENT_SECRET || app.SPOTIFY_CLIENT_SECRET;

  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = new URL(SPOTIFY_AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', SPOTIFY_REDIRECT_URI);
  authUrl.searchParams.set('scope', SPOTIFY_SCOPES);
  authUrl.searchParams.set('state', state);
  // Forces Spotify's login/account-chooser screen every time instead of
  // silently reusing whichever Spotify account is already logged into the
  // browser (2026-08-06) — the exact failure mode that produced a
  // false-positive "Hanna" authorization during the Oura connect sketch
  // (silently re-authorized Kevin's account instead of prompting). Cheap
  // insurance against repeating that mistake here.
  authUrl.searchParams.set('show_dialog', 'true');

  console.log(`Log into Spotify as the person who owns this account (${ownerId}), then approve.`);
  console.log('\nOpen this URL:\n');
  console.log(authUrl.toString());
  console.log(`\nWaiting on ${SPOTIFY_REDIRECT_URI} ...`);

  const { code } = await waitForAuthCode(state);
  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, code });
  if (!tokens.access_token) {
    throw new Error(`Unexpected token response: ${JSON.stringify(tokens)}`);
  }

  saveOwnerTokens(ownerId, tokens);
  console.log(`\nSaved tokens → ${spotifyOwnerEnvPath(ownerId)}`);
  console.log(`Granted scopes: ${tokens.scope || SPOTIFY_SCOPES}`);
  console.log(`\nNext: node scripts/spotify-pull.mjs --owner ${ownerId}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
