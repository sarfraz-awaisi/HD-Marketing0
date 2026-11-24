import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGlite } from "@electric-sql/pglite";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { agentDay, kpiReport, kpiSources, pkToday, rulesProblem } from "../src/services/kpis.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 081: the Daily KPI "Calls completed": completed out of assigned,
// Yes when the agent saved a call outcome, the same Pakistan day, for every
// lead assigned to them that day; beside the unchanged first-call deadline.
// Calls are written with fixed times (the call log only takes recent
// calls); the real log is used where who logged a call counts.
const admin = "81000000-0000-4000-8000-000000000001",
  abru = "81000000-0000-4000-8000-000000000002",
  sara = "81000000-0000-4000-8000-000000000003";
let pg, db, one, all, seeded, since, phone = 0;
const migration = new URL("../../supabase/migrations/081_kpi_calls_completed.sql", import.meta.url);
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
  seeded = await all(
    "select k.title,k.question,v.frequency,v.answer_type,v.target,v.active,v.measure,v.effective_from from kpis k join kpi_versions v on v.kpi_id=k.id where v.measure='call_activity'",
  );
  since = (await one("select min(effective_from) d from kpi_versions where measure<>'call_activity'")).d;
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, abru, sara]);
  await pg.query("update profiles set name='Abru' where id=$1", [abru]);
  await pg.query("update attendance_periods set starts_on='2026-01-01' where user_id=any($1::uuid[])", [[admin, abru, sara]]);
});
const pk = (day, time) => `${day}T${time}:00+05:00`;
const save = async (data, now) =>
  (await one("select public.kpi_save($1,null,$2::jsonb,'t',$3) r", [admin, JSON.stringify(data), now])).r;
// "Calls completed" and the first-call deadline KPI, as the CRM fills them in.
async function kpis(now) {
  const made = await save({ title: "Calls completed", question: "Did you complete all the calls assigned to you today?", frequency: "day", answer_type: "yes_no" }, now);
  const deadline = await save({ title: "Assigned calls", question: "Assigned calls?", frequency: "day", answer_type: "yes_no" }, now);
  await pg.query("update kpi_versions set measure='call_activity' where kpi_id=$1", [made.id]);
  await pg.query("update kpi_versions set measure='calls' where kpi_id=$1", [deadline.id]);
  return { made: made.id, deadline: deadline.id };
}
const facts = async (from, to, now, actor = admin, agent = null) =>
  (await one("select public.kpi_facts($1,$2,$3,$4,$5) r", [actor, from, to, agent, now])).r;
const activity = (f, agent, day) => f.measures.find((m) => m.agent_id === agent && m.day === day)?.call_activity ?? null;
const item = (day, kpi) => day.kpis.find((i) => i.id === kpi);
// n leads given to an agent at a Pakistan time, due at another.
async function leads(n, agent, assigned, due = assigned) {
  const ids = (
    await all(
      "select (create_lead(jsonb_build_object('name','Buyer '||i),'+92301'||lpad(($3::int+i)::text,7,'0'),$1,'fixture')).id from generate_series(1,$2::int) i",
      [admin, n, phone],
    )
  ).map((r) => r.id);
  phone += n;
  await pg.query("select admin_assign_leads($1,$2,$3,'t')", [ids, admin, agent]);
  await pg.query("update leads set assigned_at=$2,call_due_at=$3 where id=any($1::uuid[])", [ids, assigned, due]);
  await pg.query("update assignments set created_at=$2,call_due_at=$3 where lead_id=any($1::uuid[]) and agent_id=$4", [ids, assigned, due, agent]);
  return ids;
}
// An administrator moves a lead to another agent at a Pakistan time.
async function move(lead, agent, at) {
  await pg.query("select admin_assign_leads($1,$2,$3,'t')", [[lead], admin, agent]);
  await pg.query("update assignments set created_at=$3 where lead_id=$1 and agent_id=$2", [lead, agent, at]);
}
// A saved manual call at a fixed time, answered or not; logged by `by`
// (an audit entry) when given, else it counts for the call's agent.
const answeredOutcomes = ["Interested", "Not interested", "Follow-up required", "Site visit scheduled", "Deal discussion", "Closed lost", "Wrong number"];
const missedOutcomes = ["No answer", "Busy", "Number off", "Wrong number"];
async function call(lead, agent, at, answered = true, n = 0, by = null) {
  const outcome = (answered ? answeredOutcomes : missedOutcomes)[n % (answered ? 7 : 4)];
  const { id } = await one(
    `insert into calls(lead_id,agent_id,method,answered,status,started_at,ended_at,duration_seconds,outcome,outcome_submitted_at,created_at)
     values($1,$2,'manual',$3,case when $3 then 'completed' else 'failed' end,$4::timestamptz,$4::timestamptz+make_interval(secs=>case when $3 then 60 else 0 end),
      case when $3 then 60 else 0 end,$5,$4::timestamptz+interval '2 minutes',$4::timestamptz+interval '2 minutes') returning id`,
    [lead, agent, answered, at, outcome],
  );
  if (by)
    await pg.query("insert into audit_log(actor_id,action,entity,entity_id) values($1,'call.manual_logged','calls',$2)", [by, id]);
}
const minutes = (day, from, i) => {
  const [h, m] = from.split(":").map(Number);
  const t = h * 60 + m + i * 3;
  return pk(day, `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(t % 60).padStart(2, "0")}`);
};

