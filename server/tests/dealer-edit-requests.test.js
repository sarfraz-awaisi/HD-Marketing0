import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 059: agents edit their own dealers. A pending dealer changes in
// place; a rejected one is submitted again; an approved one keeps its
// approved details while the proposed changes wait for an administrator, who
// approves (applying them) or rejects them with a reason. Every step is made
// from the version its author saw, enforced by the database.
const admin = "59000000-0000-4000-8000-000000000001",
  ali = "59000000-0000-4000-8000-000000000002",
  sara = "59000000-0000-4000-8000-000000000003";
let pg, db, one, all;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, ali, sara]);
});
const app = () => createApp(trustedMfaFixture(db));
const as = (user) => ({ Authorization: "Bearer " + user });
const get = (user, path) =>
  request(app())
    .get("/api" + path)
    .set(as(user));
const send = (user, method, path, body = {}) =>
  request(app())
    [method]("/api" + path)
    .set(as(user))
    .send(body);
let phone = 1000;
const nextPhone = () => "0301" + String(1000000 + phone++).slice(-7);
const details = (d) => ({
  name: d.name,
  phone: d.phone,
  address: d.address,
  company_name: d.company_name,
  city: d.city,
  area: d.area,
  notes: d.notes,
});
async function addDealer(user = ali, extra = {}) {
  const res = await send(user, "post", "/dealers", {
    client_key: randomUUID(),
    name: "Khan Estate",
    phone: nextPhone(),
    address: "Shop 4, DHA Phase 6",
    city: "Lahore",
    ...extra,
  });
  expect(res.status).toBe(201);
  return res.body;
}
// The agent's Edit: every detail as the form shows it, from the version seen.
const edit = (user, d, changes) =>
  send(user, "post", `/dealers/${d.id}/changes`, {
    ...details(d),
    ...changes,
    expected_updated_at: d.pending_change?.updated_at ?? d.updated_at,
  });
const live = (id) =>
  one(
    "select name,phone,address,company_name,city,area,notes,status,updated_at from dealers where id=$1",
    [id],
  );
const audits = async (id) =>
  (
    await all(
      "select action from audit_log where entity='dealers' and entity_id=$1 order by id",
      [id],
    )
  ).map((a) => a.action);
async function approved(user = ali) {
  const d = await addDealer(user);
  return (
    await send(admin, "post", `/dealers/${d.id}/approve`, {
      expected_updated_at: d.updated_at,
    }).expect(200)
  ).body;
}

describe("an agent's Edit of a dealer waiting for review", () => {
  it("changes the submitted dealer itself, which stays pending for the administrator", async () => {
    const d = await addDealer();
    const res = await edit(ali, d, {
      name: "Khan Estate & Builders",
      area: "Phase 6",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: d.id,
      reference: d.reference,
      status: "pending",
      name: "Khan Estate & Builders",
      area: "Phase 6",
      pending_change: null,
    });
    expect((await one("select count(*)::int n from dealers")).n).toBe(1);
    expect(
      (await one("select count(*)::int n from dealer_change_requests")).n,
    ).toBe(0);
    expect(await audits(d.id)).toEqual(["dealer.create", "dealer.revise"]);
    // The administrator's earlier view is refused; the latest is decided.
    expect(
      (
        await send(admin, "post", `/dealers/${d.id}/approve`, {
          expected_updated_at: d.updated_at,
        })
      ).body.error,
    ).toBe(
      "The agent changed this dealer after you opened it. Review the latest details first.",
    );
    const latest = (await get(admin, `/dealers/${d.id}`)).body;
    expect(latest.name).toBe("Khan Estate & Builders");
    await send(admin, "post", `/dealers/${d.id}/approve`, {
      expected_updated_at: latest.updated_at,
    }).expect(200);
    expect((await live(d.id)).status).toBe("approved");
    // An edit from before the decision is refused, not applied.
    expect((await edit(ali, res.body, { name: "Too late" })).status).toBe(409);
    expect((await live(d.id)).name).toBe("Khan Estate & Builders");
  });

  it("lets a rejected dealer be corrected and submitted again", async () => {
    const d = await addDealer();
    const rejected = (
      await send(admin, "post", `/dealers/${d.id}/reject`, {
        reason: "Address incomplete",
        expected_updated_at: d.updated_at,
      }).expect(200)
    ).body;
    const mine = (await get(ali, `/dealers/${d.id}`)).body;
    expect(mine).toMatchObject({
      status: "rejected",
      rejection_reason: "Address incomplete",
    });
    const res = await edit(ali, mine, {
      address: "Shop 4, Block C, DHA Phase 6, Lahore",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "pending",
      rejection_reason: null,
      reviewed_at: null,
    });
    expect(await audits(d.id)).toEqual([
      "dealer.create",
      "dealer.reject",
      "dealer.resubmit",
    ]);
    expect(rejected.id).toBe(d.id);
  });
});

