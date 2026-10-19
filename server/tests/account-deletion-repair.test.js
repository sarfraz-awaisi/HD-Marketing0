import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

const migrations = new URL("../../supabase/migrations/", import.meta.url);
const repair = await readFile(
  new URL(
    "../../supabase/repair-account-deletion-prerequisites.sql",
    import.meta.url,
  ),
  "utf8",
);
const diagnostic = await readFile(
  new URL("../../supabase/check-account-deletion.sql", import.meta.url),
  "utf8",
);
const admin = "a2280000-0000-4000-8000-000000000001";
const agent = "a2280000-0000-4000-8000-000000000002";
const pending = "a2280000-0000-4000-8000-000000000003";
const session = "a".repeat(64),
  unlock = "b".repeat(64);
let pg;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const rpc = async (name, args) =>
  (
    await one(
      `select public.${name}(${Object.keys(args)
        .map((key, i) => `${key}=>$${i + 1}`)
        .join(",")}) value`,
      Object.values(args),
    )
  ).value;

async function install(skip = []) {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,deleted_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of (await readdir(migrations))
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    if (
      Number(file.slice(0, 3)) > 27 ||
      skip.includes(Number(file.slice(0, 3)))
    )
      continue;
    await pg.exec(
      (await readFile(new URL(file, migrations), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  }
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.test',now()),($2,'agent@example.test',now()),($3,'pending@example.test',null)",
    [admin, agent, pending],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end where id in ($1,$2)",
    [admin, agent],
  );
  if (skip.includes(23))
    await pg.query("update profiles set active=true where id=$1", [pending]);
  const lead = (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name: "Fixture customer", assigned_agent: agent }),
      "+923001234567",
      admin,
    ])
  ).id;
  await pg.query(
    "insert into calls(lead_id,agent_id,status,ended_at) values($1,$2,'completed',now())",
    [lead, agent],
  );
  await pg.query(
    "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '1 hour')",
    [lead, agent],
  );
  await rpc("save_accounts_pin", {
    p_actor: admin,
    p_hash: "fixture-" + "x".repeat(80),
    p_request: "fixture",
  });
  await rpc("unlock_accounts", {
    p_actor: admin,
    p_session: session,
    p_version: (
      await one("select version from account_security where admin_id=$1", [
        admin,
      ])
    ).version,
    p_valid: true,
    p_token: unlock,
    p_request: "fixture",
  });
  return lead;
}

async function snapshot() {
  const rows = {};
  for (const table of [
    "leads",
    "crm_private.lead_phones",
    "calls",
    "followups",
    "account_security",
    "account_unlocks",
  ])
    rows[table] = (
      await pg.query(
        `select to_jsonb(t) row from ${table} t order by to_jsonb(t)::text`,
      )
    ).rows;
  return rows;
}

async function laterDefinitions() {
  return (
    await pg.query(
      "select oid::regprocedure::text signature,pg_get_functiondef(oid) body from pg_proc where pronamespace='public'::regnamespace and proname in ('assign_lead','run_crm_job','meta_first_assignment_guard','dashboard_snapshot','property_cover_photos','crm_leaderboard','system_status','mfa_session_state','prepare_account_deletion','finish_account_deletion','guard_account_deletion','guard_deleted_invitation','account_lifecycle','account_detail','accounts_page') order by signature",
    )
  ).rows;
}

afterEach(async () => {
  await pg?.close();
  pg = undefined;
});

