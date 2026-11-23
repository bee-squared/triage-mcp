import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/domain/fixtures.js";
import { type Direction, walkDependencies } from "../../src/domain/graph.js";
import { loadScenario } from "../../src/domain/scenarios.js";
import type { ScenarioId } from "../../src/domain/schemas.js";
import { service } from "./helpers.js";

const catalog = loadCatalog();

function walk(
	scenario: ScenarioId,
	id: string,
	direction: Direction,
	depth?: number,
) {
	return walkDependencies(
		catalog,
		loadScenario(scenario),
		service(id),
		direction,
		depth,
	);
}
const ids = (related: ReturnType<typeof walk>) =>
	related.map((r) => r.service.id);

describe("walkDependencies", () => {
	it("leads from checkout-api to payment-gateway (S1)", () => {
		expect(walk("checkout-latency", "checkout-api", "upstream")[0]).toEqual({
			service: service("payment-gateway"),
			status: "degraded",
			depth: 1,
			via: [
				{
					from_service_id: "checkout-api",
					to_service_id: "payment-gateway",
					kind: "sync",
				},
			],
		});
	});

	it("never blames notifications for auth (S2)", () => {
		expect(ids(walk("auth-cert-expiry", "auth", "upstream", 3))).toEqual([
			"core-db",
		]);
	});

	it("limits the impact of search-index to web-app (S6)", () => {
		expect(ids(walk("blast-radius", "search-index", "downstream", 3))).toEqual([
			"web-app",
		]);
	});

	it("stops at the requested depth, which defaults to 2", () => {
		const at = (depth?: number) =>
			ids(walk("false-alarm", "notifications", "downstream", depth));
		expect(at(1)).toEqual(["billing", "scheduling-api"]);
		expect(at()).toEqual([
			"billing",
			"scheduling-api",
			"web-app",
			"checkout-api",
		]);
		// Here a third hop adds edges, so a default of 3 would differ.
		expect(walk("false-alarm", "web-app", "upstream")).toEqual(
			walk("false-alarm", "web-app", "upstream", 2),
		);
	});

	it("reaches a third hop only at depth 3", () => {
		const find = (depth: number) =>
			walk("false-alarm", "web-app", "upstream", depth).find(
				(r) => r.service.id === "notifications",
			);
		// Two hops through scheduling-api, three through billing.
		expect(find(2)?.via).toHaveLength(1);
		expect(find(3)).toMatchObject({ depth: 2 });
		expect(find(3)?.via.map((e) => e.from_service_id)).toEqual([
			"scheduling-api",
			"billing",
		]);
	});

	it("lists a shared dependency once, at its shortest depth, with every edge", () => {
		const related = walk("false-alarm", "checkout-api", "upstream");
		expect(new Set(ids(related)).size).toBe(related.length);
		const db = related.find((r) => r.service.id === "core-db");
		expect(db?.depth).toBe(1);
		expect(db?.via.map((e) => e.from_service_id)).toEqual([
			"checkout-api",
			"payment-gateway",
			"billing",
			"auth",
		]);
	});

	it("keeps each edge's kind", () => {
		const related = walk("false-alarm", "checkout-api", "upstream", 1);
		const billing = related.find((r) => r.service.id === "billing");
		expect(billing?.via.map((e) => e.kind)).toEqual(["async"]);
	});

	it("puts a distant unhealthy service ahead of nearer healthy ones", () => {
		// By distance alone these would be 7th and 8th, past the default cap of 5.
		const related = walk("blast-radius", "core-db", "downstream");
		expect(related).toHaveLength(8);
		expect(ids(related).slice(0, 2)).toEqual(["search-index", "web-app"]);
		expect(related[1]?.depth).toBe(2);
	});

	it("returns nothing for a service with no edges that way", () => {
		expect(walk("false-alarm", "core-db", "upstream")).toEqual([]);
		expect(walk("false-alarm", "web-app", "downstream")).toEqual([]);
	});

	it("terminates on a cycle and never lists the starting service", () => {
		const cyclic = {
			...catalog,
			dependencies: [
				{ from_service_id: "auth", to_service_id: "billing", kind: "sync" },
				{ from_service_id: "billing", to_service_id: "auth", kind: "sync" },
			] as const,
		};
		const related = walkDependencies(
			cyclic,
			loadScenario("false-alarm"),
			service("auth"),
			"upstream",
			3,
		);
		expect(ids(related)).toEqual(["billing"]);
	});

	it.each([0, 4, 1.5, Number.NaN])("rejects depth %d", (depth) => {
		expect(() => walk("false-alarm", "auth", "upstream", depth)).toThrow(
			RangeError,
		);
	});
});
