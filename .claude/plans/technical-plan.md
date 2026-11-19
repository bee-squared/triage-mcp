# TriageMCP technical plan

## Context

The repo holds only tooling: no `src/`, fixtures, or evals. `setup/initialize-project` is one unmerged commit ahead of `main`. This plan delivers the PRD's MVP as 23 reviewable PRs (numbered 0 to 19, with 3, 12 and 18 each split in two: 3a/3b, 12a/12b, 18a/18b), followed by small optional P1 PRs. Each PR leaves `main` working. Line counts are estimates that exclude the lockfile.

Skills used: `superpowers:brainstorming`, `claude-api`.

## Can Evalite work out of the box?

Mostly yes, with two dependency changes. The rest of the Evalite work is small project code.

### Dependency changes (PR 0)

| Change | Why |
|---|---|
| Pin `vitest` and `@vitest/coverage-v8` to `^4.1.12` | Evalite has no Vitest dependency of its own, so it loads the repo's Vitest 5 while using `@vitest/runner` 4. The PRD already specifies 4.1, and 4.1.12 supports Node 26. |
| Pin `evalite` to exactly `1.0.0-beta.16` instead of `^0.19.0` | The PRD's docs link points to the v1 line. In this beta `better-sqlite3` is optional and storage defaults to in-memory. |
| Remove the `better-sqlite3` override and its `allowBuilds` entry; replace the DECISIONS.md entry | They are no longer needed, which also removes the risk that entry describes. |
| Add a Dependabot ignore for Vitest major updates and Evalite | Stops a routine update from reintroducing the mismatch. |

**Gate before PR 0 merges:** run a throwaway `.eval.ts` with a stub task and no API call on Node 26, then confirm `--outputPath` JSON and `evalite export` both work. I only inspected the package, so this combination has not been run. If it fails, the fallback is a thin own runner around the same scorers, recorded in DECISIONS.md.

### What Evalite provides directly

`trialCount: 3`, `maxConcurrency`, scorers with metadata, `reportTrace`, the local UI, JSON output, the static export, and a `runEvalite` Node API.

### Project code still needed

These are PRD rules that Evalite has no option for:

| Need | Approach |
|---|---|
| Pass at 2 of 3 trials; per-scorer rates; zero tolerance for hallucinated IDs and guardrail failures | `evals/report.ts` groups the JSON output by case ID and owns the exit code (about 120 lines). |
| Cost in USD and p50/p95 latency | Computed from our own trace files, because Evalite's trace usage has no cached-token fields. |
| `pnpm eval --filter <case>` and `--model` | `evals/run.ts` wraps `runEvalite` (about 60 lines), so the `CLAUDE.md` command stays valid. Filter and model pass to workers through env vars. |
| Evalite's own threshold | Pass `scoreThreshold: 0` so `report.ts` alone decides pass or fail. |
| Timeouts | Evalite's default `testTimeout` is 30s, too short for agent trials. Set 180s and concurrency of about 6 in `evalite.config.ts`. |
| $5 spend guard that aborts mid-run | Workers append each trial's cost to a shared ledger file, and each trial checks the total before starting. |
| WCAG AA HTML report | Check Evalite's export at the gate. If it falls short, generate a small report from the JSON. |

**Residual risk:** the beta's last release was February 2026, and in-memory storage means no run history in the UI unless SQLite is added later.

## PRD corrections

Record each of these in DECISIONS.md in the PR named.

