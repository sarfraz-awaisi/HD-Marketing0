import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../src/app.js";
import { addDays, kpiReport, pkToday } from "../src/services/kpis.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 085: Today calls on administrators' Daily KPI results: every call
// each agent saved an outcome for that Pakistan day, on any lead, each call
// once. Not a KPI: Calls completed, answers and Overall are unchanged.
const admin = "85000000-0000-4000-8000-000000000001",
  abru = "85000000-0000-4000-8000-000000000002",
  sara = "85000000-0000-4000-8000-000000000003";
const migration = new URL(
  "../../supabase/migrations/085_kpi_today_calls.sql",
  import.meta.url,
);
const m081 = new URL(
  "../../supabase/migrations/081_kpi_calls_completed.sql",
  import.meta.url,
);
const day = "2026-11-23",
  before = "2026-11-22",
  after = "2026-11-24",
  now = "2026-11-25T12:00:00+05:00";
let main,
  cur,
  phone = 0;
beforeAll(async () => {
  main = await startCrmDatabase();
}, 60000);
afterAll(async () => {
  await main?.pg.close();
});
async function people(t) {
  await resetPeople(t.pg, [admin, abru, sara]);
  await t.pg.query(
    "update profiles set name=case id when $1 then 'Abru' else 'Sara' end where id=any($2::uuid[])",
    [abru, [abru, sara]],
  );
  await t.pg.query(
    "update attendance_periods set starts_on='2026-01-01' where user_id=any($1::uuid[])",
    [[admin, abru, sara]],
  );
}
beforeEach(async () => {
  cur = main;
  await people(cur);
});
const pk = (d, time) => `${d}T${time}:00+05:00`;
async function leads(n, agent, at) {
  const ids = (
    await cur.all(
      "select (create_lead(jsonb_build_object('name','Buyer '||i),'+92304'||lpad(($3::int+i)::text,7,'0'),$1,'fixture')).id from generate_series(1,$2::int) i",
      [admin, n, phone],
    )
  ).map((r) => r.id);
  phone += n;
  await cur.pg.query("select admin_assign_leads($1,$2,$3,'t')", [
    ids,
    admin,
    agent,
  ]);
  await cur.pg.query(
    "update assignments set created_at=$2 where lead_id=any($1::uuid[]) and agent_id=$3",
    [ids, at, agent],
  );
  await cur.pg.query(
    "update leads set assigned_at=$2 where id=any($1::uuid[])",
    [ids, at],
  );
  return ids;
}
// A call saved at a fixed time, with an outcome unless none; logged by `by`
// (an audit entry) when given, else it counts for the call's agent.
async function call(lead, agent, at, outcome = "No answer", by = null) {
  const answered = ![
    "No answer",
    "Busy",
    "Wrong number",
    "Number off",
  ].includes(outcome);
  // A call with no outcome saved is a provider call left open.
  const { id } = await cur.one(
    `insert into calls(lead_id,agent_id,method,answered,status,started_at,ended_at,duration_seconds,outcome,outcome_submitted_at,created_at)
     values($1,$2,case when $4::text is null then 'provider' else 'manual' end,$5,case when $5 then 'completed' else 'failed' end,
      $3::timestamptz,$3::timestamptz+make_interval(secs=>case when $5 then 60 else 0 end),case when $5 then 60 else 0 end,
      $4,case when $4::text is null then null else $3::timestamptz end,$3::timestamptz) returning id`,
    [lead, agent, at, outcome, outcome ? answered : null],
  );
  if (by)
    await cur.pg.query(
      "insert into audit_log(actor_id,action,entity,entity_id) values($1,'call.manual_logged','calls',$2)",
      [by, id],
    );
}
// "Calls completed", as update 081 adds it, for the report's columns.
async function callsCompleted() {
  const k = (
    await cur.one("select public.kpi_save($1,null,$2::jsonb,'t',$3) r", [
      admin,
      JSON.stringify({
        title: "Calls completed",
        question: "Did you complete all the calls assigned to you today?",
        frequency: "day",
        answer_type: "yes_no",
      }),
      pk(before, "00:01"),
    ])
  ).r;
  await cur.pg.query(
    "update kpi_versions set measure='call_activity' where kpi_id=$1",
    [k.id],
  );
  return k.id;
}
const facts = async (from, to) =>
  (
    await cur.one("select public.kpi_facts($1,$2,$3,null,$4) r", [
      admin,
      from,
      to,
      now,
    ])
  ).r;
