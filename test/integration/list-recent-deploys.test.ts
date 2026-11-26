import { afterEach, describe, expect, it } from "vitest";
import type { ScenarioId } from "../../src/domain/schemas.js";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

let h: Harness | undefined;
afterEach(() => h?.close());

async function deploys(
	scenario: ScenarioId,
	args: Record<string, unknown> = {},
) {
	h = await connect({ scenario });
	return h.call("list_recent_deploys", args);
}

const ids = (result: { structuredContent?: unknown }) =>
	(
		result.structuredContent as { deploys: { deploy_id: string }[] }
	).deploys.map((d) => d.deploy_id);

describe("list_recent_deploys", () => {
	it("lists S1's deploys in the last 60 minutes, newest first", async () => {
		const result = await deploys("checkout-latency");
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			scenario_id: "checkout-latency",
			within_minutes: 60,
			deploys: [
				{
					deploy_id: "DEP-1001",
					service_id: "payment-gateway",
					team_id: "payments",
					version: "v3.8.1",
					minutes_before_start: 12,
					change_summary: expect.stringContaining("synchronous fraud-score"),
				},
				expect.objectContaining({ deploy_id: "DEP-1002" }),
			],
			more_available: 0,
		});
		expect(textOf(result).split("\n")).toEqual([
			"2 deploys to any service in the last 60 minutes, newest first:",
			expect.stringMatching(
				/^- DEP-1001: payment-gateway v3\.8\.1, 12 min ago \(team payments\)\. Add a synchronous/,
			),
			expect.stringMatching(/^- DEP-1002: scheduling-api v2\.9\.3, 34 min ago/),
		]);
	});

	it("widens the window to reach the notifications red herring", async () => {
		const result = await deploys("checkout-latency", { within_minutes: 1440 });
		expect(ids(result)).toEqual([
			"DEP-1001",
			"DEP-1002",
			"DEP-1003",
			"DEP-1004",
		]);
	});

	it("keeps one service's deploys, found by name", async () => {
		const result = await deploys("checkout-latency", {
			service: "Payment Gateway",
		});
		expect(result.structuredContent).toMatchObject({
			service_id: "payment-gateway",
		});
		expect(ids(result)).toEqual(["DEP-1001"]);
		expect(textOf(result)).toMatch(/^1 deploy to payment-gateway/);
	});

	it("answers no deploys as a normal result with a next step", async () => {
		const result = await deploys("auth-cert-expiry", {
			service: "auth",
			within_minutes: 1440,
		});
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			scenario_id: "auth-cert-expiry",
			service_id: "auth",
			within_minutes: 1440,
			deploys: [],
			more_available: 0,
		});
		expect(textOf(result)).toBe("No deploys to auth in the last 1440 minutes.");
	});

	it("suggests a wider window when the default finds nothing", async () => {
		const result = await deploys("checkout-latency", { service: "web-app" });
		expect(textOf(result)).toBe(
			"No deploys to web-app in the last 60 minutes. Raise `within_minutes` (at most 1440) to look further back.",
		);
	});

	it("caps the list and says how many more exist (FR-13)", async () => {
		const result = await deploys("checkout-latency", {
			within_minutes: 1440,
			limit: 2,
		});
		expect(ids(result)).toEqual(["DEP-1001", "DEP-1002"]);
		expect(result.structuredContent).toMatchObject({ more_available: 2 });
		expect(textOf(result)).toMatch(/2 more not shown\. Raise `limit`/);
	});

	it("reads S5's deploys from S1's data set", async () => {
		const result = await deploys("ack-guardrail");
		expect(ids(result)).toEqual(["DEP-1001", "DEP-1002"]);
	});

	it("suggests billing for billing-v2 (S4)", async () => {
		const result = await deploys("unknown-service", { service: "billing-v2" });
		expect(result.isError).toBe(true);
		expect(errorMeta(result)).toEqual({
			kind: "not_found",
			suggestions: ["billing"],
		});
	});

	it("gives a next step when no service is close", async () => {
		const result = await deploys("checkout-latency", { service: "kafka" });
		expect(errorMeta(result)).toEqual({ kind: "not_found", suggestions: [] });
		expect(textOf(result)).toMatch(
			/Call list_recent_deploys without `service`/,
		);
	});
});
