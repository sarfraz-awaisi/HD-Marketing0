import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";

const admin = "20000000-0000-4000-8000-000000000001";
const agent = "20000000-0000-4000-8000-000000000002";
const other = "20000000-0000-4000-8000-000000000003";
let db,
  property,
  lead,
  phoneIndex = 0;
const one = async (sql, args = []) => (await db.query(sql, args)).rows[0];
const mutate = async (
  table,
  id,
  data,
  actor = agent,
  requestId = randomUUID(),
) =>
  (
    await one("select public.crm_mutate($1,$2,$3::jsonb,$4,$5) as result", [
      table,
      id,
      JSON.stringify(data),
      actor,
      requestId,
    ])
  ).result;

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm } });
  await db.exec(
    "create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}'); create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  const dir = new URL("../../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir)).sort())
    await db.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await db.query("insert into auth.users(id) values($1),($2),($3)", [
    admin,
    agent,
    other,
  ]);
  await db.query(
    "update public.profiles set active=true,role='admin' where id=$1",
    [admin],
  );
  await db.query("update profiles set active=true where id=any($1::uuid[])", [
    [agent, other],
  ]);
  property = (
    await one(
      "insert into properties(title,location,price,type,area,area_unit) values('Pipeline house','Lahore',100,'House',5,'marla') returning id",
    )
  ).id;
}, 30000);
afterAll(async () => {
  await db?.close();
});
beforeEach(async () => {
  await db.query("update profiles set active=true where id=any($1::uuid[])", [
    [agent, other],
  ]);
  lead = (
    await one("select (public.create_lead($1::jsonb,$2,$3,$4)).id", [
      JSON.stringify({
        name: "Pipeline lead",
        assigned_agent: agent,
        source: "CSV",
        budget_min: 5000000,
      }),
      "+92300" + String(++phoneIndex).padStart(7, "0"),
      admin,
      "fixture:create",
    ])
  ).id;
});

