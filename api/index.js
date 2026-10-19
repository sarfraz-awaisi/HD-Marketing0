// Vercel's Node function imports Express without binding a port or starting jobs.
import { createApp } from "../server/src/app.js";
import { getAdmin } from "../server/src/config/supabaseAdmin.js";
import { validateRuntime } from "../server/src/config/runtime.js";
validateRuntime();
export default createApp(getAdmin());
