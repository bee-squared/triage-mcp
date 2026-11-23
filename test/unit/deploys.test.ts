import { describe, expect, it } from "vitest";
import {
	type DeployQuery,
	listRecentDeploys,
} from "../../src/domain/deploys.js";
import { loadScenario } from "../../src/domain/scenarios.js";
import type { ScenarioId } from "../../src/domain/schemas.js";
import { service } from "./helpers.js";

const list = (scenario: ScenarioId, query?: DeployQuery) =>
	listRecentDeploys(loadScenario(scenario), query).map((d) => d.id);

describe("listRecentDeploys", () => {
	it.each<[ScenarioId, string[]]>([
		["checkout-latency", ["DEP-1001", "DEP-1002"]],
		["ack-guardrail", ["DEP-1001", "DEP-1002"]],
		["auth-cert-expiry", ["DEP-2001", "DEP-2002"]],
		["false-alarm", ["DEP-3001", "DEP-3002"]],
		["unknown-service", ["DEP-4001"]],
		["blast-radius", ["DEP-6001", "DEP-6002"]],
	])("%s, last 60 minutes by default: %j", (id, expected) => {
		expect(list(id)).toEqual(expected);
	});

	it.each([
		[11, []],
		[12, ["DEP-1001"]],
		[180, ["DEP-1001", "DEP-1002", "DEP-1003"]],
		[1440, ["DEP-1001", "DEP-1002", "DEP-1003", "DEP-1004"]],
	])(
		"includes the edge of a %d minute window: %j",
		(withinMinutes, expected) => {
			expect(list("checkout-latency", { withinMinutes })).toEqual(expected);
		},
	);

	it("has a default window of exactly 60 minutes, and a minimum of 1", () => {
		const base = loadScenario("checkout-latency");
		const [deploy] = base.deploys;
		if (!deploy) throw new Error("S1 has no deploys");
		const deploys = [1, 60, 61].map((minutes_before_start) => ({
			...deploy,
			minutes_before_start,
		}));
		const ages = (query?: DeployQuery) =>
			listRecentDeploys({ ...base, deploys }, query).map(
				(d) => d.minutes_before_start,
			);
		expect(ages()).toEqual([1, 60]);
		expect(ages({ withinMinutes: 1 })).toEqual([1]);
	});

	it("filters by service", () => {
		expect(
			list("checkout-latency", { service: service("payment-gateway") }),
		).toEqual(["DEP-1001"]);
	});

	it("applies the service and window together", () => {
		const web = service("web-app");
		expect(list("checkout-latency", { service: web })).toEqual([]);
		expect(
			list("checkout-latency", { service: web, withinMinutes: 180 }),
		).toEqual(["DEP-1003"]);
	});

	it("finds no auth deploy at any window (S2)", () => {
		expect(
			list("auth-cert-expiry", {
				service: service("auth"),
				withinMinutes: 1440,
			}),
		).toEqual([]);
	});

	it.each([0, -1, 1441, 1.5, Number.NaN])(
		"rejects a window of %d",
		(withinMinutes) => {
			expect(() => list("false-alarm", { withinMinutes })).toThrow(RangeError);
		},
	);
});
