import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
	it("applies defaults when nothing is set (FR-5)", () => {
		expect(loadConfig({})).toEqual({
			SCENARIO: "checkout-latency",
			ALLOWED_HOSTS: ["localhost", "127.0.0.1"],
			RATE_LIMIT_PER_MINUTE: 60,
		});
	});

	it("treats empty values as unset, as in .env.example", () => {
		const config = loadConfig({ ANTHROPIC_API_KEY: "", SCENARIO: " " });
		expect(config.ANTHROPIC_API_KEY).toBeUndefined();
		expect(config.SCENARIO).toBe("checkout-latency");
	});

	it("parses values", () => {
		expect(
			loadConfig({
				SCENARIO: "blast-radius",
				ANTHROPIC_API_KEY: "test-key",
				ALLOWED_HOSTS: " triage.example.com , localhost,",
				RATE_LIMIT_PER_MINUTE: "120",
			}),
		).toEqual({
			SCENARIO: "blast-radius",
			ANTHROPIC_API_KEY: "test-key",
			ALLOWED_HOSTS: ["triage.example.com", "localhost"],
			RATE_LIMIT_PER_MINUTE: 120,
		});
	});

	it("names the variable and the accepted values for a bad scenario", () => {
		expect(() => loadConfig({ SCENARIO: "billing-v2" })).toThrow(ConfigError);
		expect(() => loadConfig({ SCENARIO: "billing-v2" })).toThrow(
			/SCENARIO: .*checkout-latency.*blast-radius/,
		);
	});

	it("rejects a bad rate limit and an empty host list", () => {
		expect(() => loadConfig({ RATE_LIMIT_PER_MINUTE: "lots" })).toThrow(
			/RATE_LIMIT_PER_MINUTE: /,
		);
		expect(() => loadConfig({ ALLOWED_HOSTS: ",," })).toThrow(
			/ALLOWED_HOSTS: must list at least one host/,
		);
	});
});
