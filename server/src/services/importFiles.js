import { z } from "zod";
import { leadCreate } from "../utils/validators.js";
import { normalizePhone } from "../utils/phoneMask.js";
import {
  parseLeadImport,
  resolveImportAgents,
  importValidationMessage,
} from "./leadImport.js";

export async function fileRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const missing = ["PGRST202", "PGRST205", "42883", "42P01"].includes(
    error.code,
  );
  throw Object.assign(
    new Error(
      missing
        ? "File assignments need a database update. Ask your administrator to install the latest CRM migration."
        : error.code === "P0002"
          ? "File not found"
          : error.code === "42501"
            ? "You do not have access to this file."
            : error.code === "22023"
              ? "Choose an active agent and a file with accepted leads."
              : "File operation failed. Please try again.",
    ),
    {
      status: missing
        ? 503
        : error.code === "P0002"
          ? 404
          : error.code === "42501"
            ? 403
            : 400,
      code: error.code,
    },
  );
}

export async function importLeadFile(db, req) {
  const { rows, format, worksheet, ignoredColumns } = parseLeadImport(
    req.file,
    req.body?.mapping,
  );
  const resolved = await resolveImportAgents(db, rows);
  const prepared = resolved.map((row) => {
    if (row.error) return { row: row.row, error: row.error };
    try {
      const { phone, ...data } = leadCreate.parse(row.data);
      let normalized;
      try {
        normalized = normalizePhone(phone);
      } catch {
        return {
          row: row.row,
          error:
            "Phone must contain 10–15 digits, with a leading zero or international country code. Replace text placeholders with a valid phone number.",
        };
      }
      return {
        row: row.row,
        data,
        phone: normalized,
        ...(row.warnings?.length ? { warnings: row.warnings } : {}),
      };
    } catch (error) {
      return {
        row: row.row,
        error:
          error instanceof z.ZodError
            ? importValidationMessage(error)
            : "Row rejected",
      };
    }
  });
  const fileName =
    req.file.originalname
      .replaceAll("\\", "/")
      .split("/")
      .at(-1)
      .normalize("NFKC")
      .replace(/\p{C}/gu, "")
      .slice(0, 200) || `leads.${format}`;
  const result = await fileRpc(db, "import_leads", {
    p_file_name: fileName,
    p_format: format,
    p_worksheet: worksheet,
    p_rows: prepared,
    p_actor: req.user.id,
    p_request: req.id,
  });
  return {
    ...result,
    file_name: fileName,
    format,
    worksheet,
    ...(ignoredColumns.length ? { ignored_columns: ignoredColumns } : {}),
  };
}
