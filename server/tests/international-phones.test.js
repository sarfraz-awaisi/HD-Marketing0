import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { phoneCountry, readPhone } from "../src/utils/internationalPhone.js";
import { readSheetRow } from "../src/services/sheetsImport.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 064: phone numbers from any country in the Google Sheets import,
// checked with each country's numbering rules and stored in E.164. Pakistani
// numbers read as before; a number without a country code is never guessed
// to be from another country; the same customer written different ways is
// one lead, and different customers stay apart.
const admin = "64000000-0000-4000-8000-000000000001",
  ali = "64000000-0000-4000-8000-000000000002",
  sara = "64000000-0000-4000-8000-000000000003";
const read = (value, country) =>
  readPhone(value, country === undefined ? null : phoneCountry(country));
const phone = (value, country) => read(value, country).phone;
const problem = (value, country) => read(value, country).error;

describe("reading a phone number", () => {
  it("keeps every Pakistani format", () => {
    for (const written of [
      "03001234567",
      "0300-1234567",
      "0300 1234567",
      "3001234567",
      "923001234567",
      "+92 300 1234567",
      "+92-300-1234567",
      "0092 300 1234567",
      "(+92) 300-1234567",
      // The 0 written by mistake after +92.
      "+92 0300 1234567",
    ])
      expect(phone(written), written).toBe("+923001234567");
    expect(phone("042 3576 1234")).toBe("+924235761234");
  });
  it("reads numbers from other countries by their country code (+ or 00)", () => {
    const cases = {
      // United Arab Emirates
      "+971 50 123 4567": "+971501234567",
      "00971 50 123 4567": "+971501234567",
      "(+971) 50-123-4567": "+971501234567",
      // Saudi Arabia
      "+966 50 123 4567": "+966501234567",
      "00966501234567": "+966501234567",
      // United Kingdom, with and without the (0)
      "+44 7911 123456": "+447911123456",
      "+44 (0)7911 123456": "+447911123456",
      // United States and Canada
      "+1 (212) 555-0123": "+12125550123",
      "+1 416 555 0199": "+14165550199",
      // Australia
      "+61 412 345 678": "+61412345678",
      // Qatar, Germany, India, Bangladesh, China, Oman
      "+974 3312 3456": "+97433123456",
      "+49 1512 3456789": "+4915123456789",
      "+91 98765 43210": "+919876543210",
      "+880 1712-345678": "+8801712345678",
      "+86 138 0013 8000": "+8613800138000",
      "+968 9123 4567": "+96891234567",
    };
    for (const [written, e164] of Object.entries(cases))
      expect(phone(written), written).toBe(e164);
  });
  it("reads digits and marks copied from phones and other scripts", () => {
    // Arabic-Indic and Urdu digits, direction marks, full-width characters.
    expect(phone("٠٣٠٠١٢٣٤٥٦٧")).toBe("+923001234567");
    expect(phone("۰۳۰۰۱۲۳۴۵۶۷")).toBe("+923001234567");
    expect(phone("‎+971 50 123 4567‏")).toBe("+971501234567");
    expect(phone("‪+44 7911 123456‬")).toBe("+447911123456");
    expect(phone("＋９７１５０１２３４５６７")).toBe("+971501234567");
  });
  it("uses a country column only when it says clearly which country", () => {
    expect(phoneCountry("United Arab Emirates")).toEqual({ country: "AE" });
    expect(phoneCountry("UAE")).toEqual({ country: "AE" });
    expect(phoneCountry("ae")).toEqual({ country: "AE" });
    expect(phoneCountry("KSA")).toEqual({ country: "SA" });
    expect(phoneCountry("United Kingdom")).toEqual({ country: "GB" });
    expect(phoneCountry("UK")).toEqual({ country: "GB" });
    expect(phoneCountry("USA")).toEqual({ country: "US" });
    expect(phoneCountry("Türkiye")).toEqual({ country: "TR" });
    expect(phoneCountry("+971")).toEqual({ callingCode: "971" });
    expect(phoneCountry("1")).toEqual({ callingCode: "1" });
    for (const unclear of ["", "Pakistan or UAE", "Gulf", "Mars", "+999", "XX"])
      expect(phoneCountry(unclear), unclear).toBeNull();
    // A local number with its country.
    expect(phone("050 123 4567", "United Arab Emirates")).toBe("+971501234567");
    expect(phone("050 123 4567", "+971")).toBe("+971501234567");
    expect(phone("0501234567", "Saudi Arabia")).toBe("+966501234567");
    expect(phone("07911 123456", "UK")).toBe("+447911123456");
    expect(phone("(212) 555-0123", "USA")).toBe("+12125550123");
    expect(phone("416-555-0199", "Canada")).toBe("+14165550199");
    expect(phone("416-555-0199", "+1")).toBe("+14165550199");
    expect(phone("0412 345 678", "Australia")).toBe("+61412345678");
    expect(phone("971501234567", "AE")).toBe("+971501234567");
    // The number's own country code wins over the column.
    expect(phone("+92 300 1234567", "UAE")).toBe("+923001234567");
    // A Pakistani number from a customer abroad stays Pakistani.
    expect(phone("03001234567", "UAE")).toBe("+923001234567");
    // An unclear column is no column.
    expect(phone("03001234567", "Gulf")).toBe("+923001234567");
  });
  it("never guesses another country for a number without its code", () => {
    // Local numbers from the UAE, the UK and Saudi Arabia; a number that
    // lost its +.
    for (const written of ["050 123 4567", "07911 123456", "971501234567"])
      expect(problem(written), written).toBe("phone_needs_country");
    expect(problem("050 123 4567", "Gulf")).toBe("phone_needs_country");
    // A local number that is also a valid Pakistani one (here New York's,
    // like a Karachi landline) cannot be told apart: it is read as Pakistani,
    // as the CRM always has. A country column or a country code settles it.
    expect(phone("212 555 0123")).toBe("+922125550123");
    expect(phone("212 555 0123", "USA")).toBe("+12125550123");
    expect(phone("+1 212 555 0123")).toBe("+12125550123");
  });
  it("gives a reason for every number it cannot read", () => {
    expect(problem("")).toBe("phone_missing");
    expect(problem("   ")).toBe("phone_missing");
    expect(problem("--")).toBe("phone_missing");
    for (const written of [
      "not given",
      "+92 300 123456", // a digit short
      "0300123456", // a digit short, without +92
      "+92 300 12345678", // a digit too many
      "+1 555 0100",
      "+971 50 123",
      "+999 1234567", // no such country code
      "+44 7911 123456 ext 2",
      "12",
    ])
      expect(problem(written), written).toBe("phone_invalid");
    // Wrong for the country given.
    expect(problem("12345678", "UAE")).toBe("phone_invalid");
    // Valid but shorter than the ten digits the CRM keeps and protects
    // (Niue, the Falkland Islands).
    expect(problem("+683 7290")).toBe("phone_invalid");
    expect(problem("+500 51234")).toBe("phone_invalid");
  });
});

