# Weekly auto-updating Spotify playlist from taste-matched shows

*Approved 2026-08-07 — a private Spotify playlist, under Kevin's account, rebuilt every week from `show-matches-latest.json`'s genuinely taste-matched upcoming LA music shows.*

## Goal

Turn "shows the dashboard is recommending" into something listenable: a playlist Kevin can put on to sample the artists behind this week's recommended shows, refreshed automatically alongside the existing weekly shows pull.

## Non-goals

- **Hanna's account.** Her Spotify isn't currently connected (`connected: false` in the live match data) and this feature is scoped to Kevin's account only, per explicit decision. Nothing here blocks adding a second playlist for her later — the script takes an owner id, just always invoked with `kevin` for now.
- **Comedy shows.** `kind: 'comedy'` entries have no Spotify-track equivalent.
- **Historical/accumulating playlist.** Every run replaces the tracklist wholesale — see Refresh mechanics.
- **Manual curation UI.** No dashboard control to edit the auto-built playlist; it's a fully automated, hands-off refresh.

## Data source and filtering

Reads `data/spotify/show-matches-latest.json`'s `shows[]` — already fresh from the weekly pull's third step (`spotify:match`), no new data collection needed. A show qualifies when:

- `kind === 'music'` (comedy acts excluded — no track equivalent)
- `scores.kevin.basis !== 'claude'` — excludes LLM-guessed recommendations, keeping only shows backed by a genuine signal from Kevin's own Spotify library (`like`, `follow`, or `playlist`). Verified against live data: the current 9 music shows range from score 97 down to 18, and every score below 84 has `basis: 'claude'` — a raw score cutoff would be arbitrary where this distinction is principled. On today's data this keeps 5 qualifying shows.

**Artists are deduplicated before track resolution** — JAŸ-Z currently appears twice in `shows[]` (two different tour dates), and must contribute tracks to the playlist only once.

## Track resolution

For each deduplicated qualifying artist: a direct track search, `GET /search?type=track&q=artist:"<name>"`, taking the top 3 returned track URIs. Public catalog data — works with any valid access token, no extra scope.

**Revised during implementation** from the originally planned search-for-artist-id-then-`GET /artists/{id}/top-tracks`: verified live (2026-08-07) that `top-tracks` returns `403 Forbidden` on this app's Spotify registration, while `/me`, `/search`, and `/artists/{id}` (basic metadata) all work fine. This is very likely the same app-tier restriction the design already anticipated for related-artists/recommendations (see the 2026-08-05 spec's non-goals), just extending to `top-tracks` as well. Direct track search uses only the already-proven-working `/search` endpoint, needs one API call instead of two, and Spotify's own relevance ranking puts an artist's well-known songs first — same practical outcome. Verified end-to-end against real data: 3 of 4 real qualifying artists resolved cleanly; the fourth (`"Santana & The Doobie Brothers"`, a co-headline tour billing rather than a real Spotify artist name) correctly hit the no-match path and was skipped, not treated as a failure.

An artist with no confident search match (no results, or a co-billing/tour-name that isn't a real Spotify artist) is **skipped, not fatal** — that week's playlist just has fewer tracks, logged, not thrown. A total show-to-track yield of zero (every artist unmatched) is not treated as an error either; see Refresh mechanics.

## Auth: new write scope required

Current granted scopes (`spotify-client.mjs`'s `SPOTIFY_SCOPES`) are read-only: `user-follow-read user-library-read playlist-read-private playlist-read-collaborative`. This feature needs `playlist-modify-private` added to that constant, which existing tokens do not have — **Kevin must re-run `npm run spotify:auth -- --owner kevin` to re-consent** before this feature can go live. This is a manual step outside this implementation; the plan documents it as a rollout prerequisite, not something the code can do on his behalf.

## Playlist mechanics

- New script: `scripts/spotify-playlist-shows.mjs`, invoked as `npm run spotify:update-show-playlist`.
- **First run**: creates a private playlist under Kevin's account (`POST /users/{user_id}/playlists`, `public: false`), named `LA Shows — This Week`, with the description `Auto-updated weekly from taste-matched upcoming LA shows — see the Dining + Shows tab.` Its id is saved to `data/spotify/show-playlist-state.json` (gitignored, matches this project's existing state-file convention).
- **Every subsequent run**: reads the saved playlist id, replaces its entire tracklist in one call — `PUT /playlists/{id}/tracks` with the week's resolved track URIs. This is genuinely "replace entirely": Spotify's replace endpoint clears and resets in a single request, no separate remove-then-add needed. An empty qualifying-shows week PUTs an empty tracklist — the playlist goes empty rather than serving stale tracks, which is the honest behavior given "replace entirely" was the explicit choice.
- If the saved state file references a playlist id that no longer exists (deleted manually via the Spotify app, for instance), a 404 on the PUT triggers falling back to first-run behavior — create a new one, save the new id.

## Wiring into the weekly pull

`run-weekly-shows-pull.ps1` gains a fourth step, after `spotify:match` (needs its fresh output) and gated the same way the other three steps already are — this step failing never fails the three before it, and a `-SkipPlaylist` switch is added alongside the existing `-SkipFindShows`/`-SkipVenuePull`/`-SkipMatch` for manual reruns.

## Error handling

- A missing or expired write-scope token **fails loudly** — this is the one case that should stop the step rather than degrade quietly, since a silent no-op would look identical to "nothing changed this week" when actually the whole feature is dark.
- Any single artist's search/top-tracks lookup failing is logged and skipped, never fatal to the run.
- The playlist-id-gone-404 case falls back to recreate, as above, rather than failing.

## Testing

Every Spotify API call goes through an injectable client (mirroring `spotifyGet`'s existing shape and every other script in this codebase) — no real network calls in the test suite. Covers: the `kind`/`basis` filter against realistic fixture data, artist deduplication, first-run playlist creation vs. subsequent-run replace, an unmatched artist being skipped without failing the run, and the 404-triggers-recreate fallback.
