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

	it("works on teams", () => {
		expect(closestMatches("payment", catalog.teams)[0]).toBe("payments");
	});

	it("reads exactly the first 100 characters", () => {
		expect(suggest(`${"z".repeat(97)} db`)).toEqual(["core-db"]); // ends at 100
		expect(suggest(`${"z".repeat(98)} db`)).toEqual([]); // ends at 101
	});

	// The long second word keeps overall similarity under the threshold, so
	// only the word rules can make these match.
	it.each([
		["identical, 2 characters", "ab", "ab", true],
		["identical, 1 character", "a", "a", false],
		["prefix of 3", "abc", "abcdef", true],
		["prefix of 3, query longer", "abcdef", "abc", true],
		["prefix of 2", "ab", "abcdef", false],
		["common first 5", "abcdexx", "abcdeyy", true],
		["common first 4", "abcdxx", "abcdyy", false],
		["substitution in 4", "abcd", "abxd", true],
		["substitution in 3", "abc", "axc", false],
		["insertion", "abcd", "abxcd", true],
		["deletion", "abxcd", "abcd", true],
		["swapped neighbours", "abcd", "acbd", true],
		["swapped first two", "abcd", "bacd", true],
		["two edits", "abcdef", "axcxef", false],
		["a swap plus an edit", "abcdef", "bacdxf", false],
	])("word rule, %s: %s and %s match is %s", (_, query, word, matches) => {
		const label = `${word}-${"0".repeat(30)}`;
		const found = closestMatches(query, [{ id: label, name: label }]);
		expect(found).toEqual(matches ? [label] : []);
	});

	it.each([
		["60%", "abcde", "axcye", true],
		["57%", "abcdefg", "axcyezg", false],
		["33%, repeats are not swaps", "aaa", "a", false],
	])(
		"overall similarity of %s: %s and %s match is %s",
		(_, query, id, matches) => {
			const found = closestMatches(query, [{ id, name: id }]);
			expect(found).toEqual(matches ? [id] : []);
		},
	);

	it("ranks a shared word above higher similarity alone", () => {
		const shared = `abcde-${"0".repeat(30)}`;
		const found = closestMatches("abcde", [
			{ id: "axcye", name: "axcye" },
			{ id: shared, name: shared },
		]);
		expect(found).toEqual([shared, "axcye"]);
	});

	it("ranks more shared words first", () => {
		expect(suggest("payment api checkout")[0]).toBe("checkout-api");
	});

	it("breaks a tie on shared words by similarity", () => {
		const found = closestMatches("abcd", [
			{ id: "abcd-000000", name: "abcd-000000" },
			{ id: "abcd-0", name: "abcd-0" },
		]);
		expect(found).toEqual(["abcd-0", "abcd-000000"]);
	});
});
