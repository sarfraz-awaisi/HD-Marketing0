import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { digest } from "../src/services/accountsSecurity.js";
import { reportInactiveLeadOwners } from "../src/jobs/reportInactiveLeadOwners.js";
const admin = "a1000000-0000-4000-8000-000000000001",
  a = "a1000000-0000-4000-8000-000000000002",
  b = "a1000000-0000-4000-8000-000000000003",
  c = "a1000000-0000-4000-8000-000000000004";
const token = "fixture-accounts-unlock";
let pg, leads, property, db, app, legacy;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const rpc = async (name, args = {}) =>
  (
    await one(
      `select to_jsonb(public.${name}(${Object.keys(args)
        .map((k, i) => `${k}=>$${i + 1}`)
        .join(",")})) value`,
      Object.values(args).map((v) =>
        v !== null && typeof v === "object" ? JSON.stringify(v) : v,
      ),
    )
  ).value;
const gate = () => ({
  p_actor: admin,
  p_session: digest("Bearer " + admin),
  p_unlock: digest(token),
});
const headers = (actor = admin, grant = token) => ({
  Authorization: "Bearer " + actor,
  "X-Accounts-Unlock": grant,
});
function database() {
  const objects = new Map();
  const client = {
    objects,
    downloadHook: null,
    auth: {
      getUser: async (id) => ({
        data: {
          user: [admin, a, b, c].includes(id)
            ? { id, email_confirmed_at: "2026-10-01T00:00:00Z" }
            : null,
        },
      }),
      admin: {
        updateUserById: vi.fn(async (id) => ({ data: { user: { id } } })),
      },
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
        filters = [],
        orders = [],
        insert;
      async function run() {
        try {
          if (insert) {
            const keys = Object.keys(insert);
            return {
              data: (
                await pg.query(
                  `insert into public.${table}(${keys.join(",")}) values(${keys.map((_, i) => "$" + (i + 1)).join(",")}) returning *`,
                  keys.map((k) =>
                    typeof insert[k] === "object"
                      ? JSON.stringify(insert[k])
                      : insert[k],
                  ),
                )
              ).rows,
            };
          }
          const rows = JSON.parse(
            JSON.stringify(
              (
                await pg.query(
                  `select ${fields} from public.${table}${filters.length ? " where " + filters.map(([k], i) => `${k}=$${i + 1}`).join(" and ") : ""}${orders.length ? " order by " + orders.join(",") : ""}`,
                  filters.map(([, v]) => v),
                )
              ).rows,
            ),
          );
          return { data: rows, count: rows.length };
        } catch (e) {
          return { error: { code: e.code } };
        }
      }
      const q = {
        select(v = "*") {
          fields = v;
          return q;
        },
        eq(k, v) {
          filters.push([k, v]);
          return q;
        },
        order(k, o) {
          orders.push(k + (o?.ascending === false ? " desc" : " asc"));
          return q;
        },
        insert(v) {
          insert = v;
          return q;
        },
        async single() {
          const r = await run();
          return { ...r, data: r.data?.[0] };
        },
        async maybeSingle() {
          const r = await run();
          return { ...r, data: r.data?.[0] || null };
        },
        async range(lo, hi) {
          const r = await run();
          return { ...r, data: r.data?.slice(lo, hi + 1) };
        },
        then(resolve, reject) {
          return run().then(resolve, reject);
        },
      };
      return q;
    },
    storage: {
      from: () => ({
        download: vi.fn(async (path) => {
          if (client.downloadHook) await client.downloadHook();
          return objects.has(path)
            ? { data: new Blob([objects.get(path)]) }
            : { error: { code: "404" } };
        }),
      }),
    },
  };
  return client;
}
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url),
    files = (await readdir(dir)).sort();
  for (const file of files.filter((f) => f < "022"))
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await pg.query("insert into auth.users(id) values($1)", [admin]);
  await pg.query("update profiles set role='admin' where id=$1", [admin]);
  legacy = await rpc("save_knowledge_document", {
    p_id: null,
    p_data: {
      title: "Legacy identity",
      category: "client_kyc",
      content: "Legacy record",
    },
    p_actor: admin,
    p_request: "fixture:legacy",
  });
  await pg.exec(
    await readFile(
      new URL("022_agent_offboarding_and_kyc_access.sql", dir),
      "utf8",
    ),
  );
  await pg.exec(
    await readFile(new URL("023_admin_account_invitations.sql", dir), "utf8"),
  );
  expect(
    (
      await one("select lead_id from knowledge_documents where id=$1", [
        legacy.id,
      ])
    ).lead_id,
  ).toBeNull();
}, 30000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.exec("truncate auth.users cascade;");
  await pg.query("insert into auth.users(id) values($1),($2),($3),($4)", [
    admin,
    a,
    b,
    c,
  ]);
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end,name=id::text",
    [admin],
  );
  await rpc("save_accounts_pin", {
    p_actor: admin,
    p_hash: "fixture-" + "x".repeat(80),
    p_request: "fixture:pin",
  });
  const version = (
    await one("select version from account_security where admin_id=$1", [admin])
  ).version;
  await rpc("unlock_accounts", {
    p_actor: admin,
    p_session: digest("Bearer " + admin),
    p_version: version,
    p_valid: true,
    p_token: digest(token),
    p_request: "fixture:unlock",
  });
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Fixture property','Fixture',1,'house',5,'marla') returning id",
    )
  ).id;
  leads = [];
  for (let i = 0; i < 4; i++) {
    const lead = await rpc("create_lead", {
      p_data: { name: "Fixture client " + i, assigned_agent: a },
      p_phone: "+92305" + String(i + 1).padStart(7, "0"),
      p_actor: admin,
      p_request: "fixture:lead",
    });
    leads.push(lead);
    await pg.query(
      "update leads set status=$2,lost_reason=case when $2='lost' then 'budget' else null end where id=$1",
      [lead.id, ["new", "contacted", "won", "lost"][i]],
    );
    const f = (
      await one(
        "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '3 hours') returning id",
        [lead.id, a],
      )
    ).id;
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,now(),'completed'),($1,$2,now(),'cancelled')",
      [lead.id, a],
    );
    await pg.query(
      "insert into visits(lead_id,agent_id,property_id,scheduled_at,status) values($1,$2,$3,now()+interval '1 day','scheduled'),($1,$2,$3,now()-interval '1 day','completed'),($1,$2,$3,now(),'cancelled')",
      [lead.id, a, property],
    );
    await pg.query(
      "insert into reminders(agent_id,followup_id,due_at,read_at) values($1,$2,now()+interval '3 hours',null),($1,$2,now()+interval '4 hours',now()),($1,$2,now()-interval '1 hour',null)",
      [a, f],
    );
  }
  // Simulate unchanged, grandfathered rows that were created before migration 022.
  await pg.exec(
    "alter table knowledge_documents disable trigger require_kyc_client;",
  );
  legacy = await one(
    "insert into knowledge_documents(title,category,content,created_by,updated_by) values('Legacy identity','client_kyc','Legacy record',$1,$1) returning *",
    [admin],
  );
  await pg.exec(
    "alter table knowledge_documents enable trigger require_kyc_client;",
  );
  db = database();
  app = createApp(trustedMfaFixture(db));
});
const offboard = (mode = "equal", target = null, extra = {}) =>
  request(app)
    .post(`/api/accounts/${a}/offboard`)
    .set(headers())
    .send({ mode, target, ...extra });
