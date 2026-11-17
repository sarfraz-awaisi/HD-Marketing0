import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 071: Select all and Delete instantly for many deleted leads.
// "Select all matching" lists exactly the leads the Deleted leads pages
// list; the review says what would go and what is kept, fresh; erasing goes
// 250 at a time, each lead checked again, with the more-than-50 alert, the
// audit without customer details, and Storage cleanup that is retried.
// Synthetic leads only, against every migration.
const admin = "71300000-0000-4000-8000-000000000001",
  ali = "71300000-0000-4000-8000-000000000002",
  sara = "71300000-0000-4000-8000-000000000003";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
let property, removed, storageFails, eraseFails, failAfter;
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  await pg.exec(
    "delete from crm_private.lead_recording_cleanup;delete from public.knowledge_file_cleanup;delete from public.leads;",
  );
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Park View','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
  removed = [];
  storageFails = false;
  eraseFails = false;
  // Storage fails after this many more removals (Infinity: never).
  failAfter = Infinity;
});
// The KYC file queue, as the Supabase client reads and clears it.
const kycQueue = () => {
  let limit = 100;
  const q = {
    select: () => q,
    lte: () => q,
    order: () => q,
    limit: (n) => ((limit = n), q),
    then: (resolve, reject) =>
      all(
        `select id,storage_path from public.knowledge_file_cleanup where not_before<=now() order by created_at limit ${Number(limit)}`,
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
      rpc: async (name, args) => {
        if (name === "erase_deleted_leads" && eraseFails)
          return {
            data: null,
            error: { code: "57014", message: "canceling statement" },
          };
        if (name === "lead_recording_cleanup_done") {
          await pg.query("select public.lead_recording_cleanup_done($1)", [
            args.p_id,
          ]);
          return { data: null, error: null };
        }
        return db.rpc(name, args ?? {});
      },
      from: (table) =>
        table === "knowledge_file_cleanup" ? kycQueue() : db.from(table),
      storage: {
        from: (bucket) => ({
          remove: async (paths) => {
            if (storageFails || failAfter <= 0)
              return { error: { message: "Storage is unavailable" } };
            failAfter -= 1;
            removed.push(...paths.map((p) => `${bucket}/${p}`));
            return { error: null };
          },
        }),
      },
    }),
  );
const as = (user) => ({ Authorization: "Bearer " + user });
// n synthetic leads straight into Deleted leads, named from start.
async function deletedLeads(n, start = 1, name = "Bin buyer") {
  return (
    await all(
      "insert into leads(name,masked_phone,deleted_at,deleted_by,delete_reason,deleted_batch) select $1||' '||i,'+92300*****'||lpad(i::text,2,'0'),now()-make_interval(secs=>i),$2,'Junk inquiries',gen_random_uuid() from generate_series($3::int,$3::int+$4::int-1) i returning id",
      [name, admin, start, n],
    )
  ).map((r) => r.id);
}
const page = (server, search, n = 1, limit = 100) =>
  request(server)
    .get("/api/leads/deleted")
    .query({ page: n, limit, search })
    .set(as(admin))
    .expect(200)
    .then((r) => r.body);
const selection = (server, search = "") =>
  request(server)
    .get("/api/leads/deleted/selection")
    .query({ search })
    .set(as(admin))
    .expect(200)
    .then((r) => r.body);
const preview = (server, ids, user = admin, status = 200) =>
  request(server)
    .post("/api/leads/erase/preview")
    .set(as(user))
    .send({ lead_ids: ids })
    .expect(status)
    .then((r) => r.body);
const erase = (server, ids) =>
  request(server)
    .post("/api/leads/erase")
    .set(as(admin))
    .send({ lead_ids: ids });
const count = async (sql, args) => (await one(sql, args)).n;