describe("F1 pipeline transactions", () => {
  it("rejects missing, unknown or oversized lost details in SQL and leaves no history", async () => {
    for (const data of [
      { status: "lost" },
      { status: "lost", lost_reason: "invented" },
      { status: "lost", lost_reason: "price", lost_note: "x".repeat(501) },
    ])
      await expect(mutate("leads", lead, data)).rejects.toMatchObject({
        code: "23514",
      });
    await expect(
      db.query("update leads set status='lost' where id=$1", [lead]),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("new");
    expect(
      (
        await one(
          "select count(*)::int n from lead_status_history where lead_id=$1",
          [lead],
        )
      ).n,
    ).toBe(0);
  });

  it("writes exactly one history and one audit row with actor/request IDs and no note text", async () => {
    const requestId = randomUUID();
    const note = "Customer chose another property";
    const row = await mutate(
      "leads",
      lead,
      { status: "lost", lost_reason: "bought_elsewhere", lost_note: note },
      agent,
      requestId,
    );
    expect(row).toMatchObject({
      status: "lost",
      lost_reason: "bought_elsewhere",
      lost_note: note,
    });
    expect(row.lost_at).toBeTruthy();
    const history = (
      await db.query("select * from lead_status_history where lead_id=$1", [
        lead,
      ])
    ).rows;
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      from_status: "new",
      to_status: "lost",
      actor_id: agent,
      lost_reason: "bought_elsewhere",
      request_id: requestId,
    });
    const audit = (
      await db.query(
        "select * from audit_log where entity_id=$1 and request_id=$2",
        [lead, requestId],
      )
    ).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("status_change");
    expect(JSON.stringify(audit)).not.toContain(note);
    await mutate("leads", lead, {
      status: "lost",
      lost_reason: "bought_elsewhere",
    });
    expect(
      (
        await one(
          "select count(*)::int n from lead_status_history where lead_id=$1",
          [lead],
        )
      ).n,
    ).toBe(1);
  });

  it("rejects another agent, disabled actors and forbidden lead fields", async () => {
    await expect(
      mutate("leads", lead, { status: "lost", lost_reason: "price" }, other),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      mutate("leads", lead, { status: "contacted", name: "Overwrite" }),
    ).rejects.toMatchObject({ code: "42501" });
    await db.query("update profiles set active=false where id=$1", [other]);
    try {
      await expect(
        mutate("leads", lead, { status: "contacted" }, other),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await db.query("update profiles set active=true where id=$1", [other]);
    }
    await db.query("select assign_lead($1,$2,$3,$4)", [
      lead,
      admin,
      other,
      "reassign",
    ]);
    await expect(
      mutate("leads", lead, { status: "contacted" }, agent),
    ).rejects.toMatchObject({ code: "42501" });
    expect(
      (await mutate("leads", lead, { status: "contacted" }, other)).status,
    ).toBe("contacted");
  });

  it("progresses calls, scheduled/completed visits and won deals without moving backwards", async () => {
    const call = await mutate("calls", null, {
      lead_id: lead,
      status: "initiated",
    });
    await mutate("calls", call.id, {
      status: "completed",
      ended_at: new Date().toISOString(),
    });
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("contacted");
    const visit = await mutate("visits", null, {
      lead_id: lead,
      property_id: property,
      scheduled_at: new Date().toISOString(),
      status: "scheduled",
    });
    await mutate("visits", visit.id, { status: "completed" });
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("visit_done");
    const lateCall = await mutate("calls", null, {
      lead_id: lead,
      status: "initiated",
    });
    await mutate("calls", lateCall.id, { status: "completed" });
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("visit_done");
    const deal = await mutate("deals", null, {
      lead_id: lead,
      property_id: property,
      stage: "discussion",
      expected_value: 100,
    });
    await mutate("deals", deal.id, { stage: "won", close_date: "2026-10-08" });
    const stages = (
      await db.query(
        "select to_status from lead_status_history where lead_id=$1 order by created_at",
        [lead],
      )
    ).rows.map((row) => row.to_status);
    expect(stages).toEqual([
      "contacted",
      "visit_scheduled",
      "visit_done",
      "negotiation",
      "won",
    ]);
    const historyCount = stages.length;
    await mutate("visits", null, {
      lead_id: lead,
      property_id: property,
      scheduled_at: new Date().toISOString(),
      status: "scheduled",
    });
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("won");
    expect(
      (
        await one(
          "select count(*)::int n from lead_status_history where lead_id=$1",
          [lead],
        )
      ).n,
    ).toBe(historyCount);
    for (const row of (
      await db.query(
        "select request_id from lead_status_history where lead_id=$1",
        [lead],
      )
    ).rows)
      expect(
        (
          await one(
            "select count(*)::int n from audit_log where entity_id=$1 and request_id=$2 and action='status_change'",
            [lead, row.request_id],
          )
        ).n,
      ).toBe(1);
  });

  it("requires a reason for lost deals and atomically copies the reason to the lead", async () => {
    const deal = await mutate("deals", null, {
      lead_id: lead,
      property_id: property,
      stage: "negotiation",
      expected_value: 100,
    });
    await expect(
      mutate("deals", deal.id, { stage: "lost" }),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (await one("select stage from deals where id=$1", [deal.id])).stage,
    ).toBe("negotiation");
    await mutate("deals", deal.id, {
      stage: "lost",
      lost_reason: "budget",
      lost_note: "Budget too low",
    });
    expect(
      await one("select status,lost_reason,lost_note from leads where id=$1", [
        lead,
      ]),
    ).toEqual({
      status: "lost",
      lost_reason: "budget",
      lost_note: "Budget too low",
    });
    await mutate("leads", lead, { status: "interested" });
    expect(
      await one("select lost_reason,lost_note,lost_at from leads where id=$1", [
        lead,
      ]),
    ).toEqual({ lost_reason: null, lost_note: null, lost_at: null });
  });

  it("advances a new lead on a signed-event SQL application once and keeps terminal leads closed", async () => {
    const call = await mutate("calls", null, {
      lead_id: lead,
      status: "initiated",
      provider_call_id: "mock-" + randomUUID(),
    });
    const event = {
      event_id: randomUUID(),
      provider_call_id: call.provider_call_id,
      status: "completed",
    };
    await db.query("select apply_call_event($1::jsonb)", [
      JSON.stringify(event),
    ]);
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("contacted");
    await db.query("select apply_call_event($1::jsonb)", [
      JSON.stringify(event),
    ]);
    await db.query("select apply_call_event($1::jsonb)", [
      JSON.stringify({ ...event, event_id: randomUUID(), status: "ringing" }),
    ]);
    expect(
      (
        await one(
          "select count(*)::int n from lead_status_history where lead_id=$1",
          [lead],
        )
      ).n,
    ).toBe(1);
    await mutate("leads", lead, { status: "lost", lost_reason: "no_response" });
    await mutate("calls", null, { lead_id: lead, status: "completed" });
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("lost");
  });

  it("denies browser reads of history and execution of automatic stage functions", async () => {
    for (const role of ["anon", "authenticated"]) {
      await db.exec("set role " + role);
      try {
        await expect(
          db.query("select * from lead_status_history"),
        ).rejects.toMatchObject({ code: "42501" });
        await expect(
          db.query("select advance_lead_status($1,'won',$2,'bypass')", [
            lead,
            agent,
          ]),
        ).rejects.toMatchObject({ code: "42501" });
      } finally {
        await db.exec("reset role");
      }
    }
  });

  it("rolls back the lead update if its history insert cannot be persisted", async () => {
    await db.exec(
      "create function public.fail_history_test() returns trigger language plpgsql as $$ begin raise exception 'History unavailable'; end $$; create trigger fail_history_test before insert on public.lead_status_history for each row execute function public.fail_history_test();",
    );
    const requestId = randomUUID();
    try {
      await expect(
        mutate("leads", lead, { status: "interested" }, agent, requestId),
      ).rejects.toThrow("History unavailable");
      expect(
        (await one("select status from leads where id=$1", [lead])).status,
      ).toBe("new");
      expect(
        (
          await one(
            "select count(*)::int n from audit_log where request_id=$1",
            [requestId],
          )
        ).n,
      ).toBe(0);
    } finally {
      await db.exec(
        "drop trigger fail_history_test on public.lead_status_history; drop function public.fail_history_test();",
      );
    }
  });
});

