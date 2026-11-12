import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { agentPipelineQuery } from "../src/utils/validators.js";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 055: administrators' Lead pipeline, agent by agent. A lead counts
// for an agent only after an answered call the agent made (filed under the
// agent and recorded by the agent in the audit log), on a lead assigned to
// the agent now; leads the agent spoke to that are now someone else's are
// listed apart. Only administrators get in, in the server and the database.
const admin = "55000000-0000-4000-8000-000000000001",
  ali = "55000000-0000-4000-8000-000000000002",
  sara = "55000000-0000-4000-8000-000000000003",
  staff = "55000000-0000-4000-8000-000000000004";
let pg, db, one, phoneNo;
beforeAll(async () => {
  ({ pg, db, one } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'staff@gmail.com',now())",
    [staff],
  );
  await pg.query(
    "update profiles set active=true,role='staff',name='Sam Staff' where id=$1",
    [staff],
  );
  phoneNo = 0;
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const rpc = async (name, args) => {
  const { data, error } = await db.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), error);
  return data;
};
const agents = (query = {}, actor = admin) =>
  rpc("admin_pipeline_agents", { p_actor: actor, p_query: query });
const pipeline = (agent, query = {}, actor = admin) =>
  rpc("admin_agent_pipeline", {
    p_actor: actor,
    p_agent: agent,
    p_query: query,
  });
const names = (result) => result.data.map((r) => r.name);
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
async function newLead(owner, name) {
  return (
    await one("select (public.create_lead($1::jsonb,$2,$3,'fixture')).id", [
      JSON.stringify({ name, assigned_agent: owner }),
      "+9230066" + String(++phoneNo).padStart(5, "0"),
      admin,
    ])
  ).id;
}
// A call logged as the server logs it, so the audit log names the caller.
async function call(lead, actor, { answered = true, minutes = 60, ...data }) {
  return rpc("log_manual_call", {
    p_lead: lead,
    p_actor: actor,
    p_data: {
      answered,
      started_at: ago(minutes),
      duration_seconds: answered ? 90 : 0,
      outcome: answered ? "Interested" : "No answer",
      deal_tags: [],
      ...data,
    },
    p_request: "fixture",
  });
}
const note = (lead, actor, body) =>
  rpc("crm_mutate", {
    p_table: "notes",
    p_id: null,
    p_data: { lead_id: lead, body },
    p_actor: actor,
    p_request: "fixture",
  });
const reassign = (lead, agent) =>
  rpc("assign_lead", {
    p_lead: lead,
    p_actor: admin,
    p_agent: agent,
    p_request: "fixture",
  });
const followUp = (lead, agent, due, status = "pending") =>
  pg.query(
    `insert into followups(lead_id,agent_id,due_at,status) values($1,$2,${due},$3)`,
    [lead, agent, status],
  );
// The end of today in Pakistan, as the database works it out.
const todayEnd =
  "((date_trunc('day',now() at time zone 'Asia/Karachi')+interval '1 day') at time zone 'Asia/Karachi')";

// Ali's and Sara's leads, with every kind of call that must or must not
// count. Returns the leads by name.
async function team() {
  const lead = {};
  for (const name of [
    "Asad",
    "Bilal",
    "Chand",
    "Danish",
    "Ehsan",
    "Faraz",
    "Ghazal",
    "Hamid",
  ])
    lead[name] = await newLead(
      ["Danish"].includes(name) ? sara : ali,
      name + " Khan",
    );
  // Asad: Ali spoke to him (Hot); later an administrator called too.
  await call(lead.Asad, ali, { minutes: 300, deal_tags: ["Hot lead"] });
  await note(lead.Asad, ali, "Wants a corner plot");
  await call(lead.Asad, admin, {
    minutes: 10,
    outcome: "Deal discussion",
    notes: "Owner's call note",
  });
  await note(lead.Asad, admin, "Owner's private remark");
  // Bilal: Ali never got through.
  for (const outcome of ["No answer", "Busy", "Number off"])
    await call(lead.Bilal, ali, { answered: false, outcome, minutes: 200 });
  // Chand: only an administrator spoke to him, on Ali's lead.
  await call(lead.Chand, admin, { minutes: 100 });
  // Danish: Sara spoke to him (Warm), then he became Ali's.
  await call(lead.Danish, sara, { minutes: 250, deal_tags: ["Warm lead"] });
  await note(lead.Danish, sara, "Sara's remark");
  await reassign(lead.Danish, ali);
  // Ehsan: Ali spoke to him (Cold), then he became Sara's.
  await call(lead.Ehsan, ali, {
    minutes: 240,
    deal_tags: ["Cold lead"],
    notes: "Budget too low for DHA",
  });
  await reassign(lead.Ehsan, sara);
  // Faraz: Ali spoke to him, and his later call found the phone off.
  await call(lead.Faraz, ali, { minutes: 120, outcome: "Follow-up required" });
  await call(lead.Faraz, ali, {
    answered: false,
    minutes: 30,
    outcome: "Number off",
  });
  // Ghazal: an answered call with no audit entry: no one is known to have
  // made it, so it counts for no one.
  await pg.query(
    "insert into calls(lead_id,agent_id,status,started_at,ended_at,duration_seconds,outcome) values($1,$2,'completed',now()-interval '1 hour',now()-interval '58 minutes',120,'Interested')",
    [lead.Ghazal, ali],
  );
  // Hamid: Ali spoke to him, then the lead was deleted.
  await call(lead.Hamid, ali, { minutes: 90 });
  await rpc("delete_leads", {
    p_lead_ids: [lead.Hamid],
    p_actor: admin,
    p_reason: "Duplicate customer",
    p_request: "fixture",
  });
  return lead;
}

