import { afterEach, describe, expect, it } from "vitest";
import type { ScenarioId } from "../../src/domain/schemas.js";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

let h: Harness | undefined;
afterEach(() => h?.close());

async function deps(scenario: ScenarioId, args: Record<string, unknown>) {
	h = await connect({ scenario });
	return h.call("get_service_dependencies", args);
}

interface Related {
	service_id: string;
	status: string;
	depth: number;
	via: { service_id: string; kind: string }[];
	also_via: { service_id: string; kind: string }[];
}
const related = (result: { structuredContent?: unknown }) =>
	(result.structuredContent as { related: Related[] }).related;

describe("get_service_dependencies upstream", () => {
	it("finds S1's degraded payment-gateway first, one hop up from checkout-api", async () => {
		const result = await deps("checkout-latency", {
			service: "checkout-api",
			direction: "upstream",
			depth: 1,
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			service: {
				service_id: "checkout-api",
				name: "Checkout API",
				status: "degraded",
			},
			direction: "upstream",
			depth: 1,
			more_available: 0,
		});
		expect(related(result).map((r) => r.service_id)).toEqual([
			"payment-gateway",
			"billing",
			"auth",
			"core-db",
		]);
		expect(related(result)[0]).toEqual({
			service_id: "payment-gateway",
			name: "Payment Gateway",
			team_id: "payments",
			status: "degraded",
			depth: 1,
			via: [{ service_id: "checkout-api", kind: "sync" }],
			also_via: [],
		});
		expect(textOf(result)).toContain(
			"- billing (Billing, team payments): healthy, 1 hop, via checkout-api (async)",
		);
	});

	it("defaults to 2 hops", async () => {
		const result = await deps("checkout-latency", {
			service: "web-app",
			direction: "upstream",
		});
		expect(result.structuredContent).toMatchObject({ depth: 2 });
		expect(Math.max(...related(result).map((r) => r.depth))).toBe(2);
	});

	it("says what to try when there is nothing upstream", async () => {
		const result = await deps("checkout-latency", {
			service: "core-db",
			direction: "upstream",
		});
		expect(result.isError).toBeFalsy();
		expect(related(result)).toEqual([]);
		expect(textOf(result)).toBe(
			"core-db depends on no other service. Use direction `downstream` to see what depends on it.",
		);
	});
});

describe("get_service_dependencies downstream", () => {
	it("puts both failing services first in S6's blast radius from core-db", async () => {
		const result = await deps("blast-radius", {
			service: "core-db",
			direction: "downstream",
		});
		const shown = related(result);
		expect(shown.slice(0, 2).map((r) => [r.service_id, r.status])).toEqual([
			["search-index", "degraded"],
			["web-app", "degraded"],
		]);
		expect(shown).toHaveLength(5);
		expect(result.structuredContent).toMatchObject({ more_available: 3 });
		expect(textOf(result)).toMatch(
			/3 more not shown\. Raise `limit` \(at most 20\) or lower `depth`\.$/,
		);
	});

	it("separates shortest-path edges from the others", async () => {
		const result = await deps("blast-radius", {
			service: "core-db",
			direction: "downstream",
			limit: 20,
		});
		const checkout = related(result).find(
			(r) => r.service_id === "checkout-api",
		);
		expect(checkout).toMatchObject({
			depth: 1,
			via: [{ service_id: "core-db", kind: "sync" }],
			also_via: expect.arrayContaining([
				{ service_id: "billing", kind: "async" },
			]),
		});
		expect(textOf(result)).toContain(
			"checkout-api (Checkout API, team payments): healthy, 1 hop, via core-db (sync); also via auth (sync), payment-gateway (sync), billing (async)",
		);
		const webApp = related(result).find((r) => r.service_id === "web-app");
		expect(webApp?.via.map((v) => v.service_id).sort()).toEqual([
			"auth",
			"checkout-api",
			"scheduling-api",
			"search-index",
		]);
		expect(result.structuredContent).toMatchObject({ more_available: 0 });
	});

	it("says what to try when nothing depends on the service", async () => {
		const result = await deps("checkout-latency", {
			service: "Web App",
			direction: "downstream",
		});
		expect(textOf(result)).toBe(
			"No service depends on web-app. Use direction `upstream` to see what it depends on.",
		);
	});
});

describe("get_service_dependencies for an unknown service", () => {
	it("returns not-found with at most 3 suggestions", async () => {
		const result = await deps("checkout-latency", {
			service: "checkout",
			direction: "upstream",
		});
		expect(result.isError).toBe(true);
		const meta = errorMeta(result);
		expect(meta?.kind).toBe("not_found");
		expect(meta?.suggestions[0]).toBe("checkout-api");
		expect(meta?.suggestions.length).toBeLessThanOrEqual(3);
	});
});
