import { describe, expect, it } from "vitest";
import {
	capList,
	ERROR_META_KEY,
	moreLine,
	ok,
	serviceNotFound,
	toolError,
} from "../../src/tools/_shared.js";

describe("capList", () => {
	it("keeps the first items and counts the rest", () => {
		expect(capList([1, 2, 3, 4, 5, 6, 7], 5)).toEqual({
			shown: [1, 2, 3, 4, 5],
			more_available: 2,
		});
	});

	it("reports nothing more when the list fits", () => {
		expect(capList([1, 2], 5)).toEqual({ shown: [1, 2], more_available: 0 });
	});
});

describe("moreLine", () => {
	it("is empty when nothing was left out", () => {
		expect(moreLine({ shown: [1], more_available: 0 }, "Narrow it.")).toBe("");
	});

	it("says how many more and how to narrow", () => {
		expect(moreLine({ shown: [1], more_available: 4 }, "Narrow it.")).toBe(
			"\n4 more not shown. Narrow it.",
		);
	});
});

describe("ok", () => {
	it("returns text and structured content together", () => {
		expect(ok("hi", { a: 1 })).toEqual({
			content: [{ type: "text", text: "hi" }],
			structuredContent: { a: 1 },
		});
	});
});

describe("toolError", () => {
	it("is a tool error carrying its kind in _meta", () => {
		expect(toolError("invalid_argument", "Bad.")).toEqual({
			isError: true,
			content: [{ type: "text", text: "Bad." }],
			_meta: {
				[ERROR_META_KEY]: { kind: "invalid_argument", suggestions: [] },
			},
		});
	});

	it("appends at most 3 suggestions", () => {
		const result = toolError("not_found", "Missing.", ["a", "b", "c", "d"]);
		expect(result.content).toEqual([
			{ type: "text", text: "Missing. Did you mean `a`, `b`, `c`?" },
		]);
		expect(result._meta?.[ERROR_META_KEY]).toEqual({
			kind: "not_found",
			suggestions: ["a", "b", "c"],
		});
	});
});

describe("serviceNotFound", () => {
	it("uses the next step only when there are no suggestions", () => {
		const text = (r: ReturnType<typeof toolError>) =>
			r.content[0]?.type === "text" ? r.content[0].text : "";
		expect(text(serviceNotFound("x", ["auth"], "Try Y."))).toBe(
			'No service matches "x". Did you mean `auth`?',
		);
		expect(text(serviceNotFound("x", [], "Try Y."))).toBe(
			'No service matches "x". No service has a similar name. Try Y.',
		);
	});
});
