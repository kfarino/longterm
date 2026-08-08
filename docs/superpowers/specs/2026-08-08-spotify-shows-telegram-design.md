# Weekly show recommendations via Telegram (supersedes the auto-playlist design)

*Approved 2026-08-08 — replaces `docs/superpowers/specs/2026-08-07-spotify-shows-playlist-design.md`, whose core mechanism (an app auto-writing to a Spotify playlist) is permanently blocked by Spotify policy, discovered live during implementation. This spec keeps everything from that work that's still valid and replaces only the delivery mechanism.*

## Why the original design is dead, not just delayed

The original design built and tested `scripts/spotify-playlist-shows.mjs`: filter taste-matched shows → resolve tracks → create/replace a private Spotify playlist via the Web API. It shipped, Kevin re-consented with the new `playlist-modify-private` scope, and the actual write call still returned `403 Forbidden`. Root cause, confirmed via web research: **Spotify locked down all playlist-write access for "Development Mode" apps** — new app registrations Feb 11 2026, existing apps migrated March 9 2026. The replacement tier, Extended Quota Mode, now requires a registered organization with 250,000+ monthly active users. There is no path for a personal household app to ever write a Spotify playlist via the API again. This is a platform policy wall, not a bug — no scope, retry, or code change fixes it.

**Delete, don't leave inert:** `ensurePlaylist`, `replacePlaylistTracks`, `runPlaylistUpdate`'s playlist-specific logic, the `data/spotify/show-playlist-state.json` convention, and the `playlist-modify-private` entry in `SPOTIFY_SCOPES` (it can never be exercised) — all dead code that will 403 forever if anyone ever calls it again. Removing it is part of this work, not a followup.

**What survives unchanged:** `filterQualifyingShows`'s core filtering logic (`scores.<owner>.basis !== 'claude'` — real signal only, not LLM-guessed), the dedup-by-artist mechanism, and the weekly-pull wiring pattern (isolated `try`/`catch` in `run-weekly-shows-pull.ps1`, mirroring `run-daily-pull.ps1`'s existing Oura containment so this step's failure never marks the other three steps failed).

## New delivery: one Spotify artist-page link per artist, via Telegram

Two real-world constraints, both confirmed live during the original implementation, drove this shape:

1. **Kevin listens to Spotify on his phone**, not at the dashboard. An embedded web player (verified working, `open.spotify.com/embed/track/<id>`, no auth needed) was seriously considered and rejected for exactly this reason — it solves for a surface he doesn't use for this. A Telegram message with tappable links reaches him where he actually listens; `https://open.spotify.com/artist/<id>` deep-links straight into the Spotify app on mobile.
2. **One link per artist, not per track.** The original design resolved each artist to 3 individual track URIs (a workaround for `/artists/{id}/top-tracks` also returning 403 — same Development Mode restriction, confirmed by isolating that `/me`, `/search`, and `/artists/{id}` all work fine and only `top-tracks` doesn't). That workaround is now unnecessary: an artist *page* link needs only `GET /search?type=artist&q=artist:"<name>"&limit=1`, taking `items[0].external_urls.spotify` — the plain, never-restricted search endpoint. Simpler, one API call instead of two, and Kevin browses the artist's whole catalog rather than being handed 3 pre-picked songs.

**Search reliability note:** a bare-name query (`q: "Anthony Jeselnik"`, no field filter) returned *Bill Burr* as the top result in one live test and the correct artist in another — inconsistent. The `artist:"<name>"` field-filter syntax (already used and proven for the original track-search workaround) was retested and returned the correct artist both times. Use the field-filter form; do not fall back to a bare-name query.

## Comedy is now included

The original design excluded `kind === 'comedy'` because there was no way to resolve a comedian to a Spotify *track* (no music catalog entry). An artist-*page* link has no such limitation — comedians with released specials have real Spotify artist pages. Verified live: searching `artist:"Anthony Jeselnik"`, `artist:"Patton Oswalt"`, `artist:"Tig Notaro"`, `artist:"Pete Holmes"` all returned real stand-up-special track results under `type=track` search (confirming the artist exists in Spotify's catalog), e.g. Jeselnik's "Thoughts and Prayers" and "All These Jokes About Hurting Children" — genuine special segment titles.

`filterQualifyingShows` changes from `kind === 'music'` only to `kind === 'music' || kind === 'comedy'` — comedy's `scores.<owner>.basis` is literally the string `'comedy'` (a real signal from the household's `comedyTaste` likes/dislikes matching, not an LLM guess), so it already passes the existing `basis !== 'claude'` filter unmodified.

**Interface change:** `filterQualifyingShows` currently returns a flat array of artist name strings (correct for the old track-resolution flow, which only ever needed a name to search with). The Telegram message needs `kind` (for emoji), `date`, and `venue` per artist too. It now returns an array of `{ act, kind, date, venue }` objects, deduplicated by normalized artist name exactly as before (first occurrence wins when an artist has multiple qualifying shows — e.g. two tour dates).

## Message format

Sorted by match score, strongest first (ties broken by soonest date) — changed post-launch (2026-08-08) from the originally shipped date-ascending sort, per Kevin: he wants the list to lead with what he's most likely to want to go to, not just what's soonest. One line per artist, score shown alongside the act:

```
🎸 Counting Crows (97%) — Aug 7 @ Hollywood Bowl: https://open.spotify.com/artist/0vEsuISMWAKNctLlUAhSZC
🤣 Pete Holmes (95%) — Aug 22 @ Largo at the Coronet: https://open.spotify.com/artist/728ycbzLcFEbkixT3RIyXt
```

🎸 for `kind === 'music'`, 🤣 for `kind === 'comedy'` (changed from the originally shipped 🎵/🎤 the same day, per Kevin's preference). An artist with no confident search match is skipped (logged, not fatal) — same error-containment convention the original design already established, still valid: one bad lookup must not drop the rest of the week's list.

Sent as its own message to the household Telegram group, triggered as the 4th step of `run-weekly-shows-pull.ps1` — the same slot the (now-deleted) playlist step occupied, same isolated `try`/`catch` so a Telegram send failure never marks `spotify:find-shows`/`shows:pull`/`spotify:match` (which the dashboard already depends on) as failed.

## Non-goals

- **No dashboard delivery.** Explicitly reconsidered and rejected mid-implementation of the original design — Kevin doesn't use the dashboard to listen to music.
- **No embedded player.** Verified technically working but solves for the wrong surface (desktop dashboard vs. his actual phone-based listening).
- **No per-track resolution.** One artist-page link is the whole deliverable; no "top tracks" picking, no `/artists/{id}/top-tracks` call (still 403 anyway).
- **No changes to `spotify-client.mjs`'s existing read-only scopes** beyond removing the now-dead `playlist-modify-private` entry — this feature needs no scope beyond what was already granted before the playlist detour.

## Testing

Reuses and revises `data/test-spotify-playlist-shows.mjs` (rename to `data/test-spotify-shows-telegram.mjs` — the file's subject genuinely changed): `filterQualifyingShows` extended for comedy inclusion and the new `{act, kind, date, venue}` shape; a new `resolveArtistPageUrl` with the same skip-on-no-match convention as the original `resolveArtistTracks`; message formatting (emoji selection, date sort, both kinds present); the isolated weekly-pull wiring. Every Spotify call goes through an injectable client — no real network calls in the suite, matching this codebase's established convention. Verify `resolveArtistPageUrl` against the real API for at least one music and one comedy artist before considering the work done, the same live-verification discipline that caught both the `top-tracks` and playlist-write 403s in the first place.
