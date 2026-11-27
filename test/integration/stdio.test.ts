import { spawnSync } from "node:child_process";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { describe, expect, it } from "vitest";

// Runs the real entry point in a child process, as Claude Desktop would.

const TSX = "node_modules/.bin/tsx";
const ENTRY = "src/transports/stdio.ts";
const baseEnv = { PATH: process.env.PATH ?? "" };

describe("stdio entry point", () => {
	it("serves tools over the legacy handshake and logs only to stderr", async () => {
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

	it("negotiates MCP 2026-07-28 when the client pins it", async () => {
		const transport = new StdioClientTransport({
			command: TSX,
			args: [ENTRY],
			env: { ...baseEnv, SCENARIO: "false-alarm" },
			stderr: "pipe",
		});
		const client = new Client(
			{ name: "stdio-test", version: "0.0.0" },
			{ versionNegotiation: { mode: { pin: "2026-07-28" } } },
		);
		try {
			await client.connect(transport);
			expect(client.getProtocolEra()).toBe("modern");
			expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
			const result = await client.callTool({
				name: "get_service_health",
				arguments: {},
			});
			expect(result.structuredContent).toMatchObject({
				scenario_id: "false-alarm",
			});
			const runbook = await client.readResource({ uri: "runbook://RB-07" });
			expect(runbook.contents[0]).toMatchObject({ mimeType: "text/markdown" });
			const prompt = await client.getPrompt({
				name: "triage_outage",
				arguments: { symptom: "Checkout is slow" },
			});
			expect(prompt.messages).toHaveLength(1);
		} finally {
			await client.close();
		}
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
