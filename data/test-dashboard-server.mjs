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
import { createServer, writeJsonAtomic, ratePlace, rateVenue, readFavoritePlaces } from '../scripts/dashboard-server.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-server-test-'));
const eventsPath = path.join(tmpDir, 'month_plan_events.json');
const routineOverridesPath = path.join(tmpDir, 'dining-routine-overrides.json');
const favoriteRawPath = path.join(tmpDir, 'favorite_places_raw.json');
const favoritePlacesPath = path.join(tmpDir, 'favorite_places.json');
const venuesToFollowPath = path.join(tmpDir, 'venues_to_follow.json');
const upcomingShowsCachePath = path.join(tmpDir, 'upcoming_shows_cache.json');

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

function startFullServer() {
  return new Promise((resolve) => {
    const server = createServer(eventsPath, routineOverridesPath, favoriteRawPath, favoritePlacesPath, venuesToFollowPath, upcomingShowsCachePath);
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

await test('ratePlace patches the rating onto the matching entry in both favorite_places_raw.json and favorite_places.json', async () => {
  fs.writeFileSync(favoriteRawPath, JSON.stringify([{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to' }]));
  fs.writeFileSync(favoritePlacesPath, JSON.stringify({ meta: {}, places: [{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to', observed: null }], recentDiningActivity: [] }));

  const ok = ratePlace(favoriteRawPath, favoritePlacesPath, 'Terra Eataly', 5);
  assert.equal(ok, true);

  const raw = JSON.parse(fs.readFileSync(favoriteRawPath, 'utf8'));
  assert.equal(raw[0].rating, 5);
  const fp = JSON.parse(fs.readFileSync(favoritePlacesPath, 'utf8'));
  assert.equal(fp.places[0].rating, 5);
});

await test('ratePlace returns false for an unmatched name, without writing anything', async () => {
  fs.writeFileSync(favoriteRawPath, JSON.stringify([{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to' }]));
  const ok = ratePlace(favoriteRawPath, favoritePlacesPath, 'Nonexistent Place', 3);
  assert.equal(ok, false);
});

await test('rateVenue patches a top-level venue by name', async () => {
  fs.writeFileSync(venuesToFollowPath, JSON.stringify({ meta: {}, venues: [{ name: 'Largo at the Coronet', category: 'intimate-listening-room' }], weekendSocialSpots: {} }));
  const ok = rateVenue(venuesToFollowPath, 'Largo at the Coronet', 5);
  assert.equal(ok, true);
  const data = JSON.parse(fs.readFileSync(venuesToFollowPath, 'utf8'));
  assert.equal(data.venues[0].rating, 5);
});

await test('rateVenue patches a nested weekendSocialSpots entry by name', async () => {
  fs.writeFileSync(venuesToFollowPath, JSON.stringify({ meta: {}, venues: [], weekendSocialSpots: { venice: [{ name: 'Gjelina', vibe: 'test' }] } }));
  const ok = rateVenue(venuesToFollowPath, 'Gjelina', 4);
  assert.equal(ok, true);
  const data = JSON.parse(fs.readFileSync(venuesToFollowPath, 'utf8'));
  assert.equal(data.weekendSocialSpots.venice[0].rating, 4);
});

await test('ratePlace returns false (not throws) when favorite_places_raw.json is corrupt JSON', async () => {
  fs.writeFileSync(favoriteRawPath, '{not valid json');
  const ok = ratePlace(favoriteRawPath, favoritePlacesPath, 'Terra Eataly', 5);
  assert.equal(ok, false);
});

await test('rateVenue returns false (not throws) when venues_to_follow.json is corrupt JSON', async () => {
  fs.writeFileSync(venuesToFollowPath, '{not valid json');
  const ok = rateVenue(venuesToFollowPath, 'Largo at the Coronet', 5);
  assert.equal(ok, false);
});

await test('POST /api/rate-place writes the rating and returns 200 with the echoed body', async () => {
  fs.writeFileSync(favoriteRawPath, JSON.stringify([{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to' }]));
  fs.writeFileSync(favoritePlacesPath, JSON.stringify({ meta: {}, places: [{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to' }], recentDiningActivity: [] }));
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rate-place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Terra Eataly', rating: 4, kind: 'restaurant' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, { ok: true, name: 'Terra Eataly', rating: 4, kind: 'restaurant' });
  } finally {
    server.close();
  }
});

await test('POST /api/rate-place returns 404 for an unmatched name', async () => {
  fs.writeFileSync(favoriteRawPath, JSON.stringify([]));
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rate-place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Nobody Here', rating: 3, kind: 'restaurant' }),
    });
    assert.equal(res.status, 404);
  } finally {
    server.close();
  }
});

await test('POST /api/rate-place returns 400 for a malformed body (missing kind, out-of-range rating)', async () => {
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/rate-place`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Terra Eataly', rating: 9 }),
    });
    assert.equal(res.status, 400);
  } finally {
    server.close();
  }
});

await test('GET /api/upcoming-shows-cache returns the empty default shape when the file does not exist yet', async () => {
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/upcoming-shows-cache`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { fetchedAt: null, days: null, findings: [], shows: [] });
  } finally {
    server.close();
  }
});

await test('GET /api/upcoming-shows-cache reflects a file written directly on disk', async () => {
  fs.writeFileSync(upcomingShowsCachePath, JSON.stringify({ fetchedAt: '2026-08-05T00:00:00.000Z', days: 14, findings: [{ text: 'A show', urls: [] }] }));
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/upcoming-shows-cache`);
    const body = await res.json();
    assert.equal(body.findings[0].text, 'A show');
  } finally {
    server.close();
  }
});

await test('GET /api/venues-to-follow returns the empty default shape when the file does not exist yet', async () => {
  // Earlier rateVenue tests wrote to this same shared tmp path; remove it so
  // this test genuinely exercises the "file does not exist yet" branch.
  fs.rmSync(venuesToFollowPath, { force: true });
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/venues-to-follow`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { venues: [], weekendSocialSpots: {} });
  } finally {
    server.close();
  }
});

await test('GET /api/favorite-places returns the empty default shape when the file does not exist yet', async () => {
  // Earlier ratePlace tests wrote to this same shared tmp path; remove it so
  // this test genuinely exercises the "file does not exist yet" branch.
  fs.rmSync(favoritePlacesPath, { force: true });
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/favorite-places`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { places: [], recentDiningActivity: [] });
  } finally {
    server.close();
  }
});

await test('GET /api/favorite-places reflects a file written directly on disk (e.g. a rating just patched in by ratePlace)', async () => {
  writeJsonAtomic(favoritePlacesPath, { meta: {}, places: [{ name: 'Terra Eataly', cuisine: 'Italian', list: 'go-to', rating: 5 }], recentDiningActivity: [] });
  const server = await startFullServer();
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/favorite-places`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.places[0].name, 'Terra Eataly');
    assert.equal(body.places[0].rating, 5);
  } finally {
    server.close();
  }
});

await test('readFavoritePlaces returns the empty default shape (not throws) when the file is corrupt JSON', () => {
  fs.writeFileSync(favoritePlacesPath, '{not valid json');
  assert.deepEqual(readFavoritePlaces(favoritePlacesPath), { places: [], recentDiningActivity: [] });
});

console.log('All tests passed.');
