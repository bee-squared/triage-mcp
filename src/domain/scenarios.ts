import signalsJson from "../../fixtures/base/signals.json" with {
	type: "json",
};
import ackGuardrailJson from "../../fixtures/scenarios/ack-guardrail.json" with {
	type: "json",
};
import authCertExpiryJson from "../../fixtures/scenarios/auth-cert-expiry.json" with {
	type: "json",
};
import blastRadiusJson from "../../fixtures/scenarios/blast-radius.json" with {
	type: "json",
};
import checkoutLatencyJson from "../../fixtures/scenarios/checkout-latency.json" with {
	type: "json",
};
import falseAlarmJson from "../../fixtures/scenarios/false-alarm.json" with {
	type: "json",
};
import unknownServiceJson from "../../fixtures/scenarios/unknown-service.json" with {
	type: "json",
};
import { loadConfig } from "../config.js";
import {
	type Catalog,
	FixtureError,
	type FixtureIssue,
	loadCatalog,
	parseFixture,
} from "./fixtures.js";
import {
	type BaselineSignal,
	BaselineSignalsFileSchema,
	type Deploy,
	SCENARIO_IDS,
	type Scenario,
	type ScenarioFile,
	ScenarioFileSchema,
	type ScenarioId,
	type Service,
	type SignalSnapshot,
} from "./schemas.js";

// A scenario is a healthy baseline (one signal per service) plus a small file
// of overrides and deploys. The resolver merges them into the PRD's shape: a
// full SignalSnapshot per service per scenario (FR-4). Storing only the
// differences keeps each data set readable and the healthy records in one place.

export const BASELINE_FILE = "fixtures/base/signals.json";

export const SCENARIO_FILES = Object.fromEntries(
	SCENARIO_IDS.map((id) => [id, `fixtures/scenarios/${id}.json`]),
) as Record<ScenarioId, string>;

export interface RawScenarios {
	readonly baseline: unknown;
	readonly scenarios: Readonly<Record<ScenarioId, unknown>>;
}

/** Error budget implied by an availability SLO, as a percentage of requests. */
export function errorBudgetPct(service: Service): number {
	return Math.round((100 - service.slo_availability_pct) * 1e6) / 1e6;
}

/** Which SLOs a signal breaches. Empty means within SLO. */
export function sloBreaches(
	signal: Pick<BaselineSignal, "p95_ms" | "error_rate_pct">,
	service: Service,
): string[] {
	const breaches: string[] = [];
	if (signal.p95_ms > service.slo_p95_ms) {
		breaches.push(
			`p95_ms ${signal.p95_ms} is above the ${service.slo_p95_ms} ms SLO`,
		);
	}
	const budget = errorBudgetPct(service);
	if (signal.error_rate_pct > budget) {
		breaches.push(
			`error_rate_pct ${signal.error_rate_pct} is above the ${budget}% error budget`,
		);
	}
	return breaches;
}

/** Where a merged signal field came from, so errors point at the right file. */
interface Origin {
	readonly file: string;
	readonly path: string;
}

function checkBaseline(
	baseline: readonly BaselineSignal[],
	services: ReadonlyMap<string, Service>,
	issues: FixtureIssue[],
): void {
	const seen = new Map<string, number>();
	baseline.forEach((signal, i) => {
		const path = `[${i}]`;
		if (!services.has(signal.service_id)) {
			issues.push({
				file: BASELINE_FILE,
				path: `${path}.service_id`,
				message: `unknown service "${signal.service_id}"`,
			});
		}
		const first = seen.get(signal.service_id);
		if (first !== undefined) {
			issues.push({
				file: BASELINE_FILE,
				path: `${path}.service_id`,
				message: `duplicate value "${signal.service_id}" (first used at [${first}])`,
			});
		} else {
			seen.set(signal.service_id, i);
		}
		if (signal.status !== "healthy") {
			issues.push({
				file: BASELINE_FILE,
				path: `${path}.status`,
				message: `baseline signals must be healthy, got "${signal.status}"`,
			});
		}
	});
	for (const id of services.keys()) {
		if (!seen.has(id)) {
			issues.push({
				file: BASELINE_FILE,
				path: "(root)",
				message: `no baseline signal for service "${id}"`,
			});
		}
	}
}

