import { closestMatches } from "./closest.js";
import type { Catalog } from "./fixtures.js";
import { normalize } from "./names.js";
import type { Service } from "./schemas.js";

export type ServiceLookup =
	| { readonly found: true; readonly service: Service }
	| { readonly found: false; readonly suggestions: readonly string[] };

/**
 * Finds a service by exact ID or name, ignoring case and treating spaces,
 * hyphens and underscores alike. A near miss is only ever suggested, never
 * resolved: `billing-v2` must not answer with data for `billing` (S4).
 */
export function findService(catalog: Catalog, query: string): ServiceLookup {
	const key = normalize(query);
	const service = catalog.services.find(
		(s) => normalize(s.id) === key || normalize(s.name) === key,
	);
	return service
		? { found: true, service }
		: { found: false, suggestions: closestMatches(query, catalog.services) };
}
