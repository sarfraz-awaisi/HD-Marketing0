import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 067: a lead an administrator gives to a different agent starts
// fresh for that agent. The earlier agent's pending follow-ups and scheduled
// visits are cancelled (their unread reminders removed), the earlier
// assignment's open deal stays out of sight until it changes, and the
// earlier result ("Previously not interested") is never given to the new
// agent. Administrators keep all of it. A lead's first agent, a lead left
// with no agent, and a lead given to its own agent keep everything as
// before.
const admin = "67100000-0000-4000-8000-000000000001",
  ali = "67100000-0000-4000-8000-000000000002",
  sara = "67100000-0000-4000-8000-000000000003";
let pg, db, one, all, phoneNo, property;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Park View Residence','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
  phoneNo = 0;
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const api = (user, method, path, body) =>
  request(app())
    [method]("/api" + path)
    .set(as(user))
    .send(body);
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
async function newLead(owner, name) {
  return (
    await one("select (public.create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, assigned_agent: owner }),
      "+9230068" + String(++phoneNo).padStart(5, "0"),
      admin,
    ])
  ).id;
}
const followUp = async (lead, agent, status = "pending", notes = "Call back") =>
  (
    await one(
      "insert into followups(lead_id,agent_id,due_at,status,notes) values($1,$2,now()+interval '1 day',$3,$4) returning id",
      [lead, agent, status, notes],
    )
  ).id;
const visit = async (lead, agent, status = "scheduled") =>
  (
    await one(
      "insert into visits(lead_id,agent_id,property_id,scheduled_at,status,notes) values($1,$2,$3,now()+interval '2 days',$4,'Bring the file') returning id",
      [lead, agent, property, status],
    )
  ).id;
// One reminder per follow-up and time (reminders_followup_id_due_at_key):
// a read one an hour before the unread one.
const reminder = async (followup, agent, read = false) =>
  (
    await one(
      `insert into reminders(agent_id,followup_id,due_at,read_at) values($1,$2,now()+interval '1 day'-interval '${read ? 1 : 0} hour',${read ? "now()" : "null"}) returning id`,
      [agent, followup],
    )
  ).id;
const state = (table, id) =>
  one(`select agent_id,status,notes from ${table} where id=$1`, [id]);
// What the lead's current agent sees, by the database's own rule
// (workspace_state, update 061): the timeline, lists and calendar all keep
// "current" and "carried" records and leave "hidden" ones out. The API
// readings themselves are checked in reassigned-workspace.test.js.
const kindsSeen = async (lead) => [
  ...new Set(
    (
      await all(
        `select k from (
           select 'assignments' k,public.workspace_state(x) s from assignments x where lead_id=$1
           union all select 'notes',public.workspace_state(x) from notes x where lead_id=$1
           union all select 'calls',public.workspace_state(x) from calls x where lead_id=$1
           union all select 'followups',public.workspace_state(x) from followups x where lead_id=$1
           union all select 'visits',public.workspace_state(x) from visits x where lead_id=$1
           union all select 'deals',public.workspace_state(x) from deals x where lead_id=$1
         ) r where s<>'hidden' order by k`,
        [lead],
      )
    ).map((r) => r.k),
  ),
];

