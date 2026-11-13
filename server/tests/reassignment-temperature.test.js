import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 066: a lead's Hot, Warm or Cold starts again when an administrator
// gives it to a different agent, wherever it is read: the receiving agent's
// lists (update 061), All leads' temperature filter and administrators'
// report drill-downs. Nothing is deleted: the earlier agent's call keeps its
// tag in the history. Everything runs through the CRM's API on the real
// database schema (every migration up to the latest).
const admin = "66000000-0000-4000-8000-000000000001",
  ali = "66000000-0000-4000-8000-000000000002",
  sara = "66000000-0000-4000-8000-000000000003";
let pg, db, one, all, server;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
  server = createApp(trustedMfaFixture(db));
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
});
const as = (user) => ({ Authorization: "Bearer " + user });
let phone = 0;
async function newLead(name, owner = ali) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name, assigned_agent: owner }),
      "+92300066" + String(++phone).padStart(4, "0"),
      admin,
    ])
  ).id;
}
// An answered call with the classification, as the call form saves it.
async function classify(lead, agent, tag, minutesAgo = 10) {
  await request(server)
    .post(`/api/leads/${lead}/calls/manual`)
    .set(as(agent))
    .send({
      answered: true,
      started_at: new Date(Date.now() - minutesAgo * 60000).toISOString(),
      duration_seconds: 60,
      outcome: "Interested",
      notes: "",
      deal_tags: tag ? [tag] : [],
    })
    .expect(201);
}
const word = { "Hot lead": "hot", "Warm lead": "warm", "Cold lead": "cold" };
// The classification each view gives the lead.
const agentSees = async (agent, name) => {
  const row = (
    await request(server)
      .get("/api/my-leads?" + new URLSearchParams({ search: name }))
      .set(as(agent))
      .expect(200)
  ).body.data.find((r) => r.name === name);
  return row ? row.temperature || "none" : "not theirs";
};
const allLeadsCount = async (name, temperature) =>
  (
    await request(server)
      .get(
        "/api/leads/all?" + new URLSearchParams({ search: name, temperature }),
      )
      .set(as(admin))
      .expect(200)
  ).body.count;
const allLeadsSees = async (name) => {
  for (const t of ["hot", "warm", "cold", "none"])
    if ((await allLeadsCount(name, t)) === 1) return t;
  return "missing";
};
const drillDownSees = async (name) => {
  const row = (
    await request(server)
      .get(
        "/api/reports/drilldown?" +
          new URLSearchParams({
            report: "summary",
            metric: "total_leads",
            from: new Date(Date.now() - 86400000).toISOString(),
            to: new Date(Date.now() + 86400000).toISOString(),
            search: name,
          }),
      )
      .set(as(admin))
      .expect(200)
  ).body.data.find((r) => r.lead.name === name);
  return word[row?.temperature] || "none";
};
const everywhere = async (agent, name) => ({
  agent: await agentSees(agent, name),
  allLeads: await allLeadsSees(name),
  drillDown: await drillDownSees(name),
});
// The ways an administrator moves leads to another agent.
const reassign = {
  single: (lead, agent) =>
    request(server)
      .post(`/api/leads/${lead}/assign`)
      .set(as(admin))
      .send({ agent_id: agent }),
  selected: (lead, agent) =>
    request(server)
      .post("/api/leads/assign-selected")
      .set(as(admin))
      .send({ lead_ids: [lead], agent_id: agent }),
  bulk: (lead, agent) =>
    request(server)
      .post("/api/leads/assign-bulk")
      .set(as(admin))
      .send({ lead_ids: [lead], mode: "agent", agent_id: agent }),
  distribute: async (lead, agent) => {
    const preview = (
      await request(server)
        .post("/api/leads/distribute/preview")
        .set(as(admin))
        .send({ lead_ids: [lead], agent_ids: [agent] })
        .expect(200)
    ).body;
    return request(server)
      .post("/api/leads/distribute")
      .set(as(admin))
      .send({ lead_ids: [lead], agent_ids: [agent], token: preview.token });
  },
};

