import assert from "node:assert/strict";
import { createClient } from "@supabase/supabase-js";
import { validateRuntime } from "../server/src/config/runtime.js";
// Applies the LOCAL_DEV_ONLY checks before signing in anywhere.
validateRuntime();
const url = process.env.SUPABASE_URL,
  key = process.env.VITE_SUPABASE_ANON_KEY;
const own = process.env.LIVE_OWN_LEAD_ID,
  other = process.env.LIVE_OTHER_LEAD_ID;
if (!url || !key || !own || !other)
  throw new Error(
    "Set SUPABASE_URL, VITE_SUPABASE_ANON_KEY, LIVE_OWN_LEAD_ID and LIVE_OTHER_LEAD_ID in root .env",
  );
const db = createClient(url, key, { auth: { persistSession: false } });
const { data, error } = await db.auth.signInWithPassword({
  email: process.env.DEV_AGENT_EMAIL,
  password: process.env.DEV_AGENT_PASSWORD,
});
if (error) throw new Error("Development agent login failed");
const token = data.session.access_token;
const base = `http://localhost:${process.env.PORT || 3001}/api`;
const get = (path) =>
  fetch(base + path, { headers: { Authorization: `Bearer ${token}` } });
try {
  const meResponse = await get("/me?portal=agent");
  assert.equal(meResponse.status, 200, "Agent bootstrap must be available");
  const profile = await meResponse.json();
  assert.equal(profile.id, data.user.id, "Verified identity must match");
  assert.equal(profile.role, "agent", "Use a development agent for this check");
  assert.equal(
    profile.mfa_required,
    false,
    "This password-only script needs an optional, unenrolled agent. Use the two-factor guide for MFA acceptance; do not disable admin MFA.",
  );
  for (const table of [
    "leads",
    "profiles",
    "meta_connections",
    "meta_pages",
    "meta_forms",
    "meta_submissions",
    "meta_notice_reads",
  ]) {
    const result = await db.from(table).select("*").limit(1);
    assert(result.error, `Browser REST must deny ${table}`);
  }
  const phone = await db.rpc("private_phone", { p_lead: own });
  assert(phone.error, "Browser RPC must deny private_phone");
  const mfaState = await db.rpc("mfa_session_state", { p_actor: data.user.id });
  assert(mfaState.error, "Browser RPC must deny private MFA state");
  for (const table of ["mfa_attempts", "mfa_resets"]) {
    const result = await fetch(url + "/rest/v1/" + table + "?select=*", {
      headers: {
        apikey: key,
        Authorization: `Bearer ${token}`,
        "Accept-Profile": "crm_private",
      },
    });
    assert(result.status >= 400, "Private MFA tables must be inaccessible");
  }
  const vault = await fetch(url + "/rest/v1/lead_phones?select=*", {
    headers: {
      apikey: key,
      Authorization: `Bearer ${token}`,
      "Accept-Profile": "crm_private",
    },
  });
  assert(vault.status >= 400, "Private schema must be inaccessible");
  const ownResponse = await get("/leads/" + own);
  assert.equal(ownResponse.status, 200);
  const lead = await ownResponse.json();
  assert(lead.masked_phone.includes("******"));
  assert(
    /^\+[0-9]{10,15}$/.test(lead.phone),
    "Authorized own contact must be visible",
  );
  for (const path of [`/leads/${other}`, `/leads/${other}/timeline`])
    assert(
      [403, 404].includes((await get(path)).status),
      "Cross-agent record must be denied",
    );
  assert.equal((await get("/leads/" + own + "/phone")).status, 200);
  for (const path of [
    "/integrations/meta/settings",
    "/integrations/meta/summary",
    "/integrations/meta/inbox",
  ]) {
    assert.equal(
      (await get(path)).status,
      403,
      "Agents must not access Meta administration",
    );
  }
  const metaSummary = await db.rpc("meta_summary", { p_actor: data.user.id });
  assert(metaSummary.error, "Browser RPC must deny Meta functions");
  assert.equal((await get("/audit")).status, 403);
  assert.equal((await fetch(base + "/me")).status, 401);
  assert.equal(
    (
      await fetch(base + "/me", {
        headers: { Authorization: "Bearer invalid" },
      })
    ).status,
    401,
  );
  const escalation = await fetch(base + "/users/" + data.user.id, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ role: "admin" }),
  });
  assert.equal(escalation.status, 403);
  console.log(
    "Live Supabase access checks passed for the optional development agent. Administrator MFA, Storage, recovery, expired JWTs and concurrent connections require the documented acceptance checks.",
  );
} finally {
  await db.auth.signOut();
}
