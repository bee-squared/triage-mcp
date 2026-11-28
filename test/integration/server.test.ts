import type { Tool } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { loadCatalog } from "../../src/domain/fixtures.js";
import { SCENARIO_IDS } from "../../src/domain/schemas.js";
import { SERVER_NAME } from "../../src/server.js";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

// The rules every tool follows, checked over the live tool list.

let h: Harness;
let tools: Tool[];

beforeAll(async () => {
	h = await connect();
	tools = (await h.client.listTools()).tools;
});
afterAll(() => h.close());

describe("server", () => {
	it("identifies itself with the package version and instructions", () => {
		expect(h.client.getServerVersion()).toMatchObject({
			name: SERVER_NAME,
			version: packageJson.version,
		});
		expect(h.client.getInstructions()).toMatch(/explicitly asks/);
	});

	it("lists exactly the 8 MVP tools (FR-8)", () => {
		expect(tools.map((t) => t.name).sort()).toEqual([...ALL_TOOLS].sort());
	});

	it("exposes 2 resources and 1 prompt (FR-18 to FR-20)", async () => {
		const { resources } = await h.client.listResources();
		const { resourceTemplates } = await h.client.listResourceTemplates();
		const { prompts } = await h.client.listPrompts();
		expect(resources.filter((r) => !r.uri.startsWith("runbook://"))).toEqual([
			expect.objectContaining({ uri: "catalog://services" }),
		]);
		expect(resourceTemplates.map((t) => t.uriTemplate)).toEqual([
			"runbook://{runbook_id}",
		]);
		expect(prompts.map((p) => p.name)).toEqual(["triage_outage"]);
	});
});

const ALL_TOOLS = [
	"get_service_health",
	"get_service_dependencies",
	"list_recent_deploys",
	"search_incidents",
	"get_incident",
	"find_runbook",
	"get_oncall",
	"acknowledge_incident",
] as const;

/** The one tool that changes state (FR-10). */
const WRITE_TOOL = "acknowledge_incident";

/** Tools that return a list, so must take a `limit` (FR-13). */
const LIST_TOOLS = new Set([
	"get_service_health",
	"get_service_dependencies",
	"list_recent_deploys",
	"search_incidents",
	"find_runbook",
]);

describe.each(ALL_TOOLS)("%s follows the tool rules", (name) => {
	const tool = () => {
		const found = tools.find((t) => t.name === name);
		if (!found) throw new Error(`no tool ${name}`);
		return found;
	};

	it("says when to use it, when not to, and gives a valid example (FR-11)", async () => {
		const { description = "" } = tool();
		expect(description).toMatch(/Use when:/);
		expect(description).toMatch(/Do not use for:/);
		const example = description.match(/Example input: (\{.*\})/)?.[1];
		expect(example).toBeDefined();
		const result = await h.call(name, JSON.parse(example ?? "{}"));
		expect(result.isError).toBeFalsy();
	});

	it.runIf(name !== WRITE_TOOL)("is annotated read-only (FR-10)", () => {
		expect(tool().annotations).toMatchObject({
			readOnlyHint: true,
			destructiveHint: false,
		});
	});

	it.runIf(name === WRITE_TOOL)(
		"is annotated as a non-idempotent write (FR-10)",
		() => {
			expect(tool().annotations).toEqual({
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: false,
			});
		},
	);

	it("declares an output schema and rejects unknown arguments (FR-12)", () => {
		expect(tool().outputSchema).toMatchObject({ type: "object" });
		expect(tool().inputSchema).toMatchObject({ additionalProperties: false });
	});

	it.runIf(LIST_TOOLS.has(name))(
		"takes a limit, since it returns a list (FR-13)",
		() => {
			const props = Object.keys(tool().inputSchema.properties ?? {});
			expect(props).toContain("limit");
		},
	);
});

