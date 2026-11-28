import { describe, expect, it } from "vitest";
import {
	AGENT_MODELS,
	addUsage,
	costUsd,
	isAgentModel,
	PRICES,
	ZERO_USAGE,
} from "../../src/agent/pricing.js";

describe("pricing", () => {
	it("prices every model the agent accepts", () => {
		for (const model of AGENT_MODELS) expect(PRICES[model]).toBeDefined();
	});

	it("bills each kind of token at its own rate", () => {
		const usage = {
			input_tokens: 1_000_000,
			output_tokens: 1_000_000,
			cache_creation_input_tokens: 1_000_000,
			cache_read_input_tokens: 1_000_000,
		};
		expect(costUsd("claude-sonnet-5-5", usage)).toBeCloseTo(2 + 10 + 2.5 + 0.1);
		expect(costUsd("claude-haiku-5-5", usage)).toBeCloseTo(
			0.1 + 0.5 + 0.125 + 0.01,
		);
	});

	it("charges 1.25x input for a 5-minute cache write", () => {
		for (const price of Object.values(PRICES)) {
			expect(price.cacheWrite).toBeCloseTo(price.input * 1.25);
		}
	});

	it("returns null for a model it doesn't know", () => {
		expect(costUsd("claude-unknown", ZERO_USAGE)).toBeNull();
	});

	it("adds usage field by field", () => {
		const one = {
			input_tokens: 1,
			output_tokens: 2,
			cache_creation_input_tokens: 3,
			cache_read_input_tokens: 4,
		};
		expect(addUsage(one, one)).toEqual({
			input_tokens: 2,
			output_tokens: 4,
			cache_creation_input_tokens: 6,
			cache_read_input_tokens: 8,
		});
	});

	it("accepts only the listed agent models", () => {
		expect(isAgentModel("claude-sonnet-5-5")).toBe(true);
		expect(isAgentModel("claude-sonnet-5")).toBe(false);
	});
});
