import { describe, expect, it } from "vitest";
import dependencies from "../../fixtures/base/dependencies.json" with {
	type: "json",
};
import oncall from "../../fixtures/base/oncall.json" with { type: "json" };
import runbooks from "../../fixtures/base/runbooks.json" with { type: "json" };
import services from "../../fixtures/base/services.json" with { type: "json" };
import teams from "../../fixtures/base/teams.json" with { type: "json" };
import {
	buildCatalog,
	FixtureError,
	formatPath,
	loadCatalog,
	type RawCatalog,
} from "../../src/domain/fixtures.js";

type Rec = Record<string, unknown>;

const raw = () =>
	structuredClone({ services, dependencies, teams, oncall, runbooks }) as {
		services: Rec[];
		dependencies: Rec[];
		teams: Rec[];
		oncall: Rec[];
		runbooks: Rec[];
	};

function at(records: Rec[], index: number): Rec {
	const record = records[index];
	if (!record) throw new Error(`no fixture record at [${index}]`);
	return record;
}

function issuesFor(data: RawCatalog): string[] {
	try {
		buildCatalog(data);
	} catch (error) {
		expect(error).toBeInstanceOf(FixtureError);
		return (error as FixtureError).issues.map(
			(i) => `${i.file}: ${i.path}: ${i.message}`,
		);
	}
	throw new Error("expected buildCatalog to throw");
}

describe("base catalog", () => {
	const catalog = loadCatalog();

	it("has 10 services and on-call for every owning team (FR-6)", () => {
		expect(catalog.services).toHaveLength(10);
		const covered = new Set(catalog.oncall.map((s) => s.team_id));
		for (const service of catalog.services) {
			expect(covered).toContain(service.team_id);
		}
	});

	it("contains every service and team the eval scenarios name", () => {
		const ids = catalog.services.map((s) => s.id);
		for (const id of [
			"checkout-api",
			"payment-gateway",
			"auth",
			"notifications",
			"search-index",
			"web-app",
		]) {
			expect(ids).toContain(id);
		}
		expect(ids).not.toContain("billing-v2");
		const gateway = catalog.services.find((s) => s.id === "payment-gateway");
		expect(gateway?.team_id).toBe("payments");
	});

	it("limits search-index impact to web-app, which nothing depends on (S6)", () => {
		const dependentsOf = (id: string) =>
			catalog.dependencies
				.filter((e) => e.to_service_id === id)
				.map((e) => e.from_service_id);
		expect(dependentsOf("search-index")).toEqual(["web-app"]);
		expect(dependentsOf("web-app")).toEqual([]);
	});

	it("is memoized", () => {
		expect(loadCatalog()).toBe(catalog);
	});
});

describe("base runbooks", () => {
	const catalog = loadCatalog();
	const runbook = (id: string) => {
		const found = catalog.runbooks.find((r) => r.id === id);
		if (!found) throw new Error(`no runbook ${id}`);
		return found;
	};

	it("has at least 12 runbooks covering every service (FR-6)", () => {
		expect(catalog.runbooks.length).toBeGreaterThanOrEqual(12);
		const covered = new Set(
			catalog.runbooks.flatMap((r) => r.applies_to_service_ids),
		);
		for (const service of catalog.services) {
			expect(covered).toContain(service.id);
		}
	});

	it("escalates each runbook to a team that owns one of its services", () => {
		const owner = new Map(catalog.services.map((s) => [s.id, s.team_id]));
		for (const r of catalog.runbooks) {
			const owners = r.applies_to_service_ids.map((id) => owner.get(id));
			expect(owners, r.id).toContain(r.escalation.team_id);
		}
	});

	it("has RB-07 for the S1 payment-gateway deploy regression, with rollback", () => {
		const rb07 = runbook("RB-07");
		expect(rb07.applies_to_service_ids).toContain("payment-gateway");
		expect(rb07.escalation.team_id).toBe("payments");
		expect(rb07.rollback_steps.join(" ")).toMatch(/rollback payment-gateway/);
	});

	it("has RB-03 for the S2 auth certificate expiry, which no notifications runbook competes with", () => {
		const rb03 = runbook("RB-03");
		expect(rb03.applies_to_service_ids).toEqual(["auth"]);
		expect(rb03.symptoms.join(" ")).toMatch(/401/);
		expect(rb03.title).toMatch(/certificate/i);
		const authRunbooks = catalog.runbooks.filter((r) =>
			r.applies_to_service_ids.includes("auth"),
		);
		for (const r of authRunbooks) {
			expect(r.applies_to_service_ids).not.toContain("notifications");
		}
	});
});

