import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 047: staff accounts, departments and shifts. Rules that depend on the
// date or time use the *_at functions with explicit Pakistan times (Monday
// 2 November 2026, company shift 10:00–18:00 Monday to Saturday); access and
// ownership are checked through the API.
const admin = "47000000-0000-4000-8000-000000000001",
  agent = "47000000-0000-4000-8000-000000000002",
  other = "47000000-0000-4000-8000-000000000003",
  editor = "47000000-0000-4000-8000-000000000004",
  developer = "47000000-0000-4000-8000-000000000005",
  gone = "47000000-0000-4000-8000-000000000006";
const MON = "2026-11-02",
  TUE = "2026-11-03",
  SAT = "2026-11-07";
let pg, db, one, all, dept;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
beforeEach(async () => {
  await resetPeople(pg, [admin, agent, other]);
  // Resetting people also empties departments (they record who added them).
  await pg.exec(
    "insert into departments(name,sort_order) values('Sales',10),('Media',20),('Technical',30),('Operations / Other',40) on conflict do nothing;",
  );
  dept = Object.fromEntries(
    (await all("select name,id from departments")).map((d) => [d.name, d.id]),
  );
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'editor@gmail.com',now()),($2,'developer@gmail.com',now()),($3,'gone@gmail.com',now())",
    [editor, developer, gone],
  );
  await pg.query(
    "update profiles set active=true,role='staff',name=case id when $1 then 'Ali Editor' when $2 then 'Hassan Developer' else 'Gone Staff' end,department_id=case id when $2 then $4::uuid else $5::uuid end,job_title=case id when $1 then 'Video Editor' when $2 then 'Developer' else 'Designer' end where id in ($1,$2,$3)",
    [editor, developer, gone, dept.Technical, dept.Media],
  );
  await pg.query("update profiles set active=false where id=$1", [gone]);
  await pg.query("update profiles set department_id=$2 where id=$1", [
    agent,
    dept.Sales,
  ]);
  await pg.exec(
    "insert into attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from) values('HD Marketing standard','10:00','18:00','{1,2,3,4,5,6}',15,'2026-10-01');update attendance_periods set starts_on='2026-10-01';update crm_settings set task_rules_from=null;",
  );
});
const app = () => createApp(trustedMfaFixture(db));
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
const pk = (day, time) => `${day}T${time}:00+05:00`;
const sql = async (text, args = []) => {
  try {
    return (await one(text, args)).r;
  } catch (e) {
    throw Object.assign(new Error(e.message), { code: e.code });
  }
};
const fails = async (promise) => {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal");
};
const create = (data, at = pk(MON, "09:00")) =>
  sql("select public.task_create_at($1,$2::jsonb,'t',$3) r", [
    admin,
    JSON.stringify({
      client_key: randomUUID(),
      task_date: MON,
      scope: "team",
      title: "Edit promotional videos",
      kind: "measurable",
      target_quantity: 3,
      unit: "videos",
      ...data,
    }),
    at,
  ]);
const assignees = (task) => task.assignments.map((a) => a.user_id).sort();
const assignmentOf = (task, user) =>
  task.assignments.find((a) => a.user_id === user);
const progress = (user, id, data, at = pk(MON, "12:00")) =>
  sql("select public.task_progress_at($1,$2,$3::jsonb,'t',$4) r", [
    user,
    id,
    JSON.stringify(data),
    at,
  ]);
const report = (user, day, at) =>
  sql(
    "select public.task_report_submit_at($1,$2,'Done for today',false,'t',$3) r",
    [user, day, at],
  );
const ask = (user, kind, at, reason = null) =>
  sql("select public.task_checkout_request_at($1,$2,$3,'t',$4) r", [
    user,
    kind,
    reason,
    at,
  ]);
const decide = (actor, id, decision, at, waive = false) =>
  sql("select public.task_checkout_decide_at($1,$2,$3,null,$4,'t',$5) r", [
    actor,
    id,
    decision,
    waive,
    at,
  ]);
const state = (user, at) =>
  sql("select public.task_checkout_state_at($1,$2) r", [user, at]);
