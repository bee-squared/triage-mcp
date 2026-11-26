import type {
	CallToolResult,
	McpServer,
	StandardSchemaWithJSON,
	ToolAnnotations,
	ToolCallback,
} from "@modelcontextprotocol/server";
import { z } from "zod";
import type { AcknowledgementStore } from "../domain/acknowledgements.js";
import type { Catalog } from "../domain/fixtures.js";
import type { Scenario } from "../domain/schemas.js";

// Helpers every tool shares, so all 8 tools answer, fail and cap lists the
// same way. Tools map domain results to text plus structured content; the
// domain layer never sees MCP types.

/** What a tool handler can read. Built once per server by `createServer`. */
export interface ToolContext {
	readonly catalog: Catalog;
	readonly scenario: Scenario;
	readonly ackStore: AcknowledgementStore;
}

// ---------------------------------------------------------------------------
// Inputs

export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 20;

/** Longest service or team name a tool accepts. Real names are under 20. */
export const MAX_NAME_LENGTH = 100;

export const LimitSchema = z
	.int({ error: `limit must be a whole number from 1 to ${MAX_LIMIT}` })
	.min(1, { error: `limit must be a whole number from 1 to ${MAX_LIMIT}` })
	.max(MAX_LIMIT, {
		error: `limit must be a whole number from 1 to ${MAX_LIMIT}`,
	})
	.default(DEFAULT_LIMIT)
	.describe(
		`Most results to return, ${DEFAULT_LIMIT} by default, at most ${MAX_LIMIT}.`,
	);

export const RESPONSE_FORMATS = ["concise", "detailed"] as const;
export type ResponseFormat = (typeof RESPONSE_FORMATS)[number];

export const ResponseFormatSchema = z
	.enum(RESPONSE_FORMATS, {
		error: `response_format must be one of: ${RESPONSE_FORMATS.join(", ")}`,
	})
	.default("concise")
	.describe(
		"`concise` (default) for the key facts. `detailed` adds the full record, such as log excerpts.",
	);

/** A service ID or display name, such as `checkout-api` or `Checkout API`. */
export const ServiceRefSchema = z
	.string({ error: "service must be a service ID or name, as a string" })
	.trim()
	.min(1, { error: "service must not be empty" })
	.max(MAX_NAME_LENGTH, {
		error: `service must be at most ${MAX_NAME_LENGTH} characters`,
	});

// ---------------------------------------------------------------------------
// Results

/**
 * Why a call failed, for the eval scorers. `invalid_argument` is a bad call
 * the model should not have made. `not_found` and `empty` can be the right
 * call with an unlucky answer (S4 asks about a service that doesn't exist).
 *
 * Input that fails the Zod schema never reaches a handler: the SDK answers
 * with its own tool error, whose text starts `Input validation error:`.
 * Scorers treat that as `invalid_argument` too.
 */
export const ERROR_KINDS = ["invalid_argument", "not_found", "empty"] as const;
export type ErrorKind = (typeof ERROR_KINDS)[number];

/** `_meta` key holding `ToolErrorMeta` on every error a handler returns. */
export const ERROR_META_KEY = "triage-mcp/error";

export interface ToolErrorMeta {
	readonly kind: ErrorKind;
	/** Valid IDs close to what was asked for, best first. At most 3. */
	readonly suggestions: readonly string[];
}

/** A successful result: readable text for the model, data for the schema. */
export function ok<T extends Record<string, unknown>>(
	text: string,
	structuredContent: T,
): CallToolResult & { structuredContent: T } {
	return { content: [{ type: "text", text }], structuredContent };
}

/**
 * A tool-error result, never a protocol error: the model reads the message
 * and can recover. The message should say what was wrong and what to do
 * next. Suggestions are appended as "Did you mean ...?".
 *
 * The error kind travels in `_meta`, not `structuredContent`, because
 * structured content must match the tool's output schema.
 */
export function toolError(
	kind: ErrorKind,
	message: string,
	suggestions: readonly string[] = [],
): CallToolResult {
	const top = suggestions.slice(0, 3);
	const hint =
		top.length > 0
			? ` Did you mean ${top.map((s) => `\`${s}\``).join(", ")}?`
			: "";
	const meta: ToolErrorMeta = { kind, suggestions: top };
	return {
		isError: true,
		content: [{ type: "text", text: `${message}${hint}` }],
		_meta: { [ERROR_META_KEY]: meta },
	};
}

/** The not-found error for a service, with closest matches or a next step. */
export function serviceNotFound(
	query: string,
	suggestions: readonly string[],
	nextStep: string,
): CallToolResult {
	const lead = `No service matches "${query}".`;
	return suggestions.length > 0
		? toolError("not_found", lead, suggestions)
		: toolError(
				"not_found",
				`${lead} No service has a similar name. ${nextStep}`,
			);
}

export interface Capped<T> {
	readonly shown: readonly T[];
	/** How many matched but were left out. */
	readonly more_available: number;
}

/** Keeps the first `limit` items, which callers have already ranked. */
export function capList<T>(items: readonly T[], limit: number): Capped<T> {
	return {
		shown: items.slice(0, limit),
		more_available: Math.max(0, items.length - limit),
	};
}

/**
 * The line that ends a capped list's text, so the model knows results were
 * left out and how to see them. Empty when nothing was left out.
 */
export function moreLine(capped: Capped<unknown>, narrow: string): string {
	if (capped.more_available === 0) return "";
	return `\n${capped.more_available} more not shown. ${narrow}`;
}

// ---------------------------------------------------------------------------
// Registration

/** Every tool is read-only except `acknowledge_incident`. */
export const READ_ONLY: ToolAnnotations = {
	readOnlyHint: true,
	destructiveHint: false,
	idempotentHint: true,
	openWorldHint: false,
};

/**
 * One MCP tool. Each file in `src/tools/` exports one, and `createServer`
 * registers them all. The description must say when to use the tool, when
 * not to, and give an example input (PRD FR-11); a test checks this.
 */
export interface ToolDefinition<
	Input extends StandardSchemaWithJSON,
	Output extends StandardSchemaWithJSON,
> {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: Input;
	readonly outputSchema: Output;
	readonly annotations: ToolAnnotations;
	readonly handler: (
		input: StandardSchemaWithJSON.InferOutput<Input>,
		context: ToolContext,
	) => CallToolResult;
}

/** Identity function that infers a tool's input type from its schema. */
export function defineTool<
	Input extends StandardSchemaWithJSON,
	Output extends StandardSchemaWithJSON,
>(tool: ToolDefinition<Input, Output>): ToolDefinition<Input, Output> {
	return tool;
}

export function registerTool<
	Input extends StandardSchemaWithJSON,
	Output extends StandardSchemaWithJSON,
>(
	server: McpServer,
	tool: ToolDefinition<Input, Output>,
	context: ToolContext,
): void {
	const { name, handler, ...config } = tool;
	// The callback type is conditional on `Input`, which TypeScript can't
	// resolve for a generic, so name the type arguments and the callback type.
	const callback = ((input: StandardSchemaWithJSON.InferOutput<Input>) =>
		handler(input, context)) as ToolCallback<Input>;
	server.registerTool<Output, Input>(name, config, callback);
}
