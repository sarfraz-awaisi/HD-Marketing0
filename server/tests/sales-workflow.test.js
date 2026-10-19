import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 038: first-call tracking, admin review (no automatic reassignment),
// notifications and working hours.
const admin = "a8000000-0000-4000-8000-000000000001",
  agent = "a8000000-0000-4000-8000-000000000002",
  other = "a8000000-0000-4000-8000-000000000003";
let pg,
  db,
  one,
  all,
  phone = 0;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(() => resetPeople(pg, [admin, agent, other]));
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
async function newLead(owner = agent, name = "Customer") {
  phone += 1;
  return (
    await one("select (public.create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, ...(owner ? { assigned_agent: owner } : {}) }),
      "+9230011" + String(phone).padStart(5, "0"),
      admin,
    ])
  ).id;
}
const leadRow = (id) => one("select * from leads where id=$1", [id]);
const notices = (user, type) =>
  all(
    "select type,title,body,link,lead_id,item_count,read_at from notifications where user_id=$1 and ($2::text is null or type=$2) order by created_at,title",
    [user, type || null],
  );
const logCall = (lead, actor = agent) =>
  one("select public.log_manual_call($1,$2,$3::jsonb,'fixture') as result", [
    lead,
    actor,
    JSON.stringify({
      answered: false,
      started_at: new Date().toISOString(),
      duration_seconds: 0,
      outcome: "No answer",
    }),
  ]);
const job = async () =>
  (await one("select public.run_crm_job('response','{}') as r")).r;
