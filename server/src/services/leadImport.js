import { extname } from "node:path";
import { parse } from "csv-parse/sync";
import { read, utils } from "xlsx";
import { z } from "zod";

const MAX_ROWS = 1000;
const columns = new Set([
  "name",
  "phone",
  "email",
  "budget_min",
  "budget_max",
  "preferred_location",
  "property_id",
  "assigned_agent",
  "source",
]);
const headerKey = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
const headerAliases = new Map(
  Object.entries({
    name: [
      "name",
      "full name",
      "customer name",
      "client name",
      "lead name",
      "contact name",
      "buyer name",
    ],
    phone: [
      "phone",
      "phone number",
      "phone no",
      "mobile",
      "mobile number",
      "mobile no",
      "mobile phone",
      "contact number",
      "contact no",
      "contact phone",
      "telephone",
      "telephone number",
      "cell number",
      "whatsapp number",
    ],
    email: ["email", "email address", "customer email", "client email"],
    budget_min: [
      "budget min",
      "minimum budget",
      "min budget",
      "budget from",
      "budget min pkr",
      "minimum budget pkr",
    ],
    budget_max: [
      "budget max",
      "maximum budget",
      "max budget",
      "budget to",
      "budget max pkr",
      "maximum budget pkr",
    ],
    preferred_location: [
      "preferred location",
      "location",
      "preferred city",
      "preferred area",
    ],
    property_id: ["property id"],
    assigned_agent: [
      "assigned agent",
      "assigned agent id",
      "agent id",
      "agent name",
      "assigned agent name",
    ],
    source: ["source", "lead source"],
  }).flatMap(([field, names]) => names.map((name) => [headerKey(name), field])),
);
const mappingSchema = z
  .object(
    Object.fromEntries(
      [...columns].map((field) => [
        field,
        z.number().int().min(0).max(31).optional(),
      ]),
    ),
  )
  .strict()
  .required({ name: true, phone: true });
const invalid = (message) => Object.assign(new Error(message), { status: 400 });
const rowLimit = () => invalid("Maximum 1,000 lead rows per import");
const blank = (cell) =>
  !cell?.f && (cell?.v == null || String(cell.v).trim() === "");

function csvRecords(buffer) {
  try {
    return parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer), {
      bom: true,
      trim: true,
      skip_empty_lines: true,
      info: true,
    }).map(({ record, info }) => ({
      row: info.lines,
      cells: record.map((v) => ({ t: "s", v })),
    }));
  } catch {
    throw invalid("Invalid CSV. Use a UTF-8 CSV with a header row.");
  }
}

function excelRecords(buffer, format) {
  const zip = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 3, 4]));
  const compound = buffer
    .subarray(0, 8)
    .equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const legacyBiff = buffer[0] === 9 && [0, 2, 4, 8].includes(buffer[1]);
  if (format === "xlsx" ? !zip : !(compound || legacyBiff))
    throw invalid("Invalid Excel file. Save it as .xlsx or .xls in Excel.");

  let book;
  try {
    book = read(buffer, {
      type: "buffer",
      sheets: 0,
      // Include an extra row to detect excess data before writing any leads.
      sheetRows: MAX_ROWS + 2,
      cellFormula: true,
      cellHTML: false,
      cellText: true,
      bookVBA: false,
      WTF: true,
    });
  } catch {
    throw invalid(
      "Could not read Excel file. Save an unencrypted .xlsx or .xls file and try again.",
    );
  }
  const worksheet = book.SheetNames?.[0];
  const sheet = book.Sheets?.[worksheet];
  if (!sheet?.["!ref"])
    throw invalid("The first worksheet is empty. Add lead headers and rows.");
  const range = utils.decode_range(sheet["!fullref"] || sheet["!ref"]);
  if (range.e.r > MAX_ROWS) throw rowLimit();
  // Bound sparse ranges as well as the actual parsed cells.
  if (range.e.c >= 32)
    throw invalid(
      "Remove extra worksheet columns; use supported lead headers.",
    );
  const records = [];
  for (let r = 0; r <= range.e.r; r++) {
    const cells = [];
    for (let c = 0; c <= range.e.c; c++)
      cells.push(sheet[utils.encode_cell({ r, c })]);
    // Row 1 must contain headers; retain physical worksheet row numbers.
    if (r === 0 || !cells.every(blank)) records.push({ row: r + 1, cells });
  }
  return { records, worksheet };
}

