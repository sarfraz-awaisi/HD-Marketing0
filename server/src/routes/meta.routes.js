import { Router } from "express";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { digest } from "../services/accountsSecurity.js";
import { adminOnly } from "../middleware/role.js";
import {
  callbackLimit,
  reportLimit,
  sensitiveLimit,
} from "../middleware/rateLimit.js";
import { metaConfig, metaReady } from "../services/meta/config.js";
import { encryptToken, decryptToken } from "../services/meta/crypto.js";
import { graphClient, leadFields } from "../services/meta/graph.js";
import { metaRpc } from "../services/meta/rpc.js";
import {
  mappingTargets,
  normalizeSubmission,
} from "../services/meta/normalize.js";
const providerId = z.string().regex(/^\d{1,40}$/),
  uuid = z.string().uuid(),
  empty = z.object({}).strict();
export const requiredMetaPermissions = [
  "leads_retrieval",
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_metadata",
  "pages_manage_ads",
];
function cookieValue(req) {
  const value = (req.get("cookie") || "")
    .split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("hd_meta_state="));
  return value?.slice("hd_meta_state=".length) || "";
}
export function metaCallbackRouter(db, options = {}) {
  const router = Router();
  // Meta redirects the admin's browser here before any CRM sign-in check.
  router.get("/", callbackLimit, async (req, res) => {
    let config;
    try {
      config = metaConfig();
    } catch {
      return res.status(503).send("Meta connection is not configured.");
    }
    const redirect = new URL("/integrations/meta", config.frontend);
    let actor;
    try {
      const q = z
        .object({
          state: z.string().regex(/^[a-f0-9]{64}$/),
          code: z.string().min(1).max(3000).optional(),
          error: z.string().max(200).optional(),
          error_reason: z.string().max(200).optional(),
          error_description: z.string().max(2000).optional(),
        })
        .strict()
        .parse(req.query);
      actor = await metaRpc(db, "meta_oauth_consume", {
        p_state: digest(q.state),
        p_cookie: digest(cookieValue(req)),
      });
      if (!q.code || q.error) throw new Error();
      const graph = graphClient(config, options.metaFetch),
        token = await graph.request(
          "oauth/access_token",
          null,
          {
            client_id: config.appId,
            client_secret: config.secret,
            redirect_uri: config.callback,
            code: q.code,
          },
          "POST",
        );
      if (typeof token.access_token !== "string") throw new Error();
      const userToken = token.access_token;
      const debug = await graph.request(
        "debug_token",
        `${config.appId}|${config.secret}`,
        { input_token: userToken },
      );
      if (
        !debug.data?.is_valid ||
        String(debug.data.app_id) !== config.appId ||
        !debug.data.user_id
      )
        throw new Error();
      const scopes = debug.data.scopes || [];
      if (requiredMetaPermissions.some((p) => !scopes.includes(p)))
        throw new Error();
      const pages = await graph.list(
        "me/accounts",
        userToken,
        { fields: "id,name,access_token,tasks" },
        5,
      );
      const safe = [];
      for (const page of pages.data) {
        if (
          !providerId.safeParse(page.id).success ||
          typeof page.access_token !== "string"
        )
          continue;
        let instagram = {};
        try {
          const identity = await graph.request(page.id, page.access_token, {
            fields: "instagram_business_account{id,username}",
          });
          instagram = identity.instagram_business_account || {};
        } catch {
          /* Association is optional; attribution still comes from each lead. */
        }
        safe.push({
          id: page.id,
          name: String(page.name || page.id).slice(0, 250),
          instagram_id: instagram.id,
          instagram_name: instagram.username,
          ciphertext: encryptToken(
            page.access_token,
            config.key,
            "page:" + page.id,
          ),
        });
      }
      if (!safe.length) throw new Error();
      await metaRpc(db, "meta_save_connection", {
        p_actor: actor,
        p_data: {
          user_id: String(debug.data.user_id),
          scopes,
          expires_at: debug.data.expires_at
            ? new Date(debug.data.expires_at * 1000).toISOString()
            : null,
          ciphertext: encryptToken(
            userToken,
            config.key,
            "user:" + debug.data.user_id,
          ),
          pages: safe,
        },
        p_request: req.id,
      });
      redirect.searchParams.set("connection", "saved");
    } catch {
      redirect.searchParams.set("connection", "failed");
    }
    res.clearCookie("hd_meta_state", {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/api/integrations/meta/callback",
    });
    res.redirect(303, redirect.href);
  });
  return router;
}
export function metaRouter(db, options = {}) {
  const router = Router();
  router.use(adminOnly);
  const rpc = (name, args) => metaRpc(db, name, args),
    pageSecret = async (req, id) => {
      const page = await rpc("meta_page_secret", {
        p_actor: req.user.id,
        p_page: id,
      });
      if (!page)
        throw Object.assign(new Error("Connected Page not found."), {
          status: 404,
        });
      const config = metaConfig();
      return {
        page,
        config,
        token: decryptToken(page.ciphertext, config.key, "page:" + id),
        graph: graphClient(config, options.metaFetch),
      };
    };
  router.get("/settings", async (req, res) => {
    empty.parse(req.query);
    res.json({
      ...(await rpc("meta_settings", { p_actor: req.user.id })),
      configured: metaReady(),
    });
  });
  router.post("/connect", sensitiveLimit, async (req, res) => {
    empty.parse(req.body);
    const config = metaConfig(),
      state = randomBytes(32).toString("hex"),
      cookie = randomBytes(32).toString("hex");
    await rpc("meta_oauth_start", {
      p_actor: req.user.id,
      p_state: digest(state),
      p_cookie: digest(cookie),
      p_request: req.id,
    });
    res.cookie("hd_meta_state", cookie, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600000,
      path: "/api/integrations/meta/callback",
    });
    const url = new URL(
      `https://www.facebook.com/${config.version}/dialog/oauth`,
    );
    for (const [key, value] of Object.entries({
      client_id: config.appId,
      redirect_uri: config.callback,
      config_id: config.configId,
      response_type: "code",
      state,
      override_default_response_type: "true",
    }))
      url.searchParams.set(key, value);
    res.json({ url: url.href });
  });
  router.post("/pages/:id/forms", sensitiveLimit, async (req, res) => {
    empty.parse(req.body);
    const id = providerId.parse(req.params.id),
      { graph, token } = await pageSecret(req, id);
    const forms = await graph.list(
      id + "/leadgen_forms",
      token,
      { fields: "id,name,status,questions" },
      5,
    );
    const valid = forms.data
      .filter((f) => providerId.safeParse(f.id).success)
      .map((f) => ({
        id: f.id,
        name: String(f.name || f.id).slice(0, 250),
        questions: (f.questions || []).slice(0, 100).map((q) => ({
          key: String(q.key || q.id || "").slice(0, 200),
          label: String(q.label || q.key || "").slice(0, 500),
          type: String(q.type || "").slice(0, 50),
        })),
      }));
    await rpc("meta_save_forms", {
      p_actor: req.user.id,
      p_page: id,
      p_forms: valid,
      p_request: req.id,
    });
    res.json({ forms: valid.length, truncated: forms.truncated });
  });
  router.patch("/pages/:id", sensitiveLimit, async (req, res) => {
    const id = providerId.parse(req.params.id),
      { enabled } = z.object({ enabled: z.boolean() }).strict().parse(req.body),
      { graph, token, config } = await pageSecret(req, id);
    if (!enabled)
      await rpc("meta_configure", {
        p_actor: req.user.id,
        p_kind: "page",
        p_id: id,
        p_enabled: false,
        p_mapping: {},
        p_request: req.id,
      });
    try {
      const subscribed = await graph.request(id + "/subscribed_apps", token, {
          fields: "id,subscribed_fields",
        }),
        app = subscribed.data?.find((a) => String(a.id) === config.appId),
        fields = new Set(app?.subscribed_fields || []);
      if (enabled) fields.add("leadgen");
      else fields.delete("leadgen");
      if (fields.size)
        await graph.request(
          id + "/subscribed_apps",
          token,
          { subscribed_fields: [...fields].join(",") },
          "POST",
        );
      else if (app)
        await graph.request(id + "/subscribed_apps", token, {}, "DELETE");
      const verify = await graph.request(id + "/subscribed_apps", token, {
          fields: "id,subscribed_fields",
        }),
        active =
          verify.data?.some(
            (a) =>
              String(a.id) === config.appId &&
              a.subscribed_fields?.includes("leadgen"),
          ) === true;
      if (active !== enabled)
        throw Object.assign(
          new Error("Meta did not confirm the webhook subscription change."),
          { status: 502 },
        );
      await rpc("meta_configure", {
        p_actor: req.user.id,
        p_kind: "page",
        p_id: id,
        p_enabled: enabled,
        p_mapping: {},
        p_request: req.id,
      });
      res.json({ enabled, subscribed: active });
    } catch (error) {
      if (enabled) throw error;
      res.json({
        enabled: false,
        subscribed: false,
        warning:
          "Synchronization is paused locally. Meta could not confirm remote webhook removal; reconnect or remove the app in Meta Business Integrations.",
      });
    }
  });
  router.patch("/forms/:id", sensitiveLimit, async (req, res) => {
    const id = providerId.parse(req.params.id),
      data = z
        .object({
          enabled: z.boolean(),
          mapping: z
            .record(z.string().max(200), z.enum([...mappingTargets, ""]))
            .refine((m) => Object.keys(m).length <= 100),
        })
        .strict()
        .parse(req.body);
    await rpc("meta_configure", {
      p_actor: req.user.id,
      p_kind: "form",
      p_id: id,
      p_enabled: data.enabled,
      p_mapping: Object.fromEntries(
        Object.entries(data.mapping).filter(([, v]) => v),
      ),
      p_request: req.id,
    });
    res.json({ saved: true });
  });
  router.post("/forms/:id/sync", sensitiveLimit, async (req, res) => {
    const id = providerId.parse(req.params.id),
      data = z
        .object({ days: z.number().int().min(1).max(7).default(1) })
        .strict()
        .parse(req.body),
      settings = await rpc("meta_settings", { p_actor: req.user.id }),
      form = settings.forms.find((f) => f.id === id);
    if (!form?.enabled)
      throw Object.assign(new Error("Enable the form before synchronizing."), {
        status: 400,
      });
    const { graph, token } = await pageSecret(req, form.page_id);
    const since = Math.floor(Date.now() / 1000) - data.days * 86400;
    const leads = await graph.list(
      id + "/leads",
      token,
      {
        fields: "id,created_time",
        filtering: JSON.stringify([
          { field: "time_created", operator: "GREATER_THAN", value: since },
        ]),
      },
      3,
    );
    const events = leads.data
      .filter(
        (l) =>
          providerId.safeParse(l.id).success &&
          Date.parse(l.created_time) >= since * 1000,
      )
      .map((l) => ({
        lead_id: l.id,
        page_id: form.page_id,
        form_id: id,
        submitted_at: new Date(l.created_time).toISOString(),
      }));
    const result = await rpc("meta_enqueue", { p_events: events });
    res.json({ ...result, truncated: leads.truncated, checked: events.length });
  });
  router.delete("/connections/:id", sensitiveLimit, async (req, res) => {
    empty.parse(req.body);
    const id = uuid.parse(req.params.id);
    await rpc("meta_disconnect", {
      p_actor: req.user.id,
      p_id: id,
      p_request: req.id,
    });
    res.json({
      disconnected: true,
      message:
        "Local synchronization stopped and stored credentials removed. You may also remove this app from Meta Business Integrations.",
    });
  });
  router.get("/summary", async (req, res) => {
    empty.parse(req.query);
    res.json(await rpc("meta_summary", { p_actor: req.user.id }));
  });
  router.get("/inbox", async (req, res) => {
    const filters = z
      .object({
        page: z.coerce.number().int().min(1).max(100000).default(1),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        search: z.string().max(100).optional(),
        platform: z.enum(["facebook", "instagram", "meta"]).optional(),
        status: z
          .enum([
            "queued",
            "processing",
            "retry",
            "created",
            "duplicate",
            "review",
            "failed",
          ])
          .optional(),
        campaign: providerId.optional(),
        form: providerId.optional(),
        assignment: z.enum(["assigned", "unassigned"]).optional(),
        from: z.iso.datetime({ offset: true }).optional(),
        to: z.iso.datetime({ offset: true }).optional(),
        sort: z.enum(["newest", "oldest"]).default("newest"),
      })
      .strict()
      .parse(req.query);
    res.json(
      await rpc("meta_inbox", {
        p_actor: req.user.id,
        p_filters: filters,
        p_request: req.id,
      }),
    );
  });
  router.get("/submissions/:id", async (req, res) => {
    res.json(
      await rpc("meta_submission", {
        p_actor: req.user.id,
        p_id: uuid.parse(req.params.id),
        p_request: req.id,
      }),
    );
  });
  router.post("/submissions/:id/retry", sensitiveLimit, async (req, res) => {
    empty.parse(req.body);
    await rpc("meta_retry", {
      p_actor: req.user.id,
      p_id: uuid.parse(req.params.id),
      p_request: req.id,
    });
    res.json({ queued: true });
  });
  router.post("/submissions/:id/resolve", sensitiveLimit, async (req, res) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(200),
        phone: z.string().min(10).max(30),
        email: z.union([z.email(), z.literal("")]).optional(),
        preferred_location: z.string().max(200).optional(),
        budget_min: z.number().nonnegative().max(1e13).optional(),
        budget_max: z.number().nonnegative().max(1e13).optional(),
      })
      .strict()
      .parse(req.body);
    const normalized = normalizeSubmission({
      field_data: Object.entries(input).map(([name, value]) => ({
        name,
        values: [String(value)],
      })),
    });
    if (normalized.reason)
      throw Object.assign(new Error("Enter a valid customer name and phone."), {
        status: 400,
      });
    if (input.budget_min === undefined) delete normalized.data.budget_min;
    res.json(
      await rpc("meta_resolve", {
        p_actor: req.user.id,
        p_id: uuid.parse(req.params.id),
        p_data: normalized.data,
        p_request: req.id,
      }),
    );
  });
  router.post("/assign", sensitiveLimit, async (req, res) => {
    const data = z
      .object({
        lead_ids: z
          .array(uuid)
          .min(1)
          .max(100)
          .refine((ids) => new Set(ids).size === ids.length),
        agent_id: uuid,
      })
      .strict()
      .parse(req.body);
    res.json(
      await rpc("meta_assign", {
        p_actor: req.user.id,
        p_leads: data.lead_ids,
        p_agent: data.agent_id,
        p_request: req.id,
      }),
    );
  });
  router.post("/notices/:id/read", async (req, res) => {
    empty.parse(req.body);
    await rpc("meta_read_notice", {
      p_actor: req.user.id,
      p_id: uuid.parse(req.params.id),
    });
    res.status(204).end();
  });
  router.get("/report", reportLimit, async (req, res) => {
    const data = z
      .object({
        from: z.iso.datetime({ offset: true }),
        to: z.iso.datetime({ offset: true }),
      })
      .strict()
      .parse(req.query);
    res.json(
      await rpc("meta_report", {
        p_actor: req.user.id,
        p_from: data.from,
        p_to: data.to,
      }),
    );
  });
  return router;
}
