import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import request from "supertest";
import {
  getCountries,
  getExampleNumber,
  getCountryCallingCode,
} from "libphonenumber-js/max";
import examples from "libphonenumber-js/mobile/examples";
import { createApp } from "../src/app.js";
import { numberCountry } from "../src/utils/internationalPhone.js";
import { phoneCountryRulesSql } from "../../scripts/phone-country-rules.mjs";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 065: the country of a lead's number, for its flag and the Country
// filter. The database works it out with libphonenumber's rules (generated
// into the migration) and gives the library's answer; shared calling codes
// (+1, +7, +44, …) are settled by area code or leading digits, never
// guessed. The filter works across every lead, with the other filters and
// pages, and agents see only their own leads.
const admin = "65000000-0000-4000-8000-000000000001",
  ali = "65000000-0000-4000-8000-000000000002",
  sara = "65000000-0000-4000-8000-000000000003";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
const dbCountries = async (numbers) =>
  Object.fromEntries(
    (
      await all(
        "select n,public.phone_country(n) c from unnest($1::text[]) n",
        [numbers],
      )
    ).map((r) => [r.n, r.c]),
  );

describe("the country of a number", () => {
  it("uses the rules generated from the installed library", async () => {
    const migration = await readFile(
      new URL(
        "../../supabase/migrations/065_phone_countries.sql",
        import.meta.url,
      ),
      "utf8",
    );
    const block = migration
      .split("-- rules: begin\n")[1]
      .split("\n-- rules: end")[0];
    expect(block).toBe(phoneCountryRulesSql());
    expect(
      (await one("select count(*)::int n from crm_private.phone_country_rules"))
        .n,
    ).toBe(block.split("\n").length);
  });
  it("is the library's answer for every country, every +1 area code and the other shared codes", async () => {
    const numbers = new Set();
    for (const country of getCountries()) {
      const example = getExampleNumber(country, examples);
      if (example) numbers.add(example.number);
    }
    for (let npa = 200; npa <= 999; npa++) {
      numbers.add(`+1${npa}2345678`);
      numbers.add(`+1${npa}5550123`);
    }
    for (const n of [
      // The United Kingdom and Guernsey, Jersey, the Isle of Man.
      "+442079460958",
      "+447911123456",
      "+441481234567",
      "+447781123456",
      "+441534123456",
      "+447797123456",
      "+441624123456",
      "+447624123456",
      // Russia and Kazakhstan; Italy and the Vatican; Norway and Svalbard.
      "+74951234567",
      "+77011234567",
      "+73312345678",
      "+390612345678",
      "+390669812345",
      "+4779123456",
      "+4741234567",
      // Australia, Christmas Island, the Cocos Islands.
      "+61412345678",
      "+61891620123",
      "+61891640123",
      // Morocco and Western Sahara; Finland and Åland; Réunion and Mayotte.
      "+212528123456",
      "+212612345678",
      "+358181234567",
      "+358401234567",
      "+262269612345",
      "+262692123456",
      // No country: a non-geographic number, an unknown code, an unused
      // +1 area code, too short for any rule.
      "+80012345678",
      "+99912345678",
      "+15550123456",
      "+11234567890",
    ])
      numbers.add(n);
    // Random numbers under every calling code.
    let seed = 64;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31);
    for (const code of new Set(
      getCountries().map((c) => getCountryCallingCode(c)),
    ))
      for (let i = 0; i < 4; i++) {
        const length = 7 + (random() % 6);
        let digits = "";
        while (digits.length < length) digits += String(random() % 10);
        const n = `+${code}${digits}`.slice(0, 16);
        if (/^\+[1-9]\d{6,14}$/.test(n)) numbers.add(n);
      }
    const list = [...numbers];
    const found = await dbCountries(list);
    const differences = list.filter(
      (n) => (found[n] ?? null) !== numberCountry(n),
    );
    expect(differences.slice(0, 10)).toEqual([]);
    expect(list.length).toBeGreaterThan(2000);
  });
  it("places shared codes by area code or leading digits, and guesses none", async () => {
    expect(
      await dbCountries([
        "+923001234567",
        "+971501234567",
        "+966501234567",
        "+442079460958",
        "+12025550123",
        "+14165550199",
        "+18765551234",
        "+61412345678",
        "+15550123456",
        "+80012345678",
      ]),
    ).toEqual({
      "+923001234567": "PK",
      "+971501234567": "AE",
      "+966501234567": "SA",
      "+442079460958": "GB",
      "+12025550123": "US",
      "+14165550199": "CA",
      "+18765551234": "JM",
      "+61412345678": "AU",
      // No area code 555 in North America: no flag.
      "+15550123456": null,
      // Non-geographic numbers belong to no country.
      "+80012345678": null,
    });
    // A number stored before numbers were checked keeps its calling code's
    // country when only one country uses it.
    expect(numberCountry("+92300123456")).toBe("PK");
    expect((await one("select public.phone_country('+92300123456') c")).c).toBe(
      "PK",
    );
    expect(numberCountry("not a number")).toBeNull();
  });
});

