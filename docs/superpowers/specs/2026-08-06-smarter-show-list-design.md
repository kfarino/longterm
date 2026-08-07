# Smarter show list — wide net, best-match first

*Branch: `feature/spotify-show-matching`. Approved 2026-08-06: Option 1 (score-then-cut), K/H only (no Us column), owner colors consistent across the app.*

## Goal

Cast a **wide net** for upcoming LA shows, then show Kevin the ones he (and Hanna, when linked) are **most likely to enjoy** — not a raw Troubadour calendar dump.

## Non-goals

- Venue quotas as the primary filter (Troubadour can still win if the act scores)
- Dual “best” + “also at venues” lists
- Changing likeness floors / Claude ticket prompt (already shipped)
- Comedy-specific taste model (venue discovery still includes comedy venues; scoring stays music-first)

## Product rules

1. **Discover wide** — venue pull + Spotify artist-follow pull both feed the candidate pool (union, deduped by act|venue|date).
2. **Score everyone** — existing hybrid likeness (`spotify-likeness.mjs`): floors then Claude; cache as today.
3. **Lead with fit** — rank by `max(Kevin, Hanna)` among linked numeric scores (same math as former Us, but **not displayed**).
4. **Short list** — Shows tab shows **top 15** after ranking. Rest stay in cache / match file but are not rendered.
5. **Columns** — **K** and **H** only. Unlinked → `—`. No Us column, no “optimistic max” footnote.

## Owner color (app-wide)

Reuse the Planner todo convention as **stable identity colors** (by `owner.id`, not list index):

| Owner | Token | Hex | Use |
|-------|--------|-----|-----|
| Kevin | `--blue` / `--p1` | `#1e4d8c` | K label + score number; Kevin todo chip |
| Hanna | `--p5` | `#4a3070` | H label + score number; Hanna todo chip |

- Drop score-magnitude colors (green/mid blue) on show % numbers — they fight owner identity.
- Muted/`—` for unlinked or pending stays `var(--sub)`.
- Basis line under the number (`follow` / `like` / `list` / `est.`) stays muted gray.
- Apply the same id→color helper anywhere owner chips appear (Planner todos first; Shows scores).

## Discovery changes (wide net)

### Venue pull (`upcoming-shows-pull.mjs` / bot `get_upcoming_shows`)

- Prompt: search **across the full follow list**, not “whatever is easy to find.” Explicit: do not dump one venue’s whole calendar; prefer **at most 2–3 notable acts per venue**, then move on so westside / comedy / larger rooms get coverage.
- Prefer structured lines (act — venue — date — URL) so the cache can store a real `shows[]` array (same parser path as Spotify find).
- Day window: keep configurable; default stays ~21 for venues, ~60 for Spotify artists (existing).

### Spotify pull (`spotify-find-shows.mjs`)

- Unchanged intent (followed artists → LA dates). Ensure its structured `shows` merge into the same pool the tab ranks.

### Merge

- Single ranked candidate list for scoring: union of venue + Spotify findings, dedupe, then likeness, then top 15 for UI.

## API / dashboard

- `/api/show-taste-matches` continues to return full scored list (or optionally `?limit=15`); dashboard **always** slices to top 15 by `max(K,H)` for display.
- Response may still include internal `us` for sort/debug; UI does not render it.
- Callout copy: ticket fit · Kevin blue / Hanna purple · Follow/Like/List / est. — no Us language.

## Layout (Shows rows)

```
[date]  Act                          K ##    H ##     Tickets
        Venue                        follow  — 
```

- Two score columns (not three). Grid tightens accordingly.
- Sort: best max(K,H) first within the shortlist (single list preferred over “Spotify follows” / “Followed venues” section split if that buries high scores — **collapse to one ranked list** labeled by count, e.g. “Best matches · 15”).

## Success criteria

- Troubadour no longer dominates by volume alone.
- Mumford-class / high floors appear near the top.
- Hanna column `—` until linked, in Hanna purple chrome when linked.
- Kevin/Hanna colors match Planner todo chips.
- Hard-refresh Shows tab: ≤15 rows, K/H only, sorted by fit.

## Claude sales pitch (added 2026-08-06)

Alongside `score` + short `reason`, Claude returns `pitch`: 1–2 sentences (≤40 words) selling (or honestly declining) the night for that person, tied to taste.

- Exact Spotify floors get a short template pitch (follow / like / playlist).
- Show row displays **one** pitch: from the highest-scoring linked owner.
- Likeness cache entries without `pitch` are treated as stale and re-scored.

## Out of scope for this change

- Linking Hanna’s Spotify
- Raising Claude concurrency / batch prompt redesign
- Changing venue follow list membership
