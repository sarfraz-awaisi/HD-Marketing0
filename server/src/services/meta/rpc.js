export async function metaRpc(db, name, args = {}) {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const missing = ["PGRST202", "PGRST205", "42P01", "42883"].includes(
    error.code,
  );
  const messages = {
    40001: "Some records changed. Refresh and try again.",
    23505: "This Page is already connected. Review existing connections.",
    42501: "Administrator access required.",
    P0002: "Integration record not found.",
    22023: "Check the selected records, mapping and settings.",
  };
  throw Object.assign(
    new Error(
      missing
        ? "Meta Lead Ads needs CRM database update 024 after 023."
        : messages[error.code] ||
            "The integration operation could not be completed. Please try again.",
    ),
    {
      status: missing
        ? 503
        : error.code === "40001" || error.code === "23505"
          ? 409
          : error.code === "42501"
            ? 403
            : error.code === "P0002"
              ? 404
              : error.code === "22023"
                ? 400
                : 503,
    },
  );
}