async function document(lead = leads[0].id, category = "client_kyc") {
  return rpc("save_knowledge_document", {
    p_id: null,
    p_data: {
      title: "Identity " + randomUUID(),
      content: "Private verification",
      category,
      ...(lead ? { lead_id: lead } : {}),
    },
    p_actor: admin,
    p_request: randomUUID(),
  });
}
async function attachment(doc) {
  const path = doc.id + "/" + randomUUID();
  await pg.query(
    "insert into knowledge_file_cleanup(document_id,storage_path) values($1,$2)",
    [doc.id, path],
  );
  const file = await rpc("attach_knowledge_file", {
    p_document: doc.id,
    p_data: {
      file_name: "identity.pdf",
      mime_type: "application/pdf",
      size_bytes: 5,
      storage_path: path,
    },
    p_actor: admin,
    p_request: randomUUID(),
  });
  db.objects.set(path, Buffer.from("fixture PDF"));
  return file;
}
const get = (url, actor = a) =>
  request(app)
    .get("/api" + url)
    .set(headers(actor));
describe("PIN-protected atomic agent offboarding", () => {
  it("previews only current counts after the PIN gate", async () => {
    const r = await get(`/accounts/${a}/offboard-preview`, admin);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ leads: 4, followups: 4, visits: 4, reminders: 4 });
    expect(
      (
        await request(app)
          .get(`/api/accounts/${a}/offboard-preview`)
          .set(headers(admin, "wrong"))
      ).status,
    ).toBe(423);
  });
  it.each(["equal", "single", "admin"])(
    "hands over all statuses and pending work with mode %s",
    async (mode) => {
      const r = await offboard(mode, mode === "single" ? b : null);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        leads: 4,
        followups: 4,
        visits: 4,
        reminders: 4,
        mode,
        active: false,
      });
      expect(
        (await one("select active from profiles where id=$1", [a])).active,
      ).toBe(false);
      const rows = (
        await pg.query("select id,assigned_agent from leads order by id")
      ).rows;
      expect(rows.some((l) => l.assigned_agent === a)).toBe(false);
      if (mode === "equal")
        expect(rows.filter((l) => l.assigned_agent === b)).toHaveLength(2);
      for (const row of rows) {
        const owner = mode === "admin" ? admin : row.assigned_agent;
        if (mode === "single") expect(owner).toBe(b);
        if (mode === "admin") expect(row.assigned_agent).toBeNull();
        expect(
          (
            await one(
              "select bool_and(agent_id=$2) ok from followups where lead_id=$1 and status='pending'",
              [row.id, owner],
            )
          ).ok,
        ).toBe(true);
        expect(
          (
            await one(
              "select bool_and(agent_id=$2) ok from visits where lead_id=$1 and status='scheduled'",
              [row.id, owner],
            )
          ).ok,
        ).toBe(true);
        expect(
          (
            await one(
              "select bool_and(m.agent_id=$2) ok from reminders m join followups f on f.id=m.followup_id where f.lead_id=$1 and m.read_at is null and m.due_at>now()",
              [row.id, owner],
            )
          ).ok,
        ).toBe(true);
      }
      expect(
        (
          await one(
            "select bool_and(agent_id=$1) ok from followups where status<>'pending'",
            [a],
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await one(
            "select bool_and(agent_id=$1) ok from visits where status<>'scheduled'",
            [a],
          )
        ).ok,
      ).toBe(true);
      expect(
        (
          await one(
            "select bool_and(agent_id=$1) ok from reminders where read_at is not null or due_at<=now()",
            [a],
          )
        ).ok,
      ).toBe(true);
      const audits = (
        await pg.query(
          "select metadata from audit_log where action='offboard_agent'",
        )
      ).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toEqual({
        leads: 4,
        followups: 4,
        visits: 4,
        reminders: 4,
        mode,
        target: mode === "single" ? b : null,
      });
      expect(JSON.stringify(audits)).not.toContain("Fixture client");
      expect((await get("/me", a)).status).toBe(403);
      const enabled = await request(app)
        .patch(`/api/accounts/${a}`)
        .set(headers())
        .send({ active: true });
      expect(enabled.status).toBe(200);
      expect(
        (
          await one(
            "select count(*)::int n from leads where assigned_agent=$1",
            [a],
          )
        ).n,
      ).toBe(0);
    },
  );
  it("balances against existing open workload without changing general round-robin", async () => {
    for (let i = 0; i < 3; i++)
      await rpc("create_lead", {
        p_data: { name: "Existing workload " + i, assigned_agent: b },
        p_phone: "+92306" + String(i + 1).padStart(7, "0"),
        p_actor: admin,
        p_request: "fixture:workload",
      });
    expect((await offboard()).status).toBe(200);
    expect(
      (
        await one("select count(*)::int n from leads where assigned_agent=$1", [
          c,
        ])
      ).n,
    ).toBe(3);
  });
  it("rolls back the profile, lead assignments and pending work when final audit fails", async () => {
    await pg.exec(
      "create function reject_offboard() returns trigger language plpgsql as $$ begin if new.action='offboard_agent' then raise exception 'Fixture audit failure'; end if; return new;end $$;create trigger reject_offboard before insert on audit_log for each row execute function reject_offboard();",
    );
    const before = (await one("select count(*)::int n from assignments")).n;
    try {
      expect((await offboard("single", b)).status).toBe(503);
      expect(
        (await one("select active from profiles where id=$1", [a])).active,
      ).toBe(true);
      expect(
        (
          await one(
            "select count(*)::int n from leads where assigned_agent=$1",
            [a],
          )
        ).n,
      ).toBe(4);
      expect(
        (await one("select bool_and(agent_id=$1) ok from followups", [a])).ok,
      ).toBe(true);
      expect(
        (await one("select bool_and(agent_id=$1) ok from visits", [a])).ok,
      ).toBe(true);
      expect((await one("select count(*)::int n from assignments")).n).toBe(
        before,
      );
    } finally {
      await pg.exec(
        "drop trigger reject_offboard on audit_log;drop function reject_offboard();",
      );
    }
  });
  it("rejects agents, wrong PIN state, administrator targets, inactive receivers and forged actor fields", async () => {
    expect(
      (
        await request(app)
          .post(`/api/accounts/${a}/offboard`)
          .set(headers(a))
          .send({ mode: "admin" })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .post(`/api/accounts/${a}/offboard`)
          .set(headers(admin, "wrong"))
          .send({ mode: "admin" })
      ).status,
    ).toBe(423);
    expect(
      (
        await request(app)
          .post(`/api/accounts/${admin}/offboard`)
          .set(headers())
          .send({ mode: "admin" })
      ).status,
    ).toBe(404);
    await pg.query("update profiles set active=false where id=$1", [b]);
    expect((await offboard("single", b)).status).toBe(400);
    expect((await offboard("admin", null, { actor: c })).status).toBe(400);
    expect(
      (await one("select active from profiles where id=$1", [a])).active,
    ).toBe(true);
  });
  it("blocks the old disable path for owned leads and saves edit fields atomically in handover", async () => {
    expect(
      (
        await request(app)
          .patch(`/api/accounts/${a}`)
          .set(headers())
          .send({ active: false })
      ).status,
    ).toBe(400);
    const r = await offboard("single", b, {
      changes: { name: "Updated teammate" },
    });
    expect(r.status).toBe(200);
    expect((await one("select name from profiles where id=$1", [a])).name).toBe(
      "Updated teammate",
    );
  });
  it("moves pending work on ordinary reassignment as well as offboarding", async () => {
    await rpc("assign_lead", {
      p_lead: leads[0].id,
      p_actor: admin,
      p_agent: b,
      p_request: "fixture:ordinary",
    });
    expect(
      (
        await one(
          "select agent_id from followups where lead_id=$1 and status='pending'",
          [leads[0].id],
        )
      ).agent_id,
    ).toBe(b);
    expect(
      (
        await one(
          "select agent_id from followups where lead_id=$1 and status='completed'",
          [leads[0].id],
        )
      ).agent_id,
    ).toBe(a);
  });
  it("alerts once per day about directly disabled owners and never auto-moves their work", async () => {
    await pg.query("update profiles set active=false where id=$1", [a]);
    await pg.query(
      "update leads set last_activity_at=now()-interval '20 days'",
    );
    expect((await reportInactiveLeadOwners(db)).data.affected).toBe(1);
    expect((await reportInactiveLeadOwners(db)).data.affected).toBe(0);
    await rpc("run_crm_job", { p_job: "stale", p_settings: { stale_days: 7 } });
    expect(
      (
        await one("select count(*)::int n from leads where assigned_agent=$1", [
          a,
        ])
      ).n,
    ).toBe(4);
    expect(
      (
        await one(
          "select count(*)::int n from security_alerts where type='inactive_agent_leads'",
        )
      ).n,
    ).toBe(1);
  });
});
describe("Current-owner Client KYC permissions", () => {
  it("requires a client for new KYC and preserves existing unlinked entries as admin-only", async () => {
    const bad = await request(app).post("/api/documents").set(headers()).send({
      title: "New identity",
      category: "client_kyc",
      content: "Private",
    });
    expect(bad.status).toBe(400);
    expect((await get(`/documents/${legacy.id}`, admin)).status).toBe(200);
    expect((await get(`/documents/${legacy.id}`)).status).toBe(404);
    const unlinked = await get("/documents?unlinked_kyc=true", admin);
    expect(unlinked.body.count).toBe(1);
    expect((await get("/documents?category=client_kyc")).body.count).toBe(0);
  });
  it("hides other clients' titles, contents, file lists, downloads and counts with 404 for guessed IDs", async () => {
    const doc = await document(),
      file = await attachment(doc);
    for (const url of [
      `/documents/${doc.id}`,
      `/documents/${doc.id}/files`,
      `/documents/${doc.id}/files/${file.id}/download`,
    ])
      expect((await get(url, b)).status).toBe(404);
    for (const url of [
      "/documents?category=client_kyc",
      "/documents?search=" + encodeURIComponent(doc.title),
    ]) {
      const r = await get(url, b);
      expect(r.status).toBe(200);
      expect(r.body.count).toBe(0);
      expect(JSON.stringify(r.body)).not.toContain(doc.title);
    }
    expect((await get("/documents?lead_id=" + leads[0].id, b)).status).toBe(
      404,
    );
  });
  it("moves KYC access to the current owner after reassignment and after offboarding", async () => {
    const doc = await document(),
      file = await attachment(doc),
      url = `/documents/${doc.id}/files/${file.id}/download`;
    expect((await get(url, a)).status).toBe(200);
    await rpc("assign_lead", {
      p_lead: leads[0].id,
      p_actor: admin,
      p_agent: b,
      p_request: "fixture:kyc-move",
    });
    expect((await get(`/documents/${doc.id}`, a)).status).toBe(404);
    expect((await get(url, a)).status).toBe(404);
    expect((await get(url, b)).status).toBe(200);
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where action='download_file'",
        )
      ).n,
    ).toBe(2);
  });
  it("rechecks ownership before sending a file if it changes during Storage retrieval", async () => {
    const doc = await document(),
      file = await attachment(doc);
    db.downloadHook = async () => {
      await rpc("assign_lead", {
        p_lead: leads[0].id,
        p_actor: admin,
        p_agent: b,
        p_request: "fixture:in-flight",
      });
    };
    expect(
      (await get(`/documents/${doc.id}/files/${file.id}/download`, a)).status,
    ).toBe(404);
  });
  it("keeps non-KYC team access and permits admins to link old KYC to clients", async () => {
    const shared = await document(null, "policy");
    expect((await get(`/documents/${shared.id}`, b)).status).toBe(200);
    const linked = await request(app)
      .patch(`/api/documents/${legacy.id}`)
      .set(headers())
      .send({
        title: legacy.title,
        category: "client_kyc",
        content: legacy.content,
        lead_id: leads[0].id,
      });
    expect(linked.status).toBe(200);
    expect((await get(`/documents/${legacy.id}`, a)).body.lead_name).toBe(
      leads[0].name,
    );
    expect((await get(`/documents/${legacy.id}`, b)).status).toBe(404);
  });
  it("searches masked client references without returning vault numbers", async () => {
    const r = await get("/documents/clients?search=Fixture", admin);
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(4);
    expect(r.body[0]).toHaveProperty("masked_phone");
    expect(r.body[0]).not.toHaveProperty("phone");
    expect((await get("/documents/clients", a)).status).toBe(403);
  });
  it("denies browser SQL and RPC access to both security workflows", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const signature of [
        "public.offboard_agent(uuid,text,text,uuid,text,uuid,text,jsonb)",
        "public.read_knowledge_document(uuid,uuid)",
        "public.authorize_knowledge_download(uuid,uuid,uuid,text)",
      ])
        expect(
          (
            await one(
              "select has_function_privilege($1,$2,'execute') allowed",
              [role, signature],
            )
          ).allowed,
        ).toBe(false);
    }
    await expect(
      pg.query("update audit_log set action='tampered'"),
    ).rejects.toThrow();
  });
});