describe("reassigning a classified lead (update 066)", () => {
  it.each(["Hot lead", "Warm lead", "Cold lead"])(
    "%s given to another agent: the new agent, All leads and report drill-downs show no classification; the call keeps its tag",
    async (tag) => {
      const name = `Buyer ${tag}`;
      const lead = await newLead(name);
      await classify(lead, ali, tag);
      expect(await everywhere(ali, name)).toEqual({
        agent: word[tag],
        allLeads: word[tag],
        drillDown: word[tag],
      });
      await reassign.single(lead, sara).expect(200);
      expect(await everywhere(sara, name)).toEqual({
        agent: "none",
        allLeads: "none",
        drillDown: "none",
      });
      expect(await agentSees(ali, name)).toBe("not theirs");
      // The history keeps it: the earlier agent's call and its tag.
      expect(
        (
          await one(
            "select count(*)::int n from calls where lead_id=$1 and $2=any(deal_tags)",
            [lead, tag],
          )
        ).n,
      ).toBe(1);
    },
  );
  it("an unclassified lead stays unclassified", async () => {
    const lead = await newLead("Buyer plain");
    await classify(lead, ali, null);
    await reassign.single(lead, sara).expect(200);
    expect(await everywhere(sara, "Buyer plain")).toEqual({
      agent: "none",
      allLeads: "none",
      drillDown: "none",
    });
  });
  it("given again to the agent who has it: the classification stays", async () => {
    const lead = await newLead("Buyer same");
    await classify(lead, ali, "Hot lead");
    const before = await one("select assigned_at from leads where id=$1", [
      lead,
    ]);
    for (const path of ["single", "selected", "bulk"])
      await reassign[path](lead, ali).expect(200);
    expect(
      await one("select assigned_at from leads where id=$1", [lead]),
    ).toEqual(before);
    expect(await everywhere(ali, "Buyer same")).toEqual({
      agent: "hot",
      allLeads: "hot",
      drillDown: "hot",
    });
  });
  it("an administrator's edit and the agent's note leave the classification", async () => {
    const lead = await newLead("Buyer edited");
    await classify(lead, ali, "Warm lead");
    await request(server)
      .patch(`/api/leads/${lead}`)
      .set(as(admin))
      .send({ preferred_location: "DHA Phase 9" })
      .expect(200);
    await request(server)
      .post("/api/notes")
      .set(as(ali))
      .send({ lead_id: lead, body: "Wants a corner plot" })
      .expect(201);
    expect(await everywhere(ali, "Buyer edited")).toEqual({
      agent: "warm",
      allLeads: "warm",
      drillDown: "warm",
    });
  });
  it("the new agent classifies the lead afresh, as before", async () => {
    const lead = await newLead("Buyer fresh");
    await classify(lead, ali, "Hot lead", 30);
    await reassign.single(lead, sara).expect(200);
    await classify(lead, sara, "Cold lead", 1);
    expect(await everywhere(sara, "Buyer fresh")).toEqual({
      agent: "cold",
      allLeads: "cold",
      drillDown: "cold",
    });
    expect(await allLeadsCount("Buyer fresh", "hot")).toBe(0);
    // Administrators' view of the new agent's pipeline agrees.
    const pipeline = (
      await request(server)
        .get(`/api/pipeline/agents/${sara}`)
        .set(as(admin))
        .expect(200)
    ).body.data.find((r) => r.name === "Buyer fresh");
    expect(pipeline.temperature).toBe("cold");
    // Back to the first agent: a different agent again, a fresh start.
    await reassign.single(lead, ali).expect(200);
    expect(await everywhere(ali, "Buyer fresh")).toEqual({
      agent: "none",
      allLeads: "none",
      drillDown: "none",
    });
  });
  it("keeps the lead's details, notes, calls, follow-ups, history and audit entries", async () => {
    const lead = await newLead("Buyer kept");
    await classify(lead, ali, "Hot lead");
    await request(server)
      .post("/api/notes")
      .set(as(ali))
      .send({ lead_id: lead, body: "Prefers evenings" })
      .expect(201);
    const due = new Date(Date.now() + 3 * 86400000).toISOString();
    await request(server)
      .post("/api/followups")
      .set(as(ali))
      .send({ lead_id: lead, due_at: due, notes: "Send the brochure" })
      .expect(201);
    const kept = () =>
      one(
        `select (select jsonb_build_object('name',l.name,'email',l.email,'status',l.status,'source',l.source,
           'preferred_location',l.preferred_location,'lead_no',l.lead_no,'created_at',l.created_at,
           'phone',(select phone from crm_private.lead_phones where lead_id=l.id)) from leads l where l.id=$1) lead,
         (select md5(string_agg(c::text,'|' order by c.id)) from calls c where c.lead_id=$1) calls,
         (select md5(string_agg(n::text,'|' order by n.id)) from notes n where n.lead_id=$1) notes,
         (select jsonb_agg(jsonb_build_object('due_at',f.due_at,'notes',f.notes,'status',f.status)) from followups f where f.lead_id=$1) followups,
         (select md5(string_agg(h::text,'|' order by h.id)) from lead_status_history h where h.lead_id=$1) statuses,
         (select md5(string_agg(a::text,'|' order by a.id)) from assignments a where a.lead_id=$1) assignments,
         (select md5(string_agg(a::text,'|' order by a.id)) from audit_log a) audit`,
        [lead],
      );
    const before = await kept();
    const audits = (await one("select max(id) m from audit_log")).m;
    await reassign.single(lead, sara).expect(200);
    const after = await kept();
    expect(after.lead).toEqual(before.lead);
    expect(after.calls).toBe(before.calls);
    expect(after.notes).toBe(before.notes);
    expect(after.followups).toEqual(before.followups);
    expect(after.statuses).toBe(before.statuses);
    // History grows; nothing in it changes.
    expect(
      (
        await one(
          "select md5(string_agg(a::text,'|' order by a.id)) h from audit_log a where id<=$1",
          [audits],
        )
      ).h,
    ).toBe(before.audit);
    expect(
      (
        await one("select count(*)::int n from assignments where lead_id=$1", [
          lead,
        ])
      ).n,
    ).toBe(2);
  });
  it.each(["single", "selected", "bulk", "distribute"])(
    "%s reassignment clears it the same way",
    async (path) => {
      const name = `Buyer via ${path}`;
      const lead = await newLead(name);
      await classify(lead, ali, "Hot lead");
      expect((await reassign[path](lead, sara)).status).toBe(200);
      expect(await everywhere(sara, name)).toEqual({
        agent: "none",
        allLeads: "none",
        drillDown: "none",
      });
    },
  );
  it("agents cannot reassign a lead or clear its classification", async () => {
    const lead = await newLead("Buyer guarded");
    await classify(lead, ali, "Hot lead");
    for (const user of [ali, sara]) {
      await request(server)
        .post(`/api/leads/${lead}/assign`)
        .set(as(user))
        .send({ agent_id: sara })
        .expect(403);
      await request(server)
        .post("/api/leads/assign-selected")
        .set(as(user))
        .send({ lead_ids: [lead], agent_id: sara })
        .expect(403);
      await request(server)
        .post("/api/leads/assign-bulk")
        .set(as(user))
        .send({ lead_ids: [lead], mode: "agent", agent_id: sara })
        .expect(403);
      await request(server)
        .post("/api/leads/distribute/preview")
        .set(as(user))
        .send({ lead_ids: [lead], agent_ids: [sara] })
        .expect(403);
    }
    // Nor can the database functions be reached from a browser session.
    for (const fn of ["assign_lead", "admin_assign_leads", "admin_lead_list"])
      expect(
        (
          await one(
            "select bool_or(has_function_privilege('authenticated',p.oid,'execute')) b from pg_proc p where p.proname=$1",
            [fn],
          )
        ).b,
      ).toBe(false);
    expect(
      (await one("select assigned_agent from leads where id=$1", [lead]))
        .assigned_agent,
    ).toBe(ali);
    expect(await everywhere(ali, "Buyer guarded")).toEqual({
      agent: "hot",
      allLeads: "hot",
      drillDown: "hot",
    });
  });
});
