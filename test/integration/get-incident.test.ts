import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/domain/fixtures.js";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

let h: Harness;
beforeAll(async () => {
	h = await connect();
});
afterAll(() => h.close());

const get = (args: Record<string, unknown>) => h.call("get_incident", args);

describe("get_incident", () => {
	it("gives INC-0142's root cause and runbook, concisely", async () => {
		const result = await get({ incident_id: "INC-0142" });
		expect(result.isError).toBeFalsy();
		expect(result.structuredContent).toEqual({
			incident: {
				incident_id: "INC-0142",
				title:
					"Checkout latency after payment-gateway deploy added a synchronous fraud check",
				severity: "SEV2",
				days_before_start: 172,
				root_cause_service_id: "payment-gateway",
				root_cause_summary: expect.stringContaining("v3.6.0"),
				runbook_id: "RB-07",
			},
		});
		expect(textOf(result).split("\n")).toEqual([
			"INC-0142 (SEV2, 172 days ago): Checkout latency after payment-gateway deploy added a synchronous fraud check",
			expect.stringMatching(
				/^Root cause \(payment-gateway\): payment-gateway v3\.6\.0/,
			),
			"Runbook: RB-07",
		]);
	});

	it("adds the resolution and postmortem when detailed", async () => {
		const result = await get({
			incident_id: "INC-0142",
			response_format: "detailed",
		});
		expect(result.structuredContent).toMatchObject({
			incident: {
				affected_service_ids: ["payment-gateway", "checkout-api", "web-app"],
				symptoms: expect.stringContaining("2.1 seconds"),
				resolution: expect.stringContaining("fernctl rollback"),
				postmortem: {
					summary: expect.any(String),
					contributing_factors: expect.arrayContaining([
						expect.stringContaining("synchronously"),
					]),
					action_items: expect.arrayContaining([
						{
							description: expect.any(String),
							owner_team_id: "payments",
							status: "open",
						},
					]),
				},
			},
		});
		const text = textOf(result);
		expect(text).toContain("Resolution: Rolled payment-gateway back");
		expect(text).toMatch(/^- \[open\] Move the fraud-score check/m);
	});

	it.each(["inc-0142", "INC 0142", "INC0142", "INC-142", "142", " INC-0142 "])(
		"reads %j as INC-0142",
		async (incident_id) => {
			const result = await get({ incident_id });
			expect(result.structuredContent).toMatchObject({
				incident: { incident_id: "INC-0142" },
			});
		},
	);

	it("keeps concise under 40% of detailed across all incidents (FR-15)", async () => {
		const size = { concise: 0, detailed: 0 };
		for (const { id } of loadCatalog().incidents) {
			for (const format of ["concise", "detailed"] as const) {
				const result = await get({ incident_id: id, response_format: format });
				size[format] += JSON.stringify(result).length;
			}
		}
		expect(size.concise).toBeLessThan(size.detailed * 0.4);
	});

	it("suggests IDs one digit typo away and never answers for them", async () => {
		const result = await get({ incident_id: "INC-0143" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toBeUndefined();
		expect(errorMeta(result)).toEqual({
			kind: "not_found",
			suggestions: ["INC-0142", "INC-0144", "INC-0141"],
		});
		expect(textOf(result)).toBe(
			"No incident INC-0143. Did you mean `INC-0142`, `INC-0144`, `INC-0141`?",
		);
	});

	it("suggests nothing for an ID far from any real one", async () => {
		const result = await get({ incident_id: "INC-9999" });
		expect(errorMeta(result)).toEqual({ kind: "not_found", suggestions: [] });
		expect(textOf(result)).toMatch(/Use search_incidents/);
	});

	it.each(["RB-07", "checkout latency", "INC-12345"])(
		"rejects %j as not an incident ID",
		async (incident_id) => {
			const result = await get({ incident_id });
			expect(result.isError).toBe(true);
			expect(errorMeta(result)).toEqual({
				kind: "invalid_argument",
				suggestions: [],
			});
			expect(textOf(result)).toMatch(/look like `INC-0142`/);
		},
	);
});
