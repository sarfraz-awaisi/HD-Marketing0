import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { utils, write } from "xlsx";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 068: each lead keeps the name of the advertisement it came from. A
// CSV or Excel file's ad name column and a Google Sheet's ad_name fill it; a
// lead keeps the first one it is given; it shows with the lead in agents'
// Assigned leads and Lead pipeline, administrators' All leads and an
// agent's pipeline, and on the lead's page. No one can change it afterwards.
const admin = "68000000-0000-4000-8000-000000000001",
  ali = "68000000-0000-4000-8000-000000000002",
  sara = "68000000-0000-4000-8000-000000000003";
let pg, db, one, all;
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
const as = (user) => ({ Authorization: "Bearer " + user });
const upload = (server, rows, name = "meta-leads.xlsx", mapping) => {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Leads");
  const call = request(server)
    .post("/api/leads/import")
    .set(as(admin))
    .attach("file", write(book, { type: "buffer", bookType: "xlsx" }), name);
  return mapping ? call.field("mapping", JSON.stringify(mapping)) : call;
};
const adsOf = (importId) =>
  all(
    "select l.name,l.ad_name from leads l join crm_private.lead_file_rows r on r.lead_id=l.id where l.import_id=$1 order by r.file_row",
    [importId],
  );
const listed = (body) =>
  Object.fromEntries(body.data.map((row) => [row.name, row.ad_name ?? null]));
const long = "Lahore plots ".repeat(50);

describe("advertisement names from CSV and Excel files", () => {
  it("fills each lead's advertisement from the file's ad name column", async () => {
    const server = app();
    const result = (
      await upload(server, [
        ["Full Name", "Phone Number", "Ad Name"],
        ["Bilal Khan", "03001680001", "  DHA Phase 9 plots  "],
        ["No ad", "03001680002", ""],
        ["Long ad", "03001680003", long],
      ]).expect(200)
    ).body;
    expect(result.rows.map((r) => r.success)).toEqual([true, true, true]);
    expect(result.ignored_columns).toBeUndefined();
    expect(await adsOf(result.import_id)).toEqual([
      { name: "Bilal Khan", ad_name: "DHA Phase 9 plots" },
      { name: "No ad", ad_name: null },
      // Shortened, as from a Google Sheet, rather than the lead rejected.
      { name: "Long ad", ad_name: long.slice(0, 500).trim() },
    ]);
  });
  it("finds Meta's ad_name and other common headings, or a matched column", async () => {
    const server = app();
    for (const heading of ["ad_name", "Advertisement", "Ad"]) {
      const result = (
        await upload(
          server,
          [
            ["name", "phone", heading],
            [
              heading + " buyer",
              "0300168" + String(heading.length).padStart(4, "1"),
              "Bahria homes",
            ],
          ],
          heading + ".xlsx",
        ).expect(200)
      ).body;
      expect(await adsOf(result.import_id)).toEqual([
        { name: heading + " buyer", ad_name: "Bahria homes" },
      ]);
    }
    // A heading the CRM does not know: the administrator matches it.
    const unmatched = await upload(server, [
      ["name", "phone", "Campaign creative"],
      ["Matched buyer", "03001689001", "Gulberg flats"],
    ]).expect(400);
    expect(unmatched.body.code).toBe("IMPORT_COLUMNS_REQUIRED");
    expect(unmatched.body.columns[2]).toMatchObject({ suggested: null });
    const matched = (
      await upload(
        server,
        [
          ["name", "phone", "Campaign creative"],
          ["Matched buyer", "03001689001", "Gulberg flats"],
        ],
        "matched.xlsx",
        { name: 0, phone: 1, ad_name: 2 },
      ).expect(200)
    ).body;
    expect(await adsOf(matched.import_id)).toEqual([
      { name: "Matched buyer", ad_name: "Gulberg flats" },
    ]);
  });
  it("shows it in every lead list and on the lead's page, also after reassignment", async () => {
    const server = app();
    const file = (
      await upload(server, [
        ["name", "phone", "ad name"],
        ["Listed buyer", "03001681001", "DHA Phase 9 plots"],
        ["Plain buyer", "03001681002", ""],
      ]).expect(200)
    ).body;
    const [lead, plain] = file.rows.map((r) => r.id);
    await pg.query("select assign_lead_import($1,$2,$3,'t')", [
      file.import_id,
      ali,
      admin,
    ]);
    const mine = (
      await request(server).get("/api/my-leads").set(as(ali)).expect(200)
    ).body;
    expect(listed(mine)).toEqual({
      "Listed buyer": "DHA Phase 9 plots",
      "Plain buyer": null,
    });
    const allLeads = (
      await request(server)
        .get("/api/leads/all?import_id=" + file.import_id)
        .set(as(admin))
        .expect(200)
    ).body;
    expect(listed(allLeads)).toEqual({
      "Listed buyer": "DHA Phase 9 plots",
      "Plain buyer": null,
    });
    // An agent's pipeline lists the leads they have spoken to.
    for (const id of [lead, plain])
      await pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
        id,
        ali,
        JSON.stringify({
          answered: true,
          started_at: new Date(Date.now() - 60000).toISOString(),
          duration_seconds: 60,
          outcome: "Interested",
          deal_tags: ["Hot lead"],
        }),
      ]);
    const pipeline = (
      await request(server)
        .get("/api/my-leads?view=pipeline")
        .set(as(ali))
        .expect(200)
    ).body;
    expect(listed(pipeline)).toEqual({
      "Listed buyer": "DHA Phase 9 plots",
      "Plain buyer": null,
    });
    const agentPipeline = (
      await request(server)
        .get(`/api/pipeline/agents/${ali}`)
        .set(as(admin))
        .expect(200)
    ).body;
    expect(listed(agentPipeline)).toEqual({
      "Listed buyer": "DHA Phase 9 plots",
      "Plain buyer": null,
    });
    // The customer's answer, like the budget: a lead's new agent sees it.
    await pg.query("select admin_assign_leads($1::uuid[],$2,$3,'t')", [
      [lead],
      admin,
      sara,
    ]);
    const moved = (
      await request(server).get("/api/my-leads").set(as(sara)).expect(200)
    ).body;
    expect(moved.data).toEqual([
      expect.objectContaining({
        name: "Listed buyer",
        reassigned: true,
        ad_name: "DHA Phase 9 plots",
      }),
    ]);
    for (const user of [admin, sara])
      expect(
        (
          await request(server)
            .get("/api/leads/" + lead)
            .set(as(user))
            .expect(200)
        ).body.ad_name,
      ).toBe("DHA Phase 9 plots");
  });
  it("cannot be changed afterwards; a lead added by hand can be given one", async () => {
    const server = app();
    const created = (
      await request(server)
        .post("/api/leads")
        .set(as(admin))
        .send({
          name: "Walk-in",
          phone: "03001682001",
          ad_name: "  Expo stand  ",
        })
        .expect(201)
    ).body;
    expect(created.ad_name).toBe("Expo stand");
    const refused = await request(server)
      .patch("/api/leads/" + created.id)
      .set(as(admin))
      .send({ ad_name: "Something else" });
    expect(refused.status).toBe(400);
    expect(
      (await one("select ad_name from leads where id=$1", [created.id]))
        .ad_name,
    ).toBe("Expo stand");
    // Over 500 characters is refused, not shortened, when typed in.
    await request(server)
      .post("/api/leads")
      .set(as(admin))
      .send({
        name: "Too long",
        phone: "03001682002",
        ad_name: "x".repeat(501),
      })
      .expect(400);
    // The table refuses an empty or over-long name, whoever writes it.
    for (const value of ["", "x".repeat(501)])
      await expect(
        pg.query("update leads set ad_name=$1 where id=$2", [
          value,
          created.id,
        ]),
      ).rejects.toThrow(/check constraint/);
  });
});

