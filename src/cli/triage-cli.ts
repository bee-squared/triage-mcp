import { parseArgs } from "node:util";
import Anthropic from "@anthropic-ai/sdk";
import { type CreateMessage, runAgent } from "../agent/loop.js";
import { connectInProcess } from "../agent/mcp.js";
import {
	AGENT_MODELS,
	type AgentModel,
	DEFAULT_MODEL,
	isAgentModel,
} from "../agent/pricing.js";
import {
	DEFAULT_TRACE_DIR,
	type ToolCallRecord,
	type Trace,
	writeTrace,
} from "../agent/trace.js";
import {
	DEFAULT_SCENARIO,
	SCENARIO_IDS,
	type ScenarioId,
} from "../domain/schemas.js";

// `pnpm triage "<question>"`: runs the agent once against an in-process
// server and prints the answer, a summary of tool calls, and where the trace
// went (FR-27 to FR-30). The logic lives here, separate from the entry file,
// so tests can run it with a fake Claude client and capture its output.

export const USAGE = `Usage: pnpm triage [options] "<question>"

Asks the triage agent a question about the Fernhill fixtures.

Options:
  --model <id>        ${AGENT_MODELS.join(", ")} (default ${DEFAULT_MODEL})
  --scenario <id>     ${SCENARIO_IDS.join(", ")}
                      (default $SCENARIO, else ${DEFAULT_SCENARIO})
  --trace-dir <dir>   where to write the JSON trace (default ${DEFAULT_TRACE_DIR})
  --no-fallback       don't re-run a refused turn on another model
  -h, --help          show this help

Needs ANTHROPIC_API_KEY (in .env or the environment). Each run costs money.`;

export interface CliOptions {
	readonly question: string;
	readonly model: AgentModel;
	readonly scenario: ScenarioId;
	readonly traceDir: string;
	readonly fallback: boolean;
}

export type ParseResult =
	| { readonly kind: "run"; readonly options: CliOptions }
	| { readonly kind: "help" }
	| { readonly kind: "error"; readonly message: string };

export function parseCliArgs(
	argv: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): ParseResult {
	let parsed: ReturnType<typeof parse>;
	try {
		parsed = parse(argv);
	} catch (error) {
		return { kind: "error", message: (error as Error).message };
	}
	const { values, positionals } = parsed;
	if (values.help) return { kind: "help" };

	const question = positionals.join(" ").trim();
	if (question === "") {
		return { kind: "error", message: "Missing the question to ask." };
	}
	const model = values.model ?? DEFAULT_MODEL;
	if (!isAgentModel(model)) {
		return {
			kind: "error",
			message: `Unknown model "${model}". Use one of: ${AGENT_MODELS.join(", ")}.`,
		};
	}
	const scenario =
		values.scenario ?? nonEmpty(env.SCENARIO) ?? DEFAULT_SCENARIO;
	if (!isScenario(scenario)) {
		return {
			kind: "error",
			message: `Unknown scenario "${scenario}". Use one of: ${SCENARIO_IDS.join(", ")}.`,
		};
	}
	return {
		kind: "run",
		options: {
			question,
			model,
			scenario,
			traceDir: values["trace-dir"] ?? DEFAULT_TRACE_DIR,
			fallback: !values["no-fallback"],
		},
	};
}

function parse(argv: readonly string[]) {
	return parseArgs({
		args: [...argv],
		allowPositionals: true,
		options: {
			model: { type: "string" },
			scenario: { type: "string" },
			"trace-dir": { type: "string" },
			"no-fallback": { type: "boolean" },
			help: { type: "boolean", short: "h" },
		},
	});
}

/** The message shown when no API key is set: what to do, not a stack trace. */
export const MISSING_KEY_MESSAGE = [
	"ANTHROPIC_API_KEY is not set.",
	"Copy .env.example to .env and add your key, or export ANTHROPIC_API_KEY.",
	"The server and `pnpm test` don't need a key; only `pnpm triage` and `pnpm eval` do.",
].join("\n");

export function hasCredentials(
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	return (
		nonEmpty(env.ANTHROPIC_API_KEY) !== undefined ||
		nonEmpty(env.ANTHROPIC_AUTH_TOKEN) !== undefined
	);
}

/** Color only on a terminal, and never when NO_COLOR is set (no-color.org). */
export function useColor(
	env: Readonly<Record<string, string | undefined>>,
	isTTY: boolean,
): boolean {
	return isTTY && nonEmpty(env.NO_COLOR) === undefined;
}

export interface Style {
	bold(text: string): string;
	dim(text: string): string;
	red(text: string): string;
}

