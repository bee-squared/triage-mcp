import { z } from "zod";
import {
	DEFAULT_DEPTH,
	DIRECTIONS,
	type Direction,
	MAX_DEPTH,
	type RelatedService,
	walkDependencies,
} from "../domain/graph.js";
import { getSignal } from "../domain/health.js";
import { DEPENDENCY_KINDS, SIGNAL_STATUSES } from "../domain/schemas.js";
import { findService } from "../domain/services.js";
import {
	capList,
	defineTool,
	LimitSchema,
	moreLine,
	ok,
	READ_ONLY,
	ServiceRefSchema,
	serviceNotFound,
} from "./_shared.js";

const DEPTH_ERROR = `depth must be a whole number from 1 to ${MAX_DEPTH}`;

const EdgeSchema = z.object({
	service_id: z.string(),
	kind: z.enum(DEPENDENCY_KINDS),
});

const RelatedSchema = z.object({
	service_id: z.string(),
	name: z.string(),
	team_id: z.string(),
	status: z.enum(SIGNAL_STATUSES),
	/** Fewest hops from the starting service. */
	depth: z.int(),
	/**
	 * The neighbours one hop nearer the start that this service was reached
	 * from, with each edge's kind: the shortest paths. Upstream, these call
	 * this service; downstream, this service calls them.
	 */
	via: z.array(EdgeSchema),
	/**
	 * Other edges the walk followed to this service, from neighbours as far
	 * from the start or farther. They still matter for impact, and their kind
	 * can differ: downstream of `core-db`, `checkout-api` is one sync hop away
	 * and also depends on it through an async call to `billing`.
	 */
	also_via: z.array(EdgeSchema),
});

type Related = z.infer<typeof RelatedSchema>;

const OutputSchema = z.object({
	service: z.object({
		service_id: z.string(),
		name: z.string(),
		status: z.enum(SIGNAL_STATUSES),
	}),
	direction: z.enum(DIRECTIONS),
	depth: z.int(),
	related: z.array(RelatedSchema),
	more_available: z.int(),
});

/** The end of each edge nearer the start, given the walk's direction. */
const NEARER_END = {
	upstream: "from_service_id",
	downstream: "to_service_id",
} as const satisfies Record<Direction, string>;

/**
 * `depthOf` holds the depth of every service the walk reached, the start at
 * 0, so an edge's nearer end tells whether it is on a shortest path.
 */
function toRelated(
	found: RelatedService,
	direction: Direction,
	depthOf: ReadonlyMap<string, number>,
): Related {
	const nearer = NEARER_END[direction];
	const via: Related["via"] = [];
	const alsoVia: Related["also_via"] = [];
	for (const edge of found.via) {
		const neighbour = edge[nearer];
		const target = depthOf.get(neighbour) === found.depth - 1 ? via : alsoVia;
		target.push({ service_id: neighbour, kind: edge.kind });
	}
	return {
		service_id: found.service.id,
		name: found.service.name,
		team_id: found.service.team_id,
		status: found.status,
		depth: found.depth,
		via,
		also_via: alsoVia,
	};
}

const edgeList = (edges: Related["via"]): string =>
	edges.map((e) => `${e.service_id} (${e.kind})`).join(", ");

function describe(entry: Related): string {
	const hops = entry.depth === 1 ? "1 hop" : `${entry.depth} hops`;
	const also =
		entry.also_via.length > 0 ? `; also via ${edgeList(entry.also_via)}` : "";
	return `- ${entry.service_id} (${entry.name}, team ${entry.team_id}): ${entry.status}, ${hops}, via ${edgeList(entry.via)}${also}`;
}

const HEADINGS: Record<Direction, string> = {
	upstream: "what it depends on",
	downstream: "what depends on it",
};

const NONE: Record<Direction, (id: string) => string> = {
	upstream: (id) =>
		`${id} depends on no other service. Use direction \`downstream\` to see what depends on it.`,
	downstream: (id) =>
		`No service depends on ${id}. Use direction \`upstream\` to see what it depends on.`,
};

export const getServiceDependenciesTool = defineTool({
	name: "get_service_dependencies",
	title: "Get service dependencies",
	description: [
		"Walks the Fernhill dependency graph from one service and returns each service reached with its current status, how many hops away it is, and the edge kinds (sync, async, external). Unhealthy services are listed first.",
		"Use when: looking for an upstream cause of a degraded service (direction `upstream`: what it depends on), or for the blast radius of a failing service (direction `downstream`: what depends on it).",
		"Do not use for: the health of the starting service alone (use get_service_health), or who owns or is on call for a service (use get_oncall).",
		`\`depth\` is the number of hops, 1 to ${MAX_DEPTH}, default ${DEFAULT_DEPTH}.`,
		'Example input: {"service": "checkout-api", "direction": "upstream", "depth": 2}',
	].join("\n\n"),
	inputSchema: z.strictObject({
		service: ServiceRefSchema.describe(
			"Service ID or name to start from, such as `checkout-api` or `Checkout API`.",
		),
		direction: z
			.enum(DIRECTIONS, {
				error: `direction must be one of: ${DIRECTIONS.join(", ")}`,
			})
			.describe(
				"`upstream` lists what the service depends on (possible causes). `downstream` lists what depends on it (impact).",
			),
		depth: z
			.int({ error: DEPTH_ERROR })
			.min(1, { error: DEPTH_ERROR })
			.max(MAX_DEPTH, { error: DEPTH_ERROR })
			.default(DEFAULT_DEPTH)
			.describe(`Hops to walk, 1 to ${MAX_DEPTH}, default ${DEFAULT_DEPTH}.`),
		limit: LimitSchema,
	}),
	outputSchema: OutputSchema,
	annotations: { ...READ_ONLY },
	handler({ service: query, direction, depth, limit }, context) {
		const { catalog, scenario } = context;
		const lookup = findService(catalog, query);
		if (!lookup.found) {
			return serviceNotFound(
				query,
				lookup.suggestions,
				"Call get_service_health without `service` to see which services are unhealthy, or ask the user which service they mean.",
			);
		}
		const start = lookup.service;
		const startInfo = {
			service_id: start.id,
			name: start.name,
			status: getSignal(scenario, start.id).status,
		};

		const found = walkDependencies(catalog, scenario, start, direction, depth);
		const capped = capList(found, limit);
		const depthOf = new Map<string, number>([
			[start.id, 0],
			...found.map((r): [string, number] => [r.service.id, r.depth]),
		]);
		const related = capped.shown.map((r) => toRelated(r, direction, depthOf));
		const structured = {
			service: startInfo,
			direction,
			depth,
			related,
			more_available: capped.more_available,
		};
		if (found.length === 0) return ok(NONE[direction](start.id), structured);

		const hops = depth === 1 ? "1 hop" : `up to ${depth} hops`;
		const heading =
			`${start.id} (${start.name}) is ${startInfo.status}. ` +
			`${found.length} service${found.length === 1 ? "" : "s"} ${direction} (${HEADINGS[direction]}), ${hops}, unhealthy first:`;
		const narrow =
			depth > 1
				? "Raise `limit` (at most 20) or lower `depth`."
				: "Raise `limit` (at most 20).";
		return ok(
			[heading, ...related.map(describe)].join("\n") + moreLine(capped, narrow),
			structured,
		);
	},
});
