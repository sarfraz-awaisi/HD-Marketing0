import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
// Follow-ups promised on calls, the Follow-ups list and the lead activity
// timeline, against every migration. Requests go through the API; a small
// query builder answers the Supabase client's calls with SQL, returning
// timestamps as strings like PostgREST does.
const admin = "f0490000-0000-4000-8000-000000000001",
  ali = "f0490000-0000-4000-8000-000000000002",
  sara = "f0490000-0000-4000-8000-000000000003";
const dir = new URL("../../supabase/migrations/", import.meta.url);
let failNextFollowUp = false;
let pg,
  lead,
  phone = 1000;
const one = async (sql, args = []) => (await pg.query(sql, args)).rows[0];
const all = async (sql, args = []) => (await pg.query(sql, args)).rows;
const plain = (row) =>
  Object.fromEntries(
    Object.entries(row).map(([k, v]) => [
      k,
      v instanceof Date ? v.toISOString() : v,
    ]),
  );
function database() {
  return {
    auth: {
      getUser: async (token) => ({
        data: {
          user: [admin, ali, sara].includes(token)
            ? { id: token, email_confirmed_at: "2026-10-01" }
            : null,
        },
      }),
    },
    rpc: async (name, args = {}) => {
      // Simulates the database refusing the next follow-up save.
      if (
        failNextFollowUp &&
        name === "crm_mutate" &&
        args.p_table === "followups"
      ) {
        failNextFollowUp = false;
        return { error: { code: "XX000", message: "simulated failure" } };
      }
      try {
        return {
          data: (
            await one(
              `select public.${name}(${Object.keys(args)
                .map((key, i) => `${key}=>$${i + 1}`)
                .join(",")}) value`,
              Object.values(args).map((v) =>
                v && typeof v === "object" && !Array.isArray(v)
                  ? JSON.stringify(v)
                  : v,
              ),
            )
          ).value,
        };
      } catch (error) {
        return { error: { code: error.code, message: error.message } };
      }
    },
    from(table) {
      let joins = "",
        fields = "r.*",
        clauses = [],
        values = [],
        sort = [],
        cap = Infinity,
        start = 0;
      const field = (key) =>
        key.startsWith("leads.") ? "l." + key.slice(6) : "r." + key;
      const add = (key, op, value) => {
        values.push(value);
        clauses.push(`${field(key)} ${op} $${values.length}`);
        return q;
      };
      async function run() {
        try {
          const rows = (
            await pg.query(
              `select ${fields} from public.${table} r${joins}${clauses.length ? " where " + clauses.join(" and ") : ""}${sort.length ? " order by " + sort.join(",") : ""}`,
              values,
            )
          ).rows.map(plain);
          return {
            data: rows.slice(start, cap === Infinity ? undefined : start + cap),
            count: rows.length,
          };
        } catch (error) {
          return { error: { code: error.code, message: error.message } };
        }
      }
      const q = {
        select(value = "*") {
          const parts = value.match(/[^,(]+(\([^)]*\))?/g) || ["*"];
          fields = parts
            .map((part) => {
              part = part.trim();
              if (part.startsWith("leads")) {
                joins = " join public.leads l on l.id=r.lead_id";
                return "to_jsonb(l) leads";
              }
              return part === "*" ? "r.*" : "r." + part;
            })
            .join(",");
          return q;
        },
        eq: (key, value) => add(key, "=", value),
        is: (key, value) => add(key, "is not distinct from", value),
        lt: (key, value) => add(key, "<", value),
        lte: (key, value) => add(key, "<=", value),
        gt: (key, value) => add(key, ">", value),
        in(key, list) {
          values.push(list);
          clauses.push(`${field(key)}::text = any($${values.length})`);
          return q;
        },
        order(key, options) {
          sort.push(
            field(key) + (options?.ascending === false ? " desc" : " asc"),
          );
          return q;
        },
        limit(value) {
          cap = value;
          return q;
        },
        range(low, high) {
          start = low;
          cap = high - low + 1;
          return run();
        },
        single: async () => {
          const r = await run();
          return { ...r, data: r.data?.[0] };
        },
        maybeSingle: async () => {
          const r = await run();
          return { ...r, data: r.data?.[0] || null };
        },
        then: (resolve, reject) => run().then(resolve, reject),
      };
      return q;
    },
  };
}
const app = () => createApp(trustedMfaFixture(database()));
const as = (user) => ({ Authorization: "Bearer " + user });
const get = (user, path) =>
  request(app())
    .get("/api" + path)
    .set(as(user));
const send = (user, method, path, body) =>
  request(app())
    [method]("/api" + path)
    .set(as(user))
    .send(body);
