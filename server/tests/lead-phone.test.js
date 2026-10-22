import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
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
import { maskAgentResponse } from "../src/middleware/phoneProtection.js";
import { phoneRevealLimit } from "../src/services/phoneAccess.js";

const admin = "91000000-0000-4000-8000-000000000001",
  agent = "91000000-0000-4000-8000-000000000002",
  other = "91000000-0000-4000-8000-000000000003";
let pg,
  leads = [];
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const reveal = async (
  index = 0,
  actor = agent,
  limit = 80,
  req = randomUUID(),
) =>
  (
    await one("select reveal_phone($1,$2,$3,$4) value", [
      leads[index].id,
      actor,
      req,
      limit,
    ])
  ).value;
const usage = async (actor = agent, limit = 80) =>
  (await one("select phone_reveal_status($1,$2) value", [actor, limit])).value;
const alerts = async () =>
  (await pg.query("select * from security_alerts order by created_at,id")).rows;
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await pg.query("insert into auth.users(id) values($1),($2),($3)", [
    admin,
    agent,
    other,
  ]);
  await pg.query("update profiles set active=true where id=any($1::uuid[])", [
    [admin, agent, other],
  ]);
  await pg.query(
    "update profiles set role='admin',name='Privacy admin' where id=$1",
    [admin],
  );
  await pg.query("update profiles set name='Privacy agent' where id=$1", [
    agent,
  ]);
  for (let i = 0; i < 85; i++) {
    const phone = "+92305" + String(i + 1).padStart(7, "0");
    const row = (
      await one(
        "select to_jsonb(create_lead($1::jsonb,$2,$3,'privacy:fixture')) value",
        [
          JSON.stringify({
            name: "Privacy customer " + i,
            assigned_agent: agent,
            source: "CSV",
          }),
          phone,
          admin,
        ],
      )
    ).value;
    leads.push({ ...row, phone });
  }
}, 30000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.exec("truncate crm_private.phone_reveals,public.security_alerts;");
  await pg.query("update profiles set active=true where id=any($1::uuid[])", [
    [admin, agent, other],
  ]);
  await pg.query(
    "update leads set assigned_agent=$1 where id=any($2::uuid[])",
    [agent, leads.map((row) => row.id)],
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function database() {
  const client = {
    auth: {
      getUser: async (token) => ({
        data: {
          user: [admin, agent, other].includes(token)
            ? { id: token, email_confirmed_at: "2026-10-01T00:00:00Z" }
            : null,
        },
      }),
    },
    rpc: vi.fn(async (name, args) => {
      try {
        const keys = Object.keys(args);
        return {
          data: (
            await one(
              `select public.${name}(${keys.map((key, i) => `${key}=>$${i + 1}${["p_data", "p_rows"].includes(key) ? "::jsonb" : ""}`).join(",")}) value`,
              keys.map((key) =>
                ["p_data", "p_rows"].includes(key)
                  ? JSON.stringify(args[key])
                  : args[key],
              ),
            )
          ).value,
        };
      } catch (error) {
        return { error: { code: error.code, message: leads[0].phone } };
      }
    }),
    from(table) {
      let fields = "r.*",
        joins = "",
        filters = [],
        orders = [],
        cap = Infinity;
      async function run() {
        try {
          const sql = `select ${fields} from public.${table} r${joins}${filters.length ? " where " + filters.map(([key, op], i) => `${key} ${op} $${i + 1}`).join(" and ") : ""}${orders.length ? " order by " + orders.join(",") : ""}`;
          const rows = JSON.parse(
            JSON.stringify(
              (
                await pg.query(
                  sql,
                  filters.map(([, , value]) => value),
                )
              ).rows,
            ),
          );
          return { data: rows.slice(0, cap), count: rows.length };
        } catch (error) {
          return { error: { code: error.code } };
        }
      }
      const q = {
        select(value = "*") {
          if (value.includes("!inner"))
            joins = " join public.leads l on l.id=r.lead_id";
          else
            fields =
              value === "*"
                ? "r.*"
                : value
                    .split(",")
                    .map((key) => "r." + key)
                    .join(",");
          return q;
        },
        eq(key, value) {
          filters.push([
            key.startsWith("leads.") ? key.replace("leads.", "l.") : "r." + key,
            "=",
            value,
          ]);
          return q;
        },
        is(key, value) {
          filters.push([
            key.startsWith("leads.") ? key.replace("leads.", "l.") : "r." + key,
            "is not distinct from",
            value,
          ]);
          return q;
        },
        ilike(key, value) {
          filters.push(["r." + key, "ilike", value]);
          return q;
        },
        order(key, opts) {
          orders.push(
            "r." + key + (opts?.ascending === false ? " desc" : " asc"),
          );
          return q;
        },
        limit(value) {
          cap = value;
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
        async range(low, high) {
          const r = await run();
          return { ...r, data: r.data?.slice(low, high + 1) };
        },
        then(resolve, reject) {
          return run().then(resolve, reject);
        },
      };
      return q;
    },
  };
  return client;
}
const get = (app, path, actor = agent) =>
  request(app)
    .get(path)
    .set("Authorization", "Bearer " + actor);
const path = (index = 0) => `/api/leads/${leads[index].id}/phone`;

describe("Historical P2 SQL transactions (retained for compatibility)", () => {
  it("audits a successful single read with identifiers/field names and no private values", async () => {
    const req = randomUUID(),
      result = await reveal(0, agent, 80, req);
    expect(result).toMatchObject({
      allowed: true,
      phone: leads[0].phone,
      shown_today: 1,
      limit: 80,
      remaining: 79,
      expires_in_seconds: 120,
      unlimited: false,
    });
    const rows = (
      await pg.query("select * from audit_log where request_id=$1", [req])
    ).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "lead.phone_revealed",
      entity_id: leads[0].id,
      actor_id: agent,
    });
    expect(JSON.stringify(rows)).not.toContain(leads[0].phone);
    expect(
      (
        await one(
          "select count(*)::int n from crm_private.phone_reveals where user_id=$1",
          [agent],
        )
      ).n,
    ).toBe(1);
  });
  it("refuses the 81st distinct lead, persists one critical alert and allows repeats of prior leads", async () => {
    for (let i = 0; i < 80; i++) expect((await reveal(i)).allowed).toBe(true);
    const denied = await reveal(80);
    expect(denied).toMatchObject({
      allowed: false,
      shown_today: 80,
      remaining: 0,
    });
    expect(denied).not.toHaveProperty("phone");
    expect(
      (await alerts()).filter((row) => row.severity === "warning"),
    ).toHaveLength(1);
    expect(
      (await alerts()).filter((row) => row.severity === "critical"),
    ).toHaveLength(1);
    expect(
      (await alerts()).find((row) => row.severity === "warning").metadata,
    ).toMatchObject({ shown_today: 64, limit: 80 });
    expect((await reveal(0)).allowed).toBe(true);
    expect((await usage()).shown_today).toBe(80);
    expect((await reveal(81)).allowed).toBe(false);
    expect(
      (await alerts()).filter((row) => row.severity === "critical"),
    ).toHaveLength(1);
  });
  it("counts repeated reveals once, emits the warning at exactly 80% and records every successful read", async () => {
    for (let i = 0; i < 20; i++) await reveal(0, agent, 5);
    expect((await usage(agent, 5)).shown_today).toBe(1);
    expect(await alerts()).toHaveLength(0);
    for (let i = 1; i < 4; i++) await reveal(i, agent, 5);
    expect((await alerts()).map((row) => row.severity)).toEqual(["warning"]);
    await reveal(0, agent, 5);
    expect(await alerts()).toHaveLength(1);
    expect(
      (
        await one(
          "select count(*)::int n from crm_private.phone_reveals where user_id=$1",
          [agent],
        )
      ).n,
    ).toBe(24);
  });
  it("rounds a small non-divisible limit threshold upward and enforces that limit", async () => {
    await reveal(0, agent, 3);
    await reveal(1, agent, 3);
    expect(await alerts()).toHaveLength(0);
    await reveal(2, agent, 3);
    expect((await alerts())[0].severity).toBe("warning");
    expect((await reveal(3, agent, 3)).allowed).toBe(false);
  });
  it("computes and resets at Pakistan midnight rather than UTC or the database timezone", async () => {
    const before = (
      await one(
        "select to_jsonb(w) value from phone_reveal_window('2026-10-13T18:59:59Z') w",
      )
    ).value;
    const after = (
      await one(
        "select to_jsonb(w) value from phone_reveal_window('2026-10-13T19:00:00Z') w",
      )
    ).value;
    expect(before.day).toBe("2026-10-13");
    expect(after.day).toBe("2026-10-14");
    expect(Date.parse(before.resets_at)).toBe(
      Date.parse("2026-10-13T19:00:00Z"),
    );
    expect(after.starts_at).toBe(before.resets_at);
    await pg.query(
      "insert into crm_private.phone_reveals(user_id,lead_id,revealed_at) select $1,$2,starts_at-interval '1 millisecond' from phone_reveal_window(now())",
      [agent, leads[0].id],
    );
    expect((await usage()).shown_today).toBe(0);
    await pg.exec("set time zone 'America/Los_Angeles';");
    try {
      expect((await reveal()).shown_today).toBe(1);
    } finally {
      await pg.exec("set time zone 'UTC';");
    }
  });
  it("keeps quotas separate for each agent and leaves administrators unlimited but audited", async () => {
    for (let i = 0; i < 85; i++)
      expect((await reveal(i, admin, 1)).allowed).toBe(true);
    expect(await usage(admin, 1)).toMatchObject({
      shown_today: 85,
      unlimited: true,
      remaining: null,
    });
    expect(await alerts()).toHaveLength(0);
    await reveal(0, agent, 1);
    await pg.query("select assign_lead($1,$2,$3,'privacy:transfer')", [
      leads[1].id,
      admin,
      other,
    ]);
    expect((await reveal(1, other, 1)).allowed).toBe(true);
    expect((await usage(agent, 1)).shown_today).toBe(1);
    expect((await usage(other, 1)).shown_today).toBe(1);
  });
  it("checks current assignment and active actor before charging a quota", async () => {
    await expect(reveal(0, other)).rejects.toMatchObject({ code: "P0002" });
    await reveal();
    await pg.query("select assign_lead($1,$2,$3,'privacy:transfer')", [
      leads[0].id,
      admin,
      other,
    ]);
    await expect(reveal()).rejects.toMatchObject({ code: "P0002" });
    await pg.query("update profiles set active=false where id=$1", [other]);
    await expect(reveal(0, other)).rejects.toMatchObject({ code: "42501" });
    expect((await usage()).shown_today).toBe(1);
  });
  it("serializes simultaneous decisions so a five-lead budget cannot yield six numbers", async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, index) => reveal(index, agent, 5)),
    );
    expect(results.filter((row) => row.allowed)).toHaveLength(5);
    expect(results.filter((row) => !row.allowed)).toHaveLength(1);
    expect((await usage(agent, 5)).shown_today).toBe(5);
  });
  it("rolls back a number read and its warning if audit insertion fails", async () => {
    for (let i = 0; i < 3; i++) await reveal(i, agent, 5);
    await pg.exec(
      "create function fail_phone_audit() returns trigger language plpgsql as $$ begin if new.action='security.alert_created' then raise exception 'Audit failed'; end if; return new; end $$;create trigger fail_phone_audit before insert on audit_log for each row execute function fail_phone_audit();",
    );
    try {
      await expect(reveal(3, agent, 5)).rejects.toThrow("Audit failed");
      expect((await usage(agent, 5)).shown_today).toBe(3);
      expect(await alerts()).toHaveLength(0);
    } finally {
      await pg.exec(
        "drop trigger fail_phone_audit on audit_log;drop function fail_phone_audit();",
      );
    }
  });
  it("rejects invalid limits in SQL and browser execution/read access", async () => {
    for (const limit of [0, -1, 10001, null])
      await expect(reveal(0, agent, limit)).rejects.toMatchObject({
        code: "22023",
      });
    for (const role of ["anon", "authenticated"]) {
      await pg.exec("set role " + role);
      try {
        await expect(reveal()).rejects.toMatchObject({ code: "42501" });
        await expect(
          pg.query("select * from security_alerts"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          pg.query("select * from crm_private.phone_reveals"),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await pg.exec("reset role");
      }
    }
    await pg.exec("set role service_role");
    try {
      expect((await reveal()).allowed).toBe(true);
    } finally {
      await pg.exec("reset role");
    }
  });
  it("lists and reviews alerts only for active admins, idempotently with atomic audit", async () => {
    await reveal(0, agent, 1);
    await reveal(1, agent, 1);
    const list = (
      await one(
        "select security_alerts_page($1,1,1,'unreviewed','critical') value",
        [admin],
      )
    ).value;
    expect(list.count).toBe(1);
    expect(list.data).toHaveLength(1);
    expect(list.data[0].user_name).toBe("Privacy agent");
    const id = list.data[0].id,
      req = randomUUID();
    const reviewed = (
      await one("select review_security_alert($1,$2,$3) value", [
        id,
        admin,
        req,
      ])
    ).value;
    expect(reviewed.reviewed_by).toBe(admin);
    expect(reviewed.reviewed_at).toBeTruthy();
    await one("select review_security_alert($1,$2,$3)", [id, admin, req]);
    expect(
      (
        await one("select count(*)::int n from audit_log where request_id=$1", [
          req,
        ])
      ).n,
    ).toBe(1);
    expect(
      (await one("select security_alerts_summary($1) value", [admin])).value
        .count,
    ).toBe(1);
    await expect(
      one("select security_alerts_page($1)", [agent]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      one("select review_security_alert($1,$2,'forged')", [id, agent]),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("rolls an alert review back if its audit cannot be persisted", async () => {
    await reveal(0, agent, 1);
    const id = (await alerts())[0].id;
    await pg.exec(
      "create function fail_review_audit() returns trigger language plpgsql as $$ begin if new.action='security.alert_reviewed' then raise exception 'Review audit failed'; end if; return new; end $$;create trigger fail_review_audit before insert on audit_log for each row execute function fail_review_audit();",
    );
    try {
      await expect(
        one("select review_security_alert($1,$2,'failed')", [id, admin]),
      ).rejects.toThrow("Review audit failed");
      expect(
        (await one("select reviewed_at from security_alerts where id=$1", [id]))
          .reviewed_at,
      ).toBeNull();
    } finally {
      await pg.exec(
        "drop trigger fail_review_audit on audit_log;drop function fail_review_audit();",
      );
    }
  });
});

describe("Automatic contact SQL authorization and atomic audit", () => {
  const contacts = async (ids, actor = agent, req = randomUUID()) =>
    (await one("select lead_contact_phones($1,$2,$3) value", [actor, ids, req]))
      .value;
  it("repairs a missing contact function repeatedly without changing customers or history", async () => {
    await contacts([leads[0].id]);
    const counts = async () =>
      await one(
        "select (select count(*) from leads)::int leads,(select count(*) from crm_private.lead_phones)::int phones,(select count(*) from crm_private.phone_reveals)::int reads,(select count(*) from audit_log)::int audits",
      );
    const before = await counts();
    await pg.exec(
      "drop function public.lead_contact_phones(uuid,uuid[],text);",
    );
    const repair = await readFile(
      new URL(
        "../../supabase/repair-visible-lead-contacts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    for (let i = 0; i < 2; i++) {
      const result = await pg.exec(repair);
      expect(result.at(-1).rows[0]).toMatchObject({
        phone_function_installed: true,
        server_access_ready: true,
      });
      expect(await counts()).toEqual(before);
    }
    expect((await contacts([leads[0].id])).phones[leads[0].id]).toBe(
      leads[0].phone,
    );
  });
  it("restores service-only permissions on an existing contact function", async () => {
    await pg.exec(
      "grant execute on function public.lead_contact_phones(uuid,uuid[],text) to public,anon,authenticated;",
    );
    await pg.exec(
      await readFile(
        new URL(
          "../../supabase/repair-visible-lead-contacts.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    for (const role of ["anon", "authenticated"])
      expect(
        (
          await one(
            "select has_function_privilege($1,'public.lead_contact_phones(uuid,uuid[],text)','execute') allowed",
            [role],
          )
        ).allowed,
      ).toBe(false);
    expect((await contacts([leads[0].id])).phones[leads[0].id]).toBe(
      leads[0].phone,
    );
  });
  it("returns every authorized contact past the historical daily quota without new alerts", async () => {
    const req = randomUUID();
    const result = await contacts(
      leads.map((row) => row.id),
      agent,
      req,
    );
    for (const row of leads) expect(result.phones[row.id]).toBe(row.phone);
    expect((await usage()).shown_today).toBe(85);
    expect(await alerts()).toHaveLength(0);
    const entries = (
      await pg.query("select * from audit_log where request_id=$1", [req])
    ).rows;
    expect(entries).toHaveLength(85);
    expect(entries.every((row) => row.action === "lead.phone_revealed")).toBe(
      true,
    );
    expect(JSON.stringify(entries)).not.toContain(leads[0].phone);
  });
  it("rejects mixed ownership and missing leads before releasing or auditing any number", async () => {
    await pg.query("update leads set assigned_agent=$1 where id=$2", [
      other,
      leads[1].id,
    ]);
    for (const ids of [
      [leads[0].id, leads[1].id],
      [leads[0].id, randomUUID()],
    ])
      await expect(contacts(ids)).rejects.toMatchObject({ code: "P0002" });
    expect((await usage()).shown_today).toBe(0);
    expect(
      (await contacts([leads[0].id, leads[1].id], admin)).phones[leads[1].id],
    ).toBe(leads[1].phone);
  });
  it("rejects empty, repeated, null and oversized selections", async () => {
    for (const ids of [
      null,
      [],
      [leads[0].id, leads[0].id],
      [leads[0].id, null],
      Array.from({ length: 101 }, () => randomUUID()),
    ])
      await expect(contacts(ids)).rejects.toMatchObject({ code: "22023" });
    expect((await usage()).shown_today).toBe(0);
  });
  it.each([admin, agent])("refuses an inactive actor %s", async (actor) => {
    await pg.query("update profiles set active=false where id=$1", [actor]);
    await expect(contacts([leads[0].id], actor)).rejects.toMatchObject({
      code: "42501",
    });
    expect(
      (await one("select count(*)::int n from crm_private.phone_reveals")).n,
    ).toBe(0);
  });
  it("denies browser roles and permits the service role", async () => {
    for (const role of ["anon", "authenticated"]) {
      await pg.exec("set role " + role);
      try {
        await expect(contacts([leads[0].id])).rejects.toMatchObject({
          code: "42501",
        });
      } finally {
        await pg.exec("reset role");
      }
    }
    await pg.exec("set role service_role");
    try {
      expect((await contacts([leads[0].id])).phones[leads[0].id]).toBe(
        leads[0].phone,
      );
    } finally {
      await pg.exec("reset role");
    }
  });
  it("returns no contacts and rolls back the ledger if audit persistence fails", async () => {
    await pg.exec(
      "create function fail_contact_audit() returns trigger language plpgsql as $$ begin if new.action='lead.phone_revealed' then raise exception 'Contact audit failed'; end if; return new; end $$;create trigger fail_contact_audit before insert on audit_log for each row execute function fail_contact_audit();",
    );
    try {
      await expect(
        contacts(leads.slice(0, 20).map((row) => row.id)),
      ).rejects.toThrow("Contact audit failed");
      expect((await usage()).shown_today).toBe(0);
    } finally {
      await pg.exec(
        "drop trigger fail_contact_audit on audit_log;drop function fail_contact_audit();",
      );
    }
  });
});

describe("Contact APIs and response privacy", () => {
  it("recovers full list and profile contacts after repairing the reported missing history table", async () => {
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    const identities = (
      await pg.query(
        "select l.id,p.phone from leads l join crm_private.lead_phones p on p.lead_id=l.id order by l.id",
      )
    ).rows;
    await pg.exec("drop table crm_private.phone_reveals;");
    const failed = await get(app, "/api/leads");
    expect(failed.status).toBe(503);
    expect(failed.body.error).toContain("database tables are missing");
    await pg.exec(
      await readFile(
        new URL(
          "../../supabase/repair-visible-lead-contacts.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      (
        await pg.query(
          "select l.id,p.phone from leads l join crm_private.lead_phones p on p.lead_id=l.id order by l.id",
        )
      ).rows,
    ).toEqual(identities);
    const list = await get(app, "/api/leads?limit=100");
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(85);
    for (const row of leads)
      expect(list.body.data.find((item) => item.id === row.id).phone).toBe(
        row.phone,
      );
    const detail = await get(app, `/api/leads/${leads[0].id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.phone).toBe(leads[0].phone);
    expect((await get(app, `/api/leads/${leads[0].id}`, other)).status).toBe(
      404,
    );
    const adminList = await get(app, "/api/leads", admin);
    expect(adminList.status).toBe(200);
    expect(
      adminList.body.data.every((row) => /^\+\d{10,15}$/.test(row.phone)),
    ).toBe(true);
  });
  it("looks up only the requested page and returns a clear error if migration 021 is missing", async () => {
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    const response = await get(app, "/api/leads?page=2");
    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(20);
    expect(client.rpc).toHaveBeenCalledExactlyOnceWith(
      "lead_contact_phones",
      expect.objectContaining({
        p_actor: agent,
        p_leads: response.body.data.map((row) => row.id),
      }),
    );
    client.rpc.mockResolvedValueOnce({
      error: { code: "PGRST202", message: leads[0].phone },
    });
    const failed = await get(app, "/api/leads");
    expect(failed.status).toBe(503);
    expect(failed.body.error).toContain("migration 021");
    expect(failed.body.error).toContain("cache refresh");
    expect(failed.body.error).toContain("project connected to this CRM");
    expect(failed.body).not.toHaveProperty("data");
    expect(JSON.stringify(failed.body)).not.toContain(leads[0].phone);
    client.rpc.mockClear();
    const empty = await get(app, "/api/leads", other);
    expect(empty.body).toMatchObject({ data: [], count: 0 });
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it("distinguishes a missing required table from a missing contact function without provider leaks", async () => {
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    client.rpc.mockResolvedValueOnce({
      error: { code: "42P01", message: leads[0].phone },
    });
    const failed = await get(app, "/api/leads");
    expect(failed.status).toBe(503);
    expect(failed.body.error).toContain("database tables are missing");
    expect(failed.body.error).not.toContain("migration 021");
    expect(JSON.stringify(failed.body)).not.toContain(leads[0].phone);
  });
  it.each([agent, admin])(
    "returns an audited no-store contact through the compatibility number endpoint as %s",
    async (actor) => {
      const client = database(),
        response = await get(
          createApp(trustedMfaFixture(client)),
          path(),
          actor,
        );
      expect(response.status).toBe(200);
      expect(response.body.phone).toBe(leads[0].phone);

      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers["ratelimit-policy"]).toContain(
        '"sensitive"; q=30; w=60',
      );
      expect(client.rpc).toHaveBeenCalledWith(
        "lead_contact_phones",
        expect.objectContaining({ p_leads: [leads[0].id], p_actor: actor }),
      );
    },
  );
  it("shows the 81st contact through the API despite the historical SQL quota", async () => {
    for (let i = 0; i < 80; i++) await reveal(i);
    const response = await get(
      createApp(trustedMfaFixture(database())),
      path(80),
    );
    expect(response.status).toBe(200);
    expect(response.body.phone).toBe(leads[80].phone);
    expect(
      (await alerts()).filter((row) => row.severity === "critical"),
    ).toHaveLength(0);
  });
  it("removes the batch route for both roles without looking up any contacts", async () => {
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    for (const actor of [agent, admin]) {
      const response = await request(app)
        .post("/api/leads/phones")
        .set("Authorization", "Bearer " + actor)
        .send({ lead_ids: leads.slice(0, 20).map((row) => row.id) });
      expect(response.status).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain(leads[0].phone);
    }
    expect(client.rpc).not.toHaveBeenCalled();
  });
  it("scopes usage to the authenticated actor and rejects client quota/clock overrides", async () => {
    await reveal();
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    const response = await get(app, "/api/phone-reveals/status");
    expect(response.body.shown_today).toBe(1);
    expect(response.body).not.toHaveProperty("phone");
    expect(
      (await get(app, "/api/phone-reveals/status", other)).body.shown_today,
    ).toBe(0);
    for (const url of [
      path() + "?limit=1000",
      path() + "?actor=" + admin,
      "/api/phone-reveals/status?at=tomorrow",
    ])
      expect((await get(app, url)).status).toBe(400);
  });
  it("returns no phone for other agents, absent sessions or disabled actors", async () => {
    const app = createApp(trustedMfaFixture(database()));
    expect((await get(app, path(), other)).status).toBe(404);
    expect((await request(app).get(path())).status).toBe(401);
    expect((await get(app, path(), "expired")).status).toBe(401);
    await pg.query("update profiles set active=false where id=$1", [agent]);
    expect((await get(app, path())).status).toBe(403);
  });
  it("surfaces missing-migration and private-operation errors without leaking provider details", async () => {
    const client = database(),
      app = createApp(trustedMfaFixture(client));
    client.rpc.mockResolvedValueOnce({
      error: { code: "PGRST202", message: leads[0].phone },
    });
    const missing = await get(app, path());
    expect(missing.status).toBe(503);
    expect(missing.body.error).toContain("migration 021");
    expect(JSON.stringify(missing.body)).not.toContain(leads[0].phone);
    client.rpc.mockResolvedValueOnce({
      error: { code: "42501", message: leads[0].phone },
    });
    expect((await get(app, path())).status).toBe(403);
  });
  it("keeps the old status configuration separate from automatic contact display", async () => {
    vi.stubEnv("PHONE_REVEAL_DAILY_LIMIT", "2");
    const app = createApp(trustedMfaFixture(database()));
    expect((await get(app, path())).body.phone).toBe(leads[0].phone);
    for (const value of ["0", "-1", "2.5", "10001", "not-a-number"]) {
      vi.stubEnv("PHONE_REVEAL_DAILY_LIMIT", value);
      expect(() => phoneRevealLimit()).toThrow();
      expect((await get(app, "/api/phone-reveals/status")).status).toBe(503);
    }
  });
  it("shows authorized contact fields and keeps agent free text masked", async () => {
    const phone = leads[0].phone;
    await pg.query(
      "select crm_mutate('notes',null,$1::jsonb,$2,'privacy:note')",
      [
        JSON.stringify({
          lead_id: leads[0].id,
          body: "Contact " + phone + " after the visit",
        }),
        agent,
      ],
    );
    const app = createApp(trustedMfaFixture(database()));
    for (const url of [
      "/api/leads?limit=100",
      `/api/leads/${leads[0].id}`,
      `/api/leads/${leads[0].id}/timeline`,
    ]) {
      const response = await get(app, url);
      expect(response.status).toBe(200);
      const body = structuredClone(response.body);
      if (url.includes("/timeline"))
        expect(JSON.stringify(body)).not.toContain(phone);
      else {
        const records = body.data || [body];
        expect(records.find((row) => row.id === leads[0].id).phone).toBe(phone);
        for (const row of records) delete row.phone;
        expect(JSON.stringify(body)).not.toContain(phone);
      }
    }
    expect((await usage()).shown_today).toBeGreaterThan(0);
    const original = await get(
      app,
      `/api/leads/${leads[0].id}/timeline`,
      admin,
    );
    expect(JSON.stringify(original.body)).toContain(phone);
  });
  it("shows file-member contacts without exposing extra phones in import metadata", async () => {
    const phone = "+923069876543",
      name = "Imported " + phone;
    const result = (
      await one(
        "select import_leads('contacts.csv','csv',null,$1::jsonb,$2,'privacy:import') value",
        [
          JSON.stringify([
            {
              row: 2,
              phone,
              data: { name, assigned_agent: agent, source: "CSV" },
            },
          ]),
          admin,
        ],
      )
    ).value;
    expect(JSON.stringify(result)).not.toContain(phone);
    const app = createApp(trustedMfaFixture(database()));
    for (const url of [
      "/api/lead-imports",
      `/api/lead-imports/${result.import_id}`,
      `/api/leads?import_id=${result.import_id}`,
    ]) {
      const response = await get(app, url);
      expect(response.status).toBe(200);
      if (url.startsWith("/api/leads?")) {
        expect(response.body.data[0].phone).toBe(phone);
        expect(response.body.data[0].name).not.toContain(phone);
      } else expect(JSON.stringify(response.body)).not.toContain(phone);
    }
    expect(
      (
        await request(app)
          .post("/api/leads/import")
          .set("Authorization", "Bearer " + agent)
          .attach(
            "file",
            Buffer.from("name,phone\nBuyer," + phone),
            "contacts.csv",
          )
      ).status,
    ).toBe(403);
  });
  it("protects administrator alert APIs, validates filters and refreshes review totals", async () => {
    await reveal(0, agent, 1);
    await reveal(1, agent, 1);
    const app = createApp(trustedMfaFixture(database()));
    for (const url of ["/api/security-alerts", "/api/security-alerts/summary"])
      expect((await get(app, url)).status).toBe(403);
    const list = await get(
      app,
      "/api/security-alerts?severity=critical",
      admin,
    );
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(1);
    const id = list.body.data[0].id;
    expect(
      (
        await request(app)
          .patch("/api/security-alerts/" + id)
          .set("Authorization", "Bearer " + agent)
          .send({ reviewed: true })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .patch("/api/security-alerts/" + id)
          .set("Authorization", "Bearer " + admin)
          .send({ reviewed: true })
      ).status,
    ).toBe(200);
    expect(
      (await get(app, "/api/security-alerts/summary", admin)).body.count,
    ).toBe(1);
    expect(
      (await get(app, "/api/security-alerts?view=reviewed", admin)).body.count,
    ).toBe(1);
    for (const url of [
      "/api/security-alerts?severity=unknown",
      "/api/security-alerts?view=unknown",
      "/api/security-alerts?page=0",
      "/api/security-alerts?user_id=" + agent,
    ])
      expect((await get(app, url, admin)).status).toBe(400);
    expect(
      (
        await request(app)
          .patch("/api/security-alerts/" + id)
          .set("Authorization", "Bearer " + admin)
          .send({ reviewed: false, reviewed_by: agent })
      ).status,
    ).toBe(400);
  });
  it("redacts common international/local phone text while preserving IDs, amounts and dates", () => {
    const object = {
      id: agent,
      provider_call_id: "mock-" + agent,
      amount: 923001234567,
      at: new Date("2026-10-13T11:00:00Z"),
      nested: [
        {
          notes:
            "+923001234567; 0300-1234567; 00923001234567; 923001234567; +14155552671",
        },
      ],
    };
    const masked = maskAgentResponse(object);
    expect(masked.id).toBe(agent);
    expect(masked.provider_call_id).toBe("mock-" + agent);
    expect(masked.amount).toBe(object.amount);
    expect(masked.at).toBe(object.at);
    for (const phone of [
      "+923001234567",
      "0300-1234567",
      "00923001234567",
      "923001234567",
      "+14155552671",
    ])
      expect(JSON.stringify(masked.nested)).not.toContain(phone);
    expect(object.nested[0].notes).toContain("+923001234567");
  });
});

describe("repeatable security-alert repair", () => {
  const repair = () =>
    readFile(
      new URL("../../supabase/repair-security-alerts.sql", import.meta.url),
      "utf8",
    );
  const missingFunctions =
    "drop function public.security_alerts_summary(uuid);drop function public.security_alerts_page(uuid,integer,integer,text,text);drop function public.review_security_alert(uuid,uuid,text);";
  it("restores missing summary/list/review readers repeatedly while retaining contacts and history", async () => {
    await reveal(0, agent, 1);
    const snapshot = async () => ({
      alerts: await alerts(),
      counts: await one(
        "select (select count(*) from leads)::int leads,(select count(*) from crm_private.lead_phones)::int phones,(select count(*) from crm_private.phone_reveals)::int reads,(select count(*) from audit_log)::int audits",
      ),
      contacts: (
        await one(
          "select pg_get_functiondef('public.lead_contact_phones(uuid,uuid[],text)'::regprocedure) body",
        )
      ).body,
    });
    const before = await snapshot();
    await pg.exec(missingFunctions);
    for (let i = 0; i < 2; i++) {
      const result = await pg.exec(await repair());
      expect(result.at(-1).rows[0]).toMatchObject({
        security_alerts_ready: true,
        summary_ready: true,
        list_ready: true,
        review_ready: true,
        server_access_ready: true,
      });
      expect(await snapshot()).toEqual(before);
    }
    expect(
      (await one("select security_alerts_summary($1) value", [admin])).value
        .count,
    ).toBe(1);
    expect(
      (await one("select security_alerts_page($1) value", [admin])).value.data,
    ).toHaveLength(1);
  });
  it("fixes the reported API warning when the alert table is missing without touching phone history", async () => {
    const app = createApp(trustedMfaFixture(database()));
    await pg.exec(missingFunctions + "drop table public.security_alerts;");
    const before = await get(app, "/api/security-alerts/summary", admin);
    expect(before.status).toBe(503);
    expect(before.body.error).toContain("019 after 018");
    await pg.exec(await repair());
    const after = await get(app, "/api/security-alerts/summary", admin);
    expect(after.status).toBe(200);
    expect(after.body).toEqual({ count: 0, critical: 0, warning: 0 });
    expect((await get(app, "/api/security-alerts", admin)).status).toBe(200);
    expect((await get(app, "/api/security-alerts/summary", agent)).status).toBe(
      403,
    );
    expect(
      (
        await one(
          "select lead_contact_phones($1,$2,'after-alert-repair') value",
          [agent, [leads[0].id]],
        )
      ).value.phones[leads[0].id],
    ).toBe(leads[0].phone);
    expect(
      (await one("select to_regclass('crm_private.phone_reveals') present"))
        .present,
    ).toBeTruthy();
  });
  it("restores RLS/service-only grants and keeps disabled administrators denied", async () => {
    await pg.exec(
      "alter table public.security_alerts disable row level security;grant all on public.security_alerts to public,anon,authenticated;grant execute on function public.security_alerts_summary(uuid),public.security_alerts_page(uuid,integer,integer,text,text),public.review_security_alert(uuid,uuid,text) to public,anon,authenticated;",
    );
    await pg.exec(await repair());
    expect(
      (
        await one(
          "select relrowsecurity enabled from pg_class where oid='public.security_alerts'::regclass",
        )
      ).enabled,
    ).toBe(true);
    for (const role of ["anon", "authenticated"]) {
      expect(
        (
          await one(
            "select has_table_privilege($1,'public.security_alerts','select') allowed",
            [role],
          )
        ).allowed,
      ).toBe(false);
      for (const signature of [
        "security_alerts_summary(uuid)",
        "security_alerts_page(uuid,integer,integer,text,text)",
        "review_security_alert(uuid,uuid,text)",
      ])
        expect(
          (
            await one(
              "select has_function_privilege($1,$2,'execute') allowed",
              [role, "public." + signature],
            )
          ).allowed,
        ).toBe(false);
    }
    await pg.query("update profiles set active=false where id=$1", [admin]);
    await expect(
      one("select security_alerts_summary($1)", [admin]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      one("select security_alerts_page($1)", [agent]),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("retains atomic review auditing after repair", async () => {
    await reveal(0, agent, 1);
    const id = (await alerts())[0].id;
    await pg.exec(await repair());
    await pg.exec(
      "create function fail_repaired_review_audit() returns trigger language plpgsql as $$ begin if new.action='security.alert_reviewed' then raise exception 'Review audit failed'; end if; return new; end $$;create trigger fail_repaired_review_audit before insert on audit_log for each row execute function fail_repaired_review_audit();",
    );
    try {
      await expect(
        one("select review_security_alert($1,$2,'repair-review')", [id, admin]),
      ).rejects.toThrow("Review audit failed");
      expect(
        (await one("select reviewed_at from security_alerts where id=$1", [id]))
          .reviewed_at,
      ).toBeNull();
    } finally {
      await pg.exec(
        "drop trigger fail_repaired_review_audit on audit_log;drop function fail_repaired_review_audit();",
      );
    }
    await one("select review_security_alert($1,$2,'repair-review')", [
      id,
      admin,
    ]);
    await one("select review_security_alert($1,$2,'repair-review')", [
      id,
      admin,
    ]);
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where request_id='repair-review'",
        )
      ).n,
    ).toBe(1);
  });
});
