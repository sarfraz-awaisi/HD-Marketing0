import { Router } from "express";
import { z } from "zod";
import { reportLimit, sensitiveLimit } from "../middleware/rateLimit.js";
import { attendanceRpc } from "./attendance.routes.js";
import {
  uuid,
  taskCreate,
  taskUpdate,
  taskProgress,
  taskReport,
  taskVerify,
  taskReason,
  taskNote,
  checkoutRequest,
  checkoutDecision,
  taskListQuery,
  taskReportsQuery,
  checkoutListQuery,
  taskPerformanceQuery,
  taskOverviewQuery,
  taskSettings,
  taskMissingQuery,
} from "../utils/validators.js";
// Daily tasks, reports and checkout requests (update 045). Every handler runs
// after the shared auth middleware. Agents act only on themselves (req.user);
// the SQL functions check the role, ownership and the date again.
const update = "Task management needs CRM database update 045 after 044.";
const noBody = z.object({}).strict();
const filters = (q, keys) =>
  Object.fromEntries(keys.filter((k) => q[k] != null).map((k) => [k, q[k]]));

export function tasksRouter(db) {
  const router = Router();
  const self = (req, name, args = {}) =>
    attendanceRpc(db, name, { p_actor: req.user.id, ...args }, update);
  router.get("/my", async (req, res) => res.json(await self(req, "task_my")));
  router.get("/checkout", async (req, res) =>
    res.json(await self(req, "task_checkout_state")),
  );
  router.post("/assignments/:id/progress", sensitiveLimit, async (req, res) => {
    const data = taskProgress.parse(req.body || {});
    res.json(
      await self(req, "task_progress", {
        p_assignment: uuid.parse(req.params.id),
        p_data: data,
        p_request: req.id,
      }),
    );
  });
  router.post("/reports", sensitiveLimit, async (req, res) => {
    const data = taskReport.parse(req.body || {});
    res.status(201).json(
      await self(req, "task_report_submit", {
        p_day: data.date || null,
        p_remarks: data.remarks || null,
        p_amend: data.amend,
        p_request: req.id,
      }),
    );
  });
  router.get("/reports/:id", async (req, res) =>
    res.json(
      await self(req, "task_report_detail", {
        p_report: uuid.parse(req.params.id),
      }),
    ),
  );
  router.post("/checkout-requests", sensitiveLimit, async (req, res) => {
    const data = checkoutRequest.parse(req.body || {});
    res.status(201).json(
      await self(req, "task_checkout_request", {
        p_kind: data.kind,
        p_reason: data.reason || null,
        p_request: req.id,
      }),
    );
  });
  router.post(
    "/checkout-requests/:id/cancel",
    sensitiveLimit,
    async (req, res) => {
      noBody.parse(req.body || {});
      res.json(
        await self(req, "task_checkout_cancel", {
          p_id: uuid.parse(req.params.id),
          p_request: req.id,
        }),
      );
    },
  );
  return router;
}

