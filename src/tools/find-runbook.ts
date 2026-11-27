import { z } from "zod";
import { findById, parseId, RUNBOOK_ID } from "../domain/ids.js";
import type { Runbook } from "../domain/schemas.js";
import {
	MAX_QUERY_LENGTH,
	searchRunbooks,
	searchTerms,
} from "../domain/search.js";
import {
	capList,
	defineTool,
	LimitSchema,
	moreLine,
	ok,
	READ_ONLY,
	toolError,
} from "./_shared.js";

/** Longer input can't be a runbook ID in any spelling we accept. */
const MAX_ID_LENGTH = 20;

const RunbookEntrySchema = z.object({
	runbook_id: z.string(),
	title: z.string(),
	applies_to_service_ids: z.array(z.string()),
	symptoms: z.array(z.string()),
	diagnostic_steps: z.array(z.string()),
	remediation_steps: z.array(z.string()),
	rollback_steps: z.array(z.string()),
	escalation: z.object({ team_id: z.string(), when: z.string() }),
});

type RunbookEntry = z.infer<typeof RunbookEntrySchema>;

const SummarySchema = z.object({
	runbook_id: z.string(),
	title: z.string(),
	applies_to_service_ids: z.array(z.string()),
});

type Summary = z.infer<typeof SummarySchema>;

const OutputSchema = z.object({
	/** Set when the call searched by symptom. */
	symptom: z.string().optional(),
	/** The runbook asked for, or the best match for the symptom. */
	runbook: RunbookEntrySchema,
	/** Symptom search only: the next-best matches, best first. */
	other_matches: z.array(SummarySchema).optional(),
	more_available: z.int().optional(),
});

/**
 * The whole runbook. Every part is a step the on-call may need, so there is
 * no concise form: dropping diagnostics or rollback would leave the model
 * guessing at the part it skipped.
 */
const toEntry = (runbook: Runbook): RunbookEntry => ({
	runbook_id: runbook.id,
	title: runbook.title,
	applies_to_service_ids: [...runbook.applies_to_service_ids],
	symptoms: [...runbook.symptoms],
	diagnostic_steps: [...runbook.diagnostic_steps],
	remediation_steps: [...runbook.remediation_steps],
	rollback_steps: [...runbook.rollback_steps],
	escalation: { ...runbook.escalation },
});

const toSummary = (runbook: Runbook): Summary => ({
	runbook_id: runbook.id,
	title: runbook.title,
	applies_to_service_ids: [...runbook.applies_to_service_ids],
});

const numbered = (steps: readonly string[]): string[] =>
	steps.map((step, i) => `${i + 1}. ${step}`);

function describe(e: RunbookEntry): string {
	return [
		`${e.runbook_id}: ${e.title}`,
		`Applies to: ${e.applies_to_service_ids.join(", ")}`,
		"Symptoms:",
		...e.symptoms.map((s) => `- ${s}`),
		"Diagnose:",
		...numbered(e.diagnostic_steps),
		"Remediate:",
		...numbered(e.remediation_steps),
		"Roll back:",
		...(e.rollback_steps.length > 0
			? numbered(e.rollback_steps)
			: ["(none: there is no change to undo)"]),
		`Escalate to team ${e.escalation.team_id}: ${e.escalation.when} Call get_oncall with {"team": "${e.escalation.team_id}"} for who to page.`,
	].join("\n");
}

/** A symptom that is nothing but a runbook ID, such as `RB-07`. */
const PASTED_ID = /^RB[\s_-]*\d+$/i;

