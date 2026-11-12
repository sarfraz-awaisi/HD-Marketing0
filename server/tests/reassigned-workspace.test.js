import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
// Update 061: a lead moved from one agent to another opens a fresh workspace
// for the new agent, through the API, against every migration. The new
// agent sees the current assignment only (plus commitments carried over,
// without earlier comments), with Reassigned, New and Previously not
// interested; the administrator sees everything, and no record changes. A
// small query builder answers the Supabase client's calls with SQL, as in
// lead-followups-activity.test.js; workspace_state is the database's own
// function, read like a column.
const admin = "f0610000-0000-4000-8000-000000000001",
  ali = "f0610000-0000-4000-8000-000000000002",
  sara = "f0610000-0000-4000-8000-000000000003",
  omar = "f0610000-0000-4000-8000-000000000004";
const people = [admin, ali, sara, omar];
const dir = new URL("../../supabase/migrations/", import.meta.url);
let pg,
  property,
  phone = 1000;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const all = async (sql, args = []) => (await pg.query(sql, args)).rows;
const plain = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v instanceof Date ? v.toISOString() : v,
    ]),
  );
function database() {
  return {
    auth: {
      getUser: async (token) => ({
        data: {
          user: people.includes(token)
            ? { id: token, email_confirmed_at: "2026-10-01" }
            : null,
        },
      }),
    },
    rpc: async (name, args = {}) => {
      try {
        return {
          data: (
            await one(
              `select to_jsonb(public.${name}(${Object.keys(args)
                .map((key, i) => `${key}=>$${i + 1}`)
                .join(",")})) value`,
              Object.values(args).map((v) =>
                v && typeof v === "object" && !Array.isArray(v)
                  ? JSON.stringify(v)
                  : v,
              ),
            )
          ).value,
        };
      } catch (error) {
        return { error: { code: error.code, message: error.message } };
      }
    },
    from(table) {
      let joins = "",
        fields = "r.*",
        clauses = [],
        values = [],
        sort = [],
        cap = Infinity,
        start = 0;
      const field = (key) =>
        key.startsWith("leads.") ? "l." + key.slice(6) : "r." + key;
      const add = (key, op, value) => {
        values.push(value);
        clauses.push(`${field(key)} ${op} $${values.length}`);
        return q;
      };
      async function run() {
        try {
          const rows = (
            await pg.query(
              `select ${fields} from public.${table} r${joins}${clauses.length ? " where " + clauses.join(" and ") : ""}${sort.length ? " order by " + sort.join(",") : ""}`,
              values,
            )
          ).rows.map(plain);
          return {
            data: rows.slice(start, cap === Infinity ? undefined : start + cap),
            count: rows.length,
          };
        } catch (error) {
          return { error: { code: error.code, message: error.message } };
        }
      }
      const q = {
        select(value = "*") {
          const parts = value.match(/[^,(]+(\([^)]*\))?/g) || ["*"];
          fields = parts
            .map((part) => {
              part = part.trim();
              if (part.startsWith("leads")) {
                joins = " join public.leads l on l.id=r.lead_id";
                return "to_jsonb(l) leads";
              }
              // A computed field (workspace_state) is a function of the row.
              return part === "*" ? "r.*" : "r." + part + " " + part;
            })
            .join(",");
          return q;
        },
        eq: (key, value) => add(key, "=", value),
        is: (key, value) => add(key, "is not distinct from", value),
        lt: (key, value) => add(key, "<", value),
        lte: (key, value) => add(key, "<=", value),
        gt: (key, value) => add(key, ">", value),
        in(key, list) {
          values.push(list);
          clauses.push(`${field(key)}::text = any($${values.length})`);
          return q;
        },
        order(key, options) {
          sort.push(
            field(key) + (options?.ascending === false ? " desc" : " asc"),
          );
          return q;
        },
        limit(value) {
          cap = value;
          return q;
        },
        range(low, high) {
          start = low;
          cap = high - low + 1;
          return run();
        },
        single: async () => {
          const r = await run();
          return { ...r, data: r.data?.[0] };
        },
        maybeSingle: async () => {
          const r = await run();
          return { ...r, data: r.data?.[0] || null };
        },
        then: (resolve, reject) => run().then(resolve, reject),
      };
      return q;
    },
  };
}
const app = () => createApp(trustedMfaFixture(database()));
const as = (user) => ({ Authorization: "Bearer " + user });
const get = (user, path) =>
  request(app())
    .get("/api" + path)
    .set(as(user));