function apiDatabase(role = "agent", owner = agent) {
  const profile = {
    id: role === "admin" ? admin : agent,
    role,
    name: "Pipeline user",
    active: true,
  };
  const client = {
    auth: {
      getUser: async () => ({
        data: {
          user: { id: profile.id, email_confirmed_at: "2026-10-01T00:00:00Z" },
        },
      }),
    },
    rpc: vi.fn(async (name, args) => {
      try {
        return {
          data: (
            await one("select crm_mutate($1,$2,$3::jsonb,$4,$5) as value", [
              args.p_table,
              args.p_id,
              JSON.stringify(args.p_data),
              args.p_actor,
              args.p_request,
            ])
          ).value,
        };
      } catch (error) {
        return { error: { code: error.code } };
      }
    }),
    from: vi.fn((table) => {
      const filters = {};
      const query = {
        select: () => query,
        is: vi.fn(() => query),
        eq: vi.fn((field, value) => {
          filters[field] = value;
          return query;
        }),
        order: () => query,
        single: async () => ({ data: profile }),
        maybeSingle: async () => ({
          data:
            role === "admin" || owner === profile.id
              ? { id: lead, assigned_agent: owner }
              : null,
        }),
        limit: async () => ({
          data:
            table === "lead_status_history"
              ? [
                  {
                    id: randomUUID(),
                    lead_id: lead,
                    from_status: "new",
                    to_status: "contacted",
                    created_at: "2026-10-08T10:00:00Z",
                  },
                ]
              : [],
        }),
        range: async () => ({ data: [], count: 0 }),
      };
      return query;
    }),
  };
  return client;
}

