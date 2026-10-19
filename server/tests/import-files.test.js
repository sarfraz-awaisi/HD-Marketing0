import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import request from "supertest";
import { utils, write } from "xlsx";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
let pg,
  next = 1;
const admin = "41000000-0000-4000-8000-000000000001",
  agent = "41000000-0000-4000-8000-000000000002",
  other = "41000000-0000-4000-8000-000000000003";
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const row = (name = "File customer") => ({
  row: 2,
  data: { name, source: "CSV", budget_min: 0 },
  phone: "+92303" + String(next++).padStart(7, "0"),
});
async function imported(rows = [row()], name = "customers.csv", actor = admin) {
  return (
    await one(
      "select import_leads($1,$2,null,$3::jsonb,$4,'file-test') as value",
      [name, name.split(".").at(-1), JSON.stringify(rows), actor],
    )
  ).value;
}
const assignment = async (id, target = agent, actor = admin) =>
  (
    await one(
      "select assign_lead_import($1,$2,$3,'assign-file-test') as value",
      [id, target, actor],
    )
  ).value;
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}'); create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
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
    "update profiles set role='admin',name='File admin' where id=$1",
    [admin],
  );
  await pg.query("update profiles set name='First file agent' where id=$1", [
    agent,
  ]);
  await pg.query("update profiles set name='Second file agent' where id=$1", [
    other,
  ]);
}, 30000);
afterAll(async () => {
  await pg?.close();
});
function database() {
  const rpc = vi.fn(async (name, args) => {
    const calls = {
      import_leads: [
        "select import_leads($1,$2,$3,$4::jsonb,$5,$6) as value",
        [
          args.p_file_name,
          args.p_format,
          args.p_worksheet,
          JSON.stringify(args.p_rows),
          args.p_actor,
          args.p_request,
        ],
      ],
      lead_imports_page: [
        "select lead_imports_page($1,$2,$3,$4) as value",
        [args.p_actor, args.p_page, args.p_limit, args.p_search],
      ],
      lead_import_summary: [
        "select lead_import_summary($1,$2) as value",
        [args.p_import, args.p_actor],
      ],
      assign_lead_import: [
        "select assign_lead_import($1,$2,$3,$4) as value",
        [args.p_import, args.p_agent, args.p_actor, args.p_request],
      ],
      lead_contact_phones: [
        "select lead_contact_phones($1,$2,$3) as value",
        [args.p_actor, args.p_leads, args.p_request],
      ],
      private_phone: ["select private_phone($1) as value", [args.p_lead]],
    };
    try {
      return { data: (await one(...calls[name])).value };
    } catch (error) {
      return { error: { code: error.code } };
    }
  });
  return {
    rpc,
    auth: {
      getUser: async (token) => ({
        data: {
          user: [admin, agent, other].includes(token)
            ? { id: token, email_confirmed_at: "2026-10-01T00:00:00Z" }
            : null,
        },
      }),
    },
    from(table) {
      const filters = {},
        ids = {};
      let lo = 0,
        hi = 19;
      const where = () => {
        const values = [];
        const clauses = [];
        for (const [key, value] of Object.entries(filters)) {
          values.push(value);
          clauses.push(
            `${key}${value === null ? " is not distinct from " : "="}$${values.length}`,
          );
        }
        for (const [key, value] of Object.entries(ids)) {
          values.push(value);
          clauses.push(`${key}=any($${values.length}::uuid[])`);
        }
        return {
          values,
          clause: clauses.length ? " where " + clauses.join(" and ") : "",
        };
      };
      const run = async () => {
        const { values, clause } = where();
        return (
          await pg.query(`select * from public.${table}${clause}`, values)
        ).rows;
      };
      const q = {
        select: () => q,
        eq: (key, value) => {
          filters[key] = value;
          return q;
        },
        is: (key, value) => {
          filters[key] = value;
          return q;
        },
        in: (key, value) => {
          ids[key] = value;
          return q;
        },
        order: () => q,
        single: async () => ({ data: (await run())[0] }),
        maybeSingle: async () => ({ data: (await run())[0] || null }),
        range: async (start, end) => {
          const data = await run();
          return { data: data.slice(start, end + 1), count: data.length };
        },
        insert: async (rows) => {
          try {
            for (const r of Array.isArray(rows) ? rows : [rows])
              await pg.query(
                "insert into audit_log(actor_id,action,entity,entity_id,request_id,metadata) values($1,$2,$3,$4,$5,$6::jsonb)",
                [
                  r.actor_id,
                  r.action,
                  r.entity,
                  r.entity_id,
                  r.request_id,
                  JSON.stringify(r.metadata),
                ],
              );
            return {};
          } catch (error) {
            return { error: { code: error.code } };
          }
        },
        then: (resolve, reject) =>
          run().then((data) => resolve({ data }), reject),
      };
      return q;
    },
  };
}