const send = (user, method, path, body) =>
  request(app())
    [method]("/api" + path)
    .set(as(user))
    .send(body);
const ok = async (response, status = 200) => {
  const res = await response;
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body;
};
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
const answered = ["Interested", "Not interested", "Follow-up required"];
const call = (outcome, change = {}) => ({
  answered: answered.includes(outcome),
  started_at: new Date(Date.now() - 120000).toISOString(),
  duration_seconds: answered.includes(outcome) ? 90 : 0,
  outcome,
  notes: "",
  deal_tags: [],
  ...change,
});
async function customer(owner = ali, name = "Customer " + phone) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, assigned_agent: owner }),
      "+92311" + String(phone++).padStart(7, "0"),
      admin,
    ])
  ).id;
}
const logCall = (user, lead, outcome, change) =>
  ok(
    send(user, "post", `/leads/${lead}/calls/manual`, call(outcome, change)),
    201,
  );
// Bulk (All leads, update 060) or single (the lead's own Assign).
const moveAll = (leads, agent) =>
  ok(
    send(admin, "post", "/leads/assign-selected", {
      lead_ids: leads,
      agent_id: agent,
    }),
  );
const moveOne = (lead, agent) =>
  ok(send(admin, "post", `/leads/${lead}/assign`, { agent_id: agent }));
const myLeads = async (user, query = "") =>
  (await ok(get(user, "/my-leads?view=assigned" + query))).data;
const row = async (user, lead, query = "") =>
  (await myLeads(user, query)).find((r) => r.id === lead);
const timeline = (user, lead) => ok(get(user, `/leads/${lead}/timeline`));
const kinds = (items) =>
  items.map((i) => i.kind + (i.carried_over ? " (carried)" : "")).sort();
// Everything recorded about the leads, to show nothing was changed or lost.
const history = (leads) =>
  one(
    `select (select jsonb_agg(to_jsonb(x) order by x.id) from calls x where lead_id=any($1)) calls,
      (select jsonb_agg(to_jsonb(x) order by x.id) from notes x where lead_id=any($1)) notes,
      (select jsonb_agg(to_jsonb(x)-'agent_id'-'updated_at' order by x.id) from followups x where lead_id=any($1)) followups,
      (select jsonb_agg(to_jsonb(x)-'agent_id'-'updated_at' order by x.id) from visits x where lead_id=any($1)) visits,
      (select jsonb_agg(to_jsonb(x) order by x.id) from deals x where lead_id=any($1)) deals,
      (select jsonb_agg(to_jsonb(x) order by x.id) from lead_status_history x where lead_id=any($1)) stages,
      (select jsonb_agg(jsonb_build_object('status',l.status,'lost_reason',l.lost_reason,'lost_note',l.lost_note) order by l.id) from leads l where id=any($1)) leads,
      (select count(*)::int from audit_log a where a.entity in ('notes','calls','followups','visits','deals')) audit`,
    [leads],
  );
// Ali works a lead: an answered Interested call (Warm) with comments, a
// note, a follow-up promised on a call, one completed follow-up, a
// scheduled visit with comments, and the stage moved to Interested.
async function aliWorks(lead) {
  await logCall(ali, lead, "Interested", {
    notes: "Wants a corner plot",
    deal_tags: ["Warm lead"],
  });
  await ok(
    send(ali, "post", "/notes", { lead_id: lead, body: "Ali's private note" }),
    201,
  );
  const pending = await ok(
    send(ali, "post", "/followups", {
      lead_id: lead,
      due_at: inHours(30),
      status: "pending",
      notes: "Ali: call after Friday prayers",
    }),
    201,
  );
  const done = await ok(
    send(ali, "post", "/followups", {
      lead_id: lead,
      due_at: inHours(2),
      status: "pending",
      notes: "Ali: done already",
    }),
    201,
  );
  await ok(
    send(ali, "patch", `/followups/${done.id}`, { status: "completed" }),
  );
  const visit = await ok(
    send(ali, "post", "/visits", {
      lead_id: lead,
      property_id: property,
      scheduled_at: inHours(50),
      status: "scheduled",
      notes: "Ali: bring the file",
    }),
    201,
  );
  await ok(send(ali, "patch", `/leads/${lead}`, { status: "interested" }));
  return { pending: pending.id, done: done.id, visit: visit.id };
}
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.test',now()),($2,'ali@example.test',now()),($3,'sara@example.test',now()),($4,'omar@example.test',now())",
    people,
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' when $3 then 'Sara Agent' else 'Omar Agent' end",
    [admin, ali, sara],
  );
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Park View Residence','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
}, 120000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await pg.exec(
    "insert into public.crm_settings(id) values(true) on conflict(id) do nothing;update public.crm_settings set work_days='{1,2,3,4,5,6,7}',work_start='00:00',work_end='23:59',first_call_grace_minutes=120,idle_days=7;",
  );
});

