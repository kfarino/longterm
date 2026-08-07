# Deep Spotify taste profile + act star ratings

*Branch: `feature/spotify-show-matching`. Approved 2026-08-06: Approach 1 — monthly deep profile from full follows/likes/playlists (option A data); show scores use the profile; user stars (1–5) rate **suggestion quality** (feedback into the next profile), not a ticket-score override. Clarified 2026-08-06 evening.*

## Goal

Stop ranking shows from a shallow capped name-list. Build a **thorough taste profile** from all Spotify taste we already pull, refresh it on a schedule, score shows against that profile, and let Kevin/Hanna **star how good our suggestion was** after they listen — feedback for the next profile, not a hard score override.

## Non-goals

- Spotify recently-played / top-artists / audio-features (blocked or out of scope for v1 — option A only)
- Replacing venue/artist discovery pulls
- Comedy-specific taste model
- Requiring stars before any scores appear (scores always from floors/profile)

## Data we already have (input)

`data/spotify/<owner>-taste.json` from `spotify-pull.mjs`:

- Followed artists
- Liked-song artists (with track counts — **capped for ranking weight**, not discarded)
- Playlist artists (with track counts)

Kevin today: ~2.7k unique artists across those sources. Hanna when linked: same shape.

## Taste profile (monthly / on-demand)

### Job

`scripts/spotify-taste-profile.mjs` (npm: `spotify:profile`)

1. Load `<owner>-taste.json` (require fresh-ish pull; warn if older than ~45 days).
2. Build a **structured inventory** (deterministic, no LLM):
   - Followed list (full)
   - Liked artists with **per-artist track cap** (same `LIKED_TRACK_CAP = 5`) so volume ≠ dominance
   - Playlist artists (capped weight)
   - Overlap sets (followed∩liked, etc.)
   - Coarse buckets by source mix only (no fake genres from empty Spotify genre fields)
3. Send inventory to Claude in **chunks** if needed (map-reduce): each chunk returns partial themes; a final pass merges into one profile.
4. Write `data/spotify/<owner>-profile.json` (gitignored under `data/spotify/*`).

### Profile schema (v1)

```json
{
  "ownerId": "kevin",
  "builtAt": "ISO",
  "tastePulledAt": "ISO",
  "digestVersion": 1,
  "breadth": "short paragraph — eclectic / what not to over-index",
  "ticketYes": ["vibes or artist archetypes they'd buy tickets for"],
  "ticketMaybe": ["..."],
  "ticketSkip": ["anti-patterns"],
  "anchors": {
    "followed": ["up to ~40 name anchors that define taste"],
    "likedDiverse": ["up to ~60 capped liked names — set not chart"],
    "playlist": ["up to ~40"]
  },
  "notes": "optional freeform from Claude",
  "model": "claude-…"
}
```

Profile is **narrative + anchors**, not a fake 0–100 per artist for the whole catalog.

### Cadence

- **On demand:** `npm run spotify:profile -- --owner kevin`
- **Monthly:** scheduled task (same pattern as other Longterm pulls) or documented manual first; wire task in a follow-up if not in this PR
- Rebuild after a fresh `spotify:pull` when the user asks

## Act star ratings (suggestion quality feedback)

Stars are **not** a score override. They measure how well **our suggestion** (score + pitch) matched reality after Kevin/Hanna listen / consider the act.

### Storage

`data/spotify/<owner>-act-ratings.json` (gitignored):

```json
{
  "ownerId": "kevin",
  "updatedAt": "ISO",
  "acts": {
    "<normalized act name>": {
      "displayName": "Anthony Green",
      "stars": 4,
      "ratedAt": "ISO",
      "note": "optional — e.g. pitch was right / wrong vibe"
    }
  }
}
```

- **Scope:** feedback on the **act suggestion** (same act across dates)
- 1 = suggestion was way off · 5 = suggestion nailed it
- Does **not** replace floors / profile-Claude ticket scores
- Fed into the next **profile rebuild** (and optionally shown as a small “you rated this suggestion N★” chip) so Claude learns where it was wrong

### Show scoring (unchanged ownership)

1. Exact Spotify name hit → floors + template pitch  
2. Else profile-Claude (or digest fallback) → score + sales pitch  
3. Stars sit **beside** the score as feedback — they do not set the 0–100

### UI / API

- Star control on each show row (per linked owner)
- `GET/PUT /api/act-ratings` as before
- Ranking / top-15 still by ticket score `max(K,H)` only

## Ranking / display (unchanged product rules)

- Lead with best matches: sort by `max(K,H)` among linked scores  
- Top ~15 on the tab  
- **K and H only** (no Us column)  
- Owner colors: Kevin blue / Hanna purple  
- Wide discovery net stays separate from scoring quality  

## Pipeline

```
spotify:pull          → <owner>-taste.json
spotify:profile       → <owner>-profile.json   (monthly / on demand)
spotify:find-shows + shows:pull → upcoming_shows_cache.json
scoreShowsLikeness    → floors | profile-Claude   (stars = feedback only)
dashboard Shows tab   → top 15 + pitches + suggestion-star controls
```

## Success criteria

- Claude show scoring no longer receives a raw “Drake 142 / Kanye …” style volume list  
- Profile built from full taste inventory (chunked), readable in gitignored JSON  
- Starring an act records suggestion quality; ticket % still comes from floors/profile-Claude  
- Unrated acts still get profile-based estimates  
- Hanna unlinked → H `—`; her ratings file unused until linked  

## Out of scope / later

- Monthly Windows scheduled task install script (document command first; automate if Kevin wants)  
- Telegram “rate this act”  
- Recently-played enrichment (option B)  
