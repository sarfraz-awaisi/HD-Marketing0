// The dependency security gate of CI and the Production release, in place of
// `npm audit --audit-level=high`. It fails on any high or critical advisory,
// with one narrow way out for a problem that has no fix yet:
// - the packages the server and the site run with (production dependencies)
//   may have no high or critical advisory at all;
// - in the full audit (build and test tools included), an advisory listed in
//   scripts/audit-exceptions.json, with its reason and an expiry date not yet
//   passed, is reported but does not fail the gate. Any other one does.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
const SERIOUS = new Set(["high", "critical"]);
// Each serious advisory once, by its GitHub id, with the packages it reaches.
export function seriousAdvisories(report) {
  const found = new Map();
  for (const entry of Object.values(report?.vulnerabilities || {}))
    for (const via of entry.via || []) {
      if (typeof via !== "object" || !SERIOUS.has(via.severity)) continue;
      const id =
        /GHSA-[a-z0-9-]+/i.exec(via.url || "")?.[0] || `npm-${via.source}`;
      const advisory = found.get(id) || {
        id,
        package: via.name,
        severity: via.severity,
        title: via.title,
        reaches: new Set(),
      };
      advisory.reaches.add(entry.name);
      found.set(id, advisory);
    }
  return [...found.values()];
}
// The gate's verdict: problems (it fails if there are any) and the
// exceptions it used.
export function evaluate({ full, production, exceptions, today }) {
  const problems = [],
    used = [];
  for (const a of seriousAdvisories(production))
    problems.push(
      `${a.id} (${a.severity}, ${a.package}) is in a production dependency: no exception allowed`,
    );
  const listed = new Map((exceptions || []).map((e) => [e.id, e]));
  for (const a of seriousAdvisories(full)) {
    const e = listed.get(a.id);
    if (!e) {
      problems.push(`${a.id} (${a.severity}, ${a.package}): ${a.title}`);
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.expires || "") || e.expires < today)
      problems.push(`${a.id}: its exception expired on ${e.expires}`);
    else if (!e.reason) problems.push(`${a.id}: its exception gives no reason`);
    else used.push({ ...a, reaches: [...a.reaches], expires: e.expires });
  }
  return { problems, used };
}
const audit = (args) => {
  try {
    return JSON.parse(
      execFileSync("npm", ["audit", "--json", ...args], {
        encoding: "utf8",
        maxBuffer: 64 << 20,
      }),
    );
  } catch (error) {
    // npm audit exits non-zero when it finds anything; its report is still
    // on standard output. No report at all is a failure of the gate.
    if (error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
};
// Run as a command (not imported, as the tests do).
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const exceptions = JSON.parse(
    readFileSync(new URL("./audit-exceptions.json", import.meta.url), "utf8"),
  );
  const { problems, used } = evaluate({
    full: audit([]),
    production: audit(["--omit=dev"]),
    exceptions,
    today: new Date().toISOString().slice(0, 10),
  });
  for (const u of used)
    console.log(
      `Accepted until ${u.expires}: ${u.id} (${u.severity}, ${u.package}, reaches ${u.reaches.join(", ")}): ${u.title}`,
    );
  if (problems.length) {
    console.error(
      [
        "Dependency security gate failed:",
        ...problems.map((p) => "  • " + p),
      ].join("\n"),
    );
    process.exit(1);
  }
  console.log(
    "Dependency security gate passed: no high or critical advisory without an exception.",
  );
}
