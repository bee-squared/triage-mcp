import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/domain/fixtures.js";
import {
	findTeam,
	getOnCall,
	getOnCallForService,
} from "../../src/domain/oncall.js";
import { service } from "./helpers.js";

const catalog = loadCatalog();

function team(id: string) {
	const lookup = findTeam(catalog, id);
	if (!lookup.found) throw new Error(`no test team "${id}"`);
	return lookup.team;
}

describe("findTeam", () => {
	it.each(catalog.teams)("finds $id by ID and by name", (expected) => {
		for (const query of [
			expected.id,
			expected.name,
			` ${expected.name.toUpperCase()} `,
		]) {
			expect(findTeam(catalog, query)).toEqual({ found: true, team: expected });
		}
	});

	it.each([
		["payment", ["payments"]],
		["Payments team", ["payments"]],
		["messages", ["messaging"]],
		["platforms", ["platform"]],
	])("suggests %j -> %j without resolving it", (query, suggestions) => {
		expect(findTeam(catalog, query)).toEqual({ found: false, suggestions });
	});

	it.each(["", "kafka", "sre"])("suggests nothing for %j", (query) => {
		expect(findTeam(catalog, query)).toEqual({ found: false, suggestions: [] });
	});
});

describe("getOnCall", () => {
	it("returns the shift, channel and owned services (S1 pages Payments)", () => {
		expect(getOnCall(catalog, team("payments"))).toEqual({
			team: team("payments"),
			primary_handle: "payments-primary",
			secondary_handle: "payments-secondary",
			escalation_channel: "#payments-escalation",
			service_ids: ["checkout-api", "payment-gateway", "billing"],
		});
	});

	it.each(catalog.teams)("covers $id", (t) => {
		const oncall = getOnCall(catalog, t);
		expect(oncall.primary_handle).toBe(`${t.id}-primary`);
		expect(oncall.service_ids.length).toBeGreaterThan(0);
	});
});

describe("getOnCallForService", () => {
	it.each([
		["payment-gateway", "payments"],
		["auth", "identity"],
		["search-index", "platform"],
		["calendar-sync", "scheduling"],
	])("pages the team that owns %s: %s", (serviceId, teamId) => {
		expect(getOnCallForService(catalog, service(serviceId))).toEqual(
			getOnCall(catalog, team(teamId)),
		);
	});
});