const report = async (from, to, user = admin, status = 200) =>
  (
    await request(createApp(trustedMfaFixture(cur.db)))
      .get(`/api/kpis/report?from=${from}&to=${to}`)
      .set("Authorization", "Bearer " + user)
      .expect(status)
  ).body;
const row = (r, agent) => r.agents.find((a) => a.id === agent);

describe("Today calls (update 085)", () => {
  it("counts every call saved that day on new and older leads, each call once, by Pakistan day, for whoever logged it", async () => {
    await callsCompleted();
    const fresh = await leads(3, abru, pk(day, "10:00"));
    const older = await leads(3, abru, pk("2026-11-20", "10:00"));
    await call(fresh[0], abru, pk(day, "11:00"));
    await call(fresh[0], abru, pk(day, "15:00"), "Interested"); // again: counts
    await call(fresh[1], abru, pk(day, "12:00"), "Busy");
    await call(older[0], abru, pk(day, "13:00"), "Follow-up required");
    await call(older[1], abru, pk(day, "23:58"), "Number off");
    await call(older[1], abru, pk(day, "14:00"), null); // no outcome
    await call(older[2], abru, pk(before, "23:59")); // the day before
    await call(older[2], abru, pk(after, "00:00")); // the day after
    await call(fresh[2], abru, pk(day, "16:00"), "Interested", admin); // admin's
    const gone = (await leads(1, abru, pk(day, "09:00")))[0];
    await call(gone, abru, pk(day, "09:30"));
    await cur.pg.query("select delete_leads($1,$2,'Duplicate entry','t')", [
      [gone],
      admin,
    ]);
    const f = await facts(before, after);
    const of = (agent, d) =>
      f.measures.find((m) => m.agent_id === agent && m.day === d);
    expect([before, day, after].map((d) => of(abru, d)?.today_calls)).toEqual([
      1, 5, 1,
    ]);
    expect(of(admin, day).today_calls).toBe(1);
    // Calls completed is unchanged: 2 of the 3 leads given that day.
    expect(of(abru, day).call_activity).toEqual({ assigned: 3, completed: 2 });
  });

  it("always shows today's calls, whatever period is shown, and changes no answer or Overall", async () => {
    await callsCompleted();
    const [a] = await leads(1, abru, pk(day, "10:00"));
    const [s] = await leads(1, sara, pk(day, "10:00"));
    await call(a, abru, pk(before, "11:00"));
    await call(a, abru, pk(day, "11:00"));
    await call(s, sara, pk(day, "11:00"));
    await call(s, sara, pk(day, "12:00"));
    // As the report reads them with today = day.
    const at = async (from, to) =>
      (
        await cur.one("select public.kpi_facts($1,$2,$3,null,$4) r", [
          admin,
          from,
          to,
          pk(day, "23:00"),
        ])
      ).r;
    const counts = (r) =>
      Object.fromEntries(r.agents.map((x) => [x.name, x.today_calls]));
    const todays = await at(day, day);
    expect(todays.today).toBe(day);
    const withCalls = kpiReport(todays, day, day);
    expect(withCalls.today_calls).toBe(true);
    expect(counts(withCalls)).toEqual({ Abru: 1, Sara: 2 });
    // A period holding today: today's calls only, not the period's.
    expect(counts(kpiReport(await at(before, day), before, day))).toEqual({
      Abru: 1,
      Sara: 2,
    });
    // A period before today: today's measures come apart.
    const past = await at(before, before);
    expect(counts(kpiReport(past, before, before, todays.measures)).Abru).toBe(
      1,
    );
    // Answers and Overall are as without the count (before update 085).
    const without = {
      ...todays,
      measures: todays.measures.map((m) => {
        const copy = { ...m };
        delete copy.today_calls;
        return copy;
      }),
    };
    const old = kpiReport(without, day, day);
    expect(old.today_calls).toBe(false);
    const strip = (r) =>
      r.agents.map((x) => {
        const copy = { ...x };
        delete copy.today_calls;
        return copy;
      });
    expect(strip(withCalls)).toEqual(strip(old));
  });

  it("the report shows today's calls for a week to today and for the week before; administrators only", async () => {
    await callsCompleted();
    const today = pkToday();
    // Two calls earlier today (Pakistan time), whatever the hour; a lead
    // given yesterday. Seven-day periods hold working days, so Abru is
    // listed whichever weekday the test runs on.
    const start = Date.parse(pk(today, "00:00"));
    const [a] = await leads(1, abru, pk(addDays(today, -1), "10:00"));
    for (const n of [2, 1])
      await call(
        a,
        abru,
        new Date(
          Math.max(Date.now() - n * 60000, start + n * 1000),
        ).toISOString(),
      );
    const week = await report(addDays(today, -6), today);
    expect(row(week, abru).today_calls).toBe(2);
    const before = await report(addDays(today, -7), addDays(today, -1));
    expect(row(before, abru).today_calls).toBe(2);
    await report(today, today, abru, 403);
    const one = (
      await cur.one("select public.kpi_facts($1,$2,$3,$4,$5) r", [
        admin,
        today,
        today,
        sara,
        new Date().toISOString(),
      ])
    ).r;
    expect(one.measures.every((m) => m.agent_id === sara)).toBe(true);
  });
});

