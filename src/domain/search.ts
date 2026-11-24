import type { Catalog } from "./fixtures.js";
import type { Incident, Runbook, Service } from "./schemas.js";

// Keyword search over past incidents and runbooks (PRD `search_incidents`,
// `find_runbook`). Deliberately simple and deterministic: words are lowercased,
// stemmed and mapped through a small synonym table, then each query term
// scores by the most important field it appears in, weighted by how rare it
// is. There is no negation: "no recent deploy" still matches "deploy".

/**
 * The longest query or symptom accepted. Tool schemas use it as their max so
 * long input is rejected with a tool error; nothing is silently cut.
 */
export const MAX_QUERY_LENGTH = 300;

const STOPWORDS = new Set(
	(
		"a about after all an and any are as at be been before but by can did do " +
		"does for from had has have how i if in into is it its me my no not of on " +
		"or our out since so than that the their them then there these they this to " +
		"up was we were what when where which while who why with you your " +
		// Words in nearly every question about past incidents, which rank nothing.
		"incident incidents issue issues past previous problem problems similar"
	).split(" "),
);

/**
 * Stems that mean the same thing for triage. Applied after stemming, to the
 * query and to records alike, so either side can use any of the words.
 *
 * Tuned to the fixtures, so keep it small: add an entry only when an eval
 * shows a real query missing, and test it in `search.test.ts`.
 */
const SYNONYMS: Readonly<Record<string, string>> = {
	slow: "latency",
	slown: "latency",
	p95: "latency",
	unauthoriz: "401",
	cert: "certificat",
	expiry: "expir",
	failur: "fail",
	"500": "5xx",
	"502": "5xx",
	"503": "5xx",
	"504": "5xx",
	logout: "login",
	logg: "login",
};

/** Light suffix stripping: enough to match `deploys`, `deployed` and `deploy`. */
function stem(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
	for (const suffix of ["ness", "ing", "ed", "es", "s"]) {
		if (
			w.endsWith(suffix) &&
			!w.endsWith("ss") &&
			w.length - suffix.length >= 3
		) {
			w = w.slice(0, -suffix.length);
			break;
		}
	}
	if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
	return w;
}

/** The distinct search terms in `text`, in first-seen order. */
export function searchTerms(text: string): string[] {
	const words = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
	const found = words
		.filter((w) => w.length > 1 && !STOPWORDS.has(w))
		.map((w) => {
			const s = stem(w);
			return SYNONYMS[s] ?? s;
		});
	return [...new Set(found)];
}

/** Callers validate the length; over the max is a RangeError. */
function queryTerms(query: string): string[] {
	if (query.length > MAX_QUERY_LENGTH) {
		throw new RangeError(
			`query must be at most ${MAX_QUERY_LENGTH} characters, got ${query.length}`,
		);
	}
	return searchTerms(query);
}

interface Field {
	readonly text: string;
	readonly weight: number;
}

/**
 * Records matching at least one term, best first. Each term adds the weight
 * of the heaviest field containing it times its rarity across `records`, so
 * a word every record shares counts least. Ties keep the input order.
 */
function rank<T>(
	records: readonly T[],
	query: readonly string[],
	fields: (record: T) => readonly Field[],
): T[] {
	const indexed = records.map((record) => {
		const weights = new Map<string, number>();
		for (const { text, weight } of fields(record)) {
			for (const term of searchTerms(text)) {
				weights.set(term, Math.max(weights.get(term) ?? 0, weight));
			}
		}
		return { record, weights };
	});
	// Rarity is relative to `records`, which may be filtered to one service, so
	// scores rank results within one call and mean nothing across calls.
	const rarity = new Map(
		query.map((term) => {
			const df = indexed.filter(({ weights }) => weights.has(term)).length;
			return [term, df === 0 ? 0 : Math.log(1 + records.length / df)];
		}),
	);
	return indexed
		.map(({ record, weights }) => ({
			record,
			score: query.reduce(
				(sum, term) => sum + (weights.get(term) ?? 0) * (rarity.get(term) ?? 0),
				0,
			),
		}))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score)
		.map(({ record }) => record);
}

export interface IncidentQuery {
	readonly query: string;
	/** Only incidents that affected this service. Callers resolve it first. */
	readonly service?: Service | undefined;
}

/**
 * Past incidents matching `query`, best first, ties newest first. Callers cap
 * the list. A query with no search terms (only stopwords, or empty) lists the
 * service's incidents newest first, or nothing when no service is given.
 */
export function searchIncidents(
	catalog: Catalog,
	{ query, service }: IncidentQuery,
): Incident[] {
	const pool = catalog.incidents
		.filter(
			(i) =>
				service === undefined || i.affected_service_ids.includes(service.id),
		)
		.sort((a, b) => a.days_before_start - b.days_before_start);
	const words = queryTerms(query);
	if (words.length === 0) return service === undefined ? [] : pool;
	return rank(pool, words, (incident) => [
		{ text: incident.title, weight: 3 },
		{ text: incident.symptoms, weight: 2 },
		{ text: incident.root_cause_service_id, weight: 2 },
		{ text: incident.root_cause_summary, weight: 1 },
		{ text: incident.affected_service_ids.join(" "), weight: 1 },
	]);
}

/**
 * Runbooks matching a symptom description, best first, ties in catalog order.
 * Callers cap the list. No search terms means no matches.
 */
export function searchRunbooks(catalog: Catalog, symptom: string): Runbook[] {
	return rank(catalog.runbooks, queryTerms(symptom), (runbook) => [
		{ text: runbook.title, weight: 3 },
		{ text: runbook.symptoms.join(" "), weight: 2 },
		{ text: runbook.applies_to_service_ids.join(" "), weight: 2 },
	]);
}
