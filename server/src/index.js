import { getAdmin } from "./config/supabaseAdmin.js";
import { createApp } from "./app.js";
import { validateRuntime } from "./config/runtime.js";
validateRuntime();
const port = Number(process.env.PORT || 3001);
createApp(getAdmin()).listen(port, "127.0.0.1", () =>
  console.log(`HD Marketing API listening on http://localhost:${port}`),
);
