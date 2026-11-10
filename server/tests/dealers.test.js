import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApp } from "../src/app.js";
import { presentAuditEntry } from "../src/services/auditHistory.js";
import { dealerView } from "../src/routes/dealers.routes.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 049: the dealer affiliate network, through the API as each role
// uses it. Agent A (ali) and agent B (sara) must never learn about each
// other's dealers: not by listing, searching, paging, counting, opening an id
// or checking a number.
const admin = "49000000-0000-4000-8000-000000000001",
  ali = "49000000-0000-4000-8000-000000000002",
  sara = "49000000-0000-4000-8000-000000000003",
  staff = "49000000-0000-4000-8000-000000000004";
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
    "insert into auth.users(id,email,email_confirmed_at) values($1,'staff@gmail.com',now())",
    [staff],
  );
  await pg.query(
    "update profiles set active=true,role='staff',name='Sam Staff' where id=$1",
    [staff],
  );
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
const nextPhone = () => "0300" + String(1000000 + phone++).slice(-7);
const add = (user, data = {}) =>
  send(user, "post", "/dealers", {
    client_key: randomUUID(),
    name: "Dealer " + phone,
    phone: nextPhone(),
    address: "Plot 5, Main Boulevard",
    ...data,
  });
const audits = (id) =>
  all(
    "select actor_id,action,metadata from audit_log where entity='dealers' and entity_id=$1 order by id",
    [id],
  );

describe("adding dealers", () => {
  it("records an agent's dealer as pending, owned by the signed-in agent", async () => {
    const res = await add(ali, {
      name: "  Khan   Estate  ",
      phone: " +92 300 1234567 ",
      address: "  Shop 4, DHA Phase 6 \n Lahore ",
      company_name: "  Khan Associates ",
      city: " Lahore ",
      area: "",
      notes: "   ",
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: "Khan Estate",
      address: "Shop 4, DHA Phase 6 \n Lahore",
      company_name: "Khan Associates",
      city: "Lahore",
      area: null,
      notes: null,
      status: "pending",
      rejection_reason: null,
    });
    expect(res.body.reference).toMatch(/^DL-\d{6}$/);
    // An agent sees the full number of a dealer they added.
    expect(res.body).toMatchObject({ phone: "+923001234567", owner_id: ali });
    // Agents are not told who reviews dealers or who else holds the number.
    expect(res.body).not.toHaveProperty("submitted_by");
    expect(res.body).not.toHaveProperty("duplicates");
    const row = await one("select * from dealers where id=$1", [res.body.id]);
    expect(row).toMatchObject({
      phone: "+923001234567",
      submitted_by: ali,
      reviewed_by: null,
    });
    expect(await audits(res.body.id)).toEqual([
      {
        actor_id: ali,
        action: "dealer.create",
        metadata: expect.objectContaining({
          agent_id: ali,
          status: "pending",
          auto_approved: false,
        }),
      },
    ]);
    expect(JSON.stringify(await audits(res.body.id))).not.toMatch(/300123/);
  });
  it("approves an administrator's dealer at once, recording the administrator", async () => {
    const res = await add(admin, { phone: "03211234567" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      phone: "+923211234567",
      status: "approved",
      submitted_by: { id: admin, name: "Owner" },
      reviewed_by: { id: admin },
      duplicates: 0,
    });
    expect(res.body.reviewed_at).toBeTruthy();
    expect((await audits(res.body.id))[0].metadata.auto_approved).toBe(true);
  });
  it("never takes the owner, status or reviewer from the request", async () => {
    for (const extra of [
      { submitted_by: sara },
      { status: "approved" },
      { reviewed_by: admin },
    ])
      expect((await add(ali, extra)).status).toBe(400);
    expect((await one("select count(*)::int n from dealers")).n).toBe(0);
  });
  it("checks and normalizes the details with clear messages", async () => {
    const cases = [
      [{ name: "   " }, "Dealer name is required"],
      [{ name: "A" }, "Dealer name must be at least 2 characters"],
      [{ address: " " }, "Address is required"],
      [{ phone: "" }, "Contact number is required"],
      [
        { phone: "12345" },
        "Enter a valid contact number, for example 03XX XXXXXXX",
      ],
      [{ phone: "0300-12ab567" }, "Enter a valid contact number"],
      [{ city: "x".repeat(81) }, "City must be at most 80 characters"],
    ];
    for (const [data, message] of cases) {
      const res = await add(ali, data);
      expect(res.status, message).toBe(400);
      expect(res.body.error).toContain(message);
    }
    expect((await add(ali, { name: 5 })).status).toBe(400);
  });
  it("treats 03001234567, +923001234567, 923001234567 and 3001234567 as one number", async () => {
    const first = await add(ali, { phone: "03001234567" });
    expect(first.status).toBe(201);
    for (const same of [
      "+923001234567",
      "923001234567",
      "3001234567",
      "0092 300 123 4567",
      "(0300) 123-4567",
    ]) {
      const res = await add(ali, { phone: same });
      expect(res.status, same).toBe(409);
      expect(res.body.error).toContain(
        `You already added this contact number as dealer ${first.body.reference} (pending)`,
      );
    }
    expect(
      (
        await one(
          "select count(*)::int n from dealers where phone='+923001234567'",
        )
      ).n,
    ).toBe(1);
  });
  it("returns the first dealer when the same form is sent twice", async () => {
    const body = {
      client_key: randomUUID(),
      name: "Twice Sent",
      phone: nextPhone(),
      address: "Gulberg III",
    };
    const first = await send(ali, "post", "/dealers", body);
    const again = await send(ali, "post", "/dealers", body);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: first.body.id, replayed: true });
    expect((await one("select count(*)::int n from dealers")).n).toBe(1);
    expect((await audits(first.body.id)).length).toBe(1);
  });
  it("lets an agent submit a rejected dealer again", async () => {
    const first = await add(ali, { phone: "03007654321" });
    await send(admin, "post", `/dealers/${first.body.id}/reject`, {
      reason: "Wrong office address",
    });
    const again = await add(ali, { phone: "+923007654321" });
    expect(again.status).toBe(201);
    expect(again.body.status).toBe("pending");
  });
});