function checkScenarioFile(
	key: ScenarioId,
	scenario: ScenarioFile,
	files: ReadonlyMap<ScenarioId, ScenarioFile>,
	catalog: Catalog,
	deployIds: Map<string, string>,
	issues: FixtureIssue[],
): void {
	const file = SCENARIO_FILES[key];
	const serviceIds = new Set(catalog.services.map((s) => s.id));
	const owner = new Map(catalog.services.map((s) => [s.id, s.team_id]));

	if (scenario.id !== key) {
		issues.push({
			file,
			path: "id",
			message: `must be "${key}" to match the file name`,
		});
	}

	if (scenario.extends !== undefined) {
		const target = files.get(scenario.extends);
		if (scenario.extends === key) {
			issues.push({
				file,
				path: "extends",
				message: "a scenario cannot extend itself",
			});
		} else if (target?.extends !== undefined) {
			issues.push({
				file,
				path: "extends",
				message: `"${scenario.extends}" extends another scenario; extend a data set directly`,
			});
		}
	}

	const overridden = new Map<string, number>();
	scenario.signal_overrides?.forEach((override, i) => {
		const path = `signal_overrides[${i}].service_id`;
		if (!serviceIds.has(override.service_id)) {
			issues.push({
				file,
				path,
				message: `unknown service "${override.service_id}"`,
			});
		}
		const first = overridden.get(override.service_id);
		if (first !== undefined) {
			issues.push({
				file,
				path,
				message: `service "${override.service_id}" is already overridden at signal_overrides[${first}]`,
			});
		} else {
			overridden.set(override.service_id, i);
		}
	});

	scenario.deploys?.forEach((deploy, i) => {
		const path = `deploys[${i}]`;
		const team = owner.get(deploy.service_id);
		if (team === undefined) {
			issues.push({
				file,
				path: `${path}.service_id`,
				message: `unknown service "${deploy.service_id}"`,
			});
		} else if (team !== deploy.team_id) {
			issues.push({
				file,
				path: `${path}.team_id`,
				message: `"${deploy.service_id}" is owned by "${team}", not "${deploy.team_id}"`,
			});
		}
		const where = `${file}: ${path}`;
		const first = deployIds.get(deploy.id);
		if (first !== undefined) {
			issues.push({
				file,
				path: `${path}.id`,
				message: `duplicate deploy ID "${deploy.id}" (first used at ${first})`,
			});
		} else {
			deployIds.set(deploy.id, where);
		}
	});
}

function resolve(
	id: ScenarioId,
	files: ReadonlyMap<ScenarioId, ScenarioFile>,
	baseline: readonly BaselineSignal[],
	catalog: Catalog,
	issues: FixtureIssue[],
): Scenario {
	const own = files.get(id);
	if (!own) throw new Error(`scenario "${id}" was not parsed`);
	const dataId = own.extends ?? id;
	const data = files.get(dataId);
	if (!data) throw new Error(`scenario "${dataId}" was not parsed`);
	const dataFile = SCENARIO_FILES[dataId];

	const base = new Map(baseline.map((s, i) => [s.service_id, { s, i }]));
	const overrides = new Map(
		(data.signal_overrides ?? []).map((o, i) => [o.service_id, { o, i }]),
	);

	const signals: SignalSnapshot[] = [];
	for (const service of catalog.services) {
		const from = base.get(service.id);
		if (!from) continue; // reported by checkBaseline
		const override = overrides.get(service.id);
		const changes = Object.fromEntries(
			Object.entries(override?.o ?? {}).filter(
				([key, value]) => key !== "service_id" && value !== undefined,
			),
		) as Partial<BaselineSignal>;
		const signal: SignalSnapshot = {
			...from.s,
			...changes,
			scenario_id: id,
		};
		signals.push(signal);

		// Only report a data set's problems once, not again for each extender.
		if (own.extends !== undefined) continue;
		const origin: Origin = override
			? { file: dataFile, path: `signal_overrides[${override.i}]` }
			: { file: BASELINE_FILE, path: `[${from.i}]` };
		const breaches = sloBreaches(signal, service);
		if (signal.status === "healthy" && breaches.length > 0) {
			issues.push({
				...origin,
				message: `status "healthy" but ${breaches.join(" and ")} for "${service.id}"`,
			});
		} else if (signal.status !== "healthy" && breaches.length === 0) {
			issues.push({
				...origin,
				message: `status "${signal.status}" but "${service.id}" is within its SLOs; raise p95_ms or error_rate_pct, or mark it healthy`,
			});
		}
	}

	const deploys: Deploy[] = (data.deploys ?? [])
		.map((d) => ({ ...d, scenario_id: id }))
		.sort((a, b) => a.minutes_before_start - b.minutes_before_start);

	return { id, description: own.description, signals, deploys };
}

