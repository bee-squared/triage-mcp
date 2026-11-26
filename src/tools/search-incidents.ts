import { z } from "zod";
import { INCIDENT_ID, parseId } from "../domain/ids.js";
import { type Incident, SEVERITIES, type Service } from "../domain/schemas.js";
import {
	MAX_QUERY_LENGTH,
	searchIncidents,
	searchTerms,
} from "../domain/search.js";
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
	toolError,
} from "./_shared.js";

const SummarySchema = z.object({
	incident_id: z.string(),
	title: z.string(),
	severity: z.enum(SEVERITIES),
	days_before_start: z.int(),
	root_cause_service_id: z.string(),
	runbook_id: z.string(),
});

type Summary = z.infer<typeof SummarySchema>;

const OutputSchema = z.object({
	query: z.string(),
	/** Set when the call named a service. */
	service_id: z.string().optional(),
	incidents: z.array(SummarySchema),
	more_available: z.int(),
});

/**
 * A summary per match. The root cause and runbook IDs let the model link a
 * past incident to the current one without opening it; the rest of the
 * record is one get_incident call away.
 */
const toSummary = (incident: Incident): Summary => ({
	incident_id: incident.id,
	title: incident.title,
	severity: incident.severity,
	days_before_start: incident.days_before_start,
	root_cause_service_id: incident.root_cause_service_id,
	runbook_id: incident.runbook_id,
});

const describe = (s: Summary): string =>
	`- ${s.incident_id} (${s.severity}, ${s.days_before_start} days ago): ${s.title}. Root cause: ${s.root_cause_service_id}. Runbook ${s.runbook_id}.`;

/** A query that is nothing but an incident ID, such as `INC-0142`. */
const PASTED_ID = /^INC[\s_-]*\d+$/i;

export const searchIncidentsTool = defineTool({
	name: "search_incidents",
	title: "Search past incidents",
	description: [
		"Keyword search over Fernhill's past incidents, best match first. Each result gives the incident ID, title, severity, how many days ago it happened, the root-cause service and the runbook ID.",
		"Use when: checking whether the current symptoms happened before, and what caused them then. Describe the symptom in a few words (`checkout latency`, `401 errors`) and pass `service` to keep only incidents that affected it.",
		"Do not use for: reading one incident you already have the ID of, such as `INC-0142` (use get_incident; searching for an ID matches nothing), current health (use get_service_health), or what to do now (use find_runbook).",
		"A similar past incident is a lead, not proof: check that its root-cause service is unhealthy now.",
		'Example input: {"query": "checkout latency after deploy", "service": "checkout-api"}',
	].join("\n\n"),
	inputSchema: z.strictObject({
		query: z
			.string({ error: "query must be a string" })
			.trim()
			.min(1, { error: "query must not be empty" })
			.max(MAX_QUERY_LENGTH, {
				error: `query must be at most ${MAX_QUERY_LENGTH} characters`,
			})
			.describe(
				"Symptoms or keywords, such as `checkout latency` or `certificate expired 401`.",
			),
		service: ServiceRefSchema.optional().describe(
			"Service ID or name, such as `checkout-api`. Keeps only incidents that affected it.",
		),
		limit: LimitSchema,
	}),
	outputSchema: OutputSchema,
	annotations: { ...READ_ONLY },
	handler({ query, service: serviceQuery, limit }, context) {
		const { catalog } = context;

		if (PASTED_ID.test(query)) {
			const id = parseId(INCIDENT_ID, query) ?? query;
			return toolError(
				"invalid_argument",
				`search_incidents searches by symptom, not by ID. To read ${id}, call get_incident with {"incident_id": "${id}"}.`,
			);
		}

		let service: Service | undefined;
		if (serviceQuery !== undefined) {
			const lookup = findService(catalog, serviceQuery);
			if (!lookup.found) {
				return serviceNotFound(
					serviceQuery,
					lookup.suggestions,
					"Search again without `service`, or ask the user which service they mean.",
				);
			}
			service = lookup.service;
		}

		const hasTerms = searchTerms(query).length > 0;
		if (!hasTerms && service === undefined) {
			return toolError(
				"invalid_argument",
				`The query "${query}" has no search words, only common ones like "the" or "incident". Describe a symptom or name a service, such as \`checkout latency\`.`,
			);
		}

		const matches = searchIncidents(catalog, { query, service });
		const scope = service ? ` affecting ${service.id}` : "";
		if (matches.length === 0) {
			const broaden = service
				? "Search again without `service`, or with fewer, more general words."
				: "Search again with fewer, more general words, such as a service name or one symptom (`latency`, `5xx`, `timeout`).";
			return toolError(
				"empty",
				`No past incidents${scope} match "${query}". ${broaden}`,
			);
		}

		const capped = capList(matches, limit);
		const summaries = capped.shown.map(toSummary);
		const heading = hasTerms
			? `${matches.length} past incident${matches.length === 1 ? "" : "s"}${scope} match "${query}", best first:`
			: `${matches.length} past incident${matches.length === 1 ? "" : "s"}${scope}, newest first:`;
		const text =
			[heading, ...summaries.map(describe)].join("\n") +
			moreLine(
				capped,
				"Raise `limit` (at most 20), add words to the query, or pass `service`.",
			) +
			"\nCall get_incident with an ID for its root cause, resolution and postmortem.";
		return ok(text, {
			query,
			...(service ? { service_id: service.id } : {}),
			incidents: summaries,
			more_available: capped.more_available,
		});
	},
});