describe("Select all matching deleted leads (update 071)", () => {
  it("selects exactly what the pages list, across pages, for each search", async () => {
    const server = app();
    await deletedLeads(130, 1, "Bin buyer");
    await deletedLeads(15, 501, "Corner plot");
    // Not in Deleted leads: never selected.
    await pg.query(
      "insert into leads(name,masked_phone) values('Active buyer','+92300*****99')",
    );
    for (const search of ["", "corner", "HD-0005", "12", "nobody"]) {
      const listed = [];
      const first = await page(server, search);
      for (let n = 1; n <= Math.ceil(first.count / 100); n++)
        listed.push(...(await page(server, search, n)).data.map((r) => r.id));
      const matching = await selection(server, search);
      expect([search, matching.count, matching.ids]).toEqual([
        search,
        first.count,
        listed,
      ]);
    }
    expect((await selection(server)).count).toBe(145);
  });

  it("stops at 2,000 and says how many match", async () => {
    await deletedLeads(2001);
    const matching = await selection(app());
    expect(matching).toMatchObject({ count: 2001, limit: 2000 });
    expect(matching.ids).toHaveLength(2000);
  }, 60000);

  it("is for administrators only, with checked filters", async () => {
    const server = app();
    await request(server)
      .get("/api/leads/deleted/selection")
      .set(as(ali))
      .expect(403);
    await request(server)
      .get("/api/leads/deleted/selection")
      .query({ search: "x".repeat(101) })
      .set(as(admin))
      .expect(400);
    await request(server)
      .get("/api/leads/deleted/selection")
      .query({ page: 2 })
      .set(as(admin))
      .expect(400);
    await expect(
      one("select deleted_lead_ids($1,'') r", [ali]),
    ).rejects.toThrow();
  });
});

