import { getAdmin } from "./config/supabaseAdmin.js";
import { createApp } from "./app.js";
import { validateRuntime } from "./config/runtime.js";
import { gracefulShutdown } from "./lifecycle.js";
validateRuntime();
const port = Number(process.env.PORT || 3001);
const lifecycle = { draining: false };
const server = createApp(getAdmin(), { lifecycle }).listen(
  port,
  "127.0.0.1",
  () => {
    console.log(
      JSON.stringify({
        event: "listening",
        port,
        release: process.env.RELEASE_SHA || "development",
      }),
    );
    process.send?.("ready");
  },
);
server.requestTimeout = 300000;
server.headersTimeout = 60000;
gracefulShutdown(server, lifecycle);