describe("F1 API validation and access", () => {
  it.each(["admin", "agent"])(
    "returns 400 for missing/invalid/oversized lost details as %s",
    async (role) => {
      const client = apiDatabase(role);
      const app = createApp(trustedMfaFixture(client));
      for (const body of [
        { status: "lost" },
        { status: "lost", lost_reason: "unknown" },
        { status: "lost", lost_reason: "price", lost_note: "x".repeat(501) },
      ])
        expect(
          (
            await request(app)
              .patch("/api/leads/" + lead)
              .set("Authorization", "Bearer valid")
              .send(body)
          ).status,
        ).toBe(400);
      expect(client.rpc).not.toHaveBeenCalled();
    },
  );

  it.each(["admin", "agent"])(
    "stores an authorized lost transition through SQL as %s",
    async (role) => {
      const client = apiDatabase(role);
      const response = await request(createApp(trustedMfaFixture(client)))
        .patch("/api/leads/" + lead)
        .set("Authorization", "Bearer valid")
        .send({
          status: "lost",
          lost_reason: "location",
          lost_note: "Prefers another area",
        });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        status: "lost",
        lost_reason: "location",
        source: "CSV",
        budget_min: 5000000,
      });
      expect(client.rpc).toHaveBeenCalledWith(
        "crm_mutate",
        expect.objectContaining({
          p_actor: role === "admin" ? admin : agent,
          p_table: "leads",
          p_data: {
            status: "lost",
            lost_reason: "location",
            lost_note: "Prefers another area",
          },
        }),
      );
    },
  );

  it("returns 403 when an agent attempts to change a lead after reassignment", async () => {
    await db.query("select assign_lead($1,$2,$3,'reassign')", [
      lead,
      admin,
      other,
    ]);
    const response = await request(createApp(trustedMfaFixture(apiDatabase())))
      .patch("/api/leads/" + lead)
      .set("Authorization", "Bearer valid")
      .send({ status: "lost", lost_reason: "price" });
    expect(response.status).toBe(403);
  });

  it("rejects lost deals without a reason before writing", async () => {
    const client = apiDatabase();
    const app = createApp(trustedMfaFixture(client));
    expect(
      (
        await request(app)
          .post("/api/deals")
          .set("Authorization", "Bearer valid")
          .send({
            lead_id: lead,
            property_id: property,
            stage: "lost",
            expected_value: 100,
          })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .patch("/api/deals/" + randomUUID())
          .set("Authorization", "Bearer valid")
          .send({ stage: "lost" })
      ).status,
    ).toBe(400);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("preserves a cancelled visit and the lead stage when only its notes change", async () => {
    const visit = await mutate("visits", null, {
      lead_id: lead,
      property_id: property,
      scheduled_at: new Date().toISOString(),
      status: "cancelled",
    });
    const client = apiDatabase();
    const response = await request(createApp(trustedMfaFixture(client)))
      .patch("/api/visits/" + visit.id)
      .set("Authorization", "Bearer valid")
      .send({ notes: "Customer postponed the visit" });
    expect(response.status).toBe(200);
    expect(response.body.status).toBe("cancelled");
    expect(client.rpc).toHaveBeenCalledWith(
      "crm_mutate",
      expect.objectContaining({
        p_data: { notes: "Customer postponed the visit" },
      }),
    );
    expect(
      (await one("select status from leads where id=$1", [lead])).status,
    ).toBe("new");
  });

  it("includes stage history in the authorized timeline and denies a different owner", async () => {
    const response = await request(createApp(trustedMfaFixture(apiDatabase())))
      .get("/api/leads/" + lead + "/timeline")
      .set("Authorization", "Bearer valid");
    expect(response.status).toBe(200);
    expect(response.body[0]).toMatchObject({
      kind: "lead_status_history",
      from_status: "new",
      to_status: "contacted",
    });
    expect(
      (
        await request(createApp(trustedMfaFixture(apiDatabase("agent", other))))
          .get("/api/leads/" + lead + "/timeline")
          .set("Authorization", "Bearer valid")
      ).status,
    ).toBe(404);
  });

  it("applies a validated lost reason filter together with current assignment", async () => {
    const client = apiDatabase();
    const app = createApp(trustedMfaFixture(client));
    const response = await request(app)
      .get("/api/leads?lost_reason=budget")
      .set("Authorization", "Bearer valid");
    expect(response.status).toBe(200);
    const query = client.from.mock.results.find(
      (result, index) => client.from.mock.calls[index][0] === "leads",
    ).value;
    expect(query.eq).toHaveBeenCalledWith("assigned_agent", agent);
    expect(query.eq).toHaveBeenCalledWith("lost_reason", "budget");
    expect(
      (
        await request(app)
          .get("/api/leads?lost_reason=unknown")
          .set("Authorization", "Bearer valid")
      ).status,
    ).toBe(400);
  });
});

