import express from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { auth } from "./middleware/auth.js";
import { createApiLimiters } from "./middleware/rateLimit.js";
import { crmRouter } from "./routes/crm.routes.js";
import { webhooksRouter } from "./routes/webhooks.routes.js";
import { protectAgentPhones } from "./middleware/phoneProtection.js";
import { onboardingRouter } from "./routes/onboarding.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { mfaRouter } from "./routes/mfa.routes.js";
import { metaWebhookRouter } from "./routes/metaWebhook.routes.js";
import { metaCallbackRouter, metaRouter } from "./routes/meta.routes.js";
import { trustProxy } from "./config/runtime.js";
import { healthRouter } from "./routes/health.routes.js";
export function createApp(db, options = {}) {
  const app = express();
  // Production reads the RATE_LIMIT_* settings (docs/RATE_LIMITS.md);
  // options.rateLimits lets tests use small limits. Route modules reach these
  // limiters through the policy middleware in rateLimit.js.
  const limits = createApiLimiters(options.rateLimits);
  app.locals.rateLimiters = limits;
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy(process.env.TRUST_PROXY || "loopback"));
  app.use(helmet());
  app.use(
    cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }),
  );
  app.use((req, res, next) => {
    req.id = randomUUID();
    if (process.env.NODE_ENV === "production") {
      const started = performance.now();
      res.once("finish", () =>
        console.log(
          JSON.stringify({
            event: "request",
            request_id: req.id,
            method: req.method,
            status: res.statusCode,
            duration_ms: Math.round(performance.now() - started),
            release: process.env.RELEASE_SHA || "unknown",
          }),
        ),
      );
    }
    res.set("X-Request-ID", req.id);
    if (/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA || ""))
      res.set("X-Release-SHA", process.env.RELEASE_SHA);
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/ready", async (_req, res) => {
    if (options.lifecycle?.draining)
      return res.status(503).json({ status: "draining" });
    try {
      const { error } = await db
        .from("profiles")
        .select("id")
        .limit(1)
        .abortSignal(AbortSignal.timeout(5000));
      if (error) throw new Error("Database unavailable");
      res.json({
        status: "ready",
        release: process.env.RELEASE_SHA || "development",
      });
    } catch {
      res.status(503).json({ status: "unavailable" });
    }
  });
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use(
    "/api/integrations/meta/webhook",
    limits.metaWebhook,
    express.raw({ type: "application/json", limit: "256kb" }),
    metaWebhookRouter(db),
  );
  app.use("/api/integrations/meta/callback", metaCallbackRouter(db, options));
  app.use(
    "/api/webhooks",
    limits.callbacks,
    express.raw({ type: "application/json", limit: "256kb" }),
    webhooksRouter(db),
  );
  app.use(express.json({ limit: "256kb" }));
  app.use("/api/auth", limits.public, authRouter(db, options));
  app.use("/api/onboarding", limits.public, onboardingRouter(db));
  app.use(
    "/api/health",
    limits.unauthenticated,
    auth(db),
    limits.perUser,
    healthRouter(db),
  );
  app.use(
    "/api/mfa",
    limits.unauthenticated,
    auth(db, { allowMfaSetup: true }),
    limits.perUser,
    mfaRouter(db, options),
  );
  app.use(
    "/api/integrations/meta",
    limits.unauthenticated,
    auth(db),
    limits.perUser,
    metaRouter(db, options),
  );
  app.use(
    "/api",
    limits.unauthenticated,
    auth(db),
    limits.perUser,
    protectAgentPhones,
    crmRouter(db, options),
  );
  app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
  app.use((err, req, res, _next) => {
    const status =
      err instanceof ZodError
        ? 400
        : err.status ||
          (err.type === "entity.too.large"
            ? 413
            : err.code === "LIMIT_FILE_SIZE"
              ? 413
              : 500);
    res.status(status).json({
      error:
        err instanceof ZodError
          ? "Invalid input: " +
            err.issues.map((i) => i.path.join(".") || i.message).join(", ")
          : status === 500
            ? "Request failed"
            : err.message,
      request_id: req.id,
      ...(String(err.code || "").startsWith("ACCOUNTS_")
        ? { code: err.code }
        : {}),
      ...(String(err.code || "").startsWith("MFA_") ? { code: err.code } : {}),
      ...(err.code === "IMPORT_COLUMNS_REQUIRED" && status === 400
        ? {
            code: err.code,
            columns: err.columns,
            format: err.format,
            worksheet: err.worksheet,
          }
        : {}),
    });
  });
  return app;
}
