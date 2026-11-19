# Fixtures

All data here is synthetic. **Fernhill** is a fictional B2B scheduling and payments SaaS company. No record describes a real person, company, or system. On-call handles are role-style (`payments-primary`), never names.

## Layout

| Path | Contents |
|---|---|
| `base/services.json` | The 10 services in the catalog |
| `base/dependencies.json` | Dependency edges between services |
| `base/teams.json` | Owning teams and their escalation channels |
| `base/oncall.json` | One on-call shift (primary and secondary handle) per team |
| `base/runbooks.json` | 12 runbooks (`RB-01` to `RB-12`) with symptoms, steps, and an escalation team |
| `scenarios/` | Per-scenario signals and deploys layered over `base/` (added later) |

`src/domain/schemas.ts` defines the schema for each file, and `src/domain/fixtures.ts` loads and validates them at startup. A bad record stops the server with a message naming the file and field, for example:

```
Invalid fixture data (1 issue):
  fixtures/base/services.json: [2].team_id: unknown team "payment"
```

## Conventions

- **Stable IDs.** Services and teams use lowercase slugs (`payment-gateway`). Eval answer keys reference these IDs, so don't rename them.
- **Edge direction.** In a dependency edge, `from_service_id` calls `to_service_id`. A service's *upstream* is what it depends on (possible causes). Its *downstream* is what depends on it (impact).
- **Edge kinds.** `sync` is a request the caller waits on, `async` goes through a queue or background job, and `external` crosses to a third party.
- **Relative time.** Timestamps are offsets from the scenario clock (`minutes_before_start`), so data never goes stale.
- **Coverage.** Every team has exactly one on-call shift. Service names are unique, ignoring case, so lookup by name is unambiguous.

## Catalog at a glance

| Service | Team | Tier | Depends on |
|---|---|---|---|
| `web-app` | web | 1 | auth, checkout-api, scheduling-api, search-index |
| `checkout-api` | payments | 1 | auth, payment-gateway, core-db, billing (async) |
| `payment-gateway` | payments | 1 | core-db |
| `billing` | payments | 2 | core-db, notifications (async) |
| `auth` | identity | 1 | core-db |
| `scheduling-api` | scheduling | 1 | auth, core-db, calendar-sync (async), notifications (async) |
| `calendar-sync` | scheduling | 2 | core-db |
| `notifications` | messaging | 2 | (none) |
| `search-index` | platform | 2 | core-db (async) |
| `core-db` | platform | 1 | (none) |

Only `web-app` depends on `search-index`, so a search outage can't reach checkout (scenario S6).

## Runbooks at a glance

Every service has at least one runbook. Each runbook escalates to a team that owns one of its services. `rollback_steps` is empty when there is no change to undo. Steps use `fernctl`, a fictional internal CLI.

| ID | Title | Services | Notes |
|---|---|---|---|
| `RB-01` | Core database connection pool exhaustion | core-db | |
| `RB-02` | Core database replication lag | core-db | |
| `RB-03` | Auth TLS certificate expiry | auth | S2 answer |
| `RB-04` | Auth session signing key rotation failure | auth | S2 decoy |
| `RB-05` | Checkout API elevated error rate | checkout-api | S1 decoy (errors, not latency) |
| `RB-06` | Card processor outage | payment-gateway | S1 decoy (no deploy) |
| `RB-07` | Payment gateway latency regression after deploy | payment-gateway, checkout-api | S1 and S5 answer |
| `RB-08` | Notifications queue backlog | notifications | |
| `RB-09` | Calendar sync stalled | calendar-sync, scheduling-api | |
| `RB-10` | Search index degraded or stale | search-index | S6 |
| `RB-11` | Web app errors after front-end release | web-app | |
| `RB-12` | Billing invoice generation failure | billing | |

Eval answer keys reference runbook IDs, so don't renumber them.