| PRD item | Problem | Decision | PR |
|---|---|---|---|
| FR-38 judge at temperature 0 | Impossible. Sonnet 5.5 rejects non-default values, and API version `2026-10-21` (sent by the pinned SDK) rejects the field on every model. | Omit it. Pin the model, use structured output for the 1 to 5 score, pass at 4 or above, and let the 2-of-3 rule absorb noise. | 15 |
| Forced tool choice | `any` and `tool` return a 400 on Sonnet 5.5. | Use `auto`, steered by descriptions and the prompt. | 11 |
| Scorers can't check several required outcomes: "no active incident", "checkout unaffected", "doesn't blame notifications", "cites INC-0142", "recommends rollback" | No FR-37 scorer covers them, and a simple mention check would fail "notifications is not the cause". | Add a deterministic **claims** scorer with `required_patterns[]` and `forbidden_patterns[]` in the answer key. | 12b |
| No-hallucinated-IDs scorer on S4 | The answer must repeat `billing-v2`, which isn't a real ID. | Allow tokens that appear in the user's question. Check `INC-`, `RB-`, and `DEP-` by pattern and service IDs by known slug shape. | 12b |
| Root-cause match on `auth` | Plain substring matching also hits "authentication" and "unauthorized". | Match on word boundaries against the service ID or name. Scorers can be N/A per case (S3, S4). | 12b |
| Rate limit and acknowledgements on serverless | In-memory state exists per instance, so neither is global. | Accept this for a demo and document it. | 16 |
| FR-15 token ratio | Tests must run without an API key. | Use `chars/4` as a ratio proxy, enforced by a test. | 9 |
| Signal storage | 10 services across 5 data sets is mostly repeated healthy records. | Store a healthy baseline plus per-scenario overrides, resolved into the PRD's shape at load. | 3b |
| Versions | The repo uses pnpm 12, the PRD says 11. | Keep pnpm 12. | 0 |

## Architecture decisions

- **Fixture loading:** static JSON imports so Vercel bundles the data, validated by Zod at startup. Errors name the file and field.
- **Server factory:** `createServer({ scenario, ackStore })`. The store is injected: a fresh one per eval trial, a module-level one over HTTP (where the server is built per request).
- **Tool helpers:** `src/tools/_shared.ts` holds `ok()`, `toolError()`, closest-match suggestions (at most 3), and list capping. Errors carry a kind (`invalid_argument`, `not_found`, `empty`) so the argument-validity scorer doesn't count an expected not-found as a failure.
- **Exactly-one inputs** (`find_runbook`, `get_oncall`): checked in the handler, keeping the published schema a plain object.
- **Agent loop:** a hand-written loop as the PRD wants, about 80 lines including trace capture.
  - Append `response.content` whole and keep history append-only, because thinking blocks must be replayed unchanged.
  - Return all parallel tool results in one user message.
  - Handle `refusal`, `max_tokens`, and `pause_turn`.
  - Do not set `strict: true`, or the argument-validity scorer can't fail.
- **Refusal fallback:** on for the CLI (`fallbacks: "default"`, Sonnet only). Off for evals, where a refusal fails the trial, so scores measure one model. The trace records which model served.
- **Eval cost and time (unmeasured estimates):**
  - About $0.075 per uncached trial, so about $4 for 54 trials, over the $3 target. Start with prompt caching and `effort: "medium"`, then measure in PR 13.
  - Sequential trials would exceed 10 minutes, hence concurrency of about 6.

## Workflow

- Claude works in a worktree, then stops with verified uncommitted changes and a suggested commit message.
- **You commit, push, open, and merge.** Your settings deny these to Claude, and the sandbox blocks GitHub and Vercel, so you also read CI results and do the Vercel setup.
- PRs merge in order, and each starts from updated `main`. Unmerged work can't be stacked because Claude can't commit it. PRs 16 and 17 can run in parallel with 11 to 15 once PR 10 merges.
- Every PR runs `pnpm check && pnpm typecheck && pnpm test`. `pnpm eval` runs only when you approve it, each time.

## PR sequence

### Foundation

| PR | Scope | Key files | Est. lines |
|---|---|---|---|
| **0** | Finish the setup branch: Evalite changes and gate above. CI `node@24` to `node@26`; add the `pnpm install --frozen-lockfile` step if the setup action doesn't install. Add a `build` script (`tsconfig.build.json`) and uncomment the build step in `ci.yml`, which is commented out today. Add `exactOptionalPropertyTypes`. Remove the `wt` script if the setup branch has it (`scripts/wt.sh` doesn't exist). | `package.json`, `pnpm-workspace.yaml`, `ci.yml`, `tsconfig*.json`, `dependabot.yml`, `DECISIONS.md` | 80 |
| **1** | Add `CHANGELOG.md` and the Biome hook in the existing `.claude/settings.json`. The PRD is already at `docs/specs/triage-mcp-prd.md`. The `/eval` command moves to PR 13, since `pnpm eval` doesn't exist before then. | `CHANGELOG.md`, `.claude/settings.json` | 30 |

