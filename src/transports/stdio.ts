import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { loadConfig } from "../config.js";
import { createAcknowledgementStore } from "../domain/acknowledgements.js";
import { loadScenarios } from "../domain/scenarios.js";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../server.js";

// Stdio entry point for local clients (Claude Desktop, Claude Code, MCP
// Inspector). Stdout carries the protocol, so everything else, including
// startup errors, goes to stderr.

const log = (message: string): void => {
	process.stderr.write(`${SERVER_NAME}: ${message}\n`);
};

try {
	const { SCENARIO: scenario } = loadConfig();
	// Validate every fixture before the first request, so a bad file stops
	// startup with a message naming the file and field (PRD FR-2).
	loadScenarios();
	// One store for the life of the process: acknowledgements end with it.
	const ackStore = createAcknowledgementStore();
	serveStdio(() => createServer({ scenario, ackStore }), {
		onerror: (error) => log(`error: ${error.message}`),
	});
	log(`v${SERVER_VERSION} serving scenario "${scenario}" over stdio`);
} catch (error) {
	log(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
