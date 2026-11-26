import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { distributeInParts, parts } from "../src/services/leadDistribution.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 086: Select all on the Never assigned page takes up to 2,000
// leads, and Assign to agents works through them 500 at a time, each part
// with update 084's own checks, so every database call stays short.
const admin = "86000000-0000-4000-8000-000000000001",
  abru = "86000000-0000-4000-8000-000000000002",
  alisha = "86000000-0000-4000-8000-000000000003",
  owais = "86000000-0000-4000-8000-000000000004";
const migration = new URL(
  "../../supabase/migrations/086_never_assigned_select_all.sql",
  import.meta.url,
);
const checkFile = new URL(
  "../../supabase/check-never-assigned-select-086.sql",
  import.meta.url,
);
const m084 = new URL(
  "../../supabase/migrations/084_admin_never_assigned.sql",
  import.meta.url,
);
const md5 = (text) => createHash("md5").update(text).digest("hex");
const leadId = (n) => `86000000-0000-4000-8001-${String(n).padStart(12, "0")}`;

// Update 084's function, faked: every lead is assigned to the agents in
// turn. A part changes (a new token) when told to, before its move.
function engine(agents, { change = [], fail = [] } = {}) {
  const seen = [];
  const changed = new Set();
  let moves = 0;
  const call = async (ids, apply, token) => {
    seen.push({ size: ids.length, apply, token });
    if (apply) {
      const n = moves++;
      if (fail.includes(n)) throw new Error("The database took too long");
      if (change.includes(n)) changed.add(ids[0]);
    }
    const now = md5(ids.join() + (changed.has(ids[0]) ? "!" : ""));
    const results = ids.map((id, i) => ({
      id,
      name: "Lead " + id.slice(-4),
      result: "assigned",
      agent: agents[i % agents.length],
      agent_name: "Agent " + (i % agents.length),
      reason: "Assigned",
    }));
    return {
      applied: apply && (token === null || token === now),
      stale: token !== null && token !== now,
      token: now,
      never_assigned: true,
      assigned: ids.length,
      reassigned: 0,
      skipped: 0,
      kept: 0,
      failed: 0,
      agents: agents.map((id, n) => ({
        id,
        name: "Agent " + n,
        kept: 0,
        assigned: 0,
        reassigned: 0,
        total: 0,
      })),
      moved_from: [],
      results,
    };
  };
  return { call, seen };
}
const three = [abru, alisha, owais];
const many = Array.from({ length: 1100 }, (_, i) => leadId(1100 - i));
const totals = (r) => r.agents.map((a) => a.total);

