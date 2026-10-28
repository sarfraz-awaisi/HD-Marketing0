import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import {
  fieldsText,
  presentAuditEntry,
  sanitizeMetadata,
} from "../src/services/auditHistory.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 043: the Audit history page describes entries in plain English and
// resolves people and records in one query, without changing any entry.
const admin = "ad000000-0000-4000-8000-000000000001",
  agent = "ad000000-0000-4000-8000-000000000002",
  other = "ad000000-0000-4000-8000-000000000003";
const owner = {
  id: admin,
  name: "Owner",
  role: "admin",
  uid: 100001,
  active: true,
  deleted: false,
};
const ali = {
  id: agent,
  name: "Ali Agent",
  role: "agent",
  uid: 100002,
  active: true,
  deleted: false,
};
const row = (extra) => ({
  id: 1,
  created_at: "2026-10-28T11:14:00Z",
  action: "create",
  entity: "leads",
  entity_id: null,
  actor_id: admin,
  request_id: "req-1",
  metadata: {},
  actor: owner,
  affected: null,
  agent: null,
  lead: null,
  property: null,
  document: null,
  import: null,
  ...extra,
});

describe("plain-English audit entries", () => {
  it("describes property listings and photos", () => {
    const property = { title: "Park View Residence", number: 12 };
    const created = presentAuditEntry(
      row({
        entity: "properties",
        property,
        metadata: { fields: ["price"], ownership: "company" },
      }),
    );
    expect(created).toMatchObject({
      title: "Created a property listing",
      description:
        "Created “Park View Residence” (PR-000012) in the company inventory.",
      module: { key: "properties", label: "Properties" },
      kind: { key: "create" },
      record: { label: "Park View Residence", detail: "PR-000012" },
      actor: { type: "person", name: "Owner", detail: "Admin · UID 100001" },
    });
    expect(
      presentAuditEntry(
        row({
          action: "update",
          entity: "properties",
          property,
          metadata: { fields: ["price", "availability"] },
        }),
      ).description,
    ).toBe(
      "Updated “Park View Residence” (PR-000012): price and availability status.",
    );
    expect(
      presentAuditEntry(
        row({ action: "upload_photo", entity: "properties", property }),
      ),
    ).toMatchObject({
      title: "Uploaded a property photo",
      description: "Added a photo to “Park View Residence” (PR-000012).",
      changes: [],
    });
    expect(
      presentAuditEntry(
        row({
          action: "delete",
          entity: "properties",
          entity_id: "x",
          metadata: { photo_count: 3 },
        }),
      ),
    ).toMatchObject({
      title: "Deleted a property listing",
      description: "Deleted a property listing and its 3 photos.",
      record: { label: "Deleted property" },
    });
  });

  it("describes lead activity with the lead number and agent, never the phone", () => {
    const lead = { number: "HD-000123", deleted: false };
    expect(presentAuditEntry(row({ action: "create", lead })).description).toBe(
      "Created lead HD-000123.",
    );
    expect(
      presentAuditEntry(
        row({
          action: "assign",
          lead,
          agent: ali,
          metadata: { agent_id: agent },
        }),
      ),
    ).toMatchObject({
      title: "Assigned a lead",
      description: "Assigned lead HD-000123 to Ali Agent.",
    });
    const status = presentAuditEntry(
      row({
        action: "status_change",
        lead,
        metadata: {
          from_status: "interested",
          to_status: "visit_scheduled",
          fields: ["status"],
        },
      }),
    );
    expect(status.description).toBe(
      "Moved lead HD-000123 from Interested to Visit scheduled.",
    );
    expect(status.changes).toEqual([
      { label: "Lead status", before: "Interested", after: "Visit scheduled" },
    ]);
    expect(
      presentAuditEntry(
        row({
          action: "import",
          entity: "lead_imports",
          import: { file_name: "october.xlsx", deleted: false },
          metadata: { imported_count: 40, rejected_count: 2 },
        }),
      ).description,
    ).toBe(
      "Imported 40 leads from the file “october.xlsx”; 2 rows could not be imported.",
    );
    expect(
      presentAuditEntry(
        row({
          action: "lead.bulk_assigned",
          metadata: { assigned: 5, skipped: 1, failed: 0 },
        }),
      ).description,
    ).toBe(
      "Assigned several leads in one action (5 leads assigned and 1 skipped).",
    );
    expect(
      presentAuditEntry(
        row({
          action: "lead.phone_revealed",
          lead,
          metadata: { fields: ["user_id", "lead_id", "revealed_at"] },
        }),
      ),
    ).toMatchObject({
      title: "Viewed a lead's phone number",
      kind: { key: "view" },
    });
  });

  it("describes account management without confusing the admin and the employee", () => {
    const created = presentAuditEntry(
      row({
        action: "account.created",
        entity: "profiles",
        affected: ali,
        metadata: {
          role: "agent",
          uid: 100002,
          uid_source: "auto",
          active: true,
        },
      }),
    );
    expect(created).toMatchObject({
      title: "Created an employee account",
      description: "Created Ali Agent's agent account with UID 100002.",
      actor: { name: "Owner" },
      record: { label: "Ali Agent", detail: "Agent · UID 100002" },
    });
    expect(
      presentAuditEntry(
        row({
          action: "manage_account",
          entity: "profiles",
          affected: ali,
          metadata: { fields: ["role", "active"] },
        }),
      ).description,
    ).toBe(
      "Changed Ali Agent's account: role and access (enabled or disabled).",
    );
  });

  it("describes historical attendance entries from update 042", () => {
    const at = (state, inAt, outAt, punctuality) => ({
      state,
      check_in_at: inAt,
      check_out_at: outAt,
      punctuality,
    });
    const added = presentAuditEntry(
      row({
        action: "attendance.manual_create",
        entity: "attendance_records",
        affected: ali,
        metadata: {
          user_id: agent,
          date: "2026-10-22",
          status: "present",
          reason: "Paper register",
          counted: true,
          before: { state: "not_counted" },
          after: at(
            "checked_out",
            "2026-10-22T05:00:00+00:00",
            "2026-10-22T13:00:00+00:00",
            "on_time",
          ),
        },
      }),
    );
    expect(added).toMatchObject({
      title: "Added historical attendance",
      description:
        "Added Ali Agent's attendance on October 22, 2026: Present (10:00 AM – 6:00 PM).",
      actor: { name: "Owner" },
      record: { label: "Ali Agent", detail: "October 22, 2026" },
      reason: "Paper register",
      changes: [
        {
          label: "Attendance",
          before: "Not counted",
          after: "Present (10:00 AM – 6:00 PM)",
        },
      ],
    });
    const corrected = presentAuditEntry(
      row({
        action: "attendance.manual_update",
        affected: ali,
        metadata: {
          user_id: agent,
          date: "2026-10-22",
          status: "late",
          before: at(
            "checked_out",
            "2026-10-22T05:00:00+00:00",
            "2026-10-22T13:00:00+00:00",
            "on_time",
          ),
          after: at(
            "checked_out",
            "2026-10-22T05:40:00+00:00",
            "2026-10-22T13:00:00+00:00",
            "late",
          ),
        },
      }),
    );
    expect(corrected.title).toBe("Corrected an attendance record");
    expect(corrected.description).toBe(
      "Changed Ali Agent's attendance on October 22, 2026 from Present (10:00 AM – 6:00 PM) to Late (10:40 AM – 6:00 PM).",
    );
    const removed = presentAuditEntry(
      row({
        action: "attendance.manual_update",
        affected: ali,
        metadata: {
          user_id: agent,
          date: "2026-10-23",
          status: "clear",
          before: { state: "checked_out" },
          after: { state: "not_counted" },
        },
      }),
    );
    expect(removed).toMatchObject({
      title: "Removed a historical attendance entry",
      description:
        "Removed Ali Agent's attendance entry on October 23, 2026; the day is no longer counted.",
    });
    expect(
      presentAuditEntry(
        row({
          action: "attendance.manual_create",
          entity: "attendance_leave_requests",
          affected: ali,
          metadata: {
            user_id: agent,
            date: "2026-10-21",
            status: "leave",
            after: { state: "leave", leave_type: "sick" },
          },
        }),
      ),
    ).toMatchObject({
      title: "Recorded employee leave",
      description: "Recorded sick leave for Ali Agent on October 21, 2026.",
    });
    expect(
      presentAuditEntry(
        row({
          action: "attendance.tracking_start_moved",
          entity: "attendance_policies",
          affected: ali,
          metadata: {
            user_id: agent,
            from: "2026-10-28",
            to: "2026-10-20",
            reason: null,
          },
        }),
      ),
    ).toMatchObject({
      title: "Moved the start of attendance tracking",
      changes: [
        {
          label: "Tracking starts",
          before: "October 28, 2026",
          after: "October 20, 2026",
        },
      ],
      reason: null,
    });
    // An employee's own check-in: the employee both acted and is affected.
    const checkIn = presentAuditEntry(
      row({
        action: "attendance.check_in",
        entity: "attendance_records",
        actor: ali,
        actor_id: agent,
        metadata: { date: "2026-10-28", punctuality: "late", late_minutes: 20 },
      }),
    );
    expect(checkIn).toMatchObject({
      description: "Checked in on October 28, 2026, 20 min late.",
      actor: { name: "Ali Agent" },
      record: { label: "Ali Agent", detail: "October 28, 2026" },
    });
    // An administrator adding a holiday affects no employee.
    expect(
      presentAuditEntry(
        row({
          action: "attendance.holiday_added",
          entity: "attendance_holidays",
          metadata: { date: "2026-11-09" },
        }),
      ).record,
    ).toBeNull();
  });

  it("names deleted, unknown and automatic actors safely", () => {
    expect(
      presentAuditEntry(
        row({ actor: { ...owner, deleted: true, active: false } }),
      ).actor,
    ).toEqual({
      type: "person",
      name: "Owner (deleted account)",
      detail: "Admin · UID 100001",
      note: "Account deleted",
    });
    expect(
      presentAuditEntry(row({ actor: null, actor_id: null })).actor,
    ).toMatchObject({ type: "unknown", name: "Unknown user" });
    expect(
      presentAuditEntry(
        row({
          action: "attendance.marked_incomplete",
          entity: "attendance_records",
          actor: null,
          actor_id: null,
          request_id: "job:attendance",
          affected: ali,
          metadata: { user_id: agent, date: "2026-10-27" },
        }),
      ),
    ).toMatchObject({
      actor: { type: "system", name: "System" },
      module: { key: "system" },
      description:
        "Marked Ali Agent's check-in on October 27, 2026 as incomplete because no check-out was recorded.",
    });
  });

  it("formats field lists and shows old and new values only when recorded", () => {
    expect(fieldsText(["price", "availability"])).toBe(
      "price and availability status",
    );
    expect(fieldsText(["name", "budget_min", "budget_max"])).toBe(
      "name, minimum budget and maximum budget",
    );
    expect(
      fieldsText(Array.from({ length: 10 }, (_, i) => `field_${i}`)),
    ).toMatch(/and 3 more$/);
    expect(fieldsText("price")).toBeNull();
    expect(
      presentAuditEntry(
        row({ action: "status_change", metadata: { fields: ["status"] } }),
      ),
    ).toMatchObject({
      description: "Changed the status of a lead.",
      changes: [],
    });
    expect(
      presentAuditEntry(
        row({
          action: "update",
          entity: "leads",
          metadata: { fields: ["name"] },
        }),
      ).changes,
    ).toEqual([]);
  });

  it("hides secrets and personal contact details in the technical details", () => {
    const shown = sanitizeMetadata({
      password: "hunter2",
      new_password: "x",
      token: "abc",
      api_key: "k",
      otp: "123456",
      email_code: "654321",
      phone: "+923001234567",
      phones: ["+923001234567"],
      note: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
      error_code: "rate_limited",
      nested: { secret: "s", session_id: "x", fields: ["password", "phone"] },
      leads: 3,
      shipping: "kept",
    });
    expect(shown).toEqual({
      password: "[hidden]",
      new_password: "[hidden]",
      token: "[hidden]",
      api_key: "[hidden]",
      otp: "[hidden]",
      email_code: "[hidden]",
      phone: "[hidden]",
      phones: "[hidden]",
      note: "[hidden]",
      error_code: "rate_limited",
      nested: {
        secret: "[hidden]",
        session_id: "[hidden]",
        fields: ["password", "phone"],
      },
      leads: 3,
      shipping: "kept",
    });
    expect(
      presentAuditEntry(row({ metadata: { token: "abc" } })).technical.metadata,
    ).toEqual({ token: "[hidden]" });
  });

  it("never fails on empty, malformed or unknown entries", () => {
    for (const metadata of [
      null,
      [],
      "text",
      7,
      { fields: "x", before: "y", after: 3, date: "not a date" },
    ])
      expect(() =>
        presentAuditEntry(
          row({ action: "attendance.manual_update", metadata }),
        ),
      ).not.toThrow();
    const unknown = presentAuditEntry(
      row({
        action: "billing.invoice_sent",
        entity: "invoices",
        actor: null,
        actor_id: null,
      }),
    );
    expect(unknown).toMatchObject({
      title: "Billing invoice sent",
      module: { key: "other", label: "Other" },
      technical: { action: "billing.invoice_sent", entity: "invoices" },
    });
    expect(unknown.description).toMatch(/technical details/);
  });
});

