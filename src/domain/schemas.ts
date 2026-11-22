import { z } from "zod";

// Fixture record schemas (PRD section 9). Field names stay snake_case to match
// the JSON files and the structured content tools return.

const slug = z
	.string()
	.regex(
		/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/,
		"must be a lowercase slug like `payment-gateway`",
	);

export const ServiceIdSchema = slug;
export const TeamIdSchema = slug;

/** Role-style on-call handle (`payments-primary`), never a person's name. */
export const HandleSchema = z
	.string()
	.regex(
		/^[a-z][a-z0-9]*(-[a-z0-9]+)*-(primary|secondary)$/,
		"must be a role-style handle ending in -primary or -secondary, like `payments-primary`",
	);

export const ServiceSchema = z.strictObject({
	id: ServiceIdSchema,
	name: z.string().min(1).max(60),
	team_id: TeamIdSchema,
	tier: z.int().min(1).max(3),
	description: z.string().min(1).max(300),
	slo_availability_pct: z.number().gt(0).max(100),
	slo_p95_ms: z.int().positive(),
});

export const DEPENDENCY_KINDS = ["sync", "async", "external"] as const;

/** `from_service_id` calls (depends on) `to_service_id`. */
export const DependencySchema = z.strictObject({
	from_service_id: ServiceIdSchema,
	to_service_id: ServiceIdSchema,
	kind: z.enum(DEPENDENCY_KINDS),
});

export const TeamSchema = z.strictObject({
	id: TeamIdSchema,
	name: z.string().min(1).max(60),
	escalation_channel: z
		.string()
		.regex(
			/^#[a-z0-9]+(-[a-z0-9]+)*$/,
			"must be a channel name like `#payments-escalation`",
		),
});

export const OnCallShiftSchema = z
	.strictObject({
		team_id: TeamIdSchema,
		primary_handle: HandleSchema,
		secondary_handle: HandleSchema,
	})
	.refine((shift) => shift.primary_handle !== shift.secondary_handle, {
		message: "primary_handle and secondary_handle must differ",
		path: ["secondary_handle"],
	});

/** Stable runbook ID (`RB-07`). Eval answer keys reference these. */
export const RunbookIdSchema = z
	.string()
	.regex(/^RB-\d{2}$/, "must be a runbook ID like `RB-07`");

const step = z.string().min(1).max(300);

export const RunbookSchema = z.strictObject({
	id: RunbookIdSchema,
	title: z.string().min(1).max(80),
	/** Observable symptoms, phrased the way an alert or a user would describe them. */
	symptoms: z.array(z.string().min(1).max(160)).min(1),
	applies_to_service_ids: z.array(ServiceIdSchema).min(1),
	diagnostic_steps: z.array(step).min(1),
	remediation_steps: z.array(step).min(1),
	/** Empty when there is no change to undo (for example, an expired certificate). */
	rollback_steps: z.array(step),
	escalation: z.strictObject({
		team_id: TeamIdSchema,
		/** When to page the team instead of continuing the runbook. */
		when: z.string().min(1).max(200),
	}),
});

/** Stable incident ID (`INC-0142`). Eval answer keys reference these. */
export const IncidentIdSchema = z
	.string()
	.regex(/^INC-\d{4}$/, "must be an incident ID like `INC-0142`");

/** Shared with `acknowledge_incident`. */
export const SEVERITIES = ["SEV1", "SEV2", "SEV3", "SEV4"] as const;
export const SeveritySchema = z.enum(SEVERITIES);

export const ACTION_ITEM_STATUSES = ["open", "in_progress", "done"] as const;

const prose = z.string().min(1).max(300);

export const IncidentSchema = z.strictObject({
	id: IncidentIdSchema,
	title: z.string().min(1).max(100),
	severity: SeveritySchema,
	/** How long before the scenario clock the incident started (relative, never a date). */
	days_before_start: z.int().positive().max(730),
	/** Services that showed symptoms, including the root-cause service. */
	affected_service_ids: z.array(ServiceIdSchema).min(1),
	symptoms: prose,
	root_cause_service_id: ServiceIdSchema,
	root_cause_summary: prose,
	resolution: prose,
	runbook_id: RunbookIdSchema,
	postmortem: z.strictObject({
		summary: prose,
		contributing_factors: z.array(z.string().min(1).max(200)).min(1),
		action_items: z
			.array(
				z.strictObject({
					description: z.string().min(1).max(200),
					owner_team_id: TeamIdSchema,
					status: z.enum(ACTION_ITEM_STATUSES),
				}),
			)
			.min(1),
	}),
});

export const ServicesFileSchema = z.array(ServiceSchema).min(1);
export const DependenciesFileSchema = z.array(DependencySchema);
export const TeamsFileSchema = z.array(TeamSchema).min(1);
export const OnCallFileSchema = z.array(OnCallShiftSchema);
export const RunbooksFileSchema = z.array(RunbookSchema).min(1);
export const IncidentsFileSchema = z.array(IncidentSchema).min(1);

