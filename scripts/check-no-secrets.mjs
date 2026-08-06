#!/usr/bin/env node
// Fail CI / pre-push if tracked files look like household secrets or money data.
// Does not scan untracked local data/ — only what git already tracks or would commit.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Paths that must never appear in `git ls-files` (basename or repo-relative). */
const FORBIDDEN_TRACKED = [
  /^data\/goals\.json$/i,
  /^data\/accounts\.json$/i,
  /^data\/budget_tracking\.json$/i,
  /^data\/data\.js$/i,
  /^data\/transactions_ledger\.json$/i,
  /^data\/transaction_overrides\.json$/i,
  /^data\/todos\.json$/i,
  /^data\/month_plan_events\.json$/i,
  /^data\/favorite_places.*\.json$/i,
  /^data\/venues_to_follow\.json$/i,
  /^data\/telegram-/i,
  /^data\/reminders\.json$/i,
  /^data\/goals-changelog\.jsonl$/i,
  /^data\/calendar-sync-state\.json$/i,
  /^data\/dining-routine-overrides\.json$/i,
  /^data\/upcoming_shows_cache\.json$/i,
  /kevin_hanna_goal_plan\.md$/i,
  /-goal_plan\.md$/i,
  /^budget_ledger\.csv$/i,
  /\.env$/i,
  /monarch\.env$/i,
  /telegram\.env$/i,
  /google-calendar\.env$/i,
  /oura-.*\.env$/i,
  /spotify-.*\.env$/i,
  /finance\.db$/i,
  /config\.json$/i,
];

/** Content patterns: real-looking secrets only (docs may show placeholders). */
const FORBIDDEN_CONTENT = [
  {
    re: /MONARCH_PASSWORD\s*=\s*(?!their-password\b|your[_-]|<|>|\.{2,}|\s*$)[^\s"'`]+/i,
    label: 'MONARCH_PASSWORD with non-placeholder value',
  },
  {
    re: /TELEGRAM_BOT_TOKEN\s*=\s*\d{6,}:[A-Za-z0-9_-]{20,}/,
    label: 'TELEGRAM_BOT_TOKEN that looks like a real bot token',
  },
  {
    re: /ANTHROPIC_API_KEY\s*=\s*sk-[a-zA-Z0-9_-]{20,}/,
    label: 'ANTHROPIC_API_KEY literal',
  },
  { re: /BEGIN (RSA |OPENSSH )?PRIVATE KEY/, label: 'private key block' },
  {
    re: /https:\/\/[^/\s:]+:[^/\s@]+@bridge\.simplefin\.org\//i,
    label: 'SimpleFIN access URL with embedded credentials',
  },
];

const CONTENT_SCAN_EXTENSIONS = new Set(['.mjs', '.js', '.ts', '.json', '.md', '.html', '.ps1', '.yml', '.yaml', '.env', '.txt', '.csv']);

function gitLsFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'buffer' });
  if (r.status !== 0) {
    console.error(r.stderr?.toString() || 'git ls-files failed');
    process.exit(2);
  }
  const out = r.stdout.toString('utf8');
  return out ? out.split('\0').filter(Boolean) : [];
}

function main() {
  const tracked = gitLsFiles();
  const pathHits = [];
  for (const file of tracked) {
    const norm = file.replace(/\\/g, '/');
    for (const re of FORBIDDEN_TRACKED) {
      if (re.test(norm)) pathHits.push(norm);
    }
  }

  const contentHits = [];
  for (const file of tracked) {
    const norm = file.replace(/\\/g, '/');
    if (norm === 'scripts/check-no-secrets.mjs') continue;
    const ext = path.extname(norm);
    if (!CONTENT_SCAN_EXTENSIONS.has(ext) && !norm.endsWith('Dockerfile')) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
    } catch {
      continue;
    }
    // Skip huge generated-looking blobs
    if (text.length > 1_500_000) continue;
    for (const { re, label } of FORBIDDEN_CONTENT) {
      if (re.test(text)) contentHits.push(`${norm}: ${label}`);
    }
  }

  if (pathHits.length || contentHits.length) {
    console.error('check-no-secrets: refusing to proceed — household secrets/data must not be tracked.\n');
    if (pathHits.length) {
      console.error('Forbidden tracked paths:');
      for (const p of pathHits) console.error(`  - ${p}`);
    }
    if (contentHits.length) {
      console.error('Forbidden content in tracked files:');
      for (const p of contentHits) console.error(`  - ${p}`);
    }
    console.error('\nSee AGENTS.md §0 and SECURITY.md. Unstage with: git rm --cached <path>');
    process.exit(1);
  }

  console.log(`check-no-secrets: ok (${tracked.length} tracked files scanned)`);
}

main();