const checkIn = (user, day, time) =>
  sql("select public.attendance_check_in_at($1,$2,'t') r", [
    user,
    pk(day, time),
  ]);
const checkOut = (user, day, time) =>
  sql("select public.attendance_check_out_at($1,$2,'t') r", [
    user,
    pk(day, time),
  ]);
const ownShift = (user, from, extra = {}) =>
  pg.query(
    "insert into employee_shifts(user_id,effective_from,label,shift_start,shift_end,work_days,grace_minutes) values($1,$2,$3,$4,$5,$6,$7)",
    [
      user,
      from,
      extra.label || "Media shift",
      extra.start || "11:00",
      extra.end || "19:00",
      extra.days || "{1,2,3,4,5}",
      extra.grace ?? 10,
    ],
  );
const today = async () =>
  (await one("select public.attendance_local_date(now())::text d")).d;

describe("staff accounts", () => {
  it("are a third role, separate from departments", async () => {
    expect(
      await one(
        "select role,public.department_name(department_id) d,job_title from profiles where id=$1",
        [editor],
      ),
    ).toEqual({ role: "staff", d: "Media", job_title: "Video Editor" });
    expect(
      (
        await fails(
          pg.query("update profiles set role='manager' where id=$1", [editor]),
        )
      ).code,
    ).toBe("23514");
    expect(
      (await all("select name from departments order by sort_order")).map(
        (d) => d.name,
      ),
    ).toEqual(["Sales", "Media", "Technical", "Operations / Other"]);
  });
  it("sign in only through the Staff portal, and never when disabled", async () => {
    const me = await get(editor, "/me?portal=staff");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: "staff", name: "Ali Editor" });
    expect((await get(editor, "/me?portal=agent")).body.error).toBe(
      "This account cannot sign in to the Agent portal. Choose the correct portal for your account.",
    );
    expect((await get(agent, "/me?portal=staff")).body.error).toBe(
      "This account cannot sign in to the Staff portal. Choose the correct portal for your account.",
    );
    expect((await get(gone, "/me")).status).toBe(403);
    await sql(
      "select public.record_login_attempt('editor@gmail.com',true,$1,'staff','127.0.0.1','test',5,15,15,8,20) r",
      [editor],
    );
    expect(
      (await one("select portal from login_events where user_id=$1", [editor]))
        .portal,
    ).toBe("staff");
  });
  it("see their own profile with department, job title and shift", async () => {
    const res = await get(editor, "/profile");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      role: "staff",
      department: "Media",
      job_title: "Video Editor",
      shift: { source: "company", shift_start: "10:00", shift_end: "18:00" },
    });
  });
  it("reach only their own work, attendance, notifications and profile", async () => {
    for (const path of [
      "/profile",
      "/notifications",
      "/attendance/me",
      "/attendance/leave",
      "/tasks/my",
      "/tasks/checkout",
    ])
      expect((await get(editor, path)).status, path).toBe(200);
    for (const path of [
      "/leads",
      "/leads/deleted",
      "/properties",
      "/inventory/summary",
      "/documents",
      "/dashboard",
      "/reports",
      "/leaderboard",
      "/targets",
      "/followups",
      "/visits",
      "/deals",
      "/users",
      "/audit",
      "/accounts",
      "/admin/tasks",
      "/admin/employees",
      "/admin/attendance/overview",
      "/integrations/meta/summary",
      "/health/status",
      "/call-capabilities",
      "/reminders",
    ]) {
      const res = await get(editor, path);
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe("STAFF_NOT_ALLOWED");
    }
    expect(
      (await send(editor, "post", "/leads", { name: "Buyer" })).status,
    ).toBe(403);
    // Agents keep what they had (leads are covered by the lead tests; this
    // fixture answers only function calls).
    for (const path of ["/properties", "/inventory/summary", "/tasks/my"])
      expect((await get(agent, path)).status, path).toBe(200);
    expect((await get(agent, "/admin/employees")).status).toBe(403);
    expect((await get(admin, "/admin/employees")).status).toBe(200);
  });
  it("can't use sales or administrator functions in the database either", async () => {
    for (const [text, args] of [
      ["select public.inventory_member($1) r", [editor]],
      ["select public.employees_page($1,'{}',1,20) r", [editor]],
      ["select public.employee_departments($1) r", [editor]],
      ["select public.attendance_admin($1) r", [editor]],
    ])
      expect((await fails(sql(text, args))).code, text).toBe("HA403");
    expect(
      (
        await fails(
          sql("select public.task_create_at($1,$2::jsonb,'t',$3) r", [
            editor,
            JSON.stringify({
              client_key: randomUUID(),
              scope: "team",
              title: "x",
            }),
            pk(MON, "09:00"),
          ]),
        )
      ).code,
    ).toBe("HA403");
  });
  it("get phone numbers masked like agents", async () => {
    await create(
      {
        scope: "individual",
        assignees: [editor],
        kind: "simple",
        title: "Call the client back",
        description: "Client number 0300 1234567",
        task_date: await today(),
      },
      new Date().toISOString(),
    );
    const mine = await get(editor, "/tasks/my");
    expect(mine.status).toBe(200);
    expect(JSON.stringify(mine.body)).not.toContain("1234567");
  });
  it("give browser roles nothing new", async () => {
    const tables = await all(
      "select relname,relrowsecurity from pg_class where relname in ('departments','employee_shifts')",
    );
    expect(tables.map((t) => t.relrowsecurity)).toEqual([true, true]);
    expect(
      (
        await one(
          "select count(*)::int n from information_schema.role_table_grants where table_name in ('departments','employee_shifts') and grantee in ('anon','authenticated')",
        )
      ).n,
    ).toBe(0);
    const fns = await all(
      "select p.proname,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') browser,has_function_privilege('service_role',p.oid,'execute') api from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('department_name','attendance_shift_apply','attendance_policy_for','attendance_admin_rules_for','employee_shift_info','task_recipients','task_audience','account_provisioning_details','employee_departments','department_save','employee_detail','employee_profile_save','employee_shift_save','employee_shift_cancel','employees_page','employee_me','task_performance','attendance_leave_page')",
    );
    expect(fns.filter((f) => f.anon || f.browser)).toEqual([]);
    const api = new Set(fns.filter((f) => f.api).map((f) => f.proname));
    for (const helper of [
      "department_name",
      "attendance_shift_apply",
      "attendance_policy_for",
      "attendance_admin_rules_for",
      "employee_shift_info",
      "task_recipients",
      "task_audience",
    ])
      expect(api.has(helper), helper).toBe(false);
    for (const callable of [
      "employees_page",
      "employee_me",
      "department_save",
      "task_performance",
      "attendance_leave_page",
    ])
      expect(api.has(callable), callable).toBe(true);
  });
});

