# Show likeness % — Kevin + Hanna (ticket night)

*Branch: `feature/spotify-show-matching`. Approved direction 2026-08-06: hybrid (C), optimistic household blend, horizontal score layout.*

## Goal

For each upcoming show, show a **0–100 “would buy tickets?”** score for **Kevin** and **Hanna**, plus an **Us** score for the night — including acts neither has streamed yet.

## Non-goals

- Spotify related-artists / recommendations / audio-features (blocked on this app)
- Genre fields from Spotify artist objects (empty in practice)
- Comedy-act taste (music-first; comedy stays venue-list driven)
- Replacing venue discovery — this only scores acts already in the shows cache

## Inputs

| Source | Role |
|--------|------|
| `data/spotify/<owner>-taste.json` | Intentional taste (followed / liked / playlist). Missing file = owner **unlinked**. |
| `data/upcoming_shows_cache.json` | Acts + venues + dates to score |
| `data/venues_to_follow.json` | Optional venue metadata (`area`, `category`) for live-night context |
| Anthropic (Haiku) | Score unknown acts when no Spotify name hit |
| `goals.owners` | Display names + owner ids |

## Scoring model (hybrid C)

### Per owner

1. **Exact taste hit (floor)** — same name-normalize matcher as today (`spotify-match.mjs`):
   - Follow → **floor 92**
   - Like → **floor 85**
   - Playlist → **floor 78**
   - If hit: use floor as the score (no Claude call for that owner). Optional small bump later; v1 = flat floors.

2. **No hit, owner linked** — Claude **ticket affinity** 0–100:
   - Prompt inputs: compact taste digest (≤40 followed + ≤40 strongest likes by track count), show `act`, `venue`, `date`, venue `area`/`category` if known, Westside preference note.
   - Instruct: score **willingness to buy tickets for a night out**, not “would play in headphones.” Penalize touristy/arena mismatch only lightly unless taste is clearly intimate-club.
   - Cache scores keyed by `ownerId|normalizedAct|venue|date` in `data/spotify/likeness-cache.json` (gitignored) so re-renders don’t re-spend tokens.

3. **Owner unlinked** — no numeric score; UI shows `—` (Hanna today).

### Household **Us** (optimistic)

Only over **linked** owners who have a numeric score:

```
Us = max(Kevin, Hanna)   // among linked+scored
```

- One linked → Us = that person’s score (caveat in UI: “Kevin only — Hanna not linked”).
- Both linked → Us = the higher score (either excited is enough).
- None linked → Us blank.

### Ranking

Sort shows by `Us` desc, then date, then act. Exact-hit floors naturally float known favorites up.

## Taste digest (for Claude)

Built once per pull (or on demand if missing):

```json
{
  "ownerId": "kevin",
  "followed": ["Artist", ...],      // up to 40
  "likedHeavy": [{"name": "...", "trackCount": 12}, ...],  // up to 40 by trackCount
  "pulledAt": "..."
}
```

Stored alongside taste as `data/spotify/<owner>-digest.json` (gitignored) or derived live from taste file — prefer **derive live** in v1 to avoid another stale artifact.

## API / dashboard

- Extend `/api/show-taste-matches` (or replace) to return per show:

```json
{
  "act": "...",
  "venue": "...",
  "date": "...",
  "scores": {
    "kevin": { "linked": true, "score": 82, "basis": "claude"|"follow"|"like"|"playlist", "label": "Like" },
    "hanna": { "linked": false, "score": null, "basis": null }
  },
  "us": { "score": 82, "mode": "optimistic", "coverage": "kevin-only"|"both" }
}
```

- Batch Claude: one request per **unique unlinked-miss act** per owner (not per show row duplicate); concurrency capped (e.g. 3).

## Layout (horizontal)

Use width; do **not** stack scores under act/venue.

```
[date]  Act name                     K 92   H —   Us 92    [Tickets]
        Venue · area
```

- Scores in a right-side column group (or mid column), monospace-ish numbers, small owner initials.
- Basis as tooltip (`Follow` / `Like` / `Playlist` / `Estimated`).
- Legend once at top of Shows tab.

## Failure modes

| Case | Behavior |
|------|----------|
| Anthropic down | Exact hits still score; unknowns show `?` not 0 |
| Rate limit | Serve cache; unknowns `?` |
| Act not found in Spotify search (for future id use) | Still Claude-score by name string |
| Cache corrupt | Ignore entry, rescore |

## Success criteria

- [ ] Known follow (e.g. Mumford if followed) shows high floor without Claude
- [ ] Unknown Troubadour act gets a 0–100 estimate for Kevin, `—` for Hanna
- [ ] Us = max of linked scores; copy notes when Hanna unlinked
- [ ] Scores sit beside the row, not under the venue line
- [ ] Re-render dashboard does not re-call Claude for cached acts
- [ ] Hanna link later: drop in `hanna-taste.json` → scores appear without UI rewrite

## Follow-ups (later)

- Soft bump when both hit exact taste
- Venue-distance / Westside multiplier as explicit math instead of prompt-only
- Hanna auth + pull
