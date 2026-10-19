import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { utils, write } from "xlsx";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import {
  parseLeadImport,
  resolveImportAgents,
} from "../src/services/leadImport.js";

const admin = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Import administrator",
  role: "admin",
  active: true,
};
const leadId = "20000000-0000-4000-8000-000000000001";
const defaultRows = [
  ["name", "phone"],
  ["Test buyer", "03001234567"],
];
function workbook(rows = defaultRows, bookType = "xlsx", configure) {
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet(rows), "Leads");
  configure?.(book);
  return write(book, { type: "buffer", bookType });
}
const csv = (text) => ({
  originalname: "leads.csv",
  buffer: Buffer.from(text),
});
const excel = (rows = defaultRows, configure) => ({
  originalname: "leads.xlsx",
  buffer: workbook(rows, "xlsx", configure),
});
function dbFake(profile = admin, agents = []) {
  const rpc = vi.fn(async (_, args) => {
    const seen = new Set();
    return {
      data: {
        import_id: "20000000-0000-4000-8000-000000000099",
        rows: args.p_rows.map((row) => {
          if (row.error)
            return { row: row.row, success: false, error: row.error };
          if (seen.has(row.phone))
            return { row: row.row, success: false, error: "Duplicate phone" };
          seen.add(row.phone);
          return {
            row: row.row,
            success: true,
            id: leadId,
            ...(row.warnings ? { warnings: row.warnings } : {}),
          };
        }),
      },
      error: null,
    };
  });
  const loadAgents = vi.fn(async () => ({ data: agents, error: null }));
  return {
    rpc,
    loadAgents,
    auth: {
      getUser: vi.fn(async () => ({
        data: {
          user: { id: admin.id, email_confirmed_at: "2026-10-01T00:00:00Z" },
        },
      })),
    },
    from: vi.fn(() => {
      const query = {
        select: () => query,
        eq: () => query,
        single: async () => ({ data: profile, error: null }),
        then: (resolve, reject) => loadAgents().then(resolve, reject),
      };
      return query;
    }),
  };
}
function upload(db, file, mapping) {
  const req = request(createApp(trustedMfaFixture(db)))
    .post("/api/leads/import")
    .set("Authorization", "Bearer valid");
  if (mapping !== undefined)
    req.field(
      "mapping",
      typeof mapping === "string" ? mapping : JSON.stringify(mapping),
    );
  return file ? req.attach("file", file.buffer, file.originalname) : req;
}

