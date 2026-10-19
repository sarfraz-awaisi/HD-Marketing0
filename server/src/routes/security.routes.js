import { Router } from "express";
import { adminOnly } from "../middleware/role.js";
import {
  uuid,
  securityAlertsQuery,
  reviewSecurityAlert,
  phoneRevealQuery,
  loginHistoryQuery,
} from "../utils/validators.js";
import { phoneRevealLimit, phoneAccessRpc } from "../services/phoneAccess.js";

export function securityRouter(db) {
  const router = Router();
  router.get("/phone-reveals/status", async (req, res) => {
    phoneRevealQuery.parse(req.query);
    res.json(
      await phoneAccessRpc(db, "phone_reveal_status", {
        p_actor: req.user.id,
        p_limit: phoneRevealLimit(),
      }),
    );
  });
  router.get("/security-alerts/summary", adminOnly, async (req, res) => {
    phoneRevealQuery.parse(req.query);
    res.json(
      await phoneAccessRpc(db, "security_alerts_summary", {
        p_actor: req.user.id,
      }),
    );
  });
  router.get("/security-alerts", adminOnly, async (req, res) => {
    const query = securityAlertsQuery.parse(req.query);
    res.json(
      await phoneAccessRpc(db, "security_alerts_page", {
        p_actor: req.user.id,
        p_page: query.page,
        p_limit: query.limit,
        p_view: query.view,
        p_severity: query.severity || null,
      }),
    );
  });
  router.get("/login-history", adminOnly, async (req, res) => {
    const query = loginHistoryQuery.parse(req.query);
    const { data, error } = await db.rpc("login_history_page", {
      p_actor: req.user.id,
      p_page: query.page,
      p_limit: query.limit,
      p_user: query.user || null,
      p_outcome: query.outcome || null,
      p_from: query.from || null,
      p_to: query.to || null,
    });
    if (!error) return res.json(data);
    const missing = ["PGRST202", "PGRST205", "42883", "42P01"].includes(
      error.code,
    );
    throw Object.assign(
      new Error(
        missing
          ? "Login history needs CRM database update 037 after 036."
          : error.code === "22023"
            ? "Check the login history filters."
            : "Login history could not be loaded. Please try again.",
      ),
      { status: missing ? 503 : error.code === "22023" ? 400 : 503 },
    );
  });
  router.patch("/security-alerts/:id", adminOnly, async (req, res) => {
    reviewSecurityAlert.parse(req.body);
    res.json(
      await phoneAccessRpc(db, "review_security_alert", {
        p_alert: uuid.parse(req.params.id),
        p_actor: req.user.id,
        p_request: req.id,
      }),
    );
  });
  return router;
}
