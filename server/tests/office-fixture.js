// A small office for API tests: admins and agents with JWT-shaped tokens,
// their leads, and an in-memory Supabase that answers every query and RPC the
// main routes make, so requests run the real middleware and route handlers
// (authentication, rate limits, validation) without a database.
import { randomUUID } from "node:crypto";
const pad = (n, size = 12) => String(n).padStart(size, "0");
export function office({ admins = 1, agents = 9, ip = "203.0.113.10" } = {}) {
  const people = [];
  for (let i = 0; i < admins + agents; i++) {
    const role = i < admins ? "admin" : "agent";
    const id = `c1000000-0000-4000-8000-${pad(i + 1)}`;
    people.push({
      id,
      uid: 300001 + i,
      role,
      name: `${role === "admin" ? "Admin" : "Agent"} ${i + 1}`,
      email: `${role}${i + 1}@hd-office.test`,
      password: `correct-password-${i + 1}`,
      // A distinct address per person when ip is a function.
      ip: typeof ip === "function" ? ip(i) : ip,
      token: jwt(id),
      leads: Array.from({ length: 40 }, (_, n) => leadId(i, n)),
    });
  }
  return people;
}
// JWT-shaped bearer token; only the fake Supabase decides whose it is.
const jwt = (sub) =>
  [
    "e30",
    Buffer.from(
      JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 86400 * 365 }),
    ).toString("base64url"),
    "sig",
  ].join(".");
const leadId = (person, n) =>
  `d1000000-0000-4000-8${pad(person, 3)}-${pad(n + 1)}`;
const leadOwner = (people, id) => people[Number(id.slice(19, 23)) - 8000];

export function fakeSupabase(people) {
  const byToken = new Map(people.map((p) => [p.token, p])),
    byId = new Map(people.map((p) => [p.id, p])),
    byEmail = new Map(people.map((p) => [p.email, p]));
  const profile = (p) => ({
    id: p.id,
    uid: p.uid,
    name: p.name,
    role: p.role,
    active: true,
  });
  const respond = async (value) => value;
  const leadRow = (id, owner) => ({
    id,
    lead_no: 1000 + Number(id.slice(-4)),
    name: "Customer " + id.slice(-4),
    status: "new",
    source: "manual",
    assigned_agent: owner?.id || null,
    deleted_at: null,
    created_at: "2026-10-20T05:00:00.000Z",
  });
  const list = (table, filters) => {
    if (table === "profiles") return people.map(profile);
    if (table !== "leads") return [];
    const owner = byId.get(filters.assigned_agent);
    const rows = (owner ? [owner] : people.filter((p) => p.role === "agent"))
      .flatMap((p) => p.leads.map((id) => leadRow(id, p)))
      .slice(0, 20);
    return rows;
  };
  const one = (table, filters) => {
    if (table === "profiles") {
      const p = byId.get(filters.id);
      return p
        ? { data: profile(p) }
        : { data: null, error: { code: "PGRST116" } };
    }
    if (table === "leads" && filters.id) {
      const owner = leadOwner(people, filters.id);
      if (!owner) return { data: null };
      if (filters.assigned_agent && filters.assigned_agent !== owner.id)
        return { data: null };
      return { data: leadRow(filters.id, owner) };
    }
    return { data: null };
  };
  function from(table) {
    const filters = {};
    const chain = new Proxy(
      {},
      {
        get(_target, method) {
          if (method === "then")
            return (ok, fail) =>
              respond({
                data: list(table, filters),
                count: table === "leads" ? 240 : 0,
                error: null,
              }).then(ok, fail);
          if (method === "single" || method === "maybeSingle")
            return () => respond(one(table, filters));
          if (method === "eq")
            return (column, value) => ((filters[column] = value), chain);
          return () => chain;
        },
      },
    );
    return chain;
  }
  const rpcs = {
    mfa_session_state: () => ({ reset_pending: false, reset_after: null }),
    lead_contact_phones: (a) => ({
      phones: Object.fromEntries(a.p_leads.map((id) => [id, null])),
    }),
    crm_mutate: (a) => ({ id: a.p_id || randomUUID(), ...a.p_data }),
    log_manual_call: () => ({ id: randomUUID() }),
    dashboard_snapshot: () => ({
      metrics: { leads: 40 },
      leaders: [],
      followups: [],
      visits: [],
      targets: [],
    }),
    notifications_page: () => ({ data: [], unread: 0 }),
    meta_summary: () => ({ notifications: [] }),
    security_alerts_summary: () => ({ unreviewed: 0 }),
    system_status: () => ({ ready: true, jobs: [] }),
    call_activity: () => ({ agents: [], is_workday: true }),
    first_call_queue: () => [],
    targets_page: () => ({ data: [], count: 0 }),
    lead_review_page: () => ({ data: [], count: 0 }),
    assign_lead: (a) => a.p_agent,
    assign_leads_bulk: (a) => ({
      assigned: a.p_lead_ids.length,
      skipped: 0,
      failed: 0,
    }),
    import_leads: (a) => ({
      import_id: randomUUID(),
      imported: a.p_rows?.length ?? 0,
    }),
    crm_metrics: () => ({ leads: 40, won: 2 }),
    crm_leaderboard: () => [],
    report_sources: () => [],
    report_agents: () => [],
    authorize_knowledge_download: () => ({
      storage_path: "kyc/cnic.pdf",
      mime_type: "application/pdf",
      file_name: "cnic.pdf",
    }),
    mfa_begin_attempt: () => ({ allowed: true, attempt_id: randomUUID() }),
    login_attempt_status: () => ({ locked: false }),
    record_login_attempt: (a) => ({
      outcome: a.p_success ? "success" : "failed",
    }),
  };
  const user = (p) => ({
    id: p.id,
    email: p.email,
    email_confirmed_at: "2026-10-01T00:00:00Z",
    factors: [],
  });
  return {
    auth: {
      getUser: (token) => {
        const p = byToken.get(token);
        return respond(
          p
            ? { data: { user: user(p) } }
            : { data: { user: null }, error: { status: 401 } },
        );
      },
      getClaims: (token) =>
        respond({
          data: { claims: { sub: byToken.get(token)?.id, aal: "aal1" } },
        }),
      admin: { signOut: () => respond({ error: null }) },
    },
    from,
    rpc: (name, args) => respond({ data: (rpcs[name] || (() => ({})))(args) }),
    storage: {
      from: () => ({
        download: () =>
          respond({ data: new Blob(["%PDF-1.4 simulated KYC file"]) }),
      }),
    },
    // Server sign-in client (options.createSignInClient).
    signIn: () => ({
      auth: {
        signInWithPassword: ({ email, password }) => {
          const p = byEmail.get(email);
          return respond(
            p && p.password === password
              ? {
                  data: {
                    session: {
                      access_token: p.token,
                      refresh_token: "refresh-" + p.id,
                      expires_in: 3600,
                      expires_at: 1,
                      token_type: "bearer",
                      user: { id: p.id, email },
                    },
                  },
                }
              : { data: { session: null }, error: { status: 400 } },
          );
        },
      },
    }),
  };
}

// A month of reports and dashboards (Pakistan time).
export const range = new URLSearchParams({
  from: "2026-09-30T19:00:00.000Z",
  to: "2026-10-31T19:00:00.000Z",
}).toString();
