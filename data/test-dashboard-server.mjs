// Longterm/data/test-dashboard-server.mjs
//
// Permanent regression test (NOT a temp task script — do not delete). Covers
// dashboard-server.mjs's real HTTP + filesystem behavior — the fake-fetch
// double used in test-dashboard-contract.mjs never exercises this file's
// actual code, so this test starts a real server against a real temp file.
// Run with:
//   node Longterm/data/test-dashboard-server.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, writeJsonAtomic } from '../scripts/dashboard-server.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-server-test-'));
const eventsPath = path.join(tmpDir, 'month_plan_events.json');
const routineOverridesPath = path.join(tmpDir, 'dining-routine-overrides.json');

async function test(name, fn) {
  await fn();
  console.log(`  ok - ${name}`);
}

function startServer() {
  return new Promise((resolve) => {
    const server = createServer(eventsPath, routineOverridesPath);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

console.log('test-dashboard-server.mjs');

await test('GET returns {events:{}} when the file does not exist yet', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/month-plan-events`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { events: {} });
  } finally {
    server.close();
  }
});

await test('GET reflects a file written directly on disk (dashboard reads month_plan_events.json, never writes it)', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    writeJsonAtomic(eventsPath, { events: { '2026-08-05': [{ name: 'Great White', tier: 'high' }] } });
    const res = await fetch(`http://127.0.0.1:${port}/api/month-plan-events`);
    const body = await res.json();
    assert.deepEqual(body, { events: { '2026-08-05': [{ name: 'Great White', tier: 'high' }] } });
  } finally {
    server.close();
  }
});

await test('PUT is not a supported method on /api/month-plan-events (dashboard is read-only; the bot writes the file directly)', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/month-plan-events`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events: {} }),
    });
    assert.equal(res.status, 405);
  } finally {
    server.close();
  }
});

await test('GET /api/dining-routine-overrides returns all-null defaults when the file does not exist yet', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/dining-routine-overrides`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { family_dinner: null, date_night: null, weekend_social: null });
  } finally {
    server.close();
  }
});

await test('GET /api/dining-routine-overrides reflects a bot-written override file', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    writeJsonAtomic(routineOverridesPath, { family_dinner: 4, date_night: null, weekend_social: null });
    const res = await fetch(`http://127.0.0.1:${port}/api/dining-routine-overrides`);
    assert.deepEqual(await res.json(), { family_dinner: 4, date_night: null, weekend_social: null });
  } finally {
    server.close();
  }
});

await test('serves dashboard_v5.html statically and blocks path traversal', async () => {
  const server = await startServer();
  const port = server.address().port;
  try {
    const pageRes = await fetch(`http://127.0.0.1:${port}/dashboard_v5.html`);
    assert.equal(pageRes.status, 200);
    assert.ok((await pageRes.text()).includes('<!DOCTYPE html>'));

    const traversalRes = await fetch(`http://127.0.0.1:${port}/${encodeURIComponent('../../../../etc/passwd')}`);
    assert.notEqual(traversalRes.status, 200, 'a path-traversal attempt should not succeed');
  } finally {
    server.close();
  }
});

console.log('All tests passed.');
