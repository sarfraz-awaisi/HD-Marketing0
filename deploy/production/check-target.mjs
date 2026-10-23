import { readFileSync } from "node:fs";
import { validateRuntime } from "../../server/src/config/runtime.js";
validateRuntime();
const target = JSON.parse(readFileSync("deployment-target.json", "utf8"));
if (
  target.environment !== process.env.DEPLOY_ENV ||
  target.supabase !== process.env.SUPABASE_URL ||
  target.origin !== process.env.FRONTEND_URL
)
  throw new Error("Frontend/backend environment mismatch; refusing deployment");