describe("a lead given to a different agent starts fresh (update 067)", () => {
  it("cancels the earlier agent's pending follow-ups and scheduled visits, and keeps everything else", async () => {
    const lead = await newLead(ali, "Hamza Buyer");
    const pending = await followUp(lead, ali, "pending", "Ali: after Friday");
    const done = await followUp(lead, ali, "completed", "Ali: done");
    const booked = await visit(lead, ali);
    const visited = await visit(lead, ali, "completed");
    const unread = await reminder(pending, ali);
    const read = await reminder(pending, ali, true);

    const moved = await api(admin, "post", `/leads/${lead}/assign`, {
      agent_id: sara,
    }).expect(200);
    const requestId = moved.headers["x-request-id"];

    // Cancelled, not moved: still Ali's, with his comments.
    expect(await state("followups", pending)).toEqual({
      agent_id: ali,
      status: "cancelled",
      notes: "Ali: after Friday",
    });
    expect(await state("visits", booked)).toEqual({
      agent_id: ali,
      status: "cancelled",
      notes: "Bring the file",
    });
    // Finished work is untouched.
    expect(await state("followups", done)).toMatchObject({
      agent_id: ali,
      status: "completed",
    });
    expect(await state("visits", visited)).toMatchObject({
      agent_id: ali,
      status: "completed",
    });
    // The unread reminder is removed; a read one stays as a record.
    expect(
      (await all("select id from reminders where followup_id=$1", [pending]))
        .map((r) => r.id)
        .sort(),
    ).toEqual([read]);
    expect(unread).not.toBe(read);
    // Each cancellation is recorded, in the same request as the move.
    expect(
      await all(
        "select actor_id,action,entity,entity_id,request_id from audit_log where action like '%.reassignment_cancelled' order by action",
      ),
    ).toEqual([
      {
        actor_id: admin,
        action: "followup.reassignment_cancelled",
        entity: "followups",
        entity_id: pending,
        request_id: requestId,
      },
      {
        actor_id: admin,
        action: "visit.reassignment_cancelled",
        entity: "visits",
        entity_id: booked,
        request_id: requestId,
      },
    ]);

    // Sara starts fresh: no follow-up, visit or reminder from Ali.
    expect(await kindsSeen(lead)).toEqual(["assignments"]);
    expect(
      (
        await one("select count(*)::int n from reminders where agent_id=$1", [
          sara,
        ])
      ).n,
    ).toBe(0);
    // The administrator keeps all of it, cancelled where it was pending.
    expect(
      await all(
        "select id::text,status from followups where lead_id=$1 union all select id::text,status from visits where lead_id=$1 order by 1",
        [lead],
      ),
    ).toEqual(
      [
        { id: pending, status: "cancelled" },
        { id: done, status: "completed" },
        { id: booked, status: "cancelled" },
        { id: visited, status: "completed" },
      ].sort((a, b) => a.id.localeCompare(b.id)),
    );
    // Each entry records the lead, the new agent, whose commitment it was
    // and its day (Pakistan time).
    const day = (column, table, id) =>
      one(
        `select to_char(${column} at time zone 'Asia/Karachi','YYYY-MM-DD') d from ${table} where id=$1`,
        [id],
      );
    expect(
      await all(
        "select entity_id,metadata from audit_log where action like '%.reassignment_cancelled' order by action",
      ),
    ).toEqual([
      {
        entity_id: pending,
        metadata: {
          lead_id: lead,
          agent_id: sara,
          user_id: ali,
          previous_agent_id: ali,
          due_on: (await day("due_at", "followups", pending)).d,
        },
      },
      {
        entity_id: booked,
        metadata: {
          lead_id: lead,
          agent_id: sara,
          user_id: ali,
          previous_agent_id: ali,
          visit_on: (await day("scheduled_at", "visits", booked)).d,
        },
      },
    ]);
    // Audit history explains it in plain English, naming both agents, and
    // finds it by the earlier agent's name.
    const history = (
      await api(admin, "get", "/audit?module=activities&limit=100").expect(200)
    ).body.data;
    const entry = history.find(
      (e) => e.title === "Cancelled a follow-up when the lead was reassigned",
    );
    expect(entry.description).toMatch(
      /^Cancelled Ali Agent's pending follow-up due [A-Z][a-z]+ \d{1,2}, \d{4} for lead HD-\d{6} when the lead was given to Sara Agent\.$/,
    );
    expect(
      history.find(
        (e) =>
          e.title === "Cancelled a site visit when the lead was reassigned",
      ).description,
    ).toMatch(
      /^Cancelled Ali Agent's site visit booked for [A-Z][a-z]+ \d{1,2}, \d{4} for lead HD-\d{6} when the lead was given to Sara Agent\.$/,
    );
    const byName = (
      await api(admin, "get", "/audit?search=Ali&limit=100").expect(200)
    ).body.data.map((e) => e.title);
    expect(byName).toEqual(
      expect.arrayContaining([
        "Cancelled a follow-up when the lead was reassigned",
        "Cancelled a site visit when the lead was reassigned",
      ]),
    );
  });

  it("does the same for many leads at once and for an edited lead", async () => {
    const first = await newLead(ali, "Bulk one");
    const second = await newLead(ali, "Bulk two");
    const f1 = await followUp(first, ali);
    const f2 = await followUp(second, ali);
    const v2 = await visit(second, ali);
    await api(admin, "post", "/leads/assign-selected", {
      lead_ids: [first, second],
      agent_id: sara,
    }).expect(200);
    for (const [table, id] of [
      ["followups", f1],
      ["followups", f2],
      ["visits", v2],
    ])
      expect(await state(table, id), `${table} ${id}`).toMatchObject({
        agent_id: ali,
        status: "cancelled",
      });
    // An administrator's edit that changes the agent.
    const edited = await newLead(ali, "Edited lead");
    const f3 = await followUp(edited, ali);
    await pg.query("select edit_lead($1,$2,$3,'edit-fixture')", [
      edited,
      JSON.stringify({ assigned_agent: sara }),
      admin,
    ]);
    expect(await state("followups", f3)).toMatchObject({
      agent_id: ali,
      status: "cancelled",
    });
  });

  it("keeps the commitments of a lead's first agent, of a lead left with no agent, and of a lead given to its own agent", async () => {
    // A lead's first agent: an administrator's follow-up moves to them.
    const fresh = await newLead(null, "Unassigned lead");
    const intake = await followUp(
      fresh,
      admin,
      "pending",
      "Owner: intake call",
    );
    await api(admin, "post", `/leads/${fresh}/assign`, {
      agent_id: ali,
    }).expect(200);
    expect(await state("followups", intake)).toMatchObject({
      agent_id: ali,
      status: "pending",
    });
    // Given to its own agent: nothing changes.
    await api(admin, "post", `/leads/${fresh}/assign`, {
      agent_id: ali,
    }).expect(200);
    expect(await state("followups", intake)).toMatchObject({
      agent_id: ali,
      status: "pending",
    });
    // Left with no agent: the commitments go to the administrator, as before.
    await pg.query("select handover_lead($1,$2,null,'pool')", [fresh, admin]);
    expect(await state("followups", intake)).toMatchObject({
      agent_id: admin,
      status: "pending",
    });
    // Then given to a different agent than before: a fresh start.
    await api(admin, "post", `/leads/${fresh}/assign`, {
      agent_id: sara,
    }).expect(200);
    expect(await state("followups", intake)).toMatchObject({
      agent_id: admin,
      status: "cancelled",
    });
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where action like '%.reassignment_cancelled'",
        )
      ).n,
    ).toBe(1);
  });

  it("keeps an earlier assignment's open deal out of the new agent's sight until it changes, and for administrators as it was", async () => {
    const lead = await newLead(ali, "Deal lead");
    const deal = (
      await one(
        "insert into deals(lead_id,property_id,agent_id,stage,expected_value) values($1,$2,$3,'negotiation',25000000) returning id",
        [lead, property, ali],
      )
    ).id;
    await api(admin, "post", `/leads/${lead}/assign`, {
      agent_id: sara,
    }).expect(200);
    // Sara does not see Ali's open deal; it is unchanged for administrators
    // and the reports.
    expect(await kindsSeen(lead)).toEqual(["assignments"]);
    expect(
      await one(
        "select agent_id,stage,expected_value::int v from deals where id=$1",
        [deal],
      ),
    ).toEqual({ agent_id: ali, stage: "negotiation", v: 25000000 });
    // Once the deal changes during Sara's assignment, it is hers to see.
    await pg.query("update deals set expected_value=24000000 where id=$1", [
      deal,
    ]);
    expect(await kindsSeen(lead)).toEqual(["assignments", "deals"]);
  });

  it("never gives the new agent the earlier assignment's result", async () => {
    const lead = await newLead(ali, "Not interested lead");
    await db.rpc("log_manual_call", {
      p_lead: lead,
      p_actor: ali,
      p_data: {
        answered: true,
        started_at: new Date(Date.now() - 60000).toISOString(),
        duration_seconds: 60,
        outcome: "Not interested",
        deal_tags: [],
      },
      p_request: "fixture",
    });
    await api(admin, "post", `/leads/${lead}/assign`, {
      agent_id: sara,
    }).expect(200);
    const details = (await api(sara, "get", `/leads/${lead}`).expect(200)).body;
    expect(details).toMatchObject({ reassigned: true, status: "new" });
    expect(details).not.toHaveProperty("previous_result");
    const row = (
      await api(sara, "get", "/my-leads?view=assigned").expect(200)
    ).body.data.find((r) => r.id === lead);
    expect(row).toMatchObject({ reassigned: true, previous_result: null });
    expect(
      (
        await one("select public.lead_workspace($1)->'previous_result' r", [
          lead,
        ])
      ).r,
    ).toBeNull();
  });
});
