import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
// The Google Apps Script itself (integrations/google-sheets/Code.gs), run in
// a sandbox with Google's services replaced: Sheets are arrays, the Script
// Properties an object, and UrlFetchApp calls the real CRM API, on an
// in-memory database in its own process (sheets-crm-server.mjs). Faults can
// be put between the two: a lost reply, a busy or unreachable CRM.
const admin = "56200000-0000-4000-8000-000000000001",
  ali = "56200000-0000-4000-8000-000000000002";
const code = readFileSync(
  new URL("../../integrations/google-sheets/Code.gs", import.meta.url),
  "utf8",
);
let child, base;
beforeAll(async () => {
  child = spawn(
    process.execPath,
    [fileURLToPath(new URL("./sheets-crm-server.mjs", import.meta.url))],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  base = await new Promise((resolve, reject) => {
    child.stdout.on("data", (data) => {
      const port = /PORT=(\d+)/.exec(String(data))?.[1];
      if (port) resolve(`http://127.0.0.1:${port}`);
    });
    child.on("exit", (status) =>
      reject(new Error("The CRM test server stopped: " + status)),
    );
  });
}, 90000);
afterAll(() => child?.kill());
const sql = async (text, params) => {
  const response = await fetch(base + "/__test/sql", {
    method: "POST",
    body: JSON.stringify({ sql: text, params }),
  });
  const rows = await response.json();
  if (!response.ok) throw new Error(rows.error);
  return rows;
};
const api = async (method, path, body, user = admin) => {
  const response = await fetch(base + "/api" + path, {
    method,
    headers: {
      Authorization: "Bearer " + user,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
beforeEach(async () => {
  await sql(
    `truncate auth.users,public.notifications,public.audit_log cascade;
     insert into auth.users(id,email,email_confirmed_at) values('${admin}','owner@gmail.com',now()),('${ali}','agent@gmail.com',now());
     update profiles set active=true,name=case when id='${admin}' then 'Owner' else 'Ali Agent' end,role=case when id='${admin}' then 'admin' else 'agent' end;`,
  );
});
const headings = [
  "id",
  "created_time",
  "ad_id",
  "ad_name",
  "adset_id",
  "adset_name",
  "campaign_id",
  "campaign_name",
  "form_id",
  "form_name",
  "is_organic",
  "platform",
  "what_are_you_interested_in?_",
  "what_is_your_preferred_investment_budget?_",
  "full_name",
  "phone_number",
  "email",
  "city",
  "lead_status",
];
const submission = (n, extra = {}) => ({
  id: `l:${7200000000000000 + n}`,
  created_time: "2026-11-01T10:15:30+0500",
  ad_id: "ag:120200000000001",
  ad_name: `Advertisement ${Math.floor(n / 100)}`,
  adset_id: "as:120200000000002",
  adset_name: "Lahore 25-45",
  campaign_id: "c:120200000000003",
  campaign_name: "November plots",
  form_id: "f:120200000000004",
  form_name: "Plot inquiry",
  is_organic: false,
  platform: "ig",
  "what_are_you_interested_in?_": "residential_plot",
  "what_is_your_preferred_investment_budget?_": "1_crore_to_2_crore",
  full_name: `Buyer ${n}`,
  phone_number: `p:+92301${String(n).padStart(7, "0")}`,
  email: `buyer${n}@example.com`,
  city: "Lahore",
  lead_status: "CREATED",
  ...extra,
});
// A Sheet as Apps Script reads it: a heading row, then rows of cells.
const sheet = (rows, columns = headings) => [
  [...columns],
  ...rows.map((row) => columns.map((c) => row[c] ?? "")),
];
const spreadsheet = (n) => `1SyncTestSpreadsheet0000000000000000_${n}`;
async function configure(names) {
  const { body } = await api("POST", "/integrations/sheets/key", {});
  const sources = [];
  for (const [i, name] of names.entries())
    sources.push(
      (
        await api("POST", "/integrations/sheets/sources", {
          name,
          spreadsheet: spreadsheet(i),
          worksheet: "Sheet1",
          enabled: true,
          confirm_history: true,
        })
      ).body.id,
    );
  return { key: body.key, sources };
}
// The Apps Script with Google's services replaced.
function appsScript(books, key, fault) {
  const logs = [],
    sleeps = [],
    requests = [],
    triggers = [];
  let locked = false;
  const properties = {
    CRM_BASE_URL: "https://crm.example.test",
    CRM_SHEETS_KEY: key,
  };
  const forward = (url, options) => {
    const args = [
      "-s",
      "-i",
      "-X",
      options.method.toUpperCase(),
      "-H",
      "Expect:",
      url.replace("https://crm.example.test", base),
    ];
    for (const [name, value] of Object.entries(options.headers || {}))
      args.push("-H", `${name}: ${value}`);
    if (options.payload)
      args.push(
        "-H",
        "Content-Type: " + options.contentType,
        "--data-binary",
        "@-",
      );
    const out = execFileSync("curl", args, {
      input: options.payload || "",
      maxBuffer: 20e6,
    }).toString();
    const split = out.indexOf("\r\n\r\n");
    const [status, ...lines] = out.slice(0, split).split("\r\n");
    const headers = Object.fromEntries(
      lines.map((l) => [
        l.slice(0, l.indexOf(":")),
        l.slice(l.indexOf(":") + 1).trim(),
      ]),
    );
    return {
      getResponseCode: () => Number(status.split(" ")[1]),
      getContentText: () => out.slice(split + 4),
      getHeaders: () => headers,
    };
  };
  const context = {
    console: {
      log: (message) => logs.push(String(message)),
      error: (message) => logs.push(String(message)),
    },
    LockService: {
      getScriptLock: () => ({
        tryLock: () => (locked ? false : (locked = true)),
        releaseLock: () => (locked = false),
      }),
    },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (name) => properties[name] ?? null,
      }),
    },
    Utilities: { sleep: (ms) => sleeps.push(ms) },
    SpreadsheetApp: {
      openById: (id) => {
        if (!books[id]) throw new Error("Document is missing");
        return {
          getSheetByName: (tab) =>
            books[id][tab]
              ? {
                  getDataRange: () => ({
                    getValues: () => books[id][tab].map((r) => [...r]),
                  }),
                }
              : null,
        };
      },
    },
    UrlFetchApp: {
      fetch: (url, options) => {
        const path = url.replace(/^.*\/api\/integrations\/sheets-sync/, "");
        requests.push({
          path,
          body: options.payload ? JSON.parse(options.payload) : null,
        });
        return fault
          ? fault(path, () => forward(url, options), requests.length)
          : forward(url, options);
      },
    },
    ScriptApp: {
      newTrigger: (handler) => {
        const made = { handler };
        const builder = {
          timeBased: () => builder,
          everyMinutes: (minutes) => ((made.minutes = minutes), builder),
          create: () => {
            triggers.push({
              getHandlerFunction: () => handler,
              minutes: made.minutes,
            });
            return made;
          },
        };
        return builder;
      },
      getProjectTriggers: () => [...triggers],
      deleteTrigger: (trigger) => triggers.splice(triggers.indexOf(trigger), 1),
    },
  };
  vm.createContext(context);
  vm.runInContext(code, context);
  return {
    context,
    logs,
    sleeps,
    requests,
    triggers,
    properties,
    hold: () => (locked = true),
    run() {
      logs.length = 0;
      requests.length = 0;
      context.syncLeads();
      return logs.join("\n");
    },
    rowRequests: () => requests.filter((r) => r.path.endsWith("/rows")),
  };
}
const response = (status, body = {}, headers = {}) => ({
  getResponseCode: () => status,
  getContentText: () => JSON.stringify(body),
  getHeaders: () => headers,
});
const count = async (table) =>
  (await sql(`select count(*)::int n from ${table}`))[0].n;
const overview = async () =>
  (await api("GET", "/integrations/sheets")).body.sources;

describe("the Google Apps Script", () => {
  it("imports three Sheets into three files, then only what is new, whatever the column order", async () => {
    const { key } = await configure(["Ad 1", "Ad 2", "Ad 3"]);
    const books = {
      [spreadsheet(0)]: {
        Sheet1: sheet([submission(101), submission(102), submission(103)]),
      },
      [spreadsheet(1)]: { Sheet1: sheet([submission(201), submission(202)]) },
      [spreadsheet(2)]: { Sheet1: sheet([submission(301), submission(302)]) },
    };
    const script = appsScript(books, key);
    const first = script.run();
    expect(first).toContain(
      '"Ad 1": 3 rows, 3 sent: 3 new leads, 0 repeat inquiries, 0 rejected, 0 failed',
    );
    expect(first).toContain("Sync finished");
    expect(await count("leads")).toBe(7);
    expect(
      await sql(
        "select s.name,f.file_name,f.imported_count from sheet_sources s join lead_imports f on f.id=s.import_id order by s.name",
      ),
    ).toEqual([
      { name: "Ad 1", file_name: "Ad 1", imported_count: 3 },
      { name: "Ad 2", file_name: "Ad 2", imported_count: 2 },
      { name: "Ad 3", file_name: "Ad 3", imported_count: 2 },
    ]);
    // Nothing new: the CRM is asked, and no row is sent.
    script.run();
    expect(script.rowRequests()).toEqual([]);
    expect(
      script.requests.filter((r) => r.path.endsWith("/pending")),
    ).toHaveLength(3);
    // New rows at the bottom of one Sheet.
    books[spreadsheet(1)].Sheet1.push(
      ...sheet([submission(203), submission(204)]).slice(1),
    );
    script.run();
    expect(
      script.rowRequests().map((r) => r.body.rows.map((row) => row.row)),
    ).toEqual([[4, 5]]);
    // Someone reorders a Sheet's columns and Meta adds a row.
    const reordered = [...headings].reverse();
    books[spreadsheet(2)].Sheet1 = sheet(
      [submission(301), submission(302), submission(303)],
      reordered,
    );
    script.run();
    expect(
      script.rowRequests().map((r) => r.body.rows.map((row) => row.row)),
    ).toEqual([[4]]);
    expect(await count("leads")).toBe(10);
    expect(await count("crm_private.sheet_lead_receipts")).toBe(10);
    expect(
      (
        await sql(
          "select count(distinct phone)::int n from crm_private.lead_phones",
        )
      )[0].n,
    ).toBe(10);
    const lead = (
      await sql(
        "select l.name,l.source,i.platform,i.interest,i.budget,i.ad_name,i.is_organic from leads l join crm_private.sheet_lead_inquiries i on i.lead_id=l.id where l.name='Buyer 303'",
      )
    )[0];
    expect(lead).toEqual({
      name: "Buyer 303",
      source: "Meta",
      platform: "instagram",
      interest: "residential_plot",
      budget: "1_crore_to_2_crore",
      ad_name: "Advertisement 3",
      is_organic: false,
    });
    // The logs name Sheets and counts, never a customer or the key.
    const logs = script.logs.join("\n") + first;
    expect(logs).not.toMatch(/Buyer|\+92|9230|@example|hdcrm_sheets_/);
  });

  it("rejects bad rows, imports them once fixed, and forgets rows removed from the Sheet", async () => {
    const { key } = await configure(["Ad 1"]);
    const rows = [
      submission(1),
      submission(2, { phone_number: "" }),
      submission(3, { full_name: "" }),
      // A phone number typed as a number that lost its leading zero.
      submission(4, { phone_number: 3011112222 }),
    ];
    const books = { [spreadsheet(0)]: { Sheet1: sheet(rows) } };
    const script = appsScript(books, key);
    const log = script.run();
    expect(log).toContain(
      "2 new leads, 0 repeat inquiries, 2 rejected, 0 failed",
    );
    expect(log).toContain("rejected rows 3 (phone_missing), 4 (name_missing)");
    expect(
      await sql("select phone from crm_private.lead_phones order by phone"),
    ).toEqual([{ phone: "+923010000001" }, { phone: "+923011112222" }]);
    expect((await overview())[0]).toMatchObject({ new_leads: 2, rejected: 2 });
    // Row 3 is fixed and row 4 deleted.
    books[spreadsheet(0)].Sheet1 = sheet([rows[0], submission(2), rows[3]]);
    expect(script.run()).toContain(
      "1 new leads, 0 repeat inquiries, 0 rejected, 0 failed",
    );
    expect((await overview())[0]).toMatchObject({
      new_leads: 3,
      rejected: 0,
      sheet_rows: 3,
      last_error_code: null,
    });
  });

  it("recovers from a lost reply, a busy CRM and a CRM that is down, without a duplicate", async () => {
    const { key } = await configure(["Ad 1"]);
    const books = {
      [spreadsheet(0)]: {
        Sheet1: sheet([1, 2, 3, 4, 5].map((n) => submission(n))),
      },
    };
    // The CRM saves the batch but the reply never arrives.
    let lost = false;
    const script = appsScript(books, key, (path, forward) => {
      if (path.endsWith("/rows") && !lost) {
        lost = true;
        forward();
        throw new Error("Timeout");
      }
      return forward();
    });
    script.context.SYNC.rowsPerRequest = 2;
    const log = script.run();
    expect(log).toContain(
      "3 new leads, 0 repeat inquiries, 0 rejected, 0 failed, 2 already imported",
    );
    expect(await count("leads")).toBe(5);
    expect(script.sleeps).toHaveLength(1);
    // Busy (429 with Retry-After), then a server error, then through.
    let refusals = 0;
    books[spreadsheet(0)].Sheet1.push(...sheet([submission(6)]).slice(1));
    const busy = appsScript(books, key, (path, forward) => {
      if (path.endsWith("/pending") && refusals < 2)
        return ++refusals === 1
          ? response(429, { error: "Too many" }, { "Retry-After": "7" })
          : response(503, { error: "Request failed" });
      return forward();
    });
    expect(busy.run()).toContain("1 new leads");
    expect(busy.sleeps[0]).toBeGreaterThanOrEqual(7000);
    expect(busy.sleeps[0]).toBeLessThan(8000);
    expect(busy.sleeps).toHaveLength(2);
    // The CRM cannot be reached at all: nothing is lost, the next run imports.
    books[spreadsheet(0)].Sheet1.push(...sheet([submission(7)]).slice(1));
    const down = appsScript(books, key, () => {
      throw new Error("DNS error");
    });
    expect(down.run()).toContain("Sync stopped: The CRM could not be reached.");
    expect(await count("leads")).toBe(6);
    expect(appsScript(books, key).run()).toContain("1 new leads");
    expect(await count("leads")).toBe(7);
    expect(await count("crm_private.sheet_lead_receipts")).toBe(7);
  });

  it("stops at its time limit and continues on the next run", async () => {
    const { key } = await configure(["Ad 1"]);
    const books = {
      [spreadsheet(0)]: {
        Sheet1: sheet([1, 2, 3, 4].map((n) => submission(n))),
      },
    };
    let script;
    script = appsScript(books, key, (path, forward) => {
      const answer = forward();
      if (path.endsWith("/rows")) script.context.SYNC.timeBudgetMs = -1;
      return answer;
    });
    script.context.SYNC.rowsPerRequest = 2;
    expect(script.run()).toContain("continues on the next run");
    expect(await count("leads")).toBe(2);
    expect(script.requests.at(-1)).toMatchObject({
      path: expect.stringMatching(/\/report$/),
      body: { ok: true, complete: false },
    });
    expect(appsScript(books, key).run()).toContain("2 new leads");
    expect(await count("leads")).toBe(4);
  });

  it("takes a fourth Sheet from the CRM and reports Sheets it cannot use", async () => {
    const { key } = await configure(["Ad 1", "Ad 2", "Ad 3"]);
    const books = {
      [spreadsheet(0)]: { Sheet1: sheet([submission(1)]) },
      // Ad 2's spreadsheet is not shared with the script; Ad 3 has no tab
      // "Sheet1".
      [spreadsheet(2)]: { Leads: sheet([submission(3)]) },
      [spreadsheet(3)]: { Sheet1: sheet([submission(4)]) },
      [spreadsheet(4)]: {
        Sheet1: [
          ["Customer", "Number"],
          ["Someone", "03001234567"],
        ],
      },
    };
    for (const [name, n] of [
      ["Ad 4", 3],
      ["Ad 5", 4],
    ])
      await api("POST", "/integrations/sheets/sources", {
        name,
        spreadsheet: spreadsheet(n),
        worksheet: "Sheet1",
        enabled: true,
        confirm_history: true,
      });
    const log = appsScript(books, key).run();
    expect(log).toContain('"Ad 2": the spreadsheet could not be opened');
    expect(log).toContain('"Ad 3": the spreadsheet has no tab named "Sheet1"');
    expect(log).toContain(
      '"Ad 5": the first row needs the columns id, phone_number, full_name.',
    );
    expect(log).toContain('"Ad 4": 1 rows, 1 sent: 1 new leads');
    expect(
      (await overview()).map((s) => [s.name, s.last_error_code, s.new_leads]),
    ).toEqual([
      ["Ad 1", null, 1],
      ["Ad 2", "spreadsheet_unavailable", 0],
      ["Ad 3", "worksheet_missing", 0],
      ["Ad 4", null, 1],
      ["Ad 5", "headers_missing", 0],
    ]);
    // The tab name is corrected in the CRM.
    const ad3 = (await overview())[2].id;
    await api("PATCH", `/integrations/sheets/sources/${ad3}`, {
      worksheet: "Leads",
    });
    expect(appsScript(books, key).run()).toContain(
      '"Ad 3": 1 rows, 1 sent: 1 new leads',
    );
  });

  it("stops on a refused key, runs one at a time and installs one five-minute trigger", async () => {
    const { key } = await configure(["Ad 1"]);
    const books = { [spreadsheet(0)]: { Sheet1: sheet([submission(1)]) } };
    await api("DELETE", "/integrations/sheets/key");
    const refused = appsScript(books, key);
    expect(refused.run()).toContain(
      "Sync stopped: Invalid integration key. (HTTP 401)",
    );
    expect(refused.requests).toHaveLength(1);
    expect(await count("leads")).toBe(0);
    // Settings that would send the key without HTTPS are refused.
    const plain = appsScript(books, key);
    plain.properties.CRM_BASE_URL = "http://crm.example.test";
    expect(() => plain.run()).toThrow("CRM_BASE_URL");
    expect(plain.requests).toEqual([]);
    // A run while another holds the lock does nothing.
    const busy = appsScript(books, key);
    busy.hold();
    expect(busy.run()).toBe(
      "Another sync is still running; this run was skipped.",
    );
    expect(busy.requests).toEqual([]);
    const script = appsScript(books, key);
    script.context.installTrigger();
    script.context.installTrigger();
    expect(
      script.triggers.map((t) => [t.getHandlerFunction(), t.minutes]),
    ).toEqual([["syncLeads", 5]]);
    script.context.removeTrigger();
    expect(script.triggers).toEqual([]);
  });

  it("checks its setup without importing", async () => {
    const { key } = await configure(["Ad 1"]);
    const script = appsScript(
      { [spreadsheet(0)]: { Sheet1: sheet([submission(1), submission(2)]) } },
      key,
    );
    script.context.checkSetup();
    expect(script.logs).toEqual([
      "The CRM accepted the key. Sheets turned on: 1",
      '"Ad 1": 2 rows; the columns the CRM needs are there',
    ]);
    expect(await count("leads")).toBe(0);
  });
});
