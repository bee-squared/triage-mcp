# Decisions

Notable choices and departures from the PRD, newest first.

## 2026-11-28: Shape the agent loop, its traces and the `triage` CLI

**Context:** PR 11 adds the agent loop the CLI and evals share (FR-27 to FR-31). The PRD wants a hand-written loop with a 12-call cap, a JSON trace per run, a model flag defaulting to Sonnet 5.5 and a scenario flag. It doesn't say how to count the cap when one turn asks for several calls, how to call Claude (tool choice, thinking, caching), or what the trace holds beyond "messages, tool calls, arguments, results, token usage, latency".

**Decision:**

- The loop connects to a fresh server and acknowledgement store per run through a real MCP client over an in-memory transport (`src/agent/mcp.ts`). Tool calls take the same protocol path as any client, so SDK validation errors and `_meta` error kinds reach the trace unchanged.
- MCP tools become Claude tools as published, minus `$schema`. No `strict: true`: strict decoding would guarantee valid arguments, and the argument-validity scorer exists to catch invalid ones.
- `tool_choice` is `auto`. Forcing a tool (`any` or `tool`) returns a 400 on Sonnet 5.5 (PRD correction in the plan), so the system prompt steers instead.
- Thinking is left at the default (adaptive on all three models) with `effort: "medium"`, per the plan's cost estimate. PR 13 measures it. Top-level `cache_control` caches the tools, system prompt and earlier turns, so each turn pays mostly cache reads. The system prompt is a constant with no dates or IDs, so the prefix stays byte-identical across runs.
- The whole assistant `content` is appended each turn, thinking blocks included, and history is never edited. All results from one turn go back in one user message.
- The cap counts tool calls, not turns. When a turn asks for more calls than are left, the loop runs the ones that fit, in order, then stops with status `tool_cap`. A separate 20-request backstop covers `pause_turn` loops. `refusal`, `max_tokens` and API errors end the run with a status and a message a person can act on; tool calls in a cut-off response are not run. The loop never throws for API errors, so the CLI always writes a trace.
- The CLI asks for the server-side refusal fallback (`fallbacks: "default"`) on Sonnet 5.5 and Opus 5.5; `--no-fallback` turns it off. Evals will run with it off, so a score measures one model. Haiku 5.5 has no server-side fallback, so the flag is ignored there. The trace records the model that served each turn, and a fallback turn is priced per model from `usage.iterations`.
- `--model` accepts only models in the pricing table (`src/agent/pricing.ts`), so every run has a cost. Unknown models get the list of accepted ones.
- Traces are versioned JSON in `.traces/` (gitignored): status, final text, each tool call with arguments, result, error kind and latency, per-turn usage, cost and latency, totals, the system prompt, tool names and the full message history.
- Output is plain text that reads the same without color: errors say `ERROR (kind)`. Color appears only on a terminal and never when `NO_COLOR` is set. Progress goes to stderr, the report to stdout. Exit codes: 0 answered, 1 no answer or no key, 2 bad arguments.
- Without `ANTHROPIC_API_KEY` (or `ANTHROPIC_AUTH_TOKEN`) the CLI prints what to do and exits before connecting. It doesn't try other credential sources, such as an `ant auth login` profile.

**Trade-off:** running part of a parallel batch at the cap leaves the model's other calls unanswered, but the run is stopping anyway and the trace shows which ran. Pricing is a hand-kept table that will drift from the published rates. Haiku's higher rate above 100K-token prompts isn't modeled, since a triage run stays far below that. The system prompt overlaps the `triage_outage` prompt and could drift from it.

**Revisit when:** PR 13 measures cost and pass rate at other effort levels, an eval shows the model ignoring `auto` tool choice, or a run needs more than 12 calls to answer a fair question.

## 2026-11-27: Shape the catalog and runbook resources and the `triage_outage` prompt

**Context:** PR 10 adds the PRD's 2 resources and 1 prompt (FR-18 to FR-20). The PRD gives the catalog's content ("all services with team, tier, SLOs, dependencies") but no format, says runbooks are markdown, and says the prompt returns "a structured triage instruction". It doesn't say what a bad runbook URI or a bad prompt argument returns.

**Decision:**