describe("who an agent spoke to", () => {
  it("counts a lead only after an answered call the agent made, on a lead they have now", async () => {
    const lead = await team();
    const current = await pipeline(ali);
    expect(names(current)).toEqual(["Faraz Khan", "Asad Khan"]);
    expect(current.summary).toEqual({
      contacted: 2,
      hot: 1,
      warm: 0,
      cold: 0,
      none: 1,
      followups_due: 0,
      followups_overdue: 0,
      earlier: 1,
      // Chand (an administrator) and Ghazal (a call with no recorded
      // caller). Danish, answered by Sara before he became Ali's, is not in
      // Ali's own pipeline since update 061.
      answered_by_others: 2,
      answered_by_admins: 1,
      answered_by_other_agents: 0,
      answered_unrecorded: 1,
    });
    // The agent's own Lead pipeline (update 052) lists every lead of his
    // with an answered call in his current assignment, whoever answered it,
    // so its count is his contacts plus those answered by others.
    const own = await rpc("agent_lead_list", {
      p_actor: ali,
      p_query: { view: "pipeline" },
    });
    expect(own.count).toBe(4);
    expect(own.data.map((r) => r.name).sort()).toEqual([
      "Asad Khan",
      "Chand Khan",
      "Faraz Khan",
      "Ghazal Khan",
    ]);
    // Sara: Danish is no longer hers; Ehsan is hers, but only Ali spoke to
    // him, before the move (update 061: not in her pipeline).
    expect((await pipeline(sara)).summary).toMatchObject({
      contacted: 0,
      earlier: 1,
      answered_by_others: 0,
      answered_by_other_agents: 0,
      answered_unrecorded: 0,
    });
    // Ali's earlier contact is Ehsan, now Sara's; Sara's is Danish.
    const earlier = await pipeline(ali, { view: "earlier" });
    expect(earlier.data.map((r) => [r.name, r.owner?.name])).toEqual([
      ["Ehsan Khan", "Sara Agent"],
    ]);
    expect(earlier.data[0]).toMatchObject({
      temperature: null,
      next_followup_at: null,
      last_contact_outcome: "Interested",
      note: "Budget too low for DHA",
    });
    expect(
      (await pipeline(sara, { view: "earlier" })).data.map((r) => [
        r.name,
        r.owner?.name,
        r.note,
      ]),
    ).toEqual([["Danish Khan", "Ali Agent", "Sara's remark"]]);
    // A lead with no agent now is an earlier contact too.
    await pg.query("update leads set assigned_agent=null where id=$1", [
      lead.Ehsan,
    ]);
    expect(
      (await pipeline(ali, { view: "earlier" })).data.map((r) => r.owner),
    ).toEqual([null]);
  });
  it("shows the agent's own latest contact, call and note, never someone else's", async () => {
    await team();
    const rows = Object.fromEntries(
      (await pipeline(ali)).data.map((r) => [r.name, r]),
    );
    // The administrator's later call and note on Asad are not Ali's.
    expect(rows["Asad Khan"]).toMatchObject({
      last_contact_outcome: "Interested",
      last_call_outcome: "Interested",
      last_call_connected: true,
      temperature: "hot",
      note: "Wants a corner plot",
    });
    expect(Date.parse(rows["Asad Khan"].last_contact_at)).toBeLessThan(
      Date.now() - 250 * 60000,
    );
    expect(rows["Faraz Khan"]).toMatchObject({
      last_contact_outcome: "Follow-up required",
      last_call_outcome: "Number off",
      last_call_connected: false,
      temperature: null,
      note: null,
      owner: null,
    });
  });
  it("searches by name or number, and filters by temperature and the agent's latest call", async () => {
    await team();
    const find = async (query) => names(await pipeline(ali, query));
    expect(await find({ search: "asad" })).toEqual(["Asad Khan"]);
    // Faraz is +923006600006: the last digits, or as people write it.
    for (const search of ["00006", "0300 6600006", "+92 300 6600006"])
      expect(await find({ search }), search).toEqual(["Faraz Khan"]);
    // Chand (an administrator's contact) is never found in Ali's pipeline.
    expect(await find({ search: "chand" })).toEqual([]);
    expect(await find({ temperature: "hot" })).toEqual(["Asad Khan"]);
    expect(await find({ temperature: "none" })).toEqual(["Faraz Khan"]);
    expect(await find({ temperature: "warm" })).toEqual([]);
    expect(await find({ outcome: "Number off" })).toEqual(["Faraz Khan"]);
    // Asad's latest call overall was the administrator's Deal discussion,
    // but Ali's latest was Interested.
    expect(await find({ outcome: "Deal discussion" })).toEqual([]);
    expect(await find({ outcome: "Interested" })).toEqual(["Asad Khan"]);
    const filtered = await pipeline(ali, { temperature: "hot" });
    expect([filtered.count, filtered.summary.contacted]).toEqual([1, 2]);
    expect(
      names(await pipeline(ali, { view: "earlier", search: "ehsan" })),
    ).toEqual(["Ehsan Khan"]);
  });
  it("counts follow-ups due by the end of today on all of the agent's leads", async () => {
    const lead = await team();
    await followUp(lead.Asad, ali, "now()-interval '2 days'");
    await followUp(lead.Faraz, ali, `now()+(${todayEnd}-now())/2`);
    // Bilal is not in the pipeline, but his follow-up is Ali's to do.
    await followUp(lead.Bilal, ali, "now()-interval '1 hour'");
    // Not due yet, done, or not Ali's lead any more.
    await followUp(lead.Asad, ali, `${todayEnd}+interval '1 hour'`);
    await followUp(lead.Faraz, ali, "now()-interval '3 days'", "completed");
    await followUp(lead.Ehsan, ali, "now()-interval '1 day'");
    const result = await pipeline(ali);
    expect(result.summary).toMatchObject({
      followups_due: 3,
      followups_overdue: 2,
    });
    expect(Date.parse(result.data[1].next_followup_at)).toBeLessThan(
      Date.now(),
    );
    expect((await agents({ search: "Ali" })).data[0]).toMatchObject({
      followups_due: 3,
      followups_overdue: 2,
    });
  });
  it("pages 20 leads at a time, latest contact first, across every page", async () => {
    const ids = [];
    for (let i = 1; i <= 23; i++) {
      const id = await newLead(ali, `Buyer ${String(i).padStart(2, "0")}`);
      await call(id, ali, { minutes: 500 - i });
      ids.push(id);
    }
    const first = await pipeline(ali);
    const second = await pipeline(ali, { page: 2 });
    expect([first.count, first.data.length, second.data.length]).toEqual([
      23, 20, 3,
    ]);
    expect(names(first)[0]).toBe("Buyer 23");
    expect(names(second)).toEqual(["Buyer 03", "Buyer 02", "Buyer 01"]);
    expect(second.summary.contacted).toBe(23);
  });
});

