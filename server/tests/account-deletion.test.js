import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  beforeAll,
  beforeEach,
  afterAll,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { digest } from "../src/services/accountsSecurity.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
const admin = "d2800000-0000-4000-8000-000000000001",
  agent = "d2800000-0000-4000-8000-000000000002",
  other = "d2800000-0000-4000-8000-000000000003",
  grant = "fixture-delete-grant",
  email = "agent@example.test";
let pg, db, app, lead, closed, elsewhere, property, followup;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const rpc = async (name, args) =>
  (
    await one(
      `select public.${name}(${Object.keys(args)
        .map((key, i) => `${key}=>$${i + 1}`)
        .join(",")}) value`,
      Object.values(args).map((value) =>
        value !== null && typeof value === "object" && !Array.isArray(value)
          ? JSON.stringify(value)
          : value,
      ),
    )
  ).value;
const authHeaders = (actor = admin) => ({
  Authorization: "Bearer " + actor,
  "X-Accounts-Unlock": grant,
});
const args = (target = agent) => ({
  p_actor: admin,
  p_session: digest("Bearer " + admin),
  p_unlock: digest(grant),
  p_target: target,
});
const remove = (
  target = agent,
  body = { confirm: true, email },
  actor = admin,
) =>
  request(app)
    .delete("/api/accounts/" + target)
    .set(authHeaders(actor))
    .send(body);
const get = (path, actor = admin) =>
  request(app)
    .get("/api" + path)
    .set(authHeaders(actor));
