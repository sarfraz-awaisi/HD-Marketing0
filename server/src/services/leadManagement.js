export async function leadManagementRpc(db, name, args) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const missing = ["PGRST202", "PGRST205", "42883", "42P01", "42703"].includes(
    error.code,
  );
  const safe =
    /^(This number (already belongs to HD-\d+|is in Deleted leads \(HD-\d+\)\. Restore it instead\.)|Choose |Lead not found|Restore period|Has a won deal|Use a valid|Delete reason)/.test(
      error.message || "",
    );
  throw Object.assign(
    new Error(
      missing
        ? "Lead management needs CRM database updates 029–032 after 028."
        : safe
          ? error.message
          : error.code === "42501"
            ? "Administrator access required"
            : error.code === "P0002"
              ? "Lead not found"
              : "The lead operation could not be completed.",
    ),
    {
      status: missing
        ? 503
        : error.code === "42501"
          ? 403
          : error.code === "P0002"
            ? 404
            : error.code === "23505"
              ? 409
              : error.code === "22023"
                ? 400
                : 503,
    },
  );
}