describe("import file database and API", () => {
  it("stores a filename, membership and safe partial results in one transaction", async () => {
    const good = row(),
      duplicate = { ...good, row: 3 };
    const result = await imported(
      [
        good,
        duplicate,
        { row: 4, error: "Email must be a valid email address or blank." },
      ],
      "partial.csv",
    );
    expect(result.rows.map((r) => r.success)).toEqual([true, false, false]);
    expect(result.rows[1].error).toBe("Duplicate phone");
    expect(
      await one(
        "select file_name,total_rows,imported_count,rejected_count from lead_imports where id=$1",
        [result.import_id],
      ),
    ).toEqual({
      file_name: "partial.csv",
      total_rows: 3,
      imported_count: 1,
      rejected_count: 2,
    });
    expect(
      (
        await one("select import_id from leads where id=$1", [
          result.rows[0].id,
        ])
      ).import_id,
    ).toBe(result.import_id);
    expect(JSON.stringify(result)).not.toContain(good.phone);
  });
  it.each(["csv", "xlsx", "xls"])(
    "uploads %s and registers the original filename",
    async (format) => {
      const name = `assignment-${format}.${format}`,
        phone = row().phone;
      let buffer = Buffer.from(`name,phone\nUploaded customer,${phone}`);
      if (format !== "csv") {
        const book = utils.book_new();
        utils.book_append_sheet(
          book,
          utils.aoa_to_sheet([
            ["name", "phone"],
            ["Uploaded customer", phone],
          ]),
          "Customers",
        );
        buffer = write(book, {
          type: "buffer",
          bookType: format === "xls" ? "biff8" : "xlsx",
        });
      }
      const result = await request(createApp(trustedMfaFixture(database())))
        .post("/api/leads/import")
        .set("Authorization", "Bearer " + admin)
        .attach("file", buffer, name);
      expect(result.status).toBe(200);
      expect(result.body.rows[0].success).toBe(true);
      expect(result.body.file_name).toBe(name);
      expect(
        await one(
          "select file_name,file_format from lead_imports where id=$1",
          [result.body.import_id],
        ),
      ).toEqual({ file_name: name, file_format: format });
      expect(JSON.stringify(result.body)).not.toContain(phone);
    },
  );
  it("assigns every file member and records per-lead and file audit history", async () => {
    const result = await imported(
      [row(), { ...row(), row: 3 }],
      "whole-file.csv",
    );
    const assigned = await assignment(result.import_id);
    expect(assigned).toMatchObject({
      agent_id: agent,
      lead_count: 2,
      assigned_count: 2,
    });
    expect(
      (
        await pg.query(
          "select distinct assigned_agent from leads where import_id=$1",
          [result.import_id],
        )
      ).rows,
    ).toEqual([{ assigned_agent: agent }]);
    expect(
      (
        await one(
          "select count(*)::integer n from audit_log where action='assign_file' and entity_id=$1",
          [result.import_id],
        )
      ).n,
    ).toBe(1);
    const before = (await one("select count(*)::integer n from assignments")).n;
    expect((await assignment(result.import_id)).assigned_count).toBe(0);
    expect((await one("select count(*)::integer n from assignments")).n).toBe(
      before,
    );
  });
  it("reassigns a file atomically and immediately removes the old agent's access", async () => {
    const result = await imported(
      [row(), { ...row(), row: 3 }],
      "reassignment.csv",
    );
    await assignment(result.import_id);
    expect(
      (
        await one("select lead_import_summary($1,$2) as value", [
          result.import_id,
          agent,
        ])
      ).value.lead_count,
    ).toBe(2);
    await assignment(result.import_id, other);
    expect(
      (
        await one("select lead_import_summary($1,$2) as value", [
          result.import_id,
          agent,
        ])
      ).value,
    ).toBeNull();
    expect(
      (
        await one("select lead_import_summary($1,$2) as value", [
          result.import_id,
          other,
        ])
      ).value.lead_count,
    ).toBe(2);
  });
  it("keeps individual reassignment access limited to current file members", async () => {
    const result = await imported(
      [row(), { ...row(), row: 3 }],
      "individual.csv",
    );
    await assignment(result.import_id);
    await one("select assign_lead($1,$2,$3,$4)", [
      result.rows[0].id,
      admin,
      other,
      "individual-test",
    ]);
    expect(
      (
        await one("select lead_import_summary($1,$2) as value", [
          result.import_id,
          agent,
        ])
      ).value.lead_count,
    ).toBe(1);
    expect(
      (
        await one("select lead_import_summary($1,$2) as value", [
          result.import_id,
          other,
        ])
      ).value.lead_count,
    ).toBe(1);
    expect(
      (
        await one("select lead_import_summary($1,$2) as value", [
          result.import_id,
          admin,
        ])
      ).value.mixed_assignment,
    ).toBe(true);
  });
  it("scopes file listing, detail, lead lists and automatic contacts through the actual API", async () => {
    const result = await imported(
      [row(), { ...row(), row: 3 }],
      "agent-api.csv",
    );
    await assignment(result.import_id);
    const app = createApp(trustedMfaFixture(database()));
    const listing = await request(app)
      .get("/api/lead-imports?search=agent-api")
      .set("Authorization", "Bearer " + agent);
    expect(listing.status).toBe(200);
    expect(listing.body.data).toHaveLength(1);
    expect(listing.body.data[0].id).toBe(result.import_id);
    const leads = await request(app)
      .get("/api/leads?import_id=" + result.import_id)
      .set("Authorization", "Bearer " + agent);
    expect(leads.status).toBe(200);
    expect(leads.body.data).toHaveLength(2);
    expect(
      leads.body.data.every(
        (lead) =>
          lead.import_id === result.import_id && lead.assigned_agent === agent,
      ),
    ).toBe(true);
    expect(
      (
        await request(app)
          .get("/api/lead-imports/" + result.import_id)
          .set("Authorization", "Bearer " + other)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .get("/api/leads?import_id=" + result.import_id)
          .set("Authorization", "Bearer " + other)
      ).status,
    ).toBe(404);
    expect(
      (
        await request(app)
          .post("/api/leads/phones")
          .set("Authorization", "Bearer " + other)
          .send({ lead_ids: [result.rows[0].id] })
      ).status,
    ).toBe(404);
    const assigned = await request(app)
      .post(`/api/lead-imports/${result.import_id}/assign`)
      .set("Authorization", "Bearer " + admin)
      .send({ agent_id: other });
    expect(assigned.status).toBe(200);
    expect(
      (
        await request(app)
          .get("/api/lead-imports/" + result.import_id)
          .set("Authorization", "Bearer " + agent)
      ).status,
    ).toBe(404);
  });
  it("denies agent and disabled-admin file assignments in SQL and HTTP", async () => {
    const result = await imported();
    await expect(
      assignment(result.import_id, other, agent),
    ).rejects.toMatchObject({ code: "42501" });
    const app = createApp(trustedMfaFixture(database()));
    expect(
      (
        await request(app)
          .post(`/api/lead-imports/${result.import_id}/assign`)
          .set("Authorization", "Bearer " + agent)
          .send({ agent_id: agent })
      ).status,
    ).toBe(403);
    await pg.query("update profiles set active=false where id=$1", [admin]);
    try {
      await expect(assignment(result.import_id, other)).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await pg.query("update profiles set active=true where id=$1", [admin]);
    }
  });
  it("rejects inactive/admin targets, empty files and missing IDs without changing leads", async () => {
    const result = await imported();
    await expect(assignment(result.import_id, admin)).rejects.toMatchObject({
      code: "22023",
    });
    await pg.query("update profiles set active=false where id=$1", [other]);
    try {
      await expect(assignment(result.import_id, other)).rejects.toMatchObject({
        code: "22023",
      });
    } finally {
      await pg.query("update profiles set active=true where id=$1", [other]);
    }
    const empty = await imported([{ row: 2, error: "Invalid row" }]);
    await expect(assignment(empty.import_id)).rejects.toMatchObject({
      code: "22023",
    });
    await expect(
      assignment("41000000-0000-4000-8000-000000000099"),
    ).rejects.toMatchObject({ code: "P0002" });
    expect(
      (
        await one("select assigned_agent from leads where import_id=$1", [
          result.import_id,
        ])
      ).assigned_agent,
    ).toBeNull();
  });
  it("rolls back every assignment if a later lead's audit fails", async () => {
    const result = await imported([row(), { ...row(), row: 3 }]);
    const ids = result.rows.map((r) => r.id).sort();
    await pg.exec(
      `create function public.fail_file_assignment_audit() returns trigger language plpgsql as $$ begin if new.action='assign' and new.entity_id='${ids[1]}' then raise exception 'Test audit failure'; end if; return new; end $$; create trigger test_file_assignment_audit before insert on audit_log for each row execute function fail_file_assignment_audit();`,
    );
    try {
      await expect(assignment(result.import_id)).rejects.toThrow();
    } finally {
      await pg.exec(
        "drop trigger test_file_assignment_audit on audit_log; drop function fail_file_assignment_audit();",
      );
    }
    expect(
      (
        await one(
          "select count(*)::integer n from leads where import_id=$1 and assigned_agent is not null",
          [result.import_id],
        )
      ).n,
    ).toBe(0);
    expect(
      (
        await one("select assigned_agent from lead_imports where id=$1", [
          result.import_id,
        ])
      ).assigned_agent,
    ).toBeNull();
  });
  it("rolls back file metadata, leads and phones when the import summary audit fails", async () => {
    const candidate = row(),
      before = (await one("select count(*)::integer n from lead_imports")).n;
    await pg.exec(
      "create function public.fail_file_import_audit() returns trigger language plpgsql as $$ begin if new.action='import' then raise exception 'Test audit failure'; end if; return new; end $$; create trigger test_file_import_audit before insert on audit_log for each row execute function fail_file_import_audit();",
    );
    try {
      await expect(imported([candidate])).rejects.toThrow();
    } finally {
      await pg.exec(
        "drop trigger test_file_import_audit on audit_log; drop function fail_file_import_audit();",
      );
    }
    expect((await one("select count(*)::integer n from lead_imports")).n).toBe(
      before,
    );
    expect(
      (
        await one(
          "select count(*)::integer n from crm_private.lead_phones where phone=$1",
          [candidate.phone],
        )
      ).n,
    ).toBe(0);
  });
  it("denies direct browser access to files and assignment/import functions", async () => {
    await pg.exec("set role authenticated");
    try {
      await expect(
        pg.query("select * from lead_imports"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        pg.query("select lead_imports_page($1)", [agent]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        pg.query("select assign_lead_import($1,$2,$3,null)", [
          agent,
          agent,
          admin,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        pg.query("select import_leads('x.csv','csv',null,'[]', $1,null)", [
          admin,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.exec("reset role");
    }
  });
  it("rejects forged file membership and validates file filters and assignment bodies", async () => {
    const result = await imported();
    const app = createApp(trustedMfaFixture(database()));
    expect(
      (
        await request(app)
          .patch("/api/leads/" + result.rows[0].id)
          .set("Authorization", "Bearer " + admin)
          .send({ import_id: result.import_id })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .get("/api/leads?import_id=invalid")
          .set("Authorization", "Bearer " + admin)
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post(`/api/lead-imports/${result.import_id}/assign`)
          .set("Authorization", "Bearer " + admin)
          .send({ agent_id: agent, role: "admin" })
      ).status,
    ).toBe(400);
  });
  it("reports a missing database update before writing any imported leads", async () => {
    const db = database();
    db.rpc.mockResolvedValue({
      error: { code: "PGRST202", message: "private database details" },
    });
    const response = await request(createApp(trustedMfaFixture(db)))
      .post("/api/leads/import")
      .set("Authorization", "Bearer " + admin)
      .attach(
        "file",
        Buffer.from("name,phone\nBuyer,03001234567"),
        "missing-update.csv",
      );
    expect(response.status).toBe(503);
    expect(response.body.error).toContain("database update");
    expect(response.body.error).not.toContain("private database");
  });
  it("imports and assigns the maximum 1,000-row file without missing members", async () => {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      ...row(),
      row: i + 2,
    }));
    const result = await imported(rows, "maximum.csv");
    expect(result.rows).toHaveLength(1000);
    expect(result.rows.every((r) => r.success)).toBe(true);
    expect(await assignment(result.import_id)).toMatchObject({
      lead_count: 1000,
      assigned_count: 1000,
    });
    expect(
      (
        await one(
          "select count(*)::integer n from leads where import_id=$1 and assigned_agent=$2",
          [result.import_id, agent],
        )
      ).n,
    ).toBe(1000);
  }, 30000);
  it("rejects importing through SQL with an agent actor", async () => {
    await expect(
      imported([row()], "forbidden.csv", agent),
    ).rejects.toMatchObject({ code: "42501" });
  });
  it("recovers earlier import groups while preserving ownership, timestamps and private phones", async () => {
    const legacy = new PGlite({ extensions: { pg_trgm } });
    try {
      await legacy.exec(
        "create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}'); create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
      );
      const dir = new URL("../../supabase/migrations/", import.meta.url);
      for (const file of (await readdir(dir))
        .sort()
        .filter((f) => !f.startsWith("014_") && Number(f.slice(0, 3)) < 27))
        await legacy.exec(
          (await readFile(new URL(file, dir), "utf8")).replace(
            "create extension if not exists pgcrypto;",
            "",
          ),
        );
      await legacy.query("insert into auth.users(id) values($1),($2)", [
        admin,
        agent,
      ]);
      await legacy.query(
        "update profiles set active=true where id=any($1::uuid[])",
        [[admin, agent]],
      );
      await legacy.query("update profiles set role='admin' where id=$1", [
        admin,
      ]);
      for (let i = 0; i < 3; i++)
        await legacy.query("select create_lead($1::jsonb,$2,$3,$4)", [
          JSON.stringify({
            name: "Earlier customer",
            source: i < 2 ? "CSV" : "manual",
            assigned_agent: agent,
          }),
          "+92304000000" + i,
          admin,
          i < 2 ? "earlier-upload" : "manual-create",
        ]);
      const snapshot = async () =>
        (
          await legacy.query(
            "select l.*,p.phone from leads l join crm_private.lead_phones p on p.lead_id=l.id order by l.id",
          )
        ).rows;
      const before = await snapshot();
      const audits = (
        await legacy.query("select count(*)::integer n from audit_log")
      ).rows[0].n;
      await legacy.exec(
        await readFile(
          new URL("014_import_files_and_assignments.sql", dir),
          "utf8",
        ),
      );
      // 027 indexes the import table: install it only after that table exists.
      await legacy.exec(
        await readFile(new URL("027_loading_performance.sql", dir), "utf8"),
      );
      await legacy.exec(
        await readFile(new URL("028_account_deletion.sql", dir), "utf8"),
      );
      for (const file of (await readdir(dir))
        .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 3)) >= 29)
        .sort())
        await legacy.exec(await readFile(new URL(file, dir), "utf8"));
      const after = await snapshot();
      const originalFields = Object.keys(before[0]);
      expect(
        after.map((lead) =>
          Object.fromEntries(originalFields.map((key) => [key, lead[key]])),
        ),
      ).toEqual(before);
      const recovered = after.filter((l) => l.source === "CSV");
      expect(recovered[0].import_id).toBeTruthy();
      expect(recovered[0].import_id).toBe(recovered[1].import_id);
      expect(after.find((l) => l.source === "manual").import_id).toBeNull();
      expect(
        (
          await legacy.query(
            "select file_name,file_format,legacy,imported_count from lead_imports",
          )
        ).rows,
      ).toEqual([
        expect.objectContaining({
          file_name: expect.stringMatching(/^Earlier import \(/),
          file_format: "legacy",
          legacy: true,
          imported_count: 2,
        }),
      ]);
      // Update 036 records one summary row when existing accounts receive UIDs.
      expect(
        (
          await legacy.query(
            "select count(*)::integer n from audit_log where action<>'migration.account_uids_assigned'",
          )
        ).rows[0].n,
      ).toBe(audits);
    } finally {
      await legacy.close();
    }
  }, 30000);
});
