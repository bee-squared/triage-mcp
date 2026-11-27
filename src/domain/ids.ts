import { editDistance, MAX_SUGGESTIONS } from "./closest.js";

// Parsing and "did you mean" for stable record IDs such as `INC-0142` and
// `RB-07`. Names use `closest.ts`; IDs can't, because every ID shares its
// prefix, so `INC-9999` would look close to all of them. Here only the
// number counts: a suggestion must be one digit typo away (`INC-0124` for
// `INC-0142`, `INC-0143` for `INC-0142`), and anything farther gets none.

export interface IdFormat {
	/** Upper-case prefix, such as `INC`. */
	readonly prefix: string;
	/** Digits in a canonical ID, zero-padded: 4 for `INC-0142`. */
	readonly digits: number;
}

export const INCIDENT_ID: IdFormat = { prefix: "INC", digits: 4 };
export const RUNBOOK_ID: IdFormat = { prefix: "RB", digits: 2 };

/**
 * The canonical form of `input`, or undefined if it isn't an ID of this
 * format. Forgiving about case, separators and zero padding, so `inc 142`,
 * `INC0142` and `INC-142` all read as `INC-0142`. A bare number is accepted
 * too, since the tool already says which kind of ID it takes.
 */
export function parseId(format: IdFormat, input: string): string | undefined {
	const pattern = new RegExp(`^(?:${format.prefix}[\\s_-]*)?(\\d+)$`, "i");
	const digits = input.trim().match(pattern)?.[1];
	if (digits === undefined) return undefined;
	const value = Number.parseInt(digits, 10);
	if (value >= 10 ** format.digits) return undefined;
	return `${format.prefix}-${String(value).padStart(format.digits, "0")}`;
}

const numberOf = (id: string): string => id.slice(id.indexOf("-") + 1);

/**
 * Up to 3 of `ids` one digit typo from `canonical` (a changed digit, or two
 * neighbours swapped), nearest number first. `canonical` comes from `parseId`.
 */
export function closestIds(
	canonical: string,
	ids: readonly string[],
): string[] {
	const wanted = numberOf(canonical);
	const value = Number(wanted);
	return ids
		.filter((id) => id !== canonical && editDistance(numberOf(id), wanted) <= 1)
		.sort(
			(a, b) =>
				Math.abs(Number(numberOf(a)) - value) -
				Math.abs(Number(numberOf(b)) - value),
		)
		.slice(0, MAX_SUGGESTIONS);
}

export type IdLookup<T> =
	| { readonly status: "found"; readonly record: T }
	| { readonly status: "malformed" }
	| {
			readonly status: "not_found";
			readonly id: string;
			readonly suggestions: readonly string[];
	  };

/** Finds a record by ID in any accepted spelling. Never resolves a near miss. */
export function findById<T extends { readonly id: string }>(
	format: IdFormat,
	records: readonly T[],
	input: string,
): IdLookup<T> {
	const id = parseId(format, input);
	if (id === undefined) return { status: "malformed" };
	const record = records.find((r) => r.id === id);
	if (record) return { status: "found", record };
	return {
		status: "not_found",
		id,
		suggestions: closestIds(
			id,
			records.map((r) => r.id),
		),
	};
}
