import { z } from "zod";
import { DEFAULT_SCENARIO, SCENARIO_IDS } from "./domain/schemas.js";

// Environment configuration, validated once at startup. A bad value stops the
// process with a message naming the variable and the accepted values.

const csv = z
	.string()
	.transform((value) =>
		value
			.split(",")
			.map((part) => part.trim())
			.filter((part) => part.length > 0),
	)
	.pipe(z.array(z.string()).min(1, "must list at least one host"));

const EnvSchema = z.object({
	SCENARIO: z.enum(SCENARIO_IDS).default(DEFAULT_SCENARIO),
	/** Only the triage CLI and evals need this; the server never reads it. */
	ANTHROPIC_API_KEY: z.string().optional(),
	ALLOWED_HOSTS: csv.default(["localhost", "127.0.0.1"]),
	RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(60),
});

export type Config = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

/**
 * Parses configuration from environment variables. Empty values (`KEY=`, as
 * in `.env.example`) count as unset so defaults apply.
 */
export function loadConfig(
	env: Record<string, string | undefined> = process.env,
): Config {
	const present = Object.fromEntries(
		Object.entries(env).filter(
			([, value]) => value !== undefined && value.trim() !== "",
		),
	);
	const result = EnvSchema.safeParse(present);
	if (result.success) return result.data;
	const lines = result.error.issues.map(
		(issue) => `  ${issue.path.join(".")}: ${issue.message}`,
	);
	throw new ConfigError(`Invalid configuration:\n${lines.join("\n")}`);
}