describe("agents see only their own dealers", () => {
  let mine, theirs;
  beforeEach(async () => {
    mine = [];
    for (const name of ["Ali One", "Ali Two", "Ali Three"])
      mine.push((await add(ali, { name, city: "Lahore" })).body);
    theirs = (
      await add(sara, {
        name: "Sara Secret Realty",
        phone: "03331112222",
        city: "Lahore",
      })
    ).body;
    await add(sara, { name: "Sara Second" });
  });
  it("lists, counts and pages only the agent's dealers", async () => {
    const res = await get(ali, "/dealers?limit=2");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.summary).toEqual({
      total: 3,
      pending: 3,
      approved: 0,
      rejected: 0,
      // Approved dealers with changes waiting (update 059).
      changes: 0,
    });
    expect(res.body.data.map((d) => d.name)).toEqual(["Ali Three", "Ali Two"]);
    const page2 = await get(ali, "/dealers?limit=2&page=2");
    expect(page2.body.data.map((d) => d.name)).toEqual(["Ali One"]);
    expect((await get(ali, "/dealers?limit=2&page=3")).body.data).toEqual([]);
  });
  it("never finds another agent's dealer by name, city or number", async () => {
    for (const search of [
      "Sara Secret",
      "Lahore",
      "0333 1112222",
      "923331112222",
      "1112222",
    ]) {
      const res = await get(
        ali,
        "/dealers?search=" + encodeURIComponent(search),
      );
      expect(res.status).toBe(200);
      expect(res.body.data.map((d) => d.id)).not.toContain(theirs.id);
      expect(JSON.stringify(res.body)).not.toMatch(/Sara/);
    }
    expect(
      (
        await get(sara, "/dealers?search=" + encodeURIComponent("0333-1112222"))
      ).body.data.map((d) => d.id),
    ).toEqual([theirs.id]);
  });
  it("answers another agent's dealer id exactly like a missing one", async () => {
    const other = await get(ali, `/dealers/${theirs.id}`);
    const missing = await get(ali, `/dealers/${randomUUID()}`);
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(other.body.error).toBe(missing.body.error);
    expect((await get(sara, `/dealers/${theirs.id}`)).body.name).toBe(
      "Sara Secret Realty",
    );
  });
  it("refuses changes, reviews, deletion and administrator filters", async () => {
    const id = mine[0].id;
    for (const [method, path, body] of [
      [
        "patch",
        `/dealers/${id}`,
        { expected_updated_at: mine[0].updated_at, name: "Changed" },
      ],
      ["post", `/dealers/${id}/approve`, {}],
      ["post", `/dealers/${id}/reject`, {}],
      ["post", `/dealers/${id}/delete`, {}],
      ["post", `/dealers/${id}/restore`, {}],
      ["post", `/dealers/${theirs.id}/approve`, {}],
    ])
      expect((await send(ali, method, path, body)).status, path).toBe(403);
    for (const query of [`agent=${sara}`, "view=deleted", "duplicates=true"])
      expect((await get(ali, "/dealers?" + query)).status, query).toBe(403);
    expect(
      await one("select name,status from dealers where id=$1", [id]),
    ).toEqual({ name: "Ali One", status: "pending" });
  });
  it("never tells an agent that someone else has the same number", async () => {
    // Sara's number, added by Ali: accepted with no hint of Sara's record.
    const check = await get(ali, "/dealers/check-phone?phone=03331112222");
    expect(check.status).toBe(200);
    expect(check.body.matches).toEqual([]);
    const res = await add(ali, {
      name: "Ali's copy",
      phone: "+92 333 1112222",
    });
    expect(res.status).toBe(201);
    expect(JSON.stringify(res.body)).not.toMatch(/Sara|duplicate/i);
    // Ali's own match is reported to Ali only.
    const own = await get(ali, "/dealers/check-phone?phone=923331112222");
    expect(own.body.matches).toEqual([
      expect.objectContaining({
        id: res.body.id,
        mine: true,
        status: "pending",
      }),
    ]);
    expect(own.body.matches[0]).not.toHaveProperty("submitted_by");
    // The administrator sees both, with who added each.
    const both = await get(admin, "/dealers/check-phone?phone=3331112222");
    expect(both.body.matches.map((m) => m.submitted_by.name)).toEqual([
      "Sara Agent",
      "Ali Agent",
    ]);
  });
  it("keeps staff out of the dealer network entirely", async () => {
    for (const [method, path] of [
      ["get", "/dealers"],
      ["get", `/dealers/${theirs.id}`],
      ["get", "/dealers/check-phone?phone=03331112222"],
      ["post", "/dealers"],
    ]) {
      const res = await send(staff, method, path, {});
      expect(res.status, path).toBe(403);
      expect(JSON.stringify(res.body)).not.toMatch(/Sara|Ali/);
    }
    // The database refuses staff too, if the API check were ever missed.
    await expect(
      one("select public.dealers_page($1,'{}',1,20)", [staff]),
    ).rejects.toThrow(/administrators and agents only/);
  });
});

