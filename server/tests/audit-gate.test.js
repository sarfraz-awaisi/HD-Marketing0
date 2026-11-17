import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluate, seriousAdvisories } from "../../scripts/audit-gate.mjs";
// The dependency security gate (scripts/audit-gate.mjs): high and critical
// advisories fail CI and the Production release unless listed, with a reason
// and an unexpired date, in scripts/audit-exceptions.json; never for a
// production dependency.
const advisory = (name, id, severity = "high") => ({
  name,
  severity,
  via: [
    {
      source: 1,
      name,
      title: `${name} problem`,
      url: `https://github.com/advisories/${id}`,
      severity,
    },
  ],
});
const report = (...entries) => ({
  vulnerabilities: Object.fromEntries(entries.map((e) => [e.name, e])),
});
// A package that is only affected through another one names it, not an advisory.
const through = (name, dependency) => ({
  name,
  severity: "high",
  via: [dependency],
});
const exception = (id, expires = "2026-12-17", reason = "Build tool only") => ({
  id,
  expires,
  reason,
});
const run = (full, production = report(), exceptions = []) =>
  evaluate({ full, production, exceptions, today: "2026-11-18" });

describe("dependency security gate", () => {
  it("lists each serious advisory once, with the packages it reaches", () => {
    const found = seriousAdvisories(
      report(
        advisory("picomatch", "GHSA-aaaa-bbbb-cccc"),
        through("vite", "picomatch"),
        advisory("left-pad", "GHSA-dddd-eeee-ffff", "moderate"),
      ),
    );
    expect(found.map((a) => [a.id, a.package, [...a.reaches]])).toEqual([
      ["GHSA-aaaa-bbbb-cccc", "picomatch", ["picomatch"]],
    ]);
  });

  it("passes with an advisory listed with a reason and a date not yet passed", () => {
    const verdict = run(
      report(advisory("picomatch", "GHSA-aaaa-bbbb-cccc")),
      report(),
      [exception("GHSA-aaaa-bbbb-cccc")],
    );
    expect(verdict.problems).toEqual([]);
    expect(verdict.used.map((u) => u.id)).toEqual(["GHSA-aaaa-bbbb-cccc"]);
  });

  it("fails on any other high or critical advisory, and ignores moderate and low", () => {
    const verdict = run(
      report(
        advisory("picomatch", "GHSA-aaaa-bbbb-cccc"),
        advisory("lodash", "GHSA-1111-2222-3333", "critical"),
        advisory("minimist", "GHSA-4444-5555-6666", "moderate"),
        advisory("debug", "GHSA-7777-8888-9999", "low"),
      ),
      report(),
      [exception("GHSA-aaaa-bbbb-cccc")],
    );
    expect(verdict.problems).toEqual([
      "GHSA-1111-2222-3333 (critical, lodash): lodash problem",
    ]);
  });

  it("fails once an exception has expired, or when it gives no reason", () => {
    expect(
      run(report(advisory("picomatch", "GHSA-aaaa-bbbb-cccc")), report(), [
        exception("GHSA-aaaa-bbbb-cccc", "2026-11-17"),
      ]).problems,
    ).toEqual(["GHSA-aaaa-bbbb-cccc: its exception expired on 2026-11-17"]);
    expect(
      run(report(advisory("picomatch", "GHSA-aaaa-bbbb-cccc")), report(), [
        exception("GHSA-aaaa-bbbb-cccc", "2026-12-17", ""),
      ]).problems,
    ).toEqual(["GHSA-aaaa-bbbb-cccc: its exception gives no reason"]);
    expect(
      run(report(advisory("picomatch", "GHSA-aaaa-bbbb-cccc")), report(), [
        exception("GHSA-aaaa-bbbb-cccc", "soon"),
      ]).problems,
    ).toEqual(["GHSA-aaaa-bbbb-cccc: its exception expired on soon"]);
  });

  it("never excuses an advisory in a production dependency", () => {
    const vulnerable = report(advisory("picomatch", "GHSA-aaaa-bbbb-cccc"));
    expect(
      run(vulnerable, vulnerable, [exception("GHSA-aaaa-bbbb-cccc")]).problems,
    ).toEqual([
      "GHSA-aaaa-bbbb-cccc (high, picomatch) is in a production dependency: no exception allowed",
    ]);
  });

  it("keeps the checked-in exceptions short-lived and explained", () => {
    const listed = JSON.parse(
      readFileSync(
        new URL("../../scripts/audit-exceptions.json", import.meta.url),
        "utf8",
      ),
    );
    for (const e of listed) {
      expect(e.id).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
      expect(e.reason.length).toBeGreaterThan(40);
      expect(e.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // At most 31 days from when it was added.
      expect(
        (Date.parse(e.expires) - Date.parse(e.added)) / 86400000,
      ).toBeLessThanOrEqual(31);
    }
  });
});
