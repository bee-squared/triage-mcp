import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildRequest,
	MAX_TOOL_CALLS,
	MAX_TURNS,
	runAgent,
} from "../../src/agent/loop.js";
import { connectInProcess, type McpSession } from "../../src/agent/mcp.js";
import { SYSTEM_PROMPT } from "../../src/agent/system-prompt.js";
import {
	answer,
	callTools,
	message,
	scripted,
	text,
	thinking,
	toolUse,
} from "./agent-fakes.js";

// The agent loop against a real in-process server and a scripted Claude.
// Tool calls go through MCP for real; only the model is faked.

let session: McpSession;
let clock: number;
const now = () => (clock += 5);

beforeEach(async () => {
	clock = 0;
	session = await connectInProcess({ scenario: "checkout-latency" });
});
afterEach(() => session.close());

const run = (
	createMessage: Parameters<typeof runAgent>[0]["createMessage"],
	extra: Partial<Parameters<typeof runAgent>[0]> = {},
) =>
	runAgent({
		question: "Checkout is slow, what's going on?",
		session,
		createMessage,
		scenario: "checkout-latency",
		now,
		...extra,
	});

describe("runAgent", () => {
	it("runs tool calls through MCP and returns the final answer", async () => {
		const api = scripted([
			callTools(toolUse("t1", "get_service_health")),
			callTools(toolUse("t2", "get_oncall", { service: "payment-gateway" })),
			answer("Root cause: payment-gateway."),
		]);
		const trace = await run(api.createMessage);

		expect(trace.status).toBe("answered");
		expect(trace.final_text).toBe("Root cause: payment-gateway.");
		expect(trace.stop_message).toBeNull();
		expect(trace.tool_calls.map((c) => [c.index, c.turn, c.name])).toEqual([
			[1, 1, "get_service_health"],
			[2, 2, "get_oncall"],
		]);
		const oncall = trace.tool_calls[1];
		expect(oncall?.arguments).toEqual({ service: "payment-gateway" });
		expect(oncall?.result).toContain("payments-primary");
		expect(oncall?.is_error).toBe(false);
		expect(api.requests).toHaveLength(3);
	});

	it("replays assistant content unchanged, thinking blocks included", async () => {
		const first = message({
			content: [
				thinking("sig-1"),
				text("Checking health first."),
				toolUse("t1", "get_service_health"),
			],
			stop_reason: "tool_use",
		});
		const api = scripted([first, answer("done")]);
		await run(api.createMessage);

		const second = api.requests[1]?.messages ?? [];
		expect(second[0]).toEqual({
			role: "user",
			content: "Checkout is slow, what's going on?",
		});
		expect(second[1]).toEqual({ role: "assistant", content: first.content });
		// The first request's history was not edited afterwards.
		expect(api.requests[0]?.messages).toEqual([second[0]]);
	});

	it("returns parallel tool results together in one user message", async () => {
		const api = scripted([
			callTools(
				toolUse("a", "get_service_health"),
				toolUse("b", "list_recent_deploys"),
				toolUse("c", "search_incidents", { query: "checkout latency" }),
			),
			answer("done"),
		]);
		await run(api.createMessage);

		const results = api.requests[1]?.messages[2];
		expect(results?.role).toBe("user");
		expect(
			(
				(results?.content ?? []) as Anthropic.Beta.BetaToolResultBlockParam[]
			).map((r) => [r.type, r.tool_use_id]),
		).toEqual([
			["tool_result", "a"],
			["tool_result", "b"],
			["tool_result", "c"],
		]);
	});

	it("returns bad arguments and unknown tools as error results, not throws", async () => {
		const api = scripted([
			callTools(
				toolUse("a", "get_service_dependencies", { service_id: "x" }),
				toolUse("b", "get_incident", { incident_id: "INC-9999" }),
				toolUse("c", "restart_service", { service: "auth" }),
			),
			answer("done"),
		]);
		const trace = await run(api.createMessage);

		expect(
			trace.tool_calls.map((c) => [c.name, c.is_error, c.error_kind]),
		).toEqual([
			["get_service_dependencies", true, "invalid_argument"],
			["get_incident", true, "not_found"],
			["restart_service", true, "protocol"],
		]);
		const results = api.requests[1]?.messages[2]
			?.content as Anthropic.Beta.BetaToolResultBlockParam[];
		expect(results.every((r) => r.is_error === true)).toBe(true);
		expect(trace.status).toBe("answered");
	});

	it(`stops at ${MAX_TOOL_CALLS} tool calls with a clear message (FR-29)`, async () => {
		let n = 0;
		const api = scripted([
			() => callTools(toolUse(`t${++n}`, "get_service_health")),
		]);
		const trace = await run(api.createMessage);

		expect(trace.status).toBe("tool_cap");
		expect(trace.tool_calls).toHaveLength(MAX_TOOL_CALLS);
		expect(trace.stop_message).toMatch(/12-tool-call cap/);
		expect(trace.final_text).toBe("");
		expect(api.requests).toHaveLength(MAX_TOOL_CALLS);
	});

	it("runs only the calls that fit under the cap from a parallel batch", async () => {
		const api = scripted([
			callTools(
				toolUse("a", "get_service_health"),
				toolUse("b", "list_recent_deploys"),
				toolUse("c", "get_oncall", { team: "payments" }),
			),
		]);
		const trace = await run(api.createMessage, { maxToolCalls: 2 });

		expect(trace.status).toBe("tool_cap");
		expect(trace.tool_calls.map((c) => c.id)).toEqual(["a", "b"]);
	});

	it("reports a refusal with its category", async () => {
		const api = scripted([
			message({
				content: [],
				stop_reason: "refusal",
				stop_details: {
					type: "refusal",
					category: "cyber",
					explanation: null,
				} as never,
			}),
		]);
		const trace = await run(api.createMessage);
		expect(trace.status).toBe("refusal");
		expect(trace.stop_message).toBe(
			"The model declined to continue (category: cyber).",
		);
	});

	it("does not run tool calls from a response cut off at max_tokens", async () => {
		const api = scripted([
			message({
				content: [toolUse("t1", "get_service_health")],
				stop_reason: "max_tokens",
			}),
		]);
		const trace = await run(api.createMessage);
		expect(trace.status).toBe("max_tokens");
		expect(trace.tool_calls).toEqual([]);
	});

	it("re-sends after pause_turn without adding a user message", async () => {
		const paused = message({
			content: [text("...")],
			stop_reason: "pause_turn",
		});
		const api = scripted([paused, answer("done")]);
		const trace = await run(api.createMessage);

		expect(trace.status).toBe("answered");
		expect(api.requests[1]?.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
		]);
	});

	it(`gives up after ${MAX_TURNS} requests that never finish`, async () => {
		const api = scripted([message({ content: [], stop_reason: "pause_turn" })]);
		const trace = await run(api.createMessage);
		expect(trace.status).toBe("turn_cap");
		expect(api.requests).toHaveLength(MAX_TURNS);
	});

	it("turns an API error into a stopped run with an actionable message", async () => {
		const unauthorized = new Anthropic.AuthenticationError(
			401,
			undefined,
			"invalid x-api-key",
			new Headers(),
		);
		const trace = await run(scripted([unauthorized]).createMessage);
		expect(trace.status).toBe("api_error");
		expect(trace.stop_message).toMatch(/ANTHROPIC_API_KEY/);

		const generic = await run(
			scripted([new Error("socket hang up")]).createMessage,
		);
		expect(generic.stop_message).toBe("Request failed: socket hang up");
	});

	it("records usage, cost and latency per turn and in total", async () => {
		const api = scripted([
			message({
				content: [toolUse("t1", "get_service_health")],
				stop_reason: "tool_use",
				usage: {
					input_tokens: 100,
					cache_creation_input_tokens: 4000,
					output_tokens: 200,
				},
			}),
			message({
				content: [text("done")],
				stop_reason: "end_turn",
				usage: {
					input_tokens: 300,
					cache_read_input_tokens: 4000,
					output_tokens: 400,
				},
			}),
		]);
		const trace = await run(api.createMessage);

		expect(trace.usage).toEqual({
			input_tokens: 400,
			output_tokens: 600,
			cache_creation_input_tokens: 4000,
			cache_read_input_tokens: 4000,
		});
		// Sonnet 5.5: $2 in, $10 out, $2.50 cache write, $0.10 cache read.
		expect(trace.turns[0]?.cost_usd).toBeCloseTo(0.0122, 6);
		expect(trace.turns[1]?.cost_usd).toBeCloseTo(0.005, 6);
		expect(trace.cost_usd).toBeCloseTo(0.0172, 6);
		expect(trace.turns.every((t) => t.latency_ms === 5)).toBe(true);
		expect(trace.tool_calls[0]?.latency_ms).toBe(5);
		expect(trace.latency_ms).toBeGreaterThan(0);
	});

	it("prices a fallback turn by the model that served each part", async () => {
		const api = scripted([
			message({
				content: [text("done")],
				stop_reason: "end_turn",
				model: "claude-sonnet-5",
				usage: {
					input_tokens: 2000,
					output_tokens: 200,
					iterations: [
						{
							type: "message",
							model: "claude-sonnet-5-5",
							input_tokens: 1000,
							output_tokens: 100,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation: null,
						},
						{
							type: "fallback_message",
							model: "claude-opus-5",
							input_tokens: 1000,
							output_tokens: 100,
							cache_creation_input_tokens: 0,
							cache_read_input_tokens: 0,
							cache_creation: null,
						},
					],
				},
			}),
		]);
		const trace = await run(api.createMessage, { fallback: true });

		// 1000 in + 100 out at Sonnet 5.5, then the same at Opus 5.
		expect(trace.cost_usd).toBeCloseTo(0.003 + 0.0075, 6);
		expect(trace.served_models).toEqual(["claude-sonnet-5"]);
	});

	it("records the run in a trace with everything FR-30 asks for", async () => {
		const api = scripted([
			callTools(toolUse("t1", "get_service_health")),
			answer("done"),
		]);
		const trace = await run(api.createMessage);

		expect(trace).toMatchObject({
			version: 1,
			question: "Checkout is slow, what's going on?",
			scenario: "checkout-latency",
			model: "claude-sonnet-5-5",
			served_models: ["claude-sonnet-5-5"],
			settings: { max_tool_calls: 12, effort: "medium", fallback: false },
			system: SYSTEM_PROMPT,
		});
		expect(trace.tools).toHaveLength(8);
		expect(trace.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"user",
			"assistant",
		]);
		expect(trace.run_id).toMatch(/^[0-9a-f]{8}$/);
		expect(JSON.parse(JSON.stringify(trace))).toEqual(trace);
	});

	it("uses a fresh acknowledgement store per session", async () => {
		const ack = toolUse("t1", "acknowledge_incident", {
			service: "payment-gateway",
			severity: "SEV2",
			summary: "Checkout latency from payment-gateway v3.8.1",
		});
		await run(scripted([callTools(ack), answer("acked")]).createMessage);
		expect(session.ackStore.list()).toHaveLength(1);

		const other = await connectInProcess({ scenario: "checkout-latency" });
		expect(other.ackStore.list()).toEqual([]);
		await other.close();
	});
});

describe("buildRequest", () => {
	const history = [{ role: "user" as const, content: "hi" }];

	it("sends the tools, system prompt, effort and cache marker", () => {
		const request = buildRequest({ session }, history);
		expect(request).toMatchObject({
			model: "claude-sonnet-5-5",
			max_tokens: 16_000,
			system: SYSTEM_PROMPT,
			tool_choice: { type: "auto" },
			output_config: { effort: "medium" },
			cache_control: { type: "ephemeral" },
			messages: history,
		});
		expect(request.tools).toHaveLength(8);
		expect(request).not.toHaveProperty("thinking");
		expect(request).not.toHaveProperty("fallbacks");
	});

	it("asks for a server-side fallback only when enabled and supported", () => {
		expect(buildRequest({ session, fallback: true }, history)).toMatchObject({
			betas: ["server-side-fallback-2026-07-01"],
			fallbacks: "default",
		});
		const haiku = buildRequest(
			{ session, fallback: true, model: "claude-haiku-5-5" },
			history,
		);
		expect(haiku).not.toHaveProperty("fallbacks");
		expect(haiku).not.toHaveProperty("betas");
	});
});
