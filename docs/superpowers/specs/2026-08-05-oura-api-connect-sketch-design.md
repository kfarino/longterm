# Oura API connect sketch (Kevin + Hanna)

*Branch: `feature/oura-api-sketch`. Approved direction 2026-08-05 — Kevin: connect both Oura accounts, inspect payload shape, then brainstorm product use. No dashboard/Telegram wiring in this pass.*

## Goal

Pull real Oura data for **two separate accounts** (Kevin + Hanna), keyed by `goals.owners[].id`, so we can see what the API actually returns before deciding how Longterm should use it.

## Non-goals (this sketch)

- Dashboard / bot / recap integration  
- Health scoring or coaching product logic  
- Writing anything back to Oura  
- Bevel (no public API — out of scope)

## Auth model

Oura **deprecated personal access tokens** (Dec 2025). New integrations must use **OAuth2**.

| Piece | Location | Notes |
|-------|----------|--------|
| One Longterm OAuth app | `~/.longterm/oura-app.env` | `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` from [cloud.ouraring.com](https://cloud.ouraring.com/oauth/applications) |
| Per-person tokens | `~/.longterm/oura-<ownerId>.env` | e.g. `oura-kevin.env`, `oura-hanna.env` — refresh + access tokens after each adult consents |
| Sample pulls | `data/oura/<ownerId>-latest.json` | gitignored; overwritten each pull |

Both adults authorize the **same** app against **their own** Oura login (two consent flows). Active **Oura Membership** required for Gen3+ API access.

**Scopes (first pull):** `personal daily workout spo2`  
(Add `heartrate` / `tag` / `session` later if useful. Oura’s SpO2 scope name is `spo2`, not `spo2Daily`.)

**Note:** Oura refresh tokens are **single-use** — every refresh must rewrite `oura-<ownerId>.env` with the new refresh token (handled in `oura-client.mjs`).

## Scripts

1. `scripts/oura-auth-setup.mjs --owner <id>`  
   - Loads app credentials from `oura-app.env` (prompts once to create if missing).  
   - Loopback OAuth (port **51824**, distinct from Google Calendar’s 51823).  
   - Saves tokens to `oura-<ownerId>.env`.

2. `scripts/oura-pull.mjs --owner <id> [--days 14]`  
   - Refreshes access token if needed.  
   - GETs v2 usercollection endpoints for the date window.  
   - Writes `data/oura/<ownerId>-latest.json` and prints a short inventory (endpoint → count / sample keys).

3. `scripts/oura-pull.mjs --all`  
   - Runs for every id in `goals.json` `owners[]` that has a token file (skips missing with a clear message).

Shared helpers: `scripts/oura-client.mjs`.

## Endpoints sampled (v2)

Base: `https://api.ouraring.com/v2/usercollection/`

| Path | Why |
|------|-----|
| `personal_info` | Who the token is for |
| `daily_sleep` | Sleep scores / contributors |
| `daily_readiness` | Readiness |
| `daily_activity` | Activity / steps / calories |
| `daily_spo2` | SpO2 if available |
| `workout` | Workouts in window |
| `sleep` | Detailed sleep periods (if scoped) |

Exact field names come from the live response — the point of this sketch is to capture them.

## Success criteria

- [ ] Kevin authorizes; pull writes a non-empty sample JSON  
- [ ] Hanna authorizes; separate sample JSON  
- [ ] Console inventory makes payload shape obvious for a follow-up brainstorm  
- [ ] No secrets or `data/oura/*` committed  

## Follow-up (later brainstorm)

Possible uses once we see the data: morning readiness in Telegram, couple recovery trends, sleep vs spend correlation, etc. **Decide after inspecting pulls — not in this sketch.**
