import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

// Runs the real entry point in a child process, as Claude Desktop would.

const TSX = "node_modules/.bin/tsx";
const ENTRY = "src/transports/stdio.ts";
const baseEnv = { PATH: process.env.PATH ?? "" };

describe("stdio entry point", () => {
	it("serves tools for the configured scenario and logs only to stderr", async () => {
		const transport = new StdioClientTransport({
			command: TSX,
			args: [ENTRY],
			env: { ...baseEnv, SCENARIO: "false-alarm" },
			stderr: "pipe",
		});
		let stderr = "";
		transport.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		const client = new Client({ name: "stdio-test", version: "0.0.0" });
		try {
			await client.connect(transport);
			const result = await client.callTool({
				name: "get_service_health",
				arguments: {},
			});
			expect(result.structuredContent).toMatchObject({
				scenario_id: "false-alarm",
			});
		} finally {
			await client.close();
		}
		expect(stderr).toMatch(/serving scenario "false-alarm" over stdio/);
	});

	it("refuses to start with an unknown scenario, writing nothing to stdout", () => {
		const run = spawnSync(TSX, [ENTRY], {
			env: { ...baseEnv, SCENARIO: "nope" },
			input: "",
			encoding: "utf8",
		});
		expect(run.status).toBe(1);
		expect(run.stdout).toBe("");
		expect(run.stderr).toMatch(/SCENARIO/);
		expect(run.stderr).toMatch(/checkout-latency/);
	});
});
