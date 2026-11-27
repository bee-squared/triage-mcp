import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

let h: Harness;
beforeAll(async () => {
	h = await connect();
});
afterAll(() => h.close());

const search = (args: Record<string, unknown>) =>
	h.call("search_incidents", args);

const ids = (result: { structuredContent?: unknown }) =>
	(
		result.structuredContent as { incidents: { incident_id: string }[] }
	).incidents.map((i) => i.incident_id);

describe("search_incidents", () => {
	it("ranks INC-0142 above the decoys for checkout latency (S1)", async () => {
		const result = await search({ query: "checkout latency" });
		expect(result.isError).toBeFalsy();
		expect(ids(result).slice(0, 3)).toEqual([
			"INC-0142",
			"INC-0131",
			"INC-0141",
		]);
		const { query, incidents } = result.structuredContent as {
			query: string;
			incidents: unknown[];
		};
		expect(query).toBe("checkout latency");
		expect(incidents[0]).toEqual({
			incident_id: "INC-0142",
			title: expect.stringContaining("synchronous fraud check"),
			severity: "SEV2",
			days_before_start: 172,
			root_cause_service_id: "payment-gateway",
			runbook_id: "RB-07",
		});
		const lines = textOf(result).split("\n");
		expect(lines[0]).toMatch(
			/^\d+ past incidents match "checkout latency", best first:$/,
		);
		expect(lines[1]).toBe(
			"- INC-0142 (SEV2, 172 days ago): Checkout latency after payment-gateway deploy added a synchronous fraud check. Root cause: payment-gateway. Runbook RB-07.",
		);
		expect(lines.at(-1)).toMatch(
			/^Call get_incident .*"response_format": "detailed".* resolution and postmortem\.$/,
		);
	});

	it("caps at 5 by default and says how many more exist (FR-13)", async () => {
		const result = await search({ query: "checkout latency" });
		expect(ids(result)).toHaveLength(5);
		const { more_available } = result.structuredContent as {
			more_available: number;
		};
		expect(more_available).toBeGreaterThan(0);
		expect(textOf(result)).toContain(`${more_available} more not shown.`);
	});

	it("honours a higher limit", async () => {
		const result = await search({ query: "checkout latency", limit: 20 });
		expect(ids(result).length).toBeGreaterThan(5);
	});

	it("keeps only incidents that affected the service", async () => {
		const result = await search({ query: "certificate", service: "auth" });
		expect(result.structuredContent).toMatchObject({ service_id: "auth" });
		expect(ids(result)[0]).toBe("INC-0111");
	});

	it("lists a service's incidents newest first for a query of stopwords", async () => {
		const result = await search({ query: "past issues", service: "auth" });
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).toMatch(
			/^\d+ past incidents affecting auth, newest first:/,
		);
		const days = (
			result.structuredContent as {
				incidents: { days_before_start: number }[];
			}
		).incidents.map((i) => i.days_before_start);
		expect(days).toEqual([...days].sort((a, b) => a - b));
	});

	it("sends a pasted incident ID to get_incident", async () => {
		const result = await search({ query: "inc 142" });
		expect(result.isError).toBe(true);
		expect(errorMeta(result)).toEqual({
			kind: "invalid_argument",
			suggestions: [],
		});
		expect(textOf(result)).toBe(
			'search_incidents searches by symptom, not by ID. To read INC-0142, call get_incident with {"incident_id": "INC-0142"}.',
		);
	});

	it("still treats a bare number as a keyword", async () => {
		const result = await search({ query: "503" });
		expect(result.isError).toBeFalsy();
	});

	it("rejects a query with no search words and no service", async () => {
		const result = await search({ query: "the incident" });
		expect(errorMeta(result)?.kind).toBe("invalid_argument");
		expect(textOf(result)).toMatch(/no search words/);
	});

	it("answers no matches as an empty result that says how to broaden", async () => {
		const result = await search({ query: "zebra" });
		expect(result.isError).toBe(true);
		expect(errorMeta(result)).toEqual({ kind: "empty", suggestions: [] });
		expect(textOf(result)).toMatch(
			/^No past incidents match "zebra"\. Search again with fewer, more general words/,
		);
	});

	it("suggests dropping the service when it filtered everything out", async () => {
		const result = await search({ query: "certificate", service: "billing" });
		expect(errorMeta(result)?.kind).toBe("empty");
		expect(textOf(result)).toMatch(/Search again without `service`/);
	});

	it("suggests billing for billing-v2 (S4)", async () => {
		const result = await search({
			query: "invoices",
			service: "billing-v2",
		});
		expect(errorMeta(result)).toEqual({
			kind: "not_found",
			suggestions: ["billing"],
		});
	});
});
