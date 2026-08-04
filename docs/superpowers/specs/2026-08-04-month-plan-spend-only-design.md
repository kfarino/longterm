# Month Plan = budget spend only (`schedule` kind)

*Approved 2026-08-04 — Kevin.*

## Decision

Month Plan (dashboard) shows **dinners and social events with budget implications** only. Pure scheduling (PT, Pediatrician, etc.) lives on Google Calendar and is tagged `kind: "schedule"` so it stays out of the budget view.

## Kinds

| kind | Meaning | On Month Plan? | On Google? |
|------|---------|----------------|------------|
| `dining` | Routine slot pick (`set_dinner_plan`) | yes | yes |
| `family` | Social / spend-relevant (friend dinners, pizza night) | yes | yes |
| `schedule` | Appointments / logistics | no | yes |

## Behavior

- **Dashboard** — render + `planRemainingMonth` only consider `dining` + `family`. Schedule-only days do not block routine dining suggestions. Tombstone `[]` still means “dismissed, no suggestion.”
- **Bot** — `add_family_event` takes optional `kind`; otherwise `classifyEventKind(title)` picks `schedule` vs `family`. Ambiguous titles → ask, don’t guess into the budget view. Reply names the kind stored.
- **Google sync** — all three kinds sync; new Google-only imports default to `schedule`. `extendedProperties.private.kind` preserved. Signature includes `kind`.

## Migrate (Aug 2026 data)

- → `family`: Shannon/Ryan, Free Press, Chelle & Jason, Pizza @ Nick’s, Avi + Ester
- → `schedule`: PT, Pediatrician, UCLA Baby Study
