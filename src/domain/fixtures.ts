import type { z } from "zod";
import dependenciesJson from "../../fixtures/base/dependencies.json" with {
	type: "json",
};
import incidentsJson from "../../fixtures/base/incidents.json" with {
	type: "json",
};
import oncallJson from "../../fixtures/base/oncall.json" with { type: "json" };
import runbooksJson from "../../fixtures/base/runbooks.json" with {
	type: "json",
};
import servicesJson from "../../fixtures/base/services.json" with {
	type: "json",
};
import teamsJson from "../../fixtures/base/teams.json" with { type: "json" };
import {
	DependenciesFileSchema,
	type Dependency,
	type Incident,
	IncidentsFileSchema,
	OnCallFileSchema,
	type OnCallShift,
	type Runbook,
	RunbooksFileSchema,
	type Service,
	ServicesFileSchema,
	type Team,
	TeamsFileSchema,
} from "./schemas.js";

// Fixtures are static JSON imports so a bundler (Vercel) ships them with the
// code. Everything is validated once, at first load; a bad file stops startup
// with a message naming the file and field (PRD FR-2).

export const FIXTURE_FILES = {
	services: "fixtures/base/services.json",
	dependencies: "fixtures/base/dependencies.json",
	teams: "fixtures/base/teams.json",
	oncall: "fixtures/base/oncall.json",
	runbooks: "fixtures/base/runbooks.json",
	incidents: "fixtures/base/incidents.json",
} as const;

type FixtureName = keyof typeof FIXTURE_FILES;

export interface Catalog {
	readonly services: readonly Service[];
	readonly dependencies: readonly Dependency[];
	readonly teams: readonly Team[];
	readonly oncall: readonly OnCallShift[];
	readonly runbooks: readonly Runbook[];
	readonly incidents: readonly Incident[];
}

export type RawCatalog = Record<FixtureName, unknown>;

/** One problem in one fixture file, located by a field path like `[3].team_id`. */
export interface FixtureIssue {
	readonly file: string;
	readonly path: string;
	readonly message: string;
}

export class FixtureError extends Error {
	readonly issues: readonly FixtureIssue[];

	constructor(issues: readonly FixtureIssue[]) {
		const lines = issues.map((i) => `  ${i.file}: ${i.path}: ${i.message}`);
		super(
			`Invalid fixture data (${issues.length} issue${issues.length === 1 ? "" : "s"}):\n${lines.join("\n")}`,
		);
		this.name = "FixtureError";
		this.issues = issues;
	}
}

export function formatPath(path: readonly PropertyKey[]): string {
	if (path.length === 0) return "(root)";
	return path
		.map((key, i) => {
			if (typeof key === "number") return `[${key}]`;
			return i === 0 ? String(key) : `.${String(key)}`;
		})
		.join("");
}

/** Parses one fixture file, recording each schema error against `file`. */
export function parseFixture<T>(
	file: string,
	schema: z.ZodType<T>,
	data: unknown,
	issues: FixtureIssue[],
): T | undefined {
	const result = schema.safeParse(data);
	if (result.success) return result.data;
	for (const issue of result.error.issues) {
		issues.push({
			file,
			path: formatPath(issue.path),
			message: issue.message,
		});
	}
	return undefined;
}

function parseFile<T>(
	name: FixtureName,
	schema: z.ZodType<T>,
	data: unknown,
	issues: FixtureIssue[],
): T | undefined {
	return parseFixture(FIXTURE_FILES[name], schema, data, issues);
}

function checkUnique<T>(
	name: FixtureName,
	records: readonly T[],
	field: keyof T & string,
	issues: FixtureIssue[],
	normalize: (value: string) => string = (v) => v,
): void {
	const seen = new Map<string, number>();
	records.forEach((record, i) => {
		const key = normalize(String(record[field]));
		const first = seen.get(key);
		if (first === undefined) {
			seen.set(key, i);
		} else {
			issues.push({
				file: FIXTURE_FILES[name],
				path: `[${i}].${field}`,
				message: `duplicate value "${String(record[field])}" (first used at [${first}])`,
			});
		}
	});
}

function checkIncidents(
	catalog: Catalog,
	incidents: readonly Incident[],
	issues: FixtureIssue[],
): void {
	const serviceIds = new Set(catalog.services.map((s) => s.id));
	const teamIds = new Set(catalog.teams.map((t) => t.id));
	const runbooks = new Map(catalog.runbooks.map((r) => [r.id, r]));
	const file = FIXTURE_FILES.incidents;

	checkUnique("incidents", incidents, "id", issues);
	checkUnique("incidents", incidents, "title", issues, (v) => v.toLowerCase());

	incidents.forEach((incident, i) => {
		const seen = new Set<string>();
		incident.affected_service_ids.forEach((id, j) => {
			const path = `[${i}].affected_service_ids[${j}]`;
			if (!serviceIds.has(id)) {
				issues.push({ file, path, message: `unknown service "${id}"` });
			} else if (seen.has(id)) {
				issues.push({ file, path, message: `service "${id}" is listed twice` });
			}
			seen.add(id);
		});

		const root = incident.root_cause_service_id;
		if (!serviceIds.has(root)) {
			issues.push({
				file,
				path: `[${i}].root_cause_service_id`,
				message: `unknown service "${root}"`,
			});
		} else if (!seen.has(root)) {
			issues.push({
				file,
				path: `[${i}].root_cause_service_id`,
				message: `"${root}" must also be listed in affected_service_ids`,
			});
		}

		const runbook = runbooks.get(incident.runbook_id);
		if (!runbook) {
			issues.push({
				file,
				path: `[${i}].runbook_id`,
				message: `unknown runbook "${incident.runbook_id}"`,
			});
		} else if (
			serviceIds.has(root) &&
			!runbook.applies_to_service_ids.includes(root)
		) {
			issues.push({
				file,
				path: `[${i}].runbook_id`,
				message: `${runbook.id} doesn't apply to the root-cause service "${root}"`,
			});
		}

		incident.postmortem.action_items.forEach((item, j) => {
			if (!teamIds.has(item.owner_team_id)) {
				issues.push({
					file,
					path: `[${i}].postmortem.action_items[${j}].owner_team_id`,
					message: `unknown team "${item.owner_team_id}"`,
				});
			}
		});
	});
}

