import type { Catalog } from "./fixtures.js";
import { getSignal, worstFirst } from "./health.js";
import type { Dependency, Scenario, Service, SignalStatus } from "./schemas.js";

/** Upstream is what a service depends on. Downstream is what depends on it. */
export const DIRECTIONS = ["upstream", "downstream"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const DEFAULT_DEPTH = 2;
export const MAX_DEPTH = 3;

export interface RelatedService {
	readonly service: Service;
	readonly status: SignalStatus;
	/** Fewest hops from the starting service. */
	readonly depth: number;
	/**
	 * Every edge walked to reach this service. There can be several, of
	 * different kinds: `notifications` is called by two services.
	 */
	readonly via: readonly Dependency[];
}

/**
 * Walks up to `depth` hops from `start`, listing each service reached once.
 * Unhealthy services come first, then nearer ones, so that capping the list
 * can't hide a failing service behind healthy neighbours.
 *
 * Callers validate `depth`; out of range is a RangeError.
 */
export function walkDependencies(
	catalog: Catalog,
	scenario: Scenario,
	start: Service,
	direction: Direction,
	depth: number = DEFAULT_DEPTH,
): RelatedService[] {
	if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) {
		throw new RangeError(
			`depth must be an integer from 1 to ${MAX_DEPTH}, got ${depth}`,
		);
	}
	const [near, far] =
		direction === "upstream"
			? (["from_service_id", "to_service_id"] as const)
			: (["to_service_id", "from_service_id"] as const);

	const reached = new Map<string, { depth: number; via: Dependency[] }>();
	let frontier = new Set([start.id]);
	for (let hop = 1; hop <= depth; hop++) {
		const next = new Set<string>();
		for (const edge of catalog.dependencies) {
			const id = edge[far];
			if (!frontier.has(edge[near]) || id === start.id) continue;
			const seen = reached.get(id);
			if (seen) {
				seen.via.push(edge);
			} else {
				reached.set(id, { depth: hop, via: [edge] });
				next.add(id);
			}
		}
		frontier = next;
	}

	return catalog.services
		.flatMap((service) => {
			const found = reached.get(service.id);
			if (!found) return [];
			const { status } = getSignal(scenario, service.id);
			return [{ service, status, ...found }];
		})
		.sort((a, b) => worstFirst(a.status, b.status) || a.depth - b.depth);
}