describe("F1 existing-project upgrade", () => {
  it("maps legacy stages, preserves lost records and changes no private phones", async () => {
    const legacy = new PGlite({ extensions: { pg_trgm } });
    try {
      await legacy.exec(
        "create role anon; create role authenticated; create role service_role bypassrls; create schema auth; create table auth.users(id uuid primary key,email_confirmed_at timestamptz default now(),raw_user_meta_data jsonb default '{}'); create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
      );
      const dir = new URL("../../supabase/migrations/", import.meta.url);
      for (const file of (await readdir(dir))
        .sort()
        .filter((file) => file < "012"))
        await legacy.exec(
          (await readFile(new URL(file, dir), "utf8")).replace(
            "create extension if not exists pgcrypto;",
            "",
          ),
        );
      await legacy.query("insert into auth.users(id) values($1)", [admin]);
      await legacy.query(
        "update profiles set active=true,role='admin' where id=$1",
        [admin],
      );
      const fixtures = [];
      for (const [index, status] of [
        "follow_up",
        "site_visit",
        "lost",
      ].entries()) {
        const row = (
          await legacy.query(
            "select (create_lead($1::jsonb,$2,$3,'legacy')).id",
            [
              JSON.stringify({ name: "Legacy " + status }),
              "+92300123456" + index,
              admin,
            ],
          )
        ).rows[0];
        await legacy.query("update leads set status=$2 where id=$1", [
          row.id,
          status,
        ]);
        fixtures.push(row.id);
      }
      const legacyProperty = (
        await legacy.query(
          "insert into properties(title,location,price,type,area,area_unit) values('Legacy house','Lahore',100,'House',5,'marla') returning id",
        )
      ).rows[0].id;
      await legacy.query(
        "insert into deals(lead_id,property_id,agent_id,stage,expected_value) values($1,$2,$3,'lost',100)",
        [fixtures[2], legacyProperty, admin],
      );
      const before = (
        await legacy.query(
          "select * from crm_private.lead_phones order by phone",
        )
      ).rows;
      await legacy.exec(
        await readFile(
          new URL("012_pipeline_and_lost_reasons.sql", dir),
          "utf8",
        ),
      );
      const result = (
        await legacy.query(
          "select status,lost_reason,lost_note from leads order by name",
        )
      ).rows;
      expect(result.map((row) => row.status)).toEqual([
        "contacted",
        "lost",
        "visit_scheduled",
      ]);
      expect(result[1]).toMatchObject({ lost_reason: "other" });
      expect(result[1].lost_note).toContain("not recorded");
      expect(
        (await legacy.query("select stage,lost_reason from deals")).rows[0],
      ).toEqual({ stage: "lost", lost_reason: "other" });
      expect(
        (
          await legacy.query(
            "select * from crm_private.lead_phones order by phone",
          )
        ).rows,
      ).toEqual(before);
      expect(
        (await legacy.query("select count(*)::int n from lead_status_history"))
          .rows[0].n,
      ).toBe(2);
      expect(
        (
          await legacy.query(
            "select count(*)::int n from audit_log where request_id='migration:012'",
          )
        ).rows[0].n,
      ).toBe(4);
      await expect(
        legacy.query("update leads set status='follow_up' where id=$1", [
          fixtures[0],
        ]),
      ).rejects.toMatchObject({ code: "23514" });
    } finally {
      await legacy.close();
    }
  }, 30000);
});
