import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import type { McpSession } from "./mcp.js";
import {
	addUsage,
	costUsd,
	DEFAULT_MODEL,
	type TokenUsage,
	ZERO_USAGE,
} from "./pricing.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";
import {
	type RunStatus,
	type ToolCallRecord,
	TRACE_VERSION,
	type Trace,
	type TurnRecord,
} from "./trace.js";

// The agent loop (PRD FR-27 to FR-31), shared by the CLI and the evals:
// send the question and the MCP tools to Claude, run the tool calls it asks
// for through the MCP client, and repeat until it answers or hits a cap.
// Never fork it: evals must measure the code the demo runs.

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type Message = Anthropic.Beta.BetaMessage;
type MessageParam = Anthropic.Beta.BetaMessageParam;

/** One Messages API call. The real one wraps the SDK; tests pass a fake. */
export type CreateMessage = (params: CreateParams) => Promise<Message>;

export const MAX_TOOL_CALLS = 12;
/** Model requests per run. A backstop for `pause_turn`, which uses no tool. */
export const MAX_TURNS = 20;
export const MAX_TOKENS = 16_000;
export const DEFAULT_EFFORT = "medium";
export type Effort = NonNullable<Anthropic.Beta.BetaOutputConfig["effort"]>;

/** Models the API can rescue with `fallbacks: "default"` after a refusal. */
const SERVER_FALLBACK_MODELS = new Set([
	"claude-sonnet-5-5",
	"claude-opus-5-5",
	"claude-opus-5",
]);
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export interface RunOptions {
	readonly question: string;
	readonly session: McpSession;
	readonly createMessage: CreateMessage;
	readonly scenario: string;
	readonly model?: string;
	readonly effort?: Effort;
	readonly maxToolCalls?: number;
	/**
	 * Ask the API to re-run a refused turn on another model. On for the CLI;
	 * off for evals, so a score measures one model. Ignored for models the
	 * API can't rescue (Haiku).
	 */
	readonly fallback?: boolean;
	/** Called after each tool call, for progress output. */
	readonly onToolCall?: (call: ToolCallRecord) => void;
	/** Injectable clock, so tests get stable latencies. */
	readonly now?: () => number;
}

