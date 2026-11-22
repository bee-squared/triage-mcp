import { describe, expect, it } from "vitest";
import { closestMatches } from "../../src/domain/closest.js";
import { loadCatalog } from "../../src/domain/fixtures.js";
import { findService } from "../../src/domain/services.js";

const catalog = loadCatalog();
const suggest = (query: string) => closestMatches(query, catalog.services);

describe("findService", () => {
	it.each(catalog.services)("finds $id by ID and by name", (service) => {
		for (const query of [service.id, service.name]) {
			expect(findService(catalog, query)).toEqual({ found: true, service });
		}
	});

	it.each([
		["  AUTH ", "auth"],
		["payment_gateway", "payment-gateway"],
		["Checkout  api", "checkout-api"],
		["core db", "core-db"],
		["core-database", "core-db"],
	])("normalizes %j to %s", (query, id) => {
		expect(findService(catalog, query)).toMatchObject({
			found: true,
			service: { id },
		});
	});

	it("suggests billing for billing-v2 without resolving to it (S4)", () => {
		expect(findService(catalog, "billing-v2")).toEqual({
			found: false,
			suggestions: ["billing"],
		});
	});

	it.each([
		"billin",
		"checkout",
		"authentication",
		"billing!",
		"auth 中文",
		"",
	])("never resolves the near miss %j", (query) => {
		expect(findService(catalog, query).found).toBe(false);
	});
});

describe("closestMatches", () => {
	it.each([
		["serach", "search-index"],
		["bilng", "billing"], // no shared word, only overall similarity
		["paymentgateway", "payment-gateway"],
		["payments", "payment-gateway"],
		["checkout", "checkout-api"],
		["checkout-service", "checkout-api"],
		["authentication", "auth"],
		["database", "core-db"],
		["db", "core-db"],
		["notifcations", "notifications"],
		["scheduling-v2", "scheduling-api"],
		["scheduler", "scheduling-api"],
		["notifs", "notifications"],
	])("ranks the best match for %j first: %s", (query, id) => {
		expect(suggest(query)[0]).toBe(id);
	});

	it.each(["", "   ", "???", "zzzz", "kafka"])(
		"suggests nothing for %j",
		(query) => {
			expect(suggest(query)).toEqual([]);
		},
	);

	it("returns at most 3", () => {
		expect(suggest("api app auth billing core search")).toHaveLength(3);
	});

	it("works on records without names, such as incidents", () => {
		const ids = catalog.incidents.map(({ id }) => ({ id }));
		const matches = closestMatches("INC-1042", ids);
		expect(matches).toHaveLength(3);
		expect(matches).toContain("INC-0142");
	});

	it("ignores everything past the first 100 characters", () => {
		expect(suggest(`${"z".repeat(100)} billing`)).toEqual([]);
	});
});
