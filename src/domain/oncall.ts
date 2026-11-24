import { closestMatches } from "./closest.js";
import type { Catalog } from "./fixtures.js";
import { normalize } from "./names.js";
import type { OnCallShift, Service, Team } from "./schemas.js";

export type TeamLookup =
	| { readonly found: true; readonly team: Team }
	| { readonly found: false; readonly suggestions: readonly string[] };

/** Who to page for a team (PRD `get_oncall`). */
export interface OnCall {
	readonly team: Team;
	readonly primary_handle: OnCallShift["primary_handle"];
	readonly secondary_handle: OnCallShift["secondary_handle"];
	readonly escalation_channel: Team["escalation_channel"];
	/** IDs of the services the team owns, in catalog order. */
	readonly service_ids: readonly string[];
}

/**
 * Finds a team by exact ID or name, ignoring case and separators. Like
 * services, a near miss is suggested and never resolved.
 */
export function findTeam(catalog: Catalog, query: string): TeamLookup {
	const key = normalize(query);
	const team = catalog.teams.find(
		(t) => normalize(t.id) === key || normalize(t.name) === key,
	);
	return team
		? { found: true, team }
		: { found: false, suggestions: closestMatches(query, catalog.teams) };
}

export function getOnCall(catalog: Catalog, team: Team): OnCall {
	const shift = catalog.oncall.find((s) => s.team_id === team.id);
	// The loader guarantees every team a shift, so this is a bug and not user input.
	if (!shift) throw new Error(`no on-call shift for team "${team.id}"`);
	return {
		team,
		primary_handle: shift.primary_handle,
		secondary_handle: shift.secondary_handle,
		escalation_channel: team.escalation_channel,
		service_ids: catalog.services
			.filter((s) => s.team_id === team.id)
			.map((s) => s.id),
	};
}

/** On-call for the team that owns `service`. */
export function getOnCallForService(
	catalog: Catalog,
	service: Service,
): OnCall {
	const team = catalog.teams.find((t) => t.id === service.team_id);
	// The loader checks every service's team exists.
	if (!team) throw new Error(`no team "${service.team_id}"`);
	return getOnCall(catalog, team);
}
