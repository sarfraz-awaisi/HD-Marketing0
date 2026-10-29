import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { trustedMfaFixture } from "./trusted-mfa-fixture.js";
import { resetPeople, startCrmDatabase } from "./crm-fixture.js";
// Update 048: office timings for roles, departments and individual employees.
// Timings are saved through the API from a date that is today or later, so
// the attendance days used here are the coming week (MON is the next Monday
// after today). Check-ins and check-outs use the *_at functions with explicit
// Pakistan times; access is checked through the API.
const admin = "48000000-0000-4000-8000-000000000001",
  agent = "48000000-0000-4000-8000-000000000002",
  other = "48000000-0000-4000-8000-000000000003",
  editor = "48000000-0000-4000-8000-000000000004",
  editor2 = "48000000-0000-4000-8000-000000000005",
  developer = "48000000-0000-4000-8000-000000000006",
  gone = "48000000-0000-4000-8000-000000000007";
let pg, db, one, all, dept, TODAY, MON, TUE, WED, SAT, NEXT_MON;
beforeAll(async () => {
  ({ pg, db, one, all } = await startCrmDatabase());
}, 60000);
afterAll(async () => {
  await pg?.close();
});
const plus = async (day, n) =>
  (await one("select ($1::date+$2::int)::text d", [day, n])).d;
