import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  beforeEach,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { createHmac, randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { processMetaLeads } from "../src/jobs/processMetaLeads.js";
import { encryptToken, decryptToken } from "../src/services/meta/crypto.js";
import { metaConfig } from "../src/services/meta/config.js";
import { graphClient } from "../src/services/meta/graph.js";
import { normalizeSubmission } from "../src/services/meta/normalize.js";
import { requiredMetaPermissions } from "../src/routes/meta.routes.js";
import { digest } from "../src/services/accountsSecurity.js";
import {
  sensitiveLimit,
  apiLimit,
  metaWebhookLimit,
} from "../src/middleware/rateLimit.js";
const admin = "d1000000-0000-4000-8000-000000000001",
  agent = "d1000000-0000-4000-8000-000000000002",
  other = "d1000000-0000-4000-8000-000000000003";
const prefix = "/api/integrations/meta",
  key = "a1".repeat(32),
  secret = "test-app-secret",
  page = "101",
  form = "201";
let pg, db, app, metaFetch, connection;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const rpc = async (name, args = {}) =>
  (
    await one(
      `select to_jsonb(public.${name}(${Object.keys(args)
        .map((k, i) => `${k}=>$${i + 1}`)
        .join(",")})) value`,
      Object.entries(args).map(([k, v]) =>
        k === "p_leads"
          ? "{" + v.join(",") + "}"
          : v !== null && typeof v === "object"
            ? JSON.stringify(v)
            : v,
      ),
    )
  ).value;
const auth = (id = admin) => ({ Authorization: "Bearer " + id });
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
function database() {
  return {
    auth: {
      getUser: async (id) => ({
        data: {
          user: await one(
            "select id,email,email_confirmed_at from auth.users where id::text=$1",
            [id],
          ),
        },
      }),
    },
    rpc: vi.fn(async (name, args) => {
      try {
        return { data: await rpc(name, args) };
      } catch (e) {
        return { error: { code: e.code, message: e.message } };
      }
    }),
    from(table) {
      let fields = "*",
        filters = [];
      const run = async () => ({
        data: (
          await pg.query(
            `select ${fields} from public.${table}${filters.length ? " where " + filters.map(([k], i) => `${k}=$${i + 1}`).join(" and ") : ""}`,
            filters.map(([, v]) => v),
          )
        ).rows,
      });
      const q = {
        select(f) {
          fields = f;
          return q;
        },
        eq(k, v) {
          filters.push([k, v]);
          return q;
        },
        order() {
          return q;
        },
        async single() {
          return { data: (await run()).data[0] };
        },
        async maybeSingle() {
          return { data: (await run()).data[0] || null };
        },
        then(resolve, reject) {
          return run().then(resolve, reject);
        },
      };
      return q;
    },
  };
}
const event = (id = "301", extra = {}) => ({
  object: "page",
  entry: [
    {
      id: page,
      changes: [
        {
          field: "leadgen",
          value: { leadgen_id: id, form_id: form, page_id: page, ...extra },
        },
      ],
    },
  ],
});
const send = (payload = event(), sig) => {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return request(app)
    .post(prefix + "/webhook")
    .set("Content-Type", "application/json")
    .set(
      "X-Hub-Signature-256",
      sig ||
        "sha256=" + createHmac("sha256", secret).update(body).digest("hex"),
    )
    .send(body);
};
const lead = (id = "301", phone = "03001234567", platform = "fb") => ({
  id,
  form_id: form,
  platform,
  created_time: "2026-10-14T07:00:00+0000",
  campaign_id: "401",
  campaign_name: "Autumn",
  ad_id: "501",
  field_data: [
    { name: "full_name", values: ["Buyer One"] },
    ...(phone ? [{ name: "phone_number", values: [phone] }] : []),
    { name: "city", values: ["Lahore"] },
  ],
});
async function ingest(id = "301", phone = "03001234567", platform = "fb") {
  await send(event(id));
  metaFetch.mockResolvedValue(json(lead(id, phone, platform)));
  await processMetaLeads(db, { metaFetch });
  return one("select * from meta_submissions where provider_lead_id=$1", [id]);
}
async function call(name, args = {}) {
  return rpc(name, { p_actor: admin, ...args });
}
async function config(kind, id, enabled = true, mapping = {}) {
  return call("meta_configure", {
    p_kind: kind,
    p_id: id,
    p_enabled: enabled,
    p_mapping: mapping,
    p_request: "fixture",
  });
}
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(f, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
}, 30000);
afterAll(async () => pg?.close());
afterEach(() => vi.unstubAllEnvs());
beforeEach(async () => {
  for (const limiter of [sensitiveLimit, apiLimit, metaWebhookLimit])
    for (const ip of ["127.0.0.1", "::ffff:127.0.0.1"]) limiter.resetKey(ip);
  await pg.exec("truncate auth.users,public.integration_events cascade;");
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.test',now()),($2,'agent@example.test',now()),($3,'other@example.test',now())",
    [admin, agent, other],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end,name=case when id=$1 then 'Admin' else 'Agent' end",
    [admin],
  );
  for (const [k, v] of Object.entries({
    META_APP_ID: "123",
    META_APP_SECRET: secret,
    META_LOGIN_CONFIG_ID: "456",
    META_GRAPH_VERSION: "v25.0",
    META_OAUTH_REDIRECT_URL:
      "https://crm.example.test/api/integrations/meta/callback",
    META_WEBHOOK_VERIFY_TOKEN: "fixture-verify",
    META_TOKEN_ENCRYPTION_KEY: key,
    META_ANSWER_RETENTION_DAYS: "30",
    FRONTEND_URL: "https://crm.example.test",
  }))
    vi.stubEnv(k, v);
  connection = await call("meta_save_connection", {
    p_data: {
      user_id: "999",
      scopes: requiredMetaPermissions,
      ciphertext: encryptToken("fixture-user-token", key, "user:999"),
      pages: [
        {
          id: page,
          name: "Sales Page",
          ciphertext: encryptToken("fixture-page-token", key, "page:" + page),
        },
      ],
    },
    p_request: "fixture",
  });
  await call("meta_save_forms", {
    p_page: page,
    p_forms: [{ id: form, name: "Property enquiries", questions: [] }],
    p_request: "fixture",
  });
  await config("page", page);
  await config("form", form);
  db = database();
  metaFetch = vi.fn();
  app = createApp(trustedMfaFixture(db), { metaFetch });
});
describe("Meta signed durable webhook", () => {
  it("verifies only the correct challenge and handles query arrays safely", async () => {
    expect(
      (
        await request(app)
          .get(prefix + "/webhook")
          .query({
            "hub.mode": "subscribe",
            "hub.verify_token": "fixture-verify",
            "hub.challenge": "1234",
          })
      ).text,
    ).toBe("1234");
    expect(
      (
        await request(app)
          .get(prefix + "/webhook")
          .query({
            "hub.mode": "subscribe",
            "hub.verify_token": "wrong",
            "hub.challenge": "1234",
          })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app).get(
          prefix +
            "/webhook?hub.mode=subscribe&hub.verify_token[]=fixture-verify&hub.challenge=1",
        )
      ).status,
    ).toBe(403);
  });
  it("persists before acknowledgement, deduplicates replays and survives a new worker instance", async () => {
    expect((await send()).body.queued).toBe(1);
    expect(metaFetch).not.toHaveBeenCalled();
    expect((await send()).body.queued).toBe(0);
    expect((await one("select count(*)::int n from meta_submissions")).n).toBe(
      1,
    );
    metaFetch.mockResolvedValue(json(lead()));
    await processMetaLeads(database(), { metaFetch });
    expect((await one("select status from meta_submissions")).status).toBe(
      "created",
    );
  });
  it("rejects absent, malformed or tampered signatures", async () => {
    for (const sig of [
      "sha256=bad",
      "sha256=" + "0".repeat(64),
      "md5=" + "0".repeat(64),
    ])
      expect((await send(event(), sig)).status).toBe(401);
    const signature =
      "sha256=" +
      createHmac("sha256", secret)
        .update(JSON.stringify(event()))
        .digest("hex");
    expect((await send(event("302"), signature)).status).toBe(401);
    expect((await one("select count(*)::int n from meta_submissions")).n).toBe(
      0,
    );
  });
  it("rejects malformed signed JSON, foreign page identities and impossible timestamps", async () => {
    expect((await send("{")).status).toBe(400);
    expect((await send(event("301", { page_id: "999" }))).status).toBe(400);
    expect((await send(event("301", { created_time: 1e20 }))).status).toBe(400);
  });
  it("ignores unselected forms or paused Pages without fetching customer data", async () => {
    await config("form", form, false);
    expect((await send()).body.queued).toBe(0);
    await config("form", form);
    await config("page", page, false);
    expect((await send()).body.queued).toBe(0);
    expect(metaFetch).not.toHaveBeenCalled();
  });
  it("returns an error rather than a queued success on database failure", async () => {
    db.rpc.mockImplementation(async () => ({
      error: { code: "08006", message: "private database details" },
    }));
    const r = await send();
    expect(r.status).toBe(503);
    expect(r.body).not.toHaveProperty("received");
    expect(JSON.stringify(r.body)).not.toContain("private database details");
  });
});
describe("Meta lead validation, customer identity and private access", () => {
  it.each(["fb", "ig", null])(
    "creates an unassigned %s lead with truthful attribution",
    async (platform) => {
      const s = await ingest("301", "03001234567", platform);
      expect(s.status).toBe("created");
      expect(s.platform).toBe(
        platform === "ig"
          ? "instagram"
          : platform === "fb"
            ? "facebook"
            : "meta",
      );
      const l = await one("select * from leads where id=$1", [s.lead_id]);
      expect(l).toMatchObject({
        assigned_agent: null,
        meta_pending_assignment: true,
        source: "Meta",
        name: "Buyer One",
      });
      expect(s.campaign_name).toBe("Autumn");
      expect(
        (await one("select phone from crm_private.lead_phones")).phone,
      ).toBe("+923001234567");
      const r = await request(app)
        .get(prefix + "/inbox")
        .set(auth());
      expect(r.status).toBe(200);
      expect(r.body.data[0].phone).toBe("+923001234567");
      expect(
        (
          await one(
            "select count(*)::int n from audit_log where action='lead.phone_revealed'",
          )
        ).n,
      ).toBeGreaterThan(0);
    },
  );
  it.each(["", "not-a-phone"])(
    "keeps missing/invalid phone %s in review and permits admin correction",
    async (phone) => {
      const s = await ingest("301", phone);
      expect(s.status).toBe("review");
      expect(s.lead_id).toBeNull();
      expect((await one("select count(*)::int n from leads")).n).toBe(0);
      const r = await request(app)
        .post(prefix + "/submissions/" + s.id + "/resolve")
        .set(auth())
        .send({ name: "Confirmed Buyer", phone: "03001234567" });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("created");
      expect(
        await one(
          "select meta_pending_assignment,assigned_agent,preferred_location from leads",
        ),
      ).toEqual({
        meta_pending_assignment: true,
        assigned_agent: null,
        preferred_location: "Lahore",
      });
    },
  );
  it("reviews a missing name; invalid optional email/budget do not invent a customer", async () => {
    await send();
    const data = lead();
    data.field_data = data.field_data.filter((f) => f.name !== "full_name");
    metaFetch.mockResolvedValue(json(data));
    await processMetaLeads(db, { metaFetch });
    expect((await one("select status from meta_submissions")).status).toBe(
      "review",
    );
    const n = normalizeSubmission({
      ...lead(),
      field_data: [
        ...lead().field_data,
        { name: "email", values: ["wrong"] },
        { name: "budget_min", values: ["unknown"] },
      ],
    });
    expect(n.reason).toBeNull();
    expect(n.data.email).toBeUndefined();
    expect(n.data.budget_min).toBe(0);
    expect(n.answers).toHaveLength(5);
  });
  it("maps custom questions and preserves unmapped answers privately", async () => {
    await config("form", form, true, {
      customer_label: "name",
      mobile_contact: "phone",
    });
    await send();
    metaFetch.mockResolvedValue(
      json({
        ...lead(),
        field_data: [
          { name: "customer_label", values: ["Custom Buyer"] },
          { name: "mobile_contact", values: ["00923001234567"] },
          { name: "custom_notes", values: ["private answer"] },
        ],
      }),
    );
    await processMetaLeads(db, { metaFetch });
    expect((await one("select name from leads")).name).toBe("Custom Buyer");
    expect(
      (await one("select answers from crm_private.meta_answers")).answers[2]
        .values,
    ).toEqual(["private answer"]);
    expect(
      JSON.stringify(
        (
          await request(app)
            .get(prefix + "/settings")
            .set(auth())
        ).body,
      ),
    ).not.toContain("private answer");
  });
  it("matches normalized phones without changing existing owner, stage or notes", async () => {
    const l = await call("create_lead", {
      p_data: { name: "Existing buyer", assigned_agent: agent },
      p_phone: "+923001234567",
      p_request: "fixture",
    });
    await pg.query("update leads set status='contacted' where id=$1", [l.id]);
    await pg.query(
      "insert into notes(lead_id,agent_id,body) values($1,$2,'Existing note')",
      [l.id, agent],
    );
    for (const [id, phone] of [
      ["301", "03001234567"],
      ["302", "00923001234567"],
    ]) {
      const s = await ingest(id, phone);
      expect(s.status).toBe("duplicate");
      expect(s.lead_id).toBe(l.id);
    }
    expect((await one("select count(*)::int n from leads")).n).toBe(1);
    expect(
      await one(
        "select name,status,assigned_agent,meta_pending_assignment from leads",
      ),
    ).toEqual({
      name: "Existing buyer",
      status: "contacted",
      assigned_agent: agent,
      meta_pending_assignment: false,
    });
    expect((await one("select body from notes")).body).toBe("Existing note");
    expect((await call("meta_summary")).duplicates).toBe(2);
  });
  it("blocks every admin integration route for agents and forged actor fields", async () => {
    const s = await ingest();
    for (const endpoint of [
      "/settings",
      "/summary",
      "/inbox",
      "/submissions/" + s.id,
    ])
      expect(
        (
          await request(app)
            .get(prefix + endpoint)
            .set(auth(agent))
        ).status,
      ).toBe(403);
    expect(
      (
        await request(app)
          .post(prefix + "/assign")
          .set(auth(agent))
          .send({ lead_ids: [s.lead_id], agent_id: agent })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(prefix + "/assign")
          .set(auth())
          .send({ lead_ids: [s.lead_id], agent_id: agent, p_actor: admin })
      ).status,
    ).toBe(400);
    await expect(
      rpc("lead_contact_phones", {
        p_actor: agent,
        p_leads: [s.lead_id],
        p_request: "fixture",
      }),
    ).rejects.toMatchObject({ code: "P0002" });
  });
  it("denies direct browser reads and all new privileged functions", async () => {
    await pg.exec("begin;set local role authenticated;");
    try {
      await expect(
        pg.query("select * from public.meta_submissions"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.exec("rollback");
    }
    const rows = (
      await pg.query(
        "select proname,has_function_privilege('authenticated',oid,'execute') allowed from pg_proc where pronamespace='public'::regnamespace and proname like 'meta_%'",
      )
    ).rows;
    expect(rows.length).toBeGreaterThan(15);
    expect(rows.every((r) => !r.allowed)).toBe(true);
  });
  it("does not reveal encrypted credentials, raw answers or state through settings", async () => {
    await ingest();
    const settings = (
      await request(app)
        .get(prefix + "/settings")
        .set(auth())
    ).body;
    const text = JSON.stringify(settings);
    for (const value of [
      key,
      secret,
      "fixture-page-token",
      "fixture-user-token",
      "ciphertext",
      "meta_oauth_states",
      "field_data",
    ])
      expect(text).not.toContain(value);
  });
  it("audits contact access and limits contact visibility to the current owner", async () => {
    const s = await ingest();
    await call("meta_assign", {
      p_leads: [s.lead_id],
      p_agent: agent,
      p_request: "fixture",
    });
    const contact = await rpc("lead_contact_phones", {
      p_actor: agent,
      p_leads: [s.lead_id],
      p_request: "agent:view",
    });
    expect(contact.phones[s.lead_id]).toBe("+923001234567");
    await expect(
      rpc("lead_contact_phones", {
        p_actor: other,
        p_leads: [s.lead_id],
        p_request: "other:view",
      }),
    ).rejects.toMatchObject({ code: "P0002" });
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where request_id='agent:view'",
        )
      ).n,
    ).toBeGreaterThan(0);
  });
});
describe("Meta explicit assignment and reports", () => {
  it("assigns explicitly once and records existing assignment history", async () => {
    const s = await ingest();
    const r = await request(app)
      .post(prefix + "/assign")
      .set(auth())
      .send({ lead_ids: [s.lead_id], agent_id: agent });
    expect(r.status).toBe(200);
    expect(r.body.assigned).toBe(1);
    expect(
      await one("select assigned_agent,meta_pending_assignment from leads"),
    ).toEqual({ assigned_agent: agent, meta_pending_assignment: false });
    expect((await one("select count(*)::int n from assignments")).n).toBe(1);
    expect(
      (await one("select first_assigned_at from meta_submissions"))
        .first_assigned_at,
    ).toBeTruthy();
    expect(
      (
        await request(app)
          .post(prefix + "/assign")
          .set(auth())
          .send({ lead_ids: [s.lead_id], agent_id: other })
      ).status,
    ).toBe(409);
    expect((await one("select assigned_agent from leads")).assigned_agent).toBe(
      agent,
    );
  });
  it("rolls back an entire mixed bulk request and rejects inactive/non-agent recipients", async () => {
    const a = await ingest(),
      b = await ingest("302", "03007654321");
    await call("meta_assign", {
      p_leads: [a.lead_id],
      p_agent: agent,
      p_request: "fixture",
    });
    expect(
      (
        await request(app)
          .post(prefix + "/assign")
          .set(auth())
          .send({ lead_ids: [a.lead_id, b.lead_id], agent_id: other })
      ).status,
    ).toBe(409);
    expect(
      (await one("select assigned_agent from leads where id=$1", [b.lead_id]))
        .assigned_agent,
    ).toBeNull();
    await pg.query("update profiles set active=false where id=$1", [other]);
    for (const id of [other, admin])
      expect(
        (
          await request(app)
            .post(prefix + "/assign")
            .set(auth())
            .send({ lead_ids: [b.lead_id], agent_id: id })
        ).status,
      ).toBe(400);
  });
  it("assigns multiple pending customers atomically and resolves competing administrator requests", async () => {
    const a = await ingest(),
      b = await ingest("302", "03007654321");
    const results = await Promise.all(
      [agent, other].map((agent_id) =>
        request(app)
          .post(prefix + "/assign")
          .set(auth())
          .send({ lead_ids: [a.lead_id, b.lead_id], agent_id }),
      ),
    );
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await one("select count(*)::int n from assignments")).n).toBe(2);
    expect(
      (await one("select count(distinct assigned_agent)::int n from leads")).n,
    ).toBe(1);
  });
  it("excludes pending leads from round-robin, direct updates and stale jobs but preserves manual lead behavior", async () => {
    const s = await ingest();
    const manual = await call("create_lead", {
      p_data: { name: "Manual customer" },
      p_phone: "+923009999999",
      p_request: "fixture",
    });
    await pg.query(
      "update leads set last_activity_at=now()-interval '30 days'",
    );
    await expect(
      call("assign_lead", {
        p_lead: s.lead_id,
        p_agent: null,
        p_request: "fixture",
      }),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      pg.query("update leads set assigned_agent=$1 where id=$2", [
        agent,
        s.lead_id,
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    // Update 038: the stale job never assigns; both leads wait for an admin.
    await rpc("run_crm_job", { p_job: "stale", p_settings: { stale_days: 7 } });
    expect(
      (await one("select assigned_agent from leads where id=$1", [s.lead_id]))
        .assigned_agent,
    ).toBeNull();
    expect(
      (await one("select assigned_agent from leads where id=$1", [manual.id]))
        .assigned_agent,
    ).toBeNull();
    await call("assign_lead", {
      p_lead: s.lead_id,
      p_agent: agent,
      p_request: "explicit",
    });
    await call("assign_lead", {
      p_lead: s.lead_id,
      p_agent: other,
      p_request: "later-reassignment",
    });
    expect(
      (await one("select assigned_agent from leads where id=$1", [s.lead_id]))
        .assigned_agent,
    ).toBe(other);
  });
  it("filters and paginates before counting and keeps provider replays out of notifications", async () => {
    await ingest();
    await ingest("302", "03007654321", "ig");
    await send();
    const summary = await call("meta_summary");
    expect(summary).toMatchObject({
      total: 2,
      unassigned: 2,
      facebook: 1,
      instagram: 1,
    });
    expect(summary.notifications).toHaveLength(2);
    const q = await request(app)
      .get(prefix + "/inbox?platform=instagram&limit=1")
      .set(auth());
    expect(q.body.count).toBe(1);
    expect(q.body.data[0].provider_lead_id).toBe("302");
    const searched = await request(app)
      .get(prefix + "/inbox?search=Autumn&page=2&limit=1")
      .set(auth());
    expect(searched.body.count).toBe(2);
    expect(searched.body.data).toHaveLength(1);
    await call("meta_read_notice", { p_id: summary.notifications[0].id });
    await call("meta_read_notice", { p_id: summary.notifications[0].id });
    expect((await call("meta_summary")).notifications).toHaveLength(1);
  });
  it("distinguishes submissions and unique customers in campaign reporting", async () => {
    await ingest();
    await ingest("302", "00923001234567", "ig");
    const report = await call("meta_report", {
      p_from: "2020-01-01T00:00:00Z",
      p_to: "2020-02-01T00:00:00Z",
    });
    expect(report).toMatchObject({
      submissions: 0,
      unique_customers: 0,
      revenue: 0,
    });
    const now = Date.now();
    const actual = await call("meta_report", {
      p_from: new Date(now - 86400000).toISOString(),
      p_to: new Date(now + 86400000).toISOString(),
    });
    expect(actual).toMatchObject({
      submissions: 2,
      unique_customers: 1,
      unassigned: 1,
      revenue: 0,
    });
    expect(actual.groups).toHaveLength(2);
  });
});
describe("Meta retries, credentials and OAuth", () => {
  it("uses fenced leases; a stale worker cannot finish a newer attempt", async () => {
    await send();
    const [first] = await rpc("meta_claim", { p_limit: 1 });
    expect(await rpc("meta_claim", { p_limit: 1 })).toEqual([]);
    await pg.query(
      "update meta_submissions set lease_until=now()-interval '1 second'",
    );
    const [second] = await rpc("meta_claim", { p_limit: 1 });
    expect(second.lease_id).not.toBe(first.lease_id);
    const normalized = normalizeSubmission(lead());
    await expect(
      rpc("meta_finish", {
        p_id: first.id,
        p_lease: first.lease_id,
        p_data: normalized.data,
        p_answers: normalized.answers,
        p_attribution: normalized.attribution,
        p_reason: null,
        p_retention: 30,
      }),
    ).rejects.toMatchObject({ code: "40001" });
    expect((await one("select count(*)::int n from leads")).n).toBe(0);
  });
  it("backs off rate limits and retries successfully without duplicate creation", async () => {
    await send();
    metaFetch.mockResolvedValue(
      json({ error: { code: 4, message: "sensitive provider text" } }, 429),
    );
    await processMetaLeads(db, { metaFetch });
    expect(await one("select status,error_code from meta_submissions")).toEqual(
      { status: "retry", error_code: "rate_limited" },
    );
    expect(await rpc("meta_claim", { p_limit: 10 })).toEqual([]);
    await pg.query("update meta_submissions set next_attempt_at=now()");
    metaFetch.mockResolvedValue(json(lead()));
    await processMetaLeads(db, { metaFetch });
    expect(await one("select status,attempts from meta_submissions")).toEqual({
      status: "created",
      attempts: 2,
    });
    expect((await one("select count(*)::int n from leads")).n).toBe(1);
  });
  it.each([
    [190, "authorization_expired"],
    [200, "permission_denied"],
  ])(
    "shows token/permission failure %s and requires reconnect",
    async (code, label) => {
      await send();
      metaFetch.mockResolvedValue(
        json({ error: { code, message: "token-secret-private" } }, 400),
      );
      await processMetaLeads(db, { metaFetch });
      expect(
        await one("select status,error_code from meta_connections"),
      ).toEqual({ status: "attention", error_code: label });
      expect((await one("select status from meta_submissions")).status).toBe(
        "failed",
      );
      expect(JSON.stringify(await call("meta_settings"))).not.toContain(
        "token-secret-private",
      );
    },
  );
  it("rejects mismatched provider identities and cleans private answers after expiry", async () => {
    await send();
    metaFetch.mockResolvedValue(json(lead("999")));
    await processMetaLeads(db, { metaFetch });
    expect(
      (await one("select error_code from meta_submissions")).error_code,
    ).toBe("identity_mismatch");
    await call("meta_retry", {
      p_id: (await one("select id from meta_submissions")).id,
      p_request: "retry",
    });
    metaFetch.mockResolvedValue(json(lead()));
    await processMetaLeads(db, { metaFetch });
    await pg.query(
      "update crm_private.meta_answers set expires_at=now()-interval '1 second'",
    );
    vi.stubEnv("META_APP_ID", "");
    await processMetaLeads(db, { metaFetch });
    expect(
      (await one("select count(*)::int n from crm_private.meta_answers")).n,
    ).toBe(0);
    expect((await one("select count(*)::int n from leads")).n).toBe(1);
  });
  it("makes the final crashed attempt visible as failed and rejects invalid retention before claiming", async () => {
    await send();
    vi.stubEnv("META_ANSWER_RETENTION_DAYS", "999");
    await expect(processMetaLeads(db, { metaFetch })).rejects.toThrow(
      "retention",
    );
    expect((await one("select attempts from meta_submissions")).attempts).toBe(
      0,
    );
    await pg.query(
      "update meta_submissions set status='processing',attempts=10,lease_until=now()-interval '1 second'",
    );
    await rpc("meta_cleanup");
    expect(await one("select status,error_code from meta_submissions")).toEqual(
      { status: "failed", error_code: "attempt_limit" },
    );
  });
  it("stops processing and removes credentials on disconnect", async () => {
    await send();
    await call("meta_disconnect", { p_id: connection, p_request: "fixture" });
    expect(await rpc("meta_claim", { p_limit: 10 })).toEqual([]);
    expect(
      (
        await one(
          "select count(*)::int n from crm_private.meta_page_credentials",
        )
      ).n,
    ).toBe(0);
    expect((await send(event("302"))).body.queued).toBe(0);
  });
  it("encrypts with authenticated context, randomness and tamper rejection", () => {
    const a = encryptToken("secret-token", key, "page:101"),
      b = encryptToken("secret-token", key, "page:101");
    expect(a).not.toBe(b);
    expect(a).not.toContain("secret-token");
    expect(decryptToken(a, key, "page:101")).toBe("secret-token");
    expect(() => decryptToken(a, key, "page:102")).toThrow("credentials");
    expect(() =>
      decryptToken(a.slice(0, -4) + "0000", key, "page:101"),
    ).toThrow("credentials");
  });
  it("bounds pagination and does not follow attacker-controlled next URLs", async () => {
    const fetcher = vi.fn(async () =>
      json({
        data: [{ id: "1" }],
        paging: {
          next: "https://evil.example/private",
          cursors: { after: "safe-cursor" },
        },
      }),
    );
    const result = await graphClient(metaConfig(), fetcher).list(
      "101/leads",
      "private-token",
      {},
      2,
    );
    expect(result.truncated).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetcher.mock.calls) {
      expect(url.origin).toBe("https://graph.facebook.com");
      expect(url.href).not.toContain("private-token");
      expect(options.headers.Authorization).toBe("Bearer private-token");
      expect(options.redirect).toBe("error");
    }
  });
  it("rejects oversized Graph responses without provider error leakage", async () => {
    const fetcher = vi.fn(
      async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
    );
    await expect(
      graphClient(metaConfig(), fetcher).request("301", "token"),
    ).rejects.toMatchObject({ code: "response_too_large", retry: false });
  });
  it("binds OAuth state to one secure browser cookie and prevents replay", async () => {
    const r = await request(app)
      .post(prefix + "/connect")
      .set(auth())
      .send({});
    expect(r.status).toBe(200);
    expect(r.headers["set-cookie"][0]).toContain("HttpOnly");
    expect(r.headers["set-cookie"][0]).toContain("Secure");
    const url = new URL(r.body.url),
      state = url.searchParams.get("state"),
      cookie = r.headers["set-cookie"][0].split(";")[0].split("=")[1];
    await expect(
      rpc("meta_oauth_consume", {
        p_state: digest(state),
        p_cookie: digest("wrong"),
      }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      await rpc("meta_oauth_consume", {
        p_state: digest(state),
        p_cookie: digest(cookie),
      }),
    ).toBe(admin);
    await expect(
      rpc("meta_oauth_consume", {
        p_state: digest(state),
        p_cookie: digest(cookie),
      }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(url.searchParams.get("config_id")).toBe("456");
    expect(url.href).not.toContain(secret);
  });
  it("performs server-only code exchange, verifies permissions and reconnects without auto-enabling Pages", async () => {
    const r = await request(app)
        .post(prefix + "/connect")
        .set(auth())
        .send({}),
      url = new URL(r.body.url);
    metaFetch.mockImplementation(async (url, options) => {
      if (url.pathname.endsWith("/oauth/access_token")) {
        expect(options.method).toBe("POST");
        return json({ access_token: "fixture-user-token" });
      }
      if (url.pathname.endsWith("/debug_token"))
        return json({
          data: {
            is_valid: true,
            app_id: "123",
            user_id: "999",
            scopes: requiredMetaPermissions,
          },
        });
      if (url.pathname.endsWith("/me/accounts"))
        return json({
          data: [
            { id: page, name: "Sales Page", access_token: "fresh-page-token" },
          ],
        });
      return json({
        instagram_business_account: { id: "888", username: "property.sales" },
      });
    });
    const callback = await request(app)
      .get(prefix + "/callback")
      .query({ state: url.searchParams.get("state"), code: "fixture-code" })
      .set("Cookie", r.headers["set-cookie"][0].split(";")[0]);
    expect(callback.status).toBe(303);
    expect(callback.headers.location).toBe(
      "https://crm.example.test/integrations/meta?connection=saved",
    );
    expect(await one("select enabled,instagram_name from meta_pages")).toEqual({
      enabled: false,
      instagram_name: "property.sales",
    });
    expect(
      decryptToken(
        (await one("select ciphertext from crm_private.meta_page_credentials"))
          .ciphertext,
        key,
        "page:101",
      ),
    ).toBe("fresh-page-token");
    expect(callback.text).not.toContain("fresh-page-token");
  });
  it("expires OAuth states and rechecks admin activity at callback", async () => {
    await call("meta_oauth_start", {
      p_state: "state",
      p_cookie: "cookie",
      p_request: "fixture",
    });
    await pg.query(
      "update crm_private.meta_oauth_states set expires_at=now()-interval '1 second'",
    );
    await expect(
      rpc("meta_oauth_consume", { p_state: "state", p_cookie: "cookie" }),
    ).rejects.toMatchObject({ code: "42501" });
    await call("meta_oauth_start", {
      p_state: "new-state",
      p_cookie: "cookie",
      p_request: "fixture",
    });
    await pg.query("update profiles set active=false where id=$1", [admin]);
    await expect(
      rpc("meta_oauth_consume", { p_state: "new-state", p_cookie: "cookie" }),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("pauses locally even if Meta cannot remove the remote subscription", async () => {
    metaFetch.mockRejectedValue(new Error("network failure"));
    const r = await request(app)
      .patch(prefix + "/pages/" + page)
      .set(auth())
      .send({ enabled: false });
    expect(r.status).toBe(200);
    expect(r.body.warning).toContain("paused locally");
    expect((await one("select enabled from meta_pages")).enabled).toBe(false);
  });
  it("leaves the CRM available when Meta configuration is absent", async () => {
    vi.stubEnv("META_APP_ID", "");
    expect((await request(app).get("/health")).status).toBe(200);
    const settings = await request(app)
      .get(prefix + "/settings")
      .set(auth());
    expect(settings.status).toBe(200);
    expect(settings.body.configured).toBe(false);
    expect(
      (
        await request(app)
          .post(prefix + "/connect")
          .set(auth())
          .send({})
      ).status,
    ).toBe(503);
    expect(await processMetaLeads(db)).toEqual({ skipped: true });
  });
});
