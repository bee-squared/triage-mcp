import {
	type CallToolResult,
	Client,
	InMemoryTransport,
} from "@modelcontextprotocol/client";
import {
	type AcknowledgementStore,
	createAcknowledgementStore,
} from "../../src/domain/acknowledgements.js";
import type { ScenarioId } from "../../src/domain/schemas.js";
import { createServer } from "../../src/server.js";
import { ERROR_META_KEY, type ToolErrorMeta } from "../../src/tools/_shared.js";

// Connects a real MCP client to a fresh server over an in-memory transport,
// so tests go through the same protocol path as Claude: schema validation,
// tool errors and structured content included.

export interface Harness {
	readonly client: Client;
	readonly ackStore: AcknowledgementStore;
	/** Calls a tool. Bad input comes back as a tool error, never a throw. */
	call(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
	close(): Promise<void>;
}

export interface HarnessOptions {
	readonly scenario?: ScenarioId;
	readonly ackStore?: AcknowledgementStore;
}

export async function connect({
	scenario = "checkout-latency",
	ackStore = createAcknowledgementStore({
		now: () => new Date("2026-01-01T00:00:00Z"),
	}),
}: HarnessOptions = {}): Promise<Harness> {
	const server = createServer({ scenario, ackStore });
	const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
	await server.connect(serverSide);
	const client = new Client({ name: "test-client", version: "0.0.0" });
	await client.connect(clientSide);
	return {
		client,
		ackStore,
		call: async (name, args = {}) =>
			(await client.callTool({ name, arguments: args })) as CallToolResult,
		close: async () => {
			await client.close();
			await server.close();
		},
	};
}

/** All text blocks of a result, joined. */
export function textOf(result: CallToolResult): string {
	return result.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("\n");
}

/** The kind and suggestions a handler attached to a tool error. */
export function errorMeta(result: CallToolResult): ToolErrorMeta | undefined {
	return result._meta?.[ERROR_META_KEY] as ToolErrorMeta | undefined;
}