beforeEach(async () => {
  await resetPeople(pg, [admin, agent, other]);
  await pg.exec(
    "insert into departments(name,sort_order) values('Sales',10),('Media',20),('Technical',30),('Operations / Other',40) on conflict do nothing;",
  );
  dept = Object.fromEntries(
    (await all("select name,id from departments")).map((d) => [d.name, d.id]),
  );
  await pg.query(
    "insert into auth.users(id,email,email_confirmed_at) values($1,'editor@gmail.com',now()),($2,'bilal@gmail.com',now()),($3,'developer@gmail.com',now()),($4,'gone@gmail.com',now())",
    [editor, editor2, developer, gone],
  );
  await pg.query(
    "update profiles set active=true,role='staff',name=case id when $1 then 'Ali Editor' when $2 then 'Bilal Editor' when $3 then 'Hassan Developer' else 'Gone Staff' end,department_id=case id when $3 then $5::uuid else $6::uuid end where id in ($1,$2,$3,$4)",
    [editor, editor2, developer, gone, dept.Technical, dept.Media],
  );
  await pg.query("update profiles set active=false where id=$1", [gone]);
  await pg.query("update profiles set department_id=$2 where id=$1", [
    agent,
    dept.Sales,
  ]);
  await pg.exec(
    "insert into attendance_policies(name,shift_start,shift_end,work_days,grace_minutes,effective_from) values('HD Marketing standard','10:00','18:00','{1,2,3,4,5,6}',15,'2026-10-01');update attendance_periods set starts_on='2026-10-01';update crm_settings set task_rules_from=null;",
  );
  TODAY = (await one("select public.attendance_local_date(now())::text d")).d;
  MON = (
    await one(
      "select ($1::date+(8-extract(isodow from $1::date))::int)::text d",
      [TODAY],
    )
  ).d;
  TUE = await plus(MON, 1);
  WED = await plus(MON, 2);
  SAT = await plus(MON, 5);
  NEXT_MON = await plus(MON, 7);
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
const info = (user, day) =>
  sql("select public.employee_shift_info($1,$2) r", [user, day]);
const overview = async () => {
  const res = await get(admin, "/admin/attendance/shifts");
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const roleRow = async (role) =>
  (await overview()).roles.find((r) => r.role === role);
const deptRow = async (name) =>
  (await overview()).departments.find((d) => d.name === name);
const timing = (start, end, days, grace = 15, extra = {}) => ({
  shift_start: start,
  shift_end: end,
  work_days: days,
  grace_minutes: grace,
  ...extra,
});
const MON_SAT = [1, 2, 3, 4, 5, 6],
  MON_FRI = [1, 2, 3, 4, 5];
// Saves a role or department timing from the version currently shown.
const setRole = async (role, from, data) =>
  send(admin, "post", `/admin/attendance/shifts/roles/${role}`, {
    effective_from: from,
    expected_version: (await roleRow(role)).version,
    ...data,
  });
const setDept = async (name, from, data) =>
  send(admin, "post", `/admin/attendance/shifts/departments/${dept[name]}`, {
    effective_from: from,
    expected_version: (await deptRow(name)).version,
    ...data,
  });
const versionOf = async (user) =>
  (await get(admin, `/admin/attendance/shifts/employees/${user}`)).body
    .shift_version;
const setOwn = async (user, from, data) =>
  send(admin, "post", `/admin/attendance/shifts/employees/${user}`, {
    effective_from: from,
    expected_version: await versionOf(user),
    ...data,
  });
const ok = (res) => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};
const notices = (user) =>
  all(
    "select type,title,body,link,group_key from notifications where user_id=$1 and type='shift_changed' order by created_at,id",
    [user],
  );
// Shift entries in the attendance activity, newest first.
const auditOf = async () =>
  (await get(admin, "/audit?module=attendance")).body.data.filter((e) =>
    /shift|working days|grace period/i.test(e.title),
  );

describe("role and department timings", () => {
  it("set the Agent and Staff default shifts from a date, telling only the people whose timing changes", async () => {
    // The agent default matches the company shift: nobody's timing changes.
    ok(
      await setRole(
        "agent",
        MON,
        timing("10:00", "18:00", MON_SAT, 15, { reason: "Office hours" }),
      ),
    );
    ok(await setRole("staff", MON, timing("09:00", "17:00", MON_FRI, 10)));
    const agents = await roleRow("agent");
    expect(agents.current).toBeNull();
    expect(agents.planned).toMatchObject([
      { effective_from: MON, shift_start: "10:00", reason: "Office hours" },
    ]);
    expect(await info(agent, MON)).toMatchObject({
      source: "role",
      source_label: "Agent default shift",
      shift_start: "10:00",
    });
    expect(await info(developer, MON)).toMatchObject({
      source: "role",
      source_label: "Staff default shift",
      shift_start: "09:00",
      shift_end: "17:00",
      work_days: MON_FRI,
      grace_minutes: 10,
    });
    // Until then everyone follows the company shift, and is told what's coming.
    expect(await info(developer, TODAY)).toMatchObject({
      source: "company",
      source_label: "Company default shift",
      upcoming: {
        effective_from: MON,
        source_label: "Staff default shift",
        shift_start: "09:00",
      },
    });
    // Administrators keep the company shift.
    expect(await info(admin, MON)).toMatchObject({ source: "company" });
    expect(await notices(agent)).toEqual([]);
    for (const person of [editor, editor2, developer])
      expect(await notices(person)).toMatchObject([
        {
          title: "Your office timing has been updated",
          link: "/attendance",
          body: expect.stringContaining(
            "your office timing is 9:00 AM – 5:00 PM, Mon–Fri (Staff default shift).",
          ),
        },
      ]);
    expect(await notices(gone)).toEqual([]);
  });
  it("set the Media and Technical department shifts over the role default", async () => {
    ok(await setRole("staff", MON, timing("09:00", "17:00", MON_FRI, 10)));
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
    ok(await setDept("Technical", MON, timing("09:00", "17:00", MON_FRI, 10)));
    expect(await info(editor, MON)).toMatchObject({
      source: "department",
      source_label: "Media department shift",
      shift_start: "12:00",
      shift_end: "20:00",
      work_days: MON_SAT,
    });
    expect(await info(developer, MON)).toMatchObject({
      source: "department",
      source_label: "Technical department shift",
      shift_start: "09:00",
    });
    // The agent in Sales: no Sales or agent timing, so the company shift.
    expect(await info(agent, MON)).toMatchObject({ source: "company" });
    // Editors were told twice (staff default, then Media); the developer once,
    // as the Technical shift matches the staff default.
    expect(await notices(editor)).toHaveLength(2);
    expect((await notices(editor))[1].body).toContain(
      "12:00 PM – 8:00 PM, Mon–Sat (Media department shift)",
    );
    expect(await notices(developer)).toHaveLength(1);
    const media = await deptRow("Media");
    expect(media).toMatchObject({ members: 2, following: 0 });
    expect(media.planned).toHaveLength(1);
  });
  it("give new employees the timing of their department or role", async () => {
    ok(await setRole("staff", MON, timing("09:00", "17:00", MON_FRI, 10)));
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
    const designer = randomUUID(),
      tester = randomUUID();
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'designer@gmail.com',now()),($2,'tester@gmail.com',now())",
      [designer, tester],
    );
    await pg.query(
      "update profiles set active=true,role='staff',name='New Designer',department_id=$2 where id=$1",
      [designer, dept.Media],
    );
    await pg.query(
      "update profiles set active=true,role='staff',name='New Tester' where id=$1",
      [tester],
    );
    expect(await info(designer, MON)).toMatchObject({
      source_label: "Media department shift",
      shift_start: "12:00",
    });
    expect(await info(tester, MON)).toMatchObject({
      source_label: "Staff default shift",
      shift_start: "09:00",
    });
  });
  it("leave employees with their own shift untouched and unnotified", async () => {
    ok(
      await setOwn(
        editor,
        MON,
        timing("14:00", "22:00", MON_SAT, 10, { reason: "Evening edits" }),
      ),
    );
    await pg.exec("delete from notifications");
    ok(await setDept("Media", MON, timing("11:00", "19:00", MON_SAT)));
    expect(await info(editor, MON)).toMatchObject({
      source: "individual",
      source_label: "Individual shift",
      shift_start: "14:00",
    });
    expect(await info(editor2, MON)).toMatchObject({
      source: "department",
      shift_start: "11:00",
    });
    expect(await notices(editor)).toEqual([]);
    expect(await notices(editor2)).toHaveLength(1);
    expect(await deptRow("Media")).toMatchObject({ members: 2 });
  });
  it("end a department shift so its employees return to the role default", async () => {
    ok(await setRole("staff", MON, timing("09:00", "17:00", MON_FRI, 10)));
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
    ok(
      await setDept("Media", WED, { inherit: true, reason: "Back to normal" }),
    );
    expect(await info(editor, TUE)).toMatchObject({ shift_start: "12:00" });
    expect(await info(editor, WED)).toMatchObject({
      source: "role",
      source_label: "Staff default shift",
      shift_start: "09:00",
    });
    expect((await notices(editor)).at(-1).body).toMatch(
      /^The Media department shift has ended\. From .+ your office timing is 9:00 AM – 5:00 PM, Mon–Fri \(Staff default shift\)\.$/,
    );
    // Removing it again is refused: nothing left to remove from that day.
    const again = await setDept("Media", WED, { inherit: true });
    expect(again.status).toBe(409);
    // The role default can end too: staff return to the company shift.
    ok(await setRole("staff", WED, { inherit: true }));
    expect(await info(developer, WED)).toMatchObject({
      source: "company",
      shift_start: "10:00",
    });
  });
  it("refuse past dates, overnight shifts, inactive departments and repeats", async () => {
    const past = await setRole(
      "agent",
      "2026-01-05",
      timing("09:00", "17:00", MON_FRI),
    );
    expect(past.status).toBe(400);
    expect(past.body.error).toBe(
      "Choose today or a date up to a year ahead. Days already worked keep the shift they had.",
    );
    const overnight = await setRole(
      "staff",
      MON,
      timing("22:00", "06:00", MON_FRI),
    );
    expect(overnight.status).toBe(400);
    expect(JSON.stringify(overnight.body)).toContain(
      "Overnight shifts are not supported",
    );
    // The database refuses it too.
    const refused = await fails(
      sql(
        "select public.shift_default_save($1,'role','staff',$2::jsonb,'t') r",
        [
          admin,
          JSON.stringify({
            ...timing("22:00", "06:00", MON_FRI),
            expected_version: (await roleRow("staff")).version,
          }),
        ],
      ),
    );
    expect(refused.code).toBe("HA400");
    expect(refused.message).toContain("Overnight shifts are not supported");
    expect(
      (await setRole("staff", MON, timing("09:00", "17:00", MON_FRI, 300)))
        .status,
    ).toBe(400);
    await pg.query("update departments set active=false where id=$1", [
      dept["Operations / Other"],
    ]);
    const inactive = await setDept(
      "Operations / Other",
      MON,
      timing("09:00", "17:00", MON_FRI),
    );
    expect(inactive.status).toBe(409);
    ok(await setRole("staff", MON, timing("09:00", "17:00", MON_FRI)));
    const repeat = await setRole(
      "staff",
      MON,
      timing("09:00", "17:00", MON_FRI),
    );
    expect(repeat.status).toBe(409);
    expect(repeat.body.error).toBe(
      "This is already the staff default shift on that date",
    );
    expect(
      (
        await send(admin, "post", "/admin/attendance/shifts/roles/admin", {
          ...timing("09:00", "17:00", MON_FRI),
          expected_version: (await roleRow("staff")).version,
        })
      ).status,
    ).toBe(400);
  });
});

