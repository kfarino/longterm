#!/usr/bin/env node
// Deep taste profile from full Spotify taste (follows + likes + playlists).
// npm run spotify:profile -- --owner kevin
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { telegramEnvPath } from './longterm-paths.mjs';
import { buildTasteInventory, chunkNames } from './spotify-taste-inventory.mjs';
import { readActRatings, ratingsForProfilePrompt } from './spotify-act-ratings.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tasteDir = path.join(repoRoot, 'data', 'spotify');
const MODEL = 'claude-haiku-4-5-20251001';
const PROFILE_VERSION = 1;

function parseArgs(argv) {
  let ownerId = 'kevin';
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--owner' && argv[i + 1]) ownerId = argv[++i];
  }
  return { ownerId };
}

function parseEnvFile(envFilePath) {
  const vars = {};
  if (!fs.existsSync(envFilePath)) return vars;
  for (const line of fs.readFileSync(envFilePath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) vars[match[1]] = match[2];
  }
  return vars;
}

function loadApiKey() {
  const env = parseEnvFile(telegramEnvPath());
  if (!env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing in ~/.longterm/telegram.env');
  return env.ANTHROPIC_API_KEY;
}

async function claudeJson({ apiKey, system, user, maxTokens = 1024 }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  const body = await res.json();
  const text = (body.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`No JSON in reply: ${text.slice(0, 200)}`);
  return JSON.parse(jsonMatch[0]);
}

async function analyzeChunk({ apiKey, ownerId, label, names }) {
  return claudeJson({
    apiKey,
    maxTokens: 800,
    system:
      'You analyze a slice of someone\'s Spotify library for LIVE SHOW ticket taste (LA nights out), not headphone listening. ' +
      'Taste is often eclectic — do not over-index on a few famous names. ' +
      'Reply ONLY with JSON: {"ticketYes":[string],"ticketMaybe":[string],"ticketSkip":[string],"themes":[string],"notes":"≤40 words"}. ' +
      'Each array item is a short vibe/archetype phrase (not a dump of artist names).',
    user:
      `Owner: ${ownerId}\nSlice: ${label}\nArtists (${names.length}):\n${names.join(', ')}\n`,
  });
}

function uniqStrings(arr, limit) {
  const seen = new Set();
  const out = [];
  for (const x of arr || []) {
    const s = String(x || '').trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= limit) break;
  }
  return out;
}

async function mergeProfile({ apiKey, ownerId, inventory, chunkResults, starFeedback }) {
  const feedbackBlock = starFeedback.length
    ? `\nPrior suggestion feedback (1=way off, 5=nailed it):\n${starFeedback.map((f) => `${f.act}: ${f.stars}★${f.note ? ` (${f.note})` : ''}`).join('\n')}\n`
    : '\nNo suggestion-star feedback yet.\n';

  return claudeJson({
    apiKey,
    maxTokens: 1200,
    system:
      'You merge partial Spotify taste analyses into one LIVE-SHOW taste profile for a household planner. ' +
      'Emphasize breadth and eclecticism; explicitly warn against over-weighting mega-artists from save volume. ' +
      'Suggestion-star feedback (when present) means how accurate PAST recommendations were — learn from misses. ' +
      'Reply ONLY with JSON: {' +
      '"breadth":"2-4 sentences",' +
      '"ticketYes":[string],' +
      '"ticketMaybe":[string],' +
      '"ticketSkip":[string],' +
      '"anchors":{"followed":[string],"likedDiverse":[string],"playlist":[string]},' +
      '"notes":"≤60 words"' +
      '}. Anchor arrays are real artist names from the inventory (not invented).',
    user:
      `Owner: ${ownerId}\n` +
      `Inventory counts: ${JSON.stringify(inventory.counts)}\n` +
      `Followed (all): ${inventory.followed.join(', ')}\n` +
      `Liked sample (capped weight, names): ${inventory.liked.slice(0, 120).map((x) => x.name).join(', ')}\n` +
      `Playlist sample: ${inventory.playlist.slice(0, 80).map((x) => x.name).join(', ')}\n` +
      feedbackBlock +
      `\nChunk analyses:\n${JSON.stringify(chunkResults, null, 2)}\n`,
  });
}

