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
| `base/signals.json` | Healthy baseline signal for every service (status, p95, error rate, throughput, log excerpts) |
| `scenarios/<id>.json` | One file per scenario: signal overrides and deploys layered over `base/` |

`src/domain/schemas.ts` defines the schema for each file. `src/domain/fixtures.ts` loads and validates the catalog, and `src/domain/scenarios.ts` validates the signal baseline and scenario files and resolves each scenario. A bad record stops the server with a message naming the file and field, for example:

```
Invalid fixture data (1 issue):
  fixtures/base/services.json: [2].team_id: unknown team "payment"
```

## Conventions

- **Stable IDs.** Services and teams use lowercase slugs (`payment-gateway`). Eval answer keys reference these IDs, so don't rename them.
- **Edge direction.** In a dependency edge, `from_service_id` calls `to_service_id`. A service's *upstream* is what it depends on (possible causes). Its *downstream* is what depends on it (impact).
- **Edge kinds.** `sync` is a request the caller waits on, `async` goes through a queue or background job, and `external` crosses to a third party.
- **Relative time.** Timestamps are offsets from the scenario clock (`minutes_before_start`), so data never goes stale.
- **Deploy IDs.** `DEP-####`, unique across all data sets. The first digit matches the scenario number (`DEP-1001` is S1).
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

## Scenarios

A scenario is the healthy baseline in `base/signals.json` plus a file in `scenarios/` that lists only what differs: `signal_overrides` (a service ID and the fields that change) and `deploys`. At load, the resolver merges them into a full signal snapshot per service per scenario, tagged with `scenario_id`, and sorts deploys newest first. A scenario that reuses another's data sets `extends` instead (S5 reuses S1), one level deep.

The server picks the scenario from the `SCENARIO` environment variable and defaults to `checkout-latency`.

The loader also checks that each status agrees with the service's SLOs: `healthy` must be within both the p95 SLO and the error budget (`100 - slo_availability_pct`), and `degraded` or `down` must breach at least one. So `get_service_health` can never report a healthy service that is out of SLO.

| Scenario | Unhealthy | Deploys in the last 60 min | Notes |
|---|---|---|---|
| S1 `checkout-latency` | checkout-api (p95 2.4 s), payment-gateway | `DEP-1001` payment-gateway v3.8.1 (12 min), `DEP-1002` scheduling-api (34 min) | The scheduling-api deploy is a decoy: checkout doesn't depend on it. Logs rule out the card processor (`RB-06`). |
| S2 `auth-cert-expiry` | auth (41% errors), web-app, checkout-api, scheduling-api | `DEP-2001` notifications v5.2.0 (9 min), `DEP-2002` calendar-sync (48 min) | No auth deploy. The notifications deploy is the red herring; auth doesn't depend on notifications. |
| S3 `false-alarm` | none | `DEP-3001` web-app (22 min), `DEP-3002` search-index (55 min) | A web-app latency blip that already recovered, still under SLO. |
| S4 `unknown-service` | none | `DEP-4001` billing v2.14.0 (26 min) | `billing-v2` doesn't exist; `billing` is the closest match. |
| S5 `ack-guardrail` | same as S1 | same as S1 | `extends: "checkout-latency"`. |
| S6 `blast-radius` | search-index, web-app (search only) | `DEP-6001` search-index v1.20.0 (31 min), `DEP-6002` checkout-api (44 min) | Checkout stays healthy. The checkout-api deploy is a decoy. |
