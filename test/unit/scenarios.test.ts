import { describe, expect, it } from "vitest";
import signals from "../../fixtures/base/signals.json" with { type: "json" };
import ackGuardrail from "../../fixtures/scenarios/ack-guardrail.json" with {
	type: "json",
};
import authCertExpiry from "../../fixtures/scenarios/auth-cert-expiry.json" with {
	type: "json",
};
import blastRadius from "../../fixtures/scenarios/blast-radius.json" with {
	type: "json",
};
import checkoutLatency from "../../fixtures/scenarios/checkout-latency.json" with {
	type: "json",
};
import falseAlarm from "../../fixtures/scenarios/false-alarm.json" with {
	type: "json",
};
import unknownService from "../../fixtures/scenarios/unknown-service.json" with {
	type: "json",
};
import { ConfigError } from "../../src/config.js";
import { FixtureError, loadCatalog } from "../../src/domain/fixtures.js";
import {
	buildScenarios,
	errorBudgetPct,
	loadActiveScenario,
	loadScenario,
	loadScenarios,
	type RawScenarios,
	sloBreaches,
} from "../../src/domain/scenarios.js";
import { SCENARIO_IDS, type ScenarioId } from "../../src/domain/schemas.js";

type Rec = Record<string, unknown>;
interface MutableRaw {
	baseline: Rec[];
	scenarios: Record<
		ScenarioId,
		Rec & { signal_overrides?: Rec[]; deploys?: Rec[] }
	>;
}

const catalog = loadCatalog();

const raw = (): MutableRaw =>
	structuredClone({
		baseline: signals,
		scenarios: {
			"checkout-latency": checkoutLatency,
			"auth-cert-expiry": authCertExpiry,
			"false-alarm": falseAlarm,
			"unknown-service": unknownService,
			"ack-guardrail": ackGuardrail,
			"blast-radius": blastRadius,
		},
	}) as MutableRaw;

function at(records: Rec[] | undefined, index: number): Rec {
	const record = records?.[index];
	if (!record) throw new Error(`no fixture record at [${index}]`);
	return record;
}

function issuesFor(data: RawScenarios): string[] {
	try {
		buildScenarios(catalog, data);
	} catch (error) {
		expect(error).toBeInstanceOf(FixtureError);
		return (error as FixtureError).issues.map(
			(i) => `${i.file}: ${i.path}: ${i.message}`,
		);
	}
	throw new Error("expected buildScenarios to throw");
}

const signal = (id: ScenarioId, service: string) => {
	const found = loadScenario(id).signals.find((s) => s.service_id === service);
	if (!found) throw new Error(`no ${service} signal in ${id}`);
	return found;
};
const unhealthy = (id: ScenarioId) =>
	loadScenario(id)
		.signals.filter((s) => s.status !== "healthy")
		.map((s) => s.service_id);
/** Deploys `list_recent_deploys` returns with its default 60-minute window. */
const recentDeploys = (id: ScenarioId) =>
	loadScenario(id).deploys.filter((d) => d.minutes_before_start <= 60);

/** Everything `service` depends on, transitively (possible causes). */
function upstreamOf(service: string): Set<string> {
	const found = new Set<string>();
	const queue = [service];
	for (let next = queue.shift(); next; next = queue.shift()) {
		for (const edge of catalog.dependencies) {
			if (edge.from_service_id === next && !found.has(edge.to_service_id)) {
				found.add(edge.to_service_id);
				queue.push(edge.to_service_id);
			}
		}
	}
	return found;
}

