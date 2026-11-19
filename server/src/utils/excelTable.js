import { CFB } from "xlsx";
// One worksheet as a plain Excel table, for exports people work in: the
// heading row in bold, kept in view (frozen) with AutoFilter on every
// column; each column as wide as it is given; long text wrapped; data from
// row 2. Values are written as they are: text as text (a column may insist
// on text, for numbers such as IDs), numbers as numbers, blanks as empty
// cells. No cell is ever a formula: the file has no formula element at all.
// SheetJS writes no frozen panes, fonts or wrapping in its free edition, so
// this writes the few XML parts itself and zips them with SheetJS's CFB.
const main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const rel =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const pkg = "http://schemas.openxmlformats.org/package/2006/relationships";
const type = (t) =>
  `application/vnd.openxmlformats-officedocument.spreadsheetml.${t}+xml`;
// Styles: 0 default, 1 heading, 2 text, 3 wrapped text, 4 number.
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${main}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="49" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
const maxText = 32767;
const lineHeight = 15;
const maxLines = 6;

// Text Excel shows exactly: XML-escaped, characters XML cannot carry
// removed, "_x0041_"-style sequences kept literal, at most Excel's 32,767
// characters a cell.
const xmlText = (value) =>
  String(value)
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      "",
    )
    .slice(0, maxText)
    .replace(/_(x[0-9A-Fa-f]{4}_)/g, "_x005F_$1")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const attr = (value) => xmlText(value).replace(/"/g, "&quot;");
export const columnName = (i) => {
  let name = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
};

// rows: the headings first, then the data, as arrays. columns: per heading,
// { width, wrap, text }.
export function excelTable({ sheet, rows, columns = {} }) {
  const [headings, ...data] = rows;
  const specs = headings.map((h) => ({
    width: Math.max(columns[h]?.width ?? 12, String(h).length + 2),
    wrap: !!columns[h]?.wrap,
    text: !!columns[h]?.text,
  }));
  const strings = new Map();
  const shared = (text) => {
    if (!strings.has(text)) strings.set(text, strings.size);
    return strings.get(text);
  };
  const cell = (ref, value, spec, heading) => {
    if (value === null || value === undefined || value === "") return "";
    if (!heading && !spec.text && typeof value === "number")
      return Number.isFinite(value)
        ? `<c r="${ref}" s="4"><v>${value}</v></c>`
        : "";
    const style = heading ? 1 : spec.wrap ? 3 : 2;
    return `<c r="${ref}" s="${style}" t="s"><v>${shared(String(value))}</v></c>`;
  };
  const lines = (row) =>
    Math.min(
      maxLines,
      Math.max(
        1,
        ...row.map((value, i) =>
          specs[i].wrap && value
            ? String(value)
                .split("\n")
                .reduce(
                  (n, part) =>
                    n + Math.max(1, Math.ceil(part.length / specs[i].width)),
                  0,
                )
            : 1,
        ),
      ),
    );
  const last = columnName(headings.length - 1);
  const ref = `A1:${last}${rows.length}`;
  const sheetRows = rows.map((row, r) => {
    const n = lines(row);
    const height =
      r > 0 && n > 1 ? ` ht="${n * lineHeight}" customHeight="1"` : "";
    return `<row r="${r + 1}"${height}>${row.map((value, i) => cell(columnName(i) + (r + 1), value, specs[i], r === 0)).join("")}</row>`;
  });
  const cols = specs
    .map(
      (s, i) =>
        `<col min="${i + 1}" max="${i + 1}" width="${s.width}" customWidth="1"/>`,
    )
    .join("");
  const worksheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${main}" xmlns:r="${rel}"><dimension ref="${ref}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="${lineHeight}"/><cols>${cols}</cols><sheetData>${sheetRows.join("")}</sheetData><autoFilter ref="${ref}"/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
  const sst = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${main}" count="${strings.size}" uniqueCount="${strings.size}">${[...strings.keys()].map((t) => `<si><t xml:space="preserve">${xmlText(t)}</t></si>`).join("")}</sst>`;
  const name = attr(sheet);
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${main}" xmlns:r="${rel}"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${name.replace(/'/g, "''")}'!$A$1:$${last}$${rows.length}</definedName></definedNames></workbook>`;
  const parts = [
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${type("sheet.main")}"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${type("worksheet")}"/><Override PartName="/xl/styles.xml" ContentType="${type("styles")}"/><Override PartName="/xl/sharedStrings.xml" ContentType="${type("sharedStrings")}"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ],
    ["xl/workbook.xml", workbook],
    [
      "xl/_rels/workbook.xml.rels",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${pkg}"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/><Relationship Id="rId3" Type="${rel}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
    ],
    ["xl/worksheets/sheet1.xml", worksheet],
    ["xl/styles.xml", styles],
    ["xl/sharedStrings.xml", sst],
  ];
  const zip = CFB.utils.cfb_new();
  for (const [path, content] of parts)
    CFB.utils.cfb_add(zip, path, Buffer.from(content, "utf8"));
  return Buffer.from(
    CFB.write(zip, { fileType: "zip", type: "buffer", compression: true }),
  );
}
