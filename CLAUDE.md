# TriageMCP

MCP server that lets an AI assistant triage outages for "Fernhill", a fictional SaaS company, plus a CLI agent and an eval suite that gates every change. Spec: `docs/PRD.md`. All data is synthetic.

## Commands

- `pnpm dev` - run the stdio server with tsx (SCENARIO defaults to `checkout-latency`)
- `pnpm check` - Biome format + lint with fixes
- `pnpm typecheck` - `tsc --noEmit`
- `pnpm test` - unit + integration tests (no API key needed, must stay under 30s)
- `pnpm inspect` - open MCP Inspector against the stdio server
- `pnpm triage "<question>"` - run the CLI agent (needs ANTHROPIC_API_KEY, costs money)
- `pnpm eval` - run the eval suite (needs ANTHROPIC_API_KEY, costs money; ask first)

Before calling a task done: `pnpm check && pnpm typecheck && pnpm test`.

## Layout

- `fixtures/base/` - services, dependency edges, teams, on-call, incidents, runbooks (JSON)
- `fixtures/scenarios/` - per-scenario signals and deploys layered over base
- `src/domain/` - pure query functions over fixtures. No MCP imports here.
- `src/tools/` - one file per MCP tool; maps domain results to text + structured content
- `src/resources/`, `src/prompts/` - runbook/catalog resources, `triage_outage` prompt
- `src/server.ts` - server factory shared by both transports
- `src/transports/stdio.ts`, `src/transports/http.ts` - entry points
- `src/agent/` - the agent loop (shared by the CLI and evals; never fork it)
- `evals/` - cases with answer keys, scorers, `*.eval.ts`
- `test/unit/`, `test/integration/`

## Rules

- Target MCP spec 2026-07-28 with SDK v2 (`@modelcontextprotocol/server`, `@modelcontextprotocol/client`). Don't use v1 `@modelcontextprotocol/sdk` APIs or the deprecated HTTP+SSE transport.
- Server code must never write to stdout (`console.log`). Stdout is the stdio protocol channel. Log to stderr.
- MVP exposes exactly 8 tools (PRD 6.2). Adding a tool needs a DECISIONS.md entry.
- Every tool: Zod input schema, output schema, read-only annotation (except `acknowledge_incident`), description with "Use when", "Do not use for", and one example input.
- Errors are tool-error results with an actionable message and up to 3 closest valid IDs. Never throw protocol errors for bad user input.
- Lists cap at 5 by default (max 20) and report how many more exist.
- `response_format` defaults to `concise`.
- Fixture records use stable IDs (`INC-0142`, `RB-07`). Keep timestamps relative (`minutes_before_start`).
- No real people or companies in fixtures. On-call handles are role-style (`payments-primary`).

## Evals

- Never edit an answer key in `evals/cases/` to make a failing case pass. Fix the tool, description, or fixture instead, or add a DECISIONS.md entry explaining why the key was wrong.
- When a change moves eval scores, record before/after in CHANGELOG.md.
- Don't run `pnpm eval` without asking. Prefer `pnpm eval --filter <case>` while iterating.

## Worktrees

- Feature and agent work happens in Claude Code worktrees under `.claude/worktrees/<name>` (started with `claude --worktree <name>`, branch `worktree-<name>`).
- A new worktree is a fresh checkout: if `node_modules/` is missing, run `pnpm install --frozen-lockfile --prefer-offline` before anything else.
- `.env` is copied in automatically via `.worktreeinclude`. Don't recreate or edit it.
- The main checkout stays on `main` and is for review and merging.


<!-- rtk-instructions v2 -->
# Command output

Command output here is condensed to save tokens, keeping every signal and
dropping costly noise. Treat it as the complete result: run commands
normally, and batch related commands into one call to avoid extra turns.
Truncated results state their recovery path in their own output. Re-run a
command as `rtk bypass <cmd>` only when its result is unusable: empty when
output was clearly expected, contradicting its exit code, or garbled.
<!-- /rtk-instructions -->
