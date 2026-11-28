import type Anthropic from "@anthropic-ai/sdk";
import {
	type CallToolResult,
	Client,
	InMemoryTransport,
	type Tool,
} from "@modelcontextprotocol/client";
import {
	type AcknowledgementStore,
	createAcknowledgementStore,
} from "../domain/acknowledgements.js";
import type { ScenarioId } from "../domain/schemas.js";
import { createServer } from "../server.js";
import {
	ERROR_META_KEY,
	type ErrorKind,
	type ToolErrorMeta,
} from "../tools/_shared.js";

// The agent's side of MCP: a real client connected to a fresh server over an
// in-memory transport. The agent reaches the tools through the protocol, the
// same path Claude Desktop takes over stdio, so schema validation and tool
// errors behave exactly as they do for any other client.

/** What the agent needs from a tool call. */
export interface ToolOutcome {
	/** Every text block, joined: what the model reads. */
	readonly text: string;
	readonly isError: boolean;
	/** Why it failed, when it did: from `_meta`, or by the SDK's text prefix. */
	readonly errorKind: ErrorKind | "protocol" | null;
}

export interface McpSession {
	/** The server's tools as Claude API tool definitions, in server order. */
	readonly tools: readonly Anthropic.Beta.BetaTool[];
	readonly ackStore: AcknowledgementStore;
	/** Calls a tool. Never throws: protocol failures come back as errors. */
	callTool(name: string, input: unknown): Promise<ToolOutcome>;
	close(): Promise<void>;
}

export interface ConnectOptions {
	readonly scenario: ScenarioId;
	/** A fresh store per run unless the caller passes one (FR-31: evals). */
	readonly ackStore?: AcknowledgementStore;
}

/** Starts a fresh server for one run and connects a client to it. */
export async function connectInProcess({
	scenario,
	ackStore = createAcknowledgementStore(),
}: ConnectOptions): Promise<McpSession> {
	const server = createServer({ scenario, ackStore });
	const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "triage-agent", version: "0.1.0" });
	await client.connect(clientSide);
	const { tools } = await client.listTools();
	return {
		tools: tools.map(toAnthropicTool),
		ackStore,
		callTool: async (name, input) => {
			try {
				const result = (await client.callTool({
					name,
					arguments: isRecord(input) ? input : {},
				})) as CallToolResult;
				return toOutcome(result);
			} catch (error) {
				// An unknown tool name, for example. The model gets the message
				// as a failed tool result and can recover.
				const message = error instanceof Error ? error.message : String(error);
				return { text: message, isError: true, errorKind: "protocol" };
			}
		},
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

/**
 * Converts an MCP tool to a Claude API tool definition. The input schema is
 * passed through as published (minus `$schema`), with no `strict: true`:
 * strict decoding would guarantee valid arguments, and the eval's
 * argument-validity scorer exists to catch invalid ones.
 */
export function toAnthropicTool(tool: Tool): Anthropic.Beta.BetaTool {
	const { $schema: _ignored, ...inputSchema } = tool.inputSchema as Record<
		string,
		unknown
	>;
	return {
		name: tool.name,
		description: tool.description ?? "",
		input_schema: inputSchema as Anthropic.Beta.BetaTool.InputSchema,
	};
}

/** The prefix the SDK puts on schema validation errors (DECISIONS 2026-11-24). */
const SDK_VALIDATION_PREFIX = "Input validation error:";

export function toOutcome(result: CallToolResult): ToolOutcome {
	const text = result.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
	if (!result.isError) return { text, isError: false, errorKind: null };
	const meta = result._meta?.[ERROR_META_KEY] as ToolErrorMeta | undefined;
	const errorKind =
		meta?.kind ??
		(text.startsWith(SDK_VALIDATION_PREFIX) ? "invalid_argument" : "protocol");
	return { text, isError: true, errorKind };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