describe("buildCatalog validation (FR-2)", () => {
	it("names the file and field for a schema error", () => {
		const data = raw();
		at(data.services, 3).slo_p95_ms = "fast";
		const issues = issuesFor(data);
		expect(issues).toHaveLength(1);
		expect(issues[0]).toMatch(
			/^fixtures\/base\/services\.json: \[3\]\.slo_p95_ms: /,
		);
	});

	it("rejects unknown fields and person-style handles", () => {
		const data = raw();
		at(data.teams, 0).lead = "someone";
		at(data.oncall, 0).primary_handle = "jane.doe";
		const issues = issuesFor(data);
		expect(issues).toContainEqual(
			expect.stringMatching(/^fixtures\/base\/teams\.json: \[0\]/),
		);
		expect(issues).toContainEqual(
			expect.stringMatching(
				/^fixtures\/base\/oncall\.json: \[0\]\.primary_handle: must be a role-style handle/,
			),
		);
	});

	it("rejects broken references", () => {
		const data = raw();
		at(data.services, 0).team_id = "nobody";
		at(data.dependencies, 0).to_service_id = "billing-v2";
		const issues = issuesFor(data);
		expect(issues).toContain(
			'fixtures/base/services.json: [0].team_id: unknown team "nobody"',
		);
		expect(issues).toContain(
			'fixtures/base/dependencies.json: [0].to_service_id: unknown service "billing-v2"',
		);
	});

	it("rejects duplicate ids, case-insensitive duplicate names, self-edges and duplicate edges", () => {
		const data = raw();
		data.services.push({ ...at(data.services, 0), name: "Something Else" });
		at(data.services, 2).name = String(at(data.services, 1).name).toUpperCase();
		data.dependencies.push(
			{ from_service_id: "auth", to_service_id: "auth", kind: "sync" },
			{ ...at(data.dependencies, 0) },
		);
		const issues = issuesFor(data);
		expect(issues).toContain(
			'fixtures/base/services.json: [10].id: duplicate value "web-app" (first used at [0])',
		);
		expect(issues).toContainEqual(
			expect.stringMatching(/services\.json: \[2\]\.name: duplicate value/),
		);
		expect(issues).toContainEqual(
			expect.stringMatching(
				/dependencies\.json: \[\d+\]\.to_service_id: a service cannot depend on itself/,
			),
		);
		expect(issues).toContainEqual(
			expect.stringMatching(
				/dependencies\.json: \[\d+\]: duplicate edge web-app->auth/,
			),
		);
	});

	it("rejects malformed runbooks", () => {
		const data = raw();
		at(data.runbooks, 0).id = "RB-7";
		at(data.runbooks, 1).diagnostic_steps = [];
		const issues = issuesFor(data);
		expect(issues).toContain(
			"fixtures/base/runbooks.json: [0].id: must be a runbook ID like `RB-07`",
		);
		expect(issues).toContainEqual(
			expect.stringMatching(
				/^fixtures\/base\/runbooks\.json: \[1\]\.diagnostic_steps: /,
			),
		);
	});

	it("rejects broken runbook references and duplicates", () => {
		const data = raw();
		const first = at(data.runbooks, 0);
		first.applies_to_service_ids = ["core-db", "billing-v2", "core-db"];
		first.escalation = { team_id: "nobody", when: "always" };
		data.runbooks.push({
			...at(data.runbooks, 1),
			title: String(first.title).toUpperCase(),
		});
		const issues = issuesFor(data);
		expect(issues).toEqual(
			expect.arrayContaining([
				'fixtures/base/runbooks.json: [0].applies_to_service_ids[1]: unknown service "billing-v2"',
				'fixtures/base/runbooks.json: [0].applies_to_service_ids[2]: service "core-db" is listed twice',
				'fixtures/base/runbooks.json: [0].escalation.team_id: unknown team "nobody"',
				'fixtures/base/runbooks.json: [12].id: duplicate value "RB-02" (first used at [1])',
			]),
		);
		expect(issues).toContainEqual(
			expect.stringMatching(/runbooks\.json: \[12\]\.title: duplicate value/),
		);
	});

	it("requires an on-call shift for every team", () => {
		const data = raw();
		data.oncall = data.oncall.filter((s) => s.team_id !== "payments");
		expect(issuesFor(data)).toEqual([
			'fixtures/base/teams.json: [1].id: team "payments" has no on-call shift in fixtures/base/oncall.json',
		]);
	});

	it("reports a file of the wrong shape and a readable summary", () => {
		const data: RawCatalog = { ...raw(), teams: { web: "Web" } };
		expect(issuesFor(data)[0]).toMatch(
			/^fixtures\/base\/teams\.json: \(root\): /,
		);
		expect(() => buildCatalog(data)).toThrow(
			/^Invalid fixture data \(1 issue\):\n {2}fixtures\/base\/teams\.json/,
		);
	});

	it("formats paths", () => {
		expect(formatPath([])).toBe("(root)");
		expect(formatPath([2, "postmortem", "action_items", 0, "status"])).toBe(
			"[2].postmortem.action_items[0].status",
		);
	});
});
