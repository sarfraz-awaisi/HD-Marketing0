import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 059 on a database at 058: no existing row or trigger changes; the
// dealer list and details answer as before, plus the new keys (the count of
// waiting changes and none waiting); the old review and edit functions are
// unchanged; applying it again changes nothing; and 059 refuses to run
// before 058.
const admin = "59100000-0000-4000-8000-000000000001",
  ali = "59100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const file = "059_dealer_edit_requests.sql";
const replaced = ["dealer_json", "dealers_page"];
const added = [
  "dealer_values",
  "dealer_change_json",
  "dealer_submit_changes",
  "dealer_change_review",
];
const migration = async (name) =>
  (await readFile(new URL(name, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
const check = async () =>
  one(
    await readFile(
      new URL(
        "../../supabase/check-dealer-edit-requests-059.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
const list = async (actor) =>
  (await one("select dealers_page($1,'{}'::jsonb,1,20) r", [actor])).r;
// What 058 answered, with the keys 059 adds taken out.
const without059 = (page) => ({
  ...page,
  summary: Object.fromEntries(
    Object.entries(page.summary).filter(([k]) => k !== "changes"),
  ),
  data: page.data.map(({ pending_change, last_change, ...d }) => d),
});
const snapshot = async () => ({
  rows: (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage','crm_private') and tablename<>'dealer_change_requests') s",
    )
  ).s,
  functions: (
    await one(
      "select jsonb_object_agg(p.oid::regprocedure::text,md5(pg_get_functiondef(p.oid))) s from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f' and not p.proname=any($1) and p.oid<>coalesce(to_regprocedure('public.dealer_review(uuid,uuid,text,text,timestamptz,text)'),0)",
      [[...replaced, ...added]],
    )
  ).s,
  triggers: (
    await one(
      "select jsonb_agg(tgrelid::regclass::text||'.'||tgname order by 1) s from pg_trigger where not tgisinternal and tgname<>'dealer_change_touch_updated'",
    )
  ).s,
  lists: [without059(await list(admin)), without059(await list(ali))],
});
let pending, approvedDealer;
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const name of (await readdir(dir)).sort())
    if (name < "059") await db.exec(await migration(name));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, ali],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  const create = async (name, phone) =>
    (
      await one("select dealer_create($1,$2::jsonb,$3,'t') d", [
        ali,
        JSON.stringify({ name, phone, address: "Main Boulevard" }),
        randomUUID(),
      ])
    ).d;
  pending = await create("Pending Dealer", "03001110001");
  approvedDealer = await create("Approved Dealer", "03001110002");
  await db.query("select dealer_review($1,$2,'approved',null,'t')", [
    admin,
    approvedDealer.id,
  ]);
  const rejected = await create("Rejected Dealer", "03001110003");
  await db.query("select dealer_review($1,$2,'rejected','Wrong area','t')", [
    admin,
    rejected.id,
  ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 059 on a database at 058", () => {
  it("adds proposed changes without changing any dealer, list or other function", async () => {
    expect(await check()).toMatchObject({
      update_058_installed: true,
      release_stage: "at 058, ready for 059",
      existing_dealers: 3,
      dealers_by_status: { pending: 1, approved: 1, rejected: 1 },
      change_requests: null,
      transactions_open_over_1_min: 0,
    });
    const before = await snapshot();
    await db.exec(await migration(file));
    expect(await snapshot()).toEqual(before);
    expect(await check()).toMatchObject({
      release_stage: "at 059",
      existing_dealers: 3,
      dealers_by_status: { pending: 1, approved: 1, rejected: 1 },
      change_requests: 0,
      browser_function_access_must_be_0: 0,
      browser_table_access_must_be_0: 0,
      server_helper_access_must_be_0: 0,
      server_functions: 4,
    });
    const page = await list(ali);
    expect(page.summary.changes).toBe(0);
    expect(
      page.data.every(
        (d) => d.pending_change === null && d.last_change === null,
      ),
    ).toBe(true);
    // The old review still works, for code released before 059's.
    const r = (
      await one("select dealer_review($1,$2,'approved',null,'t') r", [
        admin,
        pending.id,
      ])
    ).r;
    expect(r.status).toBe("approved");
  });
  it("changes nothing when applied again", async () => {
    const definitions = async () =>
      (
        await one(
          "select jsonb_agg(md5(pg_get_functiondef(p.oid)) order by p.oid::regprocedure::text) s from pg_proc p where p.proname=any($1) or p.proname='dealer_review'",
          [[...replaced, ...added]],
        )
      ).s;
    const before = {
      snapshot: await snapshot(),
      functions: await definitions(),
    };
    await db.exec(await migration(file));
    expect({
      snapshot: await snapshot(),
      functions: await definitions(),
    }).toEqual(before);
  });
  it("refuses to run before update 058", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const name of (await readdir(dir)).sort())
        if (name < "058") await early.exec(await migration(name));
      await expect(early.exec(await migration(file))).rejects.toThrow(
        "Apply CRM updates up to 058 before update 059.",
      );
      await early.exec("rollback");
      expect(
        (
          await early.query(
            "select to_regclass('public.dealer_change_requests') t",
          )
        ).rows[0].t,
      ).toBeNull();
    } finally {
      await early.close();
    }
  });
});