describe("individual timings", () => {
  it("find employees by name, UID or email and filter by role, department, source and account", async () => {
    ok(await setDept("Media", TODAY, timing("12:00", "20:00", MON_SAT)));
    ok(await setOwn(editor, TODAY, timing("14:00", "22:00", MON_SAT)));
    const page = async (query) => {
      const res = await get(
        admin,
        `/admin/attendance/shifts/employees?${query}`,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body;
    };
    expect((await page("search=bilal")).data.map((r) => r.name)).toEqual([
      "Bilal Editor",
    ]);
    const { uid } = await one("select uid from profiles where id=$1", [
      developer,
    ]);
    expect((await page(`search=${uid}`)).data.map((r) => r.id)).toEqual([
      developer,
    ]);
    expect(
      (await page("search=developer@gmail.com")).data.map((r) => r.id),
    ).toEqual([developer]);
    const editors = await page(
      `department=${dept.Media}&role=staff&account=active`,
    );
    expect(editors.data.map((r) => [r.name, r.shift.source_label])).toEqual([
      ["Ali Editor", "Individual shift"],
      ["Bilal Editor", "Media department shift"],
    ]);
    expect((await page("source=individual")).data.map((r) => r.id)).toEqual([
      editor,
    ]);
    expect((await page("account=inactive")).data.map((r) => r.id)).toEqual([
      gone,
    ]);
    expect((await page("department=none")).data.map((r) => r.name)).toEqual([
      "Owner",
      "Sara Agent",
    ]);
    const all = await page("limit=100");
    expect(all.summary).toMatchObject({ individual: 1, department: 1 });
    expect(all.data.find((r) => r.id === editor)).toMatchObject({
      uid: expect.any(Number),
      role: "staff",
      department: "Media",
      email: "editor@gmail.com",
      shift: { shift_start: "14:00", work_days: MON_SAT },
    });
    expect(
      (await get(admin, "/admin/attendance/shifts/employees?source=night"))
        .status,
    ).toBe(400);
  });
  it("assign an individual timing over the department, audited with the reason", async () => {
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
    await pg.exec("delete from notifications");
    const saved = ok(
      await setOwn(
        editor,
        MON,
        timing("14:00", "22:00", MON_SAT, 10, { reason: "Evening shoots" }),
      ),
    );
    expect(saved.shift.upcoming).toMatchObject({
      effective_from: MON,
      source: "individual",
      shift_start: "14:00",
    });
    expect(await info(editor, MON)).toMatchObject({
      source: "individual",
      label: "Individual shift",
      shift_start: "14:00",
      shift_end: "22:00",
    });
    expect(await info(editor2, MON)).toMatchObject({ shift_start: "12:00" });
    expect(await notices(editor)).toMatchObject([
      {
        body: expect.stringMatching(
          /^You have been given an individual office timing\. From .+ your office timing is 2:00 PM – 10:00 PM, Mon–Sat \(Individual shift\)\.$/,
        ),
      },
    ]);
    expect(await notices(editor2)).toEqual([]);
    const [entry] = await auditOf();
    expect(entry.title).toBe("Assigned an individual shift");
    expect(entry.description).toContain(
      "Set Ali Editor's shift to Individual shift, 2:00 PM–10:00 PM, Mon–Sat, 10 min grace from",
    );
    expect(entry.description).toContain("Reason: Evening shoots");
    expect(entry.changes[0]).toEqual({
      label: "Shift",
      before: "Media department shift, 12:00 PM–8:00 PM, Mon–Sat, 15 min grace",
      after: "Individual shift, 2:00 PM–10:00 PM, Mon–Sat, 10 min grace",
    });
    // Changing only the working days is described as such.
    ok(await setOwn(editor, TUE, timing("14:00", "22:00", MON_FRI, 10)));
    expect((await auditOf())[0].title).toBe(
      "Changed an employee's working days",
    );
  });
  it("remove an individual timing so the employee returns to their department", async () => {
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
    ok(await setOwn(editor, MON, timing("14:00", "22:00", MON_SAT)));
    const removed = ok(
      await setOwn(editor, WED, { inherit: true, reason: "Shoots finished" }),
    );
    expect(removed.shifts.map((s) => [s.effective_from, s.source])).toEqual([
      [WED, "inherit"],
      [MON, "individual"],
    ]);
    expect(await info(editor, TUE)).toMatchObject({ shift_start: "14:00" });
    expect(await info(editor, WED)).toMatchObject({
      source: "department",
      source_label: "Media department shift",
      shift_start: "12:00",
    });
    expect((await notices(editor)).at(-1).body).toMatch(
      /^Your individual office timing has been removed\. From .+ your office timing is 12:00 PM – 8:00 PM, Mon–Sat \(Media department shift\)\.$/,
    );
    const [entry] = await auditOf();
    expect(entry.title).toBe("Removed an individual shift");
    expect(entry.description).toContain(
      "Removed Ali Editor's individual shift from",
    );
    expect(entry.description).toContain(
      "they follow the Media department shift, 12:00 PM–8:00 PM, Mon–Sat, 15 min grace.",
    );
    // An employee without an individual timing has nothing to remove.
    expect((await setOwn(editor2, MON, { inherit: true })).status).toBe(409);
  });
  it("keep earlier days and records on the timing they had", async () => {
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
    await checkIn(editor, MON, "12:05");
    await checkOut(editor, MON, "20:00");
    // A later change from Tuesday, and the editor moves to Technical on
    // Wednesday (recorded as it happens).
    ok(await setDept("Media", TUE, timing("11:00", "19:00", MON_SAT)));
    ok(await setDept("Technical", MON, timing("09:00", "17:00", MON_FRI)));
    await pg.query(
      "insert into employee_group_history(user_id,effective_from,role,department_id) values($1,$2,'staff',$3)",
      [editor, WED, dept.Technical],
    );
    expect(await info(editor, MON)).toMatchObject({ shift_start: "12:00" });
    expect(await info(editor, TUE)).toMatchObject({ shift_start: "11:00" });
    expect(await info(editor, WED)).toMatchObject({
      source_label: "Technical department shift",
      shift_start: "09:00",
    });
    expect(
      await one(
        "select shift_start::text s,shift_end::text e,punctuality from attendance_records where user_id=$1 and attendance_date=$2",
        [editor, MON],
      ),
    ).toEqual({ s: "12:00:00", e: "20:00:00", punctuality: "within_grace" });
    const days = await all(
      "select day::text d,state,shift_start::text s from public.attendance_days($1,$2,$3,$4) order by day",
      [MON, WED, editor, pk(MON, "21:00")],
    );
    expect(days.map((d) => [d.d, d.state, d.s])).toEqual([
      [MON, "checked_out", "12:00:00"],
      [TUE, "upcoming", "11:00:00"],
      [WED, "upcoming", "09:00:00"],
    ]);
  });
  it("withdraw a planned change, keeping it in the history", async () => {
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
    ok(await setOwn(editor, MON, timing("14:00", "22:00", MON_SAT)));
    const withdrawn = await send(
      admin,
      "delete",
      `/admin/attendance/shifts/employees/${editor}/${MON}?version=${await versionOf(editor)}`,
    );
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect(withdrawn.body.shifts[0]).toMatchObject({
      effective_from: MON,
      withdrawn_by_name: "Owner",
      upcoming: false,
    });
    expect(await info(editor, MON)).toMatchObject({ source: "department" });
    expect((await notices(editor)).at(-1).body).toMatch(
      /^A planned change to your office timing was withdrawn\. From .+ \(Media department shift\)\.$/,
    );
    expect(
      (
        await send(
          admin,
          "delete",
          `/admin/attendance/shifts/employees/${editor}/${MON}?version=${await versionOf(editor)}`,
        )
      ).status,
    ).toBe(409);
    const dropped = await send(
      admin,
      "delete",
      `/admin/attendance/shifts/departments/${dept.Media}/${MON}?version=${(await deptRow("Media")).version}`,
    );
    expect(dropped.status).toBe(200);
    expect((await deptRow("Media")).planned).toEqual([]);
    const history = (await get(admin, "/admin/attendance/shifts/history")).body;
    expect(history.data.map((h) => [h.scope, h.target_name, h.status])).toEqual(
      [
        ["individual", "Ali Editor", "withdrawn"],
        ["department", "Media", "withdrawn"],
      ],
    );
    expect(history.data[0]).toMatchObject({ withdrawn_by_name: "Owner" });
  });
});

describe("shift history", () => {
  it("lists every version with whether it is current, planned, replaced, ended or withdrawn", async () => {
    ok(await setRole("staff", TODAY, timing("09:00", "17:00", MON_FRI)));
    ok(await setRole("staff", MON, timing("09:30", "17:30", MON_FRI)));
    ok(await setRole("staff", MON, timing("08:30", "16:30", MON_FRI)));
    ok(await setOwn(developer, TODAY, timing("12:00", "20:00", MON_FRI)));
    ok(await setOwn(developer, TODAY, timing("13:00", "21:00", MON_FRI)));
    const res = await get(admin, "/admin/attendance/shifts/history");
    expect(res.status).toBe(200);
    expect(
      res.body.data.map((h) => [
        h.scope,
        h.target_name,
        h.shift_start,
        h.status,
      ]),
    ).toEqual([
      ["individual", "Hassan Developer", "13:00", "current"],
      ["individual", "Hassan Developer", "12:00", "replaced"],
      ["role", "Staff", "08:30", "planned"],
      ["role", "Staff", "09:30", "replaced"],
      ["role", "Staff", "09:00", "current"],
    ]);
    // The newer version on the same day wins.
    expect(await info(developer, TODAY)).toMatchObject({
      shift_start: "13:00",
    });
    expect(await info(editor, MON)).toMatchObject({ shift_start: "08:30" });
    const mine = await get(
      admin,
      `/admin/attendance/shifts/history?user=${developer}&status=current`,
    );
    expect(mine.body.data.map((h) => h.shift_start)).toEqual(["13:00"]);
    expect(
      (await get(admin, "/admin/attendance/shifts/history?scope=role")).body
        .count,
    ).toBe(3);
    expect(
      (await get(admin, "/admin/attendance/shifts/history?search=hassan")).body
        .count,
    ).toBe(2);
  });
});

describe("attendance on each employee's timing", () => {
  beforeEach(async () => {
    ok(await setRole("agent", MON, timing("10:00", "18:00", MON_SAT)));
    ok(await setRole("staff", MON, timing("09:00", "17:00", MON_FRI, 10)));
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
    ok(await setOwn(editor2, MON, timing("14:00", "22:00", MON_SAT, 10)));
  });
  it("judge check-ins against the employee's own start and grace", async () => {
    expect(await checkIn(agent, MON, "10:05")).toMatchObject({
      punctuality: "within_grace",
    });
    expect(await checkIn(other, MON, "10:20")).toMatchObject({
      punctuality: "late",
      late_minutes: 20,
    });
    // The Media editor arriving at 12:05 is within grace, not two hours late.
    expect(await checkIn(editor, MON, "12:05")).toMatchObject({
      punctuality: "within_grace",
    });
    expect(await checkIn(editor2, MON, "14:10")).toMatchObject({
      punctuality: "within_grace",
    });
    expect(await checkIn(developer, MON, "08:55")).toMatchObject({
      punctuality: "on_time",
    });
    expect(await checkIn(editor, TUE, "12:20")).toMatchObject({
      punctuality: "late",
      late_minutes: 20,
    });
    // One minute past the 10-minute grace is late.
    expect(await checkIn(editor2, TUE, "14:11")).toMatchObject({
      punctuality: "late",
      late_minutes: 11,
    });
  });
  it("judge check-outs against the employee's own end", async () => {
    await checkIn(editor, MON, "12:00");
    expect(await checkOut(editor, MON, "18:00")).toMatchObject({
      early_departure_minutes: 120,
    });
    await checkIn(editor, TUE, "12:00");
    expect(await checkOut(editor, TUE, "20:00")).toMatchObject({
      early_departure_minutes: 0,
      state: "checked_out",
    });
    await checkIn(developer, MON, "09:00");
    expect(await checkOut(developer, MON, "17:00")).toMatchObject({
      early_departure_minutes: 0,
    });
  });
  it("use each employee's working days, holidays and leave", async () => {
    await pg.query(
      "insert into attendance_holidays(holiday_date,name) values($1,'Company holiday')",
      [WED],
    );
    await pg.query(
      "insert into attendance_leave_requests(user_id,leave_type,start_date,end_date,reason,status,reviewer_id,reviewed_at) values($1,'casual',$2,$2,'Wedding','approved',$3,now())",
      [editor, TUE, admin],
    );
    const states = async (user) =>
      Object.fromEntries(
        (
          await all(
            "select day::text d,state,scheduled from public.attendance_days($1,$2,$3,$4)",
            [MON, await plus(MON, 6), user, pk(NEXT_MON, "09:00")],
          )
        ).map((d) => [d.d, d.state]),
      );
    const media = await states(editor),
      tech = await states(developer);
    // Saturday is a working day for Media and a day off on the staff default.
    expect(media[SAT]).toBe("absent");
    expect(tech[SAT]).toBe("day_off");
    expect(media[WED]).toBe("holiday");
    expect(tech[WED]).toBe("holiday");
    expect(media[TUE]).toBe("leave");
    expect(tech[TUE]).toBe("absent");
    expect((await fails(checkIn(developer, SAT, "09:00"))).message).toBe(
      "Today is a scheduled day off. No check-in is needed.",
    );
    expect((await fails(checkIn(editor, WED, "12:00"))).message).toContain(
      "company holiday",
    );
    expect((await fails(checkIn(editor, TUE, "12:00"))).message).toBe(
      "You are on approved leave today. Ask an administrator if you need to work.",
    );
    // A later Media change leaves the leave request as it was.
    ok(await setDept("Media", TUE, timing("11:00", "19:00", MON_FRI)));
    expect(
      await one(
        "select start_date::text s,end_date::text e,status from attendance_leave_requests where user_id=$1",
        [editor],
      ),
    ).toEqual({ s: TUE, e: TUE, status: "approved" });
    const totals = await one(
      "select row_to_json(t) r from public.attendance_totals($1,$2,$3,$4) t",
      [MON, await plus(MON, 6), developer, pk(NEXT_MON, "09:00")],
    );
    // Monday to Friday are working days (Wednesday a holiday); Saturday and
    // Sunday are days off, not absences.
    expect(totals.r).toMatchObject({ scheduled_days: 5, absent_days: 4 });
  });
  it("record historical entries and half days on the timing of that day", async () => {
    const entered = await sql(
      "select public.attendance_admin_set_at($1,$2,$3::jsonb,'Office records',false,false,'t',$4) r",
      [
        admin,
        editor,
        JSON.stringify([
          {
            date: MON,
            status: "present",
            check_in: "12:10",
            check_out: "20:00",
          },
          {
            date: TUE,
            status: "half_day",
            check_in: "12:00",
            check_out: "16:00",
          },
        ]),
        pk(WED, "10:00"),
      ],
    );
    expect(entered.results.map((r) => r.result)).not.toContain("error");
    const rows = await all(
      "select attendance_date::text d,shift_start::text s,punctuality,early_departure_minutes e from attendance_records where user_id=$1 order by attendance_date",
      [editor],
    );
    expect(rows).toEqual([
      { d: MON, s: "12:00:00", punctuality: "within_grace", e: 0 },
      { d: TUE, s: "12:00:00", punctuality: "on_time", e: 240 },
    ]);
    // A half day must end before the editor's 8:00 PM shift end.
    const full = await sql(
      "select public.attendance_admin_set_at($1,$2,$3::jsonb,'Office records',false,false,'t',$4) r",
      [
        admin,
        editor2,
        JSON.stringify([
          {
            date: MON,
            status: "half_day",
            check_in: "14:00",
            check_out: "22:00",
          },
        ]),
        pk(WED, "10:00"),
      ],
    );
    expect(full.results[0]).toMatchObject({
      result: "error",
      message: "A half day ends before the shift ends at 22:00",
    });
  });
  it("show the timing and where it comes from in reports and to the employee", async () => {
    await checkIn(editor, MON, "12:30");
    const daily = await sql(
      "select public.attendance_daily($1,$2,null,'staff',null,null,null,1,50) r",
      [admin, MON],
    );
    expect(
      daily.data
        .filter((r) => r.state !== "not_tracked")
        .map((r) => [r.name, r.punctuality, r.shift_start]),
    ).toEqual([
      ["Ali Editor", "late", "12:00:00"],
      ["Bilal Editor", null, "14:00:00"],
      ["Hassan Developer", null, "09:00:00"],
    ]);
    const mine = await get(editor, "/profile");
    expect(mine.status).toBe(200);
    expect(mine.body.shift).toMatchObject({
      source: "company",
      upcoming: {
        effective_from: MON,
        source_label: "Media department shift",
        shift_start: "12:00",
      },
    });
    const me = await get(editor2, "/attendance/me");
    expect(me.status).toBe(200);
    expect(me.body.policy).toMatchObject({
      source: "company",
      source_label: "Company default shift",
      assigned: false,
      upcoming: { source_label: "Individual shift", shift_start: "14:00" },
    });
    const people = await get(
      admin,
      "/admin/employees?role=staff&account=active",
    );
    expect(
      people.body.data.map((p) => [p.name, p.shift.upcoming?.source_label]),
    ).toEqual([
      ["Ali Editor", "Media department shift"],
      ["Bilal Editor", "Individual shift"],
      ["Hassan Developer", "Staff default shift"],
    ]);
  });
});

describe("task checkout on each employee's timing", () => {
  const create = (data) =>
    sql("select public.task_create_at($1,$2::jsonb,'t',$3) r", [
      admin,
      JSON.stringify({
        client_key: randomUUID(),
        task_date: MON,
        scope: "individual",
        assignees: [editor],
        title: "Edit the DHA video",
        kind: "simple",
        ...data,
      }),
      pk(MON, "09:00"),
    ]);
  const progress = (user, id, at) =>
    sql("select public.task_progress_at($1,$2,$3::jsonb,'t',$4) r", [
      user,
      id,
      JSON.stringify({ status: "completed" }),
      at,
    ]);
  const report = (user, at) =>
    sql(
      "select public.task_report_submit_at($1,$2,'Done for today',false,'t',$3) r",
      [user, MON, at],
    );
  const ask = (user, kind, at, reason = "Need to leave") =>
    sql("select public.task_checkout_request_at($1,$2,$3,'t',$4) r", [
      user,
      kind,
      reason,
      at,
    ]);
  const decide = (id, at, waive = false) =>
    sql(
      "select public.task_checkout_decide_at($1,$2,'approve',null,$3,'t',$4) r",
      [admin, id, waive, at],
    );
  const state = (user, at) =>
    sql("select public.task_checkout_state_at($1,$2) r", [user, at]);
  beforeEach(async () => {
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
  });
  it("stay off unless an administrator turns them on", async () => {
    await checkIn(editor, MON, "12:00");
    expect(await state(editor, pk(MON, "15:00"))).toMatchObject({
      required: false,
      shift_end: "20:00",
    });
    expect(await checkOut(editor, MON, "15:00")).toMatchObject({
      state: "checked_out",
    });
  });
  it("allow the normal checkout at the employee's own shift end, with the report", async () => {
    await pg.query("update crm_settings set task_rules_from=$1", [MON]);
    await create({});
    await checkIn(editor, MON, "12:00");
    // 6:00 PM is the company end, but two hours early for the Media shift.
    expect(await state(editor, pk(MON, "18:00"))).toMatchObject({
      required: true,
      shift_end: "20:00",
      before_shift_end: true,
    });
    expect((await fails(checkOut(editor, MON, "18:00"))).message).toBe(
      "Checking out before your shift ends at 8:00 PM needs an approved early or emergency checkout request.",
    );
    expect((await fails(checkOut(editor, MON, "20:00"))).message).toBe(
      "Please submit your daily work report before checking out.",
    );
    await report(editor, pk(MON, "19:50"));
    // Unfinished tasks don't block the normal checkout.
    expect(await checkOut(editor, MON, "20:00")).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 0,
    });
  });
  it("allow an approved early checkout before the employee's shift end, rechecked when used", async () => {
    await pg.query("update crm_settings set task_rules_from=$1", [MON]);
    const t = await create({});
    await checkIn(editor, MON, "12:00");
    expect((await state(editor, pk(MON, "17:00"))).early_blockers).toContain(
      "Complete every task due today first (0 of 1 done).",
    );
    await progress(editor, t.assignments[0].id, pk(MON, "16:30"));
    await report(editor, pk(MON, "16:40"));
    const req = await ask(editor, "early", pk(MON, "17:00"));
    await decide(req.id, pk(MON, "17:05"));
    // The Media shift changes from the same day after the approval: the day
    // keeps the shift it was checked in with (ends 8:00 PM), so the approval
    // is still what allows leaving at 7:00 PM.
    ok(await setDept("Media", MON, timing("10:00", "18:00", MON_SAT)));
    expect(await state(editor, pk(MON, "19:00"))).toMatchObject({
      shift_end: "20:00",
      before_shift_end: true,
    });
    expect(await checkOut(editor, MON, "19:00")).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 60,
    });
  });
  it("allow an emergency checkout and the no-tasks report", async () => {
    await pg.query("update crm_settings set task_rules_from=$1", [MON]);
    await checkIn(editor2, MON, "12:00");
    expect(await report(editor2, pk(MON, "13:00"))).toMatchObject({
      task_count: 0,
    });
    expect(await state(editor2, pk(MON, "13:30"))).toMatchObject({
      shift_end: "20:00",
      can_request_early: false,
      can_request_emergency: true,
    });
    const req = await ask(
      editor2,
      "emergency",
      pk(MON, "14:00"),
      "Family emergency",
    );
    await decide(req.id, pk(MON, "14:05"));
    // Approval allows the check-out; it doesn't check anyone out.
    expect(
      (
        await one("select state from attendance_records where user_id=$1", [
          editor2,
        ])
      ).state,
    ).toBe("checked_in");
    expect(await checkOut(editor2, MON, "14:10")).toMatchObject({
      state: "checked_out",
      early_departure_minutes: 350,
    });
  });
});

