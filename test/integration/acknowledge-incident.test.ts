import { afterEach, describe, expect, it } from "vitest";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

let h: Harness;
afterEach(() => h.close());

async function ack(args: Record<string, unknown>) {
	h = await connect();
	return h.call("acknowledge_incident", args);
}

const VALID = {
	service: "payment-gateway",
	severity: "SEV2",
	summary: "Checkout latency from payment-gateway v3.8.1; rolling back.",
};

describe("acknowledge_incident", () => {
	it("records the acknowledgement and returns a confirmation ID", async () => {
		const result = await ack({ ...VALID, service: "Payment Gateway" });
		expect(result.isError).toBeFalsy();
		const expected = {
			confirmation_id: "ACK-0001",
			service_id: "payment-gateway",
			team_id: "payments",
			severity: "SEV2",
			summary: VALID.summary,
			created_at: "2026-01-01T00:00:00.000Z",
		};
		expect(result.structuredContent).toEqual(expected);
		const { team_id: _, ...stored } = expected;
		expect(h.ackStore.list()).toEqual([stored]);
		expect(textOf(result)).toMatch(
			/^Acknowledged ACK-0001: SEV2 on payment-gateway \(team payments\)\./,
		);
		expect(textOf(result)).toMatch(/nobody was paged/);
	});

	it("is not idempotent: a repeat records a second acknowledgement", async () => {
		await ack(VALID);
		const second = await h.call("acknowledge_incident", VALID);
		expect(second.structuredContent).toMatchObject({
			confirmation_id: "ACK-0002",
		});
		expect(h.ackStore.list()).toHaveLength(2);
	});

	it("trims the summary before storing it", async () => {
		const result = await ack({ ...VALID, summary: "  latency  " });
		expect(result.structuredContent).toMatchObject({ summary: "latency" });
	});

	it("accepts a summary of exactly 200 characters after trimming", async () => {
		const summary = "x".repeat(200);
		const result = await ack({ ...VALID, summary: ` ${summary} ` });
		expect(result.isError).toBeFalsy();
		expect(h.ackStore.list()[0]?.summary).toBe(summary);
	});

	it("records nothing for an unknown service, and suggests one", async () => {
		const result = await ack({ ...VALID, service: "billing-v2" });
		expect(errorMeta(result)).toEqual({
			kind: "not_found",
			suggestions: ["billing"],
		});
		expect(h.ackStore.list()).toEqual([]);
	});

	it.each([
		[
			"a lower-case severity",
			{ severity: "sev2" },
			/severity must be one of: SEV1, SEV2, SEV3, SEV4/,
		],
		["an unknown severity", { severity: "SEV5" }, /severity must be one of/],
		["an empty summary", { summary: "   " }, /summary must not be empty/],
		[
			"a long summary",
			{ summary: "x".repeat(201) },
			/summary must be at most 200 characters/,
		],
		["a missing summary", { summary: undefined }, /summary must be a string/],
	])(
		"rejects %s in the schema and records nothing",
		async (_, change, message) => {
			const result = await ack({ ...VALID, ...change });
			expect(result.isError).toBe(true);
			expect(textOf(result)).toMatch(/^Input validation error:/);
			expect(textOf(result)).toMatch(message);
			expect(h.ackStore.list()).toEqual([]);
		},
	);
});
