import { Router } from "express";
import { z } from "zod";
import { adminOnly } from "../middleware/role.js";
import { reportLimit, sensitiveLimit } from "../middleware/rateLimit.js";
import {
  uuid,
  kpiCreate,
  kpiUpdate,
  kpiArchive,
  kpiAnswers,
  kpiReportQuery,
  kpiMyQuery,
} from "../utils/validators.js";
import {
  kpiRpc,
  kpiList,
  agentDay,
  agentHistory,
  kpiReport,
  pkToday,
  weekStart,
  addDays,
} from "../services/kpis.js";
// Daily KPIs (update 070), after the shared auth middleware. Administrators
// manage KPIs and see everyone; an agent answers and sees only their own
// (req.user). The SQL functions check the person, the day and every answer
// again, so a request cannot act for someone else.
const noBody = z.object({}).strict();
const agentOnly = (req, res, next) =>
  req.user.role === "agent"
    ? next()
    : res.status(403).json({ error: "Agent access required" });

export function kpisRouter(db) {
  const router = Router();
  const rpc = (req, name, args) =>
    kpiRpc(db, name, { p_actor: req.user.id, ...args });
  // An agent's day, with the 14 days before it for their history.
  const myDay = async (req, day) => {
    const from = [weekStart(day), addDays(day, -13)].sort()[0];
    const facts = await rpc(req, "kpi_facts", {
      p_from: from,
      p_to: day,
      p_agent: req.user.id,
    });
    return {
      ...agentDay(facts, req.user.id, day),
      history: agentHistory(facts, req.user.id, addDays(day, -13), day),
    };
  };

  router.get("/manage", adminOnly, async (req, res) =>
    res.json(kpiList(await rpc(req, "kpi_admin_list", {}))),
  );
  router.post("/", adminOnly, sensitiveLimit, async (req, res) =>
    res.status(201).json(
      await rpc(req, "kpi_save", {
        p_id: null,
        p_data: kpiCreate.parse(req.body),
        p_request: req.id,
      }),
    ),
  );
  router.patch("/:id", adminOnly, sensitiveLimit, async (req, res) =>
    res.json(
      await rpc(req, "kpi_save", {
        p_id: uuid.parse(req.params.id),
        p_data: kpiUpdate.parse(req.body),
        p_request: req.id,
      }),
    ),
  );
  router.post("/:id/archive", adminOnly, sensitiveLimit, async (req, res) =>
    res.json(
      await rpc(req, "kpi_archive", {
        p_id: uuid.parse(req.params.id),
        p_archived: kpiArchive.parse(req.body).archived,
        p_request: req.id,
      }),
    ),
  );
  router.delete("/:id", adminOnly, sensitiveLimit, async (req, res) => {
    noBody.parse(req.body ?? {});
    res.json(
      await rpc(req, "kpi_delete", {
        p_id: uuid.parse(req.params.id),
        p_request: req.id,
      }),
    );
  });

  // The agent's own day (today unless chosen; never a future day).
  router.get("/my", agentOnly, async (req, res) => {
    const { day = pkToday() } = kpiMyQuery.parse(req.query);
    if (day > pkToday() || day < addDays(pkToday(), -366))
      return res.status(400).json({ error: "Choose a day up to today" });
    res.set("Cache-Control", "no-store").json(await myDay(req, day));
  });
  router.put("/my/:day", agentOnly, sensitiveLimit, async (req, res) => {
    const day = z.iso.date().parse(req.params.day);
    const { answers } = kpiAnswers.parse(req.body);
    const saved = await rpc(req, "kpi_submit", {
      p_day: day,
      p_answers: answers,
      p_request: req.id,
    });
    res.json({ ...(await myDay(req, day)), saved: saved.saved });
  });

  // Administrators: every agent's results, and one agent's history.
  router.get("/report", adminOnly, reportLimit, async (req, res) => {
    const q = kpiReportQuery.parse(req.query);
    const facts = await rpc(req, "kpi_facts", {
      p_from: q.from,
      p_to: q.to,
      p_agent: q.agent ?? null,
    });
    res.set("Cache-Control", "no-store").json(kpiReport(facts, q.from, q.to));
  });
  router.get("/history", adminOnly, reportLimit, async (req, res) => {
    const q = kpiReportQuery.parse(req.query);
    if (!q.agent)
      return res.status(400).json({ error: "Choose an agent from the list" });
    if (addDays(q.from, 92) < q.to)
      return res
        .status(400)
        .json({ error: "Choose up to three months of history" });
    const facts = await rpc(req, "kpi_facts", {
      p_from: q.from,
      p_to: q.to,
      p_agent: q.agent,
    });
    res
      .set("Cache-Control", "no-store")
      .json(agentHistory(facts, q.agent, q.from, q.to));
  });
  return router;
}
