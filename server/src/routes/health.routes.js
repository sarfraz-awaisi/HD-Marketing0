import { Router } from "express";
import { adminOnly } from "../middleware/role.js";
import { systemStatus } from "../services/systemStatus.js";
export function healthRouter(db) {
  const router = Router();
  router.use(adminOnly);
  router.get("/status", async (req, res) =>
    res.json(await systemStatus(db, req.user.id)),
  );
  router.get("/ready", async (req, res) => {
    const result = await systemStatus(db, req.user.id);
    res.status(result.ready ? 200 : 503).json(result);
  });
  return router;
}