/** The 6 MVP scenarios (PRD FR-35). Data sets live in `fixtures/scenarios/`. */
export const SCENARIO_IDS = [
	"checkout-latency",
	"auth-cert-expiry",
	"false-alarm",
	"unknown-service",
	"ack-guardrail",
	"blast-radius",
] as const;
export const ScenarioIdSchema = z.enum(SCENARIO_IDS);
export const DEFAULT_SCENARIO = "checkout-latency" satisfies ScenarioId;

export const SIGNAL_STATUSES = ["healthy", "degraded", "down"] as const;

const logExcerpt = z.string().min(1).max(199, "must be under 200 characters");

/** Signal fields every service has in every scenario (PRD section 9). */
const signalFields = {
	status: z.enum(SIGNAL_STATUSES),
	p95_ms: z.int().nonnegative(),
	error_rate_pct: z.number().min(0).max(100),
	throughput_rpm: z.int().nonnegative(),
	log_excerpts: z.array(logExcerpt).max(5),
};

/** One service's healthy baseline in `fixtures/base/signals.json`. */
export const BaselineSignalSchema = z.strictObject({
	service_id: ServiceIdSchema,
	...signalFields,
});

/** Fields a scenario changes for one service; the rest come from the baseline. */
export const SignalOverrideSchema = z
	.strictObject({
		service_id: ServiceIdSchema,
		...z.object(signalFields).partial().shape,
	})
	.refine(
		(override) =>
			Object.values(override).filter((v) => v !== undefined).length > 1,
		{
			message: "must override at least one field besides service_id",
		},
	);

/** Stable deploy ID (`DEP-1001`), unique across all data sets. */
export const DeployIdSchema = z
	.string()
	.regex(/^DEP-\d{4}$/, "must be a deploy ID like `DEP-1001`");

/** The widest deploy window a query accepts, so no deploy can be older. */
export const MAX_DEPLOY_WINDOW_MINUTES = 1440;

/** A deploy as stored in a scenario file; the resolver adds `scenario_id`. */
export const DeployRecordSchema = z.strictObject({
	id: DeployIdSchema,
	service_id: ServiceIdSchema,
	team_id: TeamIdSchema,
	version: z
		.string()
		.regex(/^v\d+\.\d+\.\d+$/, "must be a version like `v3.8.1`"),
	/** Offset from the scenario clock. */
	minutes_before_start: z.int().min(0).max(MAX_DEPLOY_WINDOW_MINUTES),
	change_summary: z.string().min(1).max(200),
});

/**
 * A scenario file. A data set lists overrides and deploys; a scenario that
 * reuses another's data (S5 reuses S1) names it in `extends` instead.
 */
export const ScenarioFileSchema = z
	.strictObject({
		id: ScenarioIdSchema,
		description: z.string().min(1).max(300),
		extends: ScenarioIdSchema.optional(),
		signal_overrides: z.array(SignalOverrideSchema).optional(),
		deploys: z.array(DeployRecordSchema).optional(),
	})
	.refine(
		(file) =>
			file.extends === undefined
				? file.signal_overrides !== undefined && file.deploys !== undefined
				: file.signal_overrides === undefined && file.deploys === undefined,
		{
			message:
				"must have either `extends` or both `signal_overrides` and `deploys`, not a mix",
		},
	);

export const BaselineSignalsFileSchema = z.array(BaselineSignalSchema).min(1);

export type Service = z.infer<typeof ServiceSchema>;
export type Dependency = z.infer<typeof DependencySchema>;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
export type Team = z.infer<typeof TeamSchema>;
export type OnCallShift = z.infer<typeof OnCallShiftSchema>;
export type Runbook = z.infer<typeof RunbookSchema>;
export type Severity = z.infer<typeof SeveritySchema>;
export type ActionItemStatus = (typeof ACTION_ITEM_STATUSES)[number];
export type Incident = z.infer<typeof IncidentSchema>;
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;
export type SignalStatus = (typeof SIGNAL_STATUSES)[number];
export type BaselineSignal = z.infer<typeof BaselineSignalSchema>;
export type SignalOverride = z.infer<typeof SignalOverrideSchema>;
export type DeployRecord = z.infer<typeof DeployRecordSchema>;
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

/** PRD SignalSnapshot: one per service per scenario, after the overlay. */
export interface SignalSnapshot extends BaselineSignal {
	readonly scenario_id: ScenarioId;
}

/** PRD Deploy, with the scenario it was resolved for. */
export interface Deploy extends DeployRecord {
	readonly scenario_id: ScenarioId;
}

/** A resolved scenario: a full signal set plus its deploys. */
export interface Scenario {
	readonly id: ScenarioId;
	readonly description: string;
	/** One snapshot per catalog service, in catalog order. */
	readonly signals: readonly SignalSnapshot[];
	/** Newest first. */
	readonly deploys: readonly Deploy[];
}