async function unlock() {
  await rpc("unlock_accounts", {
    p_actor: admin,
    p_session: digest("Bearer " + admin),
    p_version: (
      await one("select version from account_security where admin_id=$1", [
        admin,
      ])
    ).version,
    p_valid: true,
    p_token: digest(grant),
    p_request: "fixture-unlock",
  });
}
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,deleted_at timestamptz,raw_user_meta_data jsonb default '{}',raw_app_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
}, 30000);
afterAll(() => pg?.close());
beforeEach(async () => {
  await pg.exec("truncate auth.users cascade;");
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.test',now()),($2,$4,now()),($3,'other@example.test',now())",
    [admin, agent, other, email],
  );
  await pg.query(
    "update profiles set active=true,name=id::text,role=case when id=$1 then 'admin' else 'agent' end",
    [admin],
  );
  await rpc("save_accounts_pin", {
    p_actor: admin,
    p_hash: "fixture-" + "x".repeat(80),
    p_request: "fixture-pin",
  });
  await unlock();
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Fixture','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
  const create = async (owner, phone) =>
    (
      await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
        JSON.stringify({ name: "Fixture customer", assigned_agent: owner }),
        phone,
        admin,
      ])
    ).id;
  lead = await create(agent, "+923001234001");
  closed = await create(agent, "+923001234002");
  elsewhere = await create(other, "+923001234003");
  await pg.query("update leads set status='won' where id=$1", [closed]);
  await pg.query(
    "insert into calls(lead_id,agent_id,status,ended_at) values($1,$2,'completed',now())",
    [closed, agent],
  );
  await pg.query(
    "insert into deals(lead_id,property_id,agent_id,stage,expected_value,close_date) values($1,$2,$3,'won',100,current_date)",
    [closed, property, agent],
  );
  followup = (
    await one(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '1 hour') returning id",
      [lead, agent],
    )
  ).id;
  await pg.query(
    "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,now(),'completed'),($3,$2,now(),'pending')",
    [lead, agent, elsewhere],
  );
  await pg.query(
    "insert into visits(lead_id,property_id,agent_id,scheduled_at,status) values($1,$2,$3,now(),'scheduled'),($1,$2,$3,now(),'completed')",
    [lead, property, agent],
  );
  await pg.query(
    "insert into reminders(agent_id,followup_id,due_at) values($1,$2,now()+interval '1 hour')",
    [agent, followup],
  );
  await pg.query(
    "insert into lead_imports(file_name,file_format,total_rows,imported_count,assigned_agent,created_by) values('fixture.csv','csv',0,0,$1,$2)",
    [agent, admin],
  );
  db = {
    auth: {
      getUser: async (id) => ({
        data: {
          user: await one("select * from auth.users where id::text=$1", [id]),
        },
      }),
      admin: {
        getUserById: vi.fn(async (id) => ({
          data: {
            user: await one("select * from auth.users where id=$1", [id]),
          },
        })),
        deleteUser: vi.fn(async (id, soft) => {
          expect(soft).toBe(true);
          await pg.query(
            "update auth.users set deleted_at=now(),email='deleted:'||id::text where id=$1",
            [id],
          );
          return { data: { user: { id } } };
        }),
        updateUserById: vi.fn(async () => ({ data: { user: { id: agent } } })),
        inviteUserByEmail: vi.fn(async () => ({ data: {} })),
      },
    },
    rpc: vi.fn(async (name, values) => {
      try {
        return { data: await rpc(name, values) };
      } catch (error) {
        return { error: { code: error.code, message: error.message } };
      }
    }),
    from: (table) => {
      let fields = "*",
        filters = [],
        sort = "";
      const run = async () => ({
        data: (
          await pg.query(
            "select " +
              fields +
              " from " +
              table +
              (filters.length
                ? " where " +
                  filters.map(([key], i) => key + "=$" + (i + 1)).join(" and ")
                : "") +
              sort,
            filters.map(([, value]) => value),
          )
        ).rows,
      });
      const q = {
        select: (f) => {
          fields = f;
          return q;
        },
        eq: (key, value) => {
          filters.push([key, value]);
          return q;
        },
        order: (key) => {
          sort = " order by " + key;
          return q;
        },
        single: async () => ({ data: (await run()).data[0] }),
        then: (resolve, reject) => run().then(resolve, reject),
      };
      return q;
    },
  };
  app = createApp(trustedMfaFixture(db));
});
describe("PIN-protected account deletion", () => {
  it("reports missing update 028 before touching native Auth", async () => {
    const signature =
      "public.prepare_account_deletion(uuid,text,text,uuid,text,uuid,text)";
    const definition = (
      await one("select pg_get_functiondef($1::regprocedure) body", [signature])
    ).body;
    await pg.exec("drop function " + signature);
    try {
      const response = await remove();
      expect(response.status).toBe(503);
      expect(response.body.error).toContain("028 after 027");
      expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
    } finally {
      await pg.exec(definition);
      await pg.exec(
        "revoke all on function " +
          signature +
          " from public,anon,authenticated;grant execute on function " +
          signature +
          " to service_role;",
      );
    }
  });
  it("preserves an active administrator during competing administrator deletions", async () => {
    await pg.query("update profiles set role='admin' where id=$1", [other]);
    await rpc("save_accounts_pin", {
      p_actor: other,
      p_hash: "fixture-" + "x".repeat(80),
      p_request: "other-pin",
    });
    await rpc("unlock_accounts", {
      p_actor: other,
      p_session: digest("Bearer " + other),
      p_version: (
        await one("select version from account_security where admin_id=$1", [
          other,
        ])
      ).version,
      p_valid: true,
      p_token: digest("other-delete-grant"),
      p_request: "other-unlock",
    });
    const outcomes = await Promise.allSettled([
      rpc("prepare_account_deletion", {
        ...args(other),
        p_email: "other@example.test",
        p_operation: randomUUID(),
        p_request: "delete-other",
      }),
      rpc("prepare_account_deletion", {
        p_actor: other,
        p_session: digest("Bearer " + other),
        p_unlock: digest("other-delete-grant"),
        p_target: admin,
        p_email: "admin@example.test",
        p_operation: randomUUID(),
        p_request: "delete-admin",
      }),
    ]);
    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      (
        await one(
          "select count(*)::int n from profiles where role='admin' and active",
        )
      ).n,
    ).toBe(1);
  });

  it("deletes sign-in access, preserves history and hands all owned leads/work to the admin pool", async () => {
    const before = (
      await pg.query("select * from crm_private.lead_phones order by lead_id")
    ).rows;
    const response = await remove();
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ deleted: true, leads: 2, files: 1 });
    expect(db.auth.admin.deleteUser).toHaveBeenCalledExactlyOnceWith(
      agent,
      true,
    );
    expect(
      await one("select active,deleted_at from profiles where id=$1", [agent]),
    ).toMatchObject({ active: false, deleted_at: expect.any(Date) });
    expect(
      (await pg.query("select * from crm_private.lead_phones order by lead_id"))
        .rows,
    ).toEqual(before);
    expect(
      (
        await one("select count(*)::int n from leads where assigned_agent=$1", [
          agent,
        ])
      ).n,
    ).toBe(0);
    expect(
      (await one("select agent_id from followups where id=$1", [followup]))
        .agent_id,
    ).toBe(admin);
    expect(
      (
        await one(
          "select agent_id from followups where lead_id=$1 and status='pending'",
          [elsewhere],
        )
      ).agent_id,
    ).toBe(other);
    for (const [table, condition] of [
      ["calls", "status='completed'"],
      ["deals", "stage='won'"],
      ["followups", "status='completed'"],
      ["visits", "status='completed'"],
    ])
      expect(
        (await one(`select agent_id from ${table} where ${condition}`))
          .agent_id,
      ).toBe(agent);
    expect(
      (await get("/accounts")).body.data.map((row) => row.id),
    ).not.toContain(agent);
    expect((await get("/users")).body.map((row) => row.id)).not.toContain(
      agent,
    );
    expect((await get("/me", agent)).status).toBe(403);
  });
  it.each([
    [{}, 400],
    [{ confirm: false, email }, 400],
    [{ confirm: true, email: "different@example.test" }, 400],
    [{ confirm: true, email, actor: other }, 400],
  ])(
    "rejects invalid confirmation %j without native deletion",
    async (body, status) => {
      expect((await remove(agent, body)).status).toBe(status);
      expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
      expect(
        (await one("select active from profiles where id=$1", [agent])).active,
      ).toBe(true);
    },
  );
  it("refuses own-account deletion, agents and a missing PIN grant", async () => {
    expect(
      (await remove(admin, { confirm: true, email: "admin@example.test" }))
        .status,
    ).toBe(400);
    expect((await remove(agent, undefined, other)).status).toBe(403);
    expect(
      (
        await request(app)
          .delete("/api/accounts/" + agent)
          .set("Authorization", "Bearer " + admin)
          .send({ confirm: true, email })
      ).status,
    ).toBe(423);
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
  it("leaves native failures blocked and recoverable without transferring or auditing the work twice", async () => {
    db.auth.admin.deleteUser.mockResolvedValueOnce({
      error: { message: "provider private details" },
    });
    const first = await remove();
    expect(first.status).toBe(503);
    expect(first.body.code).toBe("ACCOUNTS_DELETE_PENDING");
    expect(first.body.error).not.toContain("provider private");
    expect(
      await one("select active,deleted_at from profiles where id=$1", [agent]),
    ).toEqual({ active: false, deleted_at: null });
    expect(
      (await get("/accounts")).body.data.find((row) => row.id === agent)
        .account_status,
    ).toBe("deletion_pending");
    expect((await remove()).body).toMatchObject({ deleted: true, leads: 2 });
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where action='account.delete_requested'",
        )
      ).n,
    ).toBe(1);
  });
  it("blocks edits, reenabling and new invitation requests while deletion is pending", async () => {
    db.auth.admin.deleteUser.mockResolvedValueOnce({
      error: { code: "unavailable" },
    });
    await remove();
    for (const [method, path, body] of [
      ["patch", "", { active: true }],
      ["post", "/password", { password: "fixture-password-123" }],
      ["post", "/invitation", {}],
      ["post", "/mfa-reset", { confirm: true }],
    ]) {
      const response = await request(app)
        [method]("/api/accounts/" + agent + path)
        .set(authHeaders())
        .send(body);
      expect(response.status).toBe(409);
    }
    expect(db.auth.admin.updateUserById).not.toHaveBeenCalled();
    expect(db.auth.admin.inviteUserByEmail).not.toHaveBeenCalled();
    await expect(
      pg.query("update profiles set active=true where id=$1", [agent]),
    ).rejects.toBeTruthy();
  });
  it("retains pending invitations as cancelled and releases the email after completion", async () => {
    await pg.query("update profiles set active=false where id=$1", [agent]);
    await pg.query(
      "update auth.users set email_confirmed_at=null where id=$1",
      [agent],
    );
    await pg.query(
      "insert into account_invitations(user_id,email,token_hash,state,issued_by,expires_at) values($1,$2,$3,'sent',$4,now()+interval '1 hour')",
      [agent, email, "a".repeat(64), admin],
    );
    expect((await remove()).status).toBe(200);
    expect(
      await one(
        "select state,email from account_invitations where user_id=$1",
        [agent],
      ),
    ).toEqual({ state: "cancelled", email: "deleted:" + agent });
    await rpc("check_account_email", {
      p_actor: admin,
      p_session: args().p_session,
      p_unlock: args().p_unlock,
      p_email: email,
      p_request: "new-email-check",
    });
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where request_id='new-email-check'",
        )
      ).n,
    ).toBe(1);
  });

  it("recovers when native Auth hides a previously deleted user", async () => {
    await rpc("prepare_account_deletion", {
      ...args(),
      p_email: email,
      p_operation: randomUUID(),
      p_request: "abandoned",
    });
    await pg.query(
      "update auth.users set deleted_at=now(),email='deleted:'||id::text where id=$1",
      [agent],
    );
    await pg.query(
      "update crm_private.account_deletions set lease_until=now() where user_id=$1",
      [agent],
    );
    db.auth.admin.getUserById.mockResolvedValue({
      error: { status: 404, code: "user_not_found" },
    });
    expect((await remove()).status).toBe(200);
    expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
  });
  it("does not permit completion before native Auth has marked the account deleted", async () => {
    const operation = randomUUID(),
      base = { ...args(), p_operation: operation, p_request: "proof" };
    await rpc("prepare_account_deletion", { ...base, p_email: email });
    await expect(
      rpc("finish_account_deletion", { ...base, p_success: true }),
    ).rejects.toMatchObject({ code: "22023" });
    expect(
      (await one("select deleted_at from profiles where id=$1", [agent]))
        .deleted_at,
    ).toBeNull();
  });
  it("fences overlapping and stale deletion attempts", async () => {
    const first = randomUUID(),
      second = randomUUID(),
      base = { ...args(), p_request: "fence" };
    await rpc("prepare_account_deletion", {
      ...base,
      p_operation: first,
      p_email: email,
    });
    await expect(
      rpc("prepare_account_deletion", {
        ...base,
        p_operation: second,
        p_email: email,
      }),
    ).rejects.toMatchObject({ code: "40001" });
    await pg.query(
      "update crm_private.account_deletions set lease_until=now()-interval '1 minute' where user_id=$1",
      [agent],
    );
    await rpc("prepare_account_deletion", {
      ...base,
      p_operation: second,
      p_email: email,
    });
    await expect(
      rpc("finish_account_deletion", {
        ...base,
        p_operation: first,
        p_success: false,
      }),
    ).rejects.toMatchObject({ code: "40001" });
  });
  it("keeps requested-work mutations atomic when the initial audit fails", async () => {
    await pg.exec(
      "create function fail_delete_audit() returns trigger language plpgsql as $$ begin if new.action='account.delete_requested' then raise exception 'audit failed';end if;return new;end $$;create trigger fail_delete_audit before insert on audit_log for each row execute function fail_delete_audit();",
    );
    try {
      expect((await remove()).status).toBe(503);
      expect(db.auth.admin.deleteUser).not.toHaveBeenCalled();
      expect(
        (await one("select active from profiles where id=$1", [agent])).active,
      ).toBe(true);
      expect(
        (await one("select assigned_agent from leads where id=$1", [lead]))
          .assigned_agent,
      ).toBe(agent);
    } finally {
      await pg.exec(
        "drop trigger fail_delete_audit on audit_log;drop function fail_delete_audit();",
      );
    }
  });
  it("recovers a failed completion audit without repeating native deletion", async () => {
    await pg.exec(
      "create function fail_delete_finish() returns trigger language plpgsql as $$ begin if new.action='account.deleted' then raise exception 'audit failed';end if;return new;end $$;create trigger fail_delete_finish before insert on audit_log for each row execute function fail_delete_finish();",
    );
    try {
      expect((await remove()).status).toBe(503);
      expect(
        (await get("/accounts")).body.data.find((row) => row.id === agent)
          .email,
      ).toBe(email);
    } finally {
      await pg.exec(
        "drop trigger fail_delete_finish on audit_log;drop function fail_delete_finish();",
      );
    }
    expect((await remove()).status).toBe(200);
    expect(db.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
  });
  it("requires a renewed PIN grant after it expires during native deletion", async () => {
    db.auth.admin.deleteUser.mockImplementationOnce(async (id) => {
      await pg.query(
        "update auth.users set deleted_at=now(),email='deleted:'||id::text where id=$1",
        [id],
      );
      await pg.query("delete from account_unlocks where admin_id=$1", [admin]);
      return { data: { user: { id } } };
    });
    expect((await remove()).status).toBe(423);
    await pg.query(
      "update crm_private.account_deletions set lease_until=now() where user_id=$1",
      [agent],
    );
    await unlock();
    expect((await remove()).status).toBe(200);
    expect(db.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
  });
  it("returns repeated deletion success without duplicating completion or native calls", async () => {
    expect((await remove()).status).toBe(200);
    expect((await remove()).status).toBe(200);
    expect(db.auth.admin.deleteUser).toHaveBeenCalledTimes(1);
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where action='account.deleted'",
        )
      ).n,
    ).toBe(1);
  });
  it("blocks browser execution of deletion readers and private ledger reads", async () => {
    await pg.exec("set role authenticated");
    try {
      await expect(
        pg.query("select * from crm_private.account_deletions"),
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        pg.query("select prepare_account_deletion($1,'','',$2,null,null,'')", [
          admin,
          agent,
        ]),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await pg.exec("reset role");
    }
    for (const signature of [
      "prepare_account_deletion(uuid,text,text,uuid,text,uuid,text)",
      "finish_account_deletion(uuid,text,text,uuid,uuid,boolean,text)",
    ])
      expect(
        (
          await one(
            "select has_function_privilege('authenticated',$1,'execute') allowed",
            ["public." + signature],
          )
        ).allowed,
      ).toBe(false);
  });
});