describe("audit history API", () => {
  let pg, db, one, all, calls;
  beforeAll(async () => {
    ({ pg, db, one, all } = await startCrmDatabase());
  }, 60000);
  afterAll(async () => {
    await pg?.close();
  });
  let propertyId, leadId, uids;
  beforeEach(async () => {
    await resetPeople(pg, [admin, agent, other]);
    calls = 0;
    propertyId = (
      await one(
        "insert into properties(title,location,price,type,area,area_unit) values('Park View Residence','Lahore',100,'House',5,'marla') returning id",
      )
    ).id;
    leadId = (
      await one(
        "insert into leads(name,masked_phone,assigned_agent) values('Buyer','+92******567',$1) returning id",
        [agent],
      )
    ).id;
    uids = Object.fromEntries(
      (await all("select id,uid from profiles")).map((p) => [p.id, p.uid]),
    );
    const add = (
      actor,
      action,
      entity,
      entityId,
      metadata,
      day,
      request = "req",
    ) =>
      pg.query(
        "insert into audit_log(actor_id,action,entity,entity_id,request_id,metadata,created_at) values($1,$2,$3,$4,$5,$6,$7)",
        [
          actor,
          action,
          entity,
          entityId,
          request,
          metadata,
          `${day}T10:00:00+05:00`,
        ],
      );
    await add(
      admin,
      "create",
      "properties",
      propertyId,
      { fields: ["title"], ownership: "company" },
      "2026-10-20",
    );
    await add(
      admin,
      "assign",
      "leads",
      leadId,
      { agent_id: agent },
      "2026-10-21",
    );
    await add(
      admin,
      "attendance.manual_create",
      "attendance_records",
      "r1",
      {
        user_id: agent,
        date: "2026-10-22",
        status: "present",
        before: { state: "not_counted" },
        after: { state: "checked_out" },
      },
      "2026-10-22",
    );
    await add(
      agent,
      "attendance.check_in",
      "attendance_records",
      "r2",
      { date: "2026-10-23", punctuality: "on_time", late_minutes: 0 },
      "2026-10-23",
    );
    await add(
      null,
      "attendance.marked_incomplete",
      "attendance_records",
      "r3",
      { user_id: other, date: "2026-10-24" },
      "2026-10-24",
      "job:attendance",
    );
    await add(
      other,
      "manage_account",
      "profiles",
      agent,
      { fields: ["name"], token: "should-not-show" },
      "2026-10-25",
    );
    await pg.query(
      "update profiles set deletion_requested_at=now(),deleted_at=now(),active=false where id=$1",
      [other],
    );
  });
  const counting = () => ({
    ...db,
    // Counts the audit queries only; sign-in checks are not part of the page.
    rpc: (name, args) => {
      if (name.startsWith("audit_")) calls++;
      return db.rpc(name, args);
    },
  });
  const app = () => createApp(trustedMfaFixture(counting()));
  const as = (user) => ({ Authorization: "Bearer " + user });
  const get = (path, user = admin) => request(app()).get(path).set(as(user));
  const snapshot = () =>
    one(
      "select count(*)::integer n, md5(string_agg(id::text||action||coalesce(actor_id::text,'')||metadata::text, '|' order by id)) h from audit_log",
    );

  it("resolves who acted and who or what was affected, in plain English", async () => {
    const r = await get("/api/audit");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ count: 6, page: 1, limit: 20 });
    expect(
      r.body.data.map((e) => [e.title, e.actor.name, e.record?.label]),
    ).toEqual([
      [
        "Updated an employee account",
        "Sara Agent (deleted account)",
        "Ali Agent",
      ],
      ["Marked a missing check-out", "System", "Sara Agent (deleted account)"],
      ["Checked in", "Ali Agent", "Ali Agent"],
      ["Added historical attendance", "Owner", "Ali Agent"],
      ["Assigned a lead", "Owner", expect.stringMatching(/^Lead HD-\d{6}$/)],
      ["Created a property listing", "Owner", "Park View Residence"],
    ]);
    expect(r.body.data[4].description).toBe(
      `Assigned lead ${r.body.data[4].record.label.slice(5)} to Ali Agent.`,
    );
    expect(r.body.data[3].actor.detail).toBe(`Admin · UID ${uids[admin]}`);
    expect(r.body.data[0].actor.note).toBe("Account deleted");
    // Technical details keep the original values, without secrets.
    expect(r.body.data[0].technical).toMatchObject({
      action: "manage_account",
      entity: "profiles",
      actor_id: other,
      entity_id: agent,
      request_id: "req",
    });
    expect(r.body.data[0].technical.metadata.token).toBe("[hidden]");
    expect(JSON.stringify(r.body)).not.toContain("should-not-show");
    expect(r.body.modules.map((m) => m.key)).toContain("attendance");
    expect(calls).toBe(1);
  });

  it("searches by name or UID of the person who acted or was affected", async () => {
    const byName = await get("/api/audit?search=Ali");
    expect(byName.body.data.map((e) => e.title)).toEqual([
      "Updated an employee account",
      "Checked in",
      "Added historical attendance",
    ]);
    const byUid = await get(`/api/audit?search=${uids[admin]}`);
    expect(byUid.body.count).toBe(3);
    expect((await get("/api/audit?search=Nobody")).body.count).toBe(0);
  });

  it("filters by module, action type, person and Pakistan date range", async () => {
    expect(
      (await get("/api/audit?module=attendance")).body.data.map((e) => e.title),
    ).toEqual(["Checked in", "Added historical attendance"]);
    expect((await get("/api/audit?module=system")).body.count).toBe(1);
    expect(
      (await get("/api/audit?kind=assign")).body.data.map((e) => e.title),
    ).toEqual(["Assigned a lead"]);
    expect(
      (await get("/api/audit?module=properties&kind=assign")).body.count,
    ).toBe(0);
    expect((await get(`/api/audit?actor=${agent}`)).body.count).toBe(1);
    const days = await get("/api/audit?from=2026-10-21&to=2026-10-23");
    expect(days.body.data.map((e) => e.title)).toEqual([
      "Checked in",
      "Added historical attendance",
      "Assigned a lead",
    ]);
    const people = await get("/api/audit/actors");
    expect(people.body.map((p) => p.name)).toEqual([
      "Ali Agent",
      "Owner",
      "Sara Agent (deleted account)",
    ]);
  });

  it("sorts and pages on the server", async () => {
    const oldest = await get("/api/audit?sort=oldest&limit=2&page=2");
    expect(oldest.body).toMatchObject({ count: 6, page: 2, limit: 2 });
    expect(oldest.body.data.map((e) => e.title)).toEqual([
      "Added historical attendance",
      "Checked in",
    ]);
    expect((await get("/api/audit?limit=2&page=4")).body.data).toEqual([]);
  });

  it("keeps the audit history for administrators and never changes an entry", async () => {
    const before = await snapshot();
    for (const path of [
      "/api/audit",
      "/api/audit/actors",
      "/api/audit?module=leads",
    ])
      expect((await get(path, agent)).status).toBe(403);
    const direct = await db.rpc("audit_page", {
      p_actor: agent,
      p_filters: {},
      p_page: 1,
      p_limit: 20,
    });
    expect(direct.error?.code).toBe("42501");
    for (const path of [
      "/api/audit?module=billing",
      "/api/audit?from=2026-13-01",
      "/api/audit?sort=random",
      "/api/audit?limit=500",
      "/api/audit?from=2026-10-25&to=2026-10-20",
      "/api/audit?actor=nobody",
    ])
      expect((await get(path)).status).toBe(400);
    await get("/api/audit?search=Ali&module=attendance");
    expect(await snapshot()).toEqual(before);
    await expect(pg.query("update audit_log set action='x'")).rejects.toThrow(
      "append-only",
    );
  });

  it("reads a large history in one query per page", async () => {
    await pg.query(
      "insert into audit_log(actor_id,action,entity,entity_id,request_id,metadata) select case when g%2=0 then $1::uuid else $2::uuid end,'assign','leads',$3,'bulk',jsonb_build_object('agent_id',$2::text) from generate_series(1,300) g",
      [admin, agent, leadId],
    );
    calls = 0;
    const r = await get("/api/audit?limit=100&page=2");
    expect(r.body.count).toBe(306);
    expect(r.body.data).toHaveLength(100);
    expect(
      r.body.data.every((e) => e.record?.label?.startsWith("Lead HD-")),
    ).toBe(true);
    expect(calls).toBe(1);
  });

  it("explains a missing database update", async () => {
    const missing = {
      ...db,
      rpc: async (name, args) =>
        name.startsWith("audit_")
          ? { data: null, error: { code: "PGRST202", message: "not found" } }
          : db.rpc(name, args),
    };
    const r = await request(createApp(trustedMfaFixture(missing)))
      .get("/api/audit")
      .set(as(admin));
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("Audit history needs CRM database update 043.");
  });
});
