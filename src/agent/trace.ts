import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import type { ErrorKind } from "../tools/_shared.js";
import type { TokenUsage } from "./pricing.js";

// The JSON trace of one agent run (PRD FR-30): every message as sent, each
// tool call with its arguments, result and latency, and per-turn token usage
// and cost. Eval scorers read traces, and so does a person asking "which
// call went wrong?" (US-10), so the shape is versioned.

export const TRACE_VERSION = 1;
export const DEFAULT_TRACE_DIR = ".traces";

/** How a run ended. Only `answered` produced a final answer. */
export type RunStatus =
	| "answered"
	| "tool_cap"
	| "refusal"
	| "max_tokens"
	| "turn_cap"
	| "api_error";

export interface ToolCallRecord {
	/** 1-based position across the whole run. */
	readonly index: number;
	/** The model turn that asked for it. */
	readonly turn: number;
	readonly id: string;
	readonly name: string;
	readonly arguments: unknown;
	readonly result: string;
	readonly is_error: boolean;
	readonly error_kind: ErrorKind | "protocol" | null;
	readonly latency_ms: number;
}

export interface TurnRecord {
	readonly turn: number;
	/** The model that answered: differs from the requested one on a fallback. */
	readonly model: string;
	readonly stop_reason: string | null;
	readonly usage: TokenUsage;
	readonly cost_usd: number | null;
	readonly latency_ms: number;
}

export interface Trace {
	readonly version: typeof TRACE_VERSION;
	readonly run_id: string;
	readonly started_at: string;
	readonly question: string;
	readonly scenario: string;
	readonly model: string;
	readonly served_models: readonly string[];
	readonly settings: {
		readonly max_tool_calls: number;
		readonly effort: string;
		readonly fallback: boolean;
	};
	readonly status: RunStatus;
	/** Why the run stopped without an answer, in words a person can act on. */
	readonly stop_message: string | null;
	readonly final_text: string;
	readonly tool_calls: readonly ToolCallRecord[];
	readonly turns: readonly TurnRecord[];
	readonly usage: TokenUsage;
	/** `null` when a turn ran on a model missing from the pricing table. */
	readonly cost_usd: number | null;
	readonly latency_ms: number;
	readonly system: string;
	readonly tools: readonly string[];
	readonly messages: readonly Anthropic.Beta.BetaMessageParam[];
}

/** Writes the trace as pretty JSON and returns its path. */
export async function writeTrace(
	trace: Trace,
	dir: string = DEFAULT_TRACE_DIR,
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const stamp = trace.started_at.replace(/[:.]/g, "-");
	const path = join(dir, `${stamp}-${trace.scenario}-${trace.run_id}.json`);
	await writeFile(path, `${JSON.stringify(trace, null, "\t")}\n`, "utf8");
	return path;
}
