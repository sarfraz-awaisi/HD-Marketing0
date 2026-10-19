import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
const dir = new URL("../../supabase/migrations/", import.meta.url);
const uidMigration = () =>
  readFile(new URL("036_account_uids.sql", dir), "utf8");
let pg;
afterEach(async () => {
  await pg?.close();
  pg = null;
});
// Installs migrations through `last`, the state of an existing CRM before 036.
async function database(last = 35) {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}',last_sign_in_at timestamptz);create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of (await readdir(dir))
    .filter((file) => file.endsWith(".sql") && Number(file.slice(0, 3)) <= last)
    .sort())
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
}
const rows = async (sql, args = []) => (await pg.query(sql, args)).rows;
const one = async (sql, args = []) => (await rows(sql, args))[0];
async function user(email, role = "agent", active = true, offset = 0) {
  const id = randomUUID();
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
    [id, email],
  );
  await pg.query(
    "update profiles set role=$2,active=$3,created_at=now()+make_interval(secs=>$4) where id=$1",
    [id, role, active, offset],
  );
  return id;
}
// Each case builds its own database from the numbered migrations.
describe("account UID database update 036", { timeout: 60000 }, () => {
  it("assigns permanent unique UIDs to existing accounts without changing their data", async () => {
    await database();
    const admin = await user("owner@company.example", "admin", true, 1);
    const agent = await user("agent@company.example", "agent", true, 2);
    const disabled = await user("former@company.example", "agent", false, 3);
    const deleted = await user("deleted@company.example", "agent", false, 4);
    await pg.query(
      "update profiles set deletion_requested_at=now(),deleted_at=now() where id=$1",
      [deleted],
    );
    const lead = (
      await one(
        "insert into leads(name,masked_phone,assigned_agent) values('Existing client','+92******567',$1) returning id",
        [agent],
      )
    ).id;
    await pg.query(
      "insert into account_security(admin_id,pin_hash) values($1,$2)",
      [admin, "fixture-" + "x".repeat(80)],
    );
    const before = await rows(
      "select p.id,p.name,p.role,p.active,p.created_at,p.deleted_at,u.email from profiles p join auth.users u on u.id=p.id order by p.id",
    );
    await pg.exec(await uidMigration());
    const after = await rows(
      "select p.id,p.name,p.role,p.active,p.created_at,p.deleted_at,u.email,p.uid from profiles p join auth.users u on u.id=p.id order by p.id",
    );
    expect(after.map(({ uid, ...rest }) => rest)).toEqual(before);
    const uids = after.map((row) => row.uid);
    expect(uids.every((uid) => uid >= 100000 && uid <= 999999)).toBe(true);
    expect(new Set(uids).size).toBe(4);
    expect(
      (await one("select assigned_agent from leads where id=$1", [lead]))
        .assigned_agent,
    ).toBe(agent);
    expect(
      (
        await one("select pin_hash from account_security where admin_id=$1", [
          admin,
        ])
      ).pin_hash,
    ).toBe("fixture-" + "x".repeat(80));
    expect(
      await rows(
        "select metadata from audit_log where action='migration.account_uids_assigned'",
      ),
    ).toEqual([{ metadata: { assigned: 4, replaced: 0 } }]);
    // Rerunning keeps every UID and records nothing new.
    await pg.exec(await uidMigration());
    expect(await rows("select id,uid from profiles order by id")).toEqual(
      after.map(({ id, uid }) => ({ id, uid })),
    );
    expect(
      Number(
        (
          await one(
            "select count(*) n from audit_log where action='migration.account_uids_assigned'",
          )
        ).n,
      ),
    ).toBe(1);
    expect(
      (await one("select count(*)::int n from crm_private.account_uid_review"))
        .n,
    ).toBe(0);
    expect(
      await one(
        "select is_nullable,data_type from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='uid'",
      ),
    ).toEqual({ is_nullable: "NO", data_type: "integer" });
  });
  it("enforces the six-digit range, uniqueness and permanence in PostgreSQL", async () => {
    await database(36);
    const first = await user("first@gmail.com");
    const second = await user("second@gmail.com");
    const { uid } = await one("select uid from profiles where id=$1", [first]);
    await pg.exec("alter table profiles disable trigger assign_account_uid");
    try {
      await expect(
        pg.query("update profiles set uid=$2 where id=$1", [second, uid]),
      ).rejects.toMatchObject({ code: "23505" });
      for (const invalid of [99999, 1000000, 0, -123456])
        await expect(
          pg.query("update profiles set uid=$2 where id=$1", [second, invalid]),
        ).rejects.toMatchObject({ code: "23514" });
      await expect(
        pg.query("update profiles set uid=null where id=$1", [second]),
      ).rejects.toMatchObject({ code: "23502" });
    } finally {
      await pg.exec("alter table profiles enable trigger assign_account_uid");
    }
    await expect(
      pg.query("update profiles set uid=123456 where id=$1", [first]),
    ).rejects.toMatchObject({
      code: "22023",
      message: "Account UIDs are permanent and cannot be changed",
    });
    // Accounts created outside the CRM form still receive a UID.
    const outside = await user("dashboard.created@gmail.com");
    expect(
      (await one("select uid from profiles where id=$1", [outside])).uid,
    ).toBeGreaterThanOrEqual(100000);
  });
  it("keeps valid existing UIDs and records invalid or duplicate values before replacing them", async () => {
    await database();
    const ids = [];
    for (let n = 0; n < 6; n++)
      ids.push(await user(`m${n}@company.example`, "agent", true, n));
    await pg.exec("alter table profiles add column uid text default '000000'");
    const values = ["583214", "583214", "abc", "012345", null, "741205"];
    for (const [n, value] of values.entries())
      await pg.query("update profiles set uid=$2 where id=$1", [ids[n], value]);
    await pg.exec(await uidMigration());
    const uid = async (id) =>
      (await one("select uid from profiles where id=$1", [id])).uid;
    expect(await uid(ids[0])).toBe(583214);
    expect(await uid(ids[5])).toBe(741205);
    for (const n of [1, 2, 3, 4]) {
      expect(await uid(ids[n])).toBeGreaterThanOrEqual(100000);
      expect([583214, 741205]).not.toContain(await uid(ids[n]));
    }
    const review = await rows(
      "select profile_id,previous_value,reason,assigned_uid from crm_private.account_uid_review order by previous_value",
    );
    expect(review).toEqual([
      {
        profile_id: ids[3],
        previous_value: "012345",
        reason: "invalid",
        assigned_uid: await uid(ids[3]),
      },
      {
        profile_id: ids[1],
        previous_value: "583214",
        reason: "duplicate",
        assigned_uid: await uid(ids[1]),
      },
      {
        profile_id: ids[2],
        previous_value: "abc",
        reason: "invalid",
        assigned_uid: await uid(ids[2]),
      },
    ]);
    expect(
      (
        await one(
          "select metadata from audit_log where action='migration.account_uids_assigned'",
        )
      ).metadata,
    ).toEqual({ assigned: 4, replaced: 3 });
    expect(
      await one(
        "select data_type,column_default from information_schema.columns where table_schema='public' and table_name='profiles' and column_name='uid'",
      ),
    ).toEqual({ data_type: "integer", column_default: null });
    await pg.exec(await uidMigration());
    expect(
      (await one("select count(*)::int n from crm_private.account_uid_review"))
        .n,
    ).toBe(3);
  });
  it("keeps an existing valid integer UID column exactly as it is", async () => {
    await database();
    const a = await user("a@company.example");
    const b = await user("b@company.example");
    await pg.exec("alter table profiles add column uid integer");
    await pg.query("update profiles set uid=908234 where id=$1", [a]);
    await pg.exec(await uidMigration());
    expect((await one("select uid from profiles where id=$1", [a])).uid).toBe(
      908234,
    );
    expect(
      (await one("select uid from profiles where id=$1", [b])).uid,
    ).not.toBeNull();
    expect(
      (await one("select count(*)::int n from crm_private.account_uid_review"))
        .n,
    ).toBe(0);
  });
  it("refuses to install before update 035", async () => {
    await database(34);
    await expect(pg.exec(await uidMigration())).rejects.toThrow(
      "Apply CRM update 035 before account UID update 036.",
    );
    // The SQL Editor discards a failed script's transaction; do the same here.
    await pg.exec("rollback");
    expect(
      await one(
        "select 1 from information_schema.columns where table_name='profiles' and column_name='uid'",
      ),
    ).toBeUndefined();
  });
  it("lets existing accounts sign in and shows their UID after the update", async () => {
    await database();
    const agent = await user("legacy.agent@company.example");
    await pg.exec(await uidMigration());
    const db = {
      auth: {
        getUser: async (token) => ({
          data: {
            user: await one(
              "select id,email,email_confirmed_at from auth.users where id::text=$1",
              [token],
            ),
          },
        }),
      },
      from: () => {
        let columns;
        const q = {
          select: (value) => ((columns = value), q),
          eq: (_, id) => ({
            single: async () => ({
              data: await one(`select ${columns} from profiles where id=$1`, [
                id,
              ]),
            }),
          }),
        };
        return q;
      },
      rpc: async () => ({ data: null }),
    };
    const me = await request(createApp(trustedMfaFixture(db)))
      .get("/api/me?portal=agent")
      .set({ Authorization: "Bearer " + agent });
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({
      id: agent,
      role: "agent",
      email: "legacy.agent@company.example",
      uid: (await one("select uid from profiles where id=$1", [agent])).uid,
    });
  });
});
