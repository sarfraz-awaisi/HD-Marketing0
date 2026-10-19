import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
let pg;
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',last_sign_in_at timestamptz);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
}, 60000);
afterAll(async () => {
  await pg?.close();
});
// Whole-schema sweep after every migration: browsers reach CRM data only
// through the authorized Express API, never PostgREST tables or functions.
// PostgreSQL grants EXECUTE to PUBLIC by default, so any function a migration
// forgot to revoke is caught here (Supabase's default grants behave alike).
describe("browser roles across the entire CRM schema", () => {
  it.each(["anon", "authenticated"])(
    "%s cannot execute any CRM function",
    async (role) => {
      const { rows } = await pg.query(
        `select p.oid::regprocedure::text signature from pg_proc p
         where p.pronamespace in ('public'::regnamespace,'crm_private'::regnamespace)
           and not exists(select 1 from pg_depend d where d.objid=p.oid and d.deptype='e')
           -- PostgreSQL refuses direct calls to trigger functions.
           and p.prorettype<>'trigger'::regtype
           and has_function_privilege($1,p.oid,'execute') order by 1`,
        [role],
      );
      expect(rows.map((r) => r.signature)).toEqual([]);
    },
  );
  it.each(["anon", "authenticated"])(
    "%s has no privilege on any CRM table or sequence",
    async (role) => {
      const { rows } = await pg.query(
        `select format('%I.%I',n.nspname,c.relname) relation from pg_class c
         join pg_namespace n on n.oid=c.relnamespace
         where n.nspname in ('public','crm_private') and c.relkind in ('r','p','v','m','S')
           and (has_table_privilege($1,c.oid,'select,insert,update,delete')
             or (c.relkind='S' and has_sequence_privilege($1,c.oid,'usage')))
         order by 1`,
        [role],
      );
      expect(rows.map((r) => r.relation)).toEqual([]);
    },
  );
  // crm_private is not exposed by the API and browsers cannot use the schema
  // (checked below), so RLS is required on every table in the public schema.
  it("keeps row level security enabled on every public CRM table", async () => {
    const { rows } = await pg.query(
      `select format('%I.%I',n.nspname,c.relname) relation from pg_class c
       join pg_namespace n on n.oid=c.relnamespace
       where n.nspname='public' and c.relkind in ('r','p') and not c.relrowsecurity
       order by 1`,
    );
    expect(rows.map((r) => r.relation)).toEqual([]);
  });
  it.each(["anon", "authenticated"])(
    "%s cannot use the private schema",
    async (role) => {
      expect(
        (
          await pg.query(
            "select has_schema_privilege($1,'crm_private','usage') allowed",
            [role],
          )
        ).rows[0].allowed,
      ).toBe(false);
    },
  );
});