describe("a lead reassigned to another agent (update 061)", () => {
  it("opens a fresh workspace for the new agent, keeping everything for the administrator", async () => {
    const lead = await customer(ali, "Hamza Buyer");
    const ids = await aliWorks(lead);
    const before = await history([lead]);
    expect(await moveAll([lead], sara)).toMatchObject({ reassigned: 1 });
    // Nothing recorded changed: follow-ups and visits only moved to Sara.
    expect(await history([lead])).toEqual(before);
    expect(
      await all(
        "select id,agent_id from followups where lead_id=$1 order by due_at",
        [lead],
      ),
    ).toEqual([
      { id: ids.done, agent_id: ali },
      { id: ids.pending, agent_id: sara },
    ]);

    // Assigned leads: Reassigned and New, no earlier call, temperature,
    // stage or note; not in her pipeline yet.
    expect(await row(sara, lead)).toMatchObject({
      reassigned: true,
      status: "new",
      previous_result: null,
      first_call_at: null,
      contact: "none",
      last_call_at: null,
      last_call_outcome: null,
      temperature: null,
      note: null,
    });
    expect((await row(sara, lead, "&assignment=reassigned"))?.id).toBe(lead);
    expect((await row(sara, lead, "&call=uncalled"))?.id).toBe(lead);
    const pipeline = await ok(get(sara, "/my-leads?view=pipeline"));
    expect(pipeline).toMatchObject({
      count: 0,
      pipeline_counts: { pipeline: 0, personally_contacted: 0 },
    });

    // Lead details: the fresh stage and the indicators.
    expect(await ok(get(sara, `/leads/${lead}`))).toMatchObject({
      status: "new",
      reassigned: true,
      previous_result: null,
    });
    // Timeline: the move itself, and the commitments carried over without
    // Ali's comments; none of Ali's calls, notes or stage changes.
    const items = await timeline(sara, lead);
    expect(kinds(items)).toEqual([
      "assignments",
      "followups (carried)",
      "visits (carried)",
    ]);
    expect(items.find((i) => i.kind === "followups")).toMatchObject({
      id: ids.pending,
      status: "pending",
      notes: null,
    });
    expect(items.find((i) => i.kind === "visits")).toMatchObject({
      id: ids.visit,
      property_id: property,
      status: "scheduled",
      notes: null,
    });
    expect(JSON.stringify(items)).not.toMatch(
      /Ali:|corner plot|private note|Warm/,
    );

    // Direct API reads leave Ali's work out too.
    const followups = await ok(get(sara, "/followups"));
    expect(followups.count).toBe(1);
    expect(followups.data[0]).toMatchObject({
      id: ids.pending,
      notes: null,
      carried_over: true,
    });
    expect((await ok(get(sara, "/calls"))).count).toBe(0);
    const visits = await ok(get(sara, "/visits"));
    expect(visits.data.map((v) => [v.id, v.notes, v.carried_over])).toEqual([
      [ids.visit, null, true],
    ]);
    const calendar = await ok(
      get(
        sara,
        `/visits/calendar?from=${encodeURIComponent(inHours(-24))}&to=${encodeURIComponent(inHours(24 * 7))}`,
      ),
    );
    expect(calendar.map((v) => [v.id, v.notes, v.carried_over])).toEqual([
      [ids.visit, null, true],
    ]);
    expect(
      JSON.stringify(await ok(get(sara, "/followups/unscheduled"))),
    ).not.toContain(lead);

    // The administrator sees everything, as before.
    const full = await timeline(admin, lead);
    expect(kinds(full)).toEqual(
      expect.arrayContaining([
        "calls",
        "notes",
        "followups",
        "visits",
        "lead_status_history",
      ]),
    );
    expect(JSON.stringify(full)).toMatch(/Ali: call after Friday prayers/);
    expect(JSON.stringify(full)).toMatch(/Ali's private note/);
    expect(await ok(get(admin, `/leads/${lead}`))).toMatchObject({
      status: "interested",
    });
    // Ali no longer opens the lead.
    expect((await get(ali, `/leads/${lead}`)).status).toBe(404);

    // Sara cannot change Ali's work, through the API or the database.
    const aliCall = (await one("select id from calls where lead_id=$1", [lead]))
      .id;
    const refused = await send(sara, "patch", `/calls/${aliCall}`, {
      outcome: "Busy",
      notes: "",
      deal_tags: [],
    });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toMatch(/earlier assignment/);
    const comment = await send(sara, "patch", `/followups/${ids.pending}`, {
      notes: "Overwritten",
    });
    expect(comment.status).toBe(403);
    expect(comment.body.error).toMatch(/Comments from an earlier assignment/);
    expect(
      (
        await send(sara, "patch", `/followups/${ids.done}`, {
          status: "pending",
        })
      ).status,
    ).toBe(403);
    await expect(
      pg.query(
        "select crm_mutate('calls',$1,'{\"outcome\":\"Busy\"}'::jsonb,$2,'t')",
        [aliCall, sara],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      pg.query(
        "select crm_mutate('followups',$1,'{\"notes\":\"x\"}'::jsonb,$2,'t')",
        [ids.pending, sara],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await history([lead])).toEqual(before);
    // She may reschedule a carried-over follow-up; its comments stay.
    await ok(
      send(sara, "patch", `/followups/${ids.pending}`, { due_at: inHours(40) }),
    );
    expect(
      (await one("select notes from followups where id=$1", [ids.pending]))
        .notes,
    ).toBe("Ali: call after Friday prayers");

    // Her own work shows normally; Reassigned stays, New goes.
    await logCall(sara, lead, "Interested", {
      notes: "Sara: wants 10 marla",
      deal_tags: ["Hot lead"],
    });
    await ok(
      send(sara, "post", "/notes", { lead_id: lead, body: "Sara's note" }),
      201,
    );
    expect(await row(sara, lead)).toMatchObject({
      reassigned: true,
      status: "contacted",
      contact: "contacted",
      last_call_outcome: "Interested",
      temperature: "hot",
      note: "Sara's note",
    });
    expect((await row(sara, lead)).first_call_at).not.toBeNull();
    expect(await ok(get(sara, "/my-leads?view=pipeline"))).toMatchObject({
      count: 1,
      pipeline_counts: { pipeline: 1, personally_contacted: 1 },
    });
    const mine = await timeline(sara, lead);
    expect(kinds(mine)).toEqual([
      "assignments",
      "calls",
      "followups (carried)",
      "notes",
      "visits (carried)",
    ]);
    // Choosing the stage the lead already had (Interested, set by Ali)
    // shows as hers.
    await ok(send(sara, "patch", `/leads/${lead}`, { status: "interested" }));
    expect((await row(sara, lead)).status).toBe("interested");
    // The administrator still has all of it, and the agents both notified.
    expect(
      kinds(await timeline(admin, lead)).filter((k) => k === "calls"),
    ).toHaveLength(2);
    expect(
      await all(
        "select user_id,type from notifications where lead_id=$1 and type in ('lead_assigned','lead_moved_away') order by type,user_id",
        [lead],
      ),
    ).toEqual(
      expect.arrayContaining([
        { user_id: sara, type: "lead_assigned" },
        { user_id: ali, type: "lead_moved_away" },
      ]),
    );
  });

  it("shows Previously not interested only when the previous assignment ended Not interested", async () => {
    const leads = {};
    for (const outcome of [
      "No answer",
      "Busy",
      "Number off",
      "Interested",
      "Not interested",
    ]) {
      leads[outcome] = await customer(ali, outcome + " lead");
      await logCall(ali, leads[outcome], outcome);
    }
    // A lead Ali marked Lost, not interested, after a later No answer.
    const lost = await customer(ali, "Lost lead");
    await logCall(ali, lost, "No answer");
    await ok(
      send(ali, "patch", `/leads/${lost}`, {
        status: "lost",
        lost_reason: "not_interested",
        lost_note: "Ali: bought elsewhere maybe",
      }),
    );
    // Single moves this time, the lead's own Assign.
    for (const lead of [...Object.values(leads), lost])
      await moveOne(lead, sara);
    for (const [outcome, lead] of Object.entries(leads))
      expect(await row(sara, lead), outcome).toMatchObject({
        reassigned: true,
        status: "new",
        last_call_at: null,
        previous_result: outcome === "Not interested" ? "not_interested" : null,
      });
    // The Lost lead: New, in her first calls, without Ali's reason or note;
    // still Lost for the administrator and the reports.
    expect(await row(sara, lost, "&call=uncalled")).toMatchObject({
      status: "new",
      lost_reason: null,
      previous_result: "not_interested",
      first_call_reopened: true,
    });
    expect(await ok(get(sara, `/leads/${lost}`))).toMatchObject({
      status: "new",
      lost_reason: null,
      lost_note: null,
    });
    expect(
      await one("select status,lost_reason,lost_note from leads where id=$1", [
        lost,
      ]),
    ).toEqual({
      status: "lost",
      lost_reason: "not_interested",
      lost_note: "Ali: bought elsewhere maybe",
    });
    const queue = await ok(get(sara, "/first-call-queue"));
    expect(queue.data.find((r) => r.id === lost)).toMatchObject({
      status: "new",
      reassigned: true,
      first_call_reopened: true,
    });
    const allLeads = await ok(
      get(admin, "/leads/all?call=uncalled&search=Lost%20lead"),
    );
    expect(
      allLeads.data.map((r) => [r.id, r.status, r.first_call_reopened]),
    ).toEqual([[lost, "lost", true]]);
    // A missed deadline is flagged and reported, and the lead stays Lost.
    await pg.query(
      "update leads set call_due_at=now()-interval '1 hour' where id=$1",
      [lost],
    );
    await pg.query("select lead_response_job()");
    expect(
      await one(
        "select missed_at is not null missed,status from leads where id=$1",
        [lost],
      ),
    ).toEqual({
      missed: true,
      status: "lost",
    });
    expect(
      await one("select kind from lead_review_queue where id=$1", [lost]),
    ).toEqual({ kind: "missed" });
    expect(
      await one(
        "select count(*)::int n from notifications where user_id=$1 and type='first_call_missed' and lead_id=$2",
        [sara, lost],
      ),
    ).toEqual({ n: 1 });
    // After Sara's first call: New and the earlier result go.
    await logCall(sara, leads["Not interested"], "No answer");
    expect(await row(sara, leads["Not interested"])).toMatchObject({
      reassigned: true,
      previous_result: null,
      last_call_outcome: "No answer",
      status: "new",
    });
    // Ali's own report rows on Sara's lead still count his call.
    expect(
      (
        await one(
          "select count(*)::int n from calls where lead_id=$1 and agent_id=$2",
          [leads["Not interested"], ali],
        )
      ).n,
    ).toBe(1);
  });

  it("counts only the agent's own call as their first call on a reassigned lead", async () => {
    const lead = await customer(ali, "Admin call lead");
    await logCall(ali, lead, "Not interested");
    await moveAll([lead], sara);
    // An administrator calls first: the call is kept and shown, but Sara's
    // first call, New and the previous result stay.
    await logCall(admin, lead, "Interested", { notes: "Owner spoke to him" });
    expect(
      await one(
        "select l.first_call_at lead_first,(select a.first_call_at from assignments a where a.lead_id=l.id order by a.created_at desc,a.id desc limit 1) assignment_first from leads l where l.id=$1",
        [lead],
      ),
    ).toEqual({ lead_first: null, assignment_first: null });
    expect(await row(sara, lead, "&call=uncalled")).toMatchObject({
      reassigned: true,
      first_call_at: null,
      previous_result: "not_interested",
      last_call_outcome: "Interested",
    });
    // Her deadline passes: a missed first call, though the administrator
    // called.
    await pg.query(
      "update leads set call_due_at=now()-interval '1 hour' where id=$1",
      [lead],
    );
    await pg.query("select lead_response_job()");
    expect(
      (
        await one("select missed_at is not null m from leads where id=$1", [
          lead,
        ])
      ).m,
    ).toBe(true);
    // Her own call is the first call.
    await logCall(sara, lead, "Busy");
    const after = await row(sara, lead);
    expect(after).toMatchObject({
      previous_result: null,
      last_call_outcome: "Busy",
    });
    expect(after.first_call_at).not.toBeNull();
    expect(
      await one(
        "select a.agent_id,a.first_call_at is not null called from assignments a where a.lead_id=$1 order by a.created_at desc,a.id desc limit 1",
        [lead],
      ),
    ).toEqual({ agent_id: sara, called: true });
    // Update 063: on a lead's first agent too, an administrator's call is
    // not the agent's first call.
    const first = await customer(ali, "First agent, admin call");
    await logCall(admin, first, "Interested");
    expect(
      (
        await one("select first_call_at is null f from leads where id=$1", [
          first,
        ])
      ).f,
    ).toBe(true);
  });
  it("starts a fresh period at every move: A to B to C, and back to A", async () => {
    const lead = await customer(ali, "Cycle lead");
    const ids = await aliWorks(lead);
    await moveAll([lead], sara);
    await ok(
      send(sara, "post", "/notes", { lead_id: lead, body: "Sara period note" }),
      201,
    );
    await logCall(sara, lead, "Busy");
    const saraDone = await ok(
      send(sara, "post", "/followups", {
        lead_id: lead,
        due_at: inHours(1),
        status: "pending",
        notes: "Sara: done",
      }),
      201,
    );
    await ok(
      send(sara, "patch", `/followups/${saraDone.id}`, { status: "completed" }),
    );
    // To Omar: nothing from Ali or Sara; Ali's pending follow-up and the
    // visit still carried over.
    await moveOne(lead, omar);
    expect(await row(omar, lead)).toMatchObject({
      reassigned: true,
      status: "new",
      last_call_at: null,
    });
    let items = await timeline(omar, lead);
    expect(kinds(items)).toEqual([
      "assignments",
      "followups (carried)",
      "visits (carried)",
    ]);
    expect(items.find((i) => i.kind === "followups").id).toBe(ids.pending);
    expect(JSON.stringify(items)).not.toMatch(
      /Sara period note|Sara: done|Ali/,
    );
    // Back to Ali (A, B, C, A): a fresh period for him too.
    await moveAll([lead], ali);
    items = await timeline(ali, lead);
    expect(kinds(items)).toEqual([
      "assignments",
      "followups (carried)",
      "visits (carried)",
    ]);
    expect(JSON.stringify(items)).not.toMatch(/private note|corner plot|Sara/);
    expect(await row(ali, lead)).toMatchObject({
      reassigned: true,
      note: null,
      temperature: null,
    });
    expect(
      (await ok(get(ali, "/followups"))).data
        .filter((f) => f.lead_id === lead)
        .map((f) => [f.id, f.notes]),
    ).toEqual([[ids.pending, null]]);
    // The administrator has all three periods.
    const full = await timeline(admin, lead);
    expect(full.filter((i) => i.kind === "assignments")).toHaveLength(4);
    expect(JSON.stringify(full)).toMatch(/Sara period note/);
    expect(JSON.stringify(full)).toMatch(/Ali's private note/);
  });

  it("leaves a lead's first agent, and a lead returned to the same agent, with the whole history", async () => {
    const lead = await customer(ali, "First agent lead");
    await ok(
      send(admin, "post", "/notes", {
        lead_id: lead,
        body: "Owner's intake note",
      }),
      201,
    );
    await logCall(ali, lead, "Interested", { notes: "First call" });
    // To the admin team and back to Ali: never anyone else's.
    await pg.query("select handover_lead($1,$2,null,'t')", [lead, admin]);
    await moveOne(lead, ali);
    expect(await row(ali, lead)).toMatchObject({
      reassigned: false,
      last_call_outcome: "Interested",
    });
    expect(kinds(await timeline(ali, lead))).toEqual(
      expect.arrayContaining(["calls", "notes"]),
    );
    expect((await ok(get(ali, `/leads/${lead}`))).reassigned).toBe(false);
  });

  it("scopes an agent's own report rows, not the administrator's or the numbers", async () => {
    const lead = await customer(ali, "Report lead");
    await aliWorks(lead);
    await moveAll([lead], sara);
    const range = `from=${encodeURIComponent(inHours(-24 * 7))}&to=${encodeURIComponent(inHours(24))}`;
    const today = (user) =>
      ok(
        get(
          user,
          `/reports/drilldown?report=today&metric=waiting&key=${sara}&${range}`,
        ),
      );
    const own = await today(sara);
    const mine = own.data.find((r) => r.lead.id === lead);
    expect(mine).toMatchObject({
      last_call: null,
      calls: 0,
      temperature: null,
    });
    expect(mine.lead.status).toBe("interested");
    const theirs = (await today(admin)).data.find((r) => r.lead.id === lead);
    expect(theirs).toMatchObject({ calls: 1, temperature: "Warm lead" });
    expect(theirs.last_call.outcome).toBe("Interested");
    expect(own.value).toBe((await today(admin)).value);
  });
});