describe("departments and employee details", () => {
  it("are changed by administrators, audited and readable", async () => {
    const res = await send(admin, "patch", `/admin/employees/${editor}`, {
      department_id: dept.Technical,
      job_title: "Motion Designer",
      joined_on: "2026-09-01",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      department: "Technical",
      job_title: "Motion Designer",
      joined_on: "2026-09-01",
    });
    // Saving the same details again records nothing new.
    await send(admin, "patch", `/admin/employees/${editor}`, {
      job_title: "Motion Designer",
    });
    const audit = await get(admin, "/audit?module=accounts");
    const entries = audit.body.data.filter((e) => e.title.includes("employee"));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: "Updated employee details",
      description:
        "Set Ali Editor's department to Technical, job title to Motion Designer and joining date to September 1, 2026.",
    });
    expect(entries[0].changes).toEqual([
      { label: "Department", before: "Media", after: "Technical" },
      { label: "Job title", before: "Video Editor", after: "Motion Designer" },
      { label: "Joining date", before: null, after: "September 1, 2026" },
    ]);
    expect(
      (
        await send(editor, "patch", `/admin/employees/${editor}`, {
          job_title: "Boss",
        })
      ).status,
    ).toBe(403);
  });
  it("can be added, renamed and deactivated but never duplicated", async () => {
    const created = await send(admin, "post", "/admin/departments", {
      name: "Customer Care",
    });
    expect(created.status).toBe(201);
    expect(
      (
        await send(admin, "post", "/admin/departments", {
          name: "customer care",
        })
      ).status,
    ).toBe(409);
    const renamed = await send(
      admin,
      "patch",
      `/admin/departments/${created.body.id}`,
      {
        name: "Client Care",
      },
    );
    expect(renamed.body.name).toBe("Client Care");
    await send(admin, "patch", `/admin/departments/${created.body.id}`, {
      active: false,
    });
    const refused = await send(admin, "patch", `/admin/employees/${editor}`, {
      department_id: created.body.id,
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toBe("Choose an active department");
    const list = (await get(admin, "/admin/departments")).body;
    expect(list.find((d) => d.name === "Media")).toMatchObject({
      members: 1,
      staff: 1,
      agents: 0,
    });
    const titles = (await get(admin, "/audit?module=accounts")).body.data.map(
      (e) => e.description,
    );
    expect(titles).toContain("Renamed “Customer Care” to “Client Care”.");
    expect(titles).toContain("Deactivated “Client Care”.");
  });
  it("list every employee with today's attendance and tasks, filtered on the server", async () => {
    const day = await today();
    await create({ all_staff: true, task_date: day }, new Date().toISOString());
    const all = (await get(admin, "/admin/employees?account=active")).body;
    expect(all.summary).toMatchObject({
      agents: 2,
      staff: 2,
      admins: 1,
      active: 5,
    });
    const staff = (
      await get(admin, "/admin/employees?role=staff&account=active")
    ).body;
    expect(staff.data.map((e) => e.name)).toEqual([
      "Ali Editor",
      "Hassan Developer",
    ]);
    expect(staff.data[0]).toMatchObject({
      department: "Media",
      job_title: "Video Editor",
      tasks: 1,
      completed: 0,
      shift: { source: "company" },
    });
    const media = (
      await get(admin, `/admin/employees?department=${dept.Media}`)
    ).body;
    expect(media.data.map((e) => e.name)).toEqual(["Ali Editor", "Gone Staff"]);
    const none = (
      await get(admin, "/admin/employees?department=none&account=active")
    ).body;
    expect(none.data.map((e) => e.name)).toEqual(["Owner", "Sara Agent"]);
    const open = (await get(admin, "/admin/employees?tasks=incomplete")).body;
    expect(open.data.map((e) => e.name)).toEqual([
      "Ali Editor",
      "Hassan Developer",
    ]);
    expect((await get(admin, "/admin/employees?role=manager")).status).toBe(
      400,
    );
  });
});