### Data (FR 1 to 7)

| PR | Scope | Key files | Est. lines |
|---|---|---|---|
| **2** | Zod schemas, loader, env config, startup errors. Catalog: 10 services, edges, teams, on-call. | `src/domain/schemas.ts`, `src/domain/fixtures.ts`, `src/config.ts`, `fixtures/base/{services,dependencies,teams,oncall}.json`, `fixtures/README.md` | 400 |
| **3a** | 12 runbooks, with a schema check in the integrity test. | `fixtures/base/runbooks.json`, `test/unit/fixtures.test.ts` | 350 |
| **3b** | 5 data sets (S5 reuses S1's), with deploys including the `notifications` red herring. Also the scenario overlay resolver: healthy baseline plus per-scenario overrides, scenario selection from config with the `checkout-latency` default (FR 4 and 5), with tests. | `fixtures/scenarios/*`, `src/domain/scenarios.ts`, `test/unit/scenarios.test.ts` | 350 |
| **4** | 30 incidents, including INC-0142 and decoys, plus a referential integrity test. **The one PR expected over the limit:** it is data only, and splitting it would leave a partial dataset. Review a sample and rely on the test. | `fixtures/base/incidents.json`, `test/unit/fixtures.test.ts` | 600 |

### Domain (FR 32)

| PR | Scope | Key files | Est. lines |
|---|---|---|---|
| **5** | Service lookup, closest match, graph walk, health with SLO comparison, deploy window, with tests. | `src/domain/{services,graph,health,deploys}.ts` | 350 |
| **6** | Incident and runbook keyword search, on-call lookup, acknowledgement store, with tests. | `src/domain/{search,oncall,acknowledgements}.ts` | 300 |

### MCP server (FR 8 to 21, 33)

| PR | Scope | Key files | Est. lines |
|---|---|---|---|
| **7** | Server factory, shared helpers, stdio entry, in-memory integration harness, `get_service_health`, `get_service_dependencies`. This PR sets the tool pattern, so review it closely. It also tests that invalid input returns a tool error, not a protocol error. Adds the `dev` and `inspect` scripts. | `src/server.ts`, `src/tools/_shared.ts`, `src/transports/stdio.ts`, `test/integration/harness.ts`, `package.json` | 400 |
| **8** | `list_recent_deploys`, `search_incidents`, `get_incident`, with happy and error tests. | `src/tools/*`, `test/integration/*` | 350 |
| **9** | `find_runbook`, `get_oncall`, `acknowledge_incident`. Test for exactly 8 tools, annotations, description requirements, and the 40% concise ratio, plus a check that every tool call runs in under 50 ms at p95 (NFR). | `src/tools/*`, `test/integration/*` | 350 |
| **10** | Catalog and runbook resources, the `triage_outage` prompt, with tests. **Week 1 exit:** you confirm all tools work in `pnpm inspect`. | `src/resources/*`, `src/prompts/*` | 200 |

### Agent (FR 27 to 31)

| PR | Scope | Key files | Est. lines |
|---|---|---|---|
| **11** | Agent loop with a 12-call cap, JSON traces, pricing table, CLI with `--model` and `--scenario`, `NO_COLOR`, clear missing-key error. The loop connects to the server with an in-process MCP client over an in-memory transport (a fresh server and ack store per run), and converts the MCP tool list to Anthropic tool definitions. Adds the `triage` script. Unit tests use a fake Anthropic client. One real `pnpm triage` run with your approval. | `src/agent/{loop,trace,pricing,mcp}.ts`, `src/cli/triage.ts`, `package.json` | 350 |

### Evals (FR 34 to 42)

| PR | Scope | Key files | Est. lines |
|---|---|---|---|
| **12a** | Case schema, S1, S3, S4 cases, integrity test (FR-34). Mostly data, so it reviews quickly. | `evals/cases/*`, `evals/schema.ts`, `test/unit/eval-integrity.test.ts` | 250 |
| **12b** | All deterministic scorers plus claims, with tests against hand-built traces. Logic-heavy, so reviewed on its own. No API calls. | `evals/scorers/*`, `test/unit/scorers.test.ts` | 300 |
| **13** | Evalite wiring, `run.ts`, `report.ts`, spend ledger, missing-key error, tests on sample JSON. Adds the `eval` and `eval:ui` scripts and the `/eval` command. **Week 2 exit:** first scorecard from an approved filtered run, then fixes. | `evalite.config.ts`, `evals/*.eval.ts`, `evals/{run,report}.ts` | 350 |
| **14** | S2, S5, S6 cases (S5 has 2 phrasings each of variants A and B, with an argument check on B). Full run with your approval; tuning goes in follow-up PRs with before/after scores in `CHANGELOG.md`. | `evals/cases/*`, `fixtures/scenarios/*` if needed | 200 |
| **15** | Status-update judge with rubric and pinned Sonnet 5.5, run only on cases that expect a draft. | `evals/scorers/judge.ts` | 200 |

### CI and hosting (FR 22 to 26, 43 to 47)

| PR | Scope | Key files | Est. lines |
|---|---|---|---|
| **16** | Hono HTTP transport: `/mcp`, `/mcp/:scenario`, `/health`, Host and Origin allowlists (requests with no Origin allowed), 60/min/IP limit, 64 KB limit, metadata-only logs, tests. Check that the SDK's stateless handler also covers FR-23. | `src/transports/http.ts`, `src/transports/middleware.ts`, `test/integration/http.test.ts`, `package.json` (`dev:http` script) | 350 |
| **17** | Vercel entry, config, post-deploy smoke script. **Check first that Vercel supports Node 26.** If not, record a lower `engines` range for hosting, or use the PRD's `mcp-handler` fallback if the blocker is Hono. **Your steps:** create the project, set `ALLOWED_HOSTS`, test in claude.ai, and check cold start (under 2 s), warm p95 (under 500 ms) and 10 requests per second with the smoke script. | `api/index.ts`, `vercel.json`, `scripts/smoke.ts` | 100 |
| **18a** | CI: coverage at 90%, `mcp-smoke`, `security` (secret scanning, audit). **Your steps:** add required checks. | `.github/workflows/{ci,security}.yml` | 150 |
| **18b** | `evals` workflow: path-filtered, nightly and manual runs, PR comment, artifact, badge JSON published to a `badges` branch. **Your steps:** add the `ANTHROPIC_API_KEY` secret and the required check. **Week 3 exit:** evals gate PRs. | `.github/workflows/evals.yml`, `evals/summary.ts` | 200 |

### Documentation (FR 48 to 50)

| PR | Scope | Key files | Est. lines |
|---|---|---|---|
| **19** | README with real scorecard, eval pass-rate badge (from PR 18b's badge JSON), connector steps, and 5 sample questions; `EVALS.md`; `docs/API.md`; at least 5 DECISIONS.md entries. | `README.md`, `EVALS.md`, `docs/API.md`, `DECISIONS.md` | 400 |

### P1, if time allows (one small PR each)

- 2 recorded transcripts (FR-51). The README links to one, so if this is skipped, remove that link in PR 19.
- Haiku comparison table (FR-42).
- Judge calibration against 10 hand-labeled examples (FR-39).
- Prompt-injection fixture and case (threat model). Use a separate data set so S1 scores aren't affected.
- Post-deploy smoke test in CI (FR-47).

FR-17 (related IDs in tool responses) is built into PRs 7 to 9, since it costs almost nothing there.

## Verification

- **Each PR:** `pnpm check && pnpm typecheck && pnpm test`, under 30 seconds with no API key. You confirm CI.
- **After PR 10:** `pnpm inspect` lists 8 tools, 2 resources, and 1 prompt, and every tool can be called.
- **After PR 11:** with approval, `pnpm triage "Checkout is slow, what's going on?"` names `payment-gateway`, INC-0142, and RB-07, and writes a trace.
- **After PRs 13 to 15:** with approval, `pnpm eval` prints per-case, per-scorer, cost, and latency results, with exit codes tested. Targets: at least 85% pass, no hallucinated IDs, no guardrail violations, under $3, under 10 minutes.
- **After PR 17:** you run the smoke script against the deployed URL (the sandbox blocks Vercel for Claude), check `/health`, check cold start, warm latency and load against the NFR thresholds, and connect from claude.ai.
- **Before calling MVP done:** walk through each P0 FR and the 30-day metrics, and record the eval scores of two consecutive runs (at most 10 points apart).
