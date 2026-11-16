import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 067 on a database at 066: no record, trigger, grant or other
// function changes. A lead reassigned earlier keeps its records; its new
// agent no longer gets "Previously not interested" or the earlier open deal,
// and keeps the commitments that already moved with the lead. The next
// reassignment cancels the earlier agent's commitments. Applying it again
// changes nothing; it refuses to run before 066 or on a function it does not
// expect, changing nothing.
const admin = "67200000-0000-4000-8000-000000000001",
  ali = "67200000-0000-4000-8000-000000000002",
  sara = "67200000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "067_fresh_reassigned_leads.sql";
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
const changed = ["handover_lead", "workspace_item", "lead_workspace"];
async function database(upTo) {
  const pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < upTo) await pg.exec(await migration(name));
  return pg;
}
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const check = async (on = db) =>
  (
    await on.query(
      await readFile(
        new URL(
          "../../supabase/check-fresh-reassignment-067.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    )
  ).rows[0];
const snapshot = async (except = []) => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))||':'||coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname<>all($1)",
      [except],
    )
  ).s,
  grants: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,coalesce(p.proacl::text,'')) s from pg_proc p where p.pronamespace='public'::regnamespace and p.proname=any($1)",
      [changed],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
// What the lead's agent sees: the earlier result, and the kinds of records
// left in their workspace.
const seen = async (lead) => ({
  previous: (
    await one("select public.lead_workspace($1)->>'previous_result' r", [lead])
  ).r,
  kinds: (
    await db.query(
      `select distinct k from (
         select 'followups' k,public.workspace_state(x) s from followups x where lead_id=$1
         union all select 'visits',public.workspace_state(x) from visits x where lead_id=$1
         union all select 'deals',public.workspace_state(x) from deals x where lead_id=$1
       ) r where s<>'hidden' order by k`,
      [lead],
    )
  ).rows.map((r) => r.k),
});
let lead, property;
beforeAll(async () => {
  db = await database("067");
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now()),($3,'sara@gmail.com',now())",
    [admin, ali, sara],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin, ali],
  );
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Park View','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
  lead = (
    await one("select (create_lead($1::jsonb,'+923000067101',$2,'t')).id", [
      JSON.stringify({ name: "Buyer moved", assigned_agent: ali }),
      admin,
    ])
  ).id;
  // Ali spoke to him (Not interested), promised a follow-up, booked a
  // visit and opened a deal; then the lead went to Sara, before 067.
  await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    ali,
    JSON.stringify({
      answered: true,
      started_at: new Date(Date.now() - 60000).toISOString(),
      duration_seconds: 60,
      outcome: "Not interested",
      deal_tags: [],
    }),
  ]);
  await db.query(
    "insert into followups(lead_id,agent_id,due_at,notes) values($1,$2,now()+interval '1 day','Ali: call back')",
    [lead, ali],
  );
  await db.query(
    "insert into visits(lead_id,agent_id,property_id,scheduled_at) values($1,$2,$3,now()+interval '2 days')",
    [lead, ali, property],
  );
  await db.query(
    "insert into deals(lead_id,property_id,agent_id,stage,expected_value) values($1,$2,$3,'negotiation',100)",
    [lead, property, ali],
  );
  await db.query("select admin_assign_leads($1::uuid[],$2,$3,'t')", [
    [lead],
    admin,
    sara,
  ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 067 on a database at 066", () => {
  it("changes no record, trigger, grant or other function; the new agent loses the earlier result and deal, not what already moved", async () => {
    expect(await check()).toMatchObject({
      release_stage: "at 066, ready for 067",
      earlier_pending_followups_with_new_agents: 1,
      earlier_scheduled_visits_with_new_agents: 1,
      earlier_open_deals_hidden_after_067: 1,
      earlier_results_shown_to_new_agents: 1,
      cancelled_by_reassignment: 0,
      transactions_open_over_1_min: 0,
    });
    expect(await seen(lead)).toEqual({
      previous: "not_interested",
      kinds: ["deals", "followups", "visits"],
    });
    const before = await snapshot(changed);
    await db.exec(await migration(file));
    expect(await snapshot(changed)).toEqual(before);
    // Commitments that already moved stay until done; the earlier result
    // and the untouched earlier deal no longer show.
    expect(await seen(lead)).toEqual({
      previous: null,
      kinds: ["followups", "visits"],
    });
    expect(await check()).toMatchObject({
      release_stage: "at 067",
      earlier_pending_followups_with_new_agents: 1,
      earlier_scheduled_visits_with_new_agents: 1,
      earlier_results_shown_to_new_agents: 0,
      cancelled_by_reassignment: 0,
    });
    // The next reassignment cancels them.
    await db.query("select assign_lead($1,$2,$3,'t')", [lead, admin, ali]);
    expect(
      await one(
        "select (select status from followups where lead_id=$1) f,(select status from visits where lead_id=$1) v",
        [lead],
      ),
    ).toEqual({ f: "cancelled", v: "cancelled" });
    expect(await check()).toMatchObject({
      earlier_pending_followups_with_new_agents: 0,
      earlier_scheduled_visits_with_new_agents: 0,
      cancelled_by_reassignment: 2,
    });
  });
  it("changes nothing when applied again", async () => {
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
  });
  it("refuses to run before 066", async () => {
    const old = await database("066");
    try {
      await expect(old.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 066 before update 067.",
      );
    } finally {
      await old.close();
    }
  }, 120000);
  it("refuses a function it does not expect, changing nothing", async () => {
    const other = await database("067");
    try {
      const body = (
        await other.query(
          "select pg_get_functiondef('public.lead_workspace(uuid)'::regprocedure) d",
        )
      ).rows[0].d;
      await other.exec(
        body.replace("then 'not_interested' end", () => "then 'declined' end"),
      );
      const handover = (
        await other.query(
          "select md5(pg_get_functiondef('public.handover_lead(uuid,uuid,uuid,text)'::regprocedure)) h",
        )
      ).rows[0].h;
      await expect(other.exec(await migration(file))).rejects.toThrow(
        "Update 067 found an unexpected version of public.lead_workspace",
      );
      await other.exec("rollback");
      expect(
        (
          await other.query(
            "select md5(pg_get_functiondef('public.handover_lead(uuid,uuid,uuid,text)'::regprocedure)) h",
          )
        ).rows[0].h,
      ).toBe(handover);
      expect((await check(other)).release_stage).toBe("at 066, ready for 067");
    } finally {
      await other.close();
    }
  }, 120000);
});
