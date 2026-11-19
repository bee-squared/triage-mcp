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

export const ServicesFileSchema = z.array(ServiceSchema).min(1);
export const DependenciesFileSchema = z.array(DependencySchema);
export const TeamsFileSchema = z.array(TeamSchema).min(1);
export const OnCallFileSchema = z.array(OnCallShiftSchema);

/** The 6 MVP scenarios (PRD FR-35). Data sets arrive with PR 3b. */
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

export type Service = z.infer<typeof ServiceSchema>;
export type Dependency = z.infer<typeof DependencySchema>;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
export type Team = z.infer<typeof TeamSchema>;
export type OnCallShift = z.infer<typeof OnCallShiftSchema>;
export type ScenarioId = z.infer<typeof ScenarioIdSchema>;
