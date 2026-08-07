# Spotify Taste Profile + Act Stars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Monthly/on-demand deep taste profile from full Spotify taste + act star ratings that override Claude; show scores use profile instead of a capped skim list.

**Architecture:** `spotify-taste-profile.mjs` builds `<owner>-profile.json` via chunked Claude over the full taste inventory (and prior star feedback). `spotify-act-ratings.mjs` stores 1–5 suggestion-quality stars. `spotify-likeness.mjs` scores via floors → profile-Claude; stars do not set the 0–100.

**Tech Stack:** Node ESM, Anthropic Messages API, existing `dashboard-server.mjs` / `dashboard_v5.html`, gitignored `data/spotify/*`.

**Spec:** `docs/superpowers/specs/2026-08-06-spotify-taste-profile-stars-design.md`

## Global Constraints

- Star map override removed — stars = suggestion quality feedback only (1=way off … 5=nailed it).
- Act-level suggestion ratings (not per show night); fed into next profile rebuild.
- Ranking still by ticket score only (floors / profile-Claude).
- K/H only on Shows UI; no Us column.
- Do not commit unless user asks.
- Do not hand-edit generated `data/data.js` / goal-plan md.

## File map

| File | Role |
|------|------|
| `scripts/spotify-taste-inventory.mjs` | Deterministic inventory from taste JSON |
| `scripts/spotify-taste-profile.mjs` | Chunked Claude → `<owner>-profile.json` |
| `scripts/spotify-act-ratings.mjs` | Read/write `<owner>-act-ratings.json` |
| `scripts/spotify-likeness.mjs` | Score priority + profile-Claude prompt |
| `scripts/dashboard-server.mjs` | `/api/act-ratings` GET/PUT |
| `dashboard_v5.html` | Star controls + profile callout |
| `package.json` | `spotify:profile` script |

---

### Task 1: Taste inventory builder

**Files:** Create `scripts/spotify-taste-inventory.mjs`

- [ ] Export `buildTasteInventory(taste, { likedTrackCap = 5 })` returning:
  - `followed: string[]` (all names, sorted)
  - `liked: { name, cappedCount, rawCount }[]` (all liked, cappedCount = min(raw, cap), sorted by capped then name)
  - `playlist: { name, cappedCount }[]` (similar, cap playlist track weight at 5)
  - `counts`, `ownerId`, `pulledAt`
- [ ] Smoke: `node -e "import ...; const t=...; console.log(inv.followed.length, inv.liked.length)"`

---

### Task 2: Profile builder CLI

**Files:** Create `scripts/spotify-taste-profile.mjs`; modify `package.json`

- [ ] Load taste, build inventory, chunk liked+playlist+followed into batches of ~80 names
- [ ] Per chunk: Claude returns JSON themes `{ticketYes[], ticketMaybe[], ticketSkip[], notes}`
- [ ] Final merge pass → full profile schema from spec
- [ ] Write `data/spotify/<owner>-profile.json`
- [ ] npm script `"spotify:profile": "node scripts/spotify-taste-profile.mjs"`
- [ ] Run once for kevin (needs API key)

---

### Task 3: Act ratings module + API

**Files:** Create `scripts/spotify-act-ratings.mjs`; modify `dashboard-server.mjs`

- [ ] `readActRatings(ownerId)`, `setActRating(ownerId, displayName, stars, note?)`, `starsToScore(stars)`
- [ ] Normalize keys via `normalizeArtistName`
- [ ] `GET /api/act-ratings?owner=kevin` → ratings JSON
- [ ] `PUT /api/act-ratings` body `{ owner, act, stars, note? }` → updated entry
- [ ] Validate stars 1–5 integer

---

### Task 4: Likeness uses profile (stars are feedback only)

**Files:** Modify `scripts/spotify-likeness.mjs`

- [ ] Priority per owner: exact floor → profile Claude → digest fallback → pending
- [ ] Load `<owner>-profile.json`; if missing, fall back to `buildTasteDigest`
- [ ] Profile Claude prompt uses profile fields + act/venue/date; cache includes `profileBuiltAt`
- [ ] Do **not** map stars → score
- [ ] Attach `suggestionStars` from ratings onto each show score object for UI (read-only for ranking)
- [ ] Rematch: `npm run spotify:match`

---

### Task 5: Dashboard star UI

**Files:** Modify `dashboard_v5.html`

- [ ] Under act: clickable 1–5 stars = “how good was this suggestion?” (not ticket score)
- [ ] PUT on click; show chip “suggestion N★” without changing K/H %
- [ ] Callout if profile missing: run `npm run spotify:profile`
- [ ] Keep K/H colors; no Us
- [ ] Syntax-check dashboard script; hard-refresh verify

---

## Spec coverage

| Requirement | Task |
|-------------|------|
| Full taste inventory (A) | 1 |
| Monthly/on-demand profile | 2 |
| Stars storage + API | 3 |
| Score priority floors→profile (stars feedback only) | 4 |
| Star UI (suggestion quality) | 5 |
| Cap per-artist weight | 1 + existing likeness |
