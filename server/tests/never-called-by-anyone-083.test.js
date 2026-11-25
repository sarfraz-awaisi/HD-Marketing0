import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 083 on a database at 082, as production is: Never called becomes
// never called by anyone. No record, trigger or other function changes;
// rerunning changes nothing; it refuses to run before 082.
const admin = "83000000-0000-4000-8000-000000000001",
  abru = "83000000-0000-4000-8000-000000000002",
  alisha = "83000000-0000-4000-8000-000000000003";
const migration = new URL(
  "../../supabase/migrations/083_never_called_by_anyone.sql",
  import.meta.url,
);
const checkFile = new URL(
  "../../supabase/check-never-called-083.sql",
  import.meta.url,
);
let t;
beforeAll(async () => {
  t = await startCrmDatabase({ before: "083" });
  await resetPeople(t.pg, [admin, abru, alisha]);
}, 60000);
afterAll(async () => {
  await t?.pg.close();
});
const leads = async (n, agent) => {
  const ids = (
    await t.all(
      "select (create_lead(jsonb_build_object('name','Buyer '||i),'+92303'||lpad(i::text,7,'0'),$1,'fixture')).id from generate_series($2::int,$3::int) i order by i",
      [admin, n[0], n[1]],
    )
  ).map((r) => r.id);
  await t.pg.query("select admin_assign_leads($1,$2,$3,'t')", [
    ids,
    admin,
    agent,
  ]);
  return ids;
};
const call = (lead, by) =>
  t.pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    by,
    JSON.stringify({
      answered: false,
      started_at: new Date(Date.now() - 600000).toISOString(),
      duration_seconds: 0,
      outcome: "No answer",
      notes: "Called",
      deal_tags: [],
    }),
  ]);
const never = async () =>
  (
    await t.all(
      "select id from active_leads l where lead_never_called(l.id) order by id",
    )
  ).map((r) => r.id);
const snapshot = async () => ({
  rows: (
    await t.one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private')) s",
    )
  ).s,
  functions: (
    await t.one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname not in ('lead_never_called','admin_distribute_never_called')",
    )
  ).s,
  triggers: (
    await t.one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal",
    )
  ).s,
});
const check = async () => t.one(await readFile(checkFile, "utf8"));

describe("update 083 on a database at 082", () => {
  it("leaves out leads anyone has called, changes no record or other function, and reruns without change", async () => {
    const [calledEarlier, byAdmin, fresh] = await leads([1, 3], abru);
    await call(calledEarlier, abru);
    await t.pg.query("select admin_assign_leads($1,$2,$3,'t')", [
      [calledEarlier],
      admin,
      alisha,
    ]);
    await call(byAdmin, admin);
    expect(await check()).toMatchObject({
      release_stage: "at 082, ready for 083",
      never_called_now: 3,
    });
    expect(await never()).toEqual([calledEarlier, byAdmin, fresh].sort());
    const before = await snapshot();
    const sql = await readFile(migration, "utf8");
    await t.pg.exec(sql);
    expect(await snapshot()).toEqual(before);
    expect(await never()).toEqual([fresh]);
    expect(await check()).toMatchObject({
      release_stage: "at 083",
      assigned_leads: 3,
      never_called_now: 1,
      transactions_open_over_1_min: 0,
    });
    const after = (
      await t.one(
        "select md5(pg_get_functiondef('public.lead_never_called(uuid)'::regprocedure))||md5(pg_get_functiondef('public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)'::regprocedure)) f",
      )
    ).f;
    await t.pg.exec(sql);
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await t.one(
          "select md5(pg_get_functiondef('public.lead_never_called(uuid)'::regprocedure))||md5(pg_get_functiondef('public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)'::regprocedure)) f",
        )
      ).f,
    ).toBe(after);
    for (const role of ["anon", "authenticated"])
      expect(
        await t.one(
          "select has_function_privilege($1,'public.admin_distribute_never_called(uuid,uuid[],uuid[],boolean,text,text)','execute') d,has_function_privilege($1,'public.lead_never_called(uuid)','execute') h",
          [role],
        ),
      ).toEqual({ d: false, h: false });
  });
  it("refuses to run before 082", async () => {
    const at081 = await startCrmDatabase({ before: "082" });
    try {
      await expect(
        at081.pg.exec(await readFile(migration, "utf8")),
      ).rejects.toThrow(/Apply CRM updates up to 082 before update 083/);
    } finally {
      await at081.pg.close();
    }
  }, 60000);
});
