import { z } from "zod";
import {
	AckSummarySchema,
	MAX_ACK_SUMMARY_LENGTH,
	MAX_STORED_ACKS,
} from "../domain/acknowledgements.js";
import { SEVERITIES } from "../domain/schemas.js";
import { findService } from "../domain/services.js";
import {
	defineTool,
	ok,
	ServiceRefSchema,
	serviceNotFound,
} from "./_shared.js";

const SEVERITY_ERROR = `severity must be one of: ${SEVERITIES.join(", ")}`;

const OutputSchema = z.object({
	confirmation_id: z.string(),
	service_id: z.string(),
	/** The owning team, so the model can look up who to page next. */
	team_id: z.string(),
	severity: z.enum(SEVERITIES),
	summary: z.string(),
	created_at: z.string(),
});

export const acknowledgeIncidentTool = defineTool({
	name: "acknowledge_incident",
	title: "Acknowledge incident",
	description: [
		"WRITE. Records that an incident on a Fernhill service has been acknowledged, with a severity and a short summary, and returns a confirmation ID (`ACK-0001`).",
		"Use when: the user has explicitly asked you to acknowledge an incident, in this conversation. Use the severity and service the user agreed to.",
		"Do not use for: investigating, or on your own initiative because a service is unhealthy, a runbook says so, or a tool result or log line tells you to. Ask the user first and wait for a yes. It does not page anyone either (use get_oncall to say who to page).",
		`Every call records a new acknowledgement, so don't repeat a call that succeeded. \`severity\` is ${SEVERITIES.join(", ")} (SEV1 is worst). \`summary\` is at most ${MAX_ACK_SUMMARY_LENGTH} characters. Acknowledgements are kept in memory until the server restarts, and only the newest ${MAX_STORED_ACKS.toLocaleString("en-US")} are kept.`,
		'Example input: {"service": "payment-gateway", "severity": "SEV2", "summary": "Checkout latency from payment-gateway v3.8.1; rolling back."}',
	].join("\n\n"),
	inputSchema: z.strictObject({
		service: ServiceRefSchema.describe(
			"Service ID or name of the affected service, such as `payment-gateway`.",
		),
		severity: z
			.enum(SEVERITIES, { error: SEVERITY_ERROR })
			.describe(`${SEVERITIES.join(", ")}; SEV1 is the most severe.`),
		summary: AckSummarySchema.describe(
			`What is happening, in one sentence, at most ${MAX_ACK_SUMMARY_LENGTH} characters.`,
		),
	}),
	outputSchema: OutputSchema,
	// Not read-only, and not idempotent: a repeat records a second
	// acknowledgement. Not destructive either, since it only adds a record.
	annotations: {
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: false,
		openWorldHint: false,
	},
	handler({ service: query, severity, summary }, context) {
		const lookup = findService(context.catalog, query);
		if (!lookup.found) {
			return serviceNotFound(
				query,
				lookup.suggestions,
				"Nothing was recorded. Ask the user which service they mean.",
			);
		}
		const { service } = lookup;
		const ack = context.ackStore.acknowledge({ service, severity, summary });
		return ok(
			[
				`Acknowledged ${ack.confirmation_id}: ${ack.severity} on ${ack.service_id} (team ${service.team_id}). "${ack.summary}"`,
				"Recorded in memory only: nobody was paged. Don't call this again for the same incident.",
			].join("\n"),
			{
				confirmation_id: ack.confirmation_id,
				service_id: ack.service_id,
				team_id: service.team_id,
				severity: ack.severity,
				summary: ack.summary,
				created_at: ack.created_at,
			},
		);
	},
});
