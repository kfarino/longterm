# Spotify taste → show matching (Kevin + Hanna)

*Branch: `feature/oura-api-sketch` (alongside Oura connect). Approved 2026-08-05 — dual Spotify accounts; signals = following + liked songs + owned playlists; thin matcher against cached/sample shows; no Ticketmaster yet.*

## Goal

Pull intentional music taste for **both** adults (separate Spotify accounts), then score a list of upcoming shows so we can see **both / one / neither** hits — before wiring the bot or dashboard.

## Non-goals (this sketch)

- Ticketmaster / Bandsintown / live venue scraping (that stays with planned `get_upcoming_shows` web search)
- Recently played (noisy; not a good proxy)
- Top artists / related-artists / recommendations (related + recommendations are blocked for new Spotify apps; tops deprioritized vs intentional signals)
- Comedy taste (Spotify won’t help; venue-first remains)
- Bot, Telegram recap, or dashboard productization

## Auth model

Same pattern as Oura: one Longterm Spotify app; each adult consents separately.

| Piece | Location |
|-------|----------|
| App credentials | `~/.longterm/spotify-app.env` — `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET` |
| Per-owner tokens | `~/.longterm/spotify-<ownerId>.env` — e.g. `spotify-kevin.env`, `spotify-hanna.env` |
| Taste pulls | `data/spotify/<ownerId>-taste.json` (gitignored) |
| Match output | `data/spotify/show-matches-latest.json` (gitignored) |
| Sample shows fixture | `data/spotify/sample-shows.json` (**committed** — tiny fake/real-ish list so matching works before `upcoming_shows_cache.json` exists) |

Register app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard).  
Redirect URI (exact): `http://127.0.0.1:51825/oauth2callback`  
(Ports: Google Calendar 51823, Oura 51824, Spotify 51825.)

**Scopes:**

- `user-follow-read` — followed artists  
- `user-library-read` — liked / saved tracks  
- `playlist-read-private` — private playlists  
- `playlist-read-collaborative` — collaborative playlists they participate in  

## Taste signals (per owner)

| Signal | Endpoint | How we use it |
|--------|----------|----------------|
| Followed artists | `GET /v1/me/following?type=artist` (cursor pages, limit 50) | Strong intentional interest |
| Liked songs → artists | `GET /v1/me/tracks` (offset pages) | Artist affinity weighted by save count |
| Side playlists → artists | `GET /v1/me/playlists` then `GET /v1/playlists/{id}/tracks` | Only playlists **owned by** the user (or collaborative where they are a collaborator); skip followed editorial/Spotify-owned lists |

Each artist in the taste file carries:

```json
{
  "id": "spotifyArtistId",
  "name": "Artist Name",
  "sources": [
    { "type": "followed" },
    { "type": "liked", "trackCount": 12 },
    { "type": "playlist", "playlistName": "Road Trip", "trackCount": 3 }
  ]
}
```

Normalized name (lowercase, strip punctuation / leading “the ”) is used for matching.

## Show input (thin matcher)

`spotify-match-shows.mjs` reads shows from, in order:

1. `data/upcoming_shows_cache.json` if present and has findings  
2. Else `data/spotify/sample-shows.json`

Expected show shape (flexible; normalize in the script):

```json
{ "act": "Jimmy Eat World", "venue": "Hollywood Bowl", "date": "2026-11-07", "sourceUrl": "…" }
```

(`name` accepted as alias for `act` if cache uses a different field.)

## Matching rules

1. Normalize act name; match against each owner’s artist name set (and Spotify id if both sides have it later — name-first for v1).  
2. Per owner hit strength (descending): **followed** > **liked** (by track count) > **playlist** (by track count).  
3. Show rank: **both owners hit** > **one owner hits** > neither.  
4. Output lists matched shows with `owners: { <ownerId>: [...sources], … }` (ids from `goals.owners`) and unmatched shows for inspection.

## Scripts

1. `scripts/spotify-auth-setup.mjs --owner <id>` — loopback OAuth; write app env if missing; save owner tokens.  
2. `scripts/spotify-pull.mjs --owner <id> | --all` — refresh token if needed; pull three signals; write taste JSON + console inventory.  
3. `scripts/spotify-match-shows.mjs` — load both taste files (from `goals.owners` or `--owners kevin,hanna`); score show list; write `show-matches-latest.json` and print ranked summary.  

Shared helpers: `scripts/spotify-client.mjs` (paths via `longterm-paths.mjs`).

npm: `spotify:auth`, `spotify:pull`, `spotify:match`.

## Success criteria

- [ ] Kevin authorizes; Hanna authorizes  
- [ ] Each taste file shows non-empty followed / liked / playlist-derived artists  
- [ ] Matcher ranks sample (or cache) shows with clear both/one/neither labels  
- [ ] No secrets or `data/spotify/*-taste.json` / match output committed  

## Follow-up (later)

Feed matcher from live `get_upcoming_shows` cache; optional Ticketmaster for metro coverage; bot line like “Jimmy Eat World — both of you follow / like them.”
