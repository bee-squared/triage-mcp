import type { Catalog } from "./fixtures.js";
import type {
	BaselineSignal,
	Scenario,
	Service,
	SignalSnapshot,
	SignalStatus,
} from "./schemas.js";

// The scenario loader validates fixtures with the same SLO comparison that
// health queries report, so the two can't disagree.

type Measured = Pick<BaselineSignal, "p95_ms" | "error_rate_pct">;

export interface SloCheck {
	readonly value: number;
	readonly limit: number;
	/** A value exactly at the limit is within SLO. */
	readonly breached: boolean;
}

export interface SloComparison {
	readonly p95_ms: SloCheck;
	readonly error_rate_pct: SloCheck;
}

export interface ServiceHealth {
	readonly service: Service;
	readonly signal: SignalSnapshot;
	readonly slo: SloComparison;
}

/** Error budget implied by an availability SLO, as a percentage of requests. */
export function errorBudgetPct(service: Service): number {
	return Math.round((100 - service.slo_availability_pct) * 1e6) / 1e6;
}

const check = (value: number, limit: number): SloCheck => ({
	value,
	limit,
	breached: value > limit,
});

export function compareToSlo(
	signal: Measured,
	service: Service,
): SloComparison {
	return {
		p95_ms: check(signal.p95_ms, service.slo_p95_ms),
		error_rate_pct: check(signal.error_rate_pct, errorBudgetPct(service)),
	};
}

/** Which SLOs a signal breaches. Empty means within SLO. */
export function sloBreaches(signal: Measured, service: Service): string[] {
	const { p95_ms: p95, error_rate_pct: errors } = compareToSlo(signal, service);
	const breaches: string[] = [];
	if (p95.breached) {
		breaches.push(`p95_ms ${p95.value} is above the ${p95.limit} ms SLO`);
	}
	if (errors.breached) {
		breaches.push(
			`error_rate_pct ${errors.value} is above the ${errors.limit}% error budget`,
		);
	}
	return breaches;
}

const SEVERITY_RANK: Record<SignalStatus, number> = {
	down: 0,
	degraded: 1,
	healthy: 2,
};

/** Sort comparator: down, then degraded, then healthy. */
export function worstFirst(a: SignalStatus, b: SignalStatus): number {
	return SEVERITY_RANK[a] - SEVERITY_RANK[b];
}

export function getSignal(
	scenario: Scenario,
	serviceId: string,
): SignalSnapshot {
	const signal = scenario.signals.find((s) => s.service_id === serviceId);
	// The loader guarantees one per service, so this is a bug and not user input.
	if (!signal) {
		throw new Error(
			`no signal for "${serviceId}" in scenario "${scenario.id}"`,
		);
	}
	return signal;
}

export function getServiceHealth(
	scenario: Scenario,
	service: Service,
): ServiceHealth {
	const signal = getSignal(scenario, service.id);
	return { service, signal, slo: compareToSlo(signal, service) };
}

/** Every non-healthy service, worst first, then in catalog order. */
export function listUnhealthyServices(
	catalog: Catalog,
	scenario: Scenario,
): ServiceHealth[] {
	return catalog.services
		.map((service) => getServiceHealth(scenario, service))
		.filter(({ signal }) => signal.status !== "healthy")
		.sort((a, b) => worstFirst(a.signal.status, b.signal.status));
}
