# Decisions

Notable choices and departures from the PRD, newest first.

## 2026-11-26: Match record IDs by their number, and shape the deploy and incident tools

**Context:** PR 8 adds `list_recent_deploys`, `search_incidents` and `get_incident`. The 2026-11-22 entry left IDs needing their own "did you mean" rule, because name matching treats the shared `INC-` prefix as a match. The PRD gives `list_recent_deploys` and `search_incidents` no `response_format`, gives `list_recent_deploys` no `limit`, and says an empty search returns "a message with a suggestion to broaden".

**Decision:**

- `src/domain/ids.ts` parses IDs forgivingly: case, separators and zero padding don't matter, and a bare number is accepted (`inc 142`, `INC0142`, `INC-142` and `142` all read as `INC-0142`). Each tool already says which kind of ID it takes, so a bare number can't be ambiguous.
- A missing ID gets suggestions only when they are one digit typo away (one changed digit, or two neighbouring digits swapped), nearest number first, at most 3. `INC-0143` suggests `INC-0142`, `INC-0144` and `INC-0141`. `INC-9999` gets none, so the message points to `search_incidents` instead. PR 9 reuses this for runbook IDs (`RUNBOOK_ID` is already defined).
- Input that isn't an incident ID at all (`RB-07`, a sentence) is `invalid_argument`. A well-formed ID that doesn't exist is `not_found`.
- `get_incident` input is a plain string capped at 20 characters, not the fixture regex, so a near-miss spelling gets parsed or a helpful message instead of a bare SDK validation error.
- Concise `get_incident` gives the root cause and runbook. Symptoms, resolution and postmortem come with `detailed`. Across all 30 incidents, concise is 33% of detailed (FR-15 allows 40%).
- `search_incidents` and `list_recent_deploys` take no `response_format`: they return summaries, and FR-15 asks it only of tools that return entity details. Both take `limit`, like every list tool.
- An empty search is a tool error of kind `empty` (as the plan intended), with a next step that depends on whether `service` was passed. No deploys in the window is a normal result, not an error. In S2 "nothing shipped to auth" is evidence the model should use, not a failed call.
- A `search_incidents` query that is only an incident ID (`INC-0142`) is `invalid_argument` with a message that names the `get_incident` call to make. Search would split it into `inc` and `0142`, which match nothing. A bare number like `503` is still a keyword.

**Trade-off:** suggestions for a typo can point at an unrelated incident. They are hints the model must check, and the eval's hallucinated-ID scorer only checks that suggested IDs exist. Moving the resolution to `detailed` means the model needs a second call to see how INC-0142 was fixed, though RB-07 also has the rollback steps.

**Revisit when:** evals show the model stopping at concise `get_incident` without learning the fix, or repeating a pasted ID in `search_incidents` after the error.

## 2026-11-24: Set the tool pattern: SDK input validation, strict inputs, error kinds in `_meta`, and a `limit` on every list

**Context:** PR 7 adds the first two tools, and the other six copy their pattern. FR-9 wants invalid input to name the field and the accepted values. The plan wants each error to carry a kind (`invalid_argument`, `not_found`, `empty`) so the argument-validity scorer can tell a bad call from an unlucky one. FR-13 wants lists capped with a way to narrow them, but the PRD gives `get_service_health` and `get_service_dependencies` no `limit` input.

**Decision:**

- Input validation stays with the SDK. It checks the Zod schema before the handler runs and answers with a tool error (`isError: true`, never a protocol error) whose text starts `Input validation error:` and lists each field with its message. Our schemas set those messages, so they name the accepted values (`depth must be a whole number from 1 to 3`).
- Input schemas are `z.strictObject`, published with `additionalProperties: false`. With a plain object, a misspelled `service_id` is silently dropped, and `get_service_health` would answer for every unhealthy service instead of the one the model asked about.
- Errors a handler returns carry `{ kind, suggestions }` under `_meta["triage-mcp/error"]`. Structured content can't hold it, because it must match the tool's output schema. The model reads only the text, and scorers read `_meta`; SDK validation errors have no `_meta` and count as `invalid_argument` by their text prefix.
- Both tools take `limit` (default 5, max 20), from one shared schema that PRs 8 and 9 reuse. It is the only way to see past the cap: today no scenario has more than 4 unhealthy services, but a walk from `core-db` reaches 8.
- `get_service_dependencies` splits each service's edges into `via` (from neighbours one hop nearer the start: the shortest paths) and `also_via` (the rest). One combined list read as if `checkout-api`, one hop from `core-db`, were reached through `auth`.
- Concise `get_service_health` gives each service's status and only its breached SLOs, so a healthy service is one line with no numbers. `detailed` adds the rest of the record: owner, tier, description, both SLO checks, throughput and logs. Showing both SLO checks in concise would make it 62% of detailed (FR-15 allows 40%); this shape is 15% for the text and 30% for the whole result across all scenarios.
- Server code may not call `console.log`; a Biome override on `src/**` enforces it (stdout is the stdio protocol channel).

**Trade-off:** SDK validation messages are joined into one line and carry no suggestions. A handler-side parse could add them, but the published schema would then have to be looser than the real one.

**Revisit when:** evals show the model repeating an invalid call after reading the SDK's message, or a client that rejects `_meta` on tool results.

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