describe("contact numbers", () => {
  // Agents get the full number of their own dealers only. Every other
  // number in an agent's response stays masked. Lead numbers are covered by
  // lead-phone.test.js; the phone protection itself is unchanged.
  const hidden = (body, digits) =>
    expect(JSON.stringify(body)).not.toContain(digits);
  let mine, theirs;
  beforeEach(async () => {
    mine = (await add(ali, { name: "Ali Own", phone: "0321 4445556" })).body;
    theirs = (await add(sara, { name: "Sara Private", phone: "03331112222" }))
      .body;
  });
  it("shows an agent the full number of their own dealer wherever it appears", async () => {
    expect(mine.phone).toBe("+923214445556");
    const list = await get(ali, "/dealers");
    expect(list.body.data).toEqual([
      expect.objectContaining({ id: mine.id, phone: "+923214445556" }),
    ]);
    for (const search of ["0321 4445556", "4445556", "Ali Own"])
      expect(
        (await get(ali, "/dealers?search=" + encodeURIComponent(search))).body
          .data[0].phone,
        search,
      ).toBe("+923214445556");
    expect((await get(ali, `/dealers/${mine.id}`)).body.phone).toBe(
      "+923214445556",
    );
    // Still the agent's after any decision: approved and rejected alike.
    await send(admin, "post", `/dealers/${mine.id}/reject`);
    expect((await get(ali, `/dealers/${mine.id}`)).body).toMatchObject({
      status: "rejected",
      phone: "+923214445556",
    });
    // Administrators see every number.
    expect(
      (await get(admin, "/dealers")).body.data.map((d) => d.phone).sort(),
    ).toEqual(["+923214445556", "+923331112222"]);
  });
  it("never shows an agent another agent's number, through any endpoint", async () => {
    for (const [method, path] of [
      ["get", "/dealers"],
      ["get", "/dealers?search=" + encodeURIComponent("0333 1112222")],
      ["get", "/dealers?search=1112222"],
      ["get", `/dealers/${theirs.id}`],
      ["get", "/dealers/check-phone?phone=03331112222"],
      ["patch", `/dealers/${theirs.id}`],
      ["post", `/dealers/${theirs.id}/approve`],
      ["post", `/dealers/${theirs.id}/delete`],
    ]) {
      const res = await send(ali, method, path, {});
      expect(res.status, path).not.toBe(500);
      hidden(res.body, "3331112222");
      hidden(res.body, "Sara");
    }
    // The number check answers with the typed number masked.
    expect(
      (await get(ali, "/dealers/check-phone?phone=03214445556")).body.phone,
    ).toBe("+92******556");
    // Staff get nothing at all.
    for (const path of ["/dealers", `/dealers/${mine.id}`]) {
      const res = await get(staff, path);
      expect(res.status).toBe(403);
      hidden(res.body, "4445556");
    }
  });
  it("keeps other numbers masked in an agent's notes, rejection reasons and errors", async () => {
    const d = (
      await add(ali, {
        phone: "03005550101",
        notes: "Partner line 0300 5550202",
      })
    ).body;
    expect(d.phone).toBe("+923005550101");
    expect(d.notes).toBe("Partner line +92******202");
    await send(admin, "post", `/dealers/${d.id}/reject`, {
      reason: "Already listed with 03331112222",
    });
    const seen = (await get(ali, `/dealers/${d.id}`)).body;
    expect(seen.rejection_reason).toBe("Already listed with +92******222");
    hidden(seen, "3331112222");
    // A refused duplicate names the dealer, never a number.
    const again = await add(ali, { phone: "0321-4445556" });
    expect(again.status).toBe(409);
    expect(again.body.error).toContain(mine.reference);
    hidden(again.body, "4445556");
  });
  it("restores a number on the server only where the dealer is the agent's own", () => {
    const agent = { id: ali, role: "agent" };
    const row = (owner_id, phone) => ({
      id: randomUUID(),
      owner_id,
      phone,
      notes: "Call " + phone,
    });
    const page = {
      count: 3,
      data: [
        row(ali, "+923001112233"),
        row(sara, "+923004445566"),
        row(undefined, "+923007778899"),
      ],
    };
    expect(dealerView(agent, page).data.map((d) => [d.phone, d.notes])).toEqual(
      [
        ["+923001112233", "Call +92******233"],
        ["+92******566", "Call +92******566"],
        ["+92******899", "Call +92******899"],
      ],
    );
    expect(dealerView(agent, row(sara, "+923004445566")).phone).toBe(
      "+92******566",
    );
    expect(dealerView({ id: admin, role: "admin" }, page)).toBe(page);
  });
});