describe("spreadsheet parsing", () => {
  it.each(["xlsx", "biff8"])("reads real %s workbooks", (bookType) => {
    const result = parseLeadImport({
      originalname: bookType === "xlsx" ? "LEADS.XLSX" : "leads.xls",
      buffer: workbook(defaultRows, bookType),
    });
    expect(result).toMatchObject({
      format: bookType === "xlsx" ? "xlsx" : "xls",
      worksheet: "Leads",
      rows: [
        {
          row: 2,
          data: { name: "Test buyer", phone: "03001234567", source: "CSV" },
        },
      ],
    });
  });
  it("preserves UTF-8 CSV, quoted values, blank lines and original line numbers", () => {
    const result = parseLeadImport(
      csv(
        '\uFEFFName,Phone,Preferred location\r\n\r\n"Buyer, Example",03001234567,"Lahore, DHA"\r\nاحمد,03001234568,اسلام آباد\r\n',
      ),
    );
    expect(result.rows).toEqual([
      {
        row: 3,
        data: {
          name: "Buyer, Example",
          phone: "03001234567",
          preferred_location: "Lahore, DHA",
          source: "CSV",
        },
      },
      {
        row: 4,
        data: {
          name: "احمد",
          phone: "03001234568",
          preferred_location: "اسلام آباد",
          source: "CSV",
        },
      },
    ]);
  });
  it("uses raw numeric budgets, zero-padded phones, and omits blank optional IDs", () => {
    const result = parseLeadImport(
      excel(
        [
          [
            "Name",
            "Phone",
            "Budget min",
            "Budget max",
            "property_id",
            "assigned_agent",
          ],
          ["Buyer", 3001234567, 2500000, null, "", ""],
          ["International buyer", 923001234568, 1000000],
        ],
        (book) => {
          book.Sheets.Leads.B2.z = "00000000000";
          book.Sheets.Leads.C2.z = '"PKR "#,##0';
        },
      ),
    );
    expect(result.rows[0]).toEqual({
      row: 2,
      data: {
        name: "Buyer",
        phone: "03001234567",
        budget_min: 2500000,
        source: "CSV",
      },
    });
    expect(result.rows[1].data.phone).toBe("923001234568");
  });
  it("rejects a numeric phone that has lost its leading zero", () => {
    const result = parseLeadImport(
      excel([
        ["name", "phone"],
        ["Buyer", 3001234567],
      ]),
    );
    expect(result.rows[0]).toEqual({
      row: 2,
      error: expect.stringContaining("Format phone cells as Text"),
    });
    expect(result.rows[0]).not.toHaveProperty("data");
  });
  it("imports only the first worksheet and retains row numbers after empty rows", () => {
    const result = parseLeadImport(
      excel(
        [["name", "phone"], [], ["First-sheet buyer", "03001234567"]],
        (book) =>
          utils.book_append_sheet(
            book,
            utils.aoa_to_sheet([["unrelated"], ["ignore me"]]),
            "Other data",
          ),
      ),
    );
    expect(result.worksheet).toBe("Leads");
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].row).toBe(3);
    expect(result.rows[0].data.name).toBe("First-sheet buyer");
  });
  it("rejects cached formula values instead of importing them", () => {
    const result = parseLeadImport(
      excel(defaultRows, (book) => {
        book.Sheets.Leads.A2 = {
          t: "s",
          f: '"Formula buyer"',
          v: "Formula buyer",
        };
      }),
    );
    expect(result.rows[0]).toEqual({
      row: 2,
      error: "Replace formulas with values before importing.",
    });
  });
  it.each([
    ["name,email\nBuyer,buyer@example.com", /name and phone/],
    ["name,phone,Phone\nBuyer,03001234567,03001234568", /Repeated/],
    ["name,phone,role\nBuyer,03001234567,admin", /Unsupported/],
    ["name,phone\n", /no lead rows/],
    ["name,phone\nBuyer", /Invalid CSV/],
    ['name,phone\n"unterminated,03001234567', /Invalid CSV/],
  ])(
    "rejects invalid headers or CSV structure before importing",
    (text, message) => {
      expect(() => parseLeadImport(csv(text))).toThrow(message);
    },
  );
  it.each(["xlsx", "xls", "pdf"])(
    "refuses renamed text and unsupported .%s files",
    (format) => {
      expect(() =>
        parseLeadImport({
          ...csv("name,phone\nBuyer,03001234567"),
          originalname: `leads.${format}`,
        }),
      ).toThrow(/Excel file|Choose a/);
    },
  );
  it("handles corrupt, empty and headerless Excel files with safe errors", () => {
    expect(() =>
      parseLeadImport({
        originalname: "leads.xlsx",
        buffer: Buffer.from([0x50, 0x4b, 3, 4, 0]),
      }),
    ).toThrow(/Could not read/);
    expect(() => parseLeadImport(excel([]))).toThrow(
      /first worksheet is empty/,
    );
    expect(() =>
      parseLeadImport(excel([[], ["name", "phone"], ["Buyer", "03001234567"]])),
    ).toThrow(/header row/);
    expect(() =>
      parseLeadImport(
        excel([
          ["name", "phone", ""],
          ["Buyer", "03001234567", "no header"],
        ]),
      ),
    ).toThrow(/Unsupported column/);
  });
  it.each(["csv", "xlsx", "xls"])(
    "rejects more than 1,000 rows in %s",
    (format) => {
      const rows = [
        ["name", "phone"],
        ...Array.from({ length: 1001 }, () => ["Buyer", "03001234567"]),
      ];
      const file =
        format === "csv"
          ? csv(rows.map((row) => row.join(",")).join("\n"))
          : {
              originalname: `leads.${format}`,
              buffer: workbook(rows, format === "xls" ? "biff8" : "xlsx"),
            };
      expect(() => parseLeadImport(file)).toThrow(/Maximum 1,000/);
    },
  );
  it("accepts exactly 1,000 leads and rejects excessive sparse ranges", () => {
    const rows = [
      ["name", "phone"],
      ...Array.from({ length: 1000 }, () => ["Buyer", "03001234567"]),
    ];
    expect(parseLeadImport(excel(rows)).rows).toHaveLength(1000);
    expect(() =>
      parseLeadImport(
        excel(defaultRows, (book) => {
          book.Sheets.Leads["!ref"] = "A1:XFD2";
        }),
      ),
    ).toThrow(/extra worksheet columns/);
  });
  it.each(["csv", "xlsx", "xls"])(
    "matches common human headings in %s",
    (format) => {
      const rows = [
        [
          "Full Name",
          "Mobile Number",
          "E-mail Address",
          "Min. Budget",
          "Max Budget",
          "Preferred City",
        ],
        [
          "Buyer",
          "03001234567",
          "buyer@example.com",
          1000000,
          2000000,
          "Lahore",
        ],
      ];
      const file =
        format === "csv"
          ? csv(rows.map((row) => row.join(",")).join("\n"))
          : {
              originalname: `leads.${format}`,
              buffer: workbook(rows, format === "xls" ? "biff8" : "xlsx"),
            };
      const result = parseLeadImport(file);
      expect(result.rows[0].data).toEqual({
        name: "Buyer",
        phone: "03001234567",
        email: "buyer@example.com",
        budget_min: format === "csv" ? "1000000" : 1000000,
        budget_max: format === "csv" ? "2000000" : 2000000,
        preferred_location: "Lahore",
        source: "CSV",
      });
      expect(result.ignoredColumns).toEqual([]);
    },
  );
  it("requires an explicit choice when aliases would map two columns to the same field", () => {
    const file = csv("Name,Full Name,Phone\nShort,Full buyer,03001234567");
    expect(() => parseLeadImport(file)).toThrow(/Repeated/);
    const result = parseLeadImport(file, { name: 1, phone: 2 });
    expect(result.rows[0].data.name).toBe("Full buyer");
    expect(result.ignoredColumns).toEqual(["Name"]);
  });
  it("maps unusual and blank headings by column index without importing skipped formulas or privileged fields", () => {
    const file = excel(
      [
        ["Purchaser", "", "role", "Internal calculation"],
        ["Buyer", "03001234567", "admin", 50],
      ],
      (book) => {
        book.Sheets.Leads.D2.f = "25*2";
      },
    );
    const result = parseLeadImport(file, { name: 0, phone: 1 });
    expect(result.rows[0].data).toEqual({
      name: "Buyer",
      phone: "03001234567",
      source: "CSV",
    });
    expect(result.ignoredColumns).toEqual(["role", "Internal calculation"]);
    const formulaSelected = parseLeadImport(file, {
      name: 0,
      phone: 1,
      budget_min: 3,
    });
    expect(formulaSelected.rows[0].error).toContain("Replace formulas");
  });
  it.each([
    {},
    { name: 0 },
    { name: 0, phone: 0 },
    { name: 0, phone: 4 },
    { name: 0, phone: -1 },
    { name: 0, phone: "1" },
    { name: 0, phone: 1.5 },
    { name: 0, phone: 1, role: 2 },
    "invalid JSON",
    "null",
    "[]",
  ])("refuses an invalid or unsafe explicit mapping %j", (mapping) => {
    expect(() =>
      parseLeadImport(csv("Name,Phone,role\nBuyer,03001234567,admin"), mapping),
    ).toThrow(/mapping|different existing/);
  });
});

