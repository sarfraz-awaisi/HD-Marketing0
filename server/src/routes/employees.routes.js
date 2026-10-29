import { Router } from "express";
import { reportLimit, sensitiveLimit } from "../middleware/rateLimit.js";
import { attendanceRpc } from "./attendance.routes.js";
import {
  uuid,
  employeesQuery,
  employeeUpdate,
  departmentCreate,
  departmentUpdate,
} from "../utils/validators.js";
// Employee management (update 047), mounted for administrators only. Roles
// and account access stay in Accounts behind its PIN; these are working
// details (department, job title, joining date). Office timings are changed
// only in Shift management (update 048, shifts.routes.js), which checks the
// version being edited; the 047 shift routes here were retired. The SQL
// functions check the administrator again and audit every change.
const update = "Employee management needs CRM database update 047 after 046.";

export function employeesAdminRouter(db) {
  const router = Router();
  const admin = (req, name, args = {}) =>
    attendanceRpc(db, name, { p_actor: req.user.id, ...args }, update);
  router.get("/employees", reportLimit, async (req, res) => {
    const { page, limit, ...filters } = employeesQuery.parse(req.query);
    res.json(
      await admin(req, "employees_page", {
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
  router.patch("/employees/:id", sensitiveLimit, async (req, res) =>
    res.json(
      await admin(req, "employee_profile_save", {
        p_user: uuid.parse(req.params.id),
        p_data: employeeUpdate.parse(req.body),
        p_request: req.id,
      }),
    ),
  );
  router.get("/departments", async (req, res) =>
    res.json(await admin(req, "employee_departments")),
  );
  router.post("/departments", sensitiveLimit, async (req, res) =>
    res.status(201).json(
      await admin(req, "department_save", {
        p_id: null,
        p_data: departmentCreate.parse(req.body),
        p_request: req.id,
      }),
    ),
  );
  router.patch("/departments/:id", sensitiveLimit, async (req, res) =>
    res.json(
      await admin(req, "department_save", {
        p_id: uuid.parse(req.params.id),
        p_data: departmentUpdate.parse(req.body),
        p_request: req.id,
      }),
    ),
  );
  return router;
}