describe("update 081 migration", () => {
  it("adds the Calls completed KPI once: a daily Yes/No measured by the CRM from the first day of Daily KPIs", () => {
    expect(seeded).toEqual([
      expect.objectContaining({ title: "Calls completed", frequency: "day", answer_type: "yes_no", target: 1, active: true, measure: "call_activity", effective_from: since }),
    ]);
  });
  it("reruns without changing anything and refuses an unexpected definition", async () => {
    const sql = await readFile(migration, "utf8");
    await kpis(pk("2026-11-23", "09:00"));
    const state = "select (select count(*) from kpis)::int k,(select count(*) from kpi_versions)::int v,md5(pg_get_functiondef('public.kpi_measures(date,date,uuid,timestamp with time zone)'::regprocedure)) f,md5(pg_get_functiondef('public.kpi_rules_problem(text,text,text,integer,boolean)'::regprocedure)) r";
    const before = await one(state);
    await pg.exec(sql);
    expect(await one(state)).toEqual(before);
    await pg.exec(
      "begin;create or replace function public.kpi_rules_problem(p_measure text,p_frequency text,p_answer_type text,p_target integer,p_expect_yes boolean) returns text language sql immutable set search_path='' as $$ select null::text $$;",
    );
    try {
      await expect(pg.exec(sql)).rejects.toThrow(/Update 081 found an unexpected version of public.kpi_rules_problem/);
    } finally {
      await pg.exec("rollback");
    }
  });
  it("accepts the same Calls completed rules as the server, and the table holds to them", async () => {
    for (const frequency of ["day", "week"])
      for (const answer_type of ["yes_no", "number"])
        for (const expected of ["yes", "no"]) {
          const js = rulesProblem("call_activity", { frequency, answer_type, target: 40, expected });
          const { p } = await one("select public.kpi_rules_problem('call_activity',$1,$2,40,$3) p", [frequency, answer_type, answer_type === "number" || expected === "yes"]);
          expect(p, `${frequency} ${answer_type} ${expected}`).toBe(js);
        }
    expect(kpiSources.call_activity).toMatchObject({ frequencies: ["day"], answer_types: ["yes_no"] });
    const k = await kpis(pk("2026-11-23", "09:00"));
    await expect(pg.query("update kpi_versions set answer_type='number',target=40 where kpi_id=$1", [k.made])).rejects.toThrow(/kpi_versions_measure/);
  });
  it("has a read-only check: at 081, with yesterday's assigned and completed leads", async () => {
    const check = await readFile(new URL("../../supabase/check-kpi-calls-completed-081.sql", import.meta.url), "utf8");
    await kpis(pk("2026-11-01", "09:00"));
    const yesterday = (await one("select (kpi_today(now())-1)::text d")).d;
    const [a] = await leads(2, abru, pk(yesterday, "11:00"));
    await call(a, abru, pk(yesterday, "11:30"), false);
    expect((await pg.query(check)).rows[0]).toMatchObject({
      release_stage: "at 081",
      calls_completed_kpi: expect.objectContaining({ title: "Calls completed", frequency: "day", answer_type: "yes_no" }),
      assigned_yesterday: 2,
      completed_yesterday: 1,
    });
  });
  it("keeps the measures closed to the browser", async () => {
    for (const role of ["anon", "authenticated"]) {
      await pg.exec(`set role ${role}`);
      await expect(pg.query("select kpi_measures('2026-11-23','2026-11-23',null,now())")).rejects.toThrow(/permission denied/);
      await pg.exec("reset role");
    }
  });
});