async function main() {
  const { ownerId } = parseArgs(process.argv);
  const apiKey = loadApiKey();
  const tastePath = path.join(tasteDir, `${ownerId}-taste.json`);
  if (!fs.existsSync(tastePath)) {
    throw new Error(`Missing ${tastePath} — run: npm run spotify:pull -- --owner ${ownerId}`);
  }
  const taste = JSON.parse(fs.readFileSync(tastePath, 'utf8'));
  const inventory = buildTasteInventory(taste);
  const ageDays = inventory.pulledAt
    ? (Date.now() - new Date(inventory.pulledAt).getTime()) / 86400000
    : null;
  if (ageDays != null && ageDays > 45) {
    console.warn(`Warning: taste pull is ${ageDays.toFixed(0)} days old — consider npm run spotify:pull`);
  }

  console.log(
    `Inventory ${ownerId}: followed=${inventory.counts.followed} liked=${inventory.counts.liked} playlist=${inventory.counts.playlist}`,
  );

  const starFeedback = ratingsForProfilePrompt(readActRatings(ownerId, tasteDir));

  // Chunks: followed (usually small), liked names, playlist names
  const chunkSpecs = [
    ...chunkNames(inventory.followed, 80).map((names, i) => ({ label: `followed-${i + 1}`, names })),
    ...chunkNames(inventory.liked.map((x) => x.name), 80).map((names, i) => ({ label: `liked-${i + 1}`, names })),
    ...chunkNames(inventory.playlist.map((x) => x.name), 80).map((names, i) => ({ label: `playlist-${i + 1}`, names })),
  ].slice(0, 12); // cost cap — still covers a wide net

  const chunkResults = [];
  for (const spec of chunkSpecs) {
    console.log(`Analyzing ${spec.label} (${spec.names.length} names)…`);
    try {
      const partial = await analyzeChunk({ apiKey, ownerId, label: spec.label, names: spec.names });
      chunkResults.push({ label: spec.label, ...partial });
    } catch (err) {
      console.warn(`Chunk ${spec.label} failed: ${err.message}`);
    }
  }
  if (!chunkResults.length) throw new Error('All profile chunks failed');

  console.log('Merging profile…');
  const merged = await mergeProfile({ apiKey, ownerId, inventory, chunkResults, starFeedback });

  const profile = {
    ownerId,
    builtAt: new Date().toISOString(),
    tastePulledAt: inventory.pulledAt,
    digestVersion: PROFILE_VERSION,
    likedTrackCap: inventory.likedTrackCap,
    counts: inventory.counts,
    breadth: String(merged.breadth || '').slice(0, 800),
    ticketYes: uniqStrings(merged.ticketYes, 24),
    ticketMaybe: uniqStrings(merged.ticketMaybe, 24),
    ticketSkip: uniqStrings(merged.ticketSkip, 24),
    anchors: {
      followed: uniqStrings(merged.anchors?.followed || inventory.followed.slice(0, 40), 40),
      likedDiverse: uniqStrings(
        merged.anchors?.likedDiverse || inventory.liked.slice(0, 60).map((x) => x.name),
        60,
      ),
      playlist: uniqStrings(
        merged.anchors?.playlist || inventory.playlist.slice(0, 40).map((x) => x.name),
        40,
      ),
    },
    suggestionFeedbackUsed: starFeedback.length,
    notes: String(merged.notes || '').slice(0, 400),
    model: MODEL,
    chunksAnalyzed: chunkResults.length,
  };

  const outPath = path.join(tasteDir, `${ownerId}-profile.json`);
  fs.mkdirSync(tasteDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath}`);
  console.log(`breadth: ${profile.breadth.slice(0, 160)}…`);
  console.log(`ticketYes (${profile.ticketYes.length}): ${profile.ticketYes.slice(0, 5).join('; ')}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