describe("an agent's Edit of an approved dealer", () => {
  it("waits for approval without changing the approved details, and can be revised", async () => {
    const d = await approved();
    const before = await live(d.id);
    const mine = (await get(ali, `/dealers/${d.id}`)).body;
    const res = await edit(ali, mine, {
      name: "Khan Estate & Sons",
      city: "Islamabad",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "approved",
      name: "Khan Estate",
      city: "Lahore",
      pending_change: {
        status: "pending",
        revisions: 0,
        base_changed: false,
        changes: {
          name: { before: "Khan Estate", after: "Khan Estate & Sons" },
          city: { before: "Lahore", after: "Islamabad" },
        },
      },
    });
    expect(await live(d.id)).toEqual(before);
    // The list says so, for the agent and the administrator.
    const list = (await get(ali, "/dealers?changes=true")).body;
    expect(list.summary.changes).toBe(1);
    expect(list.data.map((x) => x.id)).toEqual([d.id]);
    expect(
      (await get(admin, "/dealers?changes=true")).body.data[0].pending_change
        .submitted_by.name,
    ).toBe("Ali Agent");
    // Revising keeps one request.
    const revised = await edit(ali, res.body, {
      name: "Khan Estate & Sons",
      city: "Rawalpindi",
    });
    expect(revised.status).toBe(200);
    expect(revised.body.pending_change).toMatchObject({
      id: res.body.pending_change.id,
      revisions: 1,
      changes: {
        name: { after: "Khan Estate & Sons" },
        city: { before: "Lahore", after: "Rawalpindi" },
      },
    });
    expect(
      (await one("select count(*)::int n from dealer_change_requests")).n,
    ).toBe(1);
    expect(await live(d.id)).toEqual(before);
    // From an older view, refused.
    expect((await edit(ali, res.body, { notes: "Old view" })).status).toBe(409);
    // Changing everything back withdraws it.
    const back = await edit(ali, revised.body, {
      name: "Khan Estate",
      city: "Lahore",
    });
    expect(back.body).toMatchObject({ withdrawn: true, pending_change: null });
    expect(await audits(d.id)).toEqual([
      "dealer.create",
      "dealer.approve",
      "dealer.change_request",
      "dealer.change_revise",
      "dealer.change_withdraw",
    ]);
  });

  it("applies the changes when an administrator approves the version reviewed", async () => {
    const d = await approved();
    const proposed = (
      await edit(ali, (await get(ali, `/dealers/${d.id}`)).body, {
        name: "Khan Estate & Sons",
        notes: "Corner office",
        phone: "0301 7777777",
      })
    ).body;
    const review = (await get(admin, `/dealers/${d.id}`)).body;
    expect(review.pending_change).toMatchObject({
      submitted_by: { name: "Ali Agent" },
      changes: {
        name: { before: "Khan Estate", after: "Khan Estate & Sons" },
        notes: { before: null, after: "Corner office" },
        phone: { before: d.phone, after: "+923017777777" },
      },
    });
    expect(review.pending_change.submitted_at).toBeTruthy();
    // The agent revises after the administrator opened it: refused.
    const revised = (
      await edit(ali, proposed, {
        name: "Khan Estate & Sons",
        notes: "Corner office, 2nd floor",
        phone: "0301 7777777",
      })
    ).body;
    const decide = (view, extra = {}) =>
      send(admin, "post", `/dealers/${d.id}/changes/approve`, {
        expected_updated_at: view.pending_change.updated_at,
        expected_dealer_updated_at: view.updated_at,
        ...extra,
      });
    expect((await decide(review)).body.error).toBe(
      "The agent revised these changes after you opened them. Review the latest version.",
    );
    const latest = (await get(admin, `/dealers/${d.id}`)).body;
    const res = await decide(latest);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Khan Estate & Sons",
      notes: "Corner office, 2nd floor",
      phone: "+923017777777",
      status: "approved",
      pending_change: null,
      last_change: { status: "approved" },
    });
    // The same decision again changes nothing.
    expect((await decide(latest)).body.unchanged).toBe(true);
    const entry = await one(
      "select metadata from audit_log where action='dealer.change_approve' and entity_id=$1",
      [d.id],
    );
    expect(entry.metadata).toMatchObject({
      fields: ["name", "notes", "phone"],
      changes: { name: { before: "Khan Estate", after: "Khan Estate & Sons" } },
      proposed_by: ali,
    });
    // Contact numbers stay out of the audit log.
    expect(JSON.stringify(entry.metadata)).not.toContain("7777777");
    expect(revised.pending_change.revisions).toBe(1);
  });

  it("keeps the approved details when an administrator rejects, and the agent can correct and propose again", async () => {
    const d = await approved();
    const before = await live(d.id);
    await edit(ali, (await get(ali, `/dealers/${d.id}`)).body, {
      city: "Karachi",
    });
    const review = (await get(admin, `/dealers/${d.id}`)).body;
    const res = await send(admin, "post", `/dealers/${d.id}/changes/reject`, {
      reason: "The dealer is still in Lahore",
      expected_updated_at: review.pending_change.updated_at,
      expected_dealer_updated_at: review.updated_at,
    });
    expect(res.status).toBe(200);
    expect(await live(d.id)).toEqual(before);
    const mine = (await get(ali, `/dealers/${d.id}`)).body;
    expect(mine).toMatchObject({
      city: "Lahore",
      pending_change: null,
      last_change: {
        status: "rejected",
        rejection_reason: "The dealer is still in Lahore",
        changes: { city: { before: "Lahore", after: "Karachi" } },
      },
    });
    const again = await edit(ali, mine, { area: "Gulberg" });
    expect(again.body.pending_change).toMatchObject({
      status: "pending",
      changes: { area: { after: "Gulberg" } },
    });
    expect(
      (await one("select count(*)::int n from dealer_change_requests")).n,
    ).toBe(2);
  });

  it("refuses a decision made from an older view of the dealer", async () => {
    const d = await approved();
    await edit(ali, (await get(ali, `/dealers/${d.id}`)).body, {
      city: "Multan",
    });
    const review = (await get(admin, `/dealers/${d.id}`)).body;
    // Another administrator changes the dealer directly meanwhile.
    await send(admin, "patch", `/dealers/${d.id}`, {
      notes: "Checked by phone",
      expected_updated_at: review.updated_at,
    }).expect(200);
    const res = await send(admin, "post", `/dealers/${d.id}/changes/approve`, {
      expected_updated_at: review.pending_change.updated_at,
      expected_dealer_updated_at: review.updated_at,
    });
    expect(res.body.error).toBe(
      "This dealer changed after you opened it. Refresh to compare the changes with the current details.",
    );
    expect((await live(d.id)).city).toBe("Lahore");
  });
});

