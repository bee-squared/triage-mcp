import { loadCatalog } from "../../src/domain/fixtures.js";
import type { Service } from "../../src/domain/schemas.js";

/** A catalog service by exact ID, failing the test if there is none. */
export function service(id: string): Service {
	const found = loadCatalog().services.find((s) => s.id === id);
	if (!found) throw new Error(`no test service "${id}"`);
	return found;
}
