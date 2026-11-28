import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectInProcess } from "../../src/agent/mcp.js";
import type { Trace } from "../../src/agent/trace.js";
import {
	type CliIo,
	MISSING_KEY_MESSAGE,
	main,
	parseCliArgs,
	useColor,
} from "../../src/cli/triage-cli.js";
import { answer, callTools, scripted, toolUse } from "./agent-fakes.js";

// The CLI end to end with a scripted Claude: argument parsing, the missing
// key message, output with and without color, and the trace file.

let traceDir: string;
beforeEach(async () => {
	traceDir = await mkdtemp(join(tmpdir(), "triage-traces-"));
});
afterEach(() => rm(traceDir, { recursive: true, force: true }));

function capture(
	env: Record<string, string> = {},
	createMessage?: CliIo["createMessage"],
) {
	const out: string[] = [];
	const err: string[] = [];
	const io: CliIo = {
		env,
		stdout: { write: (t: string) => out.push(t), isTTY: true },
		stderr: { write: (t: string) => err.push(t), isTTY: true },
		...(createMessage ? { createMessage } : {}),
	};
	return { io, stdout: () => out.join(""), stderr: () => err.join("") };
}

describe("parseCliArgs", () => {
	it("defaults to Sonnet 5.5, the SCENARIO variable, fallback on", () => {
		expect(
			parseCliArgs(["Checkout", "is", "slow"], { SCENARIO: "false-alarm" }),
		).toEqual({
			kind: "run",
			options: {
				question: "Checkout is slow",
				model: "claude-sonnet-5-5",
				scenario: "false-alarm",
				traceDir: ".traces",
				fallback: true,
			},
		});
	});

	it("reads --model, --scenario, --trace-dir and --no-fallback", () => {
		const result = parseCliArgs(
			[
				"--model",
				"claude-haiku-5-5",
				"--scenario",
				"auth-cert-expiry",
				"--trace-dir",
				"out",
				"--no-fallback",
				"Logins fail",
			],
			{},
		);
		expect(result).toMatchObject({
			kind: "run",
			options: {
				model: "claude-haiku-5-5",
				scenario: "auth-cert-expiry",
				traceDir: "out",
				fallback: false,
			},
		});
	});

	it.each([
		[[], /Missing the question/],
		[
			["--model", "gpt-5", "q"],
			/Unknown model "gpt-5". Use one of: claude-sonnet-5-5/,
		],
		[
			["--scenario", "nope", "q"],
			/Unknown scenario "nope". Use one of: checkout-latency/,
		],
		[["--bogus", "q"], /Unknown option '--bogus'/],
	])("rejects %j", (argv, message) => {
		const result = parseCliArgs(argv, {});
		expect(result.kind).toBe("error");
		expect(result.kind === "error" && result.message).toMatch(message);
	});
});

describe("useColor", () => {
	it("colors only a terminal without NO_COLOR", () => {
		expect(useColor({}, true)).toBe(true);
		expect(useColor({}, false)).toBe(false);
		expect(useColor({ NO_COLOR: "1" }, true)).toBe(false);
		expect(useColor({ NO_COLOR: "" }, true)).toBe(true);
	});
});

describe("main", () => {
	it("prints help and exits 0", async () => {
		const c = capture();
		expect(await main(["--help"], c.io)).toBe(0);
		expect(c.stdout()).toMatch(/Usage: pnpm triage/);
	});

	it("explains a missing API key instead of throwing", async () => {
		const c = capture();
		expect(await main(["Checkout is slow"], c.io)).toBe(1);
		expect(c.stderr()).toBe(`${MISSING_KEY_MESSAGE}\n`);
	});

	it("exits 2 with usage on a bad flag", async () => {
		const c = capture({ ANTHROPIC_API_KEY: "test" });
		expect(await main(["--model", "x", "q"], c.io)).toBe(2);
		expect(c.stderr()).toMatch(/Unknown model "x"[\s\S]*Usage:/);
	});

	it("prints the answer, the tool calls and the trace path, and writes the trace", async () => {
		const api = scripted([
			callTools(
				toolUse("t1", "get_service_health"),
				toolUse("t2", "get_incident", { incident_id: "INC-9999" }),
			),
			answer("Root cause: payment-gateway. Runbook RB-07."),
		]);
		const c = capture({ NO_COLOR: "1" }, () => api.createMessage);
		const code = await main(
			["--trace-dir", traceDir, "Checkout is slow"],
			c.io,
		);

		expect(code).toBe(0);
		const out = c.stdout();
		expect(out).toContain("Root cause: payment-gateway. Runbook RB-07.");
		expect(out).toMatch(/Tool calls \(2\)/);
		expect(out).toMatch(/1\. get_service_health \{\} \d+ ms\n/);
		expect(out).toMatch(/2\. get_incident .* ERROR \(not_found\)/);
		expect(out).toMatch(/model claude-sonnet-5-5 · scenario checkout-latency/);
		// NO_COLOR: no escape codes anywhere.
		expect(out + c.stderr()).not.toContain("\u001b[");
		// Progress went to stderr as the calls happened.
		expect(c.stderr()).toMatch(/get_service_health/);

		const [file] = await readdir(traceDir);
		expect(file).toMatch(/-checkout-latency-[0-9a-f]{8}\.json$/);
		expect(out).toContain(`trace: ${join(traceDir, file ?? "")}`);
		const trace = JSON.parse(
			await readFile(join(traceDir, file ?? ""), "utf8"),
		) as Trace;
		expect(trace.status).toBe("answered");
		expect(trace.tool_calls).toHaveLength(2);
	});

	it("colors output on a terminal when NO_COLOR is unset", async () => {
		const api = scripted([answer("All healthy.")]);
		const c = capture({}, () => api.createMessage);
		await main(["--trace-dir", traceDir, "Anything wrong?"], c.io);
		expect(c.stdout()).toContain("\u001b[");
	});

	it("exits 1 with the stop message when the run hits the cap, and still writes the trace", async () => {
		let n = 0;
		const api = scripted([
			() => callTools(toolUse(`t${++n}`, "get_service_health")),
		]);
		const c = capture({ NO_COLOR: "1" }, () => api.createMessage);
		const code = await main(["--trace-dir", traceDir, "Loop forever"], c.io);

		expect(code).toBe(1);
		expect(c.stdout()).toMatch(/No answer: Stopped at the 12-tool-call cap/);
		expect(c.stdout()).toMatch(/Tool calls \(12\)/);
		expect(await readdir(traceDir)).toHaveLength(1);
	});
});

describe("connectInProcess", () => {
	it("publishes the 8 tools as plain Claude tool definitions", async () => {
		const session = await connectInProcess({ scenario: "checkout-latency" });
		try {
			expect(session.tools).toHaveLength(8);
			for (const tool of session.tools) {
				expect(tool.input_schema.type).toBe("object");
				expect(tool.input_schema).not.toHaveProperty("$schema");
				expect(tool).not.toHaveProperty("strict");
				expect(tool.description).toMatch(/Use when/);
			}
		} finally {
			await session.close();
		}
	});
});