describe("a Sheet row's phone number", () => {
  const values = (extra) => ({
    id: "l:7640000000000001",
    full_name: "Overseas Buyer",
    phone_number: "p:+971 50 123 4567",
    ...extra,
  });
  it("is stored in E.164, the country column staying in the answers", () => {
    const row = readSheetRow({
      row: 2,
      values: values({ phone_number: "050 123 4567", Country: "UAE" }),
    });
    expect(row.phone).toBe("+971501234567");
    expect(row.inquiry.answers).toMatchObject({ Country: "UAE" });
    expect(row.inquiry.extra).toMatchObject({ Country: "UAE" });
    expect(JSON.stringify(row.inquiry)).not.toContain("501234567");
  });
  it("is rejected with the reason", () => {
    const reason = (phone) =>
      readSheetRow({ row: 2, values: values({ phone_number: phone }) }).error;
    expect(reason("p:")).toBe("phone_missing");
    expect(reason("07911 123456")).toBe("phone_needs_country");
    expect(reason("+1 555 0100")).toBe("phone_invalid");
  });
});

describe("importing numbers from any country (database)", () => {
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
  const as = (user) => ({ Authorization: "Bearer " + user });
  let n = 0;
  const submission = (phoneNumber, extra = {}) => ({
    id: `l:${7640000000000000 + ++n}`,
    created_time: "2026-11-01T10:15:30+0500",
    ad_name: "Overseas plots",
    full_name: `Buyer ${n}`,
    phone_number: phoneNumber,
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
          name: "Overseas",
          spreadsheet: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_64",
          worksheet: "Sheet1",
          enabled: true,
          confirm_history: true,
        })
        .expect(201)
    ).body.id;
    const send = async (rows) =>
      (
        await request(server)
          .post(`/api/integrations/sheets-sync/sources/${source}/rows`)
          .set(as(key))
          .send({ rows })
          .expect(200)
      ).body.rows.map((r) => r.status + (r.reason ? ":" + r.reason : ""));
    const rejections = async () =>
      (
        await request(server)
          .get(`/api/integrations/sheets/sources/${source}/rejections`)
          .set(as(admin))
          .expect(200)
      ).body.map((r) => [r.row, r.reason]);
    return { send, rejections };
  }
  const numbers = () =>
    all(
      "select p.phone,count(*)::int inquiries from crm_private.lead_phones p join crm_private.sheet_lead_inquiries i on i.lead_id=p.lead_id group by p.phone order by p.phone",
    );

  it("makes one lead of one customer however the number is written, and keeps different customers apart", async () => {
    const server = createApp(trustedMfaFixture(db));
    const { send } = await sheet(server);
    const rows = [
      submission("p:+971 50 123 4567"),
      submission("00971501234567"),
      submission("(+971) 50-123-4567"),
      submission("050 123 4567", { country: "United Arab Emirates" }),
      // One digit different: another customer.
      submission("p:+971 50 123 4568"),
      // The same local digits in Saudi Arabia: another customer.
      submission("050 123 4567", { country: "Saudi Arabia" }),
      submission("p:+44 7911 123456"),
      submission("p:+1 416 555 0199"),
      submission("p:+61 412 345 678"),
    ].map((values, i) => ({ row: i + 2, values }));
    expect(await send(rows)).toEqual([
      "inserted",
      "existing",
      "existing",
      "existing",
      "inserted",
      "inserted",
      "inserted",
      "inserted",
      "inserted",
    ]);
    expect(await numbers()).toEqual([
      { phone: "+14165550199", inquiries: 1 },
      { phone: "+447911123456", inquiries: 1 },
      { phone: "+61412345678", inquiries: 1 },
      { phone: "+966501234567", inquiries: 1 },
      { phone: "+971501234567", inquiries: 4 },
      { phone: "+971501234568", inquiries: 1 },
    ]);
    // Stored masked as every number is, never in full on the lead.
    expect(
      (await all("select masked_phone from leads order by masked_phone")).map(
        (r) => r.masked_phone,
      ),
    ).toContain("+97******567");
  });

  it("finds an existing Pakistani lead however its number is written", async () => {
    const server = createApp(trustedMfaFixture(db));
    const existing = (
      await one(
        "select (create_lead('{\"name\":\"Existing Buyer\"}'::jsonb,'03001234567',$1,'t')).id",
        [admin],
      )
    ).id;
    const { send } = await sheet(server);
    expect(
      await send(
        [
          submission("p:+923001234567"),
          submission("+92 0300 1234567"),
          submission("3001234567"),
          submission("0092 300 1234567"),
        ].map((values, i) => ({ row: i + 2, values })),
      ),
    ).toEqual(["existing", "existing", "existing", "existing"]);
    expect(await numbers()).toEqual([{ phone: "+923001234567", inquiries: 4 }]);
    expect(
      (await one("select count(*)::int n from leads where id<>$1", [existing]))
        .n,
    ).toBe(0);
  });

  it("rejects a number it cannot read with the reason, and imports the corrected row on the next sync", async () => {
    const server = createApp(trustedMfaFixture(db));
    const { send, rejections } = await sheet(server);
    const uk = submission("07911 123456"),
      us = submission("+1 555 0100"),
      none = submission(""),
      pk = submission("0300123456");
    expect(
      await send(
        [uk, us, none, pk].map((values, i) => ({ row: i + 2, values })),
      ),
    ).toEqual([
      "rejected:phone_needs_country",
      "rejected:phone_invalid",
      "rejected:phone_missing",
      "rejected:phone_invalid",
    ]);
    expect(await rejections()).toEqual([
      [2, "phone_needs_country"],
      [3, "phone_invalid"],
      [4, "phone_missing"],
      [5, "phone_invalid"],
    ]);
    // Corrected in the Sheet: the country code added, the digits fixed, a
    // country column filled.
    expect(
      await send([
        { row: 2, values: { ...uk, phone_number: "+44 7911 123456" } },
        { row: 3, values: { ...us, phone_number: "+1 212 555 0123" } },
        {
          row: 4,
          values: { ...none, phone_number: "0412 345 678", country: "AU" },
        },
        { row: 5, values: { ...pk, phone_number: "03001234567" } },
      ]),
    ).toEqual(["inserted", "inserted", "inserted", "inserted"]);
    expect(await rejections()).toEqual([]);
    expect((await numbers()).map((r) => r.phone)).toEqual([
      "+12125550123",
      "+447911123456",
      "+61412345678",
      "+923001234567",
    ]);
  });
});
