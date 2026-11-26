import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Bulk actions on selected dealers (administrators only): Delete, or
// Approve or Reject pending dealers. Each dealer goes through its own
// action's database function, so deleting stays a soft delete that can be
// restored, with the usual audit entry; a dealer changed after it was
// selected is left as it is and reported. No database update.
const admin = "4b000000-0000-4000-8000-000000000001",
  ali = "4b000000-0000-4000-8000-000000000002",
  sara = "4b000000-0000-4000-8000-000000000003",
  staff = "4b000000-0000-4000-8000-000000000004";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'staff@gmail.com',now()) on conflict do nothing",
    [staff],
  );
  await pg.query(
    "update profiles set active=true,role='staff',name='Sam Staff' where id=$1",
    [staff],
  );
});
const app = (database = db) => createApp(trustedMfaFixture(database));
const as = (user) => ({ Authorization: "Bearer " + user });
const send = (user, method, path, body = {}, database) =>
  request(app(database))
    [method]("/api" + path)
    .set(as(user))
    .send(body);
let phone = 5000;
const add = async (user = ali, extra = {}) => {
  const res = await send(user, "post", "/dealers", {
    client_key: randomUUID(),
    name: "Dealer " + phone,
    phone: "0300" + String(1000000 + phone++).slice(-7),
    address: "Plot 5, Main Boulevard",
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body;
};
// The dealers as the list shows them to an administrator (the versions
// a bulk action starts from).
const listed = async (ids) =>
  (
    await send(admin, "get", "/dealers?limit=100&view=active").then(
      (r) => r.body,
    )
  ).data.filter((d) => ids.includes(d.id));
const pick = (dealers) =>
  dealers.map((d) => ({ id: d.id, expected_updated_at: d.updated_at }));
const bulk = (body, user = admin, database) =>
  send(user, "post", "/dealers/bulk", body, database);
const row = (id) =>
  one(
    "select status,rejection_reason,deleted_at is not null deleted,deleted_by,delete_reason,updated_at from dealers where id=$1",
    [id],
  );
const audits = async (action) =>
  (
    await all(
      "select entity_id,metadata from audit_log where action=$1 order by id",
      [action],
    )
  ).map((a) => [a.entity_id, a.metadata?.reason ?? null]);

describe("dealer bulk actions", () => {
  it("are for administrators only, checked by the server", async () => {
    const d = await add(ali);
    const [mine] = await listed([d.id]);
    const body = { action: "delete", dealers: pick([mine]) };
    for (const user of [ali, staff])
      expect((await bulk(body, user)).status).toBe(403);
    expect(
      (await request(app()).post("/api/dealers/bulk").send(body)).status,
    ).toBe(401);
    expect(await row(d.id)).toMatchObject({ deleted: false });
    // Malformed requests change nothing.
    for (const bad of [
      { action: "export", dealers: pick([mine]) },
      { action: "delete", dealers: [] },
      { action: "delete", dealers: pick([mine, mine]) },
      { action: "delete", dealers: pick([mine]), reason: "x".repeat(301) },
      {
        action: "delete",
        dealers: Array.from({ length: 201 }, () => ({
          id: randomUUID(),
          expected_updated_at: mine.updated_at,
        })),
      },
    ])
      expect((await bulk(bad)).status).toBe(400);
    expect(await row(d.id)).toMatchObject({ deleted: false });
  });

  it("deletes the selected dealers as one Delete each: restorable, audited, linked records untouched", async () => {
    const a = await add(ali),
      b = await add(sara),
      kept = await add(ali);
    // An approved dealer with its agent's change waiting for review.
    const c = await add(ali);
    await send(admin, "post", `/dealers/${c.id}/approve`, {
      expected_updated_at: c.updated_at,
    });
    const now = (await send(ali, "get", `/dealers/${c.id}`)).body;
    expect(
      (
        await send(ali, "post", `/dealers/${c.id}/changes`, {
          name: now.name,
          phone: now.phone,
          address: now.address,
          notes: "New office",
          expected_updated_at: now.updated_at,
        })
      ).status,
    ).toBe(200);
    const before = await one(
      "select (select count(*) from dealer_change_requests)::int changes,(select md5(string_agg(x::text,'|' order by x.id)) from dealer_change_requests x) h,(select count(*) from dealers)::int dealers",
    );
    const chosen = await listed([a.id, b.id, c.id]);
    const res = await bulk({
      action: "delete",
      dealers: pick(chosen),
      reason: "  Closed agencies ",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      action: "delete",
      done: 3,
      unchanged: 0,
      failed: 0,
    });
    expect(res.body.partial).toBeUndefined();
    for (const id of [a.id, b.id, c.id])
      expect(await row(id)).toMatchObject({
        deleted: true,
        deleted_by: admin,
        delete_reason: "Closed agencies",
      });
    expect(await row(kept.id)).toMatchObject({ deleted: false });
    // Soft delete: no row removed, the waiting change kept as it was.
    expect(
      await one(
        "select (select count(*) from dealer_change_requests)::int changes,(select md5(string_agg(x::text,'|' order by x.id)) from dealer_change_requests x) h,(select count(*) from dealers)::int dealers",
      ),
    ).toEqual(before);
    expect((await audits("dealer.delete")).sort()).toEqual(
      [a.id, b.id, c.id].map((id) => [id, "Closed agencies"]).sort(),
    );
    // Each can be restored as before.
    expect(
      (await send(admin, "post", `/dealers/${b.id}/restore`)).body,
    ).toMatchObject({ deleted_at: null });
    // Agents no longer see their deleted dealers.
    expect(
      (await send(ali, "get", "/dealers?limit=100")).body.data.map((d) => d.id),
    ).toEqual([kept.id]);
  });

  it("leaves a dealer changed after it was selected, reports one already deleted, and does the rest", async () => {
    const [a, b, c] = [await add(ali), await add(ali), await add(sara)];
    const chosen = await listed([a.id, b.id, c.id]);
    // Meanwhile: the agent edits b, another administrator deletes c.
    await pg.query("update dealers set notes='Changed' where id=$1", [b.id]);
    await send(admin, "post", `/dealers/${c.id}/delete`, {});
    const res = await bulk({ action: "delete", dealers: pick(chosen) });
    expect(res.body).toMatchObject({ done: 1, unchanged: 1, failed: 1 });
    expect(res.body.results.find((r) => r.id === b.id)).toMatchObject({
      result: "failed",
      reason: "Changed after you selected it. Check it and delete it again.",
    });
    expect(res.body.results.find((r) => r.id === c.id).result).toBe(
      "unchanged",
    );
    expect(await row(a.id)).toMatchObject({ deleted: true });
    expect(await row(b.id)).toMatchObject({ deleted: false });
    // A dealer that does not exist is reported, the others still go ahead.
    const d = await add(ali);
    const res2 = await bulk({
      action: "delete",
      dealers: [
        { id: randomUUID(), expected_updated_at: d.updated_at },
        ...pick(await listed([d.id])),
      ],
    });
    expect(res2.body).toMatchObject({ done: 1, failed: 1 });
    expect(res2.body.results[0].reason).toBe("Dealer not found");
  });

  it("approves or rejects pending dealers from the version selected", async () => {
    const [a, b, c, d] = [
      await add(ali),
      await add(ali),
      await add(sara),
      await add(sara),
    ];
    const chosen = await listed([a.id, b.id, c.id, d.id]);
    await pg.query("update dealers set notes='Changed' where id=$1", [b.id]);
    await send(admin, "post", `/dealers/${c.id}/reject`, {
      expected_updated_at: c.updated_at,
    });
    const res = await bulk({
      action: "approve",
      dealers: pick(chosen),
      reason: "ignored for approvals",
    });
    expect(res.body).toMatchObject({ done: 2, failed: 2 });
    expect(await row(a.id)).toMatchObject({ status: "approved" });
    expect(await row(d.id)).toMatchObject({
      status: "approved",
      rejection_reason: null,
    });
    expect(
      res.body.results
        .filter((r) => r.result === "failed")
        .map((r) => r.reason)
        .sort(),
    ).toEqual([
      "The agent changed this dealer after you opened it. Review the latest details first.",
      "This dealer was already rejected by Owner",
    ]);
    const e = await add(ali);
    const rejected = await bulk({
      action: "reject",
      dealers: pick(await listed([e.id, b.id])),
      reason: "Duplicate agency",
    });
    expect(rejected.body).toMatchObject({ done: 2, failed: 0 });
    expect(await row(e.id)).toMatchObject({
      status: "rejected",
      rejection_reason: "Duplicate agency",
    });
    expect((await audits("dealer.reject")).map(([, r]) => r)).toEqual([
      null,
      "Duplicate agency",
      "Duplicate agency",
    ]);
  });

  it("stops when the CRM cannot finish, reports the rest, and never repeats what was done", async () => {
    const dealers = [await add(ali), await add(ali), await add(ali)];
    const chosen = await listed(dealers.map((d) => d.id));
    let deletes = 0;
    const flaky = {
      ...db,
      rpc: async (name, args) =>
        name === "dealer_delete" && ++deletes === 2
          ? { data: null, error: { code: "57014", message: "timeout" } }
          : db.rpc(name, args),
    };
    const res = await bulk(
      { action: "delete", dealers: pick(chosen) },
      admin,
      flaky,
    );
    expect(res.body).toMatchObject({ done: 1, failed: 2, partial: true });
    expect(res.body.results.slice(1).map((r) => r.reason)).toEqual([
      "Not done: the CRM could not finish. Select it and try again.",
      "Not done: the CRM could not finish. Select it and try again.",
    ]);
    expect(
      (
        await all(
          "select deleted_at is not null d from dealers where id=any($1) order by id",
          [dealers.map((d) => d.id)],
        )
      ).filter((r) => r.d),
    ).toHaveLength(1);
    // Nothing done yet: a plain error.
    deletes = 1;
    const first = await bulk(
      { action: "delete", dealers: pick(await listed([dealers[1].id])) },
      admin,
      flaky,
    );
    expect(first.status).toBe(503);
  });
});