describe("advertisement names from Google Sheets", () => {
  const sheetRow = (n, extra = {}) => ({
    id: `l:${7168000000000000 + n}`,
    created_time: "2026-11-01T10:15:30+0500",
    ad_name: "DHA Phase 9 plots",
    campaign_name: "November plots",
    platform: "fb",
    full_name: `Sheet buyer ${n}`,
    phone_number: `p:+92301${String(n).padStart(7, "0")}`,
    ...extra,
  });
  async function sheet(server) {
    const key = (
      await request(server)
        .post("/api/integrations/sheets/key")
        .set(as(admin))
        .send({})
        .expect(201)
    ).body.key;
    const source = (
      await request(server)
        .post("/api/integrations/sheets/sources")
        .set(as(admin))
        .send({
          name: "Ads",
          spreadsheet:
            "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_68/edit#gid=0",
          worksheet: "Sheet1",
          enabled: true,
          confirm_history: true,
        })
        .expect(201)
    ).body.id;
    return (rows, first = 2) =>
      request(server)
        .post(`/api/integrations/sheets-sync/sources/${source}/rows`)
        .set(as(key))
        .send({ rows: rows.map((values, i) => ({ row: first + i, values })) })
        .expect(200);
  }
  const adOf = async (phone) =>
    (
      await one(
        "select l.ad_name from leads l join crm_private.lead_phones p on p.lead_id=l.id where p.phone=$1",
        [phone],
      )
    )?.ad_name;
  it("gives a new lead its advertisement, and the lead keeps the first one", async () => {
    await pg.query("delete from crm_private.sheet_sync_keys");
    const rows = await sheet(app());
    await rows([
      sheetRow(1),
      sheetRow(2, { ad_name: "" }),
      // Headings are matched ignoring case and spacing.
      { ...sheetRow(3, { ad_name: undefined }), "Ad Name": "Bahria homes" },
    ]);
    expect(await adOf("+923010000001")).toBe("DHA Phase 9 plots");
    expect(await adOf("+923010000002")).toBeNull();
    expect(await adOf("+923010000003")).toBe("Bahria homes");
    // Repeat inquiries: a lead with an advertisement keeps it; a lead
    // without one takes the first that names one.
    await rows(
      [
        sheetRow(11, {
          phone_number: "p:+923010000001",
          ad_name: "Gulberg flats",
        }),
        sheetRow(12, {
          phone_number: "p:+923010000002",
          ad_name: "Gulberg flats",
        }),
      ],
      5,
    );
    expect(await adOf("+923010000001")).toBe("DHA Phase 9 plots");
    expect(await adOf("+923010000002")).toBe("Gulberg flats");
    // Every inquiry keeps its own advertisement on the lead's page.
    expect(
      await all(
        "select i.ad_name from crm_private.sheet_lead_inquiries i join crm_private.lead_phones p on p.lead_id=i.lead_id where p.phone='+923010000001' order by i.meta_lead_id",
      ),
    ).toEqual([{ ad_name: "DHA Phase 9 plots" }, { ad_name: "Gulberg flats" }]);
  });
});
