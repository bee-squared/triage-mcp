import type Anthropic from "@anthropic-ai/sdk";
import type { CreateMessage } from "../../src/agent/loop.js";

// A scripted stand-in for the Claude API, so agent tests run with no key and
// no network. Each call returns the next scripted response and records the
// request it was given.

type Message = Anthropic.Beta.BetaMessage;
type Block = Anthropic.Beta.BetaContentBlock;
type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export interface FakeMessage {
	readonly content: readonly Block[];
	readonly stop_reason: Message["stop_reason"];
	readonly model?: string;
	readonly usage?: Partial<Anthropic.Beta.BetaUsage>;
	readonly stop_details?: Message["stop_details"];
}

let nextId = 0;

export function message({
	content,
	stop_reason,
	model = "claude-sonnet-5-5",
	usage = {},
	stop_details = null,
}: FakeMessage): Message {
	return {
		id: `msg_${++nextId}`,
		type: "message",
		role: "assistant",
		model,
		content: [...content],
		stop_reason,
		stop_sequence: null,
		stop_details,
		container: null,
		context_management: null,
		diagnostics: null,
		usage: {
			input_tokens: 1000,
			output_tokens: 100,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation: null,
			fallback_credit: null,
			inference_geo: null,
			iterations: null,
			output_tokens_details: null,
			server_tool_use: null,
			service_tier: "standard",
			speed: "standard",
			...usage,
		},
	} as unknown as Message;
}

export const text = (value: string): Block =>
	({ type: "text", text: value, citations: null }) as Block;

export const thinking = (signature: string): Block =>
	({ type: "thinking", thinking: "", signature }) as Block;

export const toolUse = (
	id: string,
	name: string,
	input: Record<string, unknown> = {},
): Block => ({ type: "tool_use", id, name, input }) as unknown as Block;

/** One turn that calls the given tools. */
export const callTools = (...uses: Block[]): Message =>
	message({ content: uses, stop_reason: "tool_use" });

/** A final answer. */
export const answer = (value: string): Message =>
	message({ content: [text(value)], stop_reason: "end_turn" });

export interface Scripted {
	readonly createMessage: CreateMessage;
	/** Every request, deep-copied at the time it was sent. */
	readonly requests: CreateParams[];
}

/** Returns each response in turn; a function computes one from the request. */
export function scripted(
	responses: ReadonlyArray<
		Message | Error | ((params: CreateParams) => Message)
	>,
): Scripted {
	const requests: CreateParams[] = [];
	let i = 0;
	return {
		requests,
		createMessage: async (params) => {
			requests.push(structuredClone(params));
			const next = responses[Math.min(i++, responses.length - 1)];
			if (next === undefined) throw new Error("no scripted response");
			if (next instanceof Error) throw next;
			return typeof next === "function" ? next(params) : next;
		},
	};
}