- `catalog://services` is JSON (`application/json`). Each service carries its team (ID, name, escalation channel), tier, SLOs, `depends_on` and `depended_on_by`, each edge with its kind. Both directions are listed, so a reader doesn't have to invert the graph to see blast radius. It has no live status and reads the same in every scenario; its description sends the reader to `get_service_health` for that.
- `runbook://{runbook_id}` is a URI template. Its list callback enumerates all 12 runbooks with titles, and it completes `runbook_id` by prefix (`RB-1` gives `RB-10` to `RB-12`). The markdown has the same sections as `find_runbook`'s text, plus the escalation team's name and channel.
- Only the canonical ID resolves (`runbook://RB-07`, not `runbook://rb-7`), so each runbook has one address a client can cache. A miss reuses `findById` for its message: a different spelling of a real ID names the canonical URI, a near miss gets up to 3 digit-typo suggestions, and anything else gets an example URI.
- A miss is a protocol error (`ResourceNotFoundError`, sent as `-32602` with `data.uri`), not a tool-error result. The 2026-07-28 spec requires this for `resources/read`, and tool-error results exist only for tools. Likewise, a missing, empty or overlong `symptom` is the SDK's invalid-params error. The CLAUDE.md rule against protocol errors covers tool input, which these aren't.
- The prompt is one user message: the symptom between `<symptom>` markers with a note to treat it as data, then six numbered steps (investigate, identify the root cause, find the runbook, find on-call, draft a status update, take no action), the sections to answer with, and a rule to cite only IDs a tool returned. The no-action sentence is exported as `NO_ACTION_RULE` so tests can check it word for word.
- The prompt steers against the scenario traps without naming them: "the service showing symptoms is often not the one that broke" (S1), "a deploy is only a suspect if its service is unhealthy or on the failing path" (S1's `notifications` deploy), and "if a named service doesn't exist, say so and stop" (S4). The CLI agent and evals use their own system prompt (PR 11), so this prompt doesn't move eval scores.

**Trade-off:** strict URIs reject spellings `find_runbook` accepts, so a client that guesses a URI gets an error instead of the runbook. The error names the right URI, and listed resources always use it. The markers around the symptom don't stop a determined injection; they only make the boundary clear.

**Revisit when:** a client needs the catalog as markdown for display, the prompt and the agent's system prompt start to drift, or an eval shows a model following text inside the symptom.

## 2026-11-27: Shape the runbook, on-call and acknowledgement tools, and reword RB-05

**Context:** PR 9 adds the last three MVP tools: `find_runbook`, `get_oncall` and `acknowledge_incident`. The PRD gives them no `response_format` and no `limit`. It doesn't say what a symptom search returns, and doesn't say how to annotate the write tool beyond "non-read-only and non-idempotent". While building `find_runbook`, `checkout latency`, the most likely S1 query, ranked RB-05 (checkout error rate) above RB-07 (payment-gateway latency).

**Decision:**

- A `find_runbook` symptom search returns the best match in full plus the next-best matches as ID, title and services, capped by `limit` (default 5, max 20) with the usual "N more not shown" line. The model gets the steps in one call and can still choose a different runbook.
- `find_runbook` has no `response_format`. Every part of a runbook is a step the on-call may need, and a concise form small enough for FR-15's 40% would drop the diagnostic or rollback steps. `get_oncall` and `acknowledge_incident` return a few short fields, so a concise form would be the same.
- Exactly-one inputs (`runbook_id` or `symptom`, `team` or `service`) are checked in the handler as `invalid_argument`, per the plan. A symptom that is only a runbook ID, a service passed as `team`, and a team passed as `service` each get a message naming the call to make instead.
- Runbook IDs reuse `findById(RUNBOOK_ID, ...)`. With 12 two-digit IDs, every well-formed ID is one digit away from a real one, so a missing runbook always has a suggestion. The message also offers `symptom` search.
- `acknowledge_incident` is annotated `readOnlyHint: false`, `idempotentHint: false`, `destructiveHint: false` (it only adds a record) and `openWorldHint: false`. Its input reuses `AckSummarySchema`, which now carries field messages, so the store and the schema can't disagree and a bad summary never reaches the store's RangeError. Severity is the strict `SEV1` to `SEV4` enum, so `sev2` is a validation error that lists the accepted values. The result adds the owning `team_id` (FR-17).
- RB-05's symptom "Errors without a matching rise in latency" is now "Errors while response times stay normal". Search has no negation (2026-11-23), so the old wording matched `latency`. Since `checkout` is the rarer word, RB-05 won. With the new wording, `checkout latency` and `checkout is slow` rank RB-07 first, and `checkout errors` still ranks RB-05 first. No answer key exists yet, so no eval score moved.
- One server test now covers all 8 tools: exactly 8, read-only annotations except the write tool, "Use when", "Do not use for" and a runnable example in every description, and p95 under 50 ms over 40 calls of each example. The FR-15 test measures every tool with a `response_format` across every scenario, using chars/4 as the token proxy. It fails if a new tool takes `response_format` but has no reference calls.

**Trade-off:** returning the whole best-match runbook costs 800 to 1,200 characters even when the model picks another one. The wording fix tunes data to the search instead of adding negation, so other "without X" phrasings can still mislead. The p95 test measures the in-memory transport, not HTTP.

**Revisit when:** evals show the model reading the wrong runbook after a symptom search, or a fixture needs negation to rank correctly.

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
