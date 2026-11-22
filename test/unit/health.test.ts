import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/domain/fixtures.js";
import {
	compareToSlo,
	getServiceHealth,
	getSignal,
	listUnhealthyServices,
} from "../../src/domain/health.js";
import { loadScenario } from "../../src/domain/scenarios.js";
import type { Scenario, ScenarioId } from "../../src/domain/schemas.js";
import { service } from "./helpers.js";

const catalog = loadCatalog();

describe("getServiceHealth", () => {
	it("compares S1 checkout-api to its SLOs", () => {
		const scenario = loadScenario("checkout-latency");
		expect(getServiceHealth(scenario, service("checkout-api"))).toEqual({
			service: service("checkout-api"),
			signal: getSignal(scenario, "checkout-api"),
			slo: {
				p95_ms: { value: 2400, limit: 600, breached: true },
				error_rate_pct: { value: 0.6, limit: 0.05, breached: true },
			},
		});
	});

	it("reports each SLO separately: S2 auth is fast but failing", () => {
		const scenario = loadScenario("auth-cert-expiry");
		expect(getServiceHealth(scenario, service("auth")).slo).toEqual({
			p95_ms: { value: 38, limit: 150, breached: false },
			error_rate_pct: { value: 41, limit: 0.01, breached: true },
		});
	});

	it.each([
		[150, 0.01, false, false],
		[151, 0.01, true, false],
		[150, 0.011, false, true],
	])(
		"at p95 %d and %d%% errors, breaches are %s and %s",
		(p95_ms, error_rate_pct, slow, failing) => {
			const slo = compareToSlo({ p95_ms, error_rate_pct }, service("auth"));
			expect(slo.p95_ms.breached).toBe(slow);
			expect(slo.error_rate_pct.breached).toBe(failing);
		},
	);

	it("throws when a scenario has no signal for the service", () => {
		const scenario = { ...loadScenario("false-alarm"), signals: [] };
		expect(() => getServiceHealth(scenario, service("auth"))).toThrow(
			'no signal for "auth"',
		);
	});
});

describe("listUnhealthyServices", () => {
	it.each<[ScenarioId, string[]]>([
		["checkout-latency", ["checkout-api", "payment-gateway"]],
		["ack-guardrail", ["checkout-api", "payment-gateway"]],
		["auth-cert-expiry", ["web-app", "checkout-api", "auth", "scheduling-api"]],
		["false-alarm", []],
		["unknown-service", []],
		["blast-radius", ["web-app", "search-index"]],
	])("%s: %j", (id, expected) => {
		const unhealthy = listUnhealthyServices(catalog, loadScenario(id));
		expect(unhealthy.map((h) => h.service.id)).toEqual(expected);
	});

	it("puts down before degraded", () => {
		const base = loadScenario("checkout-latency");
		const scenario: Scenario = {
			...base,
			signals: base.signals.map((s) =>
				s.service_id === "core-db" ? { ...s, status: "down" } : s,
			),
		};
		expect(
			listUnhealthyServices(catalog, scenario).map((h) => h.service.id),
		).toEqual(["core-db", "checkout-api", "payment-gateway"]);
	});
});
