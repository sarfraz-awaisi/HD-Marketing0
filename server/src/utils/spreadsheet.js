import { utils, write } from "xlsx";
import { csvCell } from "./phoneMask.js";
// A CSV or Excel download of rows, the first row being the headings. Excel
// cells are written as plain values, so no formula is ever created; CSV
// cells a spreadsheet could read as a formula are prefixed (csvCell).
export function sendSheet(res, rows, name, format, sheet) {
  if (format === "xlsx") {
    const book = utils.book_new();
    utils.book_append_sheet(book, utils.aoa_to_sheet(rows), sheet);
    return res
      .type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
      .attachment(name + ".xlsx")
      .send(write(book, { type: "buffer", bookType: "xlsx" }));
  }
  res
    .type("text/csv")
    .attachment(name + ".csv")
    .send(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"));
}
