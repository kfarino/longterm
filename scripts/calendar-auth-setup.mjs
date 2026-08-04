#!/usr/bin/env node
// One-off, interactive: exchanges a one-time OAuth consent for a refresh
// token, creates the dedicated "Family Planner" Google Calendar, and saves
// credentials to ~/.longterm/google-calendar.env (same outside-the-repo
// convention as telegram.env / monarch.env).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { googleCalendarEnvPath } from './longterm-paths.mjs';

const REDIRECT_PORT = 51823;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/oauth2callback`;
const SCOPE = 'https://www.googleapis.com/auth/calendar';
const DEFAULT_ENV_PATH = googleCalendarEnvPath();

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer.trim()); }));
}

// Desktop-app OAuth clients redirect to a loopback address after consent;
// this tiny one-shot server is just there to catch that single redirect and
// pull the ?code= out of it — closes itself the moment it's handled one request.
function waitForAuthCode() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://127.0.0.1:${REDIRECT_PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(error ? `Authorization failed: ${error}. You can close this tab.` : 'Authorization received — you can close this tab and return to the terminal.');
      server.close();
      if (error) reject(new Error(`Google OAuth error: ${error}`));
      else if (code) resolve(code);
      else reject(new Error('No code or error in callback'));
    });
    server.listen(REDIRECT_PORT);
  });
}

async function exchangeCodeForTokens({ clientId, clientSecret, code }) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: 'authorization_code',
      redirect_uri: REDIRECT_URI,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function createFamilyPlannerCalendar(accessToken) {
  const res = await fetch('https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ summary: 'Family Planner' }),
  });
  if (!res.ok) throw new Error(`Calendar creation failed: ${res.status} ${await res.text()}`);
  return res.json();
}

function writeEnvFile(envPath, values) {
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  const body = Object.entries(values).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(envPath, `${body}\n`, 'utf8');
}

async function main() {
  const envPath = process.argv[2] || DEFAULT_ENV_PATH;
  console.log('Google Calendar one-time setup');
  console.log('Create an OAuth client (type: Desktop app) in a Google Cloud project with the Calendar API enabled, then paste its values below.');
  const clientId = await prompt('Client ID: ');
  const clientSecret = await prompt('Client secret: ');

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');

  console.log('\nOpen this URL in a browser and approve access:');
  console.log(authUrl.toString());
  console.log(`\nWaiting for the redirect on ${REDIRECT_URI} ...`);

  const code = await waitForAuthCode();
  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, code });
  if (!tokens.refresh_token) {
    throw new Error('No refresh_token in response — Google only issues one on first consent for a given client+account. Revoke prior access at https://myaccount.google.com/permissions and re-run.');
  }

  const calendar = await createFamilyPlannerCalendar(tokens.access_token);

  // Separate from the write-target above: which existing calendars the bot
  // is allowed to *read* from for get_calendar_events / the weekly recap's
  // calendar summary. The OAuth scope already granted covers any calendar
  // the signed-in Google account can see (including one Hanna has shared),
  // so this is just picking which ones — deliberately not the work
  // calendar, since that's a separate concern from this household planner.
  console.log('\nWhich calendars should the bot be able to read from (for questions like "what\'s on the calendar")?');
  console.log('Enter each calendar\'s id (usually its email address) — a personal calendar id is typically that account\'s email.');
  console.log('Do NOT include a work calendar — personal/family only.');
  const firstId = await prompt('First adult\'s personal calendar id (blank to skip): ');
  const firstLabel = firstId.trim() ? (await prompt('Label for that calendar (e.g. first name): ')) : '';
  const secondId = await prompt('Second adult\'s personal calendar id (blank to skip): ');
  const secondLabel = secondId.trim() ? (await prompt('Label for that calendar (e.g. first name): ')) : '';
  const readCalendarIds = [
    firstId.trim() && `${firstId.trim()}|${(firstLabel.trim() || 'Adult 1')}`,
    secondId.trim() && `${secondId.trim()}|${(secondLabel.trim() || 'Adult 2')}`,
  ].filter(Boolean).join(',');

  writeEnvFile(envPath, {
    GOOGLE_CLIENT_ID: clientId,
    GOOGLE_CLIENT_SECRET: clientSecret,
    GOOGLE_REFRESH_TOKEN: tokens.refresh_token,
    GOOGLE_CALENDAR_ID: calendar.id,
    GOOGLE_READ_CALENDAR_IDS: readCalendarIds,
  });
  console.log(`\nDone. Saved credentials + calendar id to ${envPath}`);
  console.log(`Created calendar "Family Planner" (id: ${calendar.id}).`);
  console.log(readCalendarIds ? `Bot can read from: ${readCalendarIds}` : 'No read calendars configured yet — get_calendar_events will report "not set up" until GOOGLE_READ_CALENDAR_IDS is added to the env file.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