describe("update 081 on a database at 080, as production is", () => {
  it("is ready, applies once, and leaves every earlier KPI rule as it was", async () => {
    const dir = new URL("../../supabase/migrations/", import.meta.url);
    const at080 = new PGlite({ extensions: { pg_trgm } });
    try {
      await at080.exec(
        "create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key,email text unique,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);",
      );
      for (const name of (await readdir(dir)).sort().filter((n) => n < "081"))
        await at080.exec((await readFile(new URL(name, dir), "utf8")).replace("create extension if not exists pgcrypto;", ""));
      const check = await readFile(new URL("../../supabase/check-kpi-calls-completed-081.sql", import.meta.url), "utf8");
      const stage = async () => (await at080.query(check)).rows[0].release_stage;
      const rules = "select kpi_id,version,effective_from::text,frequency,answer_type,target,active,measure,expect_yes from kpi_versions where measure<>'call_activity' order by kpi_id,version";
      expect(await stage()).toBe("at 080, ready for 081");
      const before = (await at080.query(rules)).rows;
      const sql = await readFile(migration, "utf8");
      await at080.exec(sql);
      await at080.exec(sql);
      expect(await stage()).toBe("at 081");
      expect((await at080.query(rules)).rows).toEqual(before);
      expect((await at080.query("select count(*)::int n from kpi_versions where measure='call_activity'")).rows[0].n).toBe(1);
    } finally {
      await at080.close();
    }
  }, 180000);
});

