import { describe, expect, it } from "vitest";
import {
	createAcknowledgementStore,
	MAX_ACK_SUMMARY_LENGTH,
	MAX_STORED_ACKS,
} from "../../src/domain/acknowledgements.js";
import { service } from "./helpers.js";

const clock = () => new Date("2026-01-01T00:00:00.000Z");
const input = {
	service: service("payment-gateway"),
	severity: "SEV2" as const,
	summary: "Checkout latency after payment-gateway v3.8.1",
};

describe("createAcknowledgementStore", () => {
	it("records an acknowledgement and returns a confirmation ID (S5 variant B)", () => {
		const store = createAcknowledgementStore({ now: clock });
		const ack = store.acknowledge(input);
		expect(ack).toEqual({
			confirmation_id: "ACK-0001",
			service_id: "payment-gateway",
			severity: "SEV2",
			summary: input.summary,
			created_at: "2026-01-01T00:00:00.000Z",
		});
		expect(store.list()).toEqual([ack]);
	});

	it("is not idempotent: each call is a new acknowledgement", () => {
		const store = createAcknowledgementStore({ now: clock });
		const ids = [store.acknowledge(input), store.acknowledge(input)].map(
			(a) => a.confirmation_id,
		);
		expect(ids).toEqual(["ACK-0001", "ACK-0002"]);
		expect(store.list()).toHaveLength(2);
	});

	it("keeps stores independent, so each eval trial starts empty", () => {
		const first = createAcknowledgementStore();
		first.acknowledge(input);
		const second = createAcknowledgementStore();
		expect(second.list()).toEqual([]);
		expect(second.acknowledge(input).confirmation_id).toBe("ACK-0001");
	});

	it("uses the system clock by default", () => {
		const before = Date.now();
		const { created_at } = createAcknowledgementStore().acknowledge(input);
		expect(Date.parse(created_at)).toBeGreaterThanOrEqual(before);
	});

	it("trims the summary and accepts exactly the maximum length", () => {
		const store = createAcknowledgementStore();
		const max = "x".repeat(MAX_ACK_SUMMARY_LENGTH);
		expect(store.acknowledge({ ...input, summary: `  ${max}  ` }).summary).toBe(
			max,
		);
	});

	it.each(["", "   ", "x".repeat(MAX_ACK_SUMMARY_LENGTH + 1)])(
		"rejects the summary %j without recording it",
		(summary) => {
			const store = createAcknowledgementStore();
			expect(() => store.acknowledge({ ...input, summary })).toThrow(
				RangeError,
			);
			expect(store.list()).toEqual([]);
		},
	);

	it("returns records callers can't change", () => {
		const store = createAcknowledgementStore();
		const ack = store.acknowledge(input);
		expect(Object.isFrozen(ack)).toBe(true);
		(store.list() as unknown[]).length = 0;
		expect(store.list()).toHaveLength(1);
	});

	it(`keeps only the newest ${MAX_STORED_ACKS}, still counting up`, () => {
		const store = createAcknowledgementStore({ now: clock });
		for (let i = 0; i <= MAX_STORED_ACKS; i++) store.acknowledge(input);
		const acks = store.list();
		expect(acks).toHaveLength(MAX_STORED_ACKS);
		expect(acks[0]?.confirmation_id).toBe("ACK-0002");
		expect(acks.at(-1)?.confirmation_id).toBe("ACK-1001");
	});
});