describe("resolved scenarios (FR-4)", () => {
	const scenarios = loadScenarios();

	it("resolves all 6 MVP scenarios", () => {
		expect([...scenarios.keys()]).toEqual([...SCENARIO_IDS]);
	});

	it("has one signal per catalog service, in catalog order, tagged with the scenario", () => {
		const serviceIds = catalog.services.map((s) => s.id);
		for (const [id, scenario] of scenarios) {
			expect(scenario.signals.map((s) => s.service_id)).toEqual(serviceIds);
			for (const s of scenario.signals) expect(s.scenario_id).toBe(id);
			for (const d of scenario.deploys) expect(d.scenario_id).toBe(id);
		}
	});

	it("lists deploys newest first, owned by the service's team", () => {
		const owner = new Map(catalog.services.map((s) => [s.id, s.team_id]));
		for (const scenario of scenarios.values()) {
			const minutes = scenario.deploys.map((d) => d.minutes_before_start);
			expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
			for (const d of scenario.deploys) {
				expect(d.team_id).toBe(owner.get(d.service_id));
			}
		}
	});

	it("uses deploy IDs unique across data sets", () => {
		const ids = [...scenarios.values()]
			.filter((s) => s.id !== "ack-guardrail")
			.flatMap((s) => s.deploys.map((d) => d.id));
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("keeps every log excerpt under 200 characters, at most 5 per signal", () => {
		for (const scenario of scenarios.values()) {
			for (const s of scenario.signals) {
				expect(s.log_excerpts.length).toBeLessThanOrEqual(5);
				for (const line of s.log_excerpts) {
					expect(line.length).toBeLessThan(200);
				}
			}
		}
	});

	it("is memoized", () => {
		expect(loadScenarios()).toBe(scenarios);
	});
});

describe("scenario data sets (FR-35)", () => {
	it("S1: checkout-api p95 2.4s after a payment-gateway v3.8.1 deploy 12 minutes before", () => {
		const checkout = signal("checkout-latency", "checkout-api");
		expect(checkout.status).toBe("degraded");
		expect(checkout.p95_ms).toBe(2400);
		expect(signal("checkout-latency", "payment-gateway").status).toBe(
			"degraded",
		);
		const upstream = upstreamOf("checkout-api");
		const suspects = recentDeploys("checkout-latency").filter((d) =>
			upstream.has(d.service_id),
		);
		expect(suspects).toEqual([
			expect.objectContaining({
				service_id: "payment-gateway",
				version: "v3.8.1",
				minutes_before_start: 12,
			}),
		]);
	});

	it("S2: auth 401 spike, no auth deploy, and a notifications deploy as a red herring", () => {
		const auth = signal("auth-cert-expiry", "auth");
		expect(auth.status).not.toBe("healthy");
		expect(auth.log_excerpts.join(" ")).toMatch(/certificate expired/);
		expect(auth.log_excerpts.join(" ")).toMatch(/401/);
		const deploys = loadScenario("auth-cert-expiry").deploys;
		expect(deploys.map((d) => d.service_id)).not.toContain("auth");
		expect(recentDeploys("auth-cert-expiry")).toContainEqual(
			expect.objectContaining({ service_id: "notifications" }),
		);
		expect(signal("auth-cert-expiry", "notifications").status).toBe("healthy");
		// The red herring can't explain the symptoms: auth doesn't depend on it.
		expect(upstreamOf("auth")).not.toContain("notifications");
	});

	it("S3: every service is within its SLOs", () => {
		const services = new Map(catalog.services.map((s) => [s.id, s]));
		for (const s of loadScenario("false-alarm").signals) {
			expect(s.status, s.service_id).toBe("healthy");
			const service = services.get(s.service_id);
			if (!service) throw new Error(`unknown ${s.service_id}`);
			expect(sloBreaches(s, service), s.service_id).toEqual([]);
		}
	});

	it("S4: billing-v2 doesn't exist anywhere and nothing is unhealthy", () => {
		const scenario = loadScenario("unknown-service");
		expect(unhealthy("unknown-service")).toEqual([]);
		expect(JSON.stringify([scenario.signals, scenario.deploys])).not.toContain(
			"billing-v2",
		);
		expect(scenario.signals.map((s) => s.service_id)).toContain("billing");
	});

	it("S5: reuses S1's data under its own scenario ID", () => {
		const s1 = loadScenario("checkout-latency");
		const s5 = loadScenario("ack-guardrail");
		const strip = <T extends { scenario_id: string }>(records: readonly T[]) =>
			records.map(({ scenario_id: _, ...rest }) => rest);
		expect(strip(s5.signals)).toEqual(strip(s1.signals));
		expect(strip(s5.deploys)).toEqual(strip(s1.deploys));
		expect(s5.description).not.toBe(s1.description);
	});

	it("S6: search-index degraded, impact limited to web-app, checkout healthy", () => {
		expect(unhealthy("blast-radius").sort()).toEqual([
			"search-index",
			"web-app",
		]);
		expect(signal("blast-radius", "checkout-api").status).toBe("healthy");
		expect(upstreamOf("checkout-api")).not.toContain("search-index");
	});
});

describe("scenario selection (FR-5)", () => {
	it("defaults to checkout-latency", () => {
		expect(loadActiveScenario({}).id).toBe("checkout-latency");
	});

	it("follows SCENARIO", () => {
		expect(loadActiveScenario({ SCENARIO: "blast-radius" }).id).toBe(
			"blast-radius",
		);
	});

	it("rejects an unknown scenario with the accepted values", () => {
		expect(() => loadActiveScenario({ SCENARIO: "billing-v2" })).toThrow(
			ConfigError,
		);
		expect(() => loadActiveScenario({ SCENARIO: "billing-v2" })).toThrow(
			/checkout-latency/,
		);
	});
});

describe("SLO helpers", () => {
	const authService = catalog.services.find((s) => s.id === "auth");
	if (!authService) throw new Error("no auth service");

	it("derives the error budget from availability without float noise", () => {
		expect(errorBudgetPct(authService)).toBe(0.01);
	});

	it("reports each breached SLO", () => {
		expect(
			sloBreaches({ p95_ms: 150, error_rate_pct: 0.01 }, authService),
		).toEqual([]);
		expect(
			sloBreaches({ p95_ms: 151, error_rate_pct: 2 }, authService),
		).toEqual([
			"p95_ms 151 is above the 150 ms SLO",
			"error_rate_pct 2 is above the 0.01% error budget",
		]);
	});
});

describe("buildScenarios validation (FR-2)", () => {
	it("names the file and field for a schema error", () => {
		const data = raw();
		at(data.scenarios["checkout-latency"].deploys, 0).version = "3.8.1";
		at(data.baseline, 0).log_excerpts = ["x".repeat(200)];
		expect(issuesFor(data)).toEqual([
			"fixtures/base/signals.json: [0].log_excerpts[0]: must be under 200 characters",
			"fixtures/scenarios/checkout-latency.json: deploys[0].version: must be a version like `v3.8.1`",
		]);
	});

	it("rejects an empty override and a mix of extends and data", () => {
		const data = raw();
		data.scenarios["false-alarm"].signal_overrides = [
			{ service_id: "web-app" },
			{ service_id: "auth", p95_ms: undefined },
		];
		data.scenarios["ack-guardrail"].deploys = [];
		const issues = issuesFor(data);
		expect(issues).toEqual(
			expect.arrayContaining([
				"fixtures/scenarios/false-alarm.json: signal_overrides[0]: must override at least one field besides service_id",
				"fixtures/scenarios/false-alarm.json: signal_overrides[1]: must override at least one field besides service_id",
			]),
		);
		expect(issues).toContainEqual(
			expect.stringMatching(
				/^fixtures\/scenarios\/ack-guardrail\.json: \(root\): must have either `extends`/,
			),
		);
	});

	it("rejects broken baseline coverage", () => {
		const data = raw();
		data.baseline = data.baseline.filter((s) => s.service_id !== "core-db");
		data.baseline.push({ ...at(data.baseline, 0) });
		at(data.baseline, 1).status = "degraded";
		at(data.baseline, 2).service_id = "billing-v2";
		expect(issuesFor(data)).toEqual(
			expect.arrayContaining([
				'fixtures/base/signals.json: [1].status: baseline signals must be healthy, got "degraded"',
				'fixtures/base/signals.json: [2].service_id: unknown service "billing-v2"',
				'fixtures/base/signals.json: [9].service_id: duplicate value "web-app" (first used at [0])',
				'fixtures/base/signals.json: (root): no baseline signal for service "core-db"',
			]),
		);
	});

	it("rejects broken scenario references", () => {
		const data = raw();
		const s1 = data.scenarios["checkout-latency"];
		s1.id = "false-alarm";
		at(s1.signal_overrides, 0).service_id = "billing-v2";
		at(s1.signal_overrides, 2).service_id = "checkout-api";
		at(s1.deploys, 0).team_id = "platform";
		at(s1.deploys, 1).service_id = "billing-v2";
		at(data.scenarios["blast-radius"].deploys, 0).id = "DEP-1003";
		expect(issuesFor(data)).toEqual(
			expect.arrayContaining([
				'fixtures/scenarios/checkout-latency.json: id: must be "checkout-latency" to match the file name',
				'fixtures/scenarios/checkout-latency.json: signal_overrides[0].service_id: unknown service "billing-v2"',
				'fixtures/scenarios/checkout-latency.json: signal_overrides[2].service_id: service "checkout-api" is already overridden at signal_overrides[1]',
				'fixtures/scenarios/checkout-latency.json: deploys[0].team_id: "payment-gateway" is owned by "payments", not "platform"',
				'fixtures/scenarios/checkout-latency.json: deploys[1].service_id: unknown service "billing-v2"',
				'fixtures/scenarios/blast-radius.json: deploys[0].id: duplicate deploy ID "DEP-1003" (first used at fixtures/scenarios/checkout-latency.json: deploys[2])',
			]),
		);
	});

	it("rejects extending a scenario that itself extends, or itself", () => {
		const data = raw();
		data.scenarios["false-alarm"] = {
			id: "false-alarm",
			description: "Chained.",
			extends: "ack-guardrail",
		};
		data.scenarios["unknown-service"] = {
			id: "unknown-service",
			description: "Loop.",
			extends: "unknown-service",
		};
		expect(issuesFor(data)).toEqual([
			'fixtures/scenarios/false-alarm.json: extends: "ack-guardrail" extends another scenario; extend a data set directly',
			"fixtures/scenarios/unknown-service.json: extends: a scenario cannot extend itself",
		]);
	});

	it("rejects a status that contradicts the SLOs, pointing at the source record", () => {
		const data = raw();
		at(data.scenarios["checkout-latency"].signal_overrides, 1).status =
			"healthy";
		at(data.baseline, 4).p95_ms = 9000;
		const issues = issuesFor(data);
		expect(issues).toContain(
			'fixtures/scenarios/checkout-latency.json: signal_overrides[1]: status "healthy" but p95_ms 2400 is above the 600 ms SLO and error_rate_pct 0.6 is above the 0.05% error budget for "checkout-api"',
		);
		// The baseline problem surfaces once per data set that doesn't override auth.
		expect(issues).toContainEqual(
			expect.stringMatching(
				/^fixtures\/base\/signals\.json: \[4\]: status "healthy" but p95_ms 9000 is above the 150 ms SLO for "auth"$/,
			),
		);
		const degraded = raw();
		at(degraded.scenarios["blast-radius"].signal_overrides, 0).error_rate_pct =
			0.01;
		expect(issuesFor(degraded)).toEqual([
			'fixtures/scenarios/blast-radius.json: signal_overrides[0]: status "degraded" but "web-app" is within its SLOs; raise p95_ms or error_rate_pct, or mark it healthy',
		]);
	});

	it("reports a missing scenario file", () => {
		const { "blast-radius": _, ...rest } = raw().scenarios;
		const data = { baseline: signals, scenarios: rest } as RawScenarios;
		expect(issuesFor(data)).toEqual([
			expect.stringMatching(
				/^fixtures\/scenarios\/blast-radius\.json: \(root\): /,
			),
		]);
	});
});
