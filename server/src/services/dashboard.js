function checked(result) {
  if (result.error)
    throw Object.assign(
      new Error("Dashboard could not be loaded. Please try again."),
      { status: result.error.code === "42501" ? 403 : 503 },
    );
  return result.data;
}
export async function dashboardSnapshot(db, user, range) {
  const result = await db.rpc("dashboard_snapshot", {
    p_actor: user.id,
    p_from: range.from,
    p_to: range.to,
  });
  if (!result.error) return result.data;
  if (!["PGRST202", "42883"].includes(result.error.code))
    return checked(result);
  // Compatible upgrade path until 027 is installed: one authorized HTTP request,
  // independent database reads in parallel, with the same current-owner filters.
  const activities = (table) => {
    let query = db
      .from(table)
      .select(user.role === "admin" ? "*" : "*,leads!inner(assigned_agent)");
    if (user.role !== "admin")
      query = query.eq("leads.assigned_agent", user.id);
    query = query.eq("status", table === "followups" ? "pending" : "scheduled");
    if (table === "followups")
      query = query.lte(
        "due_at",
        new Date(Date.now() + 86400000).toISOString(),
      );
    return query.order("created_at", { ascending: false }).limit(5);
  };
  const [metrics, leaders, followups, visits, targets] = await Promise.all([
    db.rpc("crm_metrics", {
      p_actor: user.id,
      p_from: range.from,
      p_to: range.to,
      p_agent: null,
      p_source: null,
    }),
    db.rpc("crm_leaderboard", {
      p_actor: user.id,
      p_from: range.from,
      p_to: range.to,
    }),
    activities("followups"),
    activities("visits"),
    user.role === "agent"
      ? db
          .from("targets")
          .select("*")
          .eq("agent_id", user.id)
          .order("created_at", { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [] }),
  ]);
  return {
    metrics: checked(metrics),
    leaders: checked(leaders),
    followups: checked(followups),
    visits: checked(visits),
    targets: checked(targets),
  };
}