/** Builds the API request for the current history. */
export function buildRequest(
	options: Pick<RunOptions, "session" | "model" | "effort" | "fallback">,
	messages: readonly MessageParam[],
): CreateParams {
	const model = options.model ?? DEFAULT_MODEL;
	const useFallback =
		(options.fallback ?? false) && SERVER_FALLBACK_MODELS.has(model);
	return {
		model,
		max_tokens: MAX_TOKENS,
		system: SYSTEM_PROMPT,
		tools: [...options.session.tools],
		// `auto` is the default and the only choice on Sonnet 5.5: forcing a
		// tool returns a 400 there (DECISIONS 2026-11-28).
		tool_choice: { type: "auto" },
		output_config: { effort: options.effort ?? DEFAULT_EFFORT },
		// Caches everything up to the last block, so each turn reads the tools,
		// system prompt and earlier turns from cache.
		cache_control: { type: "ephemeral" },
		messages: [...messages],
		...(useFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" } : {}),
	};
}

/** Runs the agent once and returns the full trace. Never throws for API errors. */
export async function runAgent(options: RunOptions): Promise<Trace> {
	const {
		question,
		session,
		createMessage,
		scenario,
		model = DEFAULT_MODEL,
		effort = DEFAULT_EFFORT,
		maxToolCalls = MAX_TOOL_CALLS,
		fallback = false,
		onToolCall,
		now = Date.now,
	} = options;
	const startedAt = new Date(now());
	const runStart = now();
	const messages: MessageParam[] = [{ role: "user", content: question }];
	const toolCalls: ToolCallRecord[] = [];
	const turns: TurnRecord[] = [];
	let status: RunStatus = "turn_cap";
	let stopMessage: string | null =
		`Stopped after ${MAX_TURNS} model requests without a final answer.`;
	let finalText = "";

	for (let turn = 1; turn <= MAX_TURNS; turn++) {
		const request = buildRequest(
			{ session, model, effort, fallback },
			messages,
		);
		const turnStart = now();
		let response: Message;
		try {
			response = await createMessage(request);
		} catch (error) {
			status = "api_error";
			stopMessage = describeApiError(error);
			break;
		}
		turns.push(turnRecord(turn, response, now() - turnStart));
		// Append the whole content, thinking blocks included: they must be
		// replayed unchanged, and history stays append-only.
		messages.push({ role: "assistant", content: response.content });
		finalText = textOf(response);

		const stop = response.stop_reason;
		if (stop === "pause_turn") continue;
		if (stop === "refusal") {
			status = "refusal";
			const category = response.stop_details?.category;
			stopMessage = `The model declined to continue${category ? ` (category: ${category})` : ""}.`;
			break;
		}
		if (stop === "max_tokens" || stop === "model_context_window_exceeded") {
			// Tool calls in a cut-off response may be incomplete: don't run them.
			status = "max_tokens";
			stopMessage = `The response hit the output limit (${MAX_TOKENS} tokens) before finishing.`;
			break;
		}
		const uses = response.content.filter(
			(block): block is Anthropic.Beta.BetaToolUseBlock =>
				block.type === "tool_use",
		);
		if (stop !== "tool_use" || uses.length === 0) {
			status = "answered";
			stopMessage = null;
			break;
		}

		// Run the calls that fit under the cap, in order, and return all their
		// results in one user message, as parallel calls expect.
		const allowed = uses.slice(0, maxToolCalls - toolCalls.length);
		const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
		for (const use of allowed) {
			const callStart = now();
			const outcome = await session.callTool(use.name, use.input);
			const record: ToolCallRecord = {
				index: toolCalls.length + 1,
				turn,
				id: use.id,
				name: use.name,
				arguments: use.input,
				result: outcome.text,
				is_error: outcome.isError,
				error_kind: outcome.errorKind,
				latency_ms: now() - callStart,
			};
			toolCalls.push(record);
			onToolCall?.(record);
			results.push({
				type: "tool_result",
				tool_use_id: use.id,
				content: outcome.text,
				...(outcome.isError ? { is_error: true } : {}),
			});
		}
		messages.push({ role: "user", content: results });
		if (toolCalls.length >= maxToolCalls) {
			status = "tool_cap";
			stopMessage = `Stopped at the ${maxToolCalls}-tool-call cap without a final answer. Try a narrower question.`;
			break;
		}
	}

	const usage = turns.reduce<TokenUsage>(
		(sum, t) => addUsage(sum, t.usage),
		ZERO_USAGE,
	);
	const costs = turns.map((t) => t.cost_usd);
	return {
		version: TRACE_VERSION,
		run_id: randomUUID().slice(0, 8),
		started_at: startedAt.toISOString(),
		question,
		scenario,
		model,
		served_models: [...new Set(turns.map((t) => t.model))],
		settings: { max_tool_calls: maxToolCalls, effort, fallback },
		status,
		stop_message: stopMessage,
		final_text: status === "answered" ? finalText : "",
		tool_calls: toolCalls,
		turns,
		usage,
		cost_usd: costs.some((c) => c === null)
			? null
			: costs.reduce<number>((sum, c) => sum + (c ?? 0), 0),
		latency_ms: now() - runStart,
		system: SYSTEM_PROMPT,
		tools: session.tools.map((t) => t.name),
		messages,
	};
}

/** The text blocks of a response, joined. Thinking blocks are not the answer. */
export function textOf(response: Message): string {
	return response.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n")
		.trim();
}

/**
 * A turn's usage and cost. With a refusal fallback, `usage.iterations` splits
 * the tokens by the model that spent them, so each part is priced at its own
 * model's rates.
 */
function turnRecord(
	turn: number,
	response: Message,
	latencyMs: number,
): TurnRecord {
	const usage = tokenUsage(response.usage);
	const iterations = response.usage.iterations ?? [];
	const priced = iterations.flatMap((it) =>
		"model" in it && it.model
			? [{ model: it.model, usage: tokenUsage(it) }]
			: [],
	);
	// Use the split only when every part names its model; otherwise price
	// the total at the serving model's rates rather than drop tokens.
	const parts =
		priced.length > 0 && priced.length === iterations.length
			? priced
			: [{ model: response.model, usage }];
	const costs = parts.map((p) => costUsd(p.model, p.usage));
	return {
		turn,
		model: response.model,
		stop_reason: response.stop_reason,
		usage,
		cost_usd: costs.some((c) => c === null)
			? null
			: costs.reduce<number>((sum, c) => sum + (c ?? 0), 0),
		latency_ms: latencyMs,
	};
}

function tokenUsage(usage: {
	input_tokens: number;
	output_tokens: number;
	cache_creation_input_tokens: number | null;
	cache_read_input_tokens: number | null;
}): TokenUsage {
	return {
		input_tokens: usage.input_tokens,
		output_tokens: usage.output_tokens,
		cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
		cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
	};
}

function describeApiError(error: unknown): string {
	if (error instanceof Anthropic.AuthenticationError) {
		return "The Claude API rejected the API key. Check ANTHROPIC_API_KEY in .env.";
	}
	if (error instanceof Anthropic.RateLimitError) {
		return "The Claude API rate limit was hit, even after retries. Wait a minute and try again.";
	}
	if (error instanceof Anthropic.APIError) {
		return `Claude API error${error.status ? ` ${error.status}` : ""}: ${error.message}`;
	}
	return `Request failed: ${error instanceof Error ? error.message : String(error)}`;
}
