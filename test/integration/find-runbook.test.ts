import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

let h: Harness;
beforeAll(async () => {
	h = await connect();
});
afterAll(() => h.close());

const find = (args: Record<string, unknown>) => h.call("find_runbook", args);

interface Output {
	symptom?: string;
	runbook: { runbook_id: string };
	other_matches?: { runbook_id: string }[];
	more_available?: number;
}
const output = (result: { structuredContent?: unknown }) =>
	result.structuredContent as Output;

describe("find_runbook", () => {
	it("returns RB-07 in full for S1's symptom, with other matches", async () => {
		const result = await find({ symptom: "checkout latency" });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toMatchObject({
			symptom: "checkout latency",
			runbook: {
				runbook_id: "RB-07",
				title: "Payment gateway latency regression after deploy",
				applies_to_service_ids: ["payment-gateway", "checkout-api"],
				symptoms: expect.any(Array),
				diagnostic_steps: expect.any(Array),
				remediation_steps: expect.any(Array),
				rollback_steps: [
					"Run `fernctl rollback payment-gateway --to previous`.",
					expect.any(String),
					expect.any(String),
				],
				escalation: { team_id: "payments", when: expect.any(String) },
			},
			more_available: 0,
		});
		expect(output(result).other_matches?.[0]?.runbook_id).toBe("RB-05");
		const text = textOf(result);
		expect(text).toMatch(/^Best match for "checkout latency":\nRB-07: /);
		expect(text).toContain(
			"1. Run `fernctl rollback payment-gateway --to previous`.",
		);
		expect(text).toContain('Call get_oncall with {"team": "payments"}');
		expect(text).toMatch(/^- RB-05: Checkout API elevated error rate/m);
	});

	it("caps the other matches with limit and says how many more", async () => {
		const result = await find({ symptom: "401 errors on login", limit: 1 });
		const out = output(result);
		expect(out.runbook.runbook_id).toBe("RB-03");
		expect(out.other_matches).toHaveLength(1);
		expect(out.more_available).toBeGreaterThan(0);
		expect(textOf(result)).toMatch(
			new RegExp(`${out.more_available} more not shown. Raise \`limit\``),
		);
	});

	it("says when a runbook has no rollback steps", async () => {
		const result = await find({ runbook_id: "RB-03" });
		expect(output(result).runbook).toMatchObject({ rollback_steps: [] });
		expect(textOf(result)).toContain("Roll back:\n(none:");
	});

	it.each(["RB-07", "rb-07", "RB 7", "RB07", "7", " RB-07 "])(
		"reads %j as RB-07",
		async (runbook_id) => {
			const result = await find({ runbook_id });
			expect(result.structuredContent).toEqual({
				runbook: expect.objectContaining({ runbook_id: "RB-07" }),
			});
			expect(textOf(result)).toMatch(/^RB-07: /);
		},
	);

	it("suggests runbook IDs one digit typo away", async () => {
		const result = await find({ runbook_id: "RB-17" });
		expect(result.isError).toBe(true);
		expect(errorMeta(result)).toEqual({
			kind: "not_found",
			suggestions: ["RB-12", "RB-11", "RB-10"],
		});
	});

	it("names symptom search as the fallback", async () => {
		const result = await find({ runbook_id: "RB-55" });
		expect(errorMeta(result)).toEqual({
			kind: "not_found",
			suggestions: ["RB-05"],
		});
		expect(textOf(result)).toBe(
			"No runbook RB-55. Pass `symptom` to search by what is wrong, or try a similar ID. Did you mean `RB-05`?",
		);
	});

	it.each([
		["both arguments", { runbook_id: "RB-07", symptom: "latency" }, /not both/],
		["neither argument", {}, /Pass `runbook_id` .* or `symptom`/],
		[
			"an incident ID as runbook_id",
			{ runbook_id: "INC-0142" },
			/not a runbook ID/,
		],
		[
			"a runbook ID as the symptom",
			{ symptom: "rb 7" },
			/call find_runbook with \{"runbook_id": "RB-07"\}/,
		],
		[
			"a symptom of only stopwords",
			{ symptom: "the issue" },
			/no search words/,
		],
	])("rejects %s as invalid_argument", async (_, args, message) => {
		const result = await find(args);
		expect(result.isError).toBe(true);
		expect(errorMeta(result)?.kind).toBe("invalid_argument");
		expect(textOf(result)).toMatch(message);
	});

	it("answers a symptom nothing matches with an empty error", async () => {
		const result = await find({ symptom: "zebra" });
		expect(errorMeta(result)?.kind).toBe("empty");
		expect(textOf(result)).toMatch(/No runbook matches "zebra"\. Try fewer/);
	});

	it("rejects a symptom over the search max in the schema", async () => {
		const result = await find({ symptom: "x".repeat(301) });
		expect(textOf(result)).toMatch(
			/^Input validation error:.*symptom must be at most 300 characters/,
		);
	});
});