// Pakistan wall-clock time, shifted by minutes, as HH:MM (null near midnight).
function pakistanClock(shift = 0) {
  const now = new Date(Date.now() + 5 * 3600000 + shift * 60000);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const base = new Date(Date.now() + 5 * 3600000);
  if (now.getUTCDate() !== base.getUTCDate()) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

describe("first-call deadlines in working hours", () => {
  it.each([
    ["Monday 11:00", "2026-10-19T11:00:00+05:00", "2026-10-19T13:00:00.000Z"],
    [
      "Monday 08:00, before opening",
      "2026-10-19T08:00:00+05:00",
      "2026-10-19T13:00:00.000Z",
    ],
    [
      "Monday 16:00, exactly two hours left",
      "2026-10-19T16:00:00+05:00",
      "2026-10-19T13:00:00.000Z",
    ],
    [
      "Monday 16:30, last-call window",
      "2026-10-19T16:30:00+05:00",
      "2026-10-20T13:00:00.000Z",
    ],
    [
      "Monday 21:00, after closing",
      "2026-10-19T21:00:00+05:00",
      "2026-10-20T13:00:00.000Z",
    ],
    [
      "Saturday 19:00, before Sunday off",
      "2026-10-17T19:00:00+05:00",
      "2026-10-19T13:00:00.000Z",
    ],
    ["Sunday noon", "2026-10-18T12:00:00+05:00", "2026-10-19T13:00:00.000Z"],
  ])("%s is due at the right close", async (_label, at, due) => {
    expect(
      new Date(
        (await one("select public.first_call_due($1) as due", [at])).due,
      ).toISOString(),
    ).toBe(due);
  });
  it("counts only working minutes for first-call speed", async () => {
    for (const [from, to, minutes] of [
      ["2026-10-19T17:00:00+05:00", "2026-10-20T11:00:00+05:00", 120],
      ["2026-10-17T17:00:00+05:00", "2026-10-19T11:00:00+05:00", 120],
      ["2026-10-19T11:00:00+05:00", "2026-10-19T11:45:00+05:00", 45],
      ["2026-10-19T19:00:00+05:00", "2026-10-19T09:00:00+05:00", 0],
    ])
      expect(
        (await one("select public.working_minutes($1,$2) as m", [from, to])).m,
      ).toBe(minutes);
  });
});

describe("assignment, first calls and notifications", () => {
  it("starts the clock on assignment and stops it on the owner's first logged call", async () => {
    const id = await newLead();
    let lead = await leadRow(id);
    expect(lead.assigned_at).not.toBeNull();
    expect(new Date(lead.call_due_at) > new Date()).toBe(true);
    expect(
      await one(
        "select to_char(call_due_at at time zone 'Asia/Karachi','HH24:MI') t,extract(isodow from call_due_at at time zone 'Asia/Karachi')::int d from leads where id=$1",
        [id],
      ),
    ).toMatchObject({ t: "18:00" });
    const assignment = await one(
      "select call_due_at from assignments where lead_id=$1",
      [id],
    );
    expect(assignment.call_due_at).toEqual(lead.call_due_at);
    // A call by someone other than the owner does not count.
    await pg.query(
      "insert into calls(lead_id,agent_id,status) values($1,$2,'initiated')",
      [id, other],
    );
    expect((await leadRow(id)).first_call_at).toBeNull();
    await logCall(id);
    lead = await leadRow(id);
    expect(lead.first_call_at).not.toBeNull();
    expect(
      (
        await one("select first_call_at from assignments where lead_id=$1", [
          id,
        ])
      ).first_call_at,
    ).toEqual(lead.first_call_at);
    // A second call keeps the original first-call time.
    await logCall(id);
    expect((await leadRow(id)).first_call_at).toEqual(lead.first_call_at);
  });
  it("notifies the new owner once, summarises bulk assignments and tells the previous owner", async () => {
    const id = await newLead(agent, "Ayesha Khan");
    const [assigned] = await notices(agent, "lead_assigned");
    expect(assigned).toMatchObject({
      title: expect.stringMatching(/^New lead assigned: HD-\d{6}$/),
      link: "/leads/" + id,
      lead_id: id,
      item_count: 1,
    });
    expect(assigned.body).toMatch(/^Ayesha Khan · First call due by /);
    expect(assigned.body).not.toMatch(/\d{7,}/);
    const ids = [await newLead(null), await newLead(null), await newLead(null)];
    await pg.query("truncate notifications");
    await one(
      "select public.assign_leads_bulk($1,$2,'agent',$3,'bulk-fixture') as r",
      [ids, admin, other],
    );
    expect(await notices(other, "lead_assigned")).toEqual([
      expect.objectContaining({
        title: "3 new leads assigned to you",
        link: "/leads?view=all&call=uncalled",
        lead_id: null,
        item_count: 3,
      }),
    ]);
    await one("select public.assign_lead($1,$2,$3,'move') as r", [
      id,
      admin,
      other,
    ]);
    expect(await notices(agent, "lead_moved_away")).toEqual([
      expect.objectContaining({
        title: expect.stringMatching(/^Lead reassigned: HD-/),
        body: "An administrator moved Ayesha Khan to another agent.",
        link: null,
      }),
    ]);
    const lead = await leadRow(id);
    expect(lead.first_call_at).toBeNull();
    expect(new Date(lead.call_due_at) > new Date()).toBe(true);
  });
  it("does not notify disabled accounts during offboarding", async () => {
    const id = await newLead(agent);
    await pg.query("truncate notifications");
    await pg.query("update profiles set active=false where id=$1", [agent]);
    await one("select public.handover_lead($1,$2,$3,'offboard') as r", [
      id,
      admin,
      other,
    ]);
    expect(await notices(agent)).toEqual([]);
    expect(await notices(other, "lead_assigned")).toHaveLength(1);
  });
  it("removes a lead's notifications when the lead is permanently purged", async () => {
    const id = await newLead(agent);
    await one(
      "select public.delete_leads($1,$2,'Customer asked to erase','x')",
      [[id], admin],
    );
    await pg.query(
      "update leads set deleted_at=now()-interval '40 days' where id=$1",
      [id],
    );
    await pg.query("delete from crm_private.lead_purge_runs");
    expect(
      (await one("select public.purge_deleted_leads(30) as r")).r.purged,
    ).toBe(1);
    expect(
      (
        await one(
          "select count(*)::int n from notifications where lead_id=$1",
          [id],
        )
      ).n,
    ).toBe(0);
  });
});

describe("missed first calls wait for an administrator", () => {
  it("lists missed calls, notifies once and never reassigns", async () => {
    const late = await newLead(agent, "Late Lead");
    const onTime = await newLead(agent, "Fresh Lead");
    await pg.query(
      "update leads set call_due_at=now()-interval '2 hours' where id=$1",
      [late],
    );
    expect(
      await all("select id,kind from lead_review_queue order by kind"),
    ).toEqual([{ id: late, kind: "missed" }]);
    expect((await job()).affected).toBe(1);
    expect((await job()).affected).toBe(0);
    const lead = await leadRow(late);
    expect(lead.assigned_agent).toBe(agent);
    expect(lead.missed_at).not.toBeNull();
    expect(
      (await one("select missed_at from assignments where lead_id=$1", [late]))
        .missed_at,
    ).not.toBeNull();
    expect(await notices(agent, "first_call_missed")).toEqual([
      expect.objectContaining({
        title: expect.stringMatching(/^Missed first call: HD-/),
        link: "/leads/" + late,
      }),
    ]);
    expect(await notices(admin, "missed_calls_review")).toEqual([
      expect.objectContaining({
        title: "Missed first calls: 1 lead to review",
        body: "Ali Agent: 1. Choose Keep or Reassign on the Overview.",
        link: "/?review=missed",
      }),
    ]);
    expect((await leadRow(onTime)).missed_at).toBeNull();
  });
  it("keeps a missed lead with its agent and sets a new deadline", async () => {
    const late = await newLead(agent, "Late Lead");
    const fine = await newLead(agent);
    await pg.query(
      "update leads set call_due_at=now()-interval '1 hour',missed_at=now() where id=$1",
      [late],
    );
    await pg.query("truncate notifications");
    const result = (
      await one(
        "select public.review_keep_leads($1,$2,'missed','keep-fixture') as r",
        [admin, [late, fine, "a8000000-0000-4000-8000-0000000000ff"]],
      )
    ).r;
    expect(result.kept).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.results).toEqual(
      expect.arrayContaining([
        { id: late, result: "kept" },
        { id: fine, result: "skipped", reason: "No longer needs review" },
        {
          id: "a8000000-0000-4000-8000-0000000000ff",
          result: "skipped",
          reason: "Lead not found",
        },
      ]),
    );
    const lead = await leadRow(late);
    expect(lead.assigned_agent).toBe(agent);
    expect(lead.missed_at).toBeNull();
    expect(new Date(lead.call_due_at) > new Date()).toBe(true);
    expect(await notices(agent, "lead_kept")).toEqual([
      expect.objectContaining({
        title: expect.stringMatching(/^Kept with you: HD-/),
      }),
    ]);
    expect(
      await one(
        "select action,metadata->>'kind' kind from audit_log where action='lead.review_kept'",
      ),
    ).toEqual({ action: "lead.review_kept", kind: "missed" });
    expect(
      (await all("select id from lead_review_queue")).map((r) => r.id),
    ).not.toContain(late);
  });
  it("reassigns reviewed leads with a recorded reason and a fresh clock", async () => {
    const late = await newLead(agent);
    await pg.query(
      "update leads set call_due_at=now()-interval '1 hour' where id=$1",
      [late],
    );
    const result = (
      await one(
        "select public.review_reassign_leads($1,$2,'missed','agent',$3,'reassign-fixture') as r",
        [admin, [late], other],
      )
    ).r;
    expect(result.assigned).toBe(1);
    const lead = await leadRow(late);
    expect(lead.assigned_agent).toBe(other);
    expect(new Date(lead.call_due_at) > new Date()).toBe(true);
    expect(
      await one(
        "select agent_id,reason from assignments where lead_id=$1 order by created_at desc,id desc limit 1",
        [late],
      ),
    ).toEqual({ agent_id: other, reason: "missed_first_call" });
    await one(
      "select public.review_reassign_leads($1,$2,'missed','unassign',null,'pool') as r",
      [admin, [late]],
    );
    expect((await leadRow(late)).assigned_agent).toBeNull();
    // Later ordinary assignments carry no review reason.
    await one("select public.assign_lead($1,$2,$3,'plain') as r", [
      late,
      admin,
      agent,
    ]);
    expect(
      (
        await one(
          "select reason from assignments where lead_id=$1 order by created_at desc,id desc limit 1",
          [late],
        )
      ).reason,
    ).toBeNull();
  });
  it("lists quiet leads unless a follow-up is planned or the admin kept them", async () => {
    const quiet = await newLead(agent);
    const planned = await newLead(agent);
    await pg.query(
      "update leads set first_call_at=now()-interval '9 days',last_activity_at=now()-interval '9 days' where id=any($1::uuid[])",
      [[quiet, planned]],
    );
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '1 day')",
      [planned, agent],
    );
    const page = (
      await one("select public.lead_review_page($1,'idle',1,10) as r", [admin])
    ).r;
    expect(page.data.map((r) => r.id)).toEqual([quiet]);
    expect(page.counts).toEqual({ missed: 0, idle: 1 });
    expect(page.data[0]).not.toHaveProperty("masked_phone");
    await one("select public.review_keep_leads($1,$2,'idle','keep') as r", [
      admin,
      [quiet],
    ]);
    expect(
      (
        await one("select public.lead_review_page($1,'idle',1,10) as r", [
          admin,
        ])
      ).r.count,
    ).toBe(0);
    await expect(
      one("select public.lead_review_page($1,'idle',1,10) as r", [agent]),
    ).rejects.toMatchObject({ code: "42501" });
  });
});