describe("repair missing 022/023 prerequisites without downgrading later updates", () => {
  it.each([
    {
      label: "screenshot: both 022 and 023 absent, 027 installed",
      skip: [22, 23],
      handover: false,
      invitations: false,
    },
    {
      label: "022 installed with only 023 absent",
      skip: [23],
      handover: true,
      invitations: false,
    },
    {
      label: "all prerequisites already installed",
      skip: [],
      handover: true,
      invitations: true,
    },
  ])(
    "repairs $label, preserves data and enables complete update 028",
    async ({ skip, handover, invitations }) => {
      const lead = await install(skip);
      expect(await one(diagnostic)).toEqual({
        update_022_handover: handover,
        update_023_invitations: invitations,
        update_027_performance: true,
      });
      const before = await snapshot();
      // All later Meta/performance/monitoring/MFA definitions remain byte-for-byte intact.
      const later = (await laterDefinitions()).filter(
        ({ signature }) => !signature.startsWith("account"),
      );
      await pg.exec(repair);
      await pg.exec(repair);
      expect(await one(diagnostic)).toEqual({
        update_022_handover: true,
        update_023_invitations: true,
        update_027_performance: true,
      });
      expect(await snapshot()).toEqual(before);
      expect(
        (await laterDefinitions()).filter(
          ({ signature }) => !signature.startsWith("account"),
        ),
      ).toEqual(later);
      expect(
        (await one("select active from profiles where id=$1", [pending]))
          .active,
      ).toBe(false);
      await expect(
        pg.query("update profiles set active=true where id=$1", [pending]),
      ).rejects.toMatchObject({ code: "22023" });
      await pg.exec(
        await readFile(new URL("028_account_deletion.sql", migrations), "utf8"),
      );
      const operation = randomUUID();
      const base = {
        p_actor: admin,
        p_session: session,
        p_unlock: unlock,
        p_target: agent,
        p_operation: operation,
        p_request: "fixture-delete",
      };
      expect(
        await rpc("prepare_account_deletion", {
          ...base,
          p_email: "agent@example.test",
        }),
      ).toMatchObject({ deleted: false, leads: 1 });
      expect(
        (await one("select assigned_agent from leads where id=$1", [lead]))
          .assigned_agent,
      ).toBeNull();
      expect(
        (await one("select agent_id from followups where lead_id=$1", [lead]))
          .agent_id,
      ).toBe(admin);
      expect(
        (await one("select agent_id from calls where lead_id=$1", [lead]))
          .agent_id,
      ).toBe(agent);
      const installed = await laterDefinitions();
      await pg.exec(repair);
      expect(await laterDefinitions()).toEqual(installed);
      expect(
        (
          await one(
            "select account_lifecycle(id,active,'confirmed') state from profiles where id=$1",
            [agent],
          )
        ).state,
      ).toBe("deletion_pending");
      // Native Auth is simulated locally; no real user or hosted request is involved.
      await pg.query(
        "update auth.users set deleted_at=now(),email='deleted:'||id::text where id=$1",
        [agent],
      );
      expect(
        await rpc("finish_account_deletion", { ...base, p_success: true }),
      ).toMatchObject({ deleted: true });
      await pg.exec(repair);
      expect(await laterDefinitions()).toEqual(installed);
      expect(
        (await one("select deleted_at from profiles where id=$1", [agent]))
          .deleted_at,
      ).not.toBeNull();
      const page = await rpc("accounts_page", {
        p_actor: admin,
        p_session: session,
        p_unlock: unlock,
        p_page: 1,
        p_limit: 20,
        p_search: "",
        p_role: "",
        p_access: "",
      });
      expect(page.data.map((row) => row.id)).not.toContain(agent);
    },
    30000,
  );

  it("restores a partially missing function and trigger alongside existing invitation data", async () => {
    await install();
    await pg.query(
      "insert into account_invitations(user_id,email,token_hash,state,issued_by,expires_at) values($1,'pending@example.test',$2,'sent',$3,now()+interval '1 hour')",
      [pending, "c".repeat(64), admin],
    );
    const invitations = (await pg.query("select * from account_invitations"))
      .rows;
    await pg.exec(
      "drop function handover_lead(uuid,uuid,uuid,text);drop trigger guard_account_activation on profiles;",
    );
    await pg.exec(repair);
    await pg.exec(repair);
    expect((await pg.query("select * from account_invitations")).rows).toEqual(
      invitations,
    );
    expect(
      (
        await one(
          "select count(*)::int n from pg_trigger where tgrelid='profiles'::regclass and tgname='guard_account_activation'",
        )
      ).n,
    ).toBe(1);
    await expect(
      pg.query("update profiles set active=true where id=$1", [pending]),
    ).rejects.toMatchObject({ code: "22023" });
  }, 30000);

  it("keeps repaired functions and invitation/history storage inaccessible to browser roles", async () => {
    await install([22, 23]);
    await pg.exec(repair);
    for (const role of ["anon", "authenticated"]) {
      for (const signature of [
        "handover_lead(uuid,uuid,uuid,text)",
        "assign_lead_023(uuid,uuid,uuid,text)",
        "update_account_022(uuid,text,text,uuid,jsonb,text)",
        "account_lifecycle(uuid,boolean,text)",
        "issue_account_invitation(uuid,text,text,uuid,text,integer,boolean,text)",
        "knowledge_document_access(uuid,uuid)",
      ]) {
        expect(
          (
            await one(
              "select has_function_privilege($1,$2,'execute') allowed",
              [role, "public." + signature],
            )
          ).allowed,
        ).toBe(false);
        expect(
          (
            await one(
              "select has_function_privilege('service_role',$1,'execute') allowed",
              ["public." + signature],
            )
          ).allowed,
        ).toBe(true);
      }
      expect(
        (
          await one(
            "select has_table_privilege($1,'public.account_invitations','select') allowed",
            [role],
          )
        ).allowed,
      ).toBe(false);
    }
    expect(
      (
        await one(
          "select relrowsecurity enabled from pg_class where oid='account_invitations'::regclass",
        )
      ).enabled,
    ).toBe(true);
  }, 30000);

  it("rolls back the complete repair if the verification audit fails", async () => {
    await install([22, 23]);
    await pg.exec(
      "create function fixture_audit_failure() returns trigger language plpgsql as $$begin if new.action='migration.pending_access_blocked' then raise exception 'fixture audit failure';end if;return new;end $$;create trigger fixture_audit_failure before insert on audit_log for each row execute function fixture_audit_failure();",
    );
    const before = await snapshot();
    await expect(pg.exec(repair)).rejects.toThrow("fixture audit failure");
    await pg.exec("rollback;");
    expect(await snapshot()).toEqual(before);
    expect(await one(diagnostic)).toEqual({
      update_022_handover: false,
      update_023_invitations: false,
      update_027_performance: true,
    });
    expect(
      (await one("select active from profiles where id=$1", [pending])).active,
    ).toBe(true);
    await pg.exec(
      "drop trigger fixture_audit_failure on audit_log;drop function fixture_audit_failure();",
    );
    await pg.exec(repair);
    expect(
      (await one("select active from profiles where id=$1", [pending])).active,
    ).toBe(false);
  }, 30000);

  it("refuses an unrelated or empty database before creating any CRM objects", async () => {
    pg = new PGlite();
    await expect(pg.exec(repair)).rejects.toThrow(
      "CRM core prerequisites missing:",
    );
    await pg.exec("rollback;");
    expect(
      await one(
        "select to_regclass('public.account_invitations') invitations,to_regclass('public.profiles') profiles",
      ),
    ).toEqual({ invitations: null, profiles: null });
  }, 30000);
});
