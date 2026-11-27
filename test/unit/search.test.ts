import { describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/domain/fixtures.js";
import {
	MAX_QUERY_LENGTH,
	searchIncidents,
	searchRunbooks,
	searchTerms,
} from "../../src/domain/search.js";
import { service } from "./helpers.js";

const catalog = loadCatalog();

const incidents = (query: string, serviceId?: string) =>
	searchIncidents(catalog, {
		query,
		service: serviceId === undefined ? undefined : service(serviceId),
	}).map((i) => i.id);
const runbooks = (symptom: string) =>
	searchRunbooks(catalog, symptom).map((r) => r.id);

describe("searchTerms", () => {
	it.each([
		["Deploys deployed deploy", ["deploy"]],
		["latencies", ["latency"]],
		["The checkout is SLOW", ["checkout", "latency"]],
		["payment-gateway", ["payment", "gateway"]],
		["unauthorized 401", ["401"]],
		["certificate certificates cert", ["certificat"]],
		["expired expiry", ["expir"]],
		["502 504 5xx", ["5xx"]],
		["similar past incidents with a problem", []],
		["", []],
		["?!", []],
	])("%j becomes %j", (text, expected) => {
		expect(searchTerms(text)).toEqual(expected);
	});

	it("keeps short stems intact", () => {
		expect(searchTerms("logs class bus")).toEqual(["log", "class", "bus"]);
	});

	it("splits pasted IDs into parts that match nothing on their own", () => {
		// IDs go to `get_incident`; search is for symptoms.
		expect(searchTerms("INC-0142")).toEqual(["inc", "0142"]);
	});
});

describe("query length", () => {
	const longest = `checkout ${"x".repeat(MAX_QUERY_LENGTH - 9)}`;
	const tooLong = `${longest}x`;

	it(`accepts exactly ${MAX_QUERY_LENGTH} characters`, () => {
		expect(longest).toHaveLength(MAX_QUERY_LENGTH);
		expect(searchIncidents(catalog, { query: longest })[0]).toBeDefined();
		expect(searchRunbooks(catalog, longest)[0]).toBeDefined();
	});

	it("rejects longer input instead of cutting it", () => {
		expect(() => searchIncidents(catalog, { query: tooLong })).toThrow(
			RangeError,
		);
		expect(() => searchRunbooks(catalog, tooLong)).toThrow(RangeError);
	});
});

describe("searchIncidents", () => {
	it.each([
		"checkout latency",
		"checkout is slow",
		"checkout latency after payment-gateway deploy",
		"p95 latency payment gateway deploy",
	])("ranks INC-0142 first for %j (S1)", (query) => {
		expect(incidents(query)[0]).toBe("INC-0142");
	});

	it.each(["401 spike auth", "certificate expired", "tls handshake failures"])(
		"ranks INC-0111 first for %j (S2)",
		(query) => {
			expect(incidents(query)[0]).toBe("INC-0111");
		},
	);

	it("finds search-index incidents for degraded search (S6)", () => {
		expect(incidents("search index degraded").slice(0, 3).sort()).toEqual([
			"INC-0109",
			"INC-0133",
			"INC-0153",
		]);
	});

	it("filters to incidents that affected the service", () => {
		const found = searchIncidents(catalog, {
			query: "latency",
			service: service("payment-gateway"),
		});
		expect(found.map((i) => i.id)).toEqual([
			"INC-0142",
			"INC-0141",
			"INC-0131",
		]);
		for (const incident of found) {
			expect(incident.affected_service_ids).toContain("payment-gateway");
		}
	});

	it("breaks ties newest first", () => {
		// Both titles contain "blank", so both score the same.
		expect(incidents("blank")).toEqual(["INC-0155", "INC-0122"]);
	});

	it("lists a service's incidents newest first when the query has no terms", () => {
		expect(incidents("past incidents", "auth")).toEqual([
			"INC-0151",
			"INC-0146",
			"INC-0127",
			"INC-0111",
			"INC-0103",
		]);
	});

	it.each(["", "the", "kafka", "zzzz"])("finds nothing for %j", (query) => {
		expect(incidents(query)).toEqual([]);
	});

	it("finds nothing when no match affected the service", () => {
		expect(incidents("card processor", "calendar-sync")).toEqual([]);
	});

	it("finds each incident by its own title", () => {
		for (const incident of catalog.incidents) {
			expect(incidents(incident.title)[0]).toBe(incident.id);
		}
	});
});

describe("searchRunbooks", () => {
	it.each([
		["checkout latency high after deploy", "RB-07"],
		// RB-05 once said "without a matching rise in latency", which matched.
		["checkout latency", "RB-07"],
		["checkout is slow", "RB-07"],
		["401 spike from auth", "RB-03"],
		["search index slow", "RB-10"],
		["queue backlog", "RB-08"],
		["users logged out", "RB-04"],
		["invoices missing", "RB-12"],
		["double bookings", "RB-09"],
		["too many connections", "RB-01"],
		["stale reads", "RB-02"],
		["blank page after release", "RB-11"],
		["card processor timeouts", "RB-06"],
		["checkout 5xx errors", "RB-05"],
	])("ranks the runbook for %j first: %s", (symptom, id) => {
		expect(runbooks(symptom)[0]).toBe(id);
	});

	it("finds each runbook by its own title", () => {
		for (const runbook of catalog.runbooks) {
			expect(runbooks(runbook.title)[0]).toBe(runbook.id);
		}
	});

	it.each(["", "kafka", "similar problems"])(
		"finds nothing for %j",
		(symptom) => {
			expect(runbooks(symptom)).toEqual([]);
		},
	);
});
