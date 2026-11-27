import { z } from "zod";
import {
	DEFAULT_DEPLOY_WINDOW_MINUTES,
	listRecentDeploys,
} from "../domain/deploys.js";
import {
	type Deploy,
	MAX_DEPLOY_WINDOW_MINUTES,
	type Service,
} from "../domain/schemas.js";
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

const WINDOW_ERROR = `within_minutes must be a whole number from 1 to ${MAX_DEPLOY_WINDOW_MINUTES}`;

const DeploySchema = z.object({
	deploy_id: z.string(),
	service_id: z.string(),
	team_id: z.string(),
	version: z.string(),
	minutes_before_start: z.int(),
	change_summary: z.string(),
});

type DeployEntry = z.infer<typeof DeploySchema>;

const OutputSchema = z.object({
	scenario_id: z.string(),
	/** Set when the call named a service. */
	service_id: z.string().optional(),
	within_minutes: z.int(),
	deploys: z.array(DeploySchema),
	more_available: z.int(),
});

/**
 * Every field is short and each one matters to triage (the summary is how a
 * red herring is ruled out), so there is no `response_format`: concise would
 * be the same list.
 */
const toEntry = (deploy: Deploy): DeployEntry => ({
	deploy_id: deploy.id,
	service_id: deploy.service_id,
	team_id: deploy.team_id,
	version: deploy.version,
	minutes_before_start: deploy.minutes_before_start,
	change_summary: deploy.change_summary,
});

const describe = (d: DeployEntry): string =>
	`- ${d.deploy_id}: ${d.service_id} ${d.version}, ${d.minutes_before_start} min ago (team ${d.team_id}). ${d.change_summary}`;

export const listRecentDeploysTool = defineTool({
	name: "list_recent_deploys",
	title: "List recent deploys",
	description: [
		"Deploys to Fernhill services in the last `within_minutes` before now, newest first, each with its deploy ID, service, version, how many minutes ago it shipped, and a change summary.",
		"Use when: looking for what changed before a service degraded, or checking whether a suspect service shipped recently. A deploy shortly before the symptoms began is a lead, not proof: compare its change summary and service with the symptoms.",
		"Do not use for: current health (use get_service_health), or changes behind past incidents (use search_incidents).",
		`\`within_minutes\` is 1 to ${MAX_DEPLOY_WINDOW_MINUTES}, default ${DEFAULT_DEPLOY_WINDOW_MINUTES}. No deploys in the window is a normal answer, not an error.`,
		'Example input: {"service": "payment-gateway", "within_minutes": 120}',
	].join("\n\n"),
	inputSchema: z.strictObject({
		service: ServiceRefSchema.optional().describe(
			"Service ID or name, such as `payment-gateway`. Omit to list deploys to every service.",
		),
		within_minutes: z
			.int({ error: WINDOW_ERROR })
			.min(1, { error: WINDOW_ERROR })
			.max(MAX_DEPLOY_WINDOW_MINUTES, { error: WINDOW_ERROR })
			.default(DEFAULT_DEPLOY_WINDOW_MINUTES)
			.describe(
				`How far back to look, in minutes: 1 to ${MAX_DEPLOY_WINDOW_MINUTES}, default ${DEFAULT_DEPLOY_WINDOW_MINUTES}.`,
			),
		limit: LimitSchema,
	}),
	outputSchema: OutputSchema,
	annotations: { ...READ_ONLY },
	handler({ service: query, within_minutes: withinMinutes, limit }, context) {
		const { catalog, scenario } = context;

		let target: Service | undefined;
		if (query !== undefined) {
			const lookup = findService(catalog, query);
			if (!lookup.found) {
				return serviceNotFound(
					query,
					lookup.suggestions,
					"Call list_recent_deploys without `service` to see deploys to every service, or ask the user which service they mean.",
				);
			}
			target = lookup.service;
		}

		const deploys = listRecentDeploys(scenario, {
			service: target,
			withinMinutes,
		});
		const capped = capList(deploys, limit);
		const entries = capped.shown.map(toEntry);
		const structured = {
			scenario_id: scenario.id,
			...(target ? { service_id: target.id } : {}),
			within_minutes: withinMinutes,
			deploys: entries,
			more_available: capped.more_available,
		};

		const scope = target ? `to ${target.id}` : "to any service";
		const window = `in the last ${withinMinutes} minutes`;
		if (deploys.length === 0) {
			const wider =
				withinMinutes < MAX_DEPLOY_WINDOW_MINUTES
					? ` Raise \`within_minutes\` (at most ${MAX_DEPLOY_WINDOW_MINUTES}) to look further back.`
					: "";
			return ok(`No deploys ${scope} ${window}.${wider}`, structured);
		}
		const count =
			deploys.length === 1 ? "1 deploy" : `${deploys.length} deploys`;
		const narrow = target
			? "Raise `limit` (at most 20) or lower `within_minutes`."
			: "Raise `limit` (at most 20), lower `within_minutes`, or pass `service`.";
		return ok(
			[
				`${count} ${scope} ${window}, newest first:`,
				...entries.map(describe),
			].join("\n") + moreLine(capped, narrow),
			structured,
		);
	},
});