describe("tasks for staff", () => {
  it("go to departments, all staff or mixed groups, one assignment each", async () => {
    await pg.query("update profiles set department_id=$2 where id=$1", [
      other,
      dept.Media,
    ]);
    const media = await create({ departments: [dept.Media] });
    // Active Media members only: the staff member and the agent, not Gone Staff.
    expect(assignees(media)).toEqual([other, editor].sort());
    expect(media.audience).toEqual({ departments: ["Media"] });
    const staff = await create({ all_staff: true, title: "Weekly backup" });
    expect(assignees(staff)).toEqual([editor, developer].sort());
    const mixed = await create({
      all_agents: true,
      departments: [dept.Technical],
      assignees: [editor],
      title: "Team meeting notes",
    });
    expect(assignees(mixed)).toEqual([agent, other, developer, editor].sort());
    expect(mixed.audience).toEqual({
      all_agents: true,
      departments: ["Technical"],
      people: 1,
    });
    expect(
      (
        await one(
          "select count(*)::int n from task_assignments where task_id=$1",
          [mixed.id],
        )
      ).n,
    ).toBe(4);
  });
  it("are decided when assigned: later department members get nothing", async () => {
    const media = await create({ departments: [dept.Media] });
    await pg.query("update profiles set department_id=$2 where id=$1", [
      developer,
      dept.Media,
    ]);
    expect(
      (
        await all("select user_id from task_assignments where task_id=$1", [
          media.id,
        ])
      ).map((r) => r.user_id),
    ).toEqual([editor]);
    // Changing department keeps the history.
    await pg.query("update profiles set department_id=$2 where id=$1", [
      editor,
      dept.Technical,
    ]);
    expect(
      (
        await one(
          "select count(*)::int n from task_assignments where task_id=$1 and user_id=$2",
          [media.id, editor],
        )
      ).n,
    ).toBe(1);
  });
  it("refuse inactive staff, admins and unknown departments", async () => {
    expect(
      (await fails(create({ scope: "individual", assignees: [gone] }))).message,
    ).toBe("Gone Staff is not an active staff member and can't be given tasks");
    expect(
      (await fails(create({ scope: "individual", assignees: [admin] })))
        .message,
    ).toBe(
      "Owner is not an active agent or staff member and can't be given tasks",
    );
    expect((await fails(create({ departments: [randomUUID()] }))).message).toBe(
      "A department is not an active department",
    );
    expect(
      (await fails(create({ scope: "individual", departments: [dept.Media] })))
        .message,
    ).toBe("An individual task is for one person");
  });
  it("let staff update only their own progress, report, and see the review", async () => {
    const t = await create({ scope: "individual", assignees: [editor] });
    const mine = assignmentOf(t, editor);
    expect(await progress(editor, mine.id, { quantity: 2 })).toMatchObject({
      completed_quantity: 2,
      percent: 66.7,
    });
    expect(
      (await fails(progress(developer, mine.id, { quantity: 3 }))).code,
    ).toBe("HA404");
    const filed = await report(editor, MON, pk(MON, "17:00"));
    expect(filed).toMatchObject({ completion_percent: 66.7, task_count: 1 });
    const reviewed = await sql(
      "select public.task_report_review($1,$2,'Good work','t') r",
      [admin, filed.id],
    );
    expect(reviewed.status).toBe("reviewed");
    expect(
      (
        await fails(
          sql("select public.task_report_review($1,$2,null,'t') r", [
            editor,
            filed.id,
          ]),
        )
      ).code,
    ).toBe("HA403");
    const notices = await all(
      "select type,link from notifications where user_id=$1 order by created_at",
      [editor],
    );
    expect(notices.map((n) => n.type)).toEqual([
      "task_assigned",
      "task_report_reviewed",
    ]);
    expect(notices[0].link).toBe("/my-tasks");
  });
  it("show department performance with each task counted equally", async () => {
    const t = await create({ all_staff: true, all_agents: true });
    await progress(editor, assignmentOf(t, editor).id, { quantity: 3 });
    await progress(developer, assignmentOf(t, developer).id, { quantity: 1 });
    const media = await sql(
      "select public.task_performance($1,$2,$3,null,$4) r",
      [admin, MON, MON, dept.Media],
    );
    expect(media.totals).toMatchObject({
      assignments: 1,
      completed: 1,
      average_percent: 100,
    });
    expect(media.employees.map((e) => [e.name, e.role, e.department])).toEqual([
      ["Ali Editor", "staff", "Media"],
    ]);
    const everyone = await sql(
      "select public.task_performance($1,$2,$3,null) r",
      [admin, MON, MON],
    );
    expect(everyone.totals.assignments).toBe(4);
    expect(
      everyone.departments.find((d) => d.name === "Technical"),
    ).toMatchObject({
      employees: 1,
      assignments: 1,
      completed: 0,
      average_percent: 33.3,
    });
    expect(everyone.employees.map((e) => e.name)).toContain("Hassan Developer");
    const api = await get(
      admin,
      `/admin/tasks/performance?from=${MON}&to=${MON}&department=${dept.Technical}`,
    );
    expect(api.body.totals.assignments).toBe(1);
  });
});

