import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { presentAuditEntry } from "../src/services/auditHistory.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 054: agents correct the names of leads assigned to them now. Requests
// go through the API to every real migration in PGlite.
const admin = "54100000-0000-4000-8000-000000000001",
  ali = "54100000-0000-4000-8000-000000000002",
  sara = "54100000-0000-4000-8000-000000000003";
let pg,
  db,
  one,
  all,
  phoneNo = 0;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
});
const app = () => createApp(trustedMfaFixture(db));
const rename = (user, lead, name) =>
  request(app())
    .put(`/api/leads/${lead}/name`)
    .set({ Authorization: "Bearer " + user })
    .send({ name });
const newLead = async (name = "Unknown", owner = ali) =>
  (
    await one("select (public.create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name, assigned_agent: owner }),
      "+9230066" + String(++phoneNo).padStart(5, "0"),
      admin,
    ])
  ).id;
const leadRow = (id) =>
  one(
    "select l.name,l.lead_no,l.assigned_agent,l.masked_phone,l.status,l.last_activity_at,(select phone from crm_private.lead_phones where lead_id=l.id) phone from leads l where id=$1",
    [id],
  );
const renames = () =>
  all(
    "select actor_id,entity,entity_id,metadata from audit_log where action='lead.renamed' order by created_at,id",
  );

describe("agents correct customer names (update 054)", () => {
  it("renames the agent's own lead and keeps everything else", async () => {
    const lead = await newLead("Unknown");
    await pg.query(
      "select crm_mutate('notes',null,jsonb_build_object('lead_id',$1::uuid,'body','Called back'),$2,'t')",
      [lead, ali],
    );
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '1 day')",
      [lead, ali],
    );
    const before = await leadRow(lead);
    const res = await rename(ali, lead, "  Muhammad   Ahmed ");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({
      id: lead,
      lead_no: before.lead_no,
      name: "Muhammad Ahmed",
      changed: true,
    });
    // Only the name changed: number, phone, agent, status and activity time
    // stay; notes and follow-ups are untouched.
    expect(await leadRow(lead)).toEqual({ ...before, name: "Muhammad Ahmed" });
    expect(
      (await one("select count(*)::int n from notes where lead_id=$1", [lead]))
        .n,
    ).toBe(1);
    expect(
      (
        await one("select count(*)::int n from followups where lead_id=$1", [
          lead,
        ])
      ).n,
    ).toBe(1);
    const [entry] = await renames();
    expect(entry).toMatchObject({
      actor_id: ali,
      entity: "leads",
      entity_id: lead,
      metadata: { before: "Unknown", after: "Muhammad Ahmed", agent_id: ali },
    });
    // Audit history shows who changed it and the name before and after.
    const shown = presentAuditEntry({
      action: "lead.renamed",
      entity: "leads",
      entity_id: lead,
      metadata: entry.metadata,
      actor: { id: ali, name: "Ali Agent" },
      lead: { number: "HD-000001" },
    });
    expect(shown).toMatchObject({
      title: "Corrected a customer's name",
      description:
        "Changed the customer name of lead HD-000001 from “Unknown” to “Muhammad Ahmed”.",
      changes: [
        { label: "Customer name", before: "Unknown", after: "Muhammad Ahmed" },
      ],
    });
  });
  it("records nothing when the name is the same", async () => {
    const lead = await newLead("Bilal Khan");
    const res = await rename(ali, lead, "Bilal Khan");
    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(await renames()).toEqual([]);
  });
  it("refuses empty, placeholder, numeric and overlong names", async () => {
    const lead = await newLead("N/A");
    for (const [name, error] of [
      ["", "Enter the customer's name"],
      ["   ", "Enter the customer's name"],
      ["unknown", "Enter the customer's real name"],
      ["N/A", "Enter the customer's real name"],
      ["03001234567", "Enter a name with letters"],
      ["Ali\u0007", "Use letters, spaces and ordinary punctuation only"],
      ["A".repeat(101), "Use a name of up to 100 characters"],
    ]) {
      const res = await rename(ali, lead, name);
      expect(res.status, name).toBe(400);
      expect(res.body.error).toBe(error);
    }
    expect(
      (
        await request(app())
          .put(`/api/leads/${lead}/name`)
          .set({ Authorization: "Bearer " + ali })
          .send({ name: "Ali", phone: "+923001234567" })
      ).status,
    ).toBe(400);
    // The database refuses the same, whoever calls it.
    for (const name of ["", "Unknown", "x".repeat(101), "Ali\u0007"])
      await expect(
        pg.query("select lead_rename($1,$2,$3,'t')", [lead, ali, name]),
      ).rejects.toMatchObject({ code: "HA400" });
    expect((await leadRow(lead)).name).toBe("N/A");
    expect(await renames()).toEqual([]);
    // Urdu names are names.
    expect((await rename(ali, lead, "محمد احمد")).body.name).toBe("محمد احمد");
  });
  it("lets only the lead's current agent, or an administrator, rename it", async () => {
    const lead = await newLead("Unknown", ali);
    // Another agent: as if the lead did not exist.
    const other = await rename(sara, lead, "Sara's guess");
    expect(other.status).toBe(404);
    expect(other.body.error).toBe("Lead not found");
    // Administrators keep their access to every lead.
    expect((await rename(admin, lead, "Imran Shah")).status).toBe(200);
    // After reassignment, the previous agent can no longer rename it.
    await pg.query("update leads set assigned_agent=$2 where id=$1", [
      lead,
      sara,
    ]);
    expect((await rename(ali, lead, "Imran Ali")).status).toBe(404);
    expect((await rename(sara, lead, "Imran Ali")).status).toBe(200);
    // A deleted lead, a disabled account and a staff account are refused.
    const removed = await newLead("Unknown", ali);
    await pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [removed],
      admin,
    ]);
    expect((await rename(ali, removed, "Zain")).status).toBe(404);
    await expect(
      pg.query("select lead_rename($1,$2,'Zain','t')", [removed, admin]),
    ).rejects.toMatchObject({ code: "HA404" });
    const mine = await newLead("Unknown", ali);
    await pg.query("update profiles set active=false where id=$1", [ali]);
    await expect(
      pg.query("select lead_rename($1,$2,'Zain','t')", [mine, ali]),
    ).rejects.toMatchObject({ code: "HA403" });
    const staff = "54100000-0000-4000-8000-000000000004";
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'staff@gmail.com',now())",
      [staff],
    );
    await pg.query("update profiles set active=true,role='staff' where id=$1", [
      staff,
    ]);
    expect((await rename(staff, mine, "Zain")).status).toBe(403);
    expect(
      (await renames()).map((r) => [r.actor_id, r.metadata.after]),
    ).toEqual([
      [admin, "Imran Shah"],
      [sara, "Imran Ali"],
    ]);
  });
  it("is callable by the server only", async () => {
    expect(
      await one(
        "select has_function_privilege('anon',f,'execute') anon,has_function_privilege('authenticated',f,'execute') authenticated,has_function_privilege('service_role',f,'execute') server from (select 'public.lead_rename(uuid,uuid,text,text)'::regprocedure f) x",
      ),
    ).toEqual({ anon: false, authenticated: false, server: true });
  });
});
