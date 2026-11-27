import { z } from "zod";
import { findById, INCIDENT_ID } from "../domain/ids.js";
import {
	ACTION_ITEM_STATUSES,
	type Incident,
	SEVERITIES,
} from "../domain/schemas.js";
import {
	defineTool,
	ok,
	READ_ONLY,
	type ResponseFormat,
	ResponseFormatSchema,
	toolError,
} from "./_shared.js";

/** Longer input can't be an incident ID in any spelling we accept. */
const MAX_ID_LENGTH = 20;

const IncidentEntrySchema = z.object({
	incident_id: z.string(),
	title: z.string(),
	severity: z.enum(SEVERITIES),
	days_before_start: z.int(),
	root_cause_service_id: z.string(),
	root_cause_summary: z.string(),
	runbook_id: z.string(),
	// Detailed only: the rest of the record.
	affected_service_ids: z.array(z.string()).optional(),
	symptoms: z.string().optional(),
	resolution: z.string().optional(),
	postmortem: z
		.object({
			summary: z.string(),
			contributing_factors: z.array(z.string()),
			action_items: z.array(
				z.object({
					description: z.string(),
					owner_team_id: z.string(),
					status: z.enum(ACTION_ITEM_STATUSES),
				}),
			),
		})
		.optional(),
});

type IncidentEntry = z.infer<typeof IncidentEntrySchema>;

const OutputSchema = z.object({ incident: IncidentEntrySchema });

/**
 * Concise answers "what broke last time and which runbook fixed it", which is
 * what triage needs to compare against now. The symptoms, resolution and
 * postmortem are most of the record, so they wait for `detailed`.
 */
function toEntry(incident: Incident, format: ResponseFormat): IncidentEntry {
	const entry: IncidentEntry = {
		incident_id: incident.id,
		title: incident.title,
		severity: incident.severity,
		days_before_start: incident.days_before_start,
		root_cause_service_id: incident.root_cause_service_id,
		root_cause_summary: incident.root_cause_summary,
		runbook_id: incident.runbook_id,
	};
	if (format === "concise") return entry;
	const { postmortem } = incident;
	return {
		...entry,
		affected_service_ids: [...incident.affected_service_ids],
		symptoms: incident.symptoms,
		resolution: incident.resolution,
		postmortem: {
			summary: postmortem.summary,
			contributing_factors: [...postmortem.contributing_factors],
			action_items: postmortem.action_items.map((item) => ({ ...item })),
		},
	};
}

function describe(e: IncidentEntry): string {
	const lines = [
		`${e.incident_id} (${e.severity}, ${e.days_before_start} days ago): ${e.title}`,
		`Root cause (${e.root_cause_service_id}): ${e.root_cause_summary}`,
		`Runbook: ${e.runbook_id}`,
	];
	if (e.postmortem === undefined) return lines.join("\n");
	const { postmortem } = e;
	return [
		...lines,
		`Affected: ${(e.affected_service_ids ?? []).join(", ")}`,
		`Symptoms: ${e.symptoms}`,
		`Resolution: ${e.resolution}`,
		`Postmortem: ${postmortem.summary}`,
		"Contributing factors:",
		...postmortem.contributing_factors.map((f) => `- ${f}`),
		"Action items:",
		...postmortem.action_items.map(
			(a) => `- [${a.status}] ${a.description} (team ${a.owner_team_id})`,
		),
	].join("\n");
}

export const getIncidentTool = defineTool({
	name: "get_incident",
	title: "Get incident",
	description: [
		"One past Fernhill incident by ID: severity, when it happened, the root-cause service and summary, and the runbook that applied.",
		"Use when: search_incidents (or the user) gave you an incident ID and you need its root cause to compare with the current symptoms, or its resolution and postmortem.",
		"Do not use for: finding incidents by symptom or service (use search_incidents), or the steps to follow now (use find_runbook with the runbook ID).",
		"`concise` (default) gives the root cause and runbook. `detailed` adds the affected services, symptoms, resolution (such as the rollback that fixed it) and the postmortem with contributing factors and action items.",
		'Example input: {"incident_id": "INC-0142", "response_format": "detailed"}',
	].join("\n\n"),
	inputSchema: z.strictObject({
		incident_id: z
			.string({ error: "incident_id must be an incident ID, as a string" })
			.trim()
			.min(1, { error: "incident_id must not be empty" })
			.max(MAX_ID_LENGTH, {
				error: "incident_id must be an incident ID like `INC-0142`",
			})
			.describe("Incident ID, such as `INC-0142`."),
		response_format: ResponseFormatSchema,
	}),
	outputSchema: OutputSchema,
	annotations: { ...READ_ONLY },
	handler({ incident_id: query, response_format: format }, context) {
		const lookup = findById(INCIDENT_ID, context.catalog.incidents, query);
		switch (lookup.status) {
			case "malformed":
				return toolError(
					"invalid_argument",
					`"${query}" is not an incident ID. Incident IDs look like \`INC-0142\`. To find incidents by symptom or service, use search_incidents.`,
				);
			case "not_found": {
				const lead = `No incident ${lookup.id}.`;
				return lookup.suggestions.length > 0
					? toolError("not_found", lead, lookup.suggestions)
					: toolError(
							"not_found",
							`${lead} No incident has a similar ID. Use search_incidents to find incidents by symptom or service.`,
						);
			}
			case "found": {
				const entry = toEntry(lookup.record, format);
				return ok(describe(entry), { incident: entry });
			}
		}
	},
});
