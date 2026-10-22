// No credentials; the loopback readiness route performs one bounded read.
const [base, release] = process.argv.slice(2);
if (
  !/^http:\/\/127\.0\.0\.1:(310[12]|320[12])$/.test(base || "") ||
  !/^[a-f0-9]{40}$/.test(release || "")
)
  throw new Error("Invalid health target");
try {
  const response = await fetch(`${base}/ready`, {
    signal: AbortSignal.timeout(7000),
  });
  const body = await response.json();
  if (!response.ok || body.status !== "ready" || body.release !== release)
    throw new Error();
} catch {
  console.error("Candidate readiness failed");
  process.exitCode = 1;
}