describe("an agent's own Lead pipeline (My pipeline and Personally contacted)", () => {
  it("counts both across every lead and names who logged a last answered call that was not the agent's", async () => {
    const lead = await team();
    const own = await rpc("agent_lead_list", {
      p_actor: ali,
      p_query: { view: "pipeline" },
    });
    const result = await rpc("agent_pipeline_attribution", {
      p_actor: ali,
      p_leads: [...own.data.map((r) => r.id), lead.Ehsan],
    });
    expect(result).toMatchObject({
      pipeline: own.count,
      personally_contacted: 2,
    });
    // Asad was Ali's, but the administrator answered last; Chand only the
    // administrator; Ghazal no one on record. Faraz was last answered by
    // Ali, and Ehsan is Sara's now. Danish was answered by Sara before he
    // became Ali's: not in Ali's pipeline (update 061).
    expect(result.answered_by).toEqual({
      [lead.Asad]: "admin",
      [lead.Chand]: "admin",
      [lead.Ghazal]: "unknown",
    });
    await expect(
      rpc("agent_pipeline_attribution", { p_actor: admin, p_leads: [] }),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      rpc("agent_pipeline_attribution", {
        p_actor: ali,
        p_leads: Array.from(
          { length: 101 },
          (_, i) => `55000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        ),
      }),
    ).rejects.toMatchObject({ code: "22023" });
  });
  it("adds them to the agent's pipeline in the API, and leaves Assigned leads and older databases as they were", async () => {
    await team();
    const res = await request(app())
      .get("/api/my-leads?view=pipeline")
      .set(as(ali));
    expect(res.status).toBe(200);
    expect(res.body.pipeline_counts).toEqual({
      pipeline: 4,
      personally_contacted: 2,
    });
    expect(
      Object.fromEntries(res.body.data.map((r) => [r.name, r.answered_by])),
    ).toEqual({
      "Asad Khan": "admin",
      "Chand Khan": "admin",
      "Faraz Khan": null,
      "Ghazal Khan": "unknown",
    });
    // Filters narrow the list, never the counts.
    const hot = await request(app())
      .get("/api/my-leads?view=pipeline&temperature=hot")
      .set(as(ali));
    expect([hot.body.count, hot.body.pipeline_counts.pipeline]).toEqual([1, 4]);
    const assigned = await request(app()).get("/api/my-leads").set(as(ali));
    expect(assigned.body.pipeline_counts).toBeUndefined();
    expect(assigned.body.data[0]).not.toHaveProperty("answered_by");
    // A database before 055: the pipeline shows as it did.
    await pg.exec(
      "alter function agent_pipeline_attribution(uuid,uuid[]) rename to agent_pipeline_attribution_hidden",
    );
    try {
      const before = await request(app())
        .get("/api/my-leads?view=pipeline")
        .set(as(ali));
      expect(before.status).toBe(200);
      expect(before.body.count).toBe(4);
      expect(before.body.pipeline_counts).toBeUndefined();
      expect(before.body.data[0]).not.toHaveProperty("answered_by");
    } finally {
      await pg.exec(
        "alter function agent_pipeline_attribution_hidden(uuid,uuid[]) rename to agent_pipeline_attribution",
      );
    }
  });
});

describe("the agent directory", () => {
  it("lists agents with their numbers, found by name or UID", async () => {
    await team();
    const all = await agents();
    expect(all.count).toBe(2);
    expect(
      all.data.map((a) => [a.name, a.contacted, a.hot, a.warm, a.cold]),
    ).toEqual([
      ["Ali Agent", 2, 1, 0, 0],
      ["Sara Agent", 0, 0, 0, 0],
    ]);
    // The directory and the agent's own page give the same numbers.
    expect(all.data[0]).toEqual({
      id: ali,
      uid: all.data[0].uid,
      name: "Ali Agent",
      active: true,
      ...(await pipeline(ali)).summary,
    });
    const { uid } = await one("select uid from profiles where id=$1", [sara]);
    expect(names(await agents({ search: String(uid) }))).toEqual([
      "Sara Agent",
    ]);
    expect(names(await agents({ search: String(uid).slice(0, 3) }))).toContain(
      "Sara Agent",
    );
    expect(names(await agents({ search: "sar" }))).toEqual(["Sara Agent"]);
    expect(names(await agents({ search: "50%" }))).toEqual([]);
    // Administrators, staff and deleted agents are not in it; disabled
    // agents are, after the active ones.
    await pg.query("update profiles set active=false where id=$1", [ali]);
    expect(
      (await agents()).data.map((a) => [a.name, a.active, a.contacted]),
    ).toEqual([
      ["Sara Agent", true, 0],
      ["Ali Agent", false, 2],
    ]);
    await pg.query(
      "update profiles set active=false,deletion_requested_at=now(),deleted_at=now() where id=$1",
      [sara],
    );
    expect(names(await agents())).toEqual(["Ali Agent"]);
    await expect(pipeline(sara)).rejects.toMatchObject({ code: "P0002" });
  });
  it("pages 20 agents at a time", async () => {
    for (let i = 1; i <= 21; i++) {
      const id = `55000000-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`;
      await pg.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [id, `agent${i}@gmail.com`],
      );
      await pg.query(
        "update profiles set active=true,role='agent',name=$2 where id=$1",
        [id, `Team ${String(i).padStart(2, "0")}`],
      );
    }
    const second = await agents({ page: 2 });
    expect([second.count, second.data.length]).toEqual([23, 3]);
    expect(names(second)).toEqual(["Team 19", "Team 20", "Team 21"]);
  });
});

describe("access", () => {
  it("lets only administrators in, in the database", async () => {
    await expect(agents({}, ali)).rejects.toMatchObject({ code: "42501" });
    await expect(pipeline(sara, {}, ali)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(pipeline(ali, {}, ali)).rejects.toMatchObject({
      code: "42501",
    });
    await expect(pipeline(ali, {}, staff)).rejects.toMatchObject({
      code: "42501",
    });
    await pg.query("update profiles set active=false where id=$1", [admin]);
    await expect(agents()).rejects.toMatchObject({ code: "42501" });
    await pg.query("update profiles set active=true where id=$1", [admin]);
    // Only agents have a pipeline.
    for (const id of [admin, staff, "55000000-0000-4000-8000-0000000000ff"])
      await expect(pipeline(id)).rejects.toMatchObject({ code: "P0002" });
    for (const query of [
      { view: "all" },
      { view: "earlier", temperature: "hot" },
      { view: "earlier", outcome: "Busy" },
      { temperature: "boiling" },
      { outcome: "Maybe" },
      { page: 0 },
      { agent: sara },
      { search: "x".repeat(101) },
    ])
      await expect(
        pipeline(ali, query),
        JSON.stringify(query),
      ).rejects.toMatchObject({ code: "22023" });
    await expect(agents({ sort: "name" })).rejects.toMatchObject({
      code: "22023",
    });
  });
  it("gives the API to administrators only, with numbers shown as in the leads list", async () => {
    await team();
    const list = await request(app())
      .get("/api/pipeline/agents?search=ali")
      .set(as(admin));
    expect([list.status, list.headers["cache-control"]]).toEqual([
      200,
      "no-store",
    ]);
    expect(list.body.data.map((a) => [a.name, a.contacted])).toEqual([
      ["Ali Agent", 2],
    ]);
    const page = await request(app())
      .get(`/api/pipeline/agents/${ali}?temperature=hot`)
      .set(as(admin));
    expect(page.status).toBe(200);
    expect(page.body.agent).toMatchObject({ id: ali, name: "Ali Agent" });
    expect(page.body.data.map((r) => [r.name, r.phone])).toEqual([
      ["Asad Khan", "+923006600001"],
    ]);
    // Agents, including the agent themself, and staff are refused,
    // whatever the address or filters say.
    for (const user of [ali, sara, staff])
      for (const path of [
        "/api/pipeline/agents",
        `/api/pipeline/agents/${ali}`,
        `/api/pipeline/agents/${sara}?view=earlier`,
      ])
        expect(
          (await request(app()).get(path).set(as(user))).status,
          `${user} ${path}`,
        ).toBe(403);
    expect(
      (await request(app()).get(`/api/pipeline/agents/${ali}`)).status,
    ).toBe(401);
    const missing = await request(app())
      .get(`/api/pipeline/agents/${staff}`)
      .set(as(admin));
    expect([missing.status, missing.body.error]).toEqual([
      404,
      "Choose an agent from the list",
    ]);
    for (const path of [
      "/api/pipeline/agents/not-a-uuid",
      `/api/pipeline/agents/${ali}?view=earlier&temperature=hot`,
      `/api/pipeline/agents/${ali}?status=won`,
      `/api/pipeline/agents/${ali}?search=${encodeURIComponent("a;drop")}`,
      "/api/pipeline/agents?agent=" + ali,
    ])
      expect((await request(app()).get(path).set(as(admin))).status, path).toBe(
        400,
      );
    expect(
      agentPipelineQuery.safeParse({ view: "earlier", outcome: "Busy" })
        .success,
    ).toBe(false);
  });
});
