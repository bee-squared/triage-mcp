import type { McpServer } from "@modelcontextprotocol/server";
import type { Catalog } from "../domain/fixtures.js";
import type { DependencyKind } from "../domain/schemas.js";

// The service catalog as one JSON resource (PRD FR-19). It is the static
// org chart of the system: who owns what, how critical it is, its SLOs and
// its edges. It has no live status, so it reads the same in every scenario;
// `get_service_health` answers "what is broken now".

export const CATALOG_URI = "catalog://services";

export interface CatalogEdge {
	readonly service_id: string;
	readonly kind: DependencyKind;
}

export interface CatalogEntry {
	readonly id: string;
	readonly name: string;
	readonly description: string;
	readonly tier: number;
	readonly team: {
		readonly id: string;
		readonly name: string;
		readonly escalation_channel: string;
	};
	readonly slo: { readonly availability_pct: number; readonly p95_ms: number };
	/** Services this one calls: where its problems can come from. */
	readonly depends_on: readonly CatalogEdge[];
	/** Services that call this one: where its problems spread to. */
	readonly depended_on_by: readonly CatalogEdge[];
}

export interface CatalogDocument {
	readonly services: readonly CatalogEntry[];
}

/** The catalog in the resource's shape, services in fixture order. */
export function catalogDocument(catalog: Catalog): CatalogDocument {
	const teams = new Map(catalog.teams.map((t) => [t.id, t]));
	return {
		services: catalog.services.map((service) => {
			const team = teams.get(service.team_id);
			if (!team) {
				// The loader checks every team reference, so this can't happen.
				throw new Error(`service ${service.id} has unknown team`);
			}
			return {
				id: service.id,
				name: service.name,
				description: service.description,
				tier: service.tier,
				team: {
					id: team.id,
					name: team.name,
					escalation_channel: team.escalation_channel,
				},
				slo: {
					availability_pct: service.slo_availability_pct,
					p95_ms: service.slo_p95_ms,
				},
				depends_on: catalog.dependencies
					.filter((e) => e.from_service_id === service.id)
					.map((e) => ({ service_id: e.to_service_id, kind: e.kind })),
				depended_on_by: catalog.dependencies
					.filter((e) => e.to_service_id === service.id)
					.map((e) => ({ service_id: e.from_service_id, kind: e.kind })),
			};
		}),
	};
}

export function registerCatalogResource(
	server: McpServer,
	catalog: Catalog,
): void {
	// Built once: the catalog never changes while the server runs.
	const text = JSON.stringify(catalogDocument(catalog), null, 2);
	server.registerResource(
		"service-catalog",
		CATALOG_URI,
		{
			title: "Fernhill service catalog",
			description:
				"Every Fernhill service with its owning team, tier (1 is most critical), SLOs, and which services it depends on and is depended on by. Static: for current status use the get_service_health tool.",
			mimeType: "application/json",
		},
		(uri) => ({
			contents: [{ uri: uri.href, mimeType: "application/json", text }],
		}),
	);
}
