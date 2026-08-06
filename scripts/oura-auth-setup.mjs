#!/usr/bin/env node
// Interactive Oura OAuth for one owner (goals.owners[].id).
// App credentials → ~/.longterm/oura-app.env
// Per-owner tokens → ~/.longterm/oura-<ownerId>.env
//
// One-time: register an app at https://cloud.ouraring.com/oauth/applications
// with redirect URI exactly http://127.0.0.1:51824/oauth2callback
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import {
  OURA_AUTHORIZE_URL,
  OURA_REDIRECT_PORT,
  OURA_REDIRECT_URI,
  OURA_SCOPES,
  exchangeCodeForTokens,
  loadOuraAppEnv,
  parseEnvFile,
  saveOwnerTokens,
  writeEnvFile,
} from './oura-client.mjs';
import { ouraAppEnvPath, ouraOwnerEnvPath } from './longterm-paths.mjs';

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
      const url = new URL(req.url, `http://localhost:${OURA_REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      const state = url.searchParams.get('state');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(
        error
          ? `Authorization failed: ${error}. You can close this tab.`
          : 'Oura authorization received — close this tab and return to the terminal.',
      );
      server.close();
      if (error) reject(new Error(`Oura OAuth error: ${error}`));
      else if (!code) reject(new Error('No code in Oura callback'));
      else if (expectedState && state !== expectedState) reject(new Error('OAuth state mismatch'));
      else resolve({ code, scope: url.searchParams.get('scope') || '' });
    });
    server.on('error', reject);
    // No explicit host: binds all interfaces (IPv4 + IPv6), since the
    // registered redirect URI's hostname is "localhost" and Windows/Node
    // may resolve that to ::1 rather than 127.0.0.1 -- binding only the
    // IPv4 loopback risked the browser's redirect never reaching this
    // server on such a system.
    server.listen(OURA_REDIRECT_PORT);
  });
}

async function ensureAppEnv() {
  const envPath = ouraAppEnvPath();
  if (fs.existsSync(envPath)) {
    const existing = parseEnvFile(envPath);
    if (existing.OURA_CLIENT_ID && existing.OURA_CLIENT_SECRET) {
      console.log(`Using app credentials from ${envPath}`);
      return existing;
    }
  }
  console.log('Create an Oura OAuth application at:');
  console.log('  https://cloud.ouraring.com/oauth/applications');
  console.log(`Redirect URI (exact): ${OURA_REDIRECT_URI}`);
  console.log('');
  const clientId = await prompt('OURA_CLIENT_ID: ');
  const clientSecret = await prompt('OURA_CLIENT_SECRET: ');
  if (!clientId || !clientSecret) throw new Error('Client ID and secret are required');
  writeEnvFile(envPath, {
    OURA_CLIENT_ID: clientId,
    OURA_CLIENT_SECRET: clientSecret,
    OURA_REDIRECT_URI: OURA_REDIRECT_URI,
  });
  console.log(`Wrote ${envPath}`);
  return { OURA_CLIENT_ID: clientId, OURA_CLIENT_SECRET: clientSecret };
}

async function main() {
  const { ownerId } = parseArgs(process.argv);
  if (!ownerId) {
    console.error('Usage: node scripts/oura-auth-setup.mjs --owner <id>');
    console.error('  <id> matches goals.owners[].id (e.g. kevin, hanna)');
    process.exit(1);
  }
  if (/[^a-z0-9_-]/i.test(ownerId)) {
    throw new Error(`Invalid owner id: ${ownerId}`);
  }

  console.log(`Oura auth setup for owner "${ownerId}"`);
  console.log(`Tokens will be saved to ${ouraOwnerEnvPath(ownerId)}\n`);

  const app = await ensureAppEnv();
  // Re-load in case ensureAppEnv just wrote the file
  const creds = loadOuraAppEnv();
  const clientId = creds.OURA_CLIENT_ID || app.OURA_CLIENT_ID;
  const clientSecret = creds.OURA_CLIENT_SECRET || app.OURA_CLIENT_SECRET;

  const state = crypto.randomBytes(16).toString('hex');
  const authUrl = new URL(OURA_AUTHORIZE_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', OURA_REDIRECT_URI);
  authUrl.searchParams.set('scope', OURA_SCOPES);
  authUrl.searchParams.set('state', state);

  console.log(`Log into Oura as the person who owns this account (${ownerId}), then approve.`);
  console.log('\nOpen this URL:\n');
  console.log(authUrl.toString());
  console.log(`\nWaiting on ${OURA_REDIRECT_URI} ...`);

  const { code, scope } = await waitForAuthCode(state);
  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, code });
  if (!tokens.access_token || !tokens.refresh_token) {
    throw new Error(`Unexpected token response: ${JSON.stringify(tokens)}`);
  }

  saveOwnerTokens(ownerId, tokens, { SCOPE: scope || tokens.scope || OURA_SCOPES });
  console.log(`\nSaved tokens → ${ouraOwnerEnvPath(ownerId)}`);
  console.log(`Granted scopes: ${scope || tokens.scope || '(see Oura response)'}`);
  console.log(`\nNext: node scripts/oura-pull.mjs --owner ${ownerId}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}