describe("update 085 on a database at 084, as production is", () => {
  let at084;
  beforeAll(async () => {
    at084 = await startCrmDatabase({ before: "085" });
  }, 60000);
  afterAll(async () => {
    await at084?.pg.close();
  });
  const state = async () =>
    cur.one(
      "select md5(pg_get_functiondef('public.kpi_measures(date,date,uuid,timestamp with time zone)'::regprocedure)) f,(select count(*) from kpis)::int k,(select count(*) from kpi_versions)::int v,(select count(*) from kpi_submissions)::int a,(select count(*) from calls)::int c",
    );

  it("applies once, reruns as a no-op, keeps 081 rerunnable, and adds only today_calls", async () => {
    cur = at084;
    await people(cur);
    await callsCompleted();
    const [a] = await leads(1, abru, pk(day, "10:00"));
    await call(a, abru, pk(day, "11:00"));
    const earlier = await facts(day, day);
    const sql = await readFile(migration, "utf8");
    const check = async () =>
      cur.one(
        await readFile(
          new URL(
            "../../supabase/check-kpi-today-calls-085.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
    expect((await check()).release_stage).toBe("at 084, ready for 085");
    const s0 = await state();
    await cur.pg.exec(sql);
    expect(await check()).toMatchObject({
      release_stage: "at 085",
      transactions_open_over_1_min: 0,
    });
    const s1 = await state();
    expect({ ...s1, f: null }).toEqual({ ...s0, f: null });
    expect(s1.f).not.toBe(s0.f);
    await cur.pg.exec(sql);
    await cur.pg.exec(await readFile(m081, "utf8"));
    expect(await state()).toEqual(s1);
    const later = await facts(day, day);
    expect(
      later.measures.map((m) => {
        const copy = { ...m };
        delete copy.today_calls;
        return copy;
      }),
    ).toEqual(earlier.measures);
    expect(later.measures.find((m) => m.agent_id === abru).today_calls).toBe(1);
  });

  it("refuses to run before 084", async () => {
    const at083 = await startCrmDatabase({ before: "084" });
    try {
      await expect(
        at083.pg.exec(await readFile(migration, "utf8")),
      ).rejects.toThrow("Apply CRM updates up to 084 before update 085.");
    } finally {
      await at083.pg.close();
    }
  });
});
