import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";

let db;
beforeEach(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(
    "create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}'); create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
}, 30000);
afterEach(async () => {
  await db?.close();
});
const setupSql = async () =>
  (
    await readFile(new URL("../../supabase/setup.sql", import.meta.url), "utf8")
  ).replace("create extension if not exists pgcrypto;", "");

describe("fresh-install SQL bundle with F1", () => {
  it("applies the existing-database 029–032 bundle atomically without resetting customers or timestamps", async () => {
    const dir = new URL("../../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter((file) => file.endsWith(".sql") && Number(file.slice(0, 3)) <= 28)
      .sort())
      await db.exec(
        (await readFile(new URL(file, dir), "utf8")).replace(
          "create extension if not exists pgcrypto;",
          "",
        ),
      );
    const before = (
      await db.query(
        "insert into leads(name,masked_phone,created_at,updated_at) values('Existing fixture','+92******567','2026-01-01','2026-01-02') returning id,created_at,updated_at",
      )
    ).rows[0];
    await db.query(
      "insert into crm_private.lead_phones(lead_id,phone) values($1,'+923001234567')",
      [before.id],
    );
    const upgrade = await readFile(
      new URL("../../supabase/update-lead-management.sql", import.meta.url),
      "utf8",
    );
    await db.exec(upgrade);
    const after = (
      await db.query(
        "select id,created_at,updated_at,lead_no::int,deleted_at from leads where id=$1",
        [before.id],
      )
    ).rows[0];
    expect(after).toEqual({ ...before, lead_no: 1, deleted_at: null });
    expect(
      (
        await db.query(
          "select phone from crm_private.lead_phones where lead_id=$1",
          [before.id],
        )
      ).rows[0].phone,
    ).toBe("+923001234567");
    await expect(db.exec(upgrade)).rejects.toThrow(
      "Lead numbering is already installed",
    );
    await db.exec("rollback;");
    expect(
      (await db.query("select count(*)::int n from leads")).rows[0].n,
    ).toBe(1);
  }, 30000);

  it("repairs a skipped 019 alert setup without blocking the later 022 migration", async () => {
    const dir = new URL("../../supabase/migrations/", import.meta.url);
    for (const file of (await readdir(dir))
      .filter(
        (file) =>
          file.endsWith(".sql") && file < "022" && !file.startsWith("019_"),
      )
      .sort()) {
      await db.exec(
        (await readFile(new URL(file, dir), "utf8")).replace(
          "create extension if not exists pgcrypto;",
          "",
        ),
      );
    }
    await db.exec(
      await readFile(
        new URL("../../supabase/repair-security-alerts.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(
      (
        await db.query(
          "select to_regclass('public.inactive_owner_alert_day') idx",
        )
      ).rows[0].idx,
    ).toBeNull();
    await db.exec(
      await readFile(
        new URL("022_agent_offboarding_and_kyc_access.sql", dir),
        "utf8",
      ),
    );
    expect(
      (
        await db.query(
          "select to_regclass('public.inactive_owner_alert_day') idx,to_regprocedure('public.report_inactive_lead_owners()') report",
        )
      ).rows[0],
    ).toMatchObject({
      idx: "inactive_owner_alert_day",
      report: "report_inactive_lead_owners()",
    });
  });
  it("stops security-alert repair in an uninitialized project without creating partial objects", async () => {
    const repair = await readFile(
      new URL("../../supabase/repair-security-alerts.sql", import.meta.url),
      "utf8",
    );
    await expect(db.exec(repair)).rejects.toThrow(
      "Required CRM tables are missing",
    );
    await db.exec("rollback;");
    expect(
      (
        await db.query(
          "select to_regclass('public.security_alerts') alerts,to_regprocedure('public.security_alerts_summary(uuid)') summary",
        )
      ).rows[0],
    ).toEqual({ alerts: null, summary: null });
  });
  it("stops the contact repair in an uninitialized project without partial CRM objects", async () => {
    const repair = await readFile(
      new URL(
        "../../supabase/repair-visible-lead-contacts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    await expect(db.exec(repair)).rejects.toThrow(
      "Required CRM tables are missing",
    );
    await db.exec("rollback;");
    expect(
      (
        await db.query(
          "select to_regclass('public.profiles') profiles,to_regprocedure('public.lead_contact_phones(uuid,uuid[],text)') contacts",
        )
      ).rows[0],
    ).toEqual({ profiles: null, contacts: null });
  });
  it("restores the missing migration-019 ledger in the reported partially upgraded database", async () => {
    await db.exec(await setupSql());
    await db.exec("drop table crm_private.phone_reveals;");
    const diagnostic = await readFile(
      new URL(
        "../../supabase/check-visible-lead-contacts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    expect((await db.query(diagnostic)).rows[0]).toEqual({
      profiles: true,
      leads: true,
      audit_log: true,
      lead_phones: true,
      phone_reveals: false,
    });
    const repair = await readFile(
      new URL(
        "../../supabase/repair-visible-lead-contacts.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const result = await db.exec(repair);
    expect(result.at(-1).rows[0]).toMatchObject({
      phone_history_ready: true,
      phone_function_installed: true,
      server_access_ready: true,
    });
    expect((await db.query(diagnostic)).rows[0]).toEqual({
      profiles: true,
      leads: true,
      audit_log: true,
      lead_phones: true,
      phone_reveals: true,
    });
    expect(
      (
        await db.query(
          "select relrowsecurity enabled from pg_class where oid='crm_private.phone_reveals'::regclass",
        )
      ).rows[0].enabled,
    ).toBe(true);
    for (const role of ["anon", "authenticated"])
      expect(
        (
          await db.query(
            "select has_table_privilege($1,'crm_private.phone_reveals','select') allowed",
            [role],
          )
        ).rows[0].allowed,
      ).toBe(false);
  });
  it("creates the pipeline tables, sample property and restricted browser grants", async () => {
    const result = await db.exec(await setupSql());
    expect(result.at(-1).rows[0].status).toBe(
      "HD Marketing database setup completed",
    );
    expect(
      (await db.query("select count(*)::int n from properties")).rows[0].n,
    ).toBe(1);
    expect(
      (
        await db.query(
          "select count(*)::int n from information_schema.columns where table_schema='public' and table_name='leads' and column_name in ('lost_reason','lost_note','lost_at')",
        )
      ).rows[0].n,
    ).toBe(3);
    expect(
      (
        await db.query(
          "select has_table_privilege('authenticated','public.lead_status_history','select') as allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
    expect(
      (
        await db.query(
          "select to_regclass('crm_private.phone_reveals') as reveals,to_regclass('public.security_alerts') as alerts",
        )
      ).rows[0],
    ).toEqual({
      reveals: "crm_private.phone_reveals",
      alerts: "security_alerts",
    });
    expect(
      (
        await db.query(
          "select has_table_privilege('authenticated','public.security_alerts','select') as table_allowed,has_function_privilege('authenticated','public.reveal_phone(uuid,uuid,text,integer)','execute') as function_allowed",
        )
      ).rows[0],
    ).toEqual({ table_allowed: false, function_allowed: false });
    expect(
      (
        await db.query(
          "select count(*)::int n from information_schema.columns where table_schema='public' and table_name='calls' and column_name in ('method','answered')",
        )
      ).rows[0].n,
    ).toBe(2);
    expect(
      (
        await db.query(
          "select has_function_privilege('authenticated','public.log_manual_call(uuid,uuid,jsonb,text)','execute') as allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
  });
  it("rolls back the whole fresh setup if a later statement fails", async () => {
    const sql = (await setupSql()).replace(
      /^COMMIT;$/m,
      "SELECT missing_setup_check();\nCOMMIT;",
    );
    await expect(db.exec(sql)).rejects.toThrow();
    await db.exec("ROLLBACK;");
    expect(
      (
        await db.query(
          "select to_regclass('public.profiles') as profiles, to_regclass('public.lead_status_history') as history",
        )
      ).rows[0],
    ).toEqual({ profiles: null, history: null });
  });
});
