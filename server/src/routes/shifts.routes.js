import { Router } from "express";
import { z } from "zod";
import { reportLimit, sensitiveLimit } from "../middleware/rateLimit.js";
import { attendanceRpc } from "./attendance.routes.js";
import {
  uuid,
  shiftEdit,
  shiftDefaultEdit,
  shiftEmployeesQuery,
  shiftHistoryQuery,
  shiftVersion,
} from "../utils/validators.js";
// Shift management (update 048), mounted for administrators only: office
// timings for agents and staff, departments and individual employees. The SQL
// functions check the administrator again, refuse saves and withdrawals made
// from an older view (expected_version, or ?version= on a withdrawal),
// notify the employees whose timing changes and audit every change. These
// are the only routes that change office timings.
const update = "Shift management needs CRM database update 048 after 047.";
const role = z.enum(["agent", "staff"]);
const day = z.iso.date();

export function shiftsAdminRouter(db) {
  const router = Router();
  const admin = (req, name, args = {}) =>
    attendanceRpc(db, name, { p_actor: req.user.id, ...args }, update);
  const saveDefault = (scope, target) => async (req, res) =>
    res.json(
      await admin(req, "shift_default_save", {
        p_scope: scope,
        p_target: target(req.params),
        p_data: shiftDefaultEdit.parse(req.body),
        p_request: req.id,
      }),
    );
  const withdrawDefault = (scope, target) => async (req, res) =>
    res.json(
      await admin(req, "shift_default_cancel", {
        p_scope: scope,
        p_target: target(req.params),
        p_from: day.parse(req.params.date),
        p_version: shiftVersion.parse(req.query).version,
        p_request: req.id,
      }),
    );
  const roleOf = (p) => role.parse(p.role);
  const departmentOf = (p) => uuid.parse(p.id);
  router.get("/", async (req, res) =>
    res.json(await admin(req, "shift_overview")),
  );
  router.post("/roles/:role", sensitiveLimit, saveDefault("role", roleOf));
  router.delete(
    "/roles/:role/:date",
    sensitiveLimit,
    withdrawDefault("role", roleOf),
  );
  router.post(
    "/departments/:id",
    sensitiveLimit,
    saveDefault("department", departmentOf),
  );
  router.delete(
    "/departments/:id/:date",
    sensitiveLimit,
    withdrawDefault("department", departmentOf),
  );
  router.get("/employees", reportLimit, async (req, res) => {
    const { page, limit, ...filters } = shiftEmployeesQuery.parse(req.query);
    res.json(
      await admin(req, "shift_employees_page", {
        p_filters: filters,
        p_page: page,
        p_limit: limit,
      }),
    );
  });
  router.get("/employees/:id", async (req, res) =>
    res.json(
      await admin(req, "employee_detail", {
        p_user: uuid.parse(req.params.id),
      }),
    ),
  );
  router.post("/employees/:id", sensitiveLimit, async (req, res) =>
    res.json(
      await admin(req, "employee_shift_save", {
        p_user: uuid.parse(req.params.id),
        p_data: shiftEdit.parse(req.body),
        p_request: req.id,
      }),
    ),
  );
  router.delete("/employees/:id/:date", sensitiveLimit, async (req, res) =>
    res.json(
      await admin(req, "employee_shift_cancel", {
        p_user: uuid.parse(req.params.id),
        p_from: day.parse(req.params.date),
        p_version: shiftVersion.parse(req.query).version,
        p_request: req.id,
      }),
    ),
  );
  router.get("/history", reportLimit, async (req, res) => {
    const { page, limit, ...filters } = shiftHistoryQuery.parse(req.query);
    res.json(
      await admin(req, "shift_history_page", {
        p_filters: filters,
        p_page: page,
        p_limit: limit,
      }),
    );
  });
  return router;
}