function leadRows(records, mapping) {
  const [header, ...recordsWithBlanks] = records;
  if (!header) throw invalid("The file is empty. Add lead headers and rows.");
  const labels = header.cells.map((cell) => {
    if (cell?.f || (cell?.v != null && cell.t !== "s"))
      throw invalid("Use plain text column names in the header row.");
    return String(cell?.v ?? "").trim();
  });
  while (
    labels.length &&
    !labels.at(-1) &&
    recordsWithBlanks.every(({ cells }) => blank(cells[labels.length - 1]))
  )
    labels.pop();
  if (!labels.length)
    throw invalid("The header row must include name and phone columns.");
  if (labels.length > 32)
    throw invalid("Maximum 32 columns per import. Remove unused columns.");

  const importColumns = labels.map((label, index) => ({
    index,
    label:
      label.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 80) ||
      `Column ${utils.encode_col(index)} (no header)`,
    suggested: headerAliases.get(headerKey(label)) || null,
  }));
  const matchColumns = (message) =>
    Object.assign(invalid(message), {
      code: "IMPORT_COLUMNS_REQUIRED",
      columns: importColumns,
    });
  let headers = importColumns.map(({ suggested }) => suggested);
  if (mapping !== undefined) {
    let selected;
    try {
      selected = mappingSchema.parse(
        typeof mapping === "string" ? JSON.parse(mapping) : mapping,
      );
    } catch {
      throw invalid(
        "Invalid column mapping. Match name and phone to file columns.",
      );
    }
    const indices = Object.values(selected);
    if (
      new Set(indices).size !== indices.length ||
      indices.some((index) => index >= labels.length)
    )
      throw invalid(
        "Choose a different existing file column for each CRM field.",
      );
    headers = labels.map(() => null);
    for (const [field, index] of Object.entries(selected))
      headers[index] = field;
  } else {
    if (!headers.includes("name") || !headers.includes("phone"))
      throw matchColumns(
        "The header row must include name and phone columns. Match your file columns to continue.",
      );
    if (headers.some((name) => !name))
      throw matchColumns(
        "Unsupported column name. Match the extra columns or choose Skip column.",
      );
    if (new Set(headers).size !== headers.length)
      throw matchColumns(
        "Repeated column names need matching. Choose which column to import.",
      );
  }

  const recordsToImport = recordsWithBlanks.filter(
    ({ cells }) => !cells.every(blank),
  );
  if (!recordsToImport.length) throw invalid("The file contains no lead rows.");
  if (recordsToImport.length > MAX_ROWS) throw rowLimit();
  const ignoredColumns = importColumns
    .filter(({ index }) => !headers[index])
    .map(({ label }) => label);
  const rows = recordsToImport.map(({ row, cells }) => {
    const data = {};
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c];
      if (!key) continue;
      const cell = cells[c];
      if (cell?.f)
        return { row, error: "Replace formulas with values before importing." };
      if (blank(cell)) continue;
      if (!["s", "n"].includes(cell.t))
        return { row, error: "Invalid cell value. Use text or numbers." };
      let value = cell.v;
      if (key === "phone" && cell.t === "n") {
        // Preserve zero padding from Excel's phone format. Raw numeric phones
        // need a country code; a missing leading zero cannot be recovered safely.
        const formatted = String(cell.w ?? "").trim();
        value = /^0[\d\s()+.-]+$/.test(formatted) ? formatted : String(value);
        if (
          !Number.isSafeInteger(cell.v) ||
          (!value.startsWith("0") && String(cell.v).length < 11)
        )
          return {
            row,
            error:
              "Format phone cells as Text and include leading zeros or country codes.",
          };
      }
      data[key] =
        key === "budget_min" || key === "budget_max"
          ? value
          : String(value).trim();
    }
    // The existing database source category covers all spreadsheet imports.
    return { row, data: { ...data, source: "CSV" } };
  });
  return { rows, ignoredColumns };
}