describe("staff attendance and shifts", () => {
  it("use the company shift unless an own shift is set", async () => {
    expect(await checkIn(editor, MON, "10:20")).toMatchObject({
      punctuality: "late",
      late_minutes: 20,
    });
    expect(await checkOut(editor, MON, "18:05")).toMatchObject({
      state: "checked_out",
    });
    const row = await one(
      "select shift_start::text s,shift_end::text e from attendance_records where user_id=$1",
      [editor],
    );
    expect(row).toEqual({ s: "10:00:00", e: "18:00:00" });
  });
  it("apply an own shift from its date, keeping earlier days as they were", async () => {
    await ownShift(editor, TUE);
    expect(await checkIn(editor, MON, "10:05")).toMatchObject({
      punctuality: "within_grace",
    });
    await checkOut(editor, MON, "18:00");
    expect(await checkIn(editor, TUE, "11:08")).toMatchObject({
      punctuality: "within_grace",
    });
    expect(
      await one(
        "select shift_start::text s,shift_end::text e,grace_minutes g from attendance_records where user_id=$1 and attendance_date=$2",
        [editor, TUE],
      ),
    ).toEqual({ s: "11:00:00", e: "19:00:00", g: 10 });
    // Checking out at 18:30 is early for the 19:00 shift.
    expect(await checkOut(editor, TUE, "18:30")).toMatchObject({
      early_departure_minutes: 30,
    });
    const days = await all(
      "select day::text d,state,scheduled,shift_start::text s from public.attendance_days($1,$2,$3,$4) order by day",
      [MON, SAT, editor, pk(SAT, "20:00")],
    );
    expect(days.find((d) => d.d === MON)).toMatchObject({
      s: "10:00:00",
      state: "checked_out",
    });
    // Saturday is a working day for the company, not on this shift.
    expect(days.find((d) => d.d === SAT)).toMatchObject({
      state: "day_off",
      scheduled: false,
    });
    expect(
      (await one("select public.employee_shift_info($1,$2) r", [editor, TUE]))
        .r,
    ).toMatchObject({
      source: "individual",
      label: "Media shift",
      shift_start: "11:00",
      work_days: [1, 2, 3, 4, 5],
    });
    // Back to the company shift from a later date.
    await pg.query(
      "insert into employee_shifts(user_id,effective_from,follows_company) values($1,'2026-11-09',true)",
      [editor],
    );
    expect(
      (
        await one("select public.employee_shift_info($1,'2026-11-09') r", [
          editor,
        ])
      ).r,
    ).toMatchObject({ source: "company", shift_start: "10:00" });
  });
  it("change from today or later through Shift management, audited, and future changes can be withdrawn", async () => {
    const day = await today();
    const later = (await one("select ($1::date+3)::text d", [day])).d;
    // Update 048 retired the 047 routes; changes go through Shift management
    // and start from the version shown.
    const path = `/admin/attendance/shifts/employees/${developer}`;
    const version = async () => (await get(admin, path)).body.shift_version;
    const saved = await send(admin, "post", path, {
      effective_from: later,
      expected_version: await version(),
      label: "Late tech shift",
      shift_start: "12:00",
      shift_end: "20:00",
      work_days: [1, 2, 3, 4, 5],
      grace_minutes: 10,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.shift.upcoming).toMatchObject({
      effective_from: later,
      label: "Late tech shift",
    });
    const past = await send(admin, "post", path, {
      effective_from: "2026-01-05",
      expected_version: await version(),
      inherit: true,
    });
    expect(past.status).toBe(400);
    expect(past.body.error).toBe(
      "Choose today or a date up to a year ahead. Days already worked keep the shift they had.",
    );
    expect(
      (
        await send(admin, "post", path, {
          expected_version: await version(),
          label: "Broken",
          shift_start: "18:00",
          shift_end: "09:00",
          work_days: [1],
          grace_minutes: 0,
        })
      ).status,
    ).toBe(400);
    const entry = (await get(admin, "/audit?module=attendance")).body.data.find(
      (e) => e.title === "Assigned an individual shift",
    );
    expect(entry.description).toContain(
      "Set Hassan Developer's shift to Late tech shift, 12:00 PM–8:00 PM, Mon–Fri, 10 min grace",
    );
    expect(entry.changes[0]).toMatchObject({
      label: "Shift",
      before: "Company default shift (10:00 AM–6:00 PM)",
    });
    const withdrawn = await send(
      admin,
      "delete",
      `${path}/${later}?version=${await version()}`,
    );
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.shift.upcoming).toBeNull();
    expect(
      (
        await send(
          admin,
          "delete",
          `${path}/${later}?version=${await version()}`,
        )
      ).status,
    ).toBe(409);
  });
  it("appear in administrator attendance with their department", async () => {
    await checkIn(editor, MON, "10:00");
    const daily = await sql(
      "select public.attendance_daily($1,$2,null,'staff',null,null,null,1,50) r",
      [admin, MON],
    );
    expect(daily.data.map((r) => [r.name, r.role, r.department])).toEqual([
      ["Ali Editor", "staff", "Media"],
      ["Hassan Developer", "staff", "Technical"],
    ]);
    const people = await sql("select public.attendance_employees($1) r", [
      admin,
    ]);
    expect(people.find((p) => p.id === developer)).toMatchObject({
      role: "staff",
      department: "Technical",
    });
    const res = await get(
      admin,
      `/admin/attendance/employees/${editor}?from=${MON}&to=${MON}`,
    );
    expect(res.body.employee).toMatchObject({
      role: "staff",
      department: "Media",
      job_title: "Video Editor",
    });
  });
  it("use the staff member's shift for corrections and historical entries", async () => {
    await ownShift(editor, "2026-10-26");
    // A missing day, approved from a correction, gets the own shift.
    const { id } = await one(
      "insert into attendance_corrections(user_id,attendance_date,correction_type,requested_check_in_at,requested_check_out_at,reason) values($1,'2026-10-27','missing_check_in',$2,$3,'Forgot') returning id",
      [editor, pk("2026-10-27", "11:30"), pk("2026-10-27", "19:00")],
    );
    await sql(
      "select public.attendance_correction_review($1,$2,'approved',null,'t') r",
      [admin, id],
    );
    expect(
      await one(
        "select shift_start::text s,punctuality,late_minutes from attendance_records where user_id=$1 and attendance_date='2026-10-27'",
        [editor],
      ),
    ).toEqual({ s: "11:00:00", punctuality: "late", late_minutes: 30 });
    const entered = await sql(
      "select public.attendance_admin_set_at($1,$2,$3::jsonb,'Office records',false,false,'t',$4) r",
      [
        admin,
        editor,
        JSON.stringify([
          {
            date: "2026-10-28",
            status: "present",
            check_in: "11:05",
            check_out: "19:00",
          },
        ]),
        pk("2026-10-30", "12:00"),
      ],
    );
    expect(entered.results[0].result).not.toBe("error");
    expect(
      await one(
        "select shift_start::text s,punctuality from attendance_records where user_id=$1 and attendance_date='2026-10-28'",
        [editor],
      ),
    ).toEqual({ s: "11:00:00", punctuality: "within_grace" });
  });
});