describe("import agent references", () => {
  const activeAgent = {
    id: "30000000-0000-4000-8000-000000000001",
    name: "Example Agent",
    role: "agent",
    active: true,
  };
  const row = (assigned_agent) => ({
    row: 2,
    data: {
      name: "Buyer",
      phone: "03001234567",
      source: "CSV",
      assigned_agent,
    },
  });
  it("resolves exact names and UUIDs using one active-agent lookup for the file", async () => {
    const db = dbFake(admin, [activeAgent]);
    const resolved = await resolveImportAgents(db, [
      row(" example   AGENT "),
      row(activeAgent.id),
      row(activeAgent.id.toUpperCase()),
    ]);
    expect(resolved.map((r) => r.data.assigned_agent)).toEqual([
      activeAgent.id,
      activeAgent.id,
      activeAgent.id,
    ]);
    expect(resolved.every((r) => !r.warnings)).toBe(true);
    expect(db.loadAgents).toHaveBeenCalledOnce();
  });
  it.each(["Unknown Agent", "30000000-0000-4000-8000-000000000099"])(
    "imports without assigning an unknown agent reference %s",
    async (reference) => {
      const result = (
        await resolveImportAgents(dbFake(admin, [activeAgent]), [
          row(reference),
        ])
      )[0];
      expect(result.data).not.toHaveProperty("assigned_agent");
      expect(result.warnings[0]).toContain("not found among active agents");
      expect(result.warnings[0]).not.toContain(reference);
    },
  );
  it("does not guess between duplicate active names or assign admin/disabled profiles", async () => {
    const db = dbFake(admin, [
      activeAgent,
      { ...activeAgent, id: "30000000-0000-4000-8000-000000000002" },
      {
        ...activeAgent,
        id: "30000000-0000-4000-8000-000000000003",
        name: "Disabled Agent",
        active: false,
      },
      { ...admin, name: "Admin Person" },
    ]);
    const resolved = await resolveImportAgents(db, [
      row("Example Agent"),
      row("Disabled Agent"),
      row("Admin Person"),
    ]);
    expect(resolved.every((r) => !r.data.assigned_agent)).toBe(true);
    expect(resolved[0].warnings[0]).toContain("multiple active agents");
    expect(
      resolved.slice(1).every((r) => r.warnings[0].includes("not found")),
    ).toBe(true);
  });
  it("accepts explicit unassigned placeholders without looking up profiles", async () => {
    const db = dbFake();
    const resolved = await resolveImportAgents(db, [
      row("Unassigned"),
      row("N/A"),
      row(""),
      { row: 5, error: "Invalid phone cell" },
    ]);
    expect(
      resolved.slice(0, 3).every((r) => !r.data.assigned_agent && !r.warnings),
    ).toBe(true);
    expect(resolved[3].error).toBe("Invalid phone cell");
    expect(db.loadAgents).not.toHaveBeenCalled();
  });
});

