#!/usr/bin/env node
// Runs every data/test-*.mjs suite in its own process and reports a summary.
//
// Exists because there was no `npm test` at all: the suites were listed in
// AGENTS.md as individual `node data/test-*.mjs` invocations, and CI ran two of
// them. That is how a test asserting a bug was correct sat green — nothing ran
// it. One command, one exit code, every suite.
//
// Each suite runs in a separate process so a crash or a stray process.exit() in
// one can't take down the run or silently skip the rest.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', 'data');

const suites = fs.readdirSync(dataDir)
  .filter((f) => /^test-.*\.mjs$/.test(f))
  .sort();

if (!suites.length) {
  console.error('No test suites found in data/.');
  process.exit(1);
}

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const selected = only.length
  ? suites.filter((s) => only.some((pattern) => s.includes(pattern)))
  : suites;

if (!selected.length) {
  console.error(`No suites matched: ${only.join(', ')}`);
  process.exit(1);
}

const failed = [];
const started = Date.now();

for (const suite of selected) {
  const result = spawnSync(process.execPath, [path.join(dataDir, suite)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) failed.push(suite);
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(`\n${'='.repeat(60)}`);
console.log(`${selected.length - failed.length}/${selected.length} suites passed in ${seconds}s`);
if (failed.length) {
  console.log('\nFAILED:');
  for (const f of failed) console.log(`  - ${f}`);
  process.exit(1);
}
console.log('All suites passed.');