const inHours = (h) => new Date(Date.now() + h * 3600000).toISOString();
const call = (change = {}) => ({
  answered: true,
  started_at: new Date(Date.now() - 120000).toISOString(),
  duration_seconds: 90,
  outcome: "Interested",
  notes: "Asked for the payment plan",
  deal_tags: ["Warm lead"],
  ...change,
});
async function customer(owner = ali) {
  return (
    await one("select (create_lead($1::jsonb,$2,$3,$4)).id", [
      JSON.stringify({
        name: "Follow-up customer " + phone,
        assigned_agent: owner,
      }),
      "+92310" + String(phone++).padStart(7, "0"),
      admin,
      "followup-fixture",
    ])
  ).id;
}
beforeAll(async () => {
  pg = new PGlite({ extensions: { pg_trgm } });
  await pg.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
  );
  for (const file of (await readdir(dir)).sort())
    await pg.exec(
      (await readFile(new URL(file, dir), "utf8")).replace(
        "create extension if not exists pgcrypto;",
        "",
      ),
    );
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'owner@example.test',now()),($2,'ali@example.test',now()),($3,'sara@example.test',now())",
    [admin, ali, sara],
  );
  await pg.query(
    "update profiles set active=true,role=case when id=$1 then 'admin' else 'agent' end,name=case id when $1 then 'Owner' when $2 then 'Ali Agent' else 'Sara Agent' end",
    [admin, ali],
  );
}, 120000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  lead = await customer();
});