describe("lead import API", () => {
  it.each(["csv", "xlsx", "xls"])(
    "accepts agent names and PKR budget headings in %s without rejecting the rows",
    async (format) => {
      const agent = {
        id: "30000000-0000-4000-8000-000000000001",
        name: "Example Agent",
        role: "agent",
        active: true,
      };
      const db = dbFake(admin, [agent]);
      const rows = [
        ["Name", "Phone", "assigned_agent", "budget_min_pkr", "budget_max_pkr"],
        ["Matched buyer", "03001234567", "Example Agent", 1000000, 2000000],
        ["Unassigned buyer", "03001234568", "Missing Agent", 3000000, 4000000],
      ];
      const file =
        format === "csv"
          ? csv(rows.map((r) => r.join(",")).join("\n"))
          : {
              originalname: `leads.${format}`,
              buffer: workbook(rows, format === "xls" ? "biff8" : "xlsx"),
            };
      const response = await upload(db, file);
      expect(response.status).toBe(200);
      expect(response.body.rows.every((r) => r.success)).toBe(true);
      expect(response.body.rows[0]).not.toHaveProperty("warnings");
      expect(response.body.rows[1].warnings[0]).toContain(
        "lead left unassigned",
      );
      expect(db.rpc.mock.calls[0][1].p_rows[0].data).toEqual({
        name: "Matched buyer",
        source: "CSV",
        assigned_agent: agent.id,
        budget_min: 1000000,
        budget_max: 2000000,
      });
      expect(db.rpc.mock.calls[0][1].p_rows[1].data).toEqual({
        name: "Unassigned buyer",
        source: "CSV",
        budget_min: 3000000,
        budget_max: 4000000,
      });
      expect(JSON.stringify(response.body)).not.toMatch(
        /03001234567|Missing Agent/,
      );
      expect(db.loadAgents).toHaveBeenCalledOnce();
    },
  );
  it("identifies 100 placeholder phone failures precisely and never invents callable numbers", async () => {
    const db = dbFake();
    const rows = [
      ["name", "phone", "assigned_agent"],
      ...Array.from({ length: 100 }, (_, i) => [
        `Buyer ${i}`,
        `TEST-PHONE-${String(i + 1).padStart(4, "0")}`,
        "Example Agent",
      ]),
    ];
    const response = await upload(db, excel(rows));
    expect(response.status).toBe(200);
    expect(response.body.rows).toHaveLength(100);
    expect(
      response.body.rows.every(
        (r) => !r.success && r.error.includes("Replace text placeholders"),
      ),
    ).toBe(true);
    expect(
      db.rpc.mock.calls[0][1].p_rows.every((row) => row.error && !row.phone),
    ).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("TEST-PHONE-");
  });
  it("reports the invalid field without echoing its private value", async () => {
    const db = dbFake();
    const response = await upload(
      db,
      excel([
        ["name", "phone", "email", "property_id", "budget_min", "budget_max"],
        [
          "Private buyer",
          "03001234567",
          "private-invalid-email",
          "private-invalid-id",
          0,
          2,
        ],
        ["Budget buyer", "03001234568", "", "", 200, 100],
      ]),
    );
    expect(response.body.rows[0].error).toContain(
      "Email must be a valid email address",
    );
    expect(response.body.rows[0].error).toContain(
      "Property ID must be a CRM property UUID",
    );
    expect(response.body.rows[1].error).toContain(
      "Maximum budget must be greater than or equal to minimum budget",
    );
    expect(JSON.stringify(response.body)).not.toMatch(
      /private-invalid|0300123456/,
    );
    expect(
      db.rpc.mock.calls[0][1].p_rows.every((row) => row.error && !row.phone),
    ).toBe(true);
  });
  it("fails before any writes if the active-agent lookup is unavailable", async () => {
    const db = dbFake();
    db.loadAgents.mockResolvedValue({
      error: { message: "private database details" },
    });
    const response = await upload(
      db,
      csv("name,phone,assigned_agent\nBuyer,03001234567,Example Agent"),
    );
    expect(response.status).toBe(503);
    expect(response.body.error).toContain("Could not load active agents");
    expect(response.body.error).not.toContain("private database details");
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("returns only header information when extra columns need matching, with no writes", async () => {
    const db = dbFake();
    const response = await upload(
      db,
      csv("Name,Phone,Notes\nPrivate buyer,03001234567,Private note"),
    );
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: "IMPORT_COLUMNS_REQUIRED",
      format: "csv",
      worksheet: null,
      columns: [
        { index: 0, label: "Name", suggested: "name" },
        { index: 1, label: "Phone", suggested: "phone" },
        { index: 2, label: "Notes", suggested: null },
      ],
    });
    expect(JSON.stringify(response.body)).not.toMatch(
      /Private buyer|03001234567|Private note/,
    );
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each(["csv", "xlsx", "xls"])(
    "imports %s after explicit matching and reports skipped columns",
    async (format) => {
      const db = dbFake();
      const rows = [
        ["Buyer", "Telephone #", "Serial No", "role"],
        ["Private buyer", "03001234567", "001", "admin"],
      ];
      const file =
        format === "csv"
          ? csv(rows.map((row) => row.join(",")).join("\n"))
          : {
              originalname: `leads.${format}`,
              buffer: workbook(rows, format === "xls" ? "biff8" : "xlsx"),
            };
      const response = await upload(db, file, { name: 0, phone: 1 });
      expect(response.status).toBe(200);
      expect(response.body.ignored_columns).toEqual(["Serial No", "role"]);
      expect(response.body.rows).toEqual([
        { row: 2, success: true, id: leadId },
      ]);
      expect(db.rpc).toHaveBeenCalledExactlyOnceWith(
        "import_leads",
        expect.objectContaining({
          p_rows: [
            {
              row: 2,
              data: { name: "Private buyer", source: "CSV", budget_min: 0 },
              phone: "+923001234567",
            },
          ],
        }),
      );
      expect(JSON.stringify(response.body)).not.toContain("Private buyer");
    },
  );
  it("rejects an attempted role field in multipart mapping before creating any leads", async () => {
    const db = dbFake();
    const response = await upload(
      db,
      csv("name,phone,role\nBuyer,03001234567,admin"),
      { name: 0, phone: 1, role: 2 },
    );
    expect(response.status).toBe(400);
    expect(response.body.error).toContain("Invalid column mapping");
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it.each(["csv", "xlsx", "xls"])(
    "creates leads through the private transactional RPC for %s",
    async (format) => {
      const db = dbFake();
      const file =
        format === "csv"
          ? csv("name,phone\nTest buyer,03001234567")
          : {
              originalname: `leads.${format}`,
              buffer: workbook(
                defaultRows,
                format === "xls" ? "biff8" : "xlsx",
              ),
            };
      const response = await upload(db, file);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        import_id: "20000000-0000-4000-8000-000000000099",
        file_name: `leads.${format}`,
        format,
        worksheet: format === "csv" ? null : "Leads",
        rows: [{ row: 2, id: leadId, success: true }],
      });
      expect(db.rpc).toHaveBeenCalledExactlyOnceWith("import_leads", {
        p_file_name: `leads.${format}`,
        p_format: format,
        p_worksheet: format === "csv" ? null : "Leads",
        p_rows: [
          {
            row: 2,
            data: { name: "Test buyer", source: "CSV", budget_min: 0 },
            phone: "+923001234567",
          },
        ],
        p_actor: admin.id,
        p_request: expect.any(String),
      });
      expect(JSON.stringify(response.body)).not.toContain("1234567");
    },
  );
  it("keeps valid rows and reports invalid fields, duplicates and formula rows safely", async () => {
    const db = dbFake();
    const response = await upload(
      db,
      excel(
        [
          ["name", "phone", "email"],
          ["Buyer", "03001234567"],
          ["Invalid buyer", "03001234568", "invalid-email"],
          ["Duplicate buyer", "03001234567"],
          ["Formula buyer", "03001234569"],
        ],
        (book) => {
          book.Sheets.Leads.A5.f = '"Formula buyer"';
        },
      ),
    );
    expect(response.status).toBe(200);
    expect(response.body.rows).toEqual([
      { row: 2, success: true, id: leadId },
      {
        row: 3,
        success: false,
        error: "Email must be a valid email address or blank.",
      },
      { row: 4, success: false, error: "Duplicate phone" },
      {
        row: 5,
        success: false,
        error: "Replace formulas with values before importing.",
      },
    ]);
    expect(db.rpc).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(response.body)).not.toContain("03001234567");
  });
  it.each([
    ["agent", true, 403],
    ["admin", false, 403],
  ])(
    "denies %s with active=%s before any database writes",
    async (role, active, status) => {
      const db = dbFake({ ...admin, role, active });
      expect((await upload(db, excel())).status).toBe(status);
      expect(db.rpc).not.toHaveBeenCalled();
    },
  );
  it("denies uploads without authentication", async () => {
    const db = dbFake();
    const response = await request(createApp(trustedMfaFixture(db)))
      .post("/api/leads/import")
      .attach("file", workbook(), "leads.xlsx");
    expect(response.status).toBe(401);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("rejects missing, unsupported and oversized files before writes", async () => {
    const db = dbFake();
    expect((await upload(db)).status).toBe(400);
    expect(
      (
        await upload(db, {
          originalname: "leads.txt",
          buffer: Buffer.from("name,phone\nBuyer,03001234567"),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await upload(db, {
          originalname: "leads.xlsx",
          buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
        })
      ).status,
    ).toBe(413);
    expect(db.rpc).not.toHaveBeenCalled();
  });
  it("rejects bad headers and over-limit workbooks without importing partial data", async () => {
    const db = dbFake();
    expect(
      (
        await upload(
          db,
          excel([
            ["name", "phone", "role"],
            ["Buyer", "03001234567", "admin"],
          ]),
        )
      ).status,
    ).toBe(400);
    const oversized = excel([
      ["name", "phone"],
      ...Array.from({ length: 1001 }, () => ["Buyer", "03001234567"]),
    ]);
    expect((await upload(db, oversized)).status).toBe(400);
    expect(db.rpc).not.toHaveBeenCalled();
  });
});
