import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { requireLocalDevelopment } from "./local-only.js";

export const sampleProperty = {
  title: "Park View Residence",
  description: "Development sample property",
  location: "Islamabad",
  price: 25000000,
  type: "House",
  area: 10,
  area_unit: "marla",
};

export async function seedLocal(
  env = process.env,
  clientFactory = createClient,
) {
  requireLocalDevelopment(env);
  if (!env.SUPABASE_SERVICE_ROLE_KEY)
    throw new Error("Local Supabase service key is required");
  const db = clientFactory(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const existing = await db
    .from("properties")
    .select("id")
    .eq("title", sampleProperty.title)
    .limit(1);
  if (existing.error) throw new Error("Local sample lookup failed");
  if (existing.data.length) return;
  const result = await db.from("properties").insert(sampleProperty);
  if (result.error) throw new Error("Local sample creation failed");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await seedLocal();
  console.log("Local sample property ready");
}
