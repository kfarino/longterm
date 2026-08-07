#!/usr/bin/env node
// Score upcoming shows with hybrid likeness % (floors + Claude).
// Writes data/spotify/show-matches-latest.json (gitignored) and prints a summary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scoreShowsLikeness } from './spotify-likeness.mjs';
import { parseShowsFromText, dedupeShows } from './show-parse.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tasteDir = path.join(repoRoot, 'data', 'spotify');
const cachePath = path.join(repoRoot, 'data', 'upcoming_shows_cache.json');
const samplePath = path.join(tasteDir, 'sample-shows.json');
const outPath = path.join(tasteDir, 'show-matches-latest.json');

function loadOwnerIds() {
  const goalsPath = path.join(repoRoot, 'data', 'goals.json');
  if (fs.existsSync(goalsPath)) {
    const goals = JSON.parse(fs.readFileSync(goalsPath, 'utf8'));
    const ids = (goals.owners || []).map((o) => o.id).filter(Boolean);
    if (ids.length) return ids;
  }
  return ['kevin', 'hanna'];
}

function loadShows() {
  if (fs.existsSync(cachePath)) {
    const cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
    if (Array.isArray(cache.shows) && cache.shows.length) return cache.shows;
    const fromFindings = [];
    for (const f of cache.findings || []) {
      if (Array.isArray(f.shows)) {
        for (const s of f.shows) fromFindings.push({ ...s, label: f.label || s.label });
      } else if (f.text) {
        for (const s of parseShowsFromText(f.text, f.urls)) {
          fromFindings.push({ ...s, label: f.label || null });
        }
      }
    }
    if (fromFindings.length) return dedupeShows(fromFindings);
  }
  if (fs.existsSync(samplePath)) {
    console.warn(`No live shows in cache — falling back to ${samplePath}`);
    const sample = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
    return sample.shows || [];
  }
  return [];
}

async function main() {
  const skipClaude = process.argv.includes('--skip-claude');
  const ownerIds = loadOwnerIds();
  const shows = loadShows();
  const payload = await scoreShowsLikeness({
    shows,
    ownerIds,
    tasteDir,
    skipClaude,
  });

  fs.mkdirSync(tasteDir, { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${outPath} (${payload.shows.length} shows)`);
  for (const id of ownerIds) {
    const s = payload.owners[id];
    console.log(`  ${id}: ${s?.connected ? `taste ok (${s.artists} artists)` : 'not connected'}`);
  }
  for (const s of payload.shows) {
    const bits = ownerIds.map((id) => {
      const m = s.scores?.[id];
      if (!m?.linked) return `${id}:—`;
      if (m.score == null) return `${id}:?`;
      return `${id}:${m.score}`;
    });
    const us = s.us?.score == null ? '—' : s.us.score;
    console.log(`  [Us ${us}] ${s.date} ${s.act} @ ${s.venue || '?'}  ${bits.join(' ')}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