describe("timed reminders and summaries", () => {
  it("reminds agents in the last-call window about leads due today", async (ctx) => {
    const end = pakistanClock(30);
    if (!end || pakistanClock(-61) === null) return ctx.skip();
    await pg.query(
      "update crm_settings set work_days='{1,2,3,4,5,6,7}',work_start='00:00',work_end=$1,first_call_grace_minutes=60",
      [end],
    );
    const id = await newLead(agent);
    await pg.query(
      "update leads set call_due_at=now()+interval '20 minutes' where id=$1",
      [id],
    );
    expect((await job()).due_soon).toBe(1);
    expect((await job()).due_soon).toBe(0);
    expect(await notices(agent, "calls_due_soon")).toEqual([
      expect.objectContaining({
        title: "1 lead needs a first call today",
        link: "/leads?view=all&call=uncalled",
      }),
    ]);
  });
  it("sends tomorrow's visits and the admins' end-of-day call summary once", async (ctx) => {
    const end = pakistanClock(-1);
    if (!end || pakistanClock(-6) === null) return ctx.skip();
    await pg.query(
      "update crm_settings set work_days='{1,2,3,4,5,6,7}',work_start='00:00',work_end=$1,first_call_grace_minutes=0",
      [end],
    );
    const id = await newLead(agent);
    await logCall(id);
    const property = (
      await one(
        "insert into properties(title,location,price,type,area,area_unit) values('Visit house','Lahore',1,'House',5,'marla') returning id",
      )
    ).id;
    await pg.query(
      "insert into visits(lead_id,property_id,agent_id,scheduled_at) values($1,$2,$3,(((now() at time zone 'Asia/Karachi')::date+1)+time '11:00') at time zone 'Asia/Karachi')",
      [id, property, agent],
    );
    const first = await job();
    expect(first).toMatchObject({ visits: 1, summaries: 1 });
    expect(await job()).toMatchObject({ visits: 0, summaries: 0 });
    expect(await notices(agent, "visit_tomorrow")).toEqual([
      expect.objectContaining({
        title: "1 site visit tomorrow",
        body: "First at 11:00 AM. Confirm with your customers today.",
      }),
    ]);
    expect(await notices(admin, "daily_call_summary")).toEqual([
      expect.objectContaining({
        title: "Today's calls: 1 · 1 agent made no calls",
        body: "Ali Agent: 1 call · Sara Agent: 0 calls",
      }),
    ]);
  });
  it("puts follow-up reminders in the bell once", async () => {
    const id = await newLead(agent, "Follow Lead");
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '3 hours')",
      [id, agent],
    );
    await one("select public.run_crm_job('followups','{}') as r");
    await one("select public.run_crm_job('followups','{}') as r");
    expect(await notices(agent, "followup_due")).toEqual([
      expect.objectContaining({
        title: expect.stringMatching(/^Follow-up due: HD-/),
        link: "/leads/" + id,
      }),
    ]);
  });
});

