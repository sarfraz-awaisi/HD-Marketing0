import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// Update 049 in the normal forward-only order: a database at 048 holding
// accounts, a lead, a call, a follow-up and a note, then 049. Every existing
// row must be unchanged, and 049 must refuse to run before 048.
const admin = "49100000-0000-4000-8000-000000000001",
  agent = "49100000-0000-4000-8000-000000000002";
const dir = new URL("../../supabase/migrations/", import.meta.url);
// Times relative to now: an agent may log a call only within the last 48 hours.
const hoursFromNow = (h) => new Date(Date.now() + h * 3600e3).toISOString();
const migration = async (file) =>
  (await readFile(new URL(file, dir), "utf8")).replace(
    "create extension if not exists pgcrypto;",
    "",
  );
const setup =
  "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);";
let db;
const one = async (text, args = []) => (await db.query(text, args)).rows[0];
// Each public, auth and storage table: its row count and a hash of every row.
const snapshot = async () =>
  (
    await one(
      "select jsonb_object_agg(t,n||':'||h) s from (select format('%I.%I',schemaname,tablename) t,(xpath('/row/n/text()',query_to_xml(format('select count(*) n from %I.%I',schemaname,tablename),false,true,'')))[1]::text n,(xpath('/row/h/text()',query_to_xml(format('select md5(coalesce(string_agg(x::text,''|'' order by x::text),'''')) h from %I.%I x',schemaname,tablename),false,true,'')))[1]::text h from pg_tables where schemaname in ('public','auth','storage')) s",
    )
  ).s;
beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(setup);
  for (const file of (await readdir(dir)).sort())
    if (file < "049") await db.exec(await migration(file));
  await db.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@gmail.com',now()),($2,'ali@gmail.com',now())",
    [admin, agent],
  );
  await db.query(
    "update profiles set active=true,name=case id when $1 then 'Owner' else 'Ali Agent' end,role=case id when $1 then 'admin' else 'agent' end",
    [admin],
  );
  const lead = (
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name: "Existing buyer", assigned_agent: agent }),
      "+923001234567",
      admin,
    ])
  ).id;
  await db.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
    lead,
    agent,
    JSON.stringify({
      answered: true,
      started_at: hoursFromNow(-1),
      duration_seconds: 60,
      outcome: "Interested",
      notes: "",
      deal_tags: [],
    }),
  ]);
  for (const [table, data] of [
    ["followups", { lead_id: lead, due_at: hoursFromNow(96) }],
    ["notes", { lead_id: lead, body: "Prefers DHA" }],
  ])
    await db.query("select crm_mutate($1,null,$2::jsonb,$3,'t')", [
      table,
      JSON.stringify(data),
      agent,
    ]);
}, 120000);
afterAll(async () => {
  await db?.close();
});

describe("update 049 on a database at 048", () => {
  it("adds the dealer network and leaves every existing row unchanged", async () => {
    const before = await snapshot();
    await db.exec(await migration("049_dealer_affiliate_network.sql"));
    const after = await snapshot();
    expect(after["public.dealers"]).toBe("0:d41d8cd98f00b204e9800998ecf8427e");
    delete after["public.dealers"];
    expect(after).toEqual(before);
  });
  it("works at once, and applying it again changes nothing", async () => {
    const created = (
      await one(
        "select public.dealer_create($1,$2::jsonb,gen_random_uuid(),'t') r",
        [
          agent,
          JSON.stringify({
            name: "First Dealer",
            phone: "0300 7654321",
            address: "Main Boulevard",
          }),
        ],
      )
    ).r;
    expect(created).toMatchObject({
      status: "pending",
      phone: "+923007654321",
      reference: "DL-000001",
    });
    const before = await snapshot();
    await db.exec(await migration("049_dealer_affiliate_network.sql"));
    expect(await snapshot()).toEqual(before);
  });
  it("refuses to run before update 048", async () => {
    const early = new PGlite({ extensions: { pg_trgm } });
    try {
      await early.exec(setup);
      for (const file of (await readdir(dir)).sort())
        if (file < "048") await early.exec(await migration(file));
      await expect(
        early.exec(await migration("049_dealer_affiliate_network.sql")),
      ).rejects.toThrow("Apply CRM updates up to 048 before update 049.");
      // The failed update leaves its transaction open; the session ends it.
      await early.exec("rollback");
      expect(
        (await early.query("select to_regclass('public.dealers') t")).rows[0].t,
      ).toBe(null);
    } finally {
      await early.close();
    }
  }, 120000);
});
