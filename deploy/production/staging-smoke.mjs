// Synthetic staging account only. Login writes staging audit/session records.
const base = process.argv[2];
if (!/^http:\/\/127\.0\.0\.1:320[12]$/.test(base || ""))
  throw new Error("Staging loopback only");
const { STAGING_SMOKE_EMAIL: email, STAGING_SMOKE_PASSWORD: password } =
  process.env;
if (!email || !password)
  throw new Error("Configure synthetic staging smoke credentials");
async function call(path, options = {}) {
  const response = await fetch(base + path, {
    ...options,
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error("Staging smoke request failed");
  return response.json();
}
try {
  const session = await call("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, portal: "admin" }),
  });
  const headers = { Authorization: `Bearer ${session.access_token}` };
  const me = await call("/api/me", { headers });
  if (me.role !== "admin") throw new Error();
  await call("/api/lead-imports", { headers });
  await call("/api/users", { headers });
  const denied = await fetch(base + "/api/me", {
    signal: AbortSignal.timeout(15000),
  });
  if (denied.status !== 401) throw new Error();
  console.log("Staging login, authorization and database reads passed");
} catch {
  console.error(
    "Staging smoke failed; inspect staging locally without logging credentials",
  );
  process.exitCode = 1;
}