describe("metrics", () => {
  it("reports on-time first calls and working-hours speed", async () => {
    const onTime = await newLead(agent);
    const late = await newLead(agent);
    await pg.query(
      "update assignments set created_at='2026-10-19T11:00:00+05:00',call_due_at='2026-10-19T18:00:00+05:00' where lead_id=$1",
      [onTime],
    );
    await pg.query(
      "update assignments set created_at='2026-10-19T17:00:00+05:00',call_due_at='2026-10-19T18:00:00+05:00' where lead_id=$1",
      [late],
    );
    await pg.query(
      "update assignments set first_call_at='2026-10-19T12:00:00+05:00' where lead_id=$1",
      [onTime],
    );
    await pg.query(
      "update assignments set first_call_at='2026-10-20T11:00:00+05:00',missed_at='2026-10-19T18:01:00+05:00' where lead_id=$1",
      [late],
    );
    const metrics = (
      await one(
        "select public.crm_metrics($1,'2026-10-01T00:00:00+05:00','2026-11-01T00:00:00+05:00') as m",
        [admin],
      )
    ).m;
    expect(metrics).toMatchObject({
      first_calls: 2,
      first_calls_with_deadline: 2,
      on_time_first_calls: 1,
      avg_first_call_minutes: 90,
      missed_in_period: 1,
    });
    const own = (
      await one(
        "select public.crm_metrics($1,'2026-10-01T00:00:00+05:00','2026-11-01T00:00:00+05:00',$2) as m",
        [other, agent],
      )
    ).m;
    expect(own.first_calls).toBe(0);
  });
});

