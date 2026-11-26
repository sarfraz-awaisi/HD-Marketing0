import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { addUp, eachPart } from "../src/services/leadDistribution.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 087: administrators select any number of leads on All leads and
// Never assigned, and what they do with them (Assign to agents,
// Round-robin unassigned, Delete) goes to the database 500 at a time.
const admin = "87000000-0000-4000-8000-000000000001",
  abru = "87000000-0000-4000-8000-000000000002",
  alisha = "87000000-0000-4000-8000-000000000003",
  owais = "87000000-0000-4000-8000-000000000004";
const migration = new URL(
  "../../supabase/migrations/087_select_any_number.sql",
  import.meta.url,
);
const m086 = new URL(
  "../../supabase/migrations/086_never_assigned_select_all.sql",
  import.meta.url,
);
const checkFile = new URL(
  "../../supabase/check-select-any-number-087.sql",
  import.meta.url,
);
const fake = (n) => `87000000-0000-4000-8001-${String(n).padStart(12, "0")}`;

describe("parts of 500 for Round-robin and Delete (update 087)", () => {
  it("adds counts, joins results, and reports the leads of a part that failed after earlier ones", async () => {
    const ids = Array.from({ length: 1200 }, (_, i) => fake(1200 - i));
    const seen = [];
    const ok = async (part) => {
      seen.push(part.length);
      return {
        deleted: part.length,
        failed: 0,
        batch: "b" + seen.length,
        results: part.map((id) => ({ id, result: "deleted" })),
      };
    };
    const all = await eachPart(ok, ids);
    expect(seen).toEqual([500, 500, 200]);
    expect(all).toMatchObject({ deleted: 1200, failed: 0, batch: "b1" });
    expect(all.results).toHaveLength(1200);
    expect(all.partial).toBeUndefined();
    // 500 or fewer: one call, its own result.
    expect(await eachPart(async () => "same", ids.slice(0, 500))).toBe("same");
    let n = 0;
    const third = async (part) => {
      if (++n === 3) throw new Error("timeout");
      return ok(part);
    };
    const partial = await eachPart(third, ids, "Not done");
    expect(partial).toMatchObject({
      deleted: 1000,
      failed: 200,
      partial: true,
    });
    expect(partial.results.filter((r) => r.result === "failed")).toEqual(
      partial.results.slice(1000),
    );
    expect(partial.results[1000].reason).toBe("Not done");
    // The first part failing, or a preview: an error.
    n = 2;
    await expect(eachPart(third, ids, "Not done")).rejects.toThrow("timeout");
    n = 1;
    await expect(eachPart(third, ids)).rejects.toThrow("timeout");
    expect(
      addUp([
        { a: 1, b: [1], c: "x" },
        { a: 2, b: [2], c: "y" },
      ]),
    ).toEqual({ a: 3, b: [1, 2], c: "x" });
  });
});