describe("checkout approvals for staff", () => {
  it("stay off by default", async () => {
    await checkIn(editor, MON, "10:00");
    expect(await state(editor, pk(MON, "15:00"))).toMatchObject({
      required: false,
    });
    expect(await checkOut(editor, MON, "15:00")).toMatchObject({
      state: "checked_out",
    });
  });
  it("need the report, allow early checkout after finishing, and leave the decision to administrators", async () => {
    await pg.query("update crm_settings set task_rules_from=$1", [MON]);
    const t = await create({
      scope: "individual",
      assignees: [editor],
      kind: "simple",
      title: "Edit the DHA video",
      priority: "high",
    });
    await checkIn(editor, MON, "10:00");
    expect((await fails(checkOut(editor, MON, "18:05"))).message).toBe(
      "Please submit your daily work report before checking out.",
    );
    await progress(
      editor,
      assignmentOf(t, editor).id,
      { status: "completed" },
      pk(MON, "15:30"),
    );
    await report(editor, MON, pk(MON, "15:50"));
    expect(await state(editor, pk(MON, "16:00"))).toMatchObject({
      required: true,
      can_request_early: true,
    });
    const req = await ask(
      editor,
      "early",
      pk(MON, "16:00"),
      "All videos delivered",
    );
    expect((await fails(ask(editor, "early", pk(MON, "16:01")))).message).toBe(
      "You already have a request waiting for an administrator",
    );
    expect(
      (await fails(decide(editor, req.id, "approve", pk(MON, "16:02")))).code,
    ).toBe("HA403");
    const admins = await all(
      "select type,link from notifications where user_id=$1 and type='checkout_request'",
      [admin],
    );
    expect(admins).toHaveLength(1);
    await decide(admin, req.id, "approve", pk(MON, "16:05"));
    // Approval allows the check-out; it doesn't check anyone out.
    expect(
      (
        await one("select state from attendance_records where user_id=$1", [
          editor,
        ])
      ).state,
    ).toBe("checked_in");
    expect(await checkOut(editor, MON, "16:10")).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 110,
    });
  });
  it("allow an emergency checkout with the report waived", async () => {
    await pg.query("update crm_settings set task_rules_from=$1", [MON]);
    await checkIn(developer, MON, "10:00");
    const req = await ask(
      developer,
      "emergency",
      pk(MON, "12:00"),
      "Family emergency",
    );
    await decide(admin, req.id, "approve", pk(MON, "12:05"), true);
    expect(await checkOut(developer, MON, "12:10")).toMatchObject({
      state: "checked_out",
    });
  });
  it("give staff without tasks a no-tasks report, not a completion-based early checkout", async () => {
    await pg.query("update crm_settings set task_rules_from=$1", [MON]);
    await checkIn(developer, MON, "10:00");
    expect(await report(developer, MON, pk(MON, "15:00"))).toMatchObject({
      task_count: 0,
    });
    expect(await state(developer, pk(MON, "15:30"))).toMatchObject({
      can_request_early: false,
      can_request_emergency: true,
    });
    expect(await checkOut(developer, MON, "18:00")).toMatchObject({
      state: "checked_out",
    });
  });
});