/**
 * Validates the signal baseline and every scenario file against the catalog,
 * then resolves each scenario. Throws a {@link FixtureError} listing every
 * issue found, each naming the file and field.
 */
export function buildScenarios(
	catalog: Catalog,
	raw: RawScenarios,
): ReadonlyMap<ScenarioId, Scenario> {
	const issues: FixtureIssue[] = [];
	const baseline = parseFixture(
		BASELINE_FILE,
		BaselineSignalsFileSchema,
		raw.baseline,
		issues,
	);
	const files = new Map<ScenarioId, ScenarioFile>();
	for (const id of SCENARIO_IDS) {
		const parsed = parseFixture(
			SCENARIO_FILES[id],
			ScenarioFileSchema,
			raw.scenarios[id],
			issues,
		);
		if (parsed) files.set(id, parsed);
	}
	if (!baseline || files.size !== SCENARIO_IDS.length) {
		throw new FixtureError(issues);
	}

	const services = new Map(catalog.services.map((s) => [s.id, s]));
	checkBaseline(baseline, services, issues);
	const deployIds = new Map<string, string>();
	for (const [id, file] of files) {
		checkScenarioFile(id, file, files, catalog, deployIds, issues);
	}
	if (issues.length > 0) throw new FixtureError(issues);

	const scenarios = new Map<ScenarioId, Scenario>();
	for (const id of SCENARIO_IDS) {
		scenarios.set(id, resolve(id, files, baseline, catalog, issues));
	}
	if (issues.length > 0) throw new FixtureError(issues);
	return scenarios;
}

let cached: ReadonlyMap<ScenarioId, Scenario> | undefined;

/** Every bundled scenario, validated and resolved on first call. */
export function loadScenarios(): ReadonlyMap<ScenarioId, Scenario> {
	cached ??= buildScenarios(loadCatalog(), {
		baseline: signalsJson,
		scenarios: {
			"checkout-latency": checkoutLatencyJson,
			"auth-cert-expiry": authCertExpiryJson,
			"false-alarm": falseAlarmJson,
			"unknown-service": unknownServiceJson,
			"ack-guardrail": ackGuardrailJson,
			"blast-radius": blastRadiusJson,
		},
	});
	return cached;
}

/** One resolved scenario by ID. */
export function loadScenario(id: ScenarioId): Scenario {
	const scenario = loadScenarios().get(id);
	if (!scenario) throw new Error(`unknown scenario "${id}"`);
	return scenario;
}

/**
 * The scenario selected by the `SCENARIO` environment variable, defaulting to
 * `checkout-latency` (FR-5). Throws a ConfigError naming the accepted values
 * for an unknown scenario.
 */
export function loadActiveScenario(
	env: Record<string, string | undefined> = process.env,
): Scenario {
	return loadScenario(loadConfig(env).SCENARIO);
}