describe("Assign to agents in parts (update 086)", () => {
  it("500 leads or fewer: one call, exactly as before", async () => {
    const e = engine(three);
    const ids = many.slice(0, 500);
    const r = await distributeInParts(e.call, {
      ids,
      agents: three,
      apply: false,
    });
    expect(e.seen).toEqual([{ size: 500, apply: false, token: null }]);
    expect(r.results).toHaveLength(500);
    expect(r.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it("splits a larger selection into whole rounds, so shares stay even, and previews it as one plan with one token", async () => {
    expect(parts(many, 3).map((p) => p.length)).toEqual([498, 498, 104]);
    expect(parts(many, 1).map((p) => p.length)).toEqual([500, 500, 100]);
    // The same leads in any order split the same way.
    expect(parts([...many].reverse(), 3)).toEqual(parts(many, 3));
    const e = engine(three);
    const r = await distributeInParts(e.call, {
      ids: many,
      agents: three,
      apply: false,
    });
    expect(e.seen.map((s) => [s.size, s.apply])).toEqual([
      [498, false],
      [498, false],
      [104, false],
    ]);
    expect(r).toMatchObject({
      applied: false,
      stale: false,
      never_assigned: true,
      assigned: 1100,
      reassigned: 0,
      kept: 0,
      failed: 0,
    });
    expect(totals(r)).toEqual([367, 367, 366]);
    expect(r.token).toMatch(/^[0-9a-f]{32}$/);
    expect(new Set(r.results.map((x) => x.id)).size).toBe(1100);
  });

  it("confirming checks every part first, then moves each with its own token; a changed selection moves nothing", async () => {
    const e = engine(three);
    const { token } = await distributeInParts(e.call, {
      ids: many,
      agents: three,
      apply: false,
    });
    const tokens = e.seen.map((s) => s.token);
    e.seen.length = 0;
    const r = await distributeInParts(e.call, {
      ids: many,
      agents: three,
      apply: true,
      token,
    });
    expect(tokens).toEqual([null, null, null]);
    expect(e.seen.map((s) => [s.size, s.apply])).toEqual([
      [498, false],
      [498, false],
      [104, false],
      [498, true],
      [498, true],
      [104, true],
    ]);
    expect(e.seen.slice(3).every((s) => /^[0-9a-f]{32}$/.test(s.token))).toBe(
      true,
    );
    expect(r).toMatchObject({ applied: true, assigned: 1100 });
    expect(r.partial).toBeUndefined();
    // An old token: only the check runs, nothing moves.
    const f = engine(three);
    const stale = await distributeInParts(f.call, {
      ids: many,
      agents: three,
      apply: true,
      token: "0".repeat(32),
    });
    expect(f.seen.every((s) => !s.apply)).toBe(true);
    expect(stale).toMatchObject({ applied: false, stale: true, token });
  });

  it("a part that changes at its move: nothing moved if it is the first; otherwise the parts before it stay assigned and the rest are failed", async () => {
    const preview = async (e) =>
      (
        await distributeInParts(e.call, {
          ids: many,
          agents: three,
          apply: false,
        })
      ).token;
    const first = engine(three, { change: [0] });
    const r1 = await distributeInParts(first.call, {
      ids: many,
      agents: three,
      apply: true,
      token: await preview(first),
    });
    expect(r1).toMatchObject({ applied: false, stale: true });
    expect(first.seen.filter((s) => s.apply)).toHaveLength(1);
    const second = engine(three, { change: [1] });
    const r2 = await distributeInParts(second.call, {
      ids: many,
      agents: three,
      apply: true,
      token: await preview(second),
    });
    expect(second.seen.filter((s) => s.apply)).toHaveLength(2);
    expect(r2).toMatchObject({
      applied: true,
      partial: true,
      assigned: 498,
      failed: 602,
    });
    expect(totals(r2)).toEqual([166, 166, 166]);
    expect(r2.results.find((x) => x.result === "failed").reason).toMatch(
      /^Changed while the leads were being assigned: not assigned/,
    );
    // The database failing on a later part: the same; on the first, an error.
    const broken = engine(three, { fail: [2] });
    const r3 = await distributeInParts(broken.call, {
      ids: many,
      agents: three,
      apply: true,
      token: await preview(broken),
    });
    expect(r3).toMatchObject({ applied: true, partial: true, assigned: 996 });
    expect(r3.results.find((x) => x.result === "failed").reason).toMatch(
      /^The CRM could not finish assigning/,
    );
    const down = engine(three, { fail: [0] });
    await expect(
      distributeInParts(down.call, {
        ids: many,
        agents: three,
        apply: true,
        token: await preview(down),
      }),
    ).rejects.toThrow("The database took too long");
  });
});

describe("Never assigned with 1,101 leads (database)", () => {
  let t;
  const app = () => createApp(trustedMfaFixture(t.db));
  const as = (user) => ({ Authorization: "Bearer " + user });
  const selection = (query, status = 200) =>
    request(app())
      .get("/api/leads/all/selection?" + new URLSearchParams(query))
      .set(as(admin))
      .expect(status);
  const distribute = (path, body, status = 200) =>
    request(app())
      .post("/api/leads/distribute" + path)
      .set(as(admin))
      .send({ never_assigned: true, ...body })
      .expect(status);
  let all, given;
  beforeAll(async () => {
    t = await startCrmDatabase();
    await resetPeople(t.pg, [admin, abru, alisha]);
    await t.pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'owais@gmail.com',now())",
      [owais],
    );
    await t.pg.query(
      "update profiles set active=true,role='agent',name=case id when $1 then 'Abru' when $2 then 'Alisha' when $3 then 'Owais' end where id=any($4::uuid[])",
      [abru, alisha, owais, three],
    );
    all = (
      await t.all(
        "select (create_lead(jsonb_build_object('name','Buyer '||i),'+92306'||lpad(i::text,7,'0'),$1,'fixture')).id from generate_series(1,1101) i order by i",
        [admin],
      )
    ).map((r) => r.id);
    given = all[0];
    await t.pg.query("select admin_assign_leads($1,$2,$3,'t')", [
      [given],
      admin,
      abru,
    ]);
  }, 180000);
  afterAll(async () => {
    await t?.pg.close();
  });

  it("Select all takes every Never assigned lead; update 087 lifts the limits", async () => {
    const one = (await selection({ never_assigned: abru })).body.ids;
    expect(one).toHaveLength(1100);
    expect(one).not.toContain(given);
    expect(
      (await selection({ never_assigned: `${abru},${alisha}` })).body.ids,
    ).toHaveLength(1100);
    expect((await selection({ never_assigned: owais })).body.ids).toHaveLength(
      1101,
    );
  }, 120000);

  it("Select the first N: that many leads from the top of the list, in its order, even when more match than Select all takes", async () => {
    const top = (await selection({ never_assigned: owais, first: 400 })).body
      .ids;
    expect(top).toHaveLength(400);
    // #1–#20 and #381–#400, as the list's pages show them.
    const page = async (n) =>
      (
        await request(app())
          .get(
            "/api/leads/all?" +
              new URLSearchParams({ never_assigned: owais, page: n }),
          )
          .set(as(admin))
          .expect(200)
      ).body.data.map((l) => l.id);
    expect(top.slice(0, 20)).toEqual(await page(1));
    expect(top.slice(380)).toEqual(await page(20));
    // Fewer leads match than asked: all of them.
    expect(
      (await selection({ never_assigned: owais, first: 2000 })).body.ids,
    ).toHaveLength(1101);
    // All leads: any number since update 087.
    expect((await selection({ first: 501 })).body.ids).toHaveLength(501);
    await selection({ never_assigned: owais, first: 0 }, 400);
  }, 120000);

  it("shares 1,100 leads in parts, evenly, none to an agent it had; a change after the preview moves nothing", async () => {
    const ids = (await selection({ never_assigned: abru })).body.ids;
    const before = (await t.one("select count(*)::int n from assignments")).n;
    const plan = (
      await distribute("/preview", { lead_ids: ids, agent_ids: three })
    ).body;
    expect(plan).toMatchObject({
      applied: false,
      stale: false,
      assigned: 1100,
      kept: 0,
      failed: 0,
    });
    expect(plan.agents.map((a) => [a.name, a.total])).toEqual([
      ["Abru", 367],
      ["Alisha", 367],
      ["Owais", 366],
    ]);
    // A lead moves after the preview: nothing is assigned.
    await t.pg.query("select admin_assign_leads($1,$2,$3,'t')", [
      [ids[1099]],
      admin,
      owais,
    ]);
    const stale = (
      await distribute("", {
        lead_ids: ids,
        agent_ids: three,
        token: plan.token,
      })
    ).body;
    expect(stale).toMatchObject({ applied: false, stale: true });
    expect(stale.token).not.toBe(plan.token);
    expect((await t.one("select count(*)::int n from assignments")).n).toBe(
      before + 1,
    );
    // Confirmed with the new plan: every lead moves, in parts.
    const done = (
      await distribute("", {
        lead_ids: ids,
        agent_ids: three,
        token: stale.token,
      })
    ).body;
    expect(done).toMatchObject({ applied: true, stale: false });
    expect(done.partial).toBeUndefined();
    expect(done.assigned + done.reassigned).toBe(1100);
    expect(done.agents.reduce((n, a) => n + a.total, 0)).toBe(1100);
    expect(
      await t.one(
        "select count(*) filter (where assigned_agent is null)::int unassigned,count(*) filter (where assigned_agent=$2)::int abru from leads where id=any($1::uuid[])",
        [ids, abru],
      ),
    ).toEqual({ unassigned: 0, abru: done.agents[0].total });
    // No lead went back to an agent it had: Owais's lead went elsewhere.
    expect(
      (await t.one("select assigned_agent from leads where id=$1", [ids[1099]]))
        .assigned_agent,
    ).not.toBe(owais);
    // One audit entry per part.
    expect(
      (
        await t.one(
          "select count(*)::int n from audit_log where action='lead.bulk_distributed' and metadata->>'never_assigned'='true'",
        )
      ).n,
    ).toBe(3);
  }, 180000);
});

describe("update 086 on a database at 085, as production is", () => {
  let t;
  beforeAll(async () => {
    t = await startCrmDatabase({ before: "086" });
    await resetPeople(t.pg, [admin, abru, alisha]);
    await t.all(
      "select create_lead(jsonb_build_object('name','Buyer '||i),'+92307'||lpad(i::text,7,'0'),$1,'fixture') from generate_series(1,501) i",
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

  it("asks for 086 before selecting over 500, applies once, reruns as a no-op and keeps 084 rerunnable", async () => {
    const select = (status, extra = "") =>
      request(app())
        .get("/api/leads/all/selection?never_assigned=" + abru + extra)
        .set({ Authorization: "Bearer " + admin })
        .expect(status);
    // Before 086 (and 087), the server asks for the updates.
    expect((await select(503)).body.error).toBe(
      "Selecting this many leads needs CRM database update 087 after 086.",
    );
    expect((await select(503, "&first=10")).body.error).toBe(
      "Selecting this many leads needs CRM database update 087 after 086.",
    );
    expect(await check()).toMatchObject({
      release_stage: "at 085, ready for 086",
      edits_fit: true,
      active_leads: 501,
      most_never_assigned: 501,
      transactions_open_over_1_min: 0,
    });
    const sql = await readFile(migration, "utf8");
    await t.pg.exec(sql);
    expect(await check()).toMatchObject({
      release_stage: "at 086",
      edits_fit: null,
    });
    expect((await select(200)).body.ids).toHaveLength(501);
    expect((await select(200, "&first=10")).body.ids).toHaveLength(10);
    const after = await listDef();
    await t.pg.exec(sql);
    await t.pg.exec(await readFile(m084, "utf8"));
    expect(await listDef()).toBe(after);
  }, 120000);

  it("refuses to run before 085", async () => {
    const at084 = await startCrmDatabase({ before: "085" });
    try {
      await expect(
        at084.pg.exec(await readFile(migration, "utf8")),
      ).rejects.toThrow("Apply CRM updates up to 085 before update 086.");
    } finally {
      await at084.pg.close();
    }
  }, 120000);
});
