import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/domain/fixtures.js";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

let h: Harness;
beforeAll(async () => {
	h = await connect();
});
afterAll(() => h.close());

const oncall = (args: Record<string, unknown>) => h.call("get_oncall", args);

const PAYMENTS = {
	team_id: "payments",
	team_name: "Payments",
	primary_handle: "payments-primary",
	secondary_handle: "payments-secondary",
	escalation_channel: "#payments-escalation",
	service_ids: expect.arrayContaining(["payment-gateway", "checkout-api"]),
};

describe("get_oncall", () => {
	it("finds the team that owns a service", async () => {
		const result = await oncall({ service: "Payment Gateway" });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			...PAYMENTS,
			service_id: "payment-gateway",
		});
		expect(textOf(result).split("\n")).toEqual([
			"payment-gateway is owned by Payments (team payments).",
			"Primary: payments-primary. Secondary: payments-secondary.",
			"Escalation channel: #payments-escalation.",
			expect.stringMatching(/^Owns: .*payment-gateway/),
		]);
	});

	it.each(["payments", "Payments", " PAYMENTS "])(
		"finds a team by %j",
		async (team) => {
			const result = await oncall({ team });
			expect(result.structuredContent).toEqual(PAYMENTS);
		},
	);

	it("answers for every team in the roster", async () => {
		for (const team of loadCatalog().teams) {
			const result = await oncall({ team: team.id });
			expect(result.isError, team.id).toBeFalsy();
		}
	});

	it("suggests at most 3 teams for an unknown team", async () => {
		for (const team of ["Payment", "plat", "schedule", "team"]) {
			const result = await oncall({ team });
			expect(result.isError).toBe(true);
			const meta = errorMeta(result);
			expect(meta?.kind).toBe("not_found");
			expect(meta?.suggestions.length).toBeLessThanOrEqual(3);
		}
		expect(errorMeta(await oncall({ team: "Payment" }))?.suggestions).toEqual([
			"payments",
		]);
	});

	it("lists the teams when no team is close", async () => {
		const result = await oncall({ team: "zzzzz" });
		expect(errorMeta(result)).toEqual({ kind: "not_found", suggestions: [] });
		expect(textOf(result)).toMatch(/Teams: web, payments, .*Or pass `service`/);
	});

	it("suggests services for an unknown service (S4)", async () => {
		const result = await oncall({ service: "billing-v2" });
		expect(errorMeta(result)).toEqual({
			kind: "not_found",
			suggestions: ["billing"],
		});
	});

	it.each([
		["both arguments", { team: "payments", service: "auth" }, /not both/],
		["neither argument", {}, /Pass `team` .* or `service`/],
		[
			"a service passed as team",
			{ team: "checkout-api" },
			/is a service, not a team\. Call get_oncall with \{"service": "checkout-api"\}/,
		],
		[
			"a team passed as service",
			{ service: "identity" },
			/is a team, not a service\. Call get_oncall with \{"team": "identity"\}/,
		],
	])("rejects %s as invalid_argument", async (_, args, message) => {
		const result = await oncall(args);
		expect(result.isError).toBe(true);
		expect(errorMeta(result)?.kind).toBe("invalid_argument");
		expect(textOf(result)).toMatch(message);
	});
});