describe("administrators manage every dealer", () => {
  it("lists every agent's dealers with filters, summary and who added them", async () => {
    const a = (await add(ali, { name: "Alpha Estates", phone: "03001110001" }))
      .body;
    await add(sara, { name: "Beta Homes", phone: "03001110002" });
    await add(admin, { name: "Gamma Admin", phone: "03001110003" });
    const res = await get(admin, "/dealers");
    expect(res.body.count).toBe(3);
    expect(res.body.summary).toEqual({
      total: 3,
      pending: 2,
      approved: 1,
      rejected: 0,
      changes: 0,
      deleted: 0,
      duplicates: 0,
    });
    expect(res.body.data[0].submitted_by.name).toBe("Owner");
    const byAli = await get(admin, `/dealers?agent=${ali}`);
    expect(byAli.body.data.map((d) => d.id)).toEqual([a.id]);
    expect(byAli.body.summary.total).toBe(1);
    expect(
      (await get(admin, "/dealers?status=approved")).body.data.map(
        (d) => d.name,
      ),
    ).toEqual(["Gamma Admin"]);
    expect(
      (await get(admin, "/dealers?search=0300%20111%200002")).body.data.map(
        (d) => d.name,
      ),
    ).toEqual(["Beta Homes"]);
    expect(
      (await get(admin, "/dealers?sort=name")).body.data.map((d) => d.name),
    ).toEqual(["Alpha Estates", "Beta Homes", "Gamma Admin"]);
    expect(
      (await get(admin, "/dealers?sort=oldest")).body.data.map(
        (d) => d.name,
      )[0],
    ).toBe("Alpha Estates");
    expect(res.body.data[0].phone).toBe("+923001110003");
  });
  it("approves once: repeating is harmless and the opposite decision is refused", async () => {
    const d = (await add(ali)).body;
    const ok = await send(admin, "post", `/dealers/${d.id}/approve`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: "approved",
      reviewed_by: { id: admin },
    });
    const again = await send(admin, "post", `/dealers/${d.id}/approve`);
    expect(again.body).toMatchObject({ status: "approved", unchanged: true });
    expect(again.body.reviewed_at).toBe(ok.body.reviewed_at);
    const reject = await send(admin, "post", `/dealers/${d.id}/reject`, {
      reason: "Too late",
    });
    expect(reject.status).toBe(409);
    expect(reject.body.error).toBe("This dealer was already approved by Owner");
    expect((await audits(d.id)).map((a) => [a.action, a.actor_id])).toEqual([
      ["dealer.create", ali],
      ["dealer.approve", admin],
    ]);
  });
  it("rejects with an optional reason the agent can read", async () => {
    const d = (await add(ali)).body;
    const res = await send(admin, "post", `/dealers/${d.id}/reject`, {
      reason: "  Could not verify the office  ",
    });
    expect(res.body).toMatchObject({
      status: "rejected",
      rejection_reason: "Could not verify the office",
    });
    const seen = await get(ali, `/dealers/${d.id}`);
    expect(seen.body).toMatchObject({
      status: "rejected",
      rejection_reason: "Could not verify the office",
    });
    expect((await get(ali, "/dealers?status=rejected")).body.count).toBe(1);
    const silent = (await add(ali)).body;
    expect(
      (await send(admin, "post", `/dealers/${silent.id}/reject`)).body,
    ).toMatchObject({ status: "rejected", rejection_reason: null });
    // Approving never stores a reason.
    const approved = (await add(ali)).body;
    expect(
      (
        await send(admin, "post", `/dealers/${approved.id}/approve`, {
          reason: "x",
        })
      ).body.rejection_reason,
    ).toBe(null);
  });
  it("edits details without changing the submission or review, and refuses a stale edit", async () => {
    const d = (await add(ali, { name: "Old Name", city: "Lahore" })).body;
    const approved = (await send(admin, "post", `/dealers/${d.id}/approve`))
      .body;
    const res = await send(admin, "patch", `/dealers/${d.id}`, {
      expected_updated_at: approved.updated_at,
      name: " New Name ",
      phone: "0345 9876543",
      city: "",
      notes: "Met at the expo",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "New Name",
      phone: "+923459876543",
      city: null,
      notes: "Met at the expo",
      status: "approved",
      submitted_by: { id: ali },
      reviewed_by: { id: admin },
      reviewed_at: approved.reviewed_at,
      created_at: d.created_at,
      updated_by: { id: admin },
    });
    const stale = await send(admin, "patch", `/dealers/${d.id}`, {
      expected_updated_at: approved.updated_at,
      name: "Overwrite",
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toMatch(/Someone changed this dealer/);
    const same = await send(admin, "patch", `/dealers/${d.id}`, {
      expected_updated_at: res.body.updated_at,
      name: "New Name",
    });
    expect(same.body.unchanged).toBe(true);
    const update = (await audits(d.id)).find(
      (a) => a.action === "dealer.update",
    );
    expect(update.actor_id).toBe(admin);
    expect(update.metadata.fields).toEqual(["city", "name", "notes", "phone"]);
    expect(update.metadata.changes).toEqual({
      city: { before: "Lahore", after: null },
      name: { before: "Old Name", after: "New Name" },
      notes: { before: null, after: "Met at the expo" },
    });
    expect(JSON.stringify(update)).not.toMatch(/987654|300/);
    const detail = (await get(admin, `/dealers/${d.id}`)).body;
    expect(detail.history.map((h) => [h.action, h.actor.name])).toEqual([
      ["dealer.create", "Ali Agent"],
      ["dealer.approve", "Owner"],
      ["dealer.update", "Owner"],
    ]);
    // Required details cannot be emptied.
    const empty = await send(admin, "patch", `/dealers/${d.id}`, {
      expected_updated_at: res.body.updated_at,
      address: "  ",
    });
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("Address is required");
  });
  it("refuses an edit that gives the owner the same number twice", async () => {
    const first = (await add(ali, { phone: "03005550001" })).body;
    const second = (await add(ali, { phone: "03005550002" })).body;
    const res = await send(admin, "patch", `/dealers/${second.id}`, {
      expected_updated_at: (await get(admin, `/dealers/${second.id}`)).body
        .updated_at,
      phone: "+923005550001",
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(first.reference);
  });
  it("deletes softly, hides the dealer from its agent, and restores it", async () => {
    const d = (await add(ali)).body;
    const del = await send(admin, "post", `/dealers/${d.id}/delete`, {
      reason: "Entered by mistake",
    });
    expect(del.body).toMatchObject({
      deleted_by: { id: admin },
      delete_reason: "Entered by mistake",
    });
    expect(
      (await send(admin, "post", `/dealers/${d.id}/delete`)).body.unchanged,
    ).toBe(true);
    expect((await get(ali, `/dealers/${d.id}`)).status).toBe(404);
    expect((await get(ali, "/dealers")).body.count).toBe(0);
    expect((await get(admin, "/dealers")).body.count).toBe(0);
    const bin = await get(admin, "/dealers?view=deleted");
    expect(bin.body.data.map((x) => x.id)).toEqual([d.id]);
    expect(bin.body.summary.deleted).toBe(1);
    // Deleted dealers cannot be reviewed or changed until restored.
    expect((await send(admin, "post", `/dealers/${d.id}/approve`)).status).toBe(
      409,
    );
    const restored = await send(admin, "post", `/dealers/${d.id}/restore`);
    expect(restored.body).toMatchObject({
      deleted_at: null,
      status: "pending",
    });
    expect((await get(ali, `/dealers/${d.id}`)).status).toBe(200);
    expect((await audits(d.id)).map((a) => [a.action, a.actor_id])).toEqual([
      ["dealer.create", ali],
      ["dealer.delete", admin],
      ["dealer.restore", admin],
    ]);
    expect(await one("select count(*)::int n from dealers")).toEqual({ n: 1 });
  });
  it("refuses to restore a dealer whose number its owner has since added again", async () => {
    const d = (await add(ali, { phone: "03006660001" })).body;
    await send(admin, "post", `/dealers/${d.id}/delete`);
    const again = (await add(ali, { phone: "03006660001" })).body;
    const res = await send(admin, "post", `/dealers/${d.id}/restore`);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain(again.reference);
  });
  it("shows administrators the records that share a number, without merging them", async () => {
    const a = (await add(ali, { phone: "03007770001" })).body;
    const s = (await add(sara, { phone: "+923007770001" })).body;
    await add(sara, { phone: "03007770002" });
    const list = await get(admin, "/dealers?duplicates=true");
    expect(list.body.data.map((d) => d.id).sort()).toEqual([a.id, s.id].sort());
    expect(list.body.data.every((d) => d.duplicates === 1)).toBe(true);
    expect(list.body.summary.duplicates).toBe(2);
    const detail = (await get(admin, `/dealers/${a.id}`)).body;
    expect(detail.possible_duplicates).toEqual([
      expect.objectContaining({
        id: s.id,
        submitted_by: expect.objectContaining({ name: "Sara Agent" }),
      }),
    ]);
    expect(await one("select count(*)::int n from dealers")).toEqual({ n: 3 });
  });
  it("writes readable audit history with the real actor", async () => {
    const d = (await add(ali, { name: "Readable Realty" })).body;
    await send(admin, "post", `/dealers/${d.id}/reject`, {
      reason: "Duplicate office",
    });
    const rows = await all(
      "select a.*,jsonb_build_object('id',p.id,'name',p.name,'role',p.role) actor,jsonb_build_object('id',g.id,'name',g.name,'role',g.role) agent from audit_log a join profiles p on p.id=a.actor_id left join profiles g on g.id=(a.metadata->>'agent_id')::uuid where entity='dealers' order by a.id",
    );
    const [created, rejected] = rows.map(presentAuditEntry);
    expect(created).toMatchObject({
      title: "Added a dealer",
      module: { key: "dealers", label: "Dealer network" },
      actor: { name: "Ali Agent" },
    });
    expect(created.description).toBe(
      `Submitted dealer “Readable Realty” (${d.reference}) for approval.`,
    );
    expect(rejected).toMatchObject({
      title: "Rejected a dealer",
      kind: { key: "review" },
      actor: { name: "Owner" },
      reason: "Duplicate office",
    });
    expect(rejected.description).toBe(
      `Rejected dealer “Readable Realty” (${d.reference}), added by Ali Agent.`,
    );
  });
});

describe("the database update", () => {
  it("gives browser roles no access to dealers or their functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect(
        (
          await one(
            "select has_table_privilege($1,'public.dealers','select') ok",
            [role],
          )
        ).ok,
      ).toBe(false);
      const callable = await all(
        "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'dealer%' and has_function_privilege($1,p.oid,'execute')",
        [role],
      );
      expect(callable).toEqual([]);
    }
    expect(
      (
        await one(
          "select relrowsecurity rls from pg_class where oid='public.dealers'::regclass",
        )
      ).rls,
    ).toBe(true);
    const service = await all(
      "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'dealer%' and has_function_privilege('service_role',p.oid,'execute') order by 1",
    );
    // Update 059 adds the agent's Edit, the review of proposed changes and
    // a review of new dealers that names the version reviewed.
    expect(service.map((r) => r.proname)).toEqual([
      "dealer_change_review",
      "dealer_check_phone",
      "dealer_create",
      "dealer_delete",
      "dealer_detail",
      "dealer_restore",
      "dealer_review",
      "dealer_review",
      "dealer_submit_changes",
      "dealer_update",
      "dealers_page",
    ]);
    // PostgREST runs stable functions read-only; these write or lock rows.
    const stable = await all(
      "select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname = any($1) and p.provolatile<>'v'",
      [service.map((r) => r.proname)],
    );
    expect(stable).toEqual([]);
  });
  it("can be applied again without changing dealers", async () => {
    const d = (await add(ali)).body;
    await pg.exec(
      await readFile(
        new URL(
          "../../supabase/migrations/049_dealer_affiliate_network.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    expect(
      await one("select name,status from dealers where id=$1", [d.id]),
    ).toEqual({
      name: d.name,
      status: "pending",
    });
  });
});
