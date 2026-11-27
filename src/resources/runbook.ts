import {
	type McpServer,
	ResourceNotFoundError,
	ResourceTemplate,
} from "@modelcontextprotocol/server";
import type { Catalog } from "../domain/fixtures.js";
import { findById, RUNBOOK_ID } from "../domain/ids.js";
import type { Runbook } from "../domain/schemas.js";

// Each runbook as a markdown resource at `runbook://RB-07` (PRD FR-18). The
// `find_runbook` tool returns the same content to the model; the resource is
// for clients and people who browse or attach a runbook directly.

export const RUNBOOK_URI_TEMPLATE = "runbook://{runbook_id}";

export const runbookUri = (id: string): string => `runbook://${id}`;

const numbered = (steps: readonly string[]): string[] =>
	steps.map((step, i) => `${i + 1}. ${step}`);

/** One runbook as markdown, with the escalation team's name and channel. */
export function runbookMarkdown(runbook: Runbook, catalog: Catalog): string {
	const team = catalog.teams.find((t) => t.id === runbook.escalation.team_id);
	const teamLine = team
		? `${team.name} (\`${team.id}\`, ${team.escalation_channel})`
		: `\`${runbook.escalation.team_id}\``;
	return [
		`# ${runbook.id}: ${runbook.title}`,
		"",
		`Applies to: ${runbook.applies_to_service_ids.map((id) => `\`${id}\``).join(", ")}`,
		"",
		"## Symptoms",
		"",
		...runbook.symptoms.map((s) => `- ${s}`),
		"",
		"## Diagnose",
		"",
		...numbered(runbook.diagnostic_steps),
		"",
		"## Remediate",
		"",
		...numbered(runbook.remediation_steps),
		"",
		"## Roll back",
		"",
		...(runbook.rollback_steps.length > 0
			? numbered(runbook.rollback_steps)
			: ["None: there is no change to undo."]),
		"",
		"## Escalate",
		"",
		`Team: ${teamLine}`,
		"",
		`When: ${runbook.escalation.when}`,
		"",
	].join("\n");
}

export function registerRunbookResources(
	server: McpServer,
	catalog: Catalog,
): void {
	const { runbooks } = catalog;
	const template = new ResourceTemplate(RUNBOOK_URI_TEMPLATE, {
		list: () => ({
			resources: runbooks.map((r) => ({
				uri: runbookUri(r.id),
				name: r.id,
				title: `${r.id}: ${r.title}`,
				description: `Runbook for ${r.applies_to_service_ids.join(", ")}.`,
				mimeType: "text/markdown",
			})),
		}),
		complete: {
			runbook_id: (value) => {
				const prefix = value.trim().toUpperCase();
				return runbooks.map((r) => r.id).filter((id) => id.startsWith(prefix));
			},
		},
	});

	server.registerResource(
		"runbook",
		template,
		{
			title: "Fernhill runbook",
			description:
				"One Fernhill runbook as markdown: symptoms, diagnostic, remediation and rollback steps, and when to escalate to which team. IDs look like `RB-07`.",
			mimeType: "text/markdown",
		},
		(uri, variables) => {
			const raw = variables.runbook_id;
			const requested = decodeURIComponent(
				(Array.isArray(raw) ? raw[0] : raw) ?? "",
			);
			// One URI per runbook: only the canonical ID resolves, so a client
			// can't cache the same runbook under two addresses. Near misses get
			// the same digit-typo suggestions as `find_runbook`.
			const runbook = runbooks.find((r) => r.id === requested);
			if (!runbook) {
				throw new ResourceNotFoundError(
					uri.href,
					notFoundMessage(requested, catalog),
				);
			}
			return {
				contents: [
					{
						uri: uri.href,
						mimeType: "text/markdown",
						text: runbookMarkdown(runbook, catalog),
					},
				],
			};
		},
	);
}

function notFoundMessage(requested: string, catalog: Catalog): string {
	const lookup = findById(RUNBOOK_ID, catalog.runbooks, requested);
	switch (lookup.status) {
		case "found":
			return `No runbook "${requested}". Use the canonical URI ${runbookUri(lookup.record.id)}.`;
		case "not_found":
			return lookup.suggestions.length > 0
				? `No runbook ${lookup.id}. Did you mean ${lookup.suggestions.map(runbookUri).join(", ")}?`
				: `No runbook ${lookup.id}. List resources to see every runbook.`;
		case "malformed":
			return `"${requested}" is not a runbook ID. Runbook URIs look like ${runbookUri("RB-07")}.`;
	}
}