export function makeStyle(color: boolean): Style {
	const wrap = (open: number, close: number) => (text: string) =>
		color ? `\u001b[${open}m${text}\u001b[${close}m` : text;
	return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39) };
}

/** One progress line per tool call. Readable without color: ERROR is a word. */
export function formatToolCall(call: ToolCallRecord, style: Style): string {
	const args = JSON.stringify(call.arguments ?? {});
	const shown = args.length > 80 ? `${args.slice(0, 77)}...` : args;
	const failed = call.is_error
		? ` ${style.red(`ERROR (${call.error_kind ?? "error"})`)}`
		: "";
	return `${String(call.index).padStart(2)}. ${call.name} ${style.dim(shown)} ${call.latency_ms} ms${failed}`;
}

/** The answer, then the tool calls, then run stats and the trace path. */
export function formatReport(
	trace: Trace,
	tracePath: string,
	style: Style,
): string {
	const lines: string[] = [];
	if (trace.status === "answered") {
		lines.push(trace.final_text, "");
	} else {
		lines.push(
			style.red(`No answer: ${trace.stop_message ?? trace.status}`),
			"",
		);
	}
	lines.push(style.bold(`Tool calls (${trace.tool_calls.length})`));
	if (trace.tool_calls.length === 0) lines.push("  none");
	for (const call of trace.tool_calls) {
		lines.push(`  ${formatToolCall(call, style)}`);
	}
	const served =
		trace.served_models.length > 0 &&
		trace.served_models.some((m) => m !== trace.model)
			? ` (served by ${trace.served_models.join(", ")})`
			: "";
	const { usage } = trace;
	const cost =
		trace.cost_usd === null ? "cost unknown" : `$${trace.cost_usd.toFixed(4)}`;
	lines.push(
		"",
		style.dim(
			[
				`model ${trace.model}${served}`,
				`scenario ${trace.scenario}`,
				`${usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens} in (${usage.cache_read_input_tokens} cached) / ${usage.output_tokens} out tokens`,
				cost,
				`${(trace.latency_ms / 1000).toFixed(1)} s`,
			].join(" · "),
		),
		style.dim(`trace: ${tracePath}`),
	);
	return lines.join("\n");
}

export interface CliIo {
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly stdout: { write(text: string): unknown; isTTY?: boolean };
	readonly stderr: { write(text: string): unknown; isTTY?: boolean };
	/** Builds the API caller. Tests inject a fake; the default uses the SDK. */
	readonly createMessage?: () => CreateMessage;
}

/** Runs the CLI and returns the exit code: 0 answered, 1 failed, 2 usage. */
export async function main(
	argv: readonly string[],
	io: CliIo,
): Promise<number> {
	const parsed = parseCliArgs(argv, io.env);
	if (parsed.kind === "help") {
		io.stdout.write(`${USAGE}\n`);
		return 0;
	}
	if (parsed.kind === "error") {
		io.stderr.write(`${parsed.message}\n\n${USAGE}\n`);
		return 2;
	}
	if (!io.createMessage && !hasCredentials(io.env)) {
		io.stderr.write(`${MISSING_KEY_MESSAGE}\n`);
		return 1;
	}
	const { options } = parsed;
	const out = makeStyle(useColor(io.env, io.stdout.isTTY ?? false));
	const err = makeStyle(useColor(io.env, io.stderr.isTTY ?? false));
	const createMessage = (io.createMessage ?? sdkCreateMessage)();

	io.stderr.write(
		err.dim(`Asking ${options.model} about scenario ${options.scenario}...\n`),
	);
	const session = await connectInProcess({ scenario: options.scenario });
	let trace: Trace;
	try {
		trace = await runAgent({
			question: options.question,
			session,
			createMessage,
			scenario: options.scenario,
			model: options.model,
			fallback: options.fallback,
			onToolCall: (call) => io.stderr.write(`  ${formatToolCall(call, err)}\n`),
		});
	} finally {
		await session.close();
	}
	const tracePath = await writeTrace(trace, options.traceDir);
	io.stdout.write(`\n${formatReport(trace, tracePath, out)}\n`);
	return trace.status === "answered" ? 0 : 1;
}

function sdkCreateMessage(): CreateMessage {
	const client = new Anthropic();
	return (params) => client.beta.messages.create(params);
}

function isScenario(value: string): value is ScenarioId {
	return (SCENARIO_IDS as readonly string[]).includes(value);
}

function nonEmpty(value: string | undefined): string | undefined {
	return value !== undefined && value.trim() !== "" ? value : undefined;
}
