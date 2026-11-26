import { z } from "zod";
import {
	getServiceHealth,
	listUnhealthyServices,
	type ServiceHealth,
} from "../domain/health.js";
import { SIGNAL_STATUSES } from "../domain/schemas.js";
import { findService } from "../domain/services.js";
import {
	capList,
	defineTool,
	LimitSchema,
	moreLine,
	ok,
	READ_ONLY,
	type ResponseFormat,
	ResponseFormatSchema,
	ServiceRefSchema,
	serviceNotFound,
} from "./_shared.js";

const SloCheckSchema = z.object({
	value: z.number(),
	limit: z.number(),
	breached: z.boolean(),
});

const SLO_METRICS = ["p95_ms", "error_rate_pct"] as const;

const HealthEntrySchema = z.object({
	service_id: z.string(),
	status: z.enum(SIGNAL_STATUSES),
	/** Only the SLOs this service breaches. Empty means within SLO. */
	slo_breaches: z.array(
		z.object({
			metric: z.enum(SLO_METRICS),
			value: z.number(),
			limit: z.number(),
		}),
	),
	// Detailed only: the rest of the service record and signal.
	name: z.string().optional(),
	team_id: z.string().optional(),
	tier: z.int().optional(),
	description: z.string().optional(),
	slo: z
		.object({ p95_ms: SloCheckSchema, error_rate_pct: SloCheckSchema })
		.optional(),
	throughput_rpm: z.number().optional(),
	log_excerpts: z.array(z.string()).optional(),
});

type HealthEntry = z.infer<typeof HealthEntrySchema>;

const OutputSchema = z.object({
	scenario_id: z.string(),
	services: z.array(HealthEntrySchema),
	more_available: z.int(),
});

/**
 * Concise keeps what triage needs: status and any breached SLO. Healthy
 * services are most of the catalog, so concise drops their numbers, which
 * keeps it well under the 40% of detailed that FR-15 allows.
 */
function toEntry(health: ServiceHealth, format: ResponseFormat): HealthEntry {
	const { service, signal, slo } = health;
	const entry: HealthEntry = {
		service_id: service.id,
		status: signal.status,
		slo_breaches: SLO_METRICS.filter((metric) => slo[metric].breached).map(
			(metric) => ({
				metric,
				value: slo[metric].value,
				limit: slo[metric].limit,
			}),
		),
	};
	if (format === "concise") return entry;
	return {
		...entry,
		name: service.name,
		team_id: service.team_id,
		tier: service.tier,
		description: service.description,
		slo: {
			p95_ms: { ...slo.p95_ms },
			error_rate_pct: { ...slo.error_rate_pct },
		},
		throughput_rpm: signal.throughput_rpm,
		log_excerpts: [...signal.log_excerpts],
	};
}

const BREACH_TEXT: Record<
	(typeof SLO_METRICS)[number],
	(value: number, limit: number) => string
> = {
	p95_ms: (value, limit) => `p95 ${value} ms, over the ${limit} ms SLO`,
	error_rate_pct: (value, limit) =>
		`error rate ${value}%, over the ${limit}% budget`,
};

const SLO_TEXT: Record<
	(typeof SLO_METRICS)[number],
	(value: number, limit: number) => string
> = {
	p95_ms: (value, limit) => `p95 ${value} ms vs ${limit} ms SLO`,
	error_rate_pct: (value, limit) => `error rate ${value}% vs ${limit}% budget`,
};

/** One service as readable text: one line, or a block when detailed. */
function describe(entry: HealthEntry): string {
	const breaches = entry.slo_breaches.map((b) =>
		BREACH_TEXT[b.metric](b.value, b.limit),
	);
	const summary =
		breaches.length > 0 ? `${breaches.join("; ")}.` : "within SLO.";
	const { slo } = entry;
	if (slo === undefined) {
		return `- ${entry.service_id}: ${entry.status}, ${summary}`;
	}
	const checks = SLO_METRICS.map((metric) => {
		const { value, limit, breached } = slo[metric];
		return SLO_TEXT[metric](value, limit) + (breached ? " (breached)" : "");
	});
	return [
		`- ${entry.service_id} (${entry.name}, team ${entry.team_id}, tier ${entry.tier}): ${entry.status}.`,
		`  ${entry.description}`,
		`  ${checks.join("; ")}; ${entry.throughput_rpm} requests per minute.`,
		...(entry.log_excerpts ?? []).map((excerpt) => `  log: ${excerpt}`),
	].join("\n");
}

export const getServiceHealthTool = defineTool({
	name: "get_service_health",
	title: "Get service health",
	description: [
		"Current health of one Fernhill service: status (healthy, degraded or down), p95 latency and error rate, each compared to the service's SLO. With no `service`, lists every service that is not healthy, worst first.",
		"Use when: starting an investigation (omit `service` to see what is unhealthy), or checking one service a user names or another tool returned.",
		"Do not use for: what a service depends on or what depends on it (use get_service_dependencies), recent changes (use list_recent_deploys), or past incidents (use search_incidents).",
		"`concise` (default) gives status and any breached SLO. `detailed` adds the owning team, tier, description, both SLO comparisons, throughput and log excerpts; use it when the status alone doesn't explain the problem.",
		'Example input: {"service": "checkout-api", "response_format": "detailed"}',
	].join("\n\n"),
	inputSchema: z.strictObject({
		service: ServiceRefSchema.optional().describe(
			"Service ID or name, such as `checkout-api` or `Checkout API`. Omit to list every service that is not healthy.",
		),
		response_format: ResponseFormatSchema,
		limit: LimitSchema.describe(
			"Most services to list when `service` is omitted, 5 by default, at most 20.",
		),
	}),
	outputSchema: OutputSchema,
	annotations: { ...READ_ONLY },
	handler({ service: query, response_format: format, limit }, context) {
		const { catalog, scenario } = context;

		if (query !== undefined) {
			const lookup = findService(catalog, query);
			if (!lookup.found) {
				return serviceNotFound(
					query,
					lookup.suggestions,
					"Call get_service_health without `service` to list the services that are not healthy, or ask the user which service they mean.",
				);
			}
			const entry = toEntry(getServiceHealth(scenario, lookup.service), format);
			return ok(describe(entry), {
				scenario_id: scenario.id,
				services: [entry],
				more_available: 0,
			});
		}

		const unhealthy = listUnhealthyServices(catalog, scenario);
		const total = catalog.services.length;
		if (unhealthy.length === 0) {
			return ok(`All ${total} services are healthy and within their SLOs.`, {
				scenario_id: scenario.id,
				services: [],
				more_available: 0,
			});
		}
		const capped = capList(unhealthy, limit);
		const entries = capped.shown.map((h) => toEntry(h, format));
		const healthy = total - unhealthy.length;
		const heading = `${unhealthy.length} of ${total} services are not healthy (${healthy} healthy), worst first:`;
		const text = [heading, ...entries.map(describe)].join("\n");
		return ok(
			text +
				moreLine(
					capped,
					"Raise `limit` (at most 20) or pass `service` to check one.",
				),
			{
				scenario_id: scenario.id,
				services: entries,
				more_available: capped.more_available,
			},
		);
	},
});
