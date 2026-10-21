import express from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { auth } from "./middleware/auth.js";
import {
  sensitiveLimit,
  metaWebhookLimit,
  createApiLimiters,
} from "./middleware/rateLimit.js";
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
  // options.rateLimits lets tests use small limits; production uses defaults.
  const { publicLimit, unauthenticatedLimit, userLimit } = createApiLimiters(
    options.rateLimits,
  );
  app.disable("x-powered-by");
  app.set("trust proxy", trustProxy(process.env.TRUST_PROXY || "loopback"));
  app.use(helmet());
  app.use(
    cors({ origin: process.env.FRONTEND_URL || "http://localhost:5173" }),
  );
  app.use((req, res, next) => {
    req.id = randomUUID();
    res.set("X-Request-ID", req.id);
    res.set("Cache-Control", "no-store");
    next();
  });
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.use(
    "/api/integrations/meta/webhook",
    metaWebhookLimit,
    express.raw({ type: "application/json", limit: "256kb" }),
    metaWebhookRouter(db),
  );
  app.use("/api/integrations/meta/callback", metaCallbackRouter(db, options));
  app.use(
    "/api/webhooks",
    sensitiveLimit,
    express.raw({ type: "application/json", limit: "256kb" }),
    webhooksRouter(db),
  );
  app.use(express.json({ limit: "256kb" }));
  app.use("/api/auth", publicLimit, authRouter(db, options));
  app.use("/api/onboarding", publicLimit, onboardingRouter(db));
  app.use(
    "/api/health",
    unauthenticatedLimit,
    auth(db),
    userLimit,
    healthRouter(db),
  );
  app.use(
    "/api/mfa",
    unauthenticatedLimit,
    auth(db, { allowMfaSetup: true }),
    userLimit,
    mfaRouter(db, options),
  );
  app.use(
    "/api/integrations/meta",
    unauthenticatedLimit,
    auth(db),
    userLimit,
    metaRouter(db, options),
  );
  app.use(
    "/api",
    unauthenticatedLimit,
    auth(db),
    userLimit,
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