describe("invalid input is a tool error, not a protocol error (FR-9)", () => {
	it.each([
		[
			"an unknown argument",
			"get_service_health",
			{ service_id: "checkout-api" },
			/Unrecognized key: "service_id"/,
		],
		[
			"a value outside an enum",
			"get_service_dependencies",
			{ service: "auth", direction: "sideways" },
			/direction must be one of: upstream, downstream/,
		],
		[
			"a number out of range",
			"get_service_dependencies",
			{ service: "auth", direction: "upstream", depth: 4 },
			/depth must be a whole number from 1 to 3/,
		],
		[
			"a missing required argument",
			"get_service_dependencies",
			{ service: "auth" },
			/direction must be one of: upstream, downstream/,
		],
		[
			"a wrong type",
			"get_service_health",
			{ service: 42 },
			/service must be a service ID or name/,
		],
		[
			"an empty name",
			"get_service_health",
			{ service: "   " },
			/service must not be empty/,
		],
		[
			"a limit over the max",
			"get_service_health",
			{ limit: 21 },
			/limit must be a whole number from 1 to 20/,
		],
		[
			"a bad response_format",
			"get_service_health",
			{ response_format: "verbose" },
			/response_format must be one of: concise, detailed/,
		],
		[
			"a deploy window over the max",
			"list_recent_deploys",
			{ within_minutes: 1441 },
			/within_minutes must be a whole number from 1 to 1440/,
		],
		[
			"a query over the max length",
			"search_incidents",
			{ query: "x".repeat(301) },
			/query must be at most 300 characters/,
		],
		[
			"a missing query",
			"search_incidents",
			{ service: "auth" },
			/query must be a string/,
		],
	])("rejects %s", async (_, name, args, message) => {
		const result = await h.call(name, args);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toMatch(/^Input validation error:/);
		expect(textOf(result)).toMatch(message);
	});

	it("answers a not-found as a tool error with a kind", async () => {
		const result = await h.call("get_service_health", { service: "nope" });
		expect(result.isError).toBe(true);
		expect(errorMeta(result)?.kind).toBe("not_found");
	});
});

/**
 * Reference calls for every tool with a `response_format`, each made in both
 * formats. A new tool that takes `response_format` fails the first test
 * until it has an entry here.
 */
function referenceCalls(): Record<string, Record<string, unknown>[]> {
	const catalog = loadCatalog();
	return {
		get_service_health: [
			{},
			...catalog.services.map((s) => ({ service: s.id })),
		],
		get_incident: catalog.incidents.map((i) => ({ incident_id: i.id })),
	};
}

describe("concise output is at most 40% of detailed (FR-15)", () => {
	it("has reference calls for every tool with a response_format", () => {
		const withFormat = tools
			.filter((t) => "response_format" in (t.inputSchema.properties ?? {}))
			.map((t) => t.name)
			.sort();
		expect(withFormat).toEqual(Object.keys(referenceCalls()).sort());
	});

	/** Tokens estimated as characters / 4; the ratio is the same either way. */
	const tokens = (value: unknown) => JSON.stringify(value).length / 4;

	it.each(Object.entries(referenceCalls()))(
		"%s, across every scenario",
		async (name, calls) => {
			const total = { concise: 0, detailed: 0 };
			for (const scenario of SCENARIO_IDS) {
				const s = await connect({ scenario });
				for (const args of calls) {
					for (const format of ["concise", "detailed"] as const) {
						const result = await s.call(name, {
							...args,
							response_format: format,
						});
						expect(result.isError, JSON.stringify(args)).toBeFalsy();
						total[format] += tokens(result);
					}
				}
				await s.close();
			}
			expect(total.concise / total.detailed).toBeLessThanOrEqual(0.4);
		},
	);
});

describe("every tool answers in under 50 ms at p95 (NFR)", () => {
	const RUNS = 40;

	it.each(ALL_TOOLS)("%s, with its example input", async (name) => {
		const description = tools.find((t) => t.name === name)?.description;
		const example = JSON.parse(
			description?.match(/Example input: (\{.*\})/)?.[1] ?? "{}",
		);
		await h.call(name, example); // warm up
		const times: number[] = [];
		for (let i = 0; i < RUNS; i++) {
			const start = performance.now();
			await h.call(name, example);
			times.push(performance.now() - start);
		}
		times.sort((a, b) => a - b);
		const p95 = times[Math.ceil(RUNS * 0.95) - 1] ?? Number.POSITIVE_INFINITY;
		expect(p95).toBeLessThan(50);
	});
});
