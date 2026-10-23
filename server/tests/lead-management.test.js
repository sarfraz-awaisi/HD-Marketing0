import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir } from "node:fs/promises";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
let pg;
const admin = "f0290000-0000-4000-8000-000000000001",
  agent = "f0290000-0000-4000-8000-000000000002";
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const dir = new URL("../../supabase/migrations/", import.meta.url);
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz default now(),deleted_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  for (const file of files.filter((f) => f < "029"))
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await pg.query(
    "insert into auth.users(id,email) values($1,'admin@example.test'),($2,'agent@example.test')",
    [admin, agent],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end",
    [admin],
  );
  await pg.query(
    "insert into leads(name,masked_phone,created_at,assigned_agent) values('Newer','+92******001','2026-01-02',$1),('Oldest','+92******002','2026-01-01',$1)",
    [agent],
  );
  for (const file of files.filter((f) => f >= "029"))
    await pg.exec(await readFile(new URL(file, dir), "utf8"));
}, 30000);
afterAll(async () => pg?.close());
describe("permanent lead identity", () => {
  it("backfills by creation time and uses increasing immutable identities", async () => {
    expect(
      (await pg.query("select name,lead_no::int from leads order by lead_no"))
        .rows,
    ).toEqual([
      { name: "Oldest", lead_no: 1 },
      { name: "Newer", lead_no: 2 },
    ]);
    const row = await one(
      "insert into leads(name,masked_phone) values('Next','+92******003') returning id,lead_no::int",
    );
    expect(row.lead_no).toBe(3);
    await expect(
      pg.query("update leads set lead_no=100 where id=$1", [row.id]),
    ).rejects.toBeTruthy();
    await expect(
      pg.query("insert into leads(name,lead_no) values('Forged',99)"),
    ).rejects.toBeTruthy();
  });
  it("uses one stored identity in both portals and counts all authorized leads", async () => {
    const range = ["2026-01-01", "2027-01-01"];
    expect(
      (
        await one("select crm_metrics($1,$2,$3,null,null) metrics", [
          admin,
          ...range,
        ])
      ).metrics.total_leads,
    ).toBe(3);
    expect(
      (
        await one("select crm_metrics($1,$2,$3,null,null) metrics", [
          agent,
          ...range,
        ])
      ).metrics.total_leads,
    ).toBe(2);
  });
});