describe("Delete instantly, reviewed and in batches (update 071)", () => {
  it("reviews what would go: leads that can be erased, those kept and why, their records and Sheet rows", async () => {
    const server = app();
    const [plain, won, sheet] = await deletedLeads(3);
    const call = (
      await one(
        "insert into calls(lead_id,agent_id,method,status,started_at,outcome) values($1,$2,'mock','completed',now(),'Interested') returning id",
        [plain, ali],
      )
    ).id;
    await pg.query(
      "insert into crm_private.recordings(call_id,storage_path) values($1,'calls/plain.mp3')",
      [call],
    );
    await pg.query(
      "insert into notes(lead_id,agent_id,body) values($1,$2,'Note')",
      [plain, ali],
    );
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,now(),'cancelled')",
      [plain, ali],
    );
    await pg.query(
      "insert into visits(lead_id,property_id,agent_id,scheduled_at,status) values($1,$2,$3,now(),'cancelled')",
      [plain, property, ali],
    );
    await pg.query(
      "insert into deals(lead_id,property_id,agent_id,stage,expected_value) values($1,$2,$3,'negotiation',100)",
      [plain, property, ali],
    );
    await pg.query(
      "insert into knowledge_documents(title,category,content,created_by,updated_by,lead_id) values('CNIC','client_kyc','Card',$1,$1,$2)",
      [admin, plain],
    );
    await pg.query(
      "insert into deals(lead_id,property_id,agent_id,stage,expected_value,close_date) values($1,$2,$3,'won',100,current_date)",
      [won, property, ali],
    );
    const source = (
      await one(
        "insert into sheet_sources(name,spreadsheet_id,worksheet,created_by) values('Ads','1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_71','Sheet1',$1) returning id",
        [admin],
      )
    ).id;
    await pg.query(
      "insert into crm_private.sheet_lead_receipts(source_id,meta_lead_id,outcome,lead_id,sheet_row) values($1,'7101','created',$2,2)",
      [source, sheet],
    );
    const active = (
      await one(
        "insert into leads(name,masked_phone) values('Active','+92300*****98') returning id",
      )
    ).id;
    const gone = "71399999-0000-4000-8000-000000000999";
    const review = await preview(server, [plain, won, sheet, active, gone]);
    expect(review).toMatchObject({
      selected: 5,
      eligible: 2,
      won_deal: 1,
      not_in_bin: 1,
      missing: 1,
      records: {
        calls: 1,
        recordings: 1,
        notes: 1,
        followups: 1,
        visits: 1,
        deals: 1,
        documents: 1,
      },
      sheet_leads: 1,
      erased_today: 0,
      alert_over: 50,
    });
    expect([...review.eligible_ids].sort()).toEqual([plain, sheet].sort());
    // Reviewing changes nothing.
    expect(
      await count(
        "select count(*)::int n from leads where deleted_at is not null",
      ),
    ).toBe(3);
  });

  it("is for administrators only, for 1 to 2,000 distinct leads", async () => {
    const server = app();
    const [lead] = await deletedLeads(1);
    await preview(server, [lead], ali, 403);
    await preview(server, [], admin, 400);
    await preview(server, [lead, lead], admin, 400);
    const many = Array.from(
      { length: 2001 },
      (_, i) => `71300000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    await preview(server, many, admin, 400);
    await expect(
      one("select erase_deleted_leads_preview($1,$2) r", [ali, [lead]]),
    ).rejects.toThrow();
  });

  it("erases 600 leads 250 at a time, with one alert and an audit without customer details", async () => {
    const server = app();
    await deletedLeads(600);
    const matching = await selection(server);
    const review = await preview(server, matching.ids);
    expect(review.eligible).toBe(600);
    let erased = 0;
    for (let i = 0; i < review.eligible_ids.length; i += 250) {
      const result = (
        await erase(server, review.eligible_ids.slice(i, i + 250)).expect(200)
      ).body;
      expect(result.failed).toBe(0);
      erased += result.erased;
    }
    expect(erased).toBe(600);
    expect(await count("select count(*)::int n from leads")).toBe(0);
    const audit = await all(
      "select metadata from audit_log where action='lead.erased' order by id",
    );
    expect(audit.map((a) => a.metadata.erased)).toEqual([250, 250, 100]);
    // Lead numbers only: no name, phone or reason.
    for (const { metadata } of audit) {
      expect(Object.keys(metadata).sort()).toEqual([
        "erased",
        "failed",
        "lead_nos",
      ]);
      expect(JSON.stringify(metadata)).not.toMatch(/Bin buyer|\+92|Junk/);
    }
    expect(
      await count(
        "select count(*)::int n from security_alerts where type='mass_lead_erasure'",
      ),
    ).toBe(1);
    expect((await preview(server, [matching.ids[0]])).erased_today).toBe(600);
  }, 60000);

  it("checks each lead again: one restored meanwhile is kept, and a repeated request erases nothing twice", async () => {
    const server = app();
    const ids = await deletedLeads(3);
    const review = await preview(server, ids);
    expect(review.eligible).toBe(3);
    // Restored (in another tab, or by another administrator) after the
    // review.
    await pg.query("select restore_leads($1,$2,'t')", [[ids[1]], admin]);
    const first = (await erase(server, review.eligible_ids).expect(200)).body;
    expect(first).toMatchObject({ erased: 2, failed: 1 });
    expect(first.results.find((r) => r.id === ids[1])).toMatchObject({
      result: "failed",
      reason: "Not in Deleted leads",
    });
    expect(
      await count("select count(*)::int n from leads where id=$1", [ids[1]]),
    ).toBe(1);
    // The same request again (a double click, or a retry): nothing more.
    const again = (await erase(server, review.eligible_ids).expect(200)).body;
    expect(again).toMatchObject({ erased: 0, failed: 3 });
    expect(
      await count(
        "select count(*)::int n from audit_log where action='lead.erased' and (metadata->>'erased')::int>0",
      ),
    ).toBe(1);
  });

  it("never erases a lead with a won deal", async () => {
    const server = app();
    const [won] = await deletedLeads(1);
    await pg.query(
      "insert into deals(lead_id,property_id,agent_id,stage,expected_value,close_date) values($1,$2,$3,'won',100,current_date)",
      [won, property, ali],
    );
    expect((await preview(server, [won])).eligible).toBe(0);
    const result = (await erase(server, [won]).expect(200)).body;
    expect(result.results[0]).toMatchObject({ reason: "Has a won deal" });
    expect(
      await count("select count(*)::int n from leads where id=$1", [won]),
    ).toBe(1);
  });

  it("erases nothing of a batch the database fails, and says so", async () => {
    const server = app();
    const ids = await deletedLeads(5);
    eraseFails = true;
    const res = await erase(server, ids);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.body.erased).toBeUndefined();
    expect(
      await count(
        "select count(*)::int n from leads where deleted_at is not null",
      ),
    ).toBe(5);
    expect(
      await count(
        "select count(*)::int n from audit_log where action='lead.erased'",
      ),
    ).toBe(0);
    // Checked again afterwards, the review shows the five still there.
    eraseFails = false;
    expect(await preview(server, ids)).toMatchObject({
      eligible: 5,
      missing: 0,
    });
  });

  it("keeps a recording queued when Storage fails, and removes it on the next run", async () => {
    const server = app();
    const ids = await deletedLeads(2);
    const call = (
      await one(
        "insert into calls(lead_id,agent_id,method,status,started_at,outcome) values($1,$2,'mock','completed',now(),'Interested') returning id",
        [ids[0], ali],
      )
    ).id;
    await pg.query(
      "insert into crm_private.recordings(call_id,storage_path) values($1,'calls/first.mp3')",
      [call],
    );
    storageFails = true;
    const result = (await erase(server, [ids[0]]).expect(200)).body;
    // The lead is erased; its file is not gone yet, and the answer says so.
    expect(result).toMatchObject({
      erased: 1,
      files_removed: false,
      storage: {
        removed: { recordings: 0, documents: 0 },
        pending: { recordings: 1, documents: 0, more: false },
        failed: true,
        done: false,
      },
    });
    expect(
      await count("select count(*)::int n from leads where id=$1", [ids[0]]),
    ).toBe(0);
    expect(
      await count(
        "select count(*)::int n from crm_private.lead_recording_cleanup where storage_path='calls/first.mp3'",
      ),
    ).toBe(1);
    expect(removed).toEqual([]);
    // The next erase run removes what is queued, its own and the earlier.
    storageFails = false;
    const next = (await erase(server, [ids[1]]).expect(200)).body;
    expect(next).toMatchObject({
      erased: 1,
      files_removed: true,
      storage: {
        removed: { recordings: 1, documents: 0 },
        pending: { recordings: 0, documents: 0, more: false },
        failed: false,
        done: true,
      },
    });
    expect(removed).toEqual(["recordings/calls/first.mp3"]);
    expect(
      await count(
        "select count(*)::int n from crm_private.lead_recording_cleanup",
      ),
    ).toBe(0);
  });

  it("keeps the Google Sheet row's receipt, so the next sync does not bring the lead back", async () => {
    const server = app();
    const [lead] = await deletedLeads(1);
    const source = (
      await one(
        "insert into sheet_sources(name,spreadsheet_id,worksheet,created_by) values('Ads','1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_72','Sheet1',$1) returning id",
        [admin],
      )
    ).id;
    await pg.query(
      "insert into crm_private.sheet_lead_receipts(source_id,meta_lead_id,outcome,lead_id,sheet_row) values($1,'7201','created',$2,2)",
      [source, lead],
    );
    expect((await preview(server, [lead])).sheet_leads).toBe(1);
    await erase(server, [lead]).expect(200);
    expect(
      await one(
        "select lead_id,outcome from crm_private.sheet_lead_receipts where source_id=$1",
        [source],
      ),
    ).toEqual({ lead_id: null, outcome: "created" });
  });

  it("says files are still waiting when more than 2,000 are queued, and the next run removes the rest", async () => {
    const server = app();
    const ids = await deletedLeads(2);
    // 2,150 recordings left by earlier erasures, plus 3 KYC files.
    await pg.query(
      "insert into crm_private.lead_recording_cleanup(storage_path) select 'calls/queued-'||i||'.mp3' from generate_series(1,2150) i",
    );
    await pg.query(
      "insert into public.knowledge_file_cleanup(document_id,storage_path) select gen_random_uuid(),'kyc/queued-'||i||'.pdf' from generate_series(1,3) i",
    );
    const first = await erase(server, [ids[0]]).expect(200);
    // One request removes at most 20 batches of 100 recordings.
    expect(first.body).toMatchObject({
      erased: 1,
      files_removed: false,
      storage: {
        removed: { recordings: 2000, documents: 3 },
        pending: { recordings: 100, documents: 0, more: true },
        failed: false,
        done: false,
      },
    });
    // Counts only: no file name or path is ever answered.
    expect(first.text).not.toMatch(/calls\/|kyc\/|queued-/);
    expect(
      await count(
        "select count(*)::int n from crm_private.lead_recording_cleanup",
      ),
    ).toBe(150);
    const waiting = await request(server)
      .get("/api/leads/erase/storage")
      .set(as(admin))
      .expect(200);
    expect(waiting.body).toEqual({
      pending: { recordings: 100, documents: 0, more: true },
    });
    // The next Delete instantly removes what is left.
    const second = (await erase(server, [ids[1]]).expect(200)).body;
    expect(second).toMatchObject({
      files_removed: true,
      storage: {
        removed: { recordings: 150, documents: 0 },
        pending: { recordings: 0, documents: 0, more: false },
        done: true,
      },
    });
    expect(removed).toHaveLength(2153);
  }, 120000);

  it("reports a Storage failure part way, keeps the rest queued, and a retry finishes", async () => {
    const server = app();
    const ids = await deletedLeads(2);
    await pg.query(
      "insert into crm_private.lead_recording_cleanup(storage_path) select 'calls/part-'||i||'.mp3' from generate_series(1,10) i",
    );
    await pg.query(
      "insert into public.knowledge_file_cleanup(document_id,storage_path) values(gen_random_uuid(),'kyc/part.pdf')",
    );
    failAfter = 4;
    const first = (await erase(server, [ids[0]]).expect(200)).body;
    // The lead is erased; four recordings went; Storage then failed for the
    // other six and for the KYC file, which stay queued.
    expect(first).toMatchObject({
      erased: 1,
      files_removed: false,
      storage: {
        removed: { recordings: 4, documents: 0 },
        pending: { recordings: 6, documents: 1, more: false },
        failed: true,
        done: false,
      },
    });
    expect(
      await count("select count(*)::int n from leads where id=$1", [ids[0]]),
    ).toBe(0);
    failAfter = Infinity;
    const retry = (await erase(server, [ids[1]]).expect(200)).body;
    expect(retry).toMatchObject({
      files_removed: true,
      storage: {
        removed: { recordings: 6, documents: 1 },
        pending: { recordings: 0, documents: 0 },
        failed: false,
      },
    });
  });

  it("tells the truth after a lost answer: the leads are gone and the queue says which files wait", async () => {
    const server = app();
    const ids = await deletedLeads(3);
    await pg.query(
      "insert into crm_private.lead_recording_cleanup(storage_path) values('calls/lost.mp3')",
    );
    storageFails = true;
    // The answer to this request never reaches the browser.
    await erase(server, ids).expect(200);
    // What the browser asks next: which leads are gone, which files wait.
    expect(await preview(server, ids)).toMatchObject({
      eligible: 0,
      missing: 3,
    });
    expect(
      (
        await request(server)
          .get("/api/leads/erase/storage")
          .set(as(admin))
          .expect(200)
      ).body,
    ).toEqual({ pending: { recordings: 1, documents: 0, more: false } });
    // Administrators only, with no extra parameters.
    await request(server)
      .get("/api/leads/erase/storage")
      .set(as(ali))
      .expect(403);
    await request(server)
      .get("/api/leads/erase/storage")
      .query({ all: 1 })
      .set(as(admin))
      .expect(400);
  });

  it("does not touch Storage when no lead was erased", async () => {
    const server = app();
    const [lead] = await deletedLeads(1);
    await pg.query(
      "insert into crm_private.lead_recording_cleanup(storage_path) values('calls/other.mp3')",
    );
    await pg.query("select restore_leads($1,$2,'t')", [[lead], admin]);
    const result = (await erase(server, [lead]).expect(200)).body;
    expect(result).toMatchObject({
      erased: 0,
      files_removed: true,
      storage: null,
    });
    expect(removed).toEqual([]);
  });
});