describe("Calls completed (update 081)", () => {
  it("counts only the day's assigned leads: Abru's 80 calls on 23 November complete 5 of 10; the deadline KPI still 5 on time", async () => {
    const day = "2026-11-23", k = await kpis(pk(day, "09:00"));
    // 10 new leads at 14:00, due 18:00: 5 called that day, 2 the next day, 3 never.
    const fresh = await leads(10, abru, pk(day, "14:00"), pk(day, "18:00"));
    // 74 older leads from 13 November; 6 were first called on Saturday 21 November.
    const old = await leads(74, abru, pk("2026-11-13", "11:00"), pk("2026-11-13", "18:00"));
    for (let i = 68; i < 74; i++) await call(old[i], abru, pk("2026-11-21", "12:00"), false, i);
    const plan = [
      ...fresh.slice(0, 5).map((l) => [l, "15:00"]),
      ...old.slice(0, 68).map((l) => [l, "12:00"]),
      [old[0], "16:30"],
      ...old.slice(68).map((l) => [l, "16:40"]),
    ];
    for (const [i, [lead, from]] of plan.entries()) await call(lead, abru, minutes(day, from, i % 20), i < 45, i);
    for (const lead of fresh.slice(5, 7)) await call(lead, abru, pk("2026-11-24", "11:00"), true);
    const f = await facts(day, day, pk("2026-11-25", "12:00"));
    // 75 calls on older leads and a repeat call add nothing.
    expect(activity(f, abru, day)).toEqual({ assigned: 10, completed: 5 });
    const d = agentDay(f, abru, day);
    expect(item(d, k.made)).toMatchObject({ measure: "call_activity", answer: false, met: false, detail: { assigned: 10, completed: 5 } });
    expect(item(d, k.deadline)).toMatchObject({
      measure: "calls",
      answer: false,
      detail: { due: 10, on_time: 5, late: 2, not_called: 3, attempts: 5, answered: 5 },
    });
    const r = kpiReport(f, day, day);
    expect(r.agents.find((a) => a.id === abru).cells[k.made].daily).toMatchObject({ days: 1, met: 0, below: 1, detail: { assigned: 10, completed: 5 } });
  });

  it("holds an agent to the leads given that day, called that day, by them", async () => {
    const day = "2026-11-18", k = await kpis(pk("2026-11-16", "09:00"));
    const [a, b, c, gone, helped] = await leads(5, abru, pk(day, "10:00"));
    const [late] = await leads(1, abru, pk(day, "17:30"));
    const [tomorrow] = await leads(1, abru, pk(day, "16:00"));
    await call(a, abru, pk(day, "11:00"));
    // Moved before Abru called it: Sara's, who called it.
    await move(b, sara, pk(day, "12:00"));
    await call(b, sara, pk(day, "13:00"));
    // Called by Abru, then moved: Abru completed it; Sara has it to call.
    await call(c, abru, pk(day, "10:30"), false);
    await move(c, sara, pk(day, "14:00"));
    // Given at 17:30, called and saved at 21:00: still that day.
    await call(late, abru, pk(day, "21:00"), false);
    // Called twice: still one completed lead.
    await call(a, abru, pk(day, "16:00"), false);
    await call(tomorrow, abru, pk("2026-11-19", "09:00"));
    // An administrator's call does not complete it for Abru.
    await call(helped, abru, pk(day, "15:00"), true, 0, admin);
    // Saved after the lead was given, for a call made earlier that day:
    // completed. Saved before it was given, or only the next day: not.
    const [earlier, before, nextDay] = await leads(3, abru, pk(day, "12:00"));
    await call(earlier, abru, pk(day, "09:00"));
    await pg.query("update calls set created_at=$2 where lead_id=$1", [earlier, pk(day, "12:05")]);
    await call(before, abru, pk(day, "09:00"));
    await call(nextDay, abru, pk(day, "23:30"));
    await pg.query("update calls set created_at=$2 where lead_id=$1", [nextDay, pk("2026-11-19", "00:10")]);
    await pg.query(
      "update leads set deleted_at=now(),deleted_by=$2,delete_reason='test deletion',deleted_batch=gen_random_uuid() where id=$1",
      [gone, admin],
    );
    const f = await facts(day, day, pk("2026-11-20", "09:00"));
    expect(activity(f, abru, day)).toEqual({ assigned: 8, completed: 4 });
    expect(activity(f, sara, day)).toEqual({ assigned: 2, completed: 1 });
    expect(activity(f, admin, day)).toBeNull();
    expect(item(agentDay(f, abru, day), k.made)).toMatchObject({ answer: false, met: false, state: "answered" });
  });

  it("is in progress today, Yes once every lead is called, and not due with nothing assigned", async () => {
    const day = "2026-11-17", k = await kpis(pk(day, "09:00"));
    const [a, b] = await leads(2, abru, pk(day, "10:00"));
    await call(a, abru, pk(day, "11:00"), false);
    let d = agentDay(await facts(day, day, pk(day, "12:00")), abru, day);
    expect(item(d, k.made)).toMatchObject({ answer: null, met: null, state: "pending", detail: { assigned: 2, completed: 1 } });
    await call(b, abru, pk(day, "12:30"), false);
    d = agentDay(await facts(day, day, pk(day, "13:00")), abru, day);
    expect(item(d, k.made)).toMatchObject({ answer: true, met: true, detail: { assigned: 2, completed: 2 } });
    // Sara had nothing given: calls to an older lead, and an unsaved dial,
    // leave the day not due.
    const [old] = await leads(1, sara, pk("2026-11-10", "11:00"));
    for (let i = 0; i < 11; i++) await call(old, sara, minutes(day, "11:00", i), i % 3 === 0, i);
    const [dialled] = await leads(1, sara, pk(day, "10:00"));
    await pg.query(
      "insert into calls(lead_id,agent_id,method,status,started_at,created_at) values($1,$2,'mock','initiated',$3,$3)",
      [dialled, sara, pk(day, "13:00")],
    );
    const f = await facts(day, day, pk("2026-11-18", "09:00"));
    expect(activity(f, sara, day)).toEqual({ assigned: 1, completed: 0 });
    expect(item(agentDay(f, sara, day), k.made)).toMatchObject({ answer: false, met: false });
    await pg.query("update assignments set created_at=$2 where lead_id=$1", [dialled, pk("2026-11-10", "10:00")]);
    const quiet = await facts(day, day, pk("2026-11-18", "09:00"));
    expect(activity(quiet, sara, day)).toBeNull();
    expect(item(agentDay(quiet, sara, day), k.made)).toMatchObject({ answer: null, state: "not_due" });
    expect(kpiReport(quiet, day, day).agents.find((x) => x.id === sara).cells[k.made].daily).toMatchObject({ days: 0, not_due: 1, missed: 0 });
  });

  it("splits days at Pakistan midnight", async () => {
    await kpis(pk("2026-11-16", "09:00"));
    const [early, late] = await leads(2, abru, pk("2026-11-17", "23:00"));
    const [tomorrow] = await leads(1, abru, pk("2026-11-18", "00:00"));
    await call(early, abru, pk("2026-11-17", "23:50"));
    await call(late, abru, pk("2026-11-17", "23:59"));
    await call(tomorrow, abru, pk("2026-11-18", "00:05"));
    const f = await facts("2026-11-17", "2026-11-18", pk("2026-11-19", "09:00"));
    // The 23:59 call was saved at 00:01, the next day.
    expect(activity(f, abru, "2026-11-17")).toEqual({ assigned: 2, completed: 1 });
    expect(activity(f, abru, "2026-11-18")).toEqual({ assigned: 1, completed: 1 });
  });

  it("credits a call to whoever logged it, and shows an agent only their own work", async () => {
    const day = pkToday(), now = new Date().toISOString();
    const k = await kpis(pk(day, "00:01"));
    const given = new Date(Math.max(Date.now() - 10 * 60000, Date.parse(pk(day, "00:00")) + 30000)).toISOString();
    const [lead] = await leads(1, abru, given);
    const log = (actor, minutesAgo) =>
      pg.query("select log_manual_call($1,$2,$3::jsonb,'t')", [
        lead,
        actor,
        JSON.stringify({ answered: true, started_at: new Date(Date.now() - minutesAgo * 60000).toISOString(), duration_seconds: 60, outcome: "Interested", notes: "", deal_tags: [] }),
      ]);
    await log(abru, 2);
    await log(admin, 1);
    expect(await one("select count(*)::int n from calls where lead_id=$1 and agent_id=$2", [lead, abru])).toEqual({ n: 2 });
    const f = await facts(day, day, now);
    expect(activity(f, abru, day)).toEqual({ assigned: 1, completed: 1 });
    expect(activity(f, admin, day)).toBeNull();
    // The agent's own page: their work only.
    const app = createApp(trustedMfaFixture(db));
    const res = await request(app).get("/api/kpis/my").set("Authorization", "Bearer " + abru);
    expect(res.status).toBe(200);
    expect(res.body.kpis.find((i) => i.id === k.made)).toMatchObject({ answer: true, detail: { assigned: 1, completed: 1 } });
    const own = await facts(day, day, now, abru, abru);
    expect(new Set(own.measures.map((m) => m.agent_id))).toEqual(new Set([abru]));
    await expect(facts(day, day, now, abru, sara)).rejects.toThrow(/only see your own KPIs/);
  });
});