describe("sales workflow API", () => {
  it("lets each user read and clear only their own notifications", async () => {
    await newLead(agent);
    await newLead(other);
    let r = await request(app()).get("/api/notifications").set(as(agent));
    expect(r.status).toBe(200);
    expect(r.body.unread).toBe(1);
    expect(r.body.data).toHaveLength(1);
    r = await request(app())
      .post("/api/notifications/read")
      .set(as(agent))
      .send({
        ids: [r.body.data[0].id, "a8000000-0000-4000-8000-0000000000aa"],
      });
    expect(r.body).toEqual({ read: 1 });
    expect(
      (
        await one(
          "select count(*)::int n from notifications where user_id=$1 and read_at is null",
          [other],
        )
      ).n,
    ).toBe(1);
    r = await request(app())
      .post("/api/notifications/read")
      .set(as(other))
      .send({});
    expect(r.body).toEqual({ read: 1 });
    expect(
      (
        await request(app())
          .post("/api/notifications/read")
          .set(as(other))
          .send({ ids: [] })
      ).status,
    ).toBe(400);
  });
  it("keeps the review list and its decisions admin-only and validated", async () => {
    const late = await newLead(agent);
    await pg.query(
      "update leads set call_due_at=now()-interval '1 hour' where id=$1",
      [late],
    );
    expect(
      (await request(app()).get("/api/lead-review").set(as(agent))).status,
    ).toBe(403);
    const list = await request(app())
      .get("/api/lead-review?kind=missed")
      .set(as(admin));
    expect(list.status).toBe(200);
    expect(list.body.data.map((r) => r.id)).toEqual([late]);
    expect(list.body.data[0]).toMatchObject({ agent_name: "Ali Agent" });
    for (const body of [
      { lead_ids: [late], kind: "missed", mode: "agent" },
      { lead_ids: [late], kind: "missed", mode: "unassign", agent_id: other },
      { lead_ids: [late, late], kind: "missed", mode: "unassign" },
    ])
      expect(
        (
          await request(app())
            .post("/api/lead-review/reassign")
            .set(as(admin))
            .send(body)
        ).status,
      ).toBe(400);
    const keep = await request(app())
      .post("/api/lead-review/keep")
      .set(as(admin))
      .send({ lead_ids: [late], kind: "missed" });
    expect(keep.body.kept).toBe(1);
    expect(
      (
        await request(app())
          .post("/api/lead-review/keep")
          .set(as(agent))
          .send({ lead_ids: [late], kind: "missed" })
      ).status,
    ).toBe(403);
  });
  it("shows agents their own call queue without contact numbers or phone-view records", async () => {
    const mine = await newLead(agent, "Queue Lead");
    await newLead(other);
    const r = await request(app()).get("/api/first-call-queue").set(as(agent));
    expect(r.status).toBe(200);
    expect(r.body.data.map((row) => row.id)).toEqual([mine]);
    expect(r.body).toMatchObject({ waiting: 1, missed: 0 });
    expect(JSON.stringify(r.body)).not.toMatch(/phone|\+92/);
    expect(
      (await one("select count(*)::int n from crm_private.phone_reveals")).n,
    ).toBe(0);
    const activity = await request(app())
      .get("/api/call-activity")
      .set(as(agent));
    expect(activity.body.agents.map((a) => a.agent_id)).toEqual([agent]);
    const team = await request(app()).get("/api/call-activity").set(as(admin));
    expect(team.body.agents.map((a) => a.name)).toEqual([
      "Ali Agent",
      "Sara Agent",
    ]);
    expect(team.body.agents[0]).toMatchObject({ waiting: 1, missed: 0 });
  });
  it("saves valid working hours for admins only", async () => {
    const valid = {
      work_days: [1, 2, 3, 4, 5],
      work_start: "09:00",
      work_end: "17:30",
      first_call_grace_minutes: 90,
      idle_days: 5,
    };
    expect(
      (
        await request(app())
          .put("/api/settings/work-hours")
          .set(as(agent))
          .send(valid)
      ).status,
    ).toBe(403);
    for (const body of [
      { ...valid, work_end: "08:00" },
      { ...valid, first_call_grace_minutes: 600 },
      { ...valid, work_days: [] },
      { ...valid, work_days: [1, 1] },
      { ...valid, extra: true },
    ])
      expect(
        (
          await request(app())
            .put("/api/settings/work-hours")
            .set(as(admin))
            .send(body)
        ).status,
      ).toBe(400);
    const saved = await request(app())
      .put("/api/settings/work-hours")
      .set(as(admin))
      .send(valid);
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject(valid);
    expect(
      (await request(app()).get("/api/settings/work-hours").set(as(agent)))
        .body,
    ).toMatchObject(valid);
    expect(
      new Date(
        (
          await one(
            "select public.first_call_due('2026-10-19T16:30:00+05:00') d",
          )
        ).d,
      ).toISOString(),
    ).toBe("2026-10-20T12:30:00.000Z");
    expect(
      await one(
        "select action from audit_log where action='settings.work_hours_updated'",
      ),
    ).toBeTruthy();
  });
});
