import { ProtocolError } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/domain/fixtures.js";
import {
	CATALOG_URI,
	type CatalogDocument,
} from "../../src/resources/catalog.js";
import { connect, type Harness } from "./harness.js";

let h: Harness;

beforeAll(async () => {
	h = await connect();
});
afterAll(() => h.close());

const catalog = loadCatalog();

async function readText(uri: string): Promise<{ text: string; mime?: string }> {
	const { contents } = await h.client.readResource({ uri });
	expect(contents).toHaveLength(1);
	const [content] = contents;
	if (!content || !("text" in content)) throw new Error("expected text");
	expect(content.uri).toBe(uri);
	return {
		text: content.text,
		...(content.mimeType && { mime: content.mimeType }),
	};
}

async function readError(uri: string): Promise<ProtocolError> {
	const error = await h.client.readResource({ uri }).then(
		() => undefined,
		(e: unknown) => e,
	);
	expect(error).toBeInstanceOf(ProtocolError);
	return error as ProtocolError;
}

describe("catalog://services (FR-19)", () => {
	it("is listed as a static JSON resource", async () => {
		const { resources } = await h.client.listResources();
		expect(resources).toContainEqual(
			expect.objectContaining({
				uri: CATALOG_URI,
				name: "service-catalog",
				mimeType: "application/json",
			}),
		);
	});

	it("lists every service with team, tier, SLOs and dependencies", async () => {
		const { text, mime } = await readText(CATALOG_URI);
		expect(mime).toBe("application/json");
		const doc = JSON.parse(text) as CatalogDocument;
		expect(doc.services.map((s) => s.id)).toEqual(
			catalog.services.map((s) => s.id),
		);
		expect(doc.services.find((s) => s.id === "checkout-api")).toMatchObject({
			name: "Checkout API",
			tier: 1,
			team: {
				id: "payments",
				name: "Payments",
				escalation_channel: "#payments-escalation",
			},
			slo: { availability_pct: 99.95, p95_ms: 600 },
			depends_on: expect.arrayContaining([
				{ service_id: "payment-gateway", kind: "sync" },
			]),
			depended_on_by: expect.arrayContaining([
				{ service_id: "web-app", kind: "sync" },
			]),
		});
	});

	it("carries every dependency edge exactly once in each direction", async () => {
		const doc = JSON.parse(
			(await readText(CATALOG_URI)).text,
		) as CatalogDocument;
		const forward = doc.services.flatMap((s) =>
			s.depends_on.map((e) => `${s.id}->${e.service_id}:${e.kind}`),
		);
		const backward = doc.services.flatMap((s) =>
			s.depended_on_by.map((e) => `${e.service_id}->${s.id}:${e.kind}`),
		);
		const fixture = catalog.dependencies.map(
			(e) => `${e.from_service_id}->${e.to_service_id}:${e.kind}`,
		);
		expect(forward.sort()).toEqual([...fixture].sort());
		expect(backward.sort()).toEqual([...fixture].sort());
	});

	it("has no live status, so it reads the same in every scenario", async () => {
		const other = await connect({ scenario: "auth-cert-expiry" });
		try {
			const { contents } = await other.client.readResource({
				uri: CATALOG_URI,
			});
			expect(contents).toEqual(
				(await h.client.readResource({ uri: CATALOG_URI })).contents,
			);
		} finally {
			await other.close();
		}
		expect((await readText(CATALOG_URI)).text).not.toMatch(/status|degraded/);
	});
});

describe("runbook://{runbook_id} (FR-18)", () => {
	it("is published as a URI template", async () => {
		const { resourceTemplates } = await h.client.listResourceTemplates();
		expect(resourceTemplates).toEqual([
			expect.objectContaining({
				uriTemplate: "runbook://{runbook_id}",
				name: "runbook",
				mimeType: "text/markdown",
			}),
		]);
	});

	it("lists all 12 runbooks with their titles", async () => {
		const { resources } = await h.client.listResources();
		const runbooks = resources.filter((r) => r.uri.startsWith("runbook://"));
		expect(runbooks.map((r) => r.uri)).toEqual(
			catalog.runbooks.map((r) => `runbook://${r.id}`),
		);
		expect(runbooks).toContainEqual(
			expect.objectContaining({
				uri: "runbook://RB-07",
				name: "RB-07",
				title: expect.stringMatching(/^RB-07: /),
				mimeType: "text/markdown",
			}),
		);
	});

	it("reads RB-07 as markdown with every section", async () => {
		const { text, mime } = await readText("runbook://RB-07");
		expect(mime).toBe("text/markdown");
		const rb07 = catalog.runbooks.find((r) => r.id === "RB-07");
		expect(text).toMatch(new RegExp(`^# RB-07: ${rb07?.title}\n`));
		for (const heading of [
			"Symptoms",
			"Diagnose",
			"Remediate",
			"Roll back",
			"Escalate",
		]) {
			expect(text).toContain(`\n## ${heading}\n`);
		}
		expect(text).toContain("`payment-gateway`");
		expect(text).toContain(`1. ${rb07?.diagnostic_steps[0]}`);
		expect(text).toMatch(/Team: Payments \(`payments`, #payments-escalation\)/);
	});

	it("says there is nothing to roll back when a runbook has no rollback steps", async () => {
		const none = catalog.runbooks.find((r) => r.rollback_steps.length === 0);
		expect(none).toBeDefined();
		const { text } = await readText(`runbook://${none?.id}`);
		expect(text).toContain("## Roll back\n\nNone: there is no change to undo.");
	});

	it("answers an unknown runbook with resource-not-found and close IDs", async () => {
		const error = await readError("runbook://RB-13");
		expect(error.data).toEqual({ uri: "runbook://RB-13" });
		expect(error.message).toMatch(
			/No runbook RB-13\. Did you mean runbook:\/\/RB-/,
		);
	});

	it("points a non-canonical spelling at the canonical URI", async () => {
		const error = await readError("runbook://rb-7");
		expect(error.message).toMatch(/Use the canonical URI runbook:\/\/RB-07/);
	});

	it.each(["runbook://RB%2D07", "runbook://%52B-07"])(
		"rejects the percent-encoded alias %s",
		async (uri) => {
			const error = await readError(uri);
			expect(error.data).toEqual({ uri });
			expect(error.message).toMatch(/Use the canonical URI runbook:\/\/RB-07/);
		},
	);

	it("explains what a runbook URI looks like for garbage input", async () => {
		const error = await readError("runbook://checkout");
		expect(error.message).toMatch(/not a runbook ID.*runbook:\/\/RB-07/);
	});

	it("completes runbook IDs by prefix", async () => {
		const complete = (value: string) =>
			h.client.complete({
				ref: { type: "ref/resource", uri: "runbook://{runbook_id}" },
				argument: { name: "runbook_id", value },
			});
		expect((await complete("rb-0")).completion.values).toEqual(
			catalog.runbooks.map((r) => r.id).filter((id) => id.startsWith("RB-0")),
		);
		expect((await complete("RB-1")).completion.values).toEqual([
			"RB-10",
			"RB-11",
			"RB-12",
		]);
		expect((await complete("x")).completion.values).toEqual([]);
	});
});
