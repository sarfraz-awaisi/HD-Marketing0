import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { presentAuditEntry } from "../src/services/auditHistory.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 069: Delete instantly. An administrator erases leads already in
// Deleted leads, or a deleted file's leads, at once: every record of the
// lead goes, as the daily job erases it, and its recordings and KYC files
// are removed from Storage. A lead outside Deleted leads, or with a won
// deal, stays. Deleted leads can be restored for 14 days instead of 30.
const admin = "69000000-0000-4000-8000-000000000001",
  ali = "69000000-0000-4000-8000-000000000002",
  sara = "69000000-0000-4000-8000-000000000003";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
let removed, property;
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  removed = [];
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Park View','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
});
// Storage, and the KYC file queue as the Supabase client reads it.
const kycQueue = () => {
  const q = {
    select: () => q,
    lte: () => q,
    order: () => q,
    limit: () => q,
    then: (resolve, reject) =>
      all(
        "select id,storage_path from public.knowledge_file_cleanup where not_before<=now() order by created_at limit 100",
      )
        .then((data) => ({ data, error: null }))
        .then(resolve, reject),
    delete: () => ({
      in: async (_, ids) => {
        await pg.query(
          "delete from public.knowledge_file_cleanup where id=any($1::uuid[])",
          [ids],
        );
        return { error: null };
      },
    }),
  };
  return q;
};
const app = () =>
  createApp(
    trustedMfaFixture({
      ...db,
      // As the Supabase client: no arguments, or a result of nothing.
      rpc: async (name, args) =>
        name === "lead_recording_cleanup_done"
          ? (await pg.query("select public.lead_recording_cleanup_done($1)", [
              args.p_id,
            ]),
            { data: null, error: null })
          : db.rpc(name, args ?? {}),
      from: (table) =>
        table === "knowledge_file_cleanup" ? kycQueue() : db.from(table),
      storage: {
        from: (bucket) => ({
          remove: async (paths) => {
            removed.push(...paths.map((p) => `${bucket}/${p}`));
            return { error: null };
          },
        }),
      },
    }),
  );
const as = (user) => ({ Authorization: "Bearer " + user });
let next = 1;
// A lead Ali worked: calls (one recorded), a note, follow-ups with a
// reminder, a visit, a deal, a revealed number, a KYC document with its
// file, a Google Sheet inquiry and notifications.
async function workedLead(name = "Worked buyer") {
  const n = next++;
  const lead = (
    await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
      JSON.stringify({ name, assigned_agent: ali }),
      "+92300069" + String(n).padStart(4, "0"),
      admin,
    ])
  ).id;
  const call = (
    await one("select (log_manual_call($1,$2,$3::jsonb,'t'))->>'id' id", [
      lead,
      ali,
      JSON.stringify({
        answered: true,
        started_at: new Date(Date.now() - 600000).toISOString(),
        duration_seconds: 90,
        outcome: "Interested",
        notes: "Wants a corner plot",
        deal_tags: ["Hot lead"],
      }),
    ])
  ).id;
  await pg.query(
    "insert into crm_private.recordings(call_id,storage_path) values($1,$2)",
    [call, `calls/${lead}.mp3`],
  );
  await pg.query(
    "insert into notes(lead_id,agent_id,body) values($1,$2,'Call after Friday')",
    [lead, ali],
  );
  const followup = (
    await one(
      "insert into followups(lead_id,agent_id,due_at) values($1,$2,now()+interval '1 day') returning id",
      [lead, ali],
    )
  ).id;
  await pg.query(
    "insert into reminders(agent_id,followup_id,due_at) values($1,$2,now()+interval '20 hours')",
    [ali, followup],
  );
  await pg.query(
    "insert into visits(lead_id,property_id,agent_id,scheduled_at) values($1,$2,$3,now()+interval '2 days')",
    [lead, property, ali],
  );
  await pg.query(
    "insert into deals(lead_id,property_id,agent_id,stage,expected_value) values($1,$2,$3,'negotiation',2500000)",
    [lead, property, ali],
  );
  await pg.query(
    "insert into crm_private.phone_reveals(user_id,lead_id) values($1,$2)",
    [ali, lead],
  );
  const doc = (
    await one(
      "insert into knowledge_documents(title,category,content,created_by,updated_by,lead_id) values('CNIC','client_kyc','Identity card',$1,$1,$2) returning id",
      [admin, lead],
    )
  ).id;
  await pg.query(
    "insert into knowledge_files(document_id,file_name,mime_type,size_bytes,storage_path,created_by) values($1,'cnic.pdf','application/pdf',10,$2,$3)",
    [doc, `kyc/${lead}.pdf`, admin],
  );
  return lead;
}
// Every record anywhere that names the lead.
const traces = async (lead) =>
  Object.fromEntries(
    (
      await all(
        "select c.table_schema||'.'||c.table_name t from information_schema.columns c join information_schema.tables x on x.table_schema=c.table_schema and x.table_name=c.table_name and x.table_type='BASE TABLE' where c.column_name='lead_id' and c.table_schema in ('public','crm_private') order by 1",
      )
    ).map(({ t }) => [t, 0]),
  );
