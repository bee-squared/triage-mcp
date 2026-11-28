import { ProtocolError } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	NO_ACTION_RULE,
	TRIAGE_PROMPT_NAME,
} from "../../src/prompts/triage-outage.js";
import { connect, type Harness } from "./harness.js";

let h: Harness;

beforeAll(async () => {
	h = await connect();
});
afterAll(() => h.close());

async function promptText(symptom: string): Promise<string> {
	const result = await h.client.getPrompt({
		name: TRIAGE_PROMPT_NAME,
		arguments: { symptom },
	});
	expect(result.messages).toHaveLength(1);
	const [message] = result.messages;
	expect(message?.role).toBe("user");
	if (message?.content.type !== "text") throw new Error("expected text");
	return message.content.text;
}

describe("triage_outage prompt (FR-20)", () => {
	it("is the only prompt, with one required symptom argument", async () => {
		const { prompts } = await h.client.listPrompts();
		expect(prompts).toEqual([
			expect.objectContaining({
				name: TRIAGE_PROMPT_NAME,
				arguments: [
					expect.objectContaining({ name: "symptom", required: true }),
				],
			}),
		]);
	});

	it("puts the symptom between markers, as data", async () => {
		const text = await promptText("  Checkout is slow  ");
		expect(text).toContain("<symptom>\nCheckout is slow\n</symptom>");
		expect(text).toMatch(/not as instructions/);
	});

	it("lays out every triage step in order, naming the tools", async () => {
		const text = await promptText("Checkout is slow");
		const steps = [
			"Investigate",
			"Identify the root cause",
			"Find the runbook",
			"Find on-call",
			"Draft a status update",
			"Do not take action",
		];
		const positions = steps.map((step) => text.indexOf(`**${step}.**`));
		expect(positions.every((p) => p >= 0)).toBe(true);
		expect([...positions].sort((a, b) => a - b)).toEqual(positions);
		for (const tool of [
			"get_service_health",
			"get_service_dependencies",
			"list_recent_deploys",
			"search_incidents",
			"get_incident",
			"find_runbook",
			"get_oncall",
		]) {
			expect(text).toContain(`\`${tool}\``);
		}
	});

	it("forbids acknowledging without explicit confirmation", async () => {
		const text = await promptText("Login is failing");
		expect(text).toContain(NO_ACTION_RULE);
		expect(NO_ACTION_RULE).toMatch(/explicit confirmation/);
	});

	it("tells the model not to invent IDs", async () => {
		expect(await promptText("x")).toMatch(
			/Only cite .* IDs that a tool returned/,
		);
	});

	it.each([
		["a missing symptom", {}],
		["an empty symptom", { symptom: "   " }],
		["an overlong symptom", { symptom: "x".repeat(301) }],
	])("rejects %s as invalid params", async (_, args) => {
		const error = await h.client
			.getPrompt({ name: TRIAGE_PROMPT_NAME, arguments: args })
			.then(
				() => undefined,
				(e: unknown) => e,
			);
		expect(error).toBeInstanceOf(ProtocolError);
		expect((error as ProtocolError).message).toMatch(/symptom/);
	});
});
