import { Router } from "express";
import { adminOnly } from "../middleware/role.js";
import {
  exportLimit,
  reportLimit,
  sensitiveLimit,
} from "../middleware/rateLimit.js";
import {
  leadReviewQuery,
  leadReviewKeep,
  leadReviewReassign,
  workSettings,
  notificationRead,
  calendarQuery,
  visitConflictQuery,
  targetCreate,
  targetUpdate,
  targetQuery,
  targetCopy,
  insightQuery,
  uuid,
} from "../utils/validators.js";
import { csvCell } from "../utils/phoneMask.js";
// Sales workflow: first-call review, call activity, working hours and the
// notification bell (update 038); visit calendar, targets and reports (039).
export async function salesRpc(db, name, args, update = "038 after 037") {
  const { data, error } = await db.rpc(name, args);
  if (!error) return data;
  const missing = ["PGRST202", "PGRST205", "42883", "42P01", "42703"].includes(
    error.code,
  );
  const status = missing
    ? 503
    : { 42501: 403, P0002: 404, 23505: 409, 22023: 400, 23514: 400 }[
        error.code
      ] || 503;
  throw Object.assign(
    new Error(
      missing
        ? `This feature needs CRM database update ${update}.`
        : status === 403
          ? "Administrator access required"
          : /^Choose /.test(error.message || "")
            ? error.message
            : status === 404
              ? "Record not found"
              : status === 409
                ? "This already exists. Edit the existing record instead."
                : status === 400
                  ? "Check the details and try again."
                  : "The request could not be completed. Please try again.",
    ),
    { status },
  );
}
const part2 = "039 after 038";
const reports = {
  sources: {
    rpc: "report_sources",
    args: (q) => ({ p_agent: q.agent || null }),
    csv: (rows) => [
      [
        "Source",
        "Leads",
        "Contacted",
        "Visited",
        "Won",
        "Lost",
        "Conversion %",
        "Won revenue (PKR)",
      ],
      ...rows.map((r) => [
        r.source === "CSV" ? "CSV / Excel" : r.source,
        r.leads,
        r.contacted,
        r.visited,
        r.won,
        r.lost,
        r.leads ? Math.round((r.won / r.leads) * 1000) / 10 : 0,
        r.revenue,
      ]),
    ],
  },
  agents: {
    rpc: "report_agents",
    args: () => ({}),
    csv: (rows) => [
      [
        "Agent",
        "UID",
        "Assigned",
        "First calls",
        "On-time first calls %",
        "Average first call (working minutes)",
        "Missed first calls",
        "Calls",
        "Answered calls",
        "Talk minutes",
        "Visits completed",
        "Won deals",
        "Won revenue (PKR)",
        "Lost",
      ],
      ...rows.map((r) => [
        r.name,
        r.uid,
        r.assigned,
        r.first_calls,
        r.first_calls_with_deadline
          ? Math.round(
              (r.on_time_first_calls / r.first_calls_with_deadline) * 100,
            )
          : "",
        r.avg_first_call_minutes ?? "",
        r.missed_first_calls,
        r.calls,
        r.connected_calls,
        r.talk_minutes,
        r.visits_completed,
        r.won_deals,
        r.revenue,
        r.lost,
      ]),
    ],
  },
  funnel: {
    rpc: "report_funnel",
    args: (q) => ({ p_agent: q.agent || null, p_source: q.source || null }),
    csv: (data) => [
      [
        "Stage",
        "Leads reaching stage",
        "% of all leads",
        "% of previous stage",
      ],
      ...data.stages.map((s, i) => [
        s.stage,
        s.reached,
        data.total ? Math.round((s.reached / data.total) * 1000) / 10 : 0,
        i && data.stages[i - 1].reached
          ? Math.round((s.reached / data.stages[i - 1].reached) * 1000) / 10
          : "",
      ]),
      [
        "lost",
        data.lost,
        data.total ? Math.round((data.lost / data.total) * 1000) / 10 : 0,
        "",
      ],
    ],
  },
  lost: {
    rpc: "report_lost",
    args: (q) => ({ p_agent: q.agent || null, p_source: q.source || null }),
    csv: (data) => [
      ["Group", "Value", "Lost leads"],
      ...data.by_reason.map((r) => ["Reason", r.reason, r.count]),
      ...data.by_source.map((r) => ["Source", r.source, r.count]),
      ...data.by_agent.map((r) => ["Agent", r.name, r.count]),
    ],
  },
};
async function runReport(db, req, type) {
  const q = insightQuery.parse(req.query);
  const report = reports[type];
  return salesRpc(
    db,
    report.rpc,
    { p_actor: req.user.id, p_from: q.from, p_to: q.to, ...report.args(q) },
    part2,
  );
}
export function salesRouter(db) {
  const router = Router();
  router.get("/notifications", async (req, res) => {
    res.json(
      await salesRpc(db, "notifications_page", {
        p_actor: req.user.id,
        p_limit: 30,
      }),
    );
  });
  router.post("/notifications/read", async (req, res) => {
    const { ids } = notificationRead.parse(req.body || {});
    res.json(
      await salesRpc(db, "read_notifications", {
        p_actor: req.user.id,
        p_ids: ids || null,
      }),
    );
  });
  router.get("/first-call-queue", async (req, res) => {
    res.json(
      await salesRpc(db, "first_call_queue", {
        p_actor: req.user.id,
        p_limit: 8,
      }),
    );
  });
  router.get("/call-activity", async (req, res) => {
    res.json(await salesRpc(db, "call_activity", { p_actor: req.user.id }));
  });
  router.get("/lead-review", adminOnly, async (req, res) => {
    const q = leadReviewQuery.parse(req.query);
    res.json(
      await salesRpc(db, "lead_review_page", {
        p_actor: req.user.id,
        p_kind: q.kind,
        p_page: q.page,
        p_limit: q.limit,
        p_agent: q.agent || null,
      }),
    );
  });
  router.post(
    "/lead-review/keep",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      const body = leadReviewKeep.parse(req.body);
      res.json(
        await salesRpc(db, "review_keep_leads", {
          p_actor: req.user.id,
          p_lead_ids: body.lead_ids,
          p_kind: body.kind,
          p_request: req.id,
        }),
      );
    },
  );
  router.post(
    "/lead-review/reassign",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      const body = leadReviewReassign.parse(req.body);
      res.json(
        await salesRpc(db, "review_reassign_leads", {
          p_actor: req.user.id,
          p_lead_ids: body.lead_ids,
          p_kind: body.kind,
          p_mode: body.mode,
          p_agent: body.agent_id || null,
          p_request: req.id,
        }),
      );
    },
  );
  router.get("/settings/work-hours", async (req, res) => {
    res.json(await salesRpc(db, "work_settings", { p_actor: req.user.id }));
  });
  router.put("/settings/work-hours", adminOnly, async (req, res) => {
    const data = workSettings.parse(req.body);
    res.json(
      await salesRpc(db, "save_work_settings", {
        p_actor: req.user.id,
        p_data: data,
        p_request: req.id,
      }),
    );
  });
  router.get("/visits/calendar", async (req, res) => {
    const q = calendarQuery.parse(req.query);
    res.json(
      await salesRpc(
        db,
        "visit_calendar",
        {
          p_actor: req.user.id,
          p_from: q.from,
          p_to: q.to,
          p_agent: q.agent || null,
        },
        part2,
      ),
    );
  });
  router.get("/visits/conflicts", async (req, res) => {
    const q = visitConflictQuery.parse(req.query);
    res.json(
      await salesRpc(
        db,
        "visit_conflicts",
        {
          p_actor: req.user.id,
          p_lead: q.lead_id,
          p_at: q.at,
          p_exclude: q.exclude || null,
        },
        part2,
      ),
    );
  });
  router.get("/targets", async (req, res) => {
    const q = targetQuery.parse(req.query);
    res.json(
      await salesRpc(
        db,
        "targets_page",
        {
          p_actor: req.user.id,
          p_period: q.period || null,
          p_start: q.start || null,
          p_current: q.current === "true",
          p_page: q.page,
          p_limit: q.limit,
        },
        part2,
      ),
    );
  });
  router.post("/targets/copy", adminOnly, sensitiveLimit, async (req, res) => {
    const body = targetCopy.parse(req.body);
    res.json(
      await salesRpc(
        db,
        "copy_targets",
        {
          p_actor: req.user.id,
          p_period: body.period,
          p_start: body.start,
          p_request: req.id,
        },
        part2,
      ),
    );
  });
  router.post("/targets", adminOnly, async (req, res) => {
    const body = targetCreate.parse(req.body);
    res
      .status(201)
      .json(
        await salesRpc(
          db,
          "save_target",
          { p_actor: req.user.id, p_id: null, p_data: body, p_request: req.id },
          part2,
        ),
      );
  });
  router.patch("/targets/:id", adminOnly, sensitiveLimit, async (req, res) => {
    const body = targetUpdate.parse(req.body);
    res.json(
      await salesRpc(
        db,
        "save_target",
        {
          p_actor: req.user.id,
          p_id: uuid.parse(req.params.id),
          p_data: body,
          p_request: req.id,
        },
        part2,
      ),
    );
  });
  // Other paths (such as /reports/export) continue to the next router before
  // any report limit is counted.
  const known = (req, _res, next) =>
    next(Object.hasOwn(reports, req.params.type) ? undefined : "route");
  router.get("/reports/:type", known, reportLimit, async (req, res) => {
    res.json(await runReport(db, req, req.params.type));
  });
  router.get(
    "/reports/:type/export",
    adminOnly,
    known,
    exportLimit,
    async (req, res) => {
      const rows = reports[req.params.type].csv(
        await runReport(db, req, req.params.type),
      );
      res
        .type("text/csv")
        .attachment(`hd-marketing-${req.params.type}-report.csv`)
        .send(rows.map((row) => row.map(csvCell).join(",")).join("\r\n"));
    },
  );
  return router;
}
