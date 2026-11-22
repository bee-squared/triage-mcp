# Decisions

Notable choices and departures from the PRD, newest first.

## 2026-11-22: List unhealthy dependencies first and suggest only plausible matches

**Context:** Lists cap at 5 by default, and a dependency walk can be longer. In S6, walking downstream from `core-db` by distance alone puts both failing services, `search-index` and `web-app`, after the cap. Separately, FR-14 asks for "up to 3 closest" matches without saying what to do when nothing is close.

**Decision:**

- `walkDependencies` orders by status (down, degraded, healthy), then depth, then catalog order. Each result carries its depth and the edges that reached it, so the graph's shape isn't lost.
- Service lookup resolves only exact IDs and names, after normalizing case and separators. Anything else is not found.
- Suggestions must share a word with the query (allowing a prefix, a common five-letter stem or one typo) or be at least 60% similar overall. An unrelated query gets none, so the model isn't handed 3 arbitrary services to blame.

**Trade-off:** output isn't in hop order, and a not-found error can have no suggestions. Its message then needs another next step, such as how to list valid services.

**Revisit when:** evals show the model misreading the order or getting stuck after an empty suggestion list.

## 2026-11-20: Give incidents a relative `days_before_start`

**Context:** The PRD's Incident has no timestamp, but an incident history without one can't say which incidents are recent, and real postmortems are dated. `CLAUDE.md` requires relative times.

**Decision:** Add `days_before_start` (1 to 730) to each incident. Days fit the scale of incident history better than `minutes_before_start`, which deploys use. Higher incident IDs are more recent, and a test enforces that.

**Revisit when:** a tool needs to filter incidents by time window; that window should then be in days too.

## 2026-11-20: Store signals as a healthy baseline plus per-scenario overrides

**Context:** The PRD stores one SignalSnapshot per service per scenario, and a Scenario lists `signal_snapshot_ids[]` and `deploy_ids[]`. With 10 services and 5 data sets that is 50 snapshots, most of them identical healthy records, which hides what each scenario actually changes.

**Decision:**

- `fixtures/base/signals.json` holds one healthy signal per service. Each `fixtures/scenarios/<id>.json` lists only `signal_overrides` (service ID plus the changed fields) and its `deploys`.
- `src/domain/scenarios.ts` resolves these at load into the PRD's shape: a full snapshot per service per scenario with `scenario_id`, and deploys with `scenario_id`. Tools see the PRD shape; only the storage differs.
- Snapshots get no IDs and scenarios no `signal_snapshot_ids[]` or `deploy_ids[]`. A snapshot is identified by scenario and service, and nothing references one by ID. Deploys keep stable `DEP-####` IDs.
- S5 reuses S1's data with `extends: "checkout-latency"` instead of a copy, so the two can't drift apart.
- The loader rejects a status that contradicts the SLOs (healthy but over the p95 SLO or error budget, or degraded while within both), so fixtures can't disagree with the SLO comparison `get_service_health` will report.

**Revisit when:** a scenario needs to remove a service or change the catalog, which overrides can't express.

## 2026-11-19: Pin Evalite to 1.0.0-beta.16 and Vitest to 4.1

**Context:** Evalite has no Vitest dependency of its own. It loads the repo's Vitest but imports `@vitest/runner` 4 directly, so Vitest 5 in the repo meant two incompatible runners. Evalite 0.19.0 also needed `better-sqlite3@^11.6.0`, which doesn't build on Node 26 and was forced to 13.x through a pnpm override.

**Decision:**

- Pin `evalite` to exactly `1.0.0-beta.16` (the line the PRD's docs link points to). `better-sqlite3` is an optional peer there, and storage defaults to in-memory.
- Pin `vitest` and `@vitest/coverage-v8` to `^4.1.12`, which matches the PRD's Vitest 4.1 and supports Node 26.
- Remove the `better-sqlite3` override and its `allowBuilds` entry. This replaces the 2026-10-29 entry, which is no longer needed.
- Dependabot ignores Vitest major updates and all Evalite updates, so a routine bump can't bring the mismatch back.

**Verified on Node 26.13.0:** a stub `.eval.ts` with `trialCount: 3` and no API call ran under `evalite run`. `--outputPath` wrote JSON, `evalite export` wrote the static UI, and `runEvalite` from `evalite/runner` ran with `scoreThreshold: 0`.

**Risk:** this is a beta, last released in February 2026. In-memory storage means the UI keeps no run history unless SQLite storage is added.

**Revisit when:** Evalite 1.0 ships stable or declares Vitest as a dependency. If Evalite breaks, the fallback is a thin runner of our own around the same scorers.

## 2026-11-19: Keep pnpm 12

**Context:** The PRD specifies pnpm 11. The repo already uses pnpm 12.16.1 through `packageManager` and `devEngines`.

**Decision:** Keep pnpm 12. Nothing in the plan depends on pnpm 11 behaviour.