describe("leave for staff", () => {
  it("is requested by staff, decided by administrators and never counted as absence", async () => {
    const day = await today();
    const from = (await one("select ($1::date+7)::text d", [day])).d;
    const res = await send(editor, "post", "/attendance/leave", {
      leave_type: "casual",
      start_date: from,
      end_date: from,
      reason: "Family wedding",
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const second = await send(developer, "post", "/attendance/leave", {
      leave_type: "sick",
      start_date: from,
      end_date: from,
      reason: "Doctor",
    });
    // Staff see only their own requests.
    const mine = (await get(editor, `/attendance/leave?status=pending`)).body;
    expect(mine.data.map((r) => r.employee_name)).toEqual(["Ali Editor"]);
    // Administrators can filter by department.
    const media = (
      await get(
        admin,
        `/admin/attendance/leave?status=pending&department=${dept.Media}`,
      )
    ).body;
    expect(
      media.data.map((r) => [r.employee_name, r.employee_department]),
    ).toEqual([["Ali Editor", "Media"]]);
    expect(
      (await get(admin, "/admin/attendance/leave?status=pending")).body.count,
    ).toBe(2);
    expect(
      (
        await send(
          admin,
          "post",
          `/admin/attendance/leave/${res.body.id}/review`,
          { decision: "approved" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await send(
          admin,
          "post",
          `/admin/attendance/leave/${second.body.id}/review`,
          { decision: "rejected", note: "Busy week" },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await one("select state from public.attendance_days($1,$1,$2,now())", [
          from,
          editor,
        ])
      ).state,
    ).toBe("leave");
    expect(
      (
        await all(
          "select type,link from notifications where user_id=$1 and type='attendance_review'",
          [editor],
        )
      )[0].link,
    ).toBe("/attendance");
    // A staff member can't decide leave.
    expect(
      (
        await send(
          editor,
          "post",
          `/admin/attendance/leave/${second.body.id}/review`,
          { decision: "approved" },
        )
      ).status,
    ).toBe(403);
  });
});