export function parseLeadImport(file, mapping) {
  if (!file) throw invalid("Choose a CSV, XLSX or XLS file.");
  const format = extname(file.originalname || "")
    .slice(1)
    .toLowerCase();
  if (!["csv", "xlsx", "xls"].includes(format))
    throw invalid("Choose a .csv, .xlsx or .xls file.");
  if (!file.buffer?.length) throw invalid("The file is empty.");
  const { records, worksheet = null } =
    format === "csv"
      ? { records: csvRecords(file.buffer) }
      : excelRecords(file.buffer, format);
  try {
    return { format, worksheet, ...leadRows(records, mapping) };
  } catch (error) {
    if (error.code === "IMPORT_COLUMNS_REQUIRED")
      Object.assign(error, { format, worksheet });
    throw error;
  }
}

const agentKey = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
const emptyAgent = (value) =>
  [
    "",
    "unassigned",
    "not assigned",
    "none",
    "n/a",
    "na",
    "null",
    "-",
    "—",
  ].includes(agentKey(value));

export async function resolveImportAgents(db, rows) {
  const needsAgents = rows.some(
    (row) => row.data && !emptyAgent(row.data.assigned_agent),
  );
  let agents = [];
  if (needsAgents) {
    try {
      const result = await db
        .from("profiles")
        .select("id,name,role,active")
        .eq("role", "agent")
        .eq("active", true);
      if (result.error || !Array.isArray(result.data)) throw new Error();
      agents = result.data.filter(
        (agent) => agent.role === "agent" && agent.active === true,
      );
    } catch {
      throw Object.assign(
        new Error(
          "Could not load active agents. No leads were imported; please try again.",
        ),
        { status: 503 },
      );
    }
  }
  const byId = new Map(agents.map((agent) => [agent.id.toLowerCase(), agent]));
  const byName = new Map();
  for (const agent of agents) {
    const key = agentKey(agent.name);
    if (key) byName.set(key, [...(byName.get(key) || []), agent]);
  }
  return rows.map((row) => {
    if (!row.data || row.data.assigned_agent == null) return row;
    const { assigned_agent: reference, ...data } = row.data;
    if (emptyAgent(reference)) return { ...row, data };
    const key = agentKey(reference);
    const matches = z.string().uuid().safeParse(key).success
      ? byId.has(key)
        ? [byId.get(key)]
        : []
      : byName.get(key) || [];
    if (matches.length === 1)
      return { ...row, data: { ...data, assigned_agent: matches[0].id } };
    return {
      ...row,
      data,
      warnings: [
        ...(row.warnings || []),
        matches.length > 1
          ? "Agent name matches multiple active agents; lead left unassigned. Assign it from Leads."
          : "Agent was not found among active agents; lead left unassigned. Assign it from Leads.",
      ],
    };
  });
}

export function importValidationMessage(error) {
  const messages = {
    name: "Name is required and must contain 1–200 characters.",
    phone:
      "Phone is required. Use a phone number with a leading zero or international country code, not a placeholder.",
    email: "Email must be a valid email address or blank.",
    budget_min:
      "Minimum budget must be a number between 0 and 10,000,000,000,000.",
    budget_max:
      "Maximum budget must be a number between 0 and 10,000,000,000,000.",
    property_id:
      "Property ID must be a CRM property UUID, or leave the column unmatched.",
    assigned_agent: "Agent must match an active team member's name or CRM ID.",
    preferred_location:
      "Preferred location must contain no more than 4,000 characters.",
  };
  return [
    ...new Set(
      error.issues.map(
        (issue) =>
          messages[issue.path[0]] ||
          (issue.code === "custom"
            ? "Maximum budget must be greater than or equal to minimum budget."
            : "Check the matched lead fields."),
      ),
    ),
  ].join(" ");
}