export function tasksAdminRouter(db) {
  const router = Router();
  const admin = (req, name, args = {}) =>
    attendanceRpc(db, name, { p_actor: req.user.id, ...args }, update);
  router.get("/overview", reportLimit, async (req, res) => {
    const q = taskOverviewQuery.parse(req.query);
    res.json(
      await admin(req, "task_admin_overview", { p_day: q.date || null }),
    );
  });
  router.get("/", reportLimit, async (req, res) => {
    const q = taskListQuery.parse(req.query);
    res.json(
      await admin(req, "task_admin_tasks", {
        p_filters: filters(q, [
          "scope",
          "from",
          "to",
          "status",
          "user",
          "search",
        ]),
        p_page: q.page,
        p_limit: q.limit,
      }),
    );
  });
  router.post("/", sensitiveLimit, async (req, res) => {
    const data = taskCreate.parse(req.body || {});
    res
      .status(201)
      .json(
        await admin(req, "task_create", { p_data: data, p_request: req.id }),
      );
  });
  router.post("/assignments/:id/cancel", sensitiveLimit, async (req, res) => {
    const data = taskReason.parse(req.body || {});
    res.json(
      await admin(req, "task_assignment_cancel", {
        p_assignment: uuid.parse(req.params.id),
        p_reason: data.reason || null,
        p_request: req.id,
      }),
    );
  });
  router.post("/assignments/:id/verify", sensitiveLimit, async (req, res) => {
    const data = taskVerify.parse(req.body || {});
    res.json(
      await admin(req, "task_verify", {
        p_assignment: uuid.parse(req.params.id),
        p_data: data,
        p_request: req.id,
      }),
    );
  });
  router.get("/reports", reportLimit, async (req, res) => {
    const q = taskReportsQuery.parse(req.query);
    res.json(
      await admin(req, "task_reports", {
        p_filters: filters(q, ["from", "to", "user", "status"]),
        p_page: q.page,
        p_limit: q.limit,
      }),
    );
  });
  router.get("/reports/:id", async (req, res) =>
    res.json(
      await admin(req, "task_report_detail", {
        p_report: uuid.parse(req.params.id),
      }),
    ),
  );
  router.post("/reports/:id/review", sensitiveLimit, async (req, res) => {
    const data = taskNote.parse(req.body || {});
    res.json(
      await admin(req, "task_report_review", {
        p_report: uuid.parse(req.params.id),
        p_note: data.note || null,
        p_request: req.id,
      }),
    );
  });
  // Daily reports still owed (default: the last 7 days, which agents can
  // still submit).
  router.get("/missing-reports", reportLimit, async (req, res) => {
    const q = taskMissingQuery.parse(req.query);
    const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
    const shift = (day, n) =>
      new Date(Date.parse(day + "T00:00:00Z") + n * 86400000)
        .toISOString()
        .slice(0, 10);
    res.json(
      await admin(req, "task_missing_reports", {
        p_from: q.from || shift(today, -7),
        p_to: q.to || shift(today, -1),
      }),
    );
  });
  router.get("/checkout-requests", reportLimit, async (req, res) => {
    const q = checkoutListQuery.parse(req.query);
    res.json(
      await admin(req, "task_checkout_requests_page", {
        p_filters: filters(q, ["status", "kind", "user", "from", "to"]),
        p_page: q.page,
        p_limit: q.limit,
      }),
    );
  });
  router.post(
    "/checkout-requests/:id/decide",
    sensitiveLimit,
    async (req, res) => {
      const data = checkoutDecision.parse(req.body || {});
      res.json(
        await admin(req, "task_checkout_decide", {
          p_id: uuid.parse(req.params.id),
          p_decision: data.decision,
          p_note: data.note || null,
          p_waive: data.waive_report,
          p_request: req.id,
        }),
      );
    },
  );
  router.get("/performance", reportLimit, async (req, res) => {
    const q = taskPerformanceQuery.parse(req.query);
    res.json(
      await admin(req, "task_performance", {
        p_from: q.from,
        p_to: q.to,
        p_user: q.user || null,
        p_department: q.department || null,
      }),
    );
  });
  router.get("/settings", async (req, res) =>
    res.json(await admin(req, "task_settings")),
  );
  router.patch("/settings", sensitiveLimit, async (req, res) => {
    const data = taskSettings.parse(req.body || {});
    res.json(
      await admin(req, "task_settings_save", {
        p_from: data.rules_from,
        p_request: req.id,
      }),
    );
  });
  // Declared last so the fixed paths above are matched first.
  router.get("/:id", async (req, res) =>
    res.json(
      await admin(req, "task_detail", { p_task: uuid.parse(req.params.id) }),
    ),
  );
  router.patch("/:id", sensitiveLimit, async (req, res) => {
    const data = taskUpdate.parse(req.body || {});
    res.json(
      await admin(req, "task_update", {
        p_task: uuid.parse(req.params.id),
        p_data: data,
        p_request: req.id,
      }),
    );
  });
  router.post("/:id/cancel", sensitiveLimit, async (req, res) => {
    const data = taskReason.parse(req.body || {});
    res.json(
      await admin(req, "task_cancel", {
        p_task: uuid.parse(req.params.id),
        p_reason: data.reason || null,
        p_request: req.id,
      }),
    );
  });
  return router;
}