describe("bulk lead assignment", () => {
  it("assigns 500 leads, skips existing owners, transfers pending work and audits counts", async () => {
    const ids = (
      await pg.query(
        "insert into leads(name,masked_phone) select 'Batch '||i,'+92******000' from generate_series(1,500)i returning id",
      )
    ).rows.map((r) => r.id);
    const call = async (mode, target, actor = admin) =>
      (
        await one("select assign_leads_bulk($1,$2,$3,$4,$5) result", [
          ids,
          actor,
          mode,
          target,
          "bulk-fixture",
        ])
      ).result;
    expect(await call("agent", agent)).toMatchObject({
      assigned: 500,
      skipped: 0,
      failed: 0,
    });
    const count = (
      await one(
        "select count(*)::int n from assignments where lead_id=any($1)",
        [ids],
      )
    ).n;
    expect(await call("agent", agent)).toMatchObject({
      assigned: 0,
      skipped: 500,
      failed: 0,
    });
    expect(
      (
        await one(
          "select count(*)::int n from assignments where lead_id=any($1)",
          [ids],
        )
      ).n,
    ).toBe(count);
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now())",
      [ids[0], agent],
    );
    expect(await call("unassign", null)).toMatchObject({ assigned: 500 });
    expect(
      (await one("select agent_id from followups where lead_id=$1", [ids[0]]))
        .agent_id,
    ).toBe(admin);
    await expect(call("agent", admin)).rejects.toMatchObject({ code: "22023" });
    await expect(call("unassign", null, agent)).rejects.toMatchObject({
      code: "42501",
    });
    const audit = (
      await one(
        "select metadata from audit_log where action='lead.bulk_assigned' order by created_at desc limit 1",
      )
    ).metadata;
    expect(Object.keys(audit).sort()).toEqual([
      "assigned",
      "failed",
      "skipped",
    ]);
  });

  it("rotates a full batch evenly despite transaction timestamp ties and excludes disabled agents", async () => {
    await pg.exec("begin");
    try {
      const second = "f0290000-0000-4000-8000-000000000003";
      const disabled = "f0290000-0000-4000-8000-000000000004";
      await pg.query(
        "insert into auth.users(id,email) values($1,'second@example.test'),($2,'disabled@example.test')",
        [second, disabled],
      );
      await pg.query("update profiles set active=true where id=$1", [second]);
      await pg.query("update profiles set active=false where id=$1", [
        disabled,
      ]);
      const ids = (
        await pg.query(
          "insert into leads(name,masked_phone) select 'Rotation '||i,'+92******000' from generate_series(1,500)i returning id",
        )
      ).rows.map((row) => row.id);
      const result = (
        await one(
          "select assign_leads_bulk($1,$2,'round_robin',null,$3) result",
          [ids, admin, "round-robin-fixture"],
        )
      ).result;
      expect(result).toMatchObject({ assigned: 500, skipped: 0, failed: 0 });
      expect(result.results).toHaveLength(500);
      expect(
        (
          await pg.query(
            "select assigned_agent,count(*)::int n from leads where id=any($1) group by assigned_agent order by assigned_agent",
            [ids],
          )
        ).rows,
      ).toEqual([
        { assigned_agent: agent, n: 250 },
        { assigned_agent: second, n: 250 },
      ]);
    } finally {
      await pg.exec("rollback");
    }
  });

  it("keeps incoming social leads private until an administrator explicitly chooses an agent", async () => {
    await pg.exec("begin");
    try {
      const lead = await one(
        "insert into leads(name,masked_phone,meta_pending_assignment) values('Incoming social customer','+92******000',true) returning id",
      );
      expect(
        (
          await one(
            "select assign_leads_bulk($1,$2,'round_robin',null,$3) result",
            [[lead.id], admin, "social-round-robin-fixture"],
          )
        ).result,
      ).toMatchObject({ assigned: 0, skipped: 0, failed: 1 });
      expect(
        await one(
          "select assigned_agent,meta_pending_assignment from leads where id=$1",
          [lead.id],
        ),
      ).toEqual({ assigned_agent: null, meta_pending_assignment: true });
      expect(
        (
          await one("select assign_leads_bulk($1,$2,'agent',$3,$4) result", [
            [lead.id],
            admin,
            agent,
            "social-explicit-fixture",
          ])
        ).result,
      ).toMatchObject({ assigned: 1, skipped: 0, failed: 0 });
      expect(
        await one(
          "select assigned_agent,meta_pending_assignment from leads where id=$1",
          [lead.id],
        ),
      ).toEqual({ assigned_agent: agent, meta_pending_assignment: false });
    } finally {
      await pg.exec("rollback");
    }
  });
});

