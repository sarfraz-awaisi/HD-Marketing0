import { readFile, readdir, writeFile } from "node:fs/promises";

const root = new URL("../supabase/", import.meta.url);
const migrations = new URL("migrations/", root);
const files = (await readdir(migrations))
  .filter((file) => file.endsWith(".sql"))
  .sort();
const parts = [
  "-- HD Marketing CRM: first-time setup for a fresh Supabase project.",
  "-- Run the entire file together in SQL Editor. No passwords or Auth users are included.",
  "-- A transaction rolls back the setup if any statement fails.",
  "BEGIN;",
  "DO $$ BEGIN IF to_regclass('public.profiles') IS NOT NULL THEN RAISE EXCEPTION 'A profiles table already exists. Stop and review the existing database before running first-time setup.'; END IF; END $$;",
];

for (const file of files) {
  // Individual upgrades may wrap themselves in a transaction. The fresh-install
  // bundle has one outer transaction, so do not commit it inside a migration.
  const sql = (await readFile(new URL(file, migrations), "utf8"))
    .replace(/^begin;[ \t]*$/gim, "")
    .replace(/^commit;[ \t]*$/gim, "");
  parts.push(`\n-- Migration: ${file}\n`, sql);
}
parts.push(
  "\n-- Safe sample property; real Auth accounts are created later.\n",
  await readFile(new URL("seed.sql", root), "utf8"),
  "COMMIT;",
  "SELECT 'HD Marketing database setup completed' AS status;",
);
await writeFile(new URL("setup.sql", root), parts.join("\n") + "\n");
console.log(`Created supabase/setup.sql from ${files.length} migrations.`);

// Existing databases install only the new lead-management tranche after 028.
const leadUpdates = files.filter(
  (file) => Number(file.slice(0, 3)) >= 29 && Number(file.slice(0, 3)) <= 32,
);
if (leadUpdates.length === 4) {
  const updates = [
    "-- HD Marketing CRM: apply once after 028; does not reset the existing database.",
    "BEGIN;",
    "DO $$ BEGIN IF to_regprocedure('public.prepare_account_deletion(uuid,text,text,uuid,text,uuid,text)') IS NULL THEN RAISE EXCEPTION 'Apply account deletion update 028 before lead-management updates 029–032.'; END IF; IF EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='leads' AND column_name='lead_no') THEN RAISE EXCEPTION 'Lead numbering is already installed. Apply only the remaining missing numbered migrations; do not rerun this bundle.'; END IF; END $$;",
  ];
  for (const file of leadUpdates)
    updates.push(
      "-- Migration: " + file,
      (await readFile(new URL(file, migrations), "utf8"))
        .replace(/^begin;[ \t]*$/gim, "")
        .replace(/^commit;[ \t]*$/gim, ""),
    );
  updates.push(
    "COMMIT;",
    "SELECT 'Lead management updates 029–032 completed' AS status;",
  );
  await writeFile(
    new URL("update-lead-management.sql", root),
    updates.join("\n") + "\n",
  );
}
