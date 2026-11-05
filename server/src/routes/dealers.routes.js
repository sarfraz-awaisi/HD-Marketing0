import { Router } from "express";
import { adminOnly } from "../middleware/role.js";
import { sensitiveLimit } from "../middleware/rateLimit.js";
import { maskAgentResponse } from "../middleware/phoneProtection.js";
import { attendanceRpc } from "./attendance.routes.js";
import {
  uuid,
  dealerCreate,
  dealerUpdate,
  dealerReason,
  dealerListQuery,
  dealerPhoneQuery,
} from "../utils/validators.js";
// Dealer affiliate network (update 049). Every handler runs after the shared
// auth middleware; staff never reach it (staffAccess). The signed-in account
// is always the actor and, for agents, the owner: no request names an owner.
// The SQL functions check the role and ownership again, so an agent asking
// for another agent's dealer gets "not found", as for a dealer that does not
// exist.
const update = "Dealers need CRM database update 049 after 048.";
const filters = (q, keys) =>
  Object.fromEntries(keys.filter((k) => q[k] != null).map((k) => [k, q[k]]));
// Agent responses are phone-masked (protectAgentPhones). An agent keeps the
// full contact number of their own dealers only: SQL returns agents nothing
// but their own dealers, and the number is restored only where the dealer's
// owner_id is the signed-in agent. Everything else stays masked: notes, the
// rejection reason, the number check and every error.
export function dealerView(user, body) {
  if (user.role === "admin") return body;
  const reveal = (row) =>
    row.owner_id === user.id && typeof row.phone === "string"
      ? { ...maskAgentResponse(row), phone: row.phone }
      : maskAgentResponse(row);
  return Array.isArray(body.data)
    ? { ...maskAgentResponse(body), data: body.data.map(reveal) }
    : reveal(body);
}
function sendDealers(req, res, body, status = 200) {
  const view = dealerView(req.user, body);
  req.phoneRevealResponse = true;
  res.status(status).json(view);
}

export function dealersRouter(db) {
  const router = Router();
  const call = (req, name, args = {}) =>
    attendanceRpc(db, name, { p_actor: req.user.id, ...args }, update);
  router.get("/", async (req, res) => {
    const q = dealerListQuery.parse(req.query);
    sendDealers(
      req,
      res,
      await call(req, "dealers_page", {
        p_filters: filters(q, [
          "status",
          "search",
          "sort",
          "agent",
          "view",
          "duplicates",
        ]),
        p_page: q.page,
        p_limit: q.limit,
      }),
    );
  });
  router.post("/", sensitiveLimit, async (req, res) => {
    const { client_key, ...data } = dealerCreate.parse(req.body || {});
    const dealer = await call(req, "dealer_create", {
      p_data: data,
      p_client_key: client_key,
      p_request: req.id,
    });
    sendDealers(req, res, dealer, dealer.replayed ? 200 : 201);
  });
  // Agents learn only about their own dealers with the number. The reply
  // stays masked: the agent typed the number and needs only the matches.
  router.get("/check-phone", async (req, res) => {
    const q = dealerPhoneQuery.parse(req.query);
    res.json(
      await call(req, "dealer_check_phone", {
        p_phone: q.phone,
        p_except: q.except || null,
      }),
    );
  });
  router.get("/:id", async (req, res) =>
    sendDealers(
      req,
      res,
      await call(req, "dealer_detail", { p_id: uuid.parse(req.params.id) }),
    ),
  );
  router.patch("/:id", adminOnly, sensitiveLimit, async (req, res) => {
    const { expected_updated_at, ...data } = dealerUpdate.parse(req.body || {});
    res.json(
      await call(req, "dealer_update", {
        p_id: uuid.parse(req.params.id),
        p_data: data,
        p_expected: expected_updated_at,
        p_request: req.id,
      }),
    );
  });
  for (const [path, decision] of [
    ["approve", "approved"],
    ["reject", "rejected"],
  ])
    router.post(`/:id/${path}`, adminOnly, sensitiveLimit, async (req, res) => {
      const data = dealerReason.parse(req.body || {});
      res.json(
        await call(req, "dealer_review", {
          p_id: uuid.parse(req.params.id),
          p_decision: decision,
          p_reason: decision === "rejected" ? data.reason || null : null,
          p_request: req.id,
        }),
      );
    });
  router.post("/:id/delete", adminOnly, sensitiveLimit, async (req, res) => {
    const data = dealerReason.parse(req.body || {});
    res.json(
      await call(req, "dealer_delete", {
        p_id: uuid.parse(req.params.id),
        p_reason: data.reason || null,
        p_request: req.id,
      }),
    );
  });
  router.post("/:id/restore", adminOnly, sensitiveLimit, async (req, res) => {
    dealerReason.parse(req.body || {});
    res.json(
      await call(req, "dealer_restore", {
        p_id: uuid.parse(req.params.id),
        p_request: req.id,
      }),
    );
  });
  return router;
}