const left = async (lead) => {
  const counts = {};
  for (const t of Object.keys(await traces(lead)))
    counts[t] = (
      await one(`select count(*)::int n from ${t} where lead_id=$1`, [lead])
    ).n;
  counts["public.leads"] = (
    await one("select count(*)::int n from leads where id=$1", [lead])
  ).n;
  counts["crm_private.recordings"] = (
    await one(
      "select count(*)::int n from crm_private.recordings where storage_path=$1",
      [`calls/${lead}.mp3`],
    )
  ).n;
  return Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
};
const moveToBin = (server, ids) =>
  request(server)
    .post("/api/leads/delete")
    .set(as(admin))
    .send({ lead_ids: ids, reason: "Junk inquiries" })
    .expect(200);

describe("Delete instantly", () => {
  it("erases a lead in Deleted leads with every record, files included, and records it", async () => {
    const server = app();
    const lead = await workedLead();
    const number = (await one("select lead_no from leads where id=$1", [lead]))
      .lead_no;
    expect(Object.keys(await left(lead)).length).toBeGreaterThan(10);
    await moveToBin(server, [lead]);
    const result = (
      await request(server)
        .post("/api/leads/erase")
        .set(as(admin))
        .send({ lead_ids: [lead] })
        .expect(200)
    ).body;
    expect(result).toMatchObject({
      erased: 1,
      failed: 0,
      files_removed: true,
      results: [{ id: lead, result: "erased" }],
    });
    expect(await left(lead)).toEqual({});
    // The recording and the KYC file are removed from Storage now.
    expect(removed.sort()).toEqual([
      `knowledge-files/kyc/${lead}.pdf`,
      `recordings/calls/${lead}.mp3`,
    ]);
    expect(
      await one(
        "select (select count(*)::int from crm_private.lead_recording_cleanup) r,(select count(*)::int from knowledge_file_cleanup) k",
      ),
    ).toEqual({ r: 0, k: 0 });
    // One entry: who, how many, HD numbers only.
    const entry = await one(
      "select actor_id,entity,entity_id,metadata from audit_log where action='lead.erased'",
    );
    expect(entry).toEqual({
      actor_id: admin,
      entity: "leads",
      entity_id: null,
      metadata: { erased: 1, failed: 0, lead_nos: [Number(number)] },
    });
    const no = `HD-${String(number).padStart(6, "0")}`;
    expect(
      presentAuditEntry({
        id: 1,
        created_at: "2026-11-17T10:00:00Z",
        action: "lead.erased",
        entity: "leads",
        entity_id: null,
        actor_id: admin,
        request_id: "r",
        metadata: entry.metadata,
        actor: {
          id: admin,
          name: "Owner",
          role: "admin",
          uid: 1,
          active: true,
        },
      }),
    ).toMatchObject({
      title: "Permanently deleted leads",
      description: `Permanently deleted 1 lead from Deleted leads, with all their records: ${no}. They cannot be restored.`,
    });
    // Gone from Deleted leads; nothing to restore.
    expect(
      (
        await request(server)
          .get("/api/leads/deleted")
          .set(as(admin))
          .expect(200)
      ).body.count,
    ).toBe(0);
    expect(
      (
        await request(server)
          .post("/api/leads/restore")
          .set(as(admin))
          .send({ lead_ids: [lead] })
          .expect(200)
      ).body.failed,
    ).toBe(1);
  });
  it("erases only leads in Deleted leads, never one with a won deal, and only for administrators", async () => {
    const server = app();
    const [active, binned, won] = [
      await workedLead("Still active"),
      await workedLead("In the bin"),
      await workedLead("Won it"),
    ];
    await moveToBin(server, [binned]);
    // A won deal on a lead already in Deleted leads (a later correction).
    await pg.query(
      "update leads set deleted_at=now(),deleted_by=$2,delete_reason='Old',deleted_batch=gen_random_uuid(),assigned_agent=null where id=$1",
      [won, admin],
    );
    await pg.query(
      "update deals set stage='won',close_date=current_date where lead_id=$1",
      [won],
    );
    for (const user of [ali, sara])
      await request(server)
        .post("/api/leads/erase")
        .set(as(user))
        .send({ lead_ids: [binned] })
        .expect(403);
    await request(server)
      .post("/api/leads/erase")
      .set(as(admin))
      .send({ lead_ids: [] })
      .expect(400);
    const result = (
      await request(server)
        .post("/api/leads/erase")
        .set(as(admin))
        .send({ lead_ids: [active, binned, won] })
        .expect(200)
    ).body;
    expect(result.erased).toBe(1);
    expect(result.failed).toBe(2);
    expect(
      Object.fromEntries(
        result.results.map((r) => [r.id, r.reason ?? r.result]),
      ),
    ).toEqual({
      [active]: "Not in Deleted leads",
      [binned]: "erased",
      [won]: "Has a won deal",
    });
    expect(await left(binned)).toEqual({});
    expect((await left(active))["public.leads"]).toBe(1);
    expect((await left(won))["public.deals"]).toBe(1);
  });
  it("erases a deleted file's leads; the file is no longer listed or restorable", async () => {
    const server = app();
    const file = (
      await one(
        "select (import_leads('October buyers.csv','csv',null,$1::jsonb,$2,'t'))->>'import_id' id",
        [
          JSON.stringify(
            [1, 2].map((n) => ({
              row: n + 1,
              data: { name: `File buyer ${n}`, source: "CSV", budget_min: 0 },
              phone: "+9230106900" + n,
            })),
          ),
          admin,
        ],
      )
    ).id;
    const ids = (
      await all("select id from leads where import_id=$1 order by id", [file])
    ).map((r) => r.id);
    // One lead was deleted on its own earlier: it stays in Deleted leads.
    const [alone] = ids;
    await moveToBin(server, [alone]);
    await request(server)
      .delete("/api/lead-imports/" + file)
      .set(as(admin))
      .send({ mode: "file_and_leads", reason: "Wrong list" })
      .expect(200);
    expect(
      (
        await request(server)
          .get("/api/deleted-lead-imports")
          .set(as(admin))
          .expect(200)
      ).body.map((f) => f.id),
    ).toEqual([file]);
    const result = (
      await request(server)
        .post(`/api/lead-imports/${file}/erase`)
        .set(as(admin))
        .send({})
        .expect(200)
    ).body;
    expect(result).toMatchObject({ erased: 1, failed: 0 });
    expect(await left(ids[1])).toEqual({});
    expect((await left(alone))["public.leads"]).toBe(1);
    expect(
      (
        await request(server)
          .get("/api/deleted-lead-imports")
          .set(as(admin))
          .expect(200)
      ).body,
    ).toEqual([]);
    await request(server)
      .post(`/api/lead-imports/${file}/restore`)
      .set(as(admin))
      .send({})
      .expect(404);
    expect(
      (
        await request(server)
          .post(`/api/lead-imports/${file}/erase`)
          .set(as(admin))
          .send({})
          .expect(404)
      ).body.error,
    ).toBe("File not found in Deleted leads");
    expect(
      await one(
        "select erased_by,erased_at is not null erased from lead_imports where id=$1",
        [file],
      ),
    ).toEqual({ erased_by: admin, erased: true });
    expect(
      (
        await one(
          "select metadata from audit_log where action='lead.file_erased' and entity_id=$1",
          [file],
        )
      ).metadata,
    ).toMatchObject({ erased: 1, failed: 0 });
  });
  it("keeps a Google Sheet row's receipt, so the next sync does not bring the lead back", async () => {
    const server = app();
    const lead = await workedLead("Sheet buyer");
    const source = (
      await one(
        "insert into sheet_sources(name,spreadsheet_id,worksheet,created_by) values('Ads','1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_69','Sheet1',$1) returning id",
        [admin],
      )
    ).id;
    await pg.query(
      "insert into crm_private.sheet_lead_receipts(source_id,meta_lead_id,outcome,lead_id,sheet_row) values($1,'6901','created',$2,2)",
      [source, lead],
    );
    await pg.query(
      "insert into crm_private.sheet_lead_inquiries(source_id,meta_lead_id,lead_id,ad_name) values($1,'6901',$2,'DHA plots')",
      [source, lead],
    );
    await moveToBin(server, [lead]);
    await request(server)
      .post("/api/leads/erase")
      .set(as(admin))
      .send({ lead_ids: [lead] })
      .expect(200);
    expect(await left(lead)).toEqual({});
    expect(
      await one(
        "select lead_id,outcome from crm_private.sheet_lead_receipts where source_id=$1",
        [source],
      ),
    ).toEqual({ lead_id: null, outcome: "created" });
  });
  it("raises one critical alert when more than 50 leads are erased in a day", async () => {
    const server = app();
    const ids = (
      await all(
        "insert into leads(name,masked_phone,deleted_at,deleted_by,delete_reason,deleted_batch) select 'Bulk '||i,'+92******000',now(),$1,'Junk',gen_random_uuid() from generate_series(1,51) i returning id",
        [admin],
      )
    ).map((r) => r.id);
    await pg.query("delete from security_alerts");
    await request(server)
      .post("/api/leads/erase")
      .set(as(admin))
      .send({ lead_ids: ids.slice(0, 50) })
      .expect(200);
    expect((await one("select count(*)::int n from security_alerts")).n).toBe(
      0,
    );
    for (const batch of [ids.slice(50), []])
      if (batch.length)
        await request(server)
          .post("/api/leads/erase")
          .set(as(admin))
          .send({ lead_ids: batch })
          .expect(200);
    expect(
      await all("select type,severity,user_id,metadata from security_alerts"),
    ).toEqual([
      {
        type: "mass_lead_erasure",
        severity: "critical",
        user_id: admin,
        metadata: { count: 51 },
      },
    ]);
  });
});

