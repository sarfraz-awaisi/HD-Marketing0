export function metaConfig() {
  const env = process.env;
  const keys = [
    "META_APP_ID",
    "META_APP_SECRET",
    "META_LOGIN_CONFIG_ID",
    "META_GRAPH_VERSION",
    "META_OAUTH_REDIRECT_URL",
    "META_WEBHOOK_VERIFY_TOKEN",
    "META_TOKEN_ENCRYPTION_KEY",
  ];
  const ready = keys.every((k) => env[k]);
  if (!ready)
    throw Object.assign(
      new Error(
        "Meta is not configured. Ask your administrator to complete the connection settings.",
      ),
      { status: 503, code: "META_NOT_CONFIGURED" },
    );
  if (
    !/^v\d+\.0$/.test(env.META_GRAPH_VERSION) ||
    !/^\d+$/.test(env.META_APP_ID) ||
    !/^\d+$/.test(env.META_LOGIN_CONFIG_ID) ||
    !/^[a-f0-9]{64}$/i.test(env.META_TOKEN_ENCRYPTION_KEY)
  )
    throw Object.assign(new Error("Meta connection settings need review."), {
      status: 503,
    });
  const callback = new URL(env.META_OAUTH_REDIRECT_URL),
    frontend = new URL(env.FRONTEND_URL || "http://localhost:5173");
  if (
    callback.protocol !== "https:" ||
    callback.username ||
    callback.password ||
    callback.hash ||
    callback.search ||
    !callback.pathname.endsWith("/api/integrations/meta/callback")
  )
    throw Object.assign(
      new Error("Meta needs a fixed HTTPS callback address."),
      { status: 503 },
    );
  if (env.NODE_ENV === "production" && frontend.protocol !== "https:")
    throw Object.assign(new Error("Configure the HTTPS CRM address."), {
      status: 503,
    });
  return {
    appId: env.META_APP_ID,
    secret: env.META_APP_SECRET,
    configId: env.META_LOGIN_CONFIG_ID,
    version: env.META_GRAPH_VERSION,
    callback: callback.href,
    frontend: frontend.origin,
    verify: env.META_WEBHOOK_VERIFY_TOKEN,
    key: env.META_TOKEN_ENCRYPTION_KEY,
  };
}
export function metaReady() {
  try {
    metaConfig();
    return true;
  } catch {
    return false;
  }
}