describe("any number of leads (database)", () => {
  let t,
    phone = 0;
  const app = () => createApp(trustedMfaFixture(t.db));
  const as = (user) => ({ Authorization: "Bearer " + user });
  const get = (path, status = 200) =>
    request(app()).get(path).set(as(admin)).expect(status);
  const post = (path, body, status = 200) =>
    request(app()).post(path).set(as(admin)).send(body).expect(status);
  const selection = async (query = {}) =>
    (await get("/api/leads/all/selection?" + new URLSearchParams(query))).body
      .ids;
  // Fresh people and n new leads, none assigned.
  async function setup(n) {
    await resetPeople(t.pg, [admin, abru, alisha]);
    await t.pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'owais@gmail.com',now())",
      [owais],
    );
    await t.pg.query(
      "update profiles set active=true,role='agent',name=case id when $1 then 'Abru' when $2 then 'Alisha' when $3 then 'Owais' end where id=any($4::uuid[])",
      [abru, alisha, owais, [abru, alisha, owais]],
    );
    const ids = (
      await t.all(
        "select (create_lead(jsonb_build_object('name','Buyer '||i),'+92308'||lpad(($3::int+i)::text,7,'0'),$1,'fixture')).id from generate_series(1,$2::int) i order by i",
        [admin, n, phone],
      )
    ).map((r) => r.id);
    phone += n;
    return ids;
  }
  const owners = async (ids) =>
    Object.fromEntries(
      (
        await t.all(
          "select coalesce(p.name,'none') name,count(*)::int n from leads l left join profiles p on p.id=l.assigned_agent where l.id=any($1::uuid[]) group by 1",
          [ids],
        )
      ).map((r) => [r.name, r.n]),
    );
  beforeAll(async () => {
    t = await startCrmDatabase();
  }, 60000);
  afterAll(async () => {
    await t?.pg.close();
  });

  it("Select all and the first N take any number, on All leads and Never assigned", async () => {
    const ids = await setup(1201);
    expect(await selection()).toHaveLength(1201);
    expect(await selection({ never_assigned: abru })).toHaveLength(1201);
    const top = await selection({ first: 1000 });
    expect(top).toHaveLength(1000);
    const page1 = (await get("/api/leads/all?page=1")).body.data.map(
      (l) => l.id,
    );
    expect(top.slice(0, 20)).toEqual(page1);
    expect(await selection({ first: 100000 })).toHaveLength(1201);
    expect(new Set(await selection())).toEqual(new Set(ids));
  }, 180000);

  it("Assign to agents from All leads: 1,201 leads in parts, even shares, leads already with a chosen agent kept", async () => {
    const ids = await setup(1201);
    // 100 leads are Abru's already.
    await t.pg.query("select admin_assign_leads($1,$2,$3,'t')", [
      ids.slice(0, 100),
      admin,
      abru,
    ]);
    const plan = (
      await post("/api/leads/distribute/preview", {
        lead_ids: ids,
        agent_ids: [abru, alisha],
      })
    ).body;
    expect(plan.applied).toBe(false);
    expect(plan.assigned + plan.reassigned + plan.skipped).toBe(1201);
    const [a, b] = plan.agents.map((x) => x.total);
    expect(a + b).toBe(1201);
    expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    expect(plan.agents[0].kept).toBe(plan.skipped);
    const done = (
      await post("/api/leads/distribute", {
        lead_ids: ids,
        agent_ids: [abru, alisha],
        token: plan.token,
      })
    ).body;
    expect(done).toMatchObject({ applied: true, stale: false });
    expect(await owners(ids)).toEqual({ Abru: a, Alisha: b });
    expect(
      (
        await t.one(
          "select count(*)::int n from audit_log where action='lead.bulk_distributed'",
        )
      ).n,
    ).toBe(3);
    // From a Never called list too: more than 500 is fine.
    const called = (
      await post("/api/leads/distribute/preview", {
        lead_ids: ids,
        agent_ids: [owais],
        never_called: true,
      })
    ).body;
    expect(
      called.assigned + called.reassigned + called.skipped + called.kept,
    ).toBe(1201);
  }, 180000);

  it("Round-robin unassigned and Delete take any number, 500 to each call", async () => {
    const ids = await setup(1201);
    const rr = (
      await post("/api/leads/assign-unassigned", {
        lead_ids: ids.slice(0, 1100),
        mode: "round_robin",
      })
    ).body;
    expect(rr).toMatchObject({ assigned: 1100, skipped: 0, failed: 0 });
    expect(rr.results).toHaveLength(1100);
    const shares = Object.values(await owners(ids.slice(0, 1100)));
    expect(shares).toHaveLength(3);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    const preview = (
      await post("/api/leads/delete-preview", { lead_ids: ids.slice(0, 700) })
    ).body;
    expect(preview).toMatchObject({ leads: 700, won: 0 });
    const gone = (
      await post("/api/leads/delete", {
        lead_ids: ids.slice(0, 700),
        reason: "Duplicate entry",
      })
    ).body;
    expect(gone).toMatchObject({ deleted: 700, failed: 0 });
    expect(gone.results).toHaveLength(700);
    expect(
      (
        await t.one(
          "select count(*)::int n from leads where id=any($1::uuid[]) and deleted_at is not null",
          [ids.slice(0, 700)],
        )
      ).n,
    ).toBe(700);
    expect(await selection()).toHaveLength(501);
  }, 180000);

  it("more than 20,000 leads in one request is refused before the database", async () => {
    const many = Array.from({ length: 20001 }, (_, i) => fake(i));
    for (const [path, body] of [
      ["/api/leads/distribute/preview", { agent_ids: [abru] }],
      ["/api/leads/assign-unassigned", { mode: "round_robin" }],
      ["/api/leads/delete-preview", {}],
      ["/api/leads/delete", { reason: "Duplicate entry" }],
    ])
      await post(path, { lead_ids: many, ...body }, 400);
  }, 60000);
});

describe("update 087 on a database at 086, as production is", () => {
  let t;
  beforeAll(async () => {
    t = await startCrmDatabase({ before: "087" });
    await resetPeople(t.pg, [admin, abru, alisha]);
    await t.all(
      "select create_lead(jsonb_build_object('name','Buyer '||i),'+92309'||lpad(i::text,7,'0'),$1,'fixture') from generate_series(1,501) i",
      [admin],
    );
  }, 120000);
  afterAll(async () => {
    await t?.pg.close();
  });
  const app = () => createApp(trustedMfaFixture(t.db));
  const listDef = async () =>
    (
      await t.one(
        "select md5(pg_get_functiondef('public.admin_lead_list(uuid,jsonb)'::regprocedure)) f",
      )
    ).f;
  const check = async () => t.one(await readFile(checkFile, "utf8"));
  const select = (query, status) =>
    request(app())
      .get("/api/leads/all/selection?" + query)
      .set({ Authorization: "Bearer " + admin })
      .expect(status);

  it("asks for 087 before selecting over 500, applies once and reruns as a no-op", async () => {
    expect((await select("", 503)).body.error).toBe(
      "Selecting this many leads needs CRM database update 087 after 086.",
    );
    expect((await select("first=501", 503)).body.error).toBe(
      "Selecting this many leads needs CRM database update 087 after 086.",
    );
    // At 086, 500 still works.
    expect((await select("first=500", 200)).body.ids).toHaveLength(500);
    expect(await check()).toMatchObject({
      release_stage: "at 086, ready for 087",
      edits_fit: true,
      active_leads: 501,
      transactions_open_over_1_min: 0,
    });
    const sql = await readFile(migration, "utf8");
    await t.pg.exec(sql);
    expect(await check()).toMatchObject({
      release_stage: "at 087",
      edits_fit: null,
    });
    expect((await select("", 200)).body.ids).toHaveLength(501);
    expect((await select("first=501", 200)).body.ids).toHaveLength(501);
    const after = await listDef();
    await t.pg.exec(sql);
    expect(await listDef()).toBe(after);
    // Update 086 now stops with its own message and changes nothing.
    await expect(t.pg.exec(await readFile(m086, "utf8"))).rejects.toThrow(
      "Update 086 found an unexpected version of admin_lead_list",
    );
    await t.pg.exec("rollback");
    expect(await listDef()).toBe(after);
  }, 120000);

  it("refuses to run before 086", async () => {
    const at085 = await startCrmDatabase({ before: "086" });
    try {
      await expect(
        at085.pg.exec(await readFile(migration, "utf8")),
      ).rejects.toThrow("Apply CRM updates up to 086 before update 087.");
    } finally {
      await at085.pg.close();
    }
  }, 120000);
});