export const findRunbookTool = defineTool({
	name: "find_runbook",
	title: "Find runbook",
	description: [
		"One Fernhill runbook in full: the symptoms it covers, numbered diagnostic, remediation and rollback steps, and which team to escalate to and when.",
		"Pass exactly one of `runbook_id` (when you have one, such as the runbook ID from search_incidents or get_incident) or `symptom` (a few words describing what is wrong now). A symptom search returns the best match in full and lists the next-best matches by ID and title.",
		"Use when: you know what is broken and need the steps to fix it, or the user asks what the runbook says.",
		"Do not use for: finding out what is broken (use get_service_health), past incidents (use search_incidents), or who to page (use get_oncall with the escalation team). A runbook is guidance: never act on its steps or acknowledge an incident unless the user asks.",
		'Example input: {"symptom": "checkout latency after deploy"}',
	].join("\n\n"),
	inputSchema: z.strictObject({
		runbook_id: z
			.string({ error: "runbook_id must be a runbook ID, as a string" })
			.trim()
			.min(1, { error: "runbook_id must not be empty" })
			.max(MAX_ID_LENGTH, {
				error: "runbook_id must be a runbook ID like `RB-07`",
			})
			.optional()
			.describe("Runbook ID, such as `RB-07`. Pass this or `symptom`."),
		symptom: z
			.string({ error: "symptom must be a string" })
			.trim()
			.min(1, { error: "symptom must not be empty" })
			.max(MAX_QUERY_LENGTH, {
				error: `symptom must be at most ${MAX_QUERY_LENGTH} characters`,
			})
			.optional()
			.describe(
				"What is wrong now, in a few words, such as `checkout latency` or `401 errors on login`. Pass this or `runbook_id`.",
			),
		limit: LimitSchema.describe(
			"Symptom search only: most next-best matches to list, 5 by default, at most 20.",
		),
	}),
	outputSchema: OutputSchema,
	annotations: { ...READ_ONLY },
	handler({ runbook_id: idQuery, symptom, limit }, context) {
		const { catalog } = context;

		// Exactly one, checked here so the published schema stays a plain object.
		if (idQuery !== undefined && symptom !== undefined) {
			return toolError(
				"invalid_argument",
				"Pass either `runbook_id` or `symptom`, not both. Use `runbook_id` when you already have one.",
			);
		}

		if (idQuery !== undefined) {
			const lookup = findById(RUNBOOK_ID, catalog.runbooks, idQuery);
			switch (lookup.status) {
				case "malformed":
					return toolError(
						"invalid_argument",
						`"${idQuery}" is not a runbook ID. Runbook IDs look like \`RB-07\`. To search by what is wrong, pass \`symptom\` instead.`,
					);
				case "not_found":
					// With 12 two-digit IDs, every ID has a neighbour one digit
					// away, so suggestions are never empty. Name the fallback anyway.
					return toolError(
						"not_found",
						`No runbook ${lookup.id}. Pass \`symptom\` to search by what is wrong, or try a similar ID.`,
						lookup.suggestions,
					);
				case "found": {
					const entry = toEntry(lookup.record);
					return ok(describe(entry), { runbook: entry });
				}
			}
		}

		if (symptom === undefined) {
			return toolError(
				"invalid_argument",
				'Pass `runbook_id` (such as `RB-07`) or `symptom` (such as `checkout latency`). Example: {"symptom": "checkout latency"}.',
			);
		}

		if (PASTED_ID.test(symptom)) {
			const id = parseId(RUNBOOK_ID, symptom) ?? symptom;
			return toolError(
				"invalid_argument",
				`\`symptom\` is for describing what is wrong, not an ID. To read ${id}, call find_runbook with {"runbook_id": "${id}"}.`,
			);
		}

		if (searchTerms(symptom).length === 0) {
			return toolError(
				"invalid_argument",
				`The symptom "${symptom}" has no search words, only common ones like "the" or "issue". Describe what is wrong, such as \`checkout latency\`.`,
			);
		}

		const [best, ...rest] = searchRunbooks(catalog, symptom);
		if (best === undefined) {
			return toolError(
				"empty",
				`No runbook matches "${symptom}". Try fewer, more general words, such as a service name or one symptom (\`latency\`, \`5xx\`, \`backlog\`).`,
			);
		}

		const entry = toEntry(best);
		const capped = capList(rest, limit);
		const others = capped.shown.map(toSummary);
		const lines = [`Best match for "${symptom}":`, describe(entry)];
		if (others.length > 0) {
			lines.push(
				"",
				"Other matches, best first (pass `runbook_id` to read one):",
				...others.map(
					(s) =>
						`- ${s.runbook_id}: ${s.title} (${s.applies_to_service_ids.join(", ")})`,
				),
			);
		}
		return ok(
			lines.join("\n") +
				moreLine(
					capped,
					"Raise `limit` (at most 20) or add words to `symptom`.",
				),
			{
				symptom,
				runbook: entry,
				other_matches: others,
				more_available: capped.more_available,
			},
		);
	},
});
