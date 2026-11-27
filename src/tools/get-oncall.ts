import { z } from "zod";
import {
	findTeam,
	getOnCall,
	getOnCallForService,
	type OnCall,
} from "../domain/oncall.js";
import { findService } from "../domain/services.js";
import {
	defineTool,
	MAX_NAME_LENGTH,
	ok,
	READ_ONLY,
	ServiceRefSchema,
	serviceNotFound,
	toolError,
} from "./_shared.js";

const OutputSchema = z.object({
	team_id: z.string(),
	team_name: z.string(),
	primary_handle: z.string(),
	secondary_handle: z.string(),
	escalation_channel: z.string(),
	/** Services the team owns, so the model can tell it has the right team. */
	service_ids: z.array(z.string()),
	/** Set when the call named a service: the service whose owner this is. */
	service_id: z.string().optional(),
});

type Output = z.infer<typeof OutputSchema>;

const toOutput = (oncall: OnCall, serviceId?: string): Output => ({
	team_id: oncall.team.id,
	team_name: oncall.team.name,
	primary_handle: oncall.primary_handle,
	secondary_handle: oncall.secondary_handle,
	escalation_channel: oncall.escalation_channel,
	service_ids: [...oncall.service_ids],
	...(serviceId === undefined ? {} : { service_id: serviceId }),
});

function describe(o: Output): string {
	const owner =
		o.service_id === undefined ? "" : `${o.service_id} is owned by `;
	return [
		`${owner}${o.team_name} (team ${o.team_id}).`,
		`Primary: ${o.primary_handle}. Secondary: ${o.secondary_handle}.`,
		`Escalation channel: ${o.escalation_channel}.`,
		`Owns: ${o.service_ids.join(", ")}.`,
	].join("\n");
}

export const getOnCallTool = defineTool({
	name: "get_oncall",
	title: "Get on-call",
	description: [
		"Who is on call for a Fernhill team: the primary and secondary handles, the escalation channel, and the services the team owns.",
		"Pass exactly one of `team` (a team ID or name, such as the escalation team from find_runbook) or `service` (a service ID or name; you get the team that owns it).",
		"Use when: you have found the likely root-cause service and need to say who to page, or a runbook says to escalate to a team.",
		"Do not use for: paging anyone or recording an acknowledgement (this only looks up names; use acknowledge_incident only if the user asks), or a service's health (use get_service_health).",
		'Example input: {"service": "payment-gateway"}',
	].join("\n\n"),
	inputSchema: z.strictObject({
		team: z
			.string({ error: "team must be a team ID or name, as a string" })
			.trim()
			.min(1, { error: "team must not be empty" })
			.max(MAX_NAME_LENGTH, {
				error: `team must be at most ${MAX_NAME_LENGTH} characters`,
			})
			.optional()
			.describe("Team ID or name, such as `payments`. Pass this or `service`."),
		service: ServiceRefSchema.optional().describe(
			"Service ID or name, such as `payment-gateway`. Pass this or `team`.",
		),
	}),
	outputSchema: OutputSchema,
	annotations: { ...READ_ONLY },
	handler({ team: teamQuery, service: serviceQuery }, context) {
		const { catalog } = context;

		// Exactly one, checked here so the published schema stays a plain object.
		if (teamQuery !== undefined && serviceQuery !== undefined) {
			return toolError(
				"invalid_argument",
				"Pass either `team` or `service`, not both.",
			);
		}

		if (teamQuery !== undefined) {
			const lookup = findTeam(catalog, teamQuery);
			if (lookup.found) {
				const out = toOutput(getOnCall(catalog, lookup.team));
				return ok(describe(out), out);
			}
			// A service passed as a team: say which argument to use.
			const service = findService(catalog, teamQuery);
			if (service.found) {
				return toolError(
					"invalid_argument",
					`"${teamQuery}" is a service, not a team. Call get_oncall with {"service": "${service.service.id}"} for the team that owns it.`,
				);
			}
			const lead = `No team matches "${teamQuery}".`;
			return lookup.suggestions.length > 0
				? toolError("not_found", lead, lookup.suggestions)
				: toolError(
						"not_found",
						`${lead} Teams: ${catalog.teams.map((t) => t.id).join(", ")}. Or pass \`service\` to find the owning team.`,
					);
		}

		if (serviceQuery !== undefined) {
			const lookup = findService(catalog, serviceQuery);
			if (lookup.found) {
				const out = toOutput(
					getOnCallForService(catalog, lookup.service),
					lookup.service.id,
				);
				return ok(describe(out), out);
			}
			const team = findTeam(catalog, serviceQuery);
			if (team.found) {
				return toolError(
					"invalid_argument",
					`"${serviceQuery}" is a team, not a service. Call get_oncall with {"team": "${team.team.id}"}.`,
				);
			}
			return serviceNotFound(
				serviceQuery,
				lookup.suggestions,
				"Ask the user which service they mean, or pass `team` if you know the owning team.",
			);
		}

		return toolError(
			"invalid_argument",
			'Pass `team` (such as `payments`) or `service` (such as `payment-gateway`). Example: {"service": "payment-gateway"}.',
		);
	},
});