function checkReferences(catalog: Catalog, issues: FixtureIssue[]): void {
	const { services, dependencies, teams, oncall, runbooks, incidents } =
		catalog;
	const serviceIds = new Set(services.map((s) => s.id));
	const teamIds = new Set(teams.map((t) => t.id));

	checkUnique("services", services, "id", issues);
	checkUnique("services", services, "name", issues, (v) => v.toLowerCase());
	checkUnique("teams", teams, "id", issues);
	checkUnique("oncall", oncall, "team_id", issues);

	services.forEach((service, i) => {
		if (!teamIds.has(service.team_id)) {
			issues.push({
				file: FIXTURE_FILES.services,
				path: `[${i}].team_id`,
				message: `unknown team "${service.team_id}"`,
			});
		}
	});

	const edges = new Set<string>();
	dependencies.forEach((edge, i) => {
		for (const field of ["from_service_id", "to_service_id"] as const) {
			if (!serviceIds.has(edge[field])) {
				issues.push({
					file: FIXTURE_FILES.dependencies,
					path: `[${i}].${field}`,
					message: `unknown service "${edge[field]}"`,
				});
			}
		}
		if (edge.from_service_id === edge.to_service_id) {
			issues.push({
				file: FIXTURE_FILES.dependencies,
				path: `[${i}].to_service_id`,
				message: "a service cannot depend on itself",
			});
		}
		const key = `${edge.from_service_id}->${edge.to_service_id}`;
		if (edges.has(key)) {
			issues.push({
				file: FIXTURE_FILES.dependencies,
				path: `[${i}]`,
				message: `duplicate edge ${key}`,
			});
		}
		edges.add(key);
	});

	oncall.forEach((shift, i) => {
		if (!teamIds.has(shift.team_id)) {
			issues.push({
				file: FIXTURE_FILES.oncall,
				path: `[${i}].team_id`,
				message: `unknown team "${shift.team_id}"`,
			});
		}
	});

	checkUnique("runbooks", runbooks, "id", issues);
	checkUnique("runbooks", runbooks, "title", issues, (v) => v.toLowerCase());

	runbooks.forEach((runbook, i) => {
		const seenServices = new Set<string>();
		runbook.applies_to_service_ids.forEach((id, j) => {
			const path = `[${i}].applies_to_service_ids[${j}]`;
			if (!serviceIds.has(id)) {
				issues.push({
					file: FIXTURE_FILES.runbooks,
					path,
					message: `unknown service "${id}"`,
				});
			} else if (seenServices.has(id)) {
				issues.push({
					file: FIXTURE_FILES.runbooks,
					path,
					message: `service "${id}" is listed twice`,
				});
			}
			seenServices.add(id);
		});
		if (!teamIds.has(runbook.escalation.team_id)) {
			issues.push({
				file: FIXTURE_FILES.runbooks,
				path: `[${i}].escalation.team_id`,
				message: `unknown team "${runbook.escalation.team_id}"`,
			});
		}
	});

	checkIncidents(catalog, incidents, issues);

	// FR-6: the roster covers every team (and so every owning team).
	const covered = new Set(oncall.map((s) => s.team_id));
	teams.forEach((team, i) => {
		if (!covered.has(team.id)) {
			issues.push({
				file: FIXTURE_FILES.teams,
				path: `[${i}].id`,
				message: `team "${team.id}" has no on-call shift in ${FIXTURE_FILES.oncall}`,
			});
		}
	});
}

/**
 * Validates raw fixture data and cross-file references.
 * Throws a {@link FixtureError} listing every issue found.
 */
export function buildCatalog(raw: RawCatalog): Catalog {
	const issues: FixtureIssue[] = [];
	const services = parseFile(
		"services",
		ServicesFileSchema,
		raw.services,
		issues,
	);
	const dependencies = parseFile(
		"dependencies",
		DependenciesFileSchema,
		raw.dependencies,
		issues,
	);
	const teams = parseFile("teams", TeamsFileSchema, raw.teams, issues);
	const oncall = parseFile("oncall", OnCallFileSchema, raw.oncall, issues);
	const runbooks = parseFile(
		"runbooks",
		RunbooksFileSchema,
		raw.runbooks,
		issues,
	);

	const incidents = parseFile(
		"incidents",
		IncidentsFileSchema,
		raw.incidents,
		issues,
	);

	// Shape errors make reference checks noisy, so report those first.
	if (
		!services ||
		!dependencies ||
		!teams ||
		!oncall ||
		!runbooks ||
		!incidents
	) {
		throw new FixtureError(issues);
	}

	const catalog: Catalog = {
		services,
		dependencies,
		teams,
		oncall,
		runbooks,
		incidents,
	};
	checkReferences(catalog, issues);
	if (issues.length > 0) throw new FixtureError(issues);
	return catalog;
}

let cached: Catalog | undefined;

/** The bundled base catalog, validated on first call. */
export function loadCatalog(): Catalog {
	cached ??= buildCatalog({
		services: servicesJson,
		dependencies: dependenciesJson,
		teams: teamsJson,
		oncall: oncallJson,
		runbooks: runbooksJson,
		incidents: incidentsJson,
	});
	return cached;
}
