// Test helper, started as its own process by
// google-sheets-apps-script.test.js: the CRM API on an in-memory database, so
// the Apps Script (whose UrlFetchApp waits for each answer) can call it over
// HTTP. POST /__test/sql runs SQL for the test's own set-up and checks; it
// exists only in this helper, never in the app.
import { createServer } from "node:http";
import { createApp } from "../src/app.js";
import { startCrmDatabase } from "./crm-fixture.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
const { pg, db } = await startCrmDatabase();
const app = createApp(trustedMfaFixture(db));
const server = createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/__test/sql") return app(req, res);
  let body = "";
  for await (const chunk of req) body += chunk;
  try {
    const { sql, params } = JSON.parse(body);
    const rows = params
      ? (await pg.query(sql, params)).rows
      : (await pg.exec(sql)).at(-1)?.rows;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(rows ?? []));
  } catch (error) {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(0, "127.0.0.1", () =>
  console.log("PORT=" + server.address().port),
);
