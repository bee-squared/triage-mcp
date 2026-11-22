// "Did you mean" suggestions for not-found errors (PRD FR-14). Only plausible
// matches are returned, so an unrelated query gets none instead of 3 guesses.

export const MAX_SUGGESTIONS = 3;

/** Longer input can't be a near miss, and edit distance costs length x length. */
const MAX_QUERY_LENGTH = 100;
/** How alike two whole strings must be to match without sharing a word. */
const MIN_SIMILARITY = 0.6;

export interface Candidate {
	readonly id: string;
	readonly name?: string;
}

const toWords = (text: string): string[] =>
	text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** Edit distance, counting two swapped neighbours as one edit. */
function editDistance(a: string, b: string): number {
	let beforePrevious: number[] = [];
	let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			let cost = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1),
			);
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
				cost = Math.min(cost, (beforePrevious[j - 2] ?? 0) + 1);
			}
			current.push(cost);
		}
		beforePrevious = previous;
		previous = current;
	}
	return previous[b.length] ?? 0;
}

function wordsMatch(a: string, b: string): boolean {
	if (a === b) return a.length >= 2;
	const shorter = Math.min(a.length, b.length);
	if (shorter >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
	// Same stem: `scheduler` and `scheduling`, `notifs` and `notifications`.
	if (shorter >= 5 && a.slice(0, 5) === b.slice(0, 5)) return true;
	return shorter >= 4 && editDistance(a, b) <= 1;
}

/** Shared words count most, then overall similarity. Zero means implausible. */
function score(query: readonly string[], label: readonly string[]): number {
	const a = query.join("-");
	const b = label.join("-");
	const similarity = 1 - editDistance(a, b) / Math.max(a.length, b.length);
	const shared = label.filter((word) =>
		query.some((other) => wordsMatch(other, word)),
	).length;
	return shared > 0 || similarity >= MIN_SIMILARITY ? shared + similarity : 0;
}

/** IDs of up to 3 candidates that resemble `query` by ID or name, best first. */
export function closestMatches(
	query: string,
	candidates: readonly Candidate[],
): string[] {
	const words = toWords(query.slice(0, MAX_QUERY_LENGTH));
	if (words.length === 0) return [];
	return candidates
		.map(({ id, name }) => ({
			id,
			score: Math.max(
				score(words, toWords(id)),
				name === undefined ? 0 : score(words, toWords(name)),
			),
		}))
		.filter((match) => match.score > 0)
		.sort((a, b) => b.score - a.score)
		.slice(0, MAX_SUGGESTIONS)
		.map((match) => match.id);
}
