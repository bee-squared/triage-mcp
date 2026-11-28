// What a run costs, from the token counts the API reports. Prices are USD per
// million tokens, first-party Claude API rates as of 2026-11. Cache writes
// use the 5-minute rate (1.25x input), the only TTL the agent sends.
//
// The table lists every model the agent may run on: the CLI and evals accept
// only these (FR-28, FR-42), plus the models a server-side refusal fallback
// can hand a turn to, so a fallback turn is still priced.

export interface ModelPrice {
	readonly input: number;
	readonly output: number;
	readonly cacheWrite: number;
	readonly cacheRead: number;
}

export const DEFAULT_MODEL = "claude-sonnet-5-5";

/** Models the CLI and evals accept with `--model`. */
export const AGENT_MODELS = [
	"claude-sonnet-5-5",
	"claude-haiku-5-5",
	"claude-opus-5-5",
] as const;
export type AgentModel = (typeof AGENT_MODELS)[number];

export const PRICES: Readonly<Record<string, ModelPrice>> = {
	"claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
	"claude-sonnet-5-5": {
		input: 2,
		output: 10,
		cacheWrite: 2.5,
		cacheRead: 0.1,
	},
	// Prompts up to 100K tokens. A triage run stays far below that.
	"claude-haiku-5-5": {
		input: 0.1,
		output: 0.5,
		cacheWrite: 0.125,
		cacheRead: 0.01,
	},
	// Refusal fallback targets.
	"claude-sonnet-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 },
	"claude-opus-5": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
	"claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

/** The four token counts that are billed at different rates. */
export interface TokenUsage {
	readonly input_tokens: number;
	readonly output_tokens: number;
	readonly cache_creation_input_tokens: number;
	readonly cache_read_input_tokens: number;
}

export const ZERO_USAGE: TokenUsage = {
	input_tokens: 0,
	output_tokens: 0,
	cache_creation_input_tokens: 0,
	cache_read_input_tokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
	return {
		input_tokens: a.input_tokens + b.input_tokens,
		output_tokens: a.output_tokens + b.output_tokens,
		cache_creation_input_tokens:
			a.cache_creation_input_tokens + b.cache_creation_input_tokens,
		cache_read_input_tokens:
			a.cache_read_input_tokens + b.cache_read_input_tokens,
	};
}

export function isAgentModel(model: string): model is AgentModel {
	return (AGENT_MODELS as readonly string[]).includes(model);
}

/** Cost in USD, or `null` for a model missing from the table. */
export function costUsd(model: string, usage: TokenUsage): number | null {
	const price = PRICES[model];
	if (!price) return null;
	const perToken =
		usage.input_tokens * price.input +
		usage.output_tokens * price.output +
		usage.cache_creation_input_tokens * price.cacheWrite +
		usage.cache_read_input_tokens * price.cacheRead;
	return perToken / 1_000_000;
}
