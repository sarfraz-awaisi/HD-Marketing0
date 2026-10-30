import { requireLocalDevelopment } from "./local-only.js";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
requireLocalDevelopment();
if (!process.env.WEBHOOK_SECRET)
  throw new Error("Configure WEBHOOK_SECRET first");
const body = await readFile(
  process.argv[2] || "server/fixtures/call-event.json",
);
const signature =
  "sha256=" +
  createHmac("sha256", process.env.WEBHOOK_SECRET).update(body).digest("hex");
const r = await fetch(
  `http://localhost:${process.env.PORT || 3001}/api/webhooks/mock`,
  {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-HD-Signature": signature,
    },
    body,
  },
);
console.log("HTTP", r.status, await r.text());
if (!r.ok) process.exitCode = 1;