describe("follow-ups promised on calls", () => {
  it("are scheduled with the call and listed under Follow-ups after a refresh", async () => {
    const at = inHours(26);
    const res = await send(ali, "post", `/leads/${lead}/calls/manual`, {
      ...call({ outcome: "Follow-up required", notes: "Call back on Friday" }),
      follow_up_at: at,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.followup).toMatchObject({
      lead_id: lead,
      agent_id: ali,
      status: "pending",
      notes: "Call outcome: Follow-up required · Call back on Friday",
    });
    expect(Date.parse(res.body.followup.due_at)).toBe(Date.parse(at));
    // A new request each time, as after a page refresh.
    for (const query of [
      "view=pending&sort=due_at&direction=asc",
      "view=upcoming",
      "",
    ]) {
      const list = await get(ali, `/followups?${query}`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect(list.body.data.map((f) => f.lead_id)).toContain(lead);
    }
    expect(
      (await get(ali, "/followups?view=overdue")).body.data.map(
        (f) => f.lead_id,
      ),
    ).not.toContain(lead);
  });
  it("must say when to follow up, in the future, and never create a follow-up otherwise", async () => {
    const missing = await send(
      ali,
      "post",
      `/leads/${lead}/calls/manual`,
      call({ outcome: "Follow-up required" }),
    );
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/^Choose when to follow up/);
    const past = await send(ali, "post", `/leads/${lead}/calls/manual`, {
      ...call({ outcome: "Follow-up required" }),
      follow_up_at: inHours(-2),
    });
    expect(past.status).toBe(400);
    const interested = await send(
      ali,
      "post",
      `/leads/${lead}/calls/manual`,
      call(),
    );
    expect(interested.status).toBe(201);
    expect(interested.body.followup).toBeUndefined();
    expect(
      (await one("select count(*)::int n from calls where lead_id=$1", [lead]))
        .n,
    ).toBe(1);
    expect(
      (
        await one("select count(*)::int n from followups where lead_id=$1", [
          lead,
        ])
      ).n,
    ).toBe(0);
  });
  it("are scheduled once for the same time, even if the form is sent twice", async () => {
    const at = inHours(48);
    for (let i = 0; i < 2; i++) {
      const res = await send(ali, "post", `/leads/${lead}/calls/manual`, {
        ...call({ outcome: "Follow-up required" }),
        follow_up_at: at,
      });
      expect(res.status).toBe(201);
    }
    expect(
      (
        await one(
          "select count(*)::int n from followups where lead_id=$1 and status='pending'",
          [lead],
        )
      ).n,
    ).toBe(1);
  });
  it("are scheduled when a call's outcome is changed to Follow-up required", async () => {
    const logged = (
      await send(ali, "post", `/leads/${lead}/calls/manual`, call())
    ).body;
    const refused = await send(ali, "patch", `/calls/${logged.id}`, {
      outcome: "Follow-up required",
      notes: "Wants a callback",
      deal_tags: [],
    });
    expect(refused.status).toBe(400);
    const at = inHours(30);
    const saved = await send(ali, "patch", `/calls/${logged.id}`, {
      outcome: "Follow-up required",
      notes: "Wants a callback",
      deal_tags: ["Hot lead"],
      follow_up_at: at,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.followup).toMatchObject({
      lead_id: lead,
      status: "pending",
    });
    // Editing the notes of a call that already asked for a follow-up needs no
    // new date and schedules nothing more.
    const again = await send(ali, "patch", `/calls/${logged.id}`, {
      outcome: "Follow-up required",
      notes: "Wants a callback after 5 pm",
      deal_tags: ["Hot lead"],
    });
    expect(again.status).toBe(200);
    expect(
      (
        await one("select count(*)::int n from followups where lead_id=$1", [
          lead,
        ])
      ).n,
    ).toBe(1);
    // Another agent cannot change the call or learn about it.
    expect(
      (
        await send(sara, "patch", `/calls/${logged.id}`, {
          outcome: "Follow-up required",
          notes: "",
          deal_tags: [],
        })
      ).status,
    ).toBe(404);
  });
});

describe("the Follow-ups list", () => {
  it("follows the lead's current owner, for agents and for the administrator's agent filter", async () => {
    const res = await send(ali, "post", "/followups", {
      lead_id: lead,
      due_at: inHours(20),
      notes: "Send the brochure",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.agent_id).toBe(ali);
    expect(
      (await send(admin, "post", `/leads/${lead}/assign`, { agent_id: sara }))
        .status,
    ).toBe(200);
    const ids = async (user, query = "") =>
      (await get(user, "/followups?view=pending" + query)).body.data.map(
        (f) => f.id,
      );
    expect(await ids(sara)).toContain(res.body.id);
    expect(await ids(ali)).not.toContain(res.body.id);
    expect(await ids(admin, `&agent=${sara}`)).toContain(res.body.id);
    expect(await ids(admin, `&agent=${ali}`)).not.toContain(res.body.id);
  });
  it("lists pending follow-ups soonest first and filters completed and cancelled ones", async () => {
    const later = (
      await send(ali, "post", "/followups", {
        lead_id: lead,
        due_at: inHours(72),
      })
    ).body;
    const sooner = (
      await send(ali, "post", "/followups", {
        lead_id: lead,
        due_at: inHours(3),
      })
    ).body;
    const done = (
      await send(ali, "post", "/followups", {
        lead_id: lead,
        due_at: inHours(5),
      })
    ).body;
    expect(
      (
        await send(ali, "patch", `/followups/${done.id}`, {
          status: "completed",
        })
      ).status,
    ).toBe(200);
    const pending = (
      await get(ali, "/followups?view=pending&sort=due_at&direction=asc")
    ).body.data
      .filter((f) => f.lead_id === lead)
      .map((f) => f.id);
    expect(pending).toEqual([sooner.id, later.id]);
    const completed = (
      await get(ali, "/followups?view=completed")
    ).body.data.map((f) => f.id);
    expect(completed).toContain(done.id);
    expect(
      (
        await one(
          "select completed_at is not null c from followups where id=$1",
          [done.id],
        )
      ).c,
    ).toBe(true);
    expect((await get(ali, "/followups?view=cancelled")).status).toBe(200);
  });
  it("lists calls still waiting for a follow-up date, only to their owner, until one is scheduled", async () => {
    // A call recorded before follow-ups could be scheduled from the call
    // form: the database function itself never required a follow-up date.
    await pg.query("select log_manual_call($1,$2,$3::jsonb,'historic')", [
      lead,
      ali,
      JSON.stringify({
        ...call({ outcome: "Follow-up required", notes: "Call next week" }),
        started_at: new Date(Date.now() - 30 * 3600000).toISOString(),
      }),
    ]);
    const waiting = async (user) =>
      (await get(user, "/followups/unscheduled")).body.data.map(
        (r) => r.lead_id,
      );
    expect(await waiting(ali)).toContain(lead);
    expect(await waiting(admin)).toContain(lead);
    expect(await waiting(sara)).not.toContain(lead);
    await send(ali, "post", "/followups", {
      lead_id: lead,
      due_at: inHours(10),
    });
    expect(await waiting(ali)).not.toContain(lead);
  });
});

describe("the lead activity timeline", () => {
  it("shows who did each action, the call outcome, notes and Warm/Cold tags, and later changes", async () => {
    await send(ali, "post", `/leads/${lead}/calls/manual`, {
      ...call({ outcome: "Follow-up required", deal_tags: ["Warm lead"] }),
      follow_up_at: inHours(24),
    });
    // The administrator writes a note on Ali's lead.
    expect(
      (
        await send(admin, "post", "/notes", {
          lead_id: lead,
          body: "Customer prefers WhatsApp",
        })
      ).status,
    ).toBe(201);
    const followup = (
      await one("select id from followups where lead_id=$1", [lead])
    ).id;
    await send(ali, "patch", `/followups/${followup}`, { status: "completed" });
    await send(admin, "patch", `/leads/${lead}`, {
      preferred_location: "DHA Phase 6",
    });
    await send(ali, "patch", `/leads/${lead}`, { status: "interested" });
    const res = await get(ali, `/leads/${lead}/timeline`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The newest entry of each kind.
    const kinds = Object.fromEntries(
      [...res.body].reverse().map((i) => [i.kind, i]),
    );
    expect(kinds.calls).toMatchObject({
      actor_name: "Ali Agent",
      outcome: "Follow-up required",
      notes: "Asked for the payment plan",
      deal_tags: ["Warm lead"],
    });
    // The note was written by the administrator, not by the lead's agent.
    expect(kinds.notes).toMatchObject({
      actor_name: "Owner",
      body: "Customer prefers WhatsApp",
    });
    expect(kinds.followups).toMatchObject({
      actor_name: "Ali Agent",
      agent_name: "Ali Agent",
      status: "completed",
    });
    expect(kinds.followups.updates).toMatchObject([
      { actor_name: "Ali Agent", fields: ["status"] },
    ]);
    expect(kinds.lead_update).toMatchObject({
      actor_name: "Owner",
      fields: ["preferred location"],
    });
    expect(kinds.lead_status_history).toMatchObject({
      actor_name: "Ali Agent",
      from_status: "contacted",
      to_status: "interested",
    });
    // Newest first.
    expect(res.body.map((i) => i.created_at)).toEqual(
      [...res.body.map((i) => i.created_at)].sort().reverse(),
    );
  });
  it("is shown only to the lead's owner and administrators", async () => {
    expect((await get(sara, `/leads/${lead}/timeline`)).status).toBe(404);
    expect((await get(admin, `/leads/${lead}/timeline`)).status).toBe(200);
    expect(
      (
        await send(sara, "post", "/followups", {
          lead_id: lead,
          due_at: inHours(5),
        })
      ).status,
    ).toBe(403);
  });
});

describe("a follow-up that cannot be saved", () => {
  it("is reported, keeps the call once, and can be saved again on its own", async () => {
    const at = inHours(28);
    failNextFollowUp = true;
    const res = await send(ali, "post", `/leads/${lead}/calls/manual`, {
      ...call({ outcome: "Follow-up required", notes: "Call back Monday" }),
      follow_up_at: at,
    });
    // The call is saved; the response says the follow-up was not, and never
    // carries a follow-up as if it had been.
    expect(res.status).toBe(201);
    expect(res.body.followup).toBeUndefined();
    expect(res.body).toMatchObject({
      followup_error: "The follow-up could not be saved.",
      followup_notes: "Call outcome: Follow-up required · Call back Monday",
    });
    expect(Date.parse(res.body.followup_due_at)).toBe(Date.parse(at));
    const counts = async () =>
      one(
        "select (select count(*) from calls where lead_id=$1)::int calls,(select count(*) from followups where lead_id=$1)::int followups",
        [lead],
      );
    expect(await counts()).toEqual({ calls: 1, followups: 0 });
    // Until it is saved, the lead waits for a follow-up date.
    const waiting = async () =>
      (await get(ali, "/followups/unscheduled")).body.data.map(
        (r) => r.lead_id,
      );
    expect(await waiting()).toContain(lead);
    // Saving the follow-up again on its own, as the lead page offers.
    const retried = await send(ali, "post", "/followups", {
      lead_id: lead,
      due_at: res.body.followup_due_at,
      notes: res.body.followup_notes,
    });
    expect(retried.status).toBe(201);
    expect(await counts()).toEqual({ calls: 1, followups: 1 });
    expect(await waiting()).not.toContain(lead);
  });
});

describe("who did what on the timeline", () => {
  it("names the actor from the audit log and leaves it out when there is no record", async () => {
    // The administrator logs a call on Ali's lead: the call belongs to Ali.
    expect(
      (await send(admin, "post", `/leads/${lead}/calls/manual`, call())).status,
    ).toBe(201);
    // Rows made without the application, as some old data might be.
    await pg.query(
      "insert into notes(lead_id,agent_id,body) values($1,$2,'Imported note')",
      [lead, ali],
    );
    await pg.query(
      "insert into followups(lead_id,agent_id,due_at,status) values($1,$2,now()+interval '3 days','pending')",
      [lead, ali],
    );
    await pg.query("update leads set status='interested' where id=$1", [lead]);
    const items = (await get(ali, `/leads/${lead}/timeline`)).body;
    const find = (kind, test = () => true) =>
      items.find((i) => i.kind === kind && test(i));
    expect(find("calls")).toMatchObject({
      actor_name: "Owner",
      agent_name: "Ali Agent",
    });
    const note = find("notes", (i) => i.body === "Imported note");
    expect(note.actor_name).toBeNull();
    const followup = find("followups");
    expect(followup.actor_name).toBeNull();
    expect(followup.agent_name).toBe("Ali Agent");
    const stage = find(
      "lead_status_history",
      (i) => i.to_status === "interested",
    );
    expect(stage.actor_name).toBeNull();
  });
});

describe("calls waiting for a follow-up date", () => {
  it("are exactly the leads the production check lists, for administrators and for each agent", async () => {
    // Each row gets an explicit, distinct time, so "before" and "after" never
    // depend on how fast the rows are written (fast runners can give two
    // rows the same timestamp).
    const legacy = async (
      id,
      owner,
      outcome = "Follow-up required",
      hoursAgo = 20,
    ) => {
      const at = new Date(Date.now() - hoursAgo * 3600000).toISOString();
      const logged = (
        await one("select log_manual_call($1,$2,$3::jsonb,'legacy') r", [
          id,
          owner,
          JSON.stringify(call({ outcome, started_at: at })),
        ])
      ).r;
      await pg.query("update calls set created_at=$2 where id=$1", [
        logged.id,
        at,
      ]);
    };
    const followup = (id, owner, status, hoursAgo) =>
      pg.query(
        "insert into followups(lead_id,agent_id,due_at,status,created_at) values($1,$2,now()+interval '2 days',$3,now()-make_interval(hours=>$4))",
        [id, owner, status, hoursAgo],
      );
    const make = async (owner = ali) => customer(owner);
    // Waiting: a follow-up was asked for and nothing covers it.
    const plain = await make();
    await legacy(plain, ali);
    const oldDone = await make();
    await followup(oldDone, ali, "completed", 40);
    await legacy(oldDone, ali);
    const twice = await make();
    await legacy(twice, ali, "Follow-up required", 30);
    await legacy(twice, ali, "Follow-up required", 10);
    const saras = await make(sara);
    await legacy(saras, sara);
    // Not waiting: covered, superseded, closed or deleted.
    const pendingBefore = await make();
    await followup(pendingBefore, ali, "pending", 40);
    await legacy(pendingBefore, ali);
    const cancelledAfter = await make();
    await legacy(cancelledAfter, ali);
    await followup(cancelledAfter, ali, "cancelled", 10);
    const laterCall = await make();
    await legacy(laterCall, ali, "Follow-up required", 30);
    await legacy(laterCall, ali, "Interested", 10);
    const lost = await make();
    await legacy(lost, ali);
    await pg.query(
      "update leads set status='lost',lost_reason='price' where id=$1",
      [lost],
    );
    const removed = await make();
    await legacy(removed, ali);
    await pg.query("select delete_leads($1,$2,'Duplicate customer','t')", [
      [removed],
      admin,
    ]);
    const rows = (
      await pg.query(
        await readFile(
          new URL(
            "../../supabase/check-followups-activity.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      )
    ).rows.filter((r) => r.metric === "lead waiting for a follow-up date");
    const fromSql = (who) =>
      rows
        .filter((r) => !who || r.detail.includes(who))
        .map((r) => Number(r.detail.match(/^HD-(\d+)/)[1]))
        .sort((a, b) => a - b);
    const fromApi = async (user) =>
      (await get(user, "/followups/unscheduled")).body.data
        .map((r) => Number(r.lead_no))
        .sort((a, b) => a - b);
    const numbers = async (ids) =>
      (
        await pg.query(
          "select lead_no from leads where id = any($1) order by lead_no",
          [ids],
        )
      ).rows.map((r) => Number(r.lead_no));
    expect(await fromApi(admin)).toEqual(fromSql());
    expect(await fromApi(ali)).toEqual(fromSql("Ali Agent"));
    expect(await fromApi(sara)).toEqual(fromSql("Sara Agent"));
    const waiting = await fromApi(admin);
    for (const n of await numbers([plain, oldDone, twice, saras]))
      expect(waiting).toContain(n);
    for (const n of await numbers([
      pendingBefore,
      cancelledAfter,
      laterCall,
      lost,
      removed,
    ]))
      expect(waiting).not.toContain(n);
    // A lead is listed once, however many calls asked for a follow-up.
    expect(new Set(waiting).size).toBe(waiting.length);
  });
});