describe("administrator lead editing", () => {
  it("normalizes private phones, rejects duplicates with only the other HD number and audits without phone values", async () => {
    const lead = (await one("select id from leads where name='Oldest'")).id;
    await pg.query("select update_lead_phone($1,$2,$3,$4)", [
      lead,
      "03001234567",
      admin,
      "phone-fixture",
    ]);
    expect(
      (
        await one(
          "select phone from crm_private.lead_phones where lead_id=$1",
          [lead],
        )
      ).phone,
    ).toBe("+923001234567");
    const other = (await one("select id from leads where name='Newer'")).id;
    await expect(
      pg.query("select update_lead_phone($1,$2,$3,$4)", [
        other,
        "+923001234567",
        admin,
        "duplicate",
      ]),
    ).rejects.toMatchObject({
      code: "23505",
      message: "This number already belongs to HD-000001",
    });
    await expect(
      pg.query("select update_lead_phone($1,$2,$3,$4)", [
        lead,
        "invalid",
        admin,
        "bad",
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await expect(
      pg.query("select update_lead_phone($1,$2,$3,$4)", [
        lead,
        "03001234568",
        agent,
        "forbidden",
      ]),
    ).rejects.toMatchObject({ code: "42501" });
    const audit = await one(
      "select metadata from audit_log where request_id='phone-fixture'",
    );
    expect(JSON.stringify(audit)).not.toMatch(/03001234567|923001234567/);
    await expect(
      pg.query("select edit_lead($1,$2,$3,$4)", [
        other,
        JSON.stringify({ name: "Should roll back", phone: "03001234567" }),
        admin,
        "atomic",
      ]),
    ).rejects.toBeTruthy();
    expect(
      (await one("select name from leads where id=$1", [other])).name,
    ).toBe("Newer");
  });
});

async function customer(suffix, owner = agent) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,$4)).id", [
      JSON.stringify({ name: "Managed " + suffix, assigned_agent: owner }),
      "+92310" + String(suffix).padStart(7, "0"),
      admin,
      "managed-fixture",
    ])
  ).id;
}
async function remove(ids, actor = admin) {
  return (
    await one("select delete_leads($1,$2,$3,$4) result", [
      ids,
      actor,
      "Duplicate or obsolete inquiry",
      "delete-fixture",
    ])
  ).result;
}
describe("recoverable lead deletion", () => {
  it("removes operational visibility and contacts, preserves history and restores the same number unassigned", async () => {
    const id = await customer(1),
      number = (await one("select lead_no from leads where id=$1", [id]))
        .lead_no;
    const f = (
      await one(
        "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()) returning id",
        [id, agent],
      )
    ).id;
    await pg.query(
      "insert into reminders(agent_id,followup_id,due_at) values($1,$2,now())",
      [agent, f],
    );
    await pg.query(
      "insert into notes(lead_id,agent_id,body) values($1,$2,'History retained')",
      [id, agent],
    );
    expect(await remove([id])).toMatchObject({ deleted: 1, failed: 0 });
    expect(
      await one("select count(*)::int n from active_leads where id=$1", [id]),
    ).toEqual({ n: 0 });
    expect(
      (await one("select status from followups where id=$1", [f])).status,
    ).toBe("cancelled");
    expect(
      (
        await one(
          "select count(*)::int n from reminders where followup_id=$1",
          [f],
        )
      ).n,
    ).toBe(0);
    await expect(
      pg.query("select lead_contact_phones($1,$2,$3)", [admin, [id], "denied"]),
    ).rejects.toMatchObject({ code: "P0002" });
    await expect(
      pg.query("select crm_mutate($1,$2,$3,$4,$5)", [
        "leads",
        id,
        JSON.stringify({ name: "Hidden" }),
        admin,
        "denied",
      ]),
    ).rejects.toMatchObject({ code: "P0002" });
    await expect(
      pg.query("select create_lead($1,$2,$3,$4)", [
        JSON.stringify({ name: "Duplicate" }),
        "+923100000001",
        admin,
        "duplicate",
      ]),
    ).rejects.toMatchObject({
      code: "23505",
      message: `This number is in Deleted leads (HD-${String(number).padStart(6, "0")}). Restore it instead.`,
    });
    const bin = (
      await one("select deleted_leads_page($1,1,20,$2) data", [
        admin,
        "Managed 1",
      ])
    ).data;
    expect(bin.data.some((r) => r.id === id)).toBe(true);
    expect(
      (
        await one("select restore_leads($1,$2,$3) result", [
          [id],
          admin,
          "restore",
        ])
      ).result,
    ).toMatchObject({ restored: 1, failed: 0 });
    expect(
      await one(
        "select lead_no,assigned_agent,deleted_at from leads where id=$1",
        [id],
      ),
    ).toEqual({ lead_no: number, assigned_agent: null, deleted_at: null });
    expect(
      (await one("select body from notes where lead_id=$1", [id])).body,
    ).toBe("History retained");
    await expect(remove([id], agent)).rejects.toMatchObject({ code: "42501" });
  });
  it("hides linked KYC and excludes deleted leads from all dashboard/report/leaderboard aggregates", async () => {
    const id = await customer(2),
      property = (
        await one(
          "insert into properties(title,location,price,type,area,area_unit) values('Fixture','Lahore',10,'House',5,'marla') returning id",
        )
      ).id;
    await pg.query(
      "insert into calls(lead_id,agent_id,status,ended_at) values($1,$2,'completed',now())",
      [id, agent],
    );
    await pg.query(
      "insert into visits(lead_id,agent_id,property_id,scheduled_at,status) values($1,$2,$3,now(),'scheduled')",
      [id, agent, property],
    );
    const doc = (
      await one("select save_knowledge_document(null,$1,$2,$3) doc", [
        JSON.stringify({
          title: "KYC fixture",
          category: "client_kyc",
          content: "Fixture",
          lead_id: id,
        }),
        admin,
        "doc",
      ])
    ).doc.id;
    const before = (
      await one(
        "select crm_metrics($1,now()-interval '1 day',now()+interval '1 day',null,null) data",
        [admin],
      )
    ).data;
    await remove([id]);
    const after = (
      await one(
        "select crm_metrics($1,now()-interval '1 day',now()+interval '1 day',null,null) data",
        [admin],
      )
    ).data;
    expect(after.total_leads).toBe(before.total_leads - 1);
    expect(after.completed_calls).toBe(before.completed_calls - 1);
    await expect(
      pg.query("select read_knowledge_document($1,$2)", [doc, admin]),
    ).rejects.toMatchObject({ code: "P0002" });
    const list = (
      await one(
        "select knowledge_documents_page($1,1,20,'','',null,false) data",
        [admin],
      )
    ).data;
    expect(list.data.map((r) => r.id)).not.toContain(doc);
    const dashboard = (
      await one(
        "select dashboard_snapshot($1,now()-interval '1 day',now()+interval '1 day') data",
        [admin],
      )
    ).data;
    expect(dashboard.visits.map((r) => r.lead_id)).not.toContain(id);
    const oldLeaderboard = (
      await one(
        "select crm_leaderboard($1,now()-interval '1 day',now()+interval '1 day') data",
        [admin],
      )
    ).data;
    expect(
      oldLeaderboard.find((r) => r.name === "Team member").completed_calls,
    ).toBe(0);
  });
  it("keeps won deals and handles both file deletion modes with whole-file restoration", async () => {
    const file = (
      await one(
        "insert into lead_imports(file_name,file_format,total_rows,imported_count,created_by) values('keep.csv','csv',1,1,$1) returning id",
        [admin],
      )
    ).id;
    const id = await customer(3);
    await pg.query("update leads set import_id=$1 where id=$2", [file, id]);
    await pg.query(
      "select delete_lead_import($1,$2,'file_only','Old upload',$3)",
      [file, admin, "file"],
    );
    expect(
      await one("select import_id,deleted_at from leads where id=$1", [id]),
    ).toEqual({ import_id: null, deleted_at: null });
    expect(
      (await one("select lead_import_summary($1,$2) data", [file, admin])).data,
    ).toBeNull();
    const second = (
      await one(
        "insert into lead_imports(file_name,file_format,total_rows,imported_count,created_by) values('remove.xlsx','xlsx',2,2,$1) returning id",
        [admin],
      )
    ).id;
    const removable = await customer(4),
      won = await customer(5);
    await pg.query("update leads set import_id=$1 where id=any($2)", [
      second,
      [removable, won],
    ]);
    const property = (await one("select id from properties limit 1")).id;
    await pg.query(
      "insert into deals(lead_id,property_id,agent_id,stage,expected_value,close_date) values($1,$2,$3,'won',10,current_date)",
      [won, property, agent],
    );
    expect(await remove([won])).toMatchObject({
      deleted: 0,
      failed: 1,
      results: [{ reason: "Has a won deal" }],
    });
    expect(
      (
        await one(
          "select delete_lead_import($1,$2,'file_and_leads','Old upload',$3) data",
          [second, admin, "file"],
        )
      ).data,
    ).toMatchObject({ deleted: 1, failed: 1 });
    expect(
      (
        await one("select lead_imports_page($1,1,20,'') data", [admin])
      ).data.data.map((r) => r.id),
    ).not.toContain(second);
    expect(
      (await one("select import_id from leads where id=$1", [won])).import_id,
    ).toBeNull();
    expect(
      (
        await one("select restore_lead_import($1,$2,$3) data", [
          second,
          admin,
          "restore-file",
        ])
      ).data.restored,
    ).toBe(1);
    expect(
      await one("select deleted_at,assigned_agent from leads where id=$1", [
        removable,
      ]),
    ).toEqual({ deleted_at: null, assigned_agent: null });
  });
  it("purges only expired leads, retains audit rows, queues recordings and never reuses their HD numbers", async () => {
    const old = await customer(6),
      recent = await customer(7),
      no = (await one("select lead_no from leads where id=$1", [old])).lead_no;
    const call = (
      await one(
        "insert into calls(lead_id,agent_id,status) values($1,$2,'completed') returning id",
        [old, agent],
      )
    ).id;
    await pg.query(
      "insert into crm_private.recordings(call_id,storage_path) values($1,'fixture/recording')",
      [call],
    );
    await remove([old, recent]);
    await pg.query(
      "update leads set deleted_at=now()-interval '31 days' where id=$1",
      [old],
    );
    expect(
      (
        await one("select restore_leads($1,$2,$3) data", [
          [old],
          admin,
          "too-late",
        ])
      ).data.failed,
    ).toBe(1);
    expect((await one("select purge_deleted_leads(30) data")).data.purged).toBe(
      1,
    );
    expect(
      (await one("select count(*)::int n from leads where id=$1", [old])).n,
    ).toBe(0);
    expect(
      (await one("select count(*)::int n from leads where id=$1", [recent])).n,
    ).toBe(1);
    expect(
      (
        await one(
          "select count(*)::int n from crm_private.lead_recording_cleanup where storage_path='fixture/recording'",
        )
      ).n,
    ).toBe(1);
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where action='lead.purged'",
        )
      ).n,
    ).toBe(1);
    expect(
      (await one("select purge_deleted_leads(30) data")).data.skipped,
    ).toBe(true);
    const replacement = await customer(6);
    expect(
      BigInt(
        (await one("select lead_no from leads where id=$1", [replacement]))
          .lead_no,
      ),
    ).toBeGreaterThan(BigInt(no));
  });
});

