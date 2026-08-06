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
| One Longterm OAuth app | `~/.longterm/oura-app.env` | `OURA_CLIENT_ID`, `OURA_CLIENT_SECRET` from Oura's developer portal |
| Per-person tokens | `~/.longterm/oura-<ownerId>.env` | e.g. `oura-kevin.env`, `oura-hanna.env` — refresh + access tokens after each adult consents |
| Sample pulls | `data/oura/<ownerId>-latest.json` | gitignored; overwritten each pull |

Both adults authorize the **same** app against **their own** Oura login (two consent flows). Active **Oura Membership** required for Gen3+ API access.

**App registration (2026-08-06 update, from actually creating it live):** the old `cloud.ouraring.com/oauth/applications` portal linked in the original version of this doc is being retired for new-app creation ("Starting October 15th, 2025 we will be migrating to our new developer portal — you can still edit existing applications here but new applications must be created in the new portal") — use **[developer.ouraring.com](https://developer.ouraring.com/applications)** instead. That portal also requires Website/Privacy Policy/Terms of Service URLs (all three set to the repo's GitHub URL here, since this is a private two-person app with no real public-facing pages) and has its own scope-checkbox UI (see below).

**Redirect URI gotcha (found live):** must use the literal hostname `localhost`, not `127.0.0.1` — the developer portal actively rejects `127.0.0.1` with "http protocol is only allowed for localhost" even though they're equivalent. `oura-client.mjs`'s `OURA_REDIRECT_URI` and `oura-auth-setup.mjs`'s local callback server were both written assuming `127.0.0.1` and had to be corrected to `localhost` (the callback server now binds with no explicit host, so it answers on whichever of IPv4/IPv6 loopback the OS resolves "localhost" to).

**Scopes:** Kevin opted into **all 11** available scopes at registration (`email personal daily heartrate tag workout session spo2 ring_configuration stress heart_health`) rather than the narrower "first pull" subset originally planned here — avoids a second re-authorization later if a brainstormed use ends up wanting one of the broader scopes. Oura's SpO2 scope name is `spo2`, not `spo2Daily`.

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

- [x] Kevin authorizes; pull writes a non-empty sample JSON (2026-08-06 — `personal_info`/`daily_sleep`/`daily_readiness`/`daily_spo2` returned real records; `daily_activity`/`sleep`/`workout` were empty for the 14-day window, presumably no recent logged activity rather than an error)
- [x] Hanna authorizes; separate sample JSON (2026-08-06 — first attempt was invalid, see below; retried in a private/incognito window with no cached Kevin session, and `personal_info.email` came back `hkamaric@gmail.com` — genuinely distinct from Kevin's `farinooh@gmail.com`. Also far richer data: 13 days of sleep/readiness/activity/SpO2 and 19 workouts, vs. Kevin's mostly-empty window — consistent with real, different accounts.)
- [x] Console inventory makes payload shape obvious for a follow-up brainstorm (confirmed via both pulls' output — Hanna's in particular shows the full shape of populated `sleep`/`workout`/`daily_activity` records that Kevin's near-empty window didn't exercise)
- [x] No secrets or `data/oura/*` committed (verified via `git status` — `oura-app.env`/`oura-kevin.env`/`oura-hanna.env` live under `~/.longterm/`, outside the repo entirely; `data/oura/*-latest.json` is gitignored)

**Caught during verification (2026-08-06):** the first Hanna attempt silently re-authorized Kevin's own account instead — the browser was still logged into his Oura session, so the consent flow never prompted for a different login. Caught by diffing `personal_info.email` between the two pulls (identical). This is a real hazard worth remembering for any future re-auth: **always verify `personal_info.email` differs from the other owner's after authorizing a second account**, don't trust that the flow visually completing means it authorized the intended person, especially in a shared/already-logged-in browser. Bogus `oura-hanna.env`/`data/oura/hanna-latest.json` from the first attempt were deleted before the real retry.

## Follow-up (later brainstorm)

Possible uses once we see the data: morning readiness in Telegram, couple recovery trends, sleep vs spend correlation, etc. **Decide after inspecting pulls — not in this sketch.**
