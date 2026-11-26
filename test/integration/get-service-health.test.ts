import { afterEach, describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/domain/fixtures.js";
import type { ScenarioId } from "../../src/domain/schemas.js";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

let h: Harness | undefined;
afterEach(() => h?.close());

async function health(
	scenario: ScenarioId,
	args: Record<string, unknown> = {},
) {
	h = await connect({ scenario });
	return h.call("get_service_health", args);
}

describe("get_service_health for one service", () => {
	it("gives S1 checkout-api's status and breached SLOs, concisely", async () => {
		const result = await health("checkout-latency", {
			service: "checkout-api",
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			scenario_id: "checkout-latency",
			services: [
				{
					service_id: "checkout-api",
					status: "degraded",
					slo_breaches: [
						{ metric: "p95_ms", value: 2400, limit: 600 },
						{ metric: "error_rate_pct", value: 0.6, limit: 0.05 },
					],
				},
			],
			more_available: 0,
		});
		expect(textOf(result)).toBe(
			"- checkout-api: degraded, p95 2400 ms, over the 600 ms SLO; error rate 0.6%, over the 0.05% budget.",
		);
	});

	it("finds a service by display name, ignoring case", async () => {
		const result = await health("checkout-latency", {
			service: "payment GATEWAY",
		});
		expect(result.structuredContent).toMatchObject({
			services: [{ service_id: "payment-gateway" }],
		});
	});

	it("adds the full record when detailed", async () => {
		const result = await health("checkout-latency", {
			service: "checkout-api",
			response_format: "detailed",
		});
		expect(result.structuredContent).toMatchObject({
			services: [
				{
					service_id: "checkout-api",
					name: "Checkout API",
					team_id: "payments",
					tier: 1,
					description: expect.stringContaining("Builds carts"),
					slo: {
						p95_ms: { value: 2400, limit: 600, breached: true },
						error_rate_pct: { value: 0.6, limit: 0.05, breached: true },
					},
					throughput_rpm: 880,
					log_excerpts: [
						expect.stringContaining("payment-gateway /authorize"),
						expect.any(String),
					],
				},
			],
		});
		expect(textOf(result).split("\n")).toEqual([
			"- checkout-api (Checkout API, team payments, tier 1): degraded.",
			expect.stringContaining("Builds carts"),
			"  p95 2400 ms vs 600 ms SLO (breached); error rate 0.6% vs 0.05% budget (breached); 880 requests per minute.",
			expect.stringMatching(/^ {2}log: POST \/checkout\/confirm/),
			expect.stringMatching(/^ {2}log: Upstream timeout/),
		]);
	});

	it("reports a service within SLO without its numbers when concise", async () => {
		const result = await health("checkout-latency", { service: "core-db" });
		expect(textOf(result)).toBe("- core-db: healthy, within SLO.");
		expect(result.structuredContent).toMatchObject({
			services: [
				{ service_id: "core-db", status: "healthy", slo_breaches: [] },
			],
		});
	});

	it("keeps concise under 40% of detailed across S1's services (FR-15)", async () => {
		h = await connect({ scenario: "checkout-latency" });
		const size = { concise: 0, detailed: 0 };
		for (const { id } of loadCatalog().services) {
			for (const format of ["concise", "detailed"] as const) {
				const result = await h.call("get_service_health", {
					service: id,
					response_format: format,
				});
				size[format] += JSON.stringify(result).length;
			}
		}
		expect(size.concise).toBeLessThan(size.detailed * 0.4);
	});
});

describe("get_service_health with no service", () => {
	it("lists S1's unhealthy services worst first", async () => {
		const result = await health("checkout-latency");
		expect(result.structuredContent).toMatchObject({
			services: [
				{ service_id: "checkout-api" },
				{ service_id: "payment-gateway" },
			],
			more_available: 0,
		});
		expect(textOf(result)).toMatch(
			/^2 of 10 services are not healthy \(8 healthy\)/,
		);
	});

	it("says everything is healthy in S3, the false alarm", async () => {
		const result = await health("false-alarm");
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			scenario_id: "false-alarm",
			services: [],
			more_available: 0,
		});
		expect(textOf(result)).toBe(
			"All 10 services are healthy and within their SLOs.",
		);
	});

	it("caps the list and says how many more exist (FR-13)", async () => {
		const result = await health("auth-cert-expiry", { limit: 2 });
		expect(result.structuredContent).toMatchObject({ more_available: 2 });
		const services = (result.structuredContent as { services: unknown[] })
			.services;
		expect(services).toHaveLength(2);
		expect(textOf(result)).toMatch(/2 more not shown\. Raise `limit`/);
	});
});

describe("get_service_health for an unknown service (FR-14)", () => {
	it("suggests billing for billing-v2 and never answers for it (S4)", async () => {
		const result = await health("unknown-service", { service: "billing-v2" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(errorMeta(result)).toEqual({
			kind: "not_found",
			suggestions: ["billing"],
		});
		expect(textOf(result)).toBe(
			'No service matches "billing-v2". Did you mean `billing`?',
		);
	});

	it("suggests at most 3 services", async () => {
		const result = await health("checkout-latency", { service: "api" });
		const suggestions = errorMeta(result)?.suggestions ?? [];
		expect(suggestions.length).toBeGreaterThan(0);
		expect(suggestions.length).toBeLessThanOrEqual(3);
	});

	it("gives a next step when nothing is close", async () => {
		const result = await health("checkout-latency", { service: "kafka" });
		expect(errorMeta(result)).toEqual({ kind: "not_found", suggestions: [] });
		expect(textOf(result)).toMatch(/Call get_service_health without `service`/);
	});
});
