import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/domain/fixtures.js";
import {
	closestIds,
	findById,
	INCIDENT_ID,
	parseId,
	RUNBOOK_ID,
} from "../../src/domain/ids.js";

const catalog = loadCatalog();
const incidentIds = catalog.incidents.map((i) => i.id);
const runbookIds = catalog.runbooks.map((r) => r.id);

describe("parseId", () => {
	it.each([
		["INC-0142", "INC-0142"],
		["inc-0142", "INC-0142"],
		["INC 0142", "INC-0142"],
		["INC_0142", "INC-0142"],
		["INC0142", "INC-0142"],
		["INC-142", "INC-0142"],
		["INC-00142", "INC-0142"],
		["142", "INC-0142"],
		["  INC-0142\n", "INC-0142"],
	])("reads %j as %s", (input, id) => {
		expect(parseId(INCIDENT_ID, input)).toBe(id);
	});

	it.each([
		"RB-07",
		"INC-",
		"INC-12345",
		"INC-01a2",
		"INC--",
		"",
		"incident 142",
	])("rejects %j", (input) => {
		expect(parseId(INCIDENT_ID, input)).toBeUndefined();
	});

	it("handles runbook IDs too", () => {
		expect(parseId(RUNBOOK_ID, "rb7")).toBe("RB-07");
		expect(parseId(RUNBOOK_ID, "RB-100")).toBeUndefined();
	});
});

describe("closestIds", () => {
	it("suggests IDs one digit off, nearest number first", () => {
		expect(closestIds("INC-0143", incidentIds)).toEqual([
			"INC-0142",
			"INC-0144",
			"INC-0141",
		]);
	});

	it("counts two swapped digits as one typo", () => {
		expect(closestIds("INC-0412", incidentIds)).toContain("INC-0142");
	});

	it.each(["INC-9999", "INC-0001", "INC-0500"])(
		"suggests nothing for %s, which is far from every ID",
		(id) => {
			expect(closestIds(id, incidentIds)).toEqual([]);
		},
	);

	it("never suggests the ID itself", () => {
		expect(closestIds("INC-0142", incidentIds)).not.toContain("INC-0142");
	});

	it("suggests the neighbouring runbook for one past the end", () => {
		expect(closestIds("RB-13", runbookIds)).toContain("RB-12");
	});
});

describe("findById", () => {
	it("finds a record in any accepted spelling", () => {
		expect(findById(INCIDENT_ID, catalog.incidents, "inc 142")).toMatchObject({
			status: "found",
			record: { id: "INC-0142" },
		});
	});

	it("reports a miss with its canonical ID and suggestions", () => {
		expect(findById(INCIDENT_ID, catalog.incidents, "inc-143")).toEqual({
			status: "not_found",
			id: "INC-0143",
			suggestions: ["INC-0142", "INC-0144", "INC-0141"],
		});
	});

	it("reports input that isn't an ID as malformed", () => {
		expect(findById(INCIDENT_ID, catalog.incidents, "RB-07")).toEqual({
			status: "malformed",
		});
	});
});
