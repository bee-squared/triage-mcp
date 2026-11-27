import { McpServer } from "@modelcontextprotocol/server";
import packageJson from "../package.json" with { type: "json" };
import type { AcknowledgementStore } from "./domain/acknowledgements.js";
import { loadCatalog } from "./domain/fixtures.js";
import { loadScenario } from "./domain/scenarios.js";
import type { ScenarioId } from "./domain/schemas.js";
import { registerTool, type ToolContext } from "./tools/_shared.js";
import { getIncidentTool } from "./tools/get-incident.js";
import { getServiceDependenciesTool } from "./tools/get-service-dependencies.js";
import { getServiceHealthTool } from "./tools/get-service-health.js";
import { listRecentDeploysTool } from "./tools/list-recent-deploys.js";
import { searchIncidentsTool } from "./tools/search-incidents.js";

// The one server factory, shared by the stdio and HTTP transports, the agent
// and the tests. It reads no environment variables: callers pass the scenario
// and the acknowledgement store, so every caller decides their lifetime.

export const SERVER_NAME = "triage-mcp";
export const SERVER_VERSION = packageJson.version;

const INSTRUCTIONS = [
	"Tools for triaging outages at Fernhill, a fictional SaaS company. All data is synthetic.",
	"Start with get_service_health (no arguments) to see what is unhealthy, then follow dependencies, recent deploys and past incidents.",
	"Only acknowledge an incident when the user explicitly asks you to.",
].join(" ");

export interface CreateServerOptions {
	readonly scenario: ScenarioId;
	/**
	 * Acknowledgements live here. Pass a fresh store per eval trial, and one
	 * per process for a long-running transport.
	 */
	readonly ackStore: AcknowledgementStore;
}

export function createServer({
	scenario,
	ackStore,
}: CreateServerOptions): McpServer {
	const context: ToolContext = {
		catalog: loadCatalog(),
		scenario: loadScenario(scenario),
		ackStore,
	};
	const server = new McpServer(
		{ name: SERVER_NAME, version: SERVER_VERSION },
		{ instructions: INSTRUCTIONS },
	);
	registerTool(server, getServiceHealthTool, context);
	registerTool(server, getServiceDependenciesTool, context);
	registerTool(server, listRecentDeploysTool, context);
	registerTool(server, searchIncidentsTool, context);
	registerTool(server, getIncidentTool, context);
	return server;
}