describe("deletion boundaries and service-only access", () => {
  it("limits bulk operations, rejects disabled recipients and records mass-deletion alerts", async () => {
    const ids = (
      await pg.query("select id from leads where name like 'Batch %' limit 51")
    ).rows.map((r) => r.id);
    await pg.query("update profiles set active=false where id=$1", [agent]);
    await expect(
      pg.query("select assign_leads_bulk($1,$2,$3,$4,$5)", [
        ids,
        admin,
        "agent",
        agent,
        "disabled",
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    await pg.query("update profiles set active=true where id=$1", [agent]);
    await expect(
      pg.query("select delete_leads($1,$2,$3,$4)", [
        [...ids, ids[0]],
        admin,
        "Reason",
        "duplicate",
      ]),
    ).rejects.toMatchObject({ code: "22023" });
    expect(await remove(ids)).toMatchObject({ deleted: 51 });
    expect(
      (
        await one(
          "select count(*)::int n from security_alerts where type='mass_lead_deletion'",
        )
      ).n,
    ).toBe(1);
    expect(
      (
        await one(
          "select crm_metrics($1,now()-interval '1 day',now()+interval '1 day',null,null) data",
          [admin],
        )
      ).data.deleted_today,
    ).toBeGreaterThan(50);
    for (const role of ["anon", "authenticated"])
      for (const signature of [
        "delete_leads(uuid[],uuid,text,text)",
        "restore_leads(uuid[],uuid,text)",
        "purge_deleted_leads(integer)",
        "edit_lead(uuid,jsonb,uuid,text)",
        "assign_leads_bulk(uuid[],uuid,text,uuid,text)",
      ])
        expect(
          (
            await one(
              "select has_function_privilege($1,$2,'execute') allowed",
              [role, "public." + signature],
            )
          ).allowed,
        ).toBe(false);
  });
  it("purges at most 200 expired leads per daily run", async () => {
    await pg.exec(
      "insert into leads(name,masked_phone,deleted_at,deleted_by,delete_reason,deleted_batch) select 'Purge batch '||i,'+92******000',now()-interval '31 days','f0290000-0000-4000-8000-000000000001','Retention fixture',gen_random_uuid() from generate_series(1,205)i;update crm_private.lead_purge_runs set last_run_at=now()-interval '2 days';",
    );
    expect((await one("select purge_deleted_leads(30) data")).data.purged).toBe(
      200,
    );
    expect(
      (
        await one(
          "select count(*)::int n from leads where name like 'Purge batch %'",
        )
      ).n,
    ).toBe(5);
  });
});

function database() {
  return {
    auth: {
      getUser: async (token) => ({
        data: {
          user: [admin, agent].includes(token)
            ? { id: token, email_confirmed_at: "2026-10-01" }
            : null,
        },
      }),
    },
    rpc: async (name, args = {}) => {
      try {
        return {
          data: (
            await one(
              `select public.${name}(${Object.keys(args)
                .map((key, i) => `${key}=>$${i + 1}`)
                .join(",")}) value`,
              Object.values(args).map((v) =>
                v && typeof v === "object" && !Array.isArray(v)
                  ? JSON.stringify(v)
                  : v,
              ),
            )
          ).value,
        };
      } catch (error) {
        return { error: { code: error.code, message: error.message } };
      }
    },
    from(table) {
      let joins = "",
        fields = "r.*",
        clauses = [],
        values = [],
        sort = [],
        cap = Infinity,
        start = 0;
      const field = (key) =>
        key.startsWith("followups.leads.")
          ? "l." + key.split(".").at(-1)
          : key.startsWith("leads.")
            ? "l." + key.slice(6)
            : "r." + key;
      const add = (key, op, value) => {
        values.push(value);
        clauses.push(`${field(key)} ${op} $${values.length}`);
        return q;
      };
      async function run() {
        try {
          const rows = (
            await pg.query(
              `select ${fields} from public.${table} r${joins}${clauses.length ? " where " + clauses.join(" and ") : ""}${sort.length ? " order by " + sort.join(",") : ""}`,
              values,
            )
          ).rows;
          return {
            data: rows.slice(start, cap === Infinity ? undefined : start + cap),
            count: rows.length,
          };
        } catch (error) {
          return { error: { code: error.code, message: error.message } };
        }
      }
      const q = {
        select(value = "*") {
          if (value.includes("followups!inner")) {
            joins =
              " join followups f on f.id=r.followup_id join leads l on l.id=f.lead_id";
            fields =
              "r.*,jsonb_build_object('lead_id',f.lead_id,'leads',to_jsonb(l)) followups";
          } else if (value.includes("leads!inner")) {
            joins = " join leads l on l.id=r.lead_id";
            fields = "r.*,to_jsonb(l) leads";
          }
          return q;
        },
        eq: (key, value) => add(key, "=", value),
        is: (key, value) => add(key, "is not distinct from", value),
        ilike: (key, value) => add(key, "ilike", value),
        lt: (key, value) => add(key, "<", value),
        lte: (key, value) => add(key, "<=", value),
        gt: (key, value) => add(key, ">", value),
        in: (key, value) => add(key, "= any", value),
        or(value) {
          const match = value.match(/^name\.ilike\.(.+),lead_no\.eq\.(\d+)$/);
          if (!match) throw new Error("Invalid fixture filter");
          values.push(match[1], match[2]);
          clauses.push(
            `(r.name ilike $${values.length - 1} or r.lead_no=$${values.length})`,
          );
          return q;
        },
        order: (key, options) => {
          sort.push(
            field(key) + (options?.ascending === false ? " desc" : " asc"),
          );
          return q;
        },
        limit(value) {
          cap = value;
          return q;
        },
        range(low, high) {
          start = low;
          cap = high - low + 1;
          return run();
        },
        single: async () => {
          const r = await run();
          return { ...r, data: r.data?.[0] };
        },
        maybeSingle: async () => {
          const r = await run();
          return { ...r, data: r.data?.[0] || null };
        },
        then: (resolve, reject) => run().then(resolve, reject),
      };
      return q;
    },
  };
}

describe("lead management HTTP authorization and visibility", () => {
  it("returns 403 for every agent bulk/delete/restore/phone/bin endpoint", async () => {
    const request = (await import("supertest")).default,
      { createApp } = await import("../src/app.js"),
      { trustedMfaFixture } = await import("./trusted-mfa-fixture.js");
    const app = createApp(trustedMfaFixture(database()));
    const id = await customer(20);
    for (const [method, path, body] of [
      ["post", "/leads/assign-bulk", { lead_ids: [id], mode: "unassign" }],
      ["post", "/leads/delete", { lead_ids: [id], reason: "Reason" }],
      ["post", "/leads/restore", { lead_ids: [id] }],
      ["patch", `/leads/${id}/phone`, { phone: "03001234567" }],
      ["get", "/leads/deleted"],
      ["get", "/leads/selection"],
      ["get", "/deleted-lead-imports"],
      [
        "delete",
        `/lead-imports/${id}`,
        { mode: "file_only", reason: "Reason" },
      ],
    ]) {
      let req = request(app)
        [method]("/api" + path)
        .set("Authorization", "Bearer " + agent);
      if (body) req = req.send(body);
      expect((await req).status).toBe(403);
    }
  });
  it("shows the same HD identity for both roles, searches by either form, reassigns and hides deleted direct IDs and all activity APIs", async () => {
    const request = (await import("supertest")).default,
      { createApp } = await import("../src/app.js"),
      { trustedMfaFixture } = await import("./trusted-mfa-fixture.js");
    const app = createApp(trustedMfaFixture(database())),
      id = await customer(21),
      number = (await one("select lead_no from leads where id=$1", [id]))
        .lead_no;
    const get = (path, actor = admin) =>
      request(app)
        .get("/api" + path)
        .set("Authorization", "Bearer " + actor);
    for (const actor of [admin, agent]) {
      for (const search of [
        String(number),
        "HD-" + String(number).padStart(6, "0"),
      ]) {
        const r = await get("/leads?search=" + search, actor);
        expect(r.status).toBe(200);
        expect(
          r.body.data.some(
            (row) => row.id === id && String(row.lead_no) === String(number),
          ),
        ).toBe(true);
      }
    }
    expect((await get("/leads/selection?search=Managed")).status).toBe(200);
    const post = (path, body) =>
      request(app)
        .post("/api" + path)
        .set("Authorization", "Bearer " + admin)
        .send(body);
    expect(
      (
        await post("/leads/assign-bulk", {
          lead_ids: [id],
          mode: "unassign",
          actor: agent,
        })
      ).status,
    ).toBe(400);
    expect(
      (await post("/leads/assign-bulk", { lead_ids: [id], mode: "unassign" }))
        .body,
    ).toMatchObject({ assigned: 1 });
    expect((await get("/leads/" + id, agent)).status).toBe(404);
    expect(
      (
        await post("/leads/assign-bulk", {
          lead_ids: [id],
          mode: "agent",
          agent_id: agent,
        })
      ).body.assigned,
    ).toBe(1);
    expect((await get("/leads/" + id, agent)).status).toBe(200);
    const f = (
      await one(
        "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()) returning id",
        [id, agent],
      )
    ).id;
    await pg.query(
      "insert into reminders(agent_id,followup_id,due_at) values($1,$2,now())",
      [agent, f],
    );
    await pg.query(
      "insert into calls(lead_id,agent_id,status) values($1,$2,'completed')",
      [id, agent],
    );
    expect(
      (
        await post("/leads/delete", {
          lead_ids: [id],
          reason: "Obsolete inquiry",
        })
      ).body.deleted,
    ).toBe(1);
    for (const actor of [admin, agent]) {
      for (const suffix of ["", "/timeline", "/phone"])
        expect((await get("/leads/" + id + suffix, actor)).status).toBe(404);
      for (const table of ["leads", "calls", "followups", "visits", "deals"]) {
        const r = await get("/" + table, actor);
        expect(r.status).toBe(200);
        expect(
          r.body.data.some((row) => row.id === id || row.lead_id === id),
        ).toBe(false);
      }
    }
    expect((await get("/reminders", agent)).body).toEqual([]);
    expect(
      (await post("/leads/restore", { lead_ids: [id] })).body.restored,
    ).toBe(1);
    expect((await get("/leads/" + id)).body.lead_no).toBe(Number(number));
  });
});
