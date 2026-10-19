export function phoneRevealLimit() {
  const value = process.env.PHONE_REVEAL_DAILY_LIMIT || "80";
  if (!/^[1-9]\d{0,4}$/.test(value) || Number(value) > 10000)
    throw Object.assign(
      new Error(
        "Ask your administrator to set PHONE_REVEAL_DAILY_LIMIT to an integer from 1 to 10000.",
      ),
      { status: 503 },
    );
  return Number(value);
}
export async function phoneAccessRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const missing = ["PGRST202", "PGRST205", "42883", "42P01"].includes(
    error.code,
  );
  throw Object.assign(
    new Error(
      missing
        ? name === "lead_contact_phones"
          ? error.code === "42P01"
            ? "Visible lead numbers cannot load because required CRM database tables are missing. Ask your administrator to run the visible-contact database check and apply the missing migrations."
            : "Visible lead numbers need database migration 021 after 020, or a database API cache refresh. Ask your administrator to run the visible-contact repair in the Supabase project connected to this CRM."
          : "Protected phone numbers and security alerts need database migration 019 after 018. Ask your administrator to apply the CRM update."
        : error.code === "P0002"
          ? "Record or phone number not found"
          : error.code === "42501"
            ? "Access denied"
            : error.code === "22023"
              ? "Invalid security settings or filters"
              : "The protected operation could not be completed. Please try again.",
    ),
    {
      status: missing
        ? 503
        : error.code === "P0002"
          ? 404
          : error.code === "42501"
            ? 403
            : error.code === "22023"
              ? 400
              : 503,
    },
  );
}

export async function leadContacts(db, req, rows) {
  if (!rows.length) return rows;
  const result = await phoneAccessRpc(db, "lead_contact_phones", {
    p_actor: req.user.id,
    p_leads: rows.map((row) => row.id),
    p_request: req.id,
  });
  req.visibleLeadPhones = result.phones;
  return rows.map((row) => ({ ...row, phone: result.phones[row.id] || null }));
}