describe("shift management access", () => {
  it("is refused to agents and staff through every endpoint", async () => {
    const paths = [
      ["get", "/admin/attendance/shifts"],
      ["get", "/admin/attendance/shifts/employees"],
      ["get", `/admin/attendance/shifts/employees/${editor}`],
      ["get", "/admin/attendance/shifts/history"],
      ["post", "/admin/attendance/shifts/roles/agent"],
      ["post", `/admin/attendance/shifts/departments/${dept.Media}`],
      ["post", `/admin/attendance/shifts/employees/${agent}`],
      ["post", `/admin/attendance/shifts/employees/${editor}`],
      ["delete", `/admin/attendance/shifts/roles/staff/${MON}`],
      ["delete", `/admin/attendance/shifts/departments/${dept.Media}/${MON}`],
      ["delete", `/admin/attendance/shifts/employees/${editor}/${MON}`],
      ["post", `/admin/employees/${editor}/shifts`],
      ["get", `/admin/employees/${editor}`],
    ];
    const body = {
      ...timing("06:00", "14:00", MON_SAT),
      effective_from: MON,
      expected_version: "0".repeat(32),
    };
    for (const [method, path] of paths)
      for (const user of [agent, editor]) {
        const res = await send(user, method, path, body);
        expect(res.status, `${user} ${method} ${path}`).toBe(403);
      }
    expect(await all("select id from shift_schedules")).toEqual([]);
    expect(await all("select id from employee_shifts")).toEqual([]);
  });
  it("is checked again by the database", async () => {
    for (const [text, args] of [
      ["select public.shift_overview($1) r", [agent]],
      [
        "select public.shift_default_save($1,'role','agent',$2::jsonb,'t') r",
        [editor, JSON.stringify(timing("06:00", "14:00", MON_SAT))],
      ],
      [
        "select public.employee_shift_save($1,$1,$2::jsonb,'t') r",
        [agent, JSON.stringify(timing("06:00", "14:00", MON_SAT))],
      ],
      ["select public.shift_history_page($1,'{}',1,20) r", [editor]],
      ["select public.shift_employees_page($1,'{}',1,20) r", [agent]],
      [
        "select public.shift_default_cancel($1,'role','staff',$2,$3,'t') r",
        [editor, MON, "0".repeat(32)],
      ],
    ])
      expect((await fails(sql(text, args))).code, text).toBe("HA403");
  });
  it("shows employees only their own timing", async () => {
    ok(await setOwn(editor2, MON, timing("14:00", "22:00", MON_SAT)));
    const mine = await get(editor, "/profile");
    expect(JSON.stringify(mine.body)).not.toContain("14:00");
    const me = await get(editor, "/attendance/me");
    expect(me.body.employee.id).toBe(editor);
    expect(JSON.stringify(me.body)).not.toContain("Bilal");
  });
  it("reads through functions the API can run", async () => {
    // The API runs stable functions in a read-only transaction, and the
    // administrator check locks the actor's profile row: every function the
    // API calls must be volatile.
    const rows = await all(
      "select proname,provolatile from pg_proc where pronamespace='public'::regnamespace and proname = any($1)",
      [
        [
          "shift_overview",
          "shift_employees_page",
          "shift_history_page",
          "shift_default_save",
          "shift_default_cancel",
          "employee_shift_save",
          "employee_shift_cancel",
          "employee_detail",
          "attendance_me",
        ],
      ],
    );
    expect(rows).toHaveLength(9);
    expect(rows.filter((r) => r.provolatile !== "v")).toEqual([]);
  });
  it("gives browser roles nothing new", async () => {
    const tables = await all(
      "select relname,relrowsecurity from pg_class where relname in ('shift_schedules','employee_group_history') order by relname",
    );
    expect(tables.map((t) => t.relrowsecurity)).toEqual([true, true]);
    expect(
      (
        await one(
          "select count(*)::int n from information_schema.role_table_grants where table_name in ('shift_schedules','employee_group_history','employee_shifts') and grantee in ('anon','authenticated')",
        )
      ).n,
    ).toBe(0);
    const fns = await all(
      "select p.proname,has_function_privilege('anon',p.oid,'execute') anon,has_function_privilege('authenticated',p.oid,'execute') browser,has_function_privilege('service_role',p.oid,'execute') api from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in ('shift_default_save','shift_default_cancel','shift_overview','shift_employees_page','shift_history_page','employee_shift_save','employee_shift_cancel','employee_detail','attendance_me','track_employee_group','work_days_text','shift_hours_text','employee_schedule_rule','attendance_shift_apply','employee_shift_info','shift_signature','shift_summary','shift_notify','shift_parse','shift_schedule_json','shift_default_at','shift_group_members','shift_version','shift_target_json')",
    );
    expect(fns).toHaveLength(24);
    expect(fns.filter((f) => f.anon || f.browser)).toEqual([]);
    expect(
      fns
        .filter((f) => f.api)
        .map((f) => f.proname)
        .sort(),
    ).toEqual([
      "attendance_me",
      "employee_detail",
      "employee_shift_cancel",
      "employee_shift_save",
      "shift_default_cancel",
      "shift_default_save",
      "shift_employees_page",
      "shift_history_page",
      "shift_overview",
    ]);
  });
});

