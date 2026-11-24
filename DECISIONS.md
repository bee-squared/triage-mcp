# Decisions

Notable choices and departures from the PRD, newest first.

## 2026-11-23: Rank keyword search by field weight and term rarity, and number acknowledgements per store

**Context:** The PRD asks for keyword search over incidents and runbooks but doesn't say how to rank results. S1 and S2 depend on the right record coming first: `checkout latency` must rank INC-0142 above the look-alike decoys (INC-0131, INC-0141), and RB-07 above RB-05. FR-16 asks for a confirmation ID without giving its format.

**Decision:**

- Search terms are lowercased words with stopwords removed, light suffix stripping (`deployed` matches `deploy`), and a short synonym table (`slow` and `p95` mean latency, `unauthorized` means 401, `502` means 5xx).
- Each query term scores the weight of the most important field it appears in (incidents: title 3, symptoms and root-cause service 2, root-cause summary and affected services 1; runbooks: title 3, symptoms and services 2), times its rarity across the records searched. Ties go to the newer incident or the earlier runbook.
- A query with only stopwords lists the given service's incidents newest first, or nothing if no service was given.
- The domain returns every match; tools cap the list.
- Confirmation IDs are `ACK-0001`, counting up per store, with an injectable clock. Each eval trial gets its own store, so IDs are predictable in traces. A store keeps the newest 1,000 acknowledgements.

**Trade-off:** there is no negation, so "no recent deploy" still matches `deploy`. The synonym table is hand-tuned to the fixtures and must be kept small to stay explainable. `ACK-` IDs repeat across processes, but acknowledgements never outlive one.

**Revisit when:** evals show the model's queries missing an incident it should find, or a decoy outranking the answer.

## 2026-11-22: List unhealthy dependencies first and suggest loose matches for names only

**Context:** Lists cap at 5 by default, and a dependency walk can be longer. In S6, walking downstream from `core-db` by distance alone puts both failing services, `search-index` and `web-app`, after the cap. Separately, FR-14 asks for "up to 3 closest" matches without saying what to do when nothing is close.

**Decision:**

- `walkDependencies` orders by status (down, degraded, healthy), then depth, then catalog order. Each result carries its depth and the edges that reached it, so the graph's shape isn't lost.
- Service lookup resolves only exact IDs and names, after normalizing case and separators. Anything else is not found.
- For named records (services, teams), a suggestion must share a word with the query or be at least 60% similar overall. Words match if they are identical (2+ characters), one is a prefix of the other (3+), they start with the same 5 characters, or they are one edit apart (4+). A query with no such match, like `kafka`, gets none instead of 3 arbitrary services.
- These rules are loose, so some unrelated queries do match (`apple` suggests `web-app`, `checking` suggests `checkout-api`). That is accepted because suggestions are hints and are never resolved.
- The matcher doesn't take bare IDs, and `name` is required to enforce it. Every incident ID shares `INC-`, so `INC-banana` would suggest 3 real incidents, which the hallucinated-ID scorer couldn't catch. Ignoring the shared word isn't enough: `INC-9999` still passes 60% similarity on the prefix. IDs need a rule that compares the numeric part, starting with `get_incident` in PR 8 and reusable for runbooks in PR 9.

**Trade-off:** output isn't in hop order, and a not-found error can have no suggestions. Its message then needs another next step, such as how to list valid services.

**Revisit when:** evals show the model misreading the order, following a loose suggestion to the wrong service, or getting stuck after an empty suggestion list.

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