describe("filtering leads by country", () => {
  const as = (user) => ({ Authorization: "Bearer " + user });
  const server = () => createApp(trustedMfaFixture(db));
  const ids = {};
  beforeAll(async () => {
    await resetPeople(pg, [admin, ali, sara]);
    const lead = async (key, phone, owner) => {
      ids[key] = (
        await one("select (create_lead($1::jsonb,$2,$3,'t')).id", [
          JSON.stringify({ name: `Buyer ${key}`, assigned_agent: owner }),
          phone,
          admin,
        ])
      ).id;
    };
    // 22 Pakistani leads (more than a page of 20), and one each from
    // elsewhere, two with no country.
    for (let n = 0; n < 22; n++)
      await lead(`pk${n}`, `+9230012300${String(n).padStart(2, "0")}`, ali);
    await lead("ae_ali", "+971501234567", ali);
    await lead("ae_sara", "+971501234568", sara);
    await lead("sa", "+966501234567", ali);
    await lead("gb", "+442079460958", null);
    await lead("us", "+12025550123", ali);
    await lead("ca", "+14165550199", sara);
    await lead("nongeo", "+80012345678", null);
    await lead("nanp_unknown", "+15550123456", null);
    // Ali's pipeline: answered calls, with temperatures.
    const call = (key, tag) =>
      pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
        ids[key],
        ali,
        JSON.stringify({
          answered: true,
          started_at: new Date(Date.now() - 60000).toISOString(),
          duration_seconds: 60,
          outcome: "Interested",
          notes: "",
          deal_tags: [tag],
        }),
      ]);
    await call("ae_ali", "Hot lead");
    await call("us", "Warm lead");
    await call("pk0", "Hot lead");
    await call("pk1", "Cold lead");
  }, 120000);
  const allLeads = async (query) =>
    (
      await request(server())
        .get("/api/leads/all?" + new URLSearchParams(query))
        .set(as(admin))
        .expect(200)
    ).body;
  const names = (body) => body.data.map((r) => r.name).sort();

  it("All leads: only the chosen country, each number with its country", async () => {
    const ae = await allLeads({ country: "AE" });
    expect(ae.count).toBe(2);
    expect(names(ae)).toEqual(["Buyer ae_ali", "Buyer ae_sara"]);
    expect(ae.data.map((r) => r.phone_country)).toEqual(["AE", "AE"]);
    // +1: the United States and Canada apart; an unused area code unknown.
    expect(names(await allLeads({ country: "US" }))).toEqual(["Buyer us"]);
    expect(names(await allLeads({ country: "CA" }))).toEqual(["Buyer ca"]);
    const unknown = await allLeads({ country: "unknown" });
    expect(names(unknown)).toEqual(["Buyer nanp_unknown", "Buyer nongeo"]);
    expect(unknown.data.map((r) => r.phone_country)).toEqual([null, null]);
    // Every lead without the filter.
    expect((await allLeads({})).count).toBe(30);
  });
  it("All leads: counts and pages across every lead, with the other filters and search", async () => {
    const first = await allLeads({ country: "PK" });
    expect(first.count).toBe(22);
    expect(first.data).toHaveLength(20);
    const second = await allLeads({ country: "PK", page: 2 });
    expect(second.count).toBe(22);
    expect(second.data).toHaveLength(2);
    expect(new Set([...first.data, ...second.data].map((r) => r.id)).size).toBe(
      22,
    );
    expect(names(await allLeads({ country: "AE", agent: sara }))).toEqual([
      "Buyer ae_sara",
    ]);
    expect(names(await allLeads({ country: "AE", search: "ae_ali" }))).toEqual([
      "Buyer ae_ali",
    ]);
    expect((await allLeads({ country: "PK", temperature: "hot" })).count).toBe(
      1,
    );
    expect(
      (await allLeads({ country: "GB", assignment: "unassigned" })).count,
    ).toBe(1);
    expect(
      (await allLeads({ country: "GB", assignment: "assigned" })).count,
    ).toBe(0);
    const selection = (
      await request(server())
        .get("/api/leads/all/selection?country=AE")
        .set(as(admin))
        .expect(200)
    ).body.ids;
    expect(selection.sort()).toEqual([ids.ae_ali, ids.ae_sara].sort());
  });
  it("refuses a country the library does not know", async () => {
    for (const country of ["XX", "pk", "Pakistan", "92"])
      await request(server())
        .get("/api/leads/all?country=" + country)
        .set(as(admin))
        .expect(400);
  });
  it("Lead pipeline (agent): only the agent's own leads of that country, with their numbers", async () => {
    const mine = async (query, user = ali) =>
      (
        await request(server())
          .get("/api/my-leads?" + new URLSearchParams(query))
          .set(as(user))
          .expect(200)
      ).body;
    const ae = await mine({ view: "pipeline", country: "AE" });
    expect(names(ae)).toEqual(["Buyer ae_ali"]);
    expect(ae.data[0].phone_country).toBe("AE");
    expect(ae.temperatures).toEqual({ hot: 1, warm: 0, cold: 0, none: 0 });
    const pk = await mine({ view: "pipeline", country: "PK" });
    expect(pk.count).toBe(2);
    expect(pk.temperatures).toEqual({ hot: 1, warm: 0, cold: 1, none: 0 });
    // The whole pipeline without the filter; another agent's AE lead never.
    expect((await mine({ view: "pipeline" })).count).toBe(4);
    expect(names(await mine({ view: "pipeline", country: "CA" }))).toEqual([]);
    expect(names(await mine({ view: "assigned", country: "AE" }))).toEqual([
      "Buyer ae_ali",
    ]);
    expect(
      names(await mine({ view: "assigned", country: "AE" }, sara)),
    ).toEqual(["Buyer ae_sara"]);
    // With the pipeline's own filters.
    expect(
      (await mine({ view: "pipeline", country: "PK", temperature: "cold" }))
        .count,
    ).toBe(1);
    // Agents have no All leads.
    await request(server())
      .get("/api/leads/all?country=AE")
      .set(as(ali))
      .expect(403);
  });
  it("Lead pipeline (administrator): one agent's pipeline and its numbers for that country", async () => {
    const pipeline = async (query) =>
      (
        await request(server())
          .get(`/api/pipeline/agents/${ali}?` + new URLSearchParams(query))
          .set(as(admin))
          .expect(200)
      ).body;
    const all = await pipeline({});
    expect(all.count).toBe(4);
    expect(all.temperatures).toEqual({
      contacted: 4,
      hot: 2,
      warm: 1,
      cold: 1,
      none: 0,
    });
    const us = await pipeline({ country: "US" });
    expect(names(us)).toEqual(["Buyer us"]);
    expect(us.data[0].phone_country).toBe("US");
    expect(us.temperatures).toEqual({
      contacted: 1,
      hot: 0,
      warm: 1,
      cold: 0,
      none: 0,
    });
    // The agent's overall numbers stay as they were.
    expect(us.summary).toEqual(all.summary);
    expect((await pipeline({ country: "SA" })).count).toBe(0);
  });
  it("lists every country the library knows, by name", async () => {
    const { countries } = (
      await request(server())
        .get("/api/phone-countries")
        .set(as(ali))
        .expect(200)
    ).body;
    expect(countries.length).toBe(getCountries().length);
    expect(countries.find((c) => c.code === "PK")).toEqual({
      code: "PK",
      name: "Pakistan",
      calling_code: "92",
    });
    expect(countries.find((c) => c.code === "AE").name).toBe(
      "United Arab Emirates",
    );
  });
});
