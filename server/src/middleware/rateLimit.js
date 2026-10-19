import { rateLimit } from "express-rate-limit";
export const mfaVerifyLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
export const metaWebhookLimit = rateLimit({
  windowMs: 60000,
  limit: 1200,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
export const sensitiveLimit = rateLimit({
  windowMs: 60000,
  limit: 30,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

export const apiLimit = rateLimit({
  windowMs: 15 * 60000,
  limit: 300,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});