describe("who may edit and decide", () => {
  it("never lets an agent edit another agent's dealer, or decide changes", async () => {
    const theirs = await approved(sara);
    const view = (await get(admin, `/dealers/${theirs.id}`)).body;
    const res = await edit(ali, view, { name: "Taken over" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Dealer not found");
    await edit(sara, (await get(sara, `/dealers/${theirs.id}`)).body, {
      city: "Quetta",
    }).expect(200);
    const review = (await get(admin, `/dealers/${theirs.id}`)).body;
    for (const user of [ali, sara])
      for (const path of ["changes/approve", "changes/reject"])
        await send(user, "post", `/dealers/${theirs.id}/${path}`, {
          expected_updated_at: review.pending_change.updated_at,
          expected_dealer_updated_at: review.updated_at,
        }).expect(403);
    // And in the database.
    const { error } = await db.rpc("dealer_change_review", {
      p_actor: sara,
      p_id: theirs.id,
      p_decision: "approved",
      p_reason: null,
      p_expected: review.pending_change.updated_at,
      p_expected_dealer: review.updated_at,
      p_request: "t",
    });
    expect(error.code).toBe("HA403");
    expect((await live(theirs.id)).city).toBe("Lahore");
    // Administrators change dealers directly, never through a request.
    expect((await edit(admin, review, { name: "x y" })).status).toBe(403);
    // A deleted dealer cannot be edited.
    const gone = await approved();
    await send(admin, "post", `/dealers/${gone.id}/delete`, {}).expect(200);
    expect((await edit(ali, gone, { name: "Back" })).status).toBe(404);
  });

  it("keeps one contact number per agent, and shows agents only their own numbers", async () => {
    const a = await approved();
    const b = await approved();
    const res = await edit(ali, (await get(ali, `/dealers/${b.id}`)).body, {
      phone: a.phone,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(
      /^You already have dealer DL-\d{6} \(approved\) with this contact number$/,
    );
    const proposed = (
      await edit(ali, (await get(ali, `/dealers/${b.id}`)).body, {
        phone: "0301 5550000",
      })
    ).body;
    expect(proposed.pending_change.changes.phone).toEqual({
      before: b.phone,
      after: "+923015550000",
    });
  });

  it("does not let two windows start two requests for one dealer", async () => {
    const d = await approved();
    const view = (await get(ali, `/dealers/${d.id}`)).body;
    const [first, second] = await Promise.all([
      edit(ali, view, { city: "Sialkot" }),
      edit(ali, view, { city: "Okara" }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(
      (
        await one(
          "select count(*)::int n from dealer_change_requests where status='pending'",
        )
      ).n,
    ).toBe(1);
  });

  it("writes each step to the audit history in plain English", async () => {
    const d = await approved();
    await edit(ali, (await get(ali, `/dealers/${d.id}`)).body, {
      city: "Faisalabad",
    });
    const review = (await get(admin, `/dealers/${d.id}`)).body;
    await send(admin, "post", `/dealers/${d.id}/changes/approve`, {
      expected_updated_at: review.pending_change.updated_at,
      expected_dealer_updated_at: review.updated_at,
    }).expect(200);
    const { body } = await get(admin, "/audit?module=dealers");
    const titles = body.data.map((e) => e.title);
    expect(titles).toEqual(
      expect.arrayContaining([
        "Proposed changes to a dealer",
        "Approved dealer changes",
      ]),
    );
    const approvedEntry = body.data.find(
      (e) => e.title === "Approved dealer changes",
    );
    expect(approvedEntry.changes).toEqual([
      { label: "City", before: "Lahore", after: "Faisalabad" },
    ]);
    expect(
      (await get(admin, `/dealers/${d.id}`)).body.history.map((h) => h.action),
    ).toEqual([
      "dealer.create",
      "dealer.approve",
      "dealer.change_request",
      "dealer.change_approve",
    ]);
  });
});
