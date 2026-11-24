import type { Tool } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { SERVER_NAME } from "../../src/server.js";
import { connect, errorMeta, type Harness, textOf } from "./harness.js";

// The tool pattern every tool follows. PR 9 tightens the count to exactly 8.

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

	it("lists the tools built so far", () => {
		expect(tools.map((t) => t.name).sort()).toEqual([
			"get_service_dependencies",
			"get_service_health",
		]);
	});
});

describe.each(["get_service_health", "get_service_dependencies"])(
	"%s follows the tool rules",
	(name) => {
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

		it("is annotated read-only (FR-10)", () => {
			expect(tool().annotations).toMatchObject({
				readOnlyHint: true,
				destructiveHint: false,
			});
		});

		it("declares an output schema and rejects unknown arguments (FR-12)", () => {
			expect(tool().outputSchema).toMatchObject({ type: "object" });
			expect(tool().inputSchema).toMatchObject({ additionalProperties: false });
		});

		it("takes a limit, since it returns a list (FR-13)", () => {
			const props = Object.keys(tool().inputSchema.properties ?? {});
			expect(props).toContain("limit");
		});
	},
);

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
