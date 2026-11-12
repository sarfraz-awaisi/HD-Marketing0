import { leadManagementRpc } from "../services/leadManagement.js";
import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { adminOnly } from "../middleware/role.js";
import {
  exportLimit,
  importLimit,
  reportLimit,
  sensitiveLimit,
} from "../middleware/rateLimit.js";
import { audit } from "../middleware/auditLogger.js";
import {
  uuid,
  schemas,
  leadCreate,
  listQuery,
  leadUpdate,
  agentLeadUpdate,
  dealCreate,
  dealUpdate,
  manualCall,
  followUpOutcome,
  phoneRevealQuery,
  bulkAssignment,
  callOutcome,
  agentLeadsQuery,
  pipelineAgentsQuery,
  agentPipelineQuery,
  adminLeadsQuery,
  unassignedAssignment,
  selectedAssignment,
  leadDistribution,
  leadIds,
  auditQuery,
  leadName,
} from "../utils/validators.js";
import {
  auditKinds,
  auditMatches,
  auditModules,
  presentAuditEntry,
} from "../services/auditHistory.js";
import { normalizePhone, csvCell } from "../utils/phoneMask.js";
import { callingProvider, callCapabilities } from "../services/cloudCalling.js";
import { assign } from "../services/leadAssignment.js";
import { importLeadFile, fileRpc } from "../services/importFiles.js";
import { documentsRouter } from "./documents.routes.js";
import { accountsRouter } from "./accounts.routes.js";
import { securityRouter } from "./security.routes.js";
import { salesRouter, salesRpc } from "./sales.routes.js";
import {
  attendanceRouter,
  attendanceAdminRouter,
  attendanceRpc,
} from "./attendance.routes.js";
import { employeesAdminRouter } from "./employees.routes.js";
import { shiftsAdminRouter } from "./shifts.routes.js";
import { tasksRouter, tasksAdminRouter } from "./tasks.routes.js";
import { dealersRouter } from "./dealers.routes.js";
import { reportDrilldownRouter } from "./reportDrilldown.routes.js";
import { leadContacts } from "../services/phoneAccess.js";
import { dashboardSnapshot } from "../services/dashboard.js";
import {
  callFollowUpNotes,
  enrichTimeline,
  scheduleFollowUp,
  unscheduledFollowUps,
} from "../services/leadActivity.js";
import {
  agentWorkspaces,
  earlierWorkRefusal,
  shownStates,
  workspaceLeads,
  workspaceReady,
  workspaceRecords,
} from "../services/leadWorkspace.js";
import { inventoryRouter } from "./inventory.routes.js";
import { sheetsAdminRouter } from "./sheets.routes.js";
import { leadInquiries } from "../services/sheetsImport.js";
const portalNames = { admin: "Admin", agent: "Agent", staff: "Staff" };
export function unwrap(r) {
  if (r.error)
    throw Object.assign(new Error("Database operation failed"), {
      status:
        r.error.code === "23505"
          ? 409
          : r.error.code === "42501"
            ? 403
            : r.error.code === "P0002"
              ? 404
              : 400,
      code: r.error.code,
    });
  return r.data;
}
export async function ownedLead(db, user, id) {
  uuid.parse(id);
  let q = db.from("leads").select("*").eq("id", id);
  if (user.role !== "admin") q = q.eq("assigned_agent", user.id);
  const row = unwrap(await q.maybeSingle());
  if (!row || row.deleted_at)
    throw Object.assign(new Error("Record not found"), { status: 404 });
  return row;
}
export function crmRouter(db, options = {}) {
  const router = Router();
  router.use("/documents", documentsRouter(db));
  router.use(accountsRouter(db, options));
  router.use(securityRouter(db));
  // Before the sales router's /reports/:type. Administrators and agents
  // (their own numbers, update 051); staff never reach it.
  router.use("/reports/drilldown", reportDrilldownRouter(db));
  router.use(salesRouter(db));
  router.use("/attendance", attendanceRouter(db));
  router.use("/admin/attendance/shifts", adminOnly, shiftsAdminRouter(db));
  router.use("/admin/attendance", adminOnly, attendanceAdminRouter(db));
  router.use("/tasks", tasksRouter(db));
  router.use("/admin/tasks", adminOnly, tasksAdminRouter(db));
  router.use("/dealers", dealersRouter(db));
  router.use("/admin", adminOnly, employeesAdminRouter(db));
  router.use("/integrations/sheets", adminOnly, sheetsAdminRouter(db));
  router.use(inventoryRouter(db));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  });
  const mutate = async (req, table, id, data) =>
    unwrap(
      await db.rpc("crm_mutate", {
        p_table: table,
        p_id: id || null,
        p_data: data,
        p_actor: req.user.id,
        p_request: req.id,
      }),
    );
  router.get("/me", (req, res) => {
    const { portal } = z
      .object({ portal: z.enum(["agent", "admin", "staff"]).optional() })
      .strict()
      .parse(req.query);
    if (portal && req.user.role !== portal)
      return res.status(403).json({
        error: `This account cannot sign in to the ${portalNames[portal]} portal. Choose the correct portal for your account.`,
      });
    res.json({
      ...req.user,
      email: req.authUser.email,
      mfa_required: req.mfa.required,
      mfa_enrolled: req.mfa.enrolled,
      mfa_reset_pending: req.mfa.reset_pending,
    });
  });
  // Update 047: the signed-in employee's department, job title and shift.
  router.get("/profile", async (req, res) =>
    res.json(
      await attendanceRpc(
        db,
        "employee_me",
        { p_actor: req.user.id },
        "Profiles need CRM database update 047 after 046.",
      ),
    ),
  );
  router.get("/call-capabilities", (_req, res) => res.json(callCapabilities()));
  router.get("/users", adminOnly, async (req, res) =>
    res.json(
      unwrap(await db.from("profiles").select("*").order("name"))
        .filter((user) => !user.deleted_at)
        .map(({ id, uid, name, role, active }) => ({
          id,
          uid,
          name,
          role,
          active,
        })),
    ),
  );
  router.patch("/users/:id", adminOnly, async (req, res) => {
    res.status(403).json({
      error:
        "Manage accounts from the Accounts page after unlocking it with your PIN.",
    });
  });
  router.get("/reminders", async (req, res) =>
    res.json(
      unwrap(
        await db
          .from("reminders")
          .select(
            "*,followups!inner(lead_id,leads!inner(lead_no,name,assigned_agent,deleted_at))",
          )
          .eq("agent_id", req.user.id)
          .is("read_at", null)
          .is("followups.leads.deleted_at", null)
          .order("created_at", { ascending: false })
          .limit(100),
      ),
    ),
  );
  router.patch("/reminders/:id", async (req, res) =>
    res.json(
      unwrap(
        await db
          .from("reminders")
          .update({ read_at: new Date().toISOString() })
          .eq("id", uuid.parse(req.params.id))
          .eq("agent_id", req.user.id)
          .select("id"),
      ),
    ),
  );
  router.post("/leads", adminOnly, async (req, res) => {
    const { phone, ...data } = leadCreate.parse(req.body);
    res.status(201).json(
      await leadManagementRpc(db, "create_lead", {
        p_data: data,
        p_phone: normalizePhone(phone),
        p_actor: req.user.id,
        p_request: req.id,
      }),
    );
  });
  router.post(
    "/leads/import",
    adminOnly,
    sensitiveLimit,
    importLimit,
    upload.single("file"),
    async (req, res) => res.json(await importLeadFile(db, req)),
  );
  router.get("/lead-imports", async (req, res) => {
    const q = z
      .object({
        page: listQuery.shape.page,
        limit: listQuery.shape.limit,
        search: z.string().max(100).optional(),
      })
      .strict()
      .parse(req.query);
    res.json(
      await fileRpc(db, "lead_imports_page", {
        p_actor: req.user.id,
        p_page: q.page,
        p_limit: q.limit,
        p_search: q.search || "",
      }),
    );
  });
  router.get("/lead-imports/:id", async (req, res) => {
    const result = await fileRpc(db, "lead_import_summary", {
      p_import: uuid.parse(req.params.id),
      p_actor: req.user.id,
    });
    if (!result)
      throw Object.assign(new Error("File not found"), { status: 404 });
    res.json(result);
  });
  router.post(
    "/lead-imports/:id/assign",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      const { agent_id } = z
        .object({ agent_id: uuid })
        .strict()
        .parse(req.body);
      res.json(
        await fileRpc(db, "assign_lead_import", {
          p_import: uuid.parse(req.params.id),
          p_agent: agent_id,
          p_actor: req.user.id,
          p_request: req.id,
        }),
      );
    },
  );
  const deleteReason = z.string().trim().min(3).max(300);
  router.post(
    "/leads/delete-preview",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      const body = z
        .union([
          z.object({ lead_ids: leadIds }).strict(),
          z.object({ import_id: uuid }).strict(),
        ])
        .parse(req.body);
      res.json(
        await leadManagementRpc(db, "lead_delete_preview", {
          p_actor: req.user.id,
          p_leads: body.lead_ids || null,
          p_import: body.import_id || null,
        }),
      );
    },
  );
  router.get("/leads/deleted", adminOnly, sensitiveLimit, async (req, res) => {
    const q = z
      .object({
        page: listQuery.shape.page,
        limit: listQuery.shape.limit,
        search: z.string().max(100).default(""),
      })
      .strict()
      .parse(req.query);
    res.json(
      await leadManagementRpc(db, "deleted_leads_page", {
        p_actor: req.user.id,
        p_page: q.page,
        p_limit: q.limit,
        p_search: q.search,
      }),
    );
  });
  router.post("/leads/delete", adminOnly, sensitiveLimit, async (req, res) => {
    z.object({}).strict().parse(req.query);
    const body = z
      .object({ lead_ids: leadIds, reason: deleteReason })
      .strict()
      .parse(req.body);
    res.json(
      await leadManagementRpc(db, "delete_leads", {
        p_lead_ids: body.lead_ids,
        p_actor: req.user.id,
        p_reason: body.reason,
        p_request: req.id,
      }),
    );
  });
  router.post("/leads/restore", adminOnly, sensitiveLimit, async (req, res) => {
    z.object({}).strict().parse(req.query);
    const body = z.object({ lead_ids: leadIds }).strict().parse(req.body);
    res.json(
      await leadManagementRpc(db, "restore_leads", {
        p_lead_ids: body.lead_ids,
        p_actor: req.user.id,
        p_request: req.id,
      }),
    );
  });
  router.delete(
    "/lead-imports/:id",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      z.object({}).strict().parse(req.query);
      const body = z
        .object({
          mode: z.enum(["file_only", "file_and_leads"]),
          reason: deleteReason,
        })
        .strict()
        .parse(req.body);
      res.json(
        await leadManagementRpc(db, "delete_lead_import", {
          p_import: uuid.parse(req.params.id),
          p_actor: req.user.id,
          p_mode: body.mode,
          p_reason: body.reason,
          p_request: req.id,
        }),
      );
    },
  );
  router.get(
    "/deleted-lead-imports",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      z.object({}).strict().parse(req.query);
      res.json(
        await leadManagementRpc(db, "deleted_imports_page", {
          p_actor: req.user.id,
        }),
      );
    },
  );
  router.post(
    "/lead-imports/:id/restore",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      z.object({}).strict().parse(req.query);
      z.object({}).strict().parse(req.body);
      res.json(
        await leadManagementRpc(db, "restore_lead_import", {
          p_import: uuid.parse(req.params.id),
          p_actor: req.user.id,
          p_request: req.id,
        }),
      );
    },
  );
  router.post(
    "/leads/assign-bulk",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      z.object({}).strict().parse(req.query);
      const body = bulkAssignment.parse(req.body);
      res.json(
        await leadManagementRpc(db, "assign_leads_bulk", {
          p_lead_ids: body.lead_ids,
          p_actor: req.user.id,
          p_mode: body.mode,
          p_agent: body.agent_id || null,
          p_request: req.id,
        }),
      );
    },
  );
  router.patch(
    "/leads/:id/phone",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      z.object({}).strict().parse(req.query);
      const { phone } = z
        .object({ phone: z.string().min(10).max(30) })
        .strict()
        .parse(req.body);
      await leadManagementRpc(db, "update_lead_phone", {
        p_lead: uuid.parse(req.params.id),
        p_phone: normalizePhone(phone),
        p_actor: req.user.id,
        p_request: req.id,
      });
      res.status(204).end();
    },
  );
  // Returns lead IDs only: an expensive count-and-filter search, limited like
  // reports so distributing a batch to many agents leaves room for changes.
  // An agent's own leads (update 052): Assigned leads, or the Lead pipeline
  // of leads with an answered call. Search, filters, counts and pages are
  // worked out in the database across every page; the database refuses
  // anyone but an active agent. Numbers are shown as in the leads list.
  router.get("/my-leads", async (req, res) => {
    if (req.user.role !== "agent")
      return res.status(403).json({ error: "Agent access required" });
    const { import_id, ...q } = agentLeadsQuery.parse(req.query);
    if (
      import_id &&
      !(await fileRpc(db, "lead_import_summary", {
        p_import: import_id,
        p_actor: req.user.id,
      }))
    )
      throw Object.assign(new Error("File not found"), { status: 404 });
    const result = await salesRpc(
      db,
      "agent_lead_list",
      {
        p_actor: req.user.id,
        p_query: { ...q, ...(import_id ? { import: import_id } : {}) },
      },
      "053 after 052",
    );
    // Update 055: My pipeline and Personally contacted, and who recorded
    // the latest answered call of each lead on the page when it was not
    // the agent. Before 055 the pipeline shows as it did.
    let attribution = null;
    if (result.view === "pipeline") {
      const { data, error } = await db.rpc("agent_pipeline_attribution", {
        p_actor: req.user.id,
        p_leads: result.data.map((row) => row.id),
      });
      if (!error) attribution = data;
      else if (!["PGRST202", "42883"].includes(error.code))
        throw Object.assign(
          new Error("The pipeline could not be loaded. Please try again."),
          { status: 503 },
        );
    }
    const rows = await leadContacts(db, req, result.data);
    res.set("Cache-Control", "no-store").json({
      ...result,
      ...(attribution && {
        pipeline_counts: {
          pipeline: attribution.pipeline,
          personally_contacted: attribution.personally_contacted,
        },
      }),
      data: attribution
        ? rows.map((row) => ({
            ...row,
            answered_by: attribution.answered_by[row.id] || null,
          }))
        : rows,
    });
  });
  // Administrators' Lead pipeline, agent by agent (update 055): the agents
  // with their numbers, then one agent's pipeline, or the leads the agent
  // spoke to that are now someone else's. The database checks the
  // administrator again and works out who spoke to each lead.
  router.get("/pipeline/agents", adminOnly, async (req, res) => {
    const q = pipelineAgentsQuery.parse(req.query);
    res
      .set("Cache-Control", "no-store")
      .json(
        await salesRpc(
          db,
          "admin_pipeline_agents",
          { p_actor: req.user.id, p_query: q },
          "055 after 054",
        ),
      );
  });
  router.get("/pipeline/agents/:agent", adminOnly, async (req, res) => {
    const agent = uuid.parse(req.params.agent);
    const q = agentPipelineQuery.parse(req.query);
    const result = await salesRpc(
      db,
      "admin_agent_pipeline",
      { p_actor: req.user.id, p_agent: agent, p_query: q },
      "055 after 054",
    );
    res.set("Cache-Control", "no-store").json({
      ...result,
      data: await leadContacts(db, req, result.data),
    });
  });
  // Administrators' All leads (update 057): search, filters, counts and
  // pages are worked out in the database across every lead; numbers are
  // added as in every lead list. With selection, the IDs of up to 500
  // matching leads.
  // The call outcome and temperature filters are update 058's: the list of
  // 057 refuses them, after this server has already checked them.
  const adminLeads = async (req, ids) => {
    const { import_id, page, ...q } = adminLeadsQuery.parse(req.query);
    try {
      return await salesRpc(
        db,
        "admin_lead_list",
        {
          p_actor: req.user.id,
          p_query: {
            ...q,
            ...(import_id ? { import: import_id } : {}),
            ...(ids ? { ids: true } : { page }),
          },
        },
        "057 after 056",
      );
    } catch (error) {
      if (
        q.call === "not_connected" &&
        error.message === "Choose valid lead filters"
      )
        throw Object.assign(
          new Error("This filter needs CRM database update 063 after 062."),
          { status: 503 },
        );
      if (
        (q.outcome || q.temperature) &&
        error.message === "Choose valid lead filters"
      )
        throw Object.assign(
          new Error("This filter needs CRM database update 058 after 057."),
          { status: 503 },
        );
      throw error;
    }
  };
  router.get("/leads/all", adminOnly, async (req, res) => {
    const result = await adminLeads(req, false);
    res.set("Cache-Control", "no-store").json({
      ...result,
      data: await leadContacts(db, req, result.data),
    });
  });
  router.get("/leads/all/selection", adminOnly, reportLimit, async (req, res) =>
    res.json({ ids: (await adminLeads(req, true)).ids }),
  );
  // Assigns the selected leads that have no agent (update 057), never one
  // that has: the database skips and names those, and reports each lead.
  router.post(
    "/leads/assign-unassigned",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      const body = unassignedAssignment.parse(req.body);
      res.json(
        await salesRpc(
          db,
          "assign_unassigned_leads",
          {
            p_lead_ids: body.lead_ids,
            p_actor: req.user.id,
            p_mode: body.mode,
            p_agent: body.agent_id || null,
            p_request: req.id,
          },
          "057 after 056",
        ),
      );
    },
  );
  // Moves the selected leads to one agent, whoever has them now (update
  // 060): the database reports each as assigned, reassigned, not changed
  // (already that agent's) or failed.
  router.post(
    "/leads/assign-selected",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      const body = selectedAssignment.parse(req.body);
      res.json(
        await salesRpc(
          db,
          "admin_assign_leads",
          {
            p_lead_ids: body.lead_ids,
            p_actor: req.user.id,
            p_agent: body.agent_id,
            p_request: req.id,
          },
          "060 after 059",
        ),
      );
    },
  );
  // Shares the selected leads among the chosen agents in turn, or gives them
  // to one agent, moving leads other agents have too (update 062). The
  // preview changes nothing; carrying it out works the plan out again under
  // the assignment lock, and returns the new plan instead (stale) if the
  // leads or agents changed since the preview.
  for (const [path, apply, limit] of [
    ["/leads/distribute/preview", false, reportLimit],
    ["/leads/distribute", true, sensitiveLimit],
  ])
    router.post(path, adminOnly, limit, async (req, res) => {
      const body = leadDistribution.parse(req.body);
      res.json(
        await salesRpc(
          db,
          "admin_distribute_leads",
          {
            p_actor: req.user.id,
            p_lead_ids: body.lead_ids,
            p_agents: body.agent_ids,
            p_apply: apply,
            p_token: body.token || null,
            p_request: req.id,
          },
          "062 after 061",
        ),
      );
    });
  router.get("/leads/selection", adminOnly, reportLimit, async (req, res) => {
    const q = listQuery.parse(req.query);
    let query = db
      .from("leads")
      .select("id", { count: "exact" })
      .is("deleted_at", null);
    if (q.search) {
      const number = q.search.replace(/^HD-/i, "");
      query =
        /^\d+$/.test(number) && BigInt(number) <= 9223372036854775807n
          ? query.or(`name.ilike.%${q.search}%,lead_no.eq.${BigInt(number)}`)
          : query.ilike("name", "%" + q.search + "%");
    }
    for (const [field, value] of [
      ["status", q.status],
      ["lost_reason", q.lost_reason],
      ["source", q.source],
      ["assigned_agent", q.agent],
      ["import_id", q.import_id],
    ])
      if (value) query = query.eq(field, value);
    const result = await query.order("id").limit(501);
    const rows = unwrap(result);
    if (result.count > 500 || rows.length > 500)
      throw Object.assign(
        new Error("Narrow your filter to 500 matching leads or fewer."),
        { status: 400 },
      );
    res.json({ ids: rows.map((row) => row.id) });
  });
  router.get("/leads/:id/phone", sensitiveLimit, async (req, res) => {
    phoneRevealQuery.parse(req.query);
    const [result] = await leadContacts(db, req, [
      { id: uuid.parse(req.params.id) },
    ]);
    req.phoneRevealResponse = true;
    res.set("Cache-Control", "no-store").json({ phone: result.phone });
  });
  // Update 054: an agent corrects the name of a lead assigned to them now; an
  // administrator, of any lead. The database checks both and records the
  // name before and after in the audit.
  router.put("/leads/:id/name", sensitiveLimit, async (req, res) => {
    const id = uuid.parse(req.params.id);
    const body = leadName.safeParse(req.body);
    if (!body.success)
      return res.status(400).json({ error: body.error.issues[0].message });
    const { data, error } = await db.rpc("lead_rename", {
      p_lead: id,
      p_actor: req.user.id,
      p_name: body.data.name,
      p_request: req.id,
    });
    if (error) {
      const custom = /^HA(\d{3})$/.exec(error.code || "");
      const missing = ["PGRST202", "42883"].includes(error.code);
      throw Object.assign(
        new Error(
          custom
            ? error.message
            : missing
              ? "Editing names needs CRM database update 054."
              : "The name could not be saved. Please try again.",
        ),
        { status: custom ? Number(custom[1]) : 503 },
      );
    }
    res.json(data);
  });
  router.post("/leads/:id/assign", adminOnly, async (req, res) => {
    const body = z
      .object({ agent_id: uuid.nullable().optional() })
      .strict()
      .parse(req.body);
    res.json({
      agent_id: unwrap(
        await assign(db, req, uuid.parse(req.params.id), body.agent_id),
      ),
    });
  });
  // What the customer submitted through an advertisement's Google Sheet
  // (update 056): administrators and the lead's agent, as the database
  // checks (404 otherwise).
  router.get("/leads/:id/inquiries", async (req, res) =>
    res.json(await leadInquiries(db, req.user, uuid.parse(req.params.id))),
  );
  router.get("/leads/:id/timeline", async (req, res) => {
    const lead = await ownedLead(db, req.user, req.params.id);
    // Update 061: on a lead reassigned to them, an agent sees the current
    // assignment only; administrators see everything.
    const since =
      (await agentWorkspaces(db, req.user, [lead.id]))?.get(lead.id)?.since ||
      null;
    const timeline = [];
    for (const table of [
      "notes",
      "calls",
      "followups",
      "visits",
      "deals",
      "assignments",
      "lead_status_history",
    ]) {
      let query = db
        .from(table)
        .select(since ? "*,workspace_state" : "*")
        .eq("lead_id", lead.id);
      if (since) query = query.in("workspace_state", shownStates);
      const data = unwrap(
        await query.order("created_at", { ascending: false }).limit(100),
      );
      // The first stage change of the assignment started from the earlier
      // assignment's stage, which is not shown.
      if (since && table === "lead_status_history" && data.length)
        data[data.length - 1] = { ...data.at(-1), from_status: null };
      timeline.push(
        ...(since ? workspaceRecords(data) : data).map((item) => ({
          ...item,
          kind: table,
        })),
      );
    }
    // Who did what comes from the audit log. If that lookup fails, the
    // activity itself is still shown, without the names.
    let items;
    try {
      items = await enrichTimeline(db, lead, timeline, since);
    } catch {
      console.error("Lead timeline shown without activity details");
      items = timeline.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    res.json(items);
  });
  // A call that ends with a promise to follow up schedules the follow-up. The
  // call is kept even if scheduling fails; the response then says so instead
  // of reporting success, so the call is not logged twice on a retry.
  const withFollowUp = async (req, leadId, dueAt, call, saved) => {
    if (!dueAt) return saved;
    try {
      return {
        ...saved,
        followup: await scheduleFollowUp(
          db,
          mutate,
          req,
          leadId,
          dueAt,
          callFollowUpNotes(call),
        ),
      };
    } catch (error) {
      return {
        ...saved,
        followup_error:
          error.message === "Forbidden"
            ? "You can no longer schedule follow-ups for this lead"
            : "The follow-up could not be saved.",
        // So the follow-up alone can be saved again, never the call.
        followup_due_at: new Date(dueAt).toISOString(),
        followup_notes: callFollowUpNotes(call),
      };
    }
  };
  const needsFollowUpTime = () =>
    Object.assign(
      new Error(
        "Choose when to follow up: a call marked Follow-up required schedules the follow-up",
      ),
      { status: 400 },
    );
  router.get("/followups/unscheduled", async (req, res) =>
    res.json(await unscheduledFollowUps(db, req.user)),
  );
  router.post("/leads/:id/calls/manual", sensitiveLimit, async (req, res) => {
    const lead = await ownedLead(db, req.user, req.params.id);
    const { follow_up_at: followUp, ...data } = manualCall(req.user.role).parse(
      req.body,
    );
    if (data.outcome === followUpOutcome && !followUp)
      throw needsFollowUpTime();
    const result = await db.rpc("log_manual_call", {
      p_lead: lead.id,
      p_actor: req.user.id,
      p_data: data,
      p_request: req.id,
    });
    if (["PGRST202", "42883"].includes(result.error?.code))
      throw Object.assign(
        new Error(
          "Manual call logging needs database migration 018. Ask your administrator to apply the CRM update.",
        ),
        { status: 503 },
      );
    res
      .status(201)
      .json(await withFollowUp(req, lead.id, followUp, data, unwrap(result)));
  });
  router.post("/leads/:id/call", sensitiveLimit, async (req, res) => {
    if (!callCapabilities().mock)
      throw Object.assign(
        new Error(
          "Calling is unavailable. Use Log a call to record a phone conversation.",
        ),
        { status: 404 },
      );
    const lead = await ownedLead(db, req.user, req.params.id);
    const provider = callingProvider();
    // Persist intent before external side effects. Provider must support idempotency by this call ID.
    const row = await mutate(req, "calls", null, {
      lead_id: lead.id,
      status: "initiated",
    });
    try {
      const phone = unwrap(await db.rpc("private_phone", { p_lead: lead.id }));
      const call = await provider.initiate({
        destination: phone,
        agent: req.user.id,
        idempotencyKey: row.id,
      });
      res.status(201).json({
        ...(await mutate(req, "calls", row.id, {
          provider_call_id: call.id,
          status: call.status,
        })),
        provider: provider.name,
      });
    } catch (e) {
      await mutate(req, "calls", row.id, { status: "failed" });
      throw e;
    }
  });
  router.post("/calls/:id/mock-complete", async (req, res) => {
    if (
      process.env.NODE_ENV === "production" ||
      process.env.CALL_PROVIDER !== "mock"
    )
      throw Object.assign(new Error("Mock disabled"), { status: 404 });
    const call = unwrap(
      await db
        .from("calls")
        .select("*")
        .eq("id", uuid.parse(req.params.id))
        .single(),
    );
    await ownedLead(db, req.user, call.lead_id);
    if (!call.provider_call_id?.startsWith("mock-"))
      throw Object.assign(new Error("Not a mock call"), { status: 400 });
    res.json(
      await mutate(req, "calls", call.id, {
        status: "completed",
        ended_at: new Date().toISOString(),
        duration_seconds: Math.max(
          0,
          Math.floor((Date.now() - Date.parse(call.started_at)) / 1000),
        ),
      }),
    );
  });
  router.get(
    "/calls/:id/recording",
    adminOnly,
    sensitiveLimit,
    async (req, res) => {
      uuid.parse(req.params.id);
      const result = unwrap(
        await db.rpc("recording_access", { p_call: req.params.id }),
      );
      if (!result?.storage_path)
        throw Object.assign(new Error("Recording unavailable or expired"), {
          status: 404,
        });
      await audit(db, req, "playback", "calls", req.params.id);
      res
        .set("Cache-Control", "no-store")
        .json(
          unwrap(
            await db.storage
              .from("recordings")
              .createSignedUrl(result.storage_path, 60),
          ),
        );
    },
  );
  const reportQuery = z
    .object({
      from: z.iso.datetime({ offset: true }),
      to: z.iso.datetime({ offset: true }),
      agent: uuid.optional(),
      source: z.enum(["manual", "CSV", "Meta", "WhatsApp", "other"]).optional(),
    })
    .strict()
    .refine((v) => v.from < v.to, { message: "Date range must be increasing" });
  router.get("/dashboard", reportLimit, async (req, res) => {
    const range = z
      .object({
        from: z.iso.datetime({ offset: true }),
        to: z.iso.datetime({ offset: true }),
      })
      .strict()
      .refine((value) => Date.parse(value.from) < Date.parse(value.to))
      .parse(req.query);
    res.json(await dashboardSnapshot(db, req.user, range));
  });
  router.get("/reports", reportLimit, async (req, res) => {
    const q = reportQuery.parse(req.query);
    res.json(
      unwrap(
        await db.rpc("crm_metrics", {
          p_actor: req.user.id,
          p_from: q.from,
          p_to: q.to,
          p_agent: q.agent || null,
          p_source: q.source || null,
        }),
      ),
    );
  });
  router.get("/reports/export", adminOnly, exportLimit, async (req, res) => {
    const q = reportQuery.parse(req.query);
    const data = unwrap(
      await db.rpc("crm_metrics", {
        p_actor: req.user.id,
        p_from: q.from,
        p_to: q.to,
        p_agent: q.agent || null,
        p_source: q.source || null,
      }),
    );
    res
      .type("text/csv")
      .attachment("hd-marketing-report.csv")
      .send(
        "metric,value\r\n" +
          Object.entries(data)
            .filter(([, v]) => typeof v === "number")
            .map(([k, v]) => [csvCell(k), csvCell(v)].join(","))
            .join("\r\n"),
      );
  });
  router.get("/leaderboard", reportLimit, async (req, res) => {
    const q = reportQuery.parse(req.query);
    res.json(
      unwrap(
        await db.rpc("crm_leaderboard", {
          p_actor: req.user.id,
          p_from: q.from,
          p_to: q.to,
        }),
      ),
    );
  });
  // Audit history (update 043): one query per page resolves every person and
  // record; entries are described in plain English and their metadata is
  // sanitized before it leaves the server. Audit entries are only read.
  const auditRpc = async (name, args) => {
    const result = await db.rpc(name, args);
    if (["PGRST202", "42883"].includes(result.error?.code))
      throw Object.assign(
        new Error("Audit history needs CRM database update 043."),
        { status: 503 },
      );
    return unwrap(result);
  };
  router.get("/audit", adminOnly, async (req, res) => {
    const q = auditQuery.parse(req.query);
    if (
      (q.module && !auditModules.some(([key]) => key === q.module)) ||
      (q.kind && !auditKinds.some(([key]) => key === q.kind))
    )
      throw Object.assign(new Error("Unknown activity filter"), {
        status: 400,
      });
    // A module and action type that never occur together match nothing.
    const match = auditMatches(q);
    const page =
      match && !match.length
        ? { page: q.page, limit: q.limit, count: 0, data: [] }
        : await auditRpc("audit_page", {
            p_actor: req.user.id,
            p_filters: {
              sort: q.sort,
              ...(q.search ? { search: q.search } : {}),
              ...(q.from ? { from: q.from } : {}),
              ...(q.to ? { to: q.to } : {}),
              ...(q.actor ? { actor: q.actor } : {}),
              ...(match ? { match } : {}),
            },
            p_page: q.page,
            p_limit: q.limit,
          });
    res.json({
      ...page,
      data: page.data.map(presentAuditEntry),
      modules: auditModules.map(([key, label]) => ({ key, label })),
      kinds: auditKinds.map(([key, label]) => ({ key, label })),
    });
  });
  router.get("/audit/actors", adminOnly, async (req, res) => {
    const people = await auditRpc("audit_actors", { p_actor: req.user.id });
    res.json(
      people.map((p) => ({
        id: p.id,
        name: p.name + (p.deleted ? " (deleted account)" : ""),
        detail: [
          p.role === "admin" ? "Admin" : "Agent",
          p.uid ? `UID ${p.uid}` : null,
        ]
          .filter(Boolean)
          .join(" · "),
      })),
    );
  });
  for (const table of [
    "leads",
    "calls",
    "targets",
    "followups",
    "visits",
    "deals",
  ]) {
    router.get("/" + table, async (req, res) => {
      const q = listQuery.parse(req.query);
      let query = db
        .from(table)
        .select(
          ["calls", "followups", "visits", "deals"].includes(table)
            ? "*,leads!inner(lead_no,name,assigned_agent)"
            : "*",
          { count: "exact" },
        );
      // Update 061: an agent's records leave out earlier assignments' work
      // on leads reassigned to them.
      const scoped =
        !["leads", "targets"].includes(table) &&
        (await workspaceReady(db, req.user));
      if (req.user.role !== "admin") {
        if (table === "leads") query = query.eq("assigned_agent", req.user.id);
        else if (table === "targets") query = query.eq("agent_id", req.user.id);
        else {
          query = db
            .from(table)
            .select(
              "*," +
                (scoped ? "workspace_state," : "") +
                "leads!inner(lead_no,name,assigned_agent)",
              { count: "exact" },
            )
            .eq("leads.assigned_agent", req.user.id);
          if (scoped) query = query.in("workspace_state", shownStates);
        }
      }
      if (table === "leads") query = query.is("deleted_at", null);
      if (["calls", "followups", "visits", "deals"].includes(table))
        query = query.is("leads.deleted_at", null);
      if (q.search) {
        if (table !== "leads")
          throw Object.assign(new Error("Search not supported"), {
            status: 400,
          });
        const number = q.search.replace(/^HD-/i, "");
        query =
          table === "leads" &&
          /^\d+$/.test(number) &&
          BigInt(number) <= 9223372036854775807n
            ? query.or(`name.ilike.%${q.search}%,lead_no.eq.${BigInt(number)}`)
            : query.ilike("name", "%" + q.search + "%");
      }
      if (q.status) {
        if (!["leads", "calls", "followups", "visits"].includes(table))
          throw Object.assign(new Error("Status not supported"), {
            status: 400,
          });
        query = query.eq("status", q.status);
      }
      if (q.method) {
        if (table !== "calls")
          throw Object.assign(
            new Error("Method filter is only available for calls"),
            { status: 400 },
          );
        query = query.eq("method", q.method);
      }
      if (q.import_id) {
        if (table !== "leads")
          throw Object.assign(
            new Error("File filter is only available for leads"),
            { status: 400 },
          );
        const file = await fileRpc(db, "lead_import_summary", {
          p_import: q.import_id,
          p_actor: req.user.id,
        });
        if (!file)
          throw Object.assign(new Error("File not found"), { status: 404 });
        query = query.eq("import_id", q.import_id);
      }
      if (q.source && table === "leads") query = query.eq("source", q.source);
      if (q.lost_reason) {
        if (table !== "leads")
          throw Object.assign(
            new Error("Lost reason filter is only available for leads"),
            { status: 400 },
          );
        query = query.eq("lost_reason", q.lost_reason);
      }
      // A follow-up belongs to the lead's current owner, as agents see it.
      if (q.agent && req.user.role === "admin")
        query = query.eq(
          table === "leads"
            ? "assigned_agent"
            : table === "followups"
              ? "leads.assigned_agent"
              : "agent_id",
          q.agent,
        );
      if (q.call) {
        if (table !== "leads")
          throw Object.assign(
            new Error("First-call filter is only available for leads"),
            { status: 400 },
          );
        // Open leads still waiting for the owner's first call (update 038).
        query = query
          .is("first_call_at", null)
          .not("call_due_at", "is", null)
          .not("assigned_agent", "is", null)
          .not("status", "in", "(won,lost)");
        const now = new Date().toISOString();
        query =
          q.call === "missed"
            ? query.lt("call_due_at", now)
            : query.gte("call_due_at", now);
      }
      if (q.view && table === "followups") {
        const now = new Date().toISOString();
        if (q.view === "completed" || q.view === "cancelled")
          query = query.eq("status", q.view);
        else {
          query = query.eq("status", "pending");
          if (q.view === "overdue") query = query.lt("due_at", now);
          else if (q.view === "upcoming") query = query.gt("due_at", now);
          else if (q.view === "due")
            query = query.lte(
              "due_at",
              new Date(Date.now() + 86400000).toISOString(),
            );
        }
      }
      const sort =
        q.sort === "name"
          ? table === "leads"
            ? "name"
            : "created_at"
          : q.sort === "updated_at" && ["calls", "targets"].includes(table)
            ? "created_at"
            : (q.sort === "call_due_at" && table !== "leads") ||
                (q.sort === "due_at" && table !== "followups")
              ? "created_at"
              : q.sort;
      const result = await query
        .order(sort, { ascending: q.direction === "asc" })
        .order("id", { ascending: q.direction === "asc" })
        .range((q.page - 1) * q.limit, q.page * q.limit - 1);
      res.json({
        data:
          table === "leads"
            ? await workspaceLeads(
                db,
                req.user,
                await leadContacts(db, req, unwrap(result)),
              )
            : scoped
              ? workspaceRecords(unwrap(result))
              : unwrap(result),
        count: result.count,
        page: q.page,
        limit: q.limit,
      });
    });
    if (table === "leads")
      router.get("/leads/:id", async (req, res) => {
        const lead = await ownedLead(db, req.user, req.params.id);
        const [contact] = await workspaceLeads(
          db,
          req.user,
          await leadContacts(db, req, [lead]),
        );
        res.json(contact);
      });
    if (!["leads", "calls"].includes(table))
      router.post("/" + table, async (req, res) => {
        if (table === "targets" && req.user.role !== "admin")
          return res
            .status(403)
            .json({ error: "Administrator access required" });
        const data = (table === "deals" ? dealCreate : schemas[table]).parse(
          req.body,
        );
        if (table === "deals" && data.stage === "won" && !data.close_date)
          throw Object.assign(new Error("Won deals require close date"), {
            status: 400,
          });
        res.status(201).json(await mutate(req, table, null, data));
      });
    router.patch("/" + table + "/:id", sensitiveLimit, async (req, res) => {
      const id = uuid.parse(req.params.id);
      if (table === "targets" && req.user.role !== "admin")
        return res.status(403).json({ error: "Administrator access required" });
      const parsed = (
        table === "leads"
          ? req.user.role === "agent"
            ? agentLeadUpdate
            : leadUpdate
          : table === "deals"
            ? dealUpdate
            : schemas[table].partial()
      ).parse(req.body);
      // Zod defaults can appear inside partial schemas. PATCH must change only
      // submitted fields, including when a visit/deal triggers a pipeline move.
      let data = Object.fromEntries(
        Object.entries(parsed).filter(([field]) =>
          Object.hasOwn(req.body, field),
        ),
      );
      let followUp;
      if (table === "calls") {
        ({ follow_up_at: followUp, ...data } = callOutcome.parse(req.body));
        data.outcome_submitted_at = new Date().toISOString();
        data.missing_outcome = false;
        // Choosing Follow-up required for a call schedules the follow-up.
        if (data.outcome === followUpOutcome && !followUp) {
          const before = unwrap(
            await db
              .from("calls")
              .select("lead_id,outcome")
              .eq("id", id)
              .maybeSingle(),
          );
          if (before) await ownedLead(db, req.user, before.lead_id);
          if (before && before.outcome !== followUpOutcome)
            throw needsFollowUpTime();
        }
      }
      // Update 061: an earlier assignment's work stays as it was recorded
      // (the database refuses it too; this says why).
      if (
        ["calls", "followups", "visits", "deals"].includes(table) &&
        (await workspaceReady(db, req.user))
      ) {
        const row = unwrap(
          await db
            .from(table)
            .select("workspace_state")
            .eq("id", id)
            .maybeSingle(),
        );
        const refusal = earlierWorkRefusal(
          table,
          row?.workspace_state,
          Object.keys(data).filter(
            (field) =>
              ![
                "outcome_submitted_at",
                "missing_outcome",
                "lead_id",
                "agent_id",
              ].includes(field),
          ),
        );
        if (refusal) throw Object.assign(new Error(refusal), { status: 403 });
      }
      if (
        table === "leads" &&
        req.user.role === "admin" &&
        (Object.hasOwn(data, "phone") || Object.hasOwn(data, "assigned_agent"))
      )
        return res.json(
          await leadManagementRpc(db, "edit_lead", {
            p_lead: id,
            p_data: data,
            p_actor: req.user.id,
            p_request: req.id,
          }),
        );
      const saved = await mutate(req, table, id, data);
      res.json(
        table === "calls" && followUp
          ? await withFollowUp(req, saved.lead_id, followUp, saved, saved)
          : saved,
      );
    });
  }
  router.post("/notes", async (req, res) =>
    res
      .status(201)
      .json(await mutate(req, "notes", null, schemas.notes.parse(req.body))),
  );
  return router;
}