describe("14 days to restore", () => {
  it("restores within 14 days, not after, and the daily job erases after 14", async () => {
    const server = app();
    const [fresh, recent, old] = [
      await workedLead("Fresh"),
      await workedLead("Recent"),
      await workedLead("Old"),
    ];
    await moveToBin(server, [fresh, recent, old]);
    await pg.query(
      "update leads set deleted_at=now()-interval '13 days' where id=$1",
      [recent],
    );
    await pg.query(
      "update leads set deleted_at=now()-interval '15 days' where id=$1",
      [old],
    );
    const bin = (
      await request(server).get("/api/leads/deleted").set(as(admin)).expect(200)
    ).body.data;
    expect(Object.fromEntries(bin.map((r) => [r.name, r.days_left]))).toEqual({
      Fresh: 14,
      Recent: 1,
      Old: 0,
    });
    const restored = (
      await request(server)
        .post("/api/leads/restore")
        .set(as(admin))
        .send({ lead_ids: [recent, old] })
        .expect(200)
    ).body;
    expect(
      Object.fromEntries(restored.results.map((r) => [r.id, r.result])),
    ).toEqual({ [recent]: "restored", [old]: "failed" });
    await pg.query("delete from crm_private.lead_purge_runs");
    expect((await one("select purge_deleted_leads() r")).r).toEqual({
      purged: 1,
    });
    expect(await left(old)).toEqual({});
    expect((await left(fresh))["public.leads"]).toBe(1);
    await expect(pg.query("select purge_deleted_leads(13)")).rejects.toThrow(
      "Retention must be 14–3650 days",
    );
  });
});