describe("simultaneous and repeated changes", () => {
  it("refuse a save made from an older view instead of overwriting the newer one", async () => {
    const { version } = await roleRow("staff");
    const first = await send(
      admin,
      "post",
      "/admin/attendance/shifts/roles/staff",
      {
        effective_from: MON,
        expected_version: version,
        ...timing("09:00", "17:00", MON_FRI),
      },
    );
    expect(first.status).toBe(200);
    const second = await send(
      admin,
      "post",
      "/admin/attendance/shifts/roles/staff",
      {
        effective_from: MON,
        expected_version: version,
        ...timing("08:00", "16:00", MON_FRI),
      },
    );
    expect(second.status).toBe(409);
    expect(second.body.error).toBe(
      "This shift was changed a moment ago. Reload to see the latest before saving.",
    );
    expect(await info(developer, MON)).toMatchObject({ shift_start: "09:00" });
    // Two saves sent together from the same view: one version, one notice each.
    const v = await versionOf(editor);
    const both = await Promise.all(
      [0, 1].map(() =>
        send(admin, "post", `/admin/attendance/shifts/employees/${editor}`, {
          effective_from: MON,
          expected_version: v,
          ...timing("14:00", "22:00", MON_SAT),
        }),
      ),
    );
    expect(both.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      (
        await one(
          "select count(*)::int n from employee_shifts where user_id=$1",
          [editor],
        )
      ).n,
    ).toBe(1);
    expect(await notices(editor)).toHaveLength(2);
    // A save without the version it started from is refused.
    expect(
      (
        await send(
          admin,
          "post",
          `/admin/attendance/shifts/employees/${editor}`,
          {
            effective_from: TUE,
            ...timing("15:00", "23:00", MON_SAT),
          },
        )
      ).status,
    ).toBe(400);
  });
  it("make department-wide changes all at once and never notify twice", async () => {
    const res = await setDept("Media", MON, timing("12:00", "20:00", MON_SAT));
    ok(res);
    const keys = await all(
      "select user_id,count(*)::int n from notifications where type='shift_changed' group by user_id",
    );
    expect(keys.map((k) => k.n)).toEqual([1, 1]);
    // Notifying the same change again adds nothing.
    const { id } = await one(
      "select id from shift_schedules where department_id=$1",
      [dept.Media],
    );
    await pg.query("select public.shift_notify($1::jsonb,$2,$3,'Again.')", [
      JSON.stringify({ [editor]: "changed" }),
      MON,
      "shift:" + id,
    ]);
    expect(await notices(editor)).toHaveLength(1);
  });
  it("let only one of two administrators editing the same timing at once win", async () => {
    const second = "48000000-0000-4000-8000-000000000008";
    await pg.query(
      "insert into auth.users(id,email,email_confirmed_at) values($1,'second.admin@gmail.com',now())",
      [second],
    );
    await pg.query(
      "update profiles set active=true,role='admin',name='Second Admin' where id=$1",
      [second],
    );
    const { version } = await deptRow("Media");
    const path = `/admin/attendance/shifts/departments/${dept.Media}`;
    const results = await Promise.all([
      send(admin, "post", path, {
        effective_from: MON,
        expected_version: version,
        ...timing("12:00", "20:00", MON_SAT),
      }),
      send(second, "post", path, {
        effective_from: MON,
        expected_version: version,
        ...timing("11:00", "19:00", MON_SAT),
      }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const loser = results.find((r) => r.status === 409);
    expect(loser.body.error).toBe(
      "This shift was changed a moment ago. Reload to see the latest before saving.",
    );
    // One version, one audit entry, one notice per affected employee, and
    // the winner's timing is the one in effect.
    const winner = results[0].status === 200 ? "12:00" : "11:00";
    expect(
      (
        await one(
          "select count(*)::int n from shift_schedules where department_id=$1",
          [dept.Media],
        )
      ).n,
    ).toBe(1);
    expect(
      (
        await one(
          "select count(*)::int n from audit_log where action='shift.default_changed'",
        )
      ).n,
    ).toBe(1);
    expect(await notices(editor)).toHaveLength(1);
    expect(await notices(editor2)).toHaveLength(1);
    expect(await info(editor2, MON)).toMatchObject({ shift_start: winner });
    // The second administrator reloads, sees the winner's timing and can
    // then change it.
    const fresh = await deptRow("Media");
    expect(fresh.planned[0].shift_start).toBe(winner);
    expect(
      (
        await send(second, "post", path, {
          effective_from: MON,
          expected_version: fresh.version,
          ...timing("10:30", "18:30", MON_SAT),
        })
      ).status,
    ).toBe(200);
  });
  it("refuse a withdrawal made from an older view, keeping the newer change", async () => {
    ok(await setOwn(editor, MON, timing("14:00", "22:00", MON_SAT)));
    const seen = await versionOf(editor);
    // Someone else replaces the planned change before the withdrawal.
    ok(await setOwn(editor, MON, timing("15:00", "23:00", MON_SAT)));
    const stale = await send(
      admin,
      "delete",
      `/admin/attendance/shifts/employees/${editor}/${MON}?version=${seen}`,
    );
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe(
      "This employee's shift was changed a moment ago. Reload to see the latest before withdrawing.",
    );
    expect(await info(editor, MON)).toMatchObject({ shift_start: "15:00" });
    expect(
      (
        await one(
          "select count(*)::int n from employee_shifts where user_id=$1 and withdrawn_at is not null",
          [editor],
        )
      ).n,
    ).toBe(0);
    // The same for a department.
    ok(await setDept("Media", MON, timing("12:00", "20:00", MON_SAT)));
    const old = (await deptRow("Media")).version;
    ok(await setDept("Media", MON, timing("11:00", "19:00", MON_SAT)));
    expect(
      (
        await send(
          admin,
          "delete",
          `/admin/attendance/shifts/departments/${dept.Media}/${MON}?version=${old}`,
        )
      ).status,
    ).toBe(409);
    expect((await deptRow("Media")).planned).toMatchObject([
      { shift_start: "11:00" },
    ]);
  });
});

describe("the retired 047 shift routes", () => {
  const body = {
    effective_from: null,
    label: "Late tech shift",
    ...timing("12:00", "20:00", MON_FRI, 10),
  };
  it("no longer change shifts for anyone, so nothing bypasses Shift management", async () => {
    const before = await one(
      "select (select count(*) from employee_shifts)::int s,(select count(*) from audit_log)::int a,(select count(*) from notifications)::int n",
    );
    const legacy = [
      [
        "post",
        `/admin/employees/${developer}/shifts`,
        { ...body, effective_from: MON },
      ],
      [
        "post",
        `/admin/employees/${developer}/shifts`,
        { effective_from: MON, follows_company: true },
      ],
      ["delete", `/admin/employees/${developer}/shifts/${MON}`],
    ];
    for (const [method, path, data] of legacy) {
      expect((await send(admin, method, path, data)).status, path).toBe(404);
      for (const user of [agent, editor])
        expect((await send(user, method, path, data)).status, path).toBe(403);
    }
    expect(
      await one(
        "select (select count(*) from employee_shifts)::int s,(select count(*) from audit_log)::int a,(select count(*) from notifications)::int n",
      ),
    ).toEqual(before);
    // Employee details still load, with the timing and where it comes from.
    const detail = await get(admin, `/admin/employees/${developer}`);
    expect(detail.status).toBe(200);
    expect(detail.body.shift).toMatchObject({ source: "company" });
    // The 047 withdrawal function without a version is gone.
    expect(
      await one(
        "select to_regprocedure('public.employee_shift_cancel(uuid,uuid,date,text)') old_cancel,to_regprocedure('public.shift_default_cancel(uuid,text,text,date,text)') old_default",
      ),
    ).toEqual({ old_cancel: null, old_default: null });
  });
  it("leave no database call that skips the version check", async () => {
    const plain = JSON.stringify({ ...body, effective_from: MON });
    for (const [text, args] of [
      [
        "select public.employee_shift_save($1,$2,$3::jsonb,'t') r",
        [admin, developer, plain],
      ],
      [
        "select public.shift_default_save($1,'department',$2,$3::jsonb,'t') r",
        [admin, dept.Media, JSON.stringify(timing("12:00", "20:00", MON_SAT))],
      ],
      [
        "select public.employee_shift_cancel($1,$2,$3,null,'t') r",
        [admin, developer, MON],
      ],
      [
        "select public.shift_default_cancel($1,'role','staff',$2,null,'t') r",
        [admin, MON],
      ],
    ]) {
      const e = await fails(sql(text, args));
      expect(e.code, text).toBe("HA400");
      expect(e.message, text).toBe(
        "Make this change in Shift management, which checks you are editing the latest timing",
      );
    }
    // Withdrawals through the API need the version too.
    ok(await setOwn(developer, MON, timing("12:00", "20:00", MON_FRI)));
    expect(
      (
        await send(
          admin,
          "delete",
          `/admin/attendance/shifts/employees/${developer}/${MON}`,
        )
      ).status,
    ).toBe(400);
    expect(await info(developer, MON)).toMatchObject({ source: "individual" });
  });
});
