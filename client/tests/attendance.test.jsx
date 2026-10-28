import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import { clockLabel, minutesLabel, pkMoment } from "../src/lib/attendance";
import { dayLabel } from "../src/lib/calendar";
import {
  monthGrid,
  monthTotals,
  todaySummary,
  weekSeries,
  workDayRange,
} from "../src/lib/attendanceDashboard";
// Update 040 screens: My attendance, the admin register, reports, requests
// and settings. All numbers come from mocked server responses.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null, me: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = {
  id: "e1000000-0000-4000-8000-000000000001",
  uid: 674892,
  name: "Owner",
  role: "admin",
  active: true,
};
const ali = {
  id: "e1000000-0000-4000-8000-000000000002",
  uid: 775610,
  name: "Ali Agent",
  role: "agent",
  active: true,
};
const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const policy = {
  name: "HD Marketing standard",
  shift_start: "10:00",
  shift_end: "18:00",
  work_days: [1, 2, 3, 4, 5, 6],
  grace_minutes: 15,
};
const day = (state, extra = {}) => ({
  day: today,
  state,
  scheduled: true,
  holiday: null,
  leave_type: null,
  ...extra,
});
const me = (todayRow, extra = {}) => ({
  server_now: new Date().toISOString(),
  date: today,
  employee: { id: ali.id, name: "Ali Agent", uid: 775610, role: "agent" },
  policy,
  today: todayRow,
  month: {
    attendance_percent: 92.3,
    present_days: 12,
    absent_days: 1,
    late_days: 2,
    leave_days: 0,
    incomplete_days: 0,
    worked_minutes: 5400,
    overtime_minutes: 30,
  },
  recent: [todayRow],
  incomplete: [],
  pending_leave: 0,
  pending_corrections: 0,
  ...extra,
});
const posted = (path) =>
  mocks.api.mock.calls
    .filter(([p, o]) => p === path && o?.method === "POST")
    .map(([, o]) => o.body);
const calls = (prefix) =>
  mocks.api.mock.calls.filter(([p]) => p.startsWith(prefix)).map(([p]) => p);
function open(path) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  mocks.user = { ...ali };
  mocks.me = me(day("not_checked_in"));
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/attendance/me") return mocks.me;
    if (path === "/attendance/check-in") {
      const record = {
        check_in_at: new Date(Date.now() - 125 * 60000).toISOString(),
        punctuality: "within_grace",
        late_minutes: 12,
      };
      mocks.me = me(day("checked_in", { ...record, record_id: "r1" }));
      return record;
    }
    if (path === "/attendance/check-out") {
      mocks.me = me(day("checked_out", { worked_minutes: 470 }));
      return { check_out_at: new Date().toISOString(), worked_minutes: 470 };
    }
    if (
      path.startsWith("/attendance/leave") ||
      path.startsWith("/attendance/corrections")
    )
      return options?.method === "POST" ? { id: "x" } : { data: [], count: 0 };
    if (path === "/notifications") return { data: [], unread: 0 };
    if (path === "/users") return [admin, ali];
    if (path === "/admin/attendance/overview")
      return {
        date: today,
        is_workday: true,
        shift_start: "10:00",
        shift_end: "18:00",
        grace_minutes: 15,
        employees: { active: 3, agents: 2, admins: 1 },
        states: { checked_in: 1, absent: 1, not_checked_in: 1 },
        punctuality: { late: 1 },
        incomplete_30_days: 2,
        pending_leave: 1,
        pending_corrections: 0,
        on_leave_today: 0,
      };
    if (path.startsWith("/admin/attendance/daily"))
      return {
        date: today,
        count: 2,
        data: [
          {
            user_id: ali.id,
            name: "Ali Agent",
            uid: 775610,
            role: "agent",
            account_active: true,
            day: today,
            state: "checked_in",
            punctuality: "late",
            late_minutes: 25,
            check_in_at: new Date().toISOString(),
            shift_start: "10:00:00",
            shift_end: "18:00:00",
          },
          {
            user_id: "e1000000-0000-4000-8000-000000000003",
            name: "Sara Agent",
            uid: 876679,
            role: "agent",
            account_active: true,
            day: today,
            state: "absent",
            shift_start: "10:00:00",
            shift_end: "18:00:00",
          },
        ],
        summary: {
          total: 2,
          states: { checked_in: 1, absent: 1 },
          punctuality: { late: 1 },
        },
      };
    if (
      path.startsWith("/admin/attendance/weekly") ||
      path.startsWith("/admin/attendance/monthly")
    ) {
      const states = [
        "checked_out",
        "checked_out",
        "absent",
        "leave",
        "incomplete",
        "checked_out",
        "day_off",
      ];
      return {
        employees: [
          {
            user_id: ali.id,
            name: "Ali Agent",
            uid: 775610,
            role: "agent",
            active: true,
            scheduled_days: 6,
            eligible_days: 5,
            present_days: 3,
            absent_days: 1,
            leave_days: 1,
            holiday_days: 0,
            incomplete_days: 1,
            on_time_days: 2,
            within_grace_days: 0,
            late_days: 1,
            completed_days: 3,
            worked_minutes: 1440,
            early_departure_minutes: 20,
            overtime_minutes: 0,
            attendance_percent: 60,
            days: states.map((state, i) => ({
              date: `2026-10-${19 + i}`,
              state,
              punctuality: i === 1 ? "late" : null,
            })),
          },
        ],
        trend: states.map((state, i) => ({
          date: `2026-10-${19 + i}`,
          present: state === "checked_out" ? 1 : 0,
          late: 0,
          absent: state === "absent" ? 1 : 0,
          leave: 0,
          incomplete: 0,
        })),
      };
    }
    if (path.startsWith("/admin/attendance/leave"))
      return path.includes("/review")
        ? { status: "approved" }
        : {
            count: 2,
            data: [
              {
                id: "l1",
                user_id: ali.id,
                employee_name: "Ali Agent",
                employee_uid: 775610,
                employee_role: "agent",
                leave_type: "sick",
                start_date: today,
                end_date: today,
                reason: "Fever",
                status: "pending",
                created_at: new Date().toISOString(),
              },
              {
                id: "l2",
                user_id: admin.id,
                employee_name: "Owner",
                employee_role: "admin",
                leave_type: "casual",
                start_date: today,
                end_date: today,
                reason: "Errand",
                status: "pending",
                created_at: new Date().toISOString(),
              },
            ],
          };
    if (path === "/admin/attendance/settings" && options?.method === "PATCH")
      return { id: "p2" };
    if (path === "/admin/attendance/settings")
      return {
        today,
        tracking_started: "2026-10-19",
        current: {
          ...policy,
          shift_start: "10:00:00",
          shift_end: "18:00:00",
          effective_from: "2026-10-19",
        },
        versions: [
          {
            id: "p1",
            ...policy,
            shift_start: "10:00:00",
            shift_end: "18:00:00",
            effective_from: "2026-10-19",
            effective_to: null,
            records: 4,
            updated_at: new Date().toISOString(),
          },
        ],
      };
    if (path.startsWith("/admin/attendance/employees/"))
      return {
        employee: {
          id: ali.id,
          name: "Ali Agent",
          uid: 775610,
          role: "agent",
          active: true,
          periods: [],
        },
        totals: {
          attendance_percent: 90,
          present_days: 9,
          late_days: 2,
          absent_days: 1,
        },
        days: [
          {
            day: today,
            state: "checked_in",
            check_in_at: new Date().toISOString(),
            punctuality: "late",
            late_minutes: 25,
          },
        ],
        leave: [],
        corrections: [],
      };
    if (path === "/admin/attendance/employees") return [ali];
    if (path.startsWith("/admin/attendance/export")) return new Blob(["x"]);
    return { data: [], count: 0 };
  });
});

describe("formatting", () => {
  it("formats shift times, durations and Pakistan moments", () => {
    expect(clockLabel("10:00")).toBe("10:00 AM");
    expect(clockLabel("18:00")).toBe("6:00 PM");
    expect(minutesLabel(470)).toBe("7 h 50 min");
    expect(minutesLabel(45)).toBe("45 min");
    expect(pkMoment("2026-10-19", "18:30")).toBe("2026-10-19T18:30:00+05:00");
  });
});

describe("command center figures", () => {
  it("keeps states separate from punctuality", () => {
    const summary = todaySummary({
      states: {
        checked_in: 2,
        checked_out: 3,
        not_checked_in: 1,
        absent: 1,
        leave: 2,
        day_off: 4,
      },
      punctuality: { on_time: 3, within_grace: 1, late: 1 },
    });
    expect(summary).toMatchObject({
      expected: 7,
      recorded: 5,
      scheduled: 9,
      working: 2,
      completed: 3,
      waiting: 1,
      absent: 1,
      leave: 2,
      late: 1,
    });
    // Punctuality is never added to the state totals.
    expect(summary.expected).toBe(2 + 3 + 1 + 1);
  });
  it("describes working days and groups week and month data without inventing days", () => {
    expect(workDayRange([1, 2, 3, 4, 5, 6])).toBe("Monday–Saturday");
    expect(workDayRange([1, 3, 5])).toBe("Mon, Wed, Fri");
    const week = weekSeries(
      [
        {
          date: "2026-10-24",
          present: 2,
          late: 1,
          absent: 1,
          leave: 0,
          incomplete: 0,
        },
        {
          date: "2026-10-25",
          present: 0,
          late: 0,
          absent: 0,
          leave: 0,
          incomplete: 0,
        },
        {
          date: "2026-10-26",
          present: 0,
          late: 0,
          absent: 0,
          leave: 0,
          incomplete: 0,
        },
      ],
      [1, 2, 3, 4, 5, 6],
      "2026-10-25",
    );
    expect(week.map((d) => [d.dayOff, d.upcoming, d.total])).toEqual([
      [false, false, 3],
      [true, false, 0],
      [false, true, 0],
    ]);
    expect(
      monthTotals([
        { present_days: 9, eligible_days: 10, absent_days: 1, late_days: 2 },
        { present_days: 3, eligible_days: 5, absent_days: 2, late_days: 0 },
      ]),
    ).toMatchObject({
      present: 12,
      eligible: 15,
      absent: 3,
      late: 2,
      percent: 80,
    });
    expect(monthTotals([]).percent).toBeNull();
    const grid = monthGrid("2026-10", []);
    // October 2026 starts on a Thursday: three blank cells, then 31 days.
    expect(grid.filter((c) => !c.date)).toHaveLength(3);
    expect(grid.filter((c) => c.date)).toHaveLength(31);
  });
});

describe("My attendance", () => {
  it("checks in, shows the running time and checks out after confirming", async () => {
    open("/attendance");
    const card = (
      await screen.findByRole("heading", { level: 2, name: /^\w+day,/ })
    ).closest("section");
    expect(
      within(card).getByText(
        "Shift 10:00 AM – 6:00 PM · 15 min grace · Mon, Tue, Wed, Thu, Fri, Sat",
      ),
    ).toBeInTheDocument();
    expect(within(card).getByText("Not checked in")).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: /Check out/ }),
    ).toBeDisabled();
    fireEvent.click(within(card).getByRole("button", { name: /Check in/ }));
    expect(
      await screen.findByText(/Checked in at .* · within grace/),
    ).toBeInTheDocument();
    expect(posted("/attendance/check-in")).toEqual([{}]);
    expect(
      await within(card).findByText("2 h 5 min so far"),
    ).toBeInTheDocument();
    expect(within(card).getByText("Within grace")).toBeInTheDocument();
    fireEvent.click(within(card).getByRole("button", { name: /Check out/ }));
    const dialog = await screen.findByRole("dialog", {
      name: "Check out now?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Keep working" }),
    );
    expect(posted("/attendance/check-out")).toEqual([]);
    fireEvent.click(within(card).getByRole("button", { name: /Check out/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Check out",
      }),
    );
    expect(
      await screen.findByText(/Checked out at .* · 7 h 50 min worked/),
    ).toBeInTheDocument();
    expect(await within(card).findByText("Checked out")).toBeInTheDocument();
  });
  it("disables check-in on a day off and shows the monthly summary", async () => {
    mocks.me = me(day("day_off", { scheduled: false }));
    open("/attendance");
    expect(
      await screen.findByText("Today is a scheduled day off."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Check in/ })).toBeDisabled();
    expect(screen.getByText("92.3%")).toBeInTheDocument();
    expect(screen.getByText("90 h")).toBeInTheDocument();
  });
  it("offers a correction for a missing check-out with the right times", async () => {
    mocks.me = me(day("not_checked_in"), {
      incomplete: [
        {
          date: "2026-10-17",
          check_in_at: "2026-10-17T05:05:00Z",
          pending_correction: false,
        },
      ],
    });
    open("/attendance");
    const alert = await screen.findByText("Check-out missing");
    fireEvent.click(
      within(alert.closest("section")).getByRole("button", {
        name: "Request correction",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Request an attendance correction",
    });
    expect(within(dialog).getByLabelText("Date")).toHaveValue("2026-10-17");
    fireEvent.change(within(dialog).getByLabelText(/Time you finished/), {
      target: { value: "18:20" },
    });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Forgot to check out" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send request" }),
    );
    await screen.findByText("Correction request sent for review");
    expect(posted("/attendance/corrections")).toEqual([
      {
        attendance_date: "2026-10-17",
        correction_type: "missing_check_out",
        requested_check_out_at: "2026-10-17T18:20:00+05:00",
        reason: "Forgot to check out",
      },
    ]);
  });
  it("validates and sends a leave request", async () => {
    open("/attendance");
    fireEvent.click(
      (await screen.findAllByRole("button", { name: "Request leave" }))[0],
    );
    const dialog = await screen.findByRole("dialog", { name: "Request leave" });
    fireEvent.change(within(dialog).getByLabelText("Leave type"), {
      target: { value: "sick" },
    });
    fireEvent.change(within(dialog).getByLabelText("Last day"), {
      target: { value: "2000-01-01" },
    });
    fireEvent.change(within(dialog).getByLabelText("Reason"), {
      target: { value: "Fever" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send request" }),
    );
    // The date field itself refuses a last day before the first day.
    expect(within(dialog).getByLabelText("Last day")).toHaveAttribute(
      "min",
      today,
    );
    await waitFor(() => expect(posted("/attendance/leave")).toEqual([]));
    fireEvent.change(within(dialog).getByLabelText("Last day"), {
      target: { value: today },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send request" }),
    );
    await screen.findByText("Leave request sent for review");
    expect(posted("/attendance/leave")).toEqual([
      {
        leave_type: "sick",
        start_date: today,
        end_date: today,
        reason: "Fever",
      },
    ]);
  });
  it("shows agents My attendance only, and admins both attendance pages", async () => {
    open("/attendance");
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    expect(
      within(nav).getByRole("link", { name: "My attendance" }),
    ).toBeInTheDocument();
    expect(
      within(nav).queryByRole("link", { name: "Attendance management" }),
    ).toBeNull();
  });
});

describe("Attendance management", () => {
  beforeEach(() => {
    mocks.user = { ...admin };
  });
  it("keeps agents out of the admin page", async () => {
    mocks.user = { ...ali };
    open("/attendance-management");
    expect(
      await screen.findByRole("heading", { name: "My overview" }),
    ).toBeInTheDocument();
    expect(calls("/admin/attendance")).toEqual([]);
  });
  it("shows today's figures, the policy and a donut that adds up", async () => {
    open("/attendance-management");
    expect(
      await screen.findByRole("heading", { name: "Attendance Command Center" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        "10:00 AM – 6:00 PM | Monday–Saturday | 15-minute grace",
      ),
    ).toBeInTheDocument();
    const kpi = (label) =>
      within(
        screen.getByText(label, { selector: "dt" }).closest("div"),
      ).getByRole("definition");
    await waitFor(() => expect(kpi("Expected today")).toHaveTextContent("3"));
    expect(kpi("Working now")).toHaveTextContent("1");
    expect(kpi("Checked out")).toHaveTextContent("0");
    expect(kpi("Not checked in")).toHaveTextContent("1");
    expect(kpi("On leave")).toHaveTextContent("0");
    expect(
      screen.getByRole("img", {
        name: /^1 of 3 expected employees have recorded attendance/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Arrival: 0 on time · 0 within grace · 1 late"),
    ).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Workspace" });
    expect(
      within(nav).getByRole("link", { name: "Attendance management" }),
    ).toBeInTheDocument();
  });
  it("lists what needs attention and opens the right section", async () => {
    open("/attendance-management");
    const panel = (
      await screen.findByRole("heading", { name: "Needs attention" })
    ).closest("section");
    expect(
      await within(panel).findByText("1 absent today"),
    ).toBeInTheDocument();
    expect(within(panel).getByText("1 late arrival")).toBeInTheDocument();
    expect(within(panel).getByText("Ali Agent (25 min)")).toBeInTheDocument();
    expect(within(panel).getByText("2 missing check-outs")).toBeInTheDocument();
    expect(
      within(panel).getByText("1 leave request waiting"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /Leave requests/ }),
    ).toHaveTextContent("1");
    fireEvent.click(
      within(panel).getByRole("button", { name: "Review leave" }),
    );
    expect(await screen.findByText("Errand")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Leave requests/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  it("shows everyone expected live, searches and opens quick details", async () => {
    open("/attendance-management");
    const register = (
      await screen.findByRole("heading", { name: "Live attendance" })
    ).closest("section");
    const absent = (await within(register).findByText("Sara Agent")).closest(
      "tr",
    );
    expect(within(absent).getByText("Absent")).toBeInTheDocument();
    fireEvent.change(
      within(register).getByRole("textbox", { name: "Search employees" }),
      {
        target: { value: "Sara" },
      },
    );
    await waitFor(() =>
      expect(
        calls("/admin/attendance/daily").some(
          (p) => p.includes("search=Sara") && p.includes("limit=100"),
        ),
      ).toBe(true),
    );
    fireEvent.change(
      within(register).getByRole("textbox", { name: "Search employees" }),
      {
        target: { value: "" },
      },
    );
    fireEvent.click(
      await within(register).findByRole("button", { name: "View Ali Agent" }),
    );
    const drawer = await screen.findByRole("dialog", { name: "Ali Agent" });
    expect(
      within(drawer).getByText(/UID 775610 · Agent · Active account/),
    ).toBeInTheDocument();
    expect(within(drawer).getByText("90%")).toBeInTheDocument();
    fireEvent.click(
      within(drawer).getByRole("button", { name: "Full employee history" }),
    );
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Employees" })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });
  it("shows the weekly trend with days off and the month's insights", async () => {
    open("/attendance-management");
    expect(
      await screen.findByRole("listitem", {
        name: /^Mon, 19 Oct: 1 present \(0 late\)/,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("listitem", { name: "Sun, 25 Oct: scheduled day off" }),
    ).toBeInTheDocument();
    const month = screen
      .getByRole("heading", { name: /\w+ \d{4}/, level: 2 })
      .closest("section");
    expect(within(month).getByText("60%")).toBeInTheDocument();
    expect(
      within(month).getByText("3 present of 5 eligible days"),
    ).toBeInTheDocument();
  });
  it("moves between sections with the keyboard and keeps deep links", async () => {
    open("/attendance-management?tab=holidays");
    const holidays = await screen.findByRole("tab", { name: "Holidays" });
    expect(holidays).toHaveAttribute("aria-selected", "true");
    expect(holidays).toHaveAttribute("tabindex", "0");
    holidays.focus();
    fireEvent.keyDown(holidays, { key: "ArrowRight" });
    const settings = screen.getByRole("tab", { name: "Settings" });
    expect(settings).toHaveAttribute("aria-selected", "true");
    expect(settings).toHaveFocus();
    fireEvent.keyDown(settings, { key: "Home" });
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveFocus();
  });
  it("shows an honest error with a retry when today's figures fail", async () => {
    let fail = true;
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      path === "/admin/attendance/overview" && fail
        ? Promise.reject(
            new Error("Attendance could not be loaded. Please try again."),
          )
        : original(path, options),
    );
    open("/attendance-management");
    expect(
      (
        await screen.findAllByText(
          "Attendance could not be loaded. Please try again.",
        )
      ).length,
    ).toBeGreaterThan(0);
    // No misleading zeros while the figures are unavailable.
    expect(
      screen.queryByRole("img", { name: /expected employees/ }),
    ).toBeNull();
    fail = false;
    fireEvent.click(screen.getAllByRole("button", { name: "Try again" })[0]);
    expect(
      await screen.findByRole("img", { name: /^1 of 3 expected employees/ }),
    ).toBeInTheDocument();
  });
  it("lists everyone expected on a date, filters and exports the register", async () => {
    open("/attendance-management?tab=daily");
    const absent = (await screen.findByText("Sara Agent")).closest("tr");
    expect(within(absent).getByText("Absent")).toBeInTheDocument();
    const late = screen.getByText("Ali Agent").closest("tr");
    expect(within(late).getByText("25 min")).toBeInTheDocument();
    fireEvent.change(
      screen.getByRole("combobox", { name: "Attendance state" }),
      { target: { value: "absent" } },
    );
    await waitFor(() =>
      expect(calls("/admin/attendance/daily").at(-1)).toContain("state=absent"),
    );
    globalThis.URL.createObjectURL = vi.fn(() => "blob:x");
    globalThis.URL.revokeObjectURL = vi.fn();
    fireEvent.click(
      within(screen.getByRole("tabpanel")).getByRole("button", {
        name: "Export CSV",
      }),
    );
    await waitFor(() =>
      expect(calls("/admin/attendance/export")).toHaveLength(1),
    );
    const query = new URLSearchParams(
      calls("/admin/attendance/export")[0].split("?")[1],
    );
    expect(Object.fromEntries(query)).toMatchObject({
      type: "daily",
      date: today,
      state: "absent",
      format: "csv",
    });
  });
  it("shows the week's daily breakdown and the month's charts", async () => {
    open("/attendance-management?tab=weekly");
    expect(await screen.findByText("60%")).toBeInTheDocument();
    expect(calls("/admin/attendance/weekly")[0]).toMatch(
      /week_start=\d{4}-\d{2}-\d{2}/,
    );
    expect(screen.getAllByLabelText(/Late, Present$/)).toHaveLength(1);
    expect(screen.getAllByLabelText(/: Absent$/)).toHaveLength(1);
    fireEvent.click(screen.getByRole("tab", { name: "Monthly" }));
    expect(
      await screen.findByText("Present and absent days"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "Present, late and absent employees per day",
      }),
    ).toBeInTheDocument();
    expect(calls("/admin/attendance/monthly")[0]).toMatch(/month=\d{4}-\d{2}/);
  });
  it("reviews another employee's leave but not the admin's own", async () => {
    open("/attendance-management?tab=leave");
    const own = (await screen.findByText("Errand")).closest("tr");
    expect(
      within(own).getByText(
        "Another administrator must review your own request",
      ),
    ).toBeInTheDocument();
    const other = screen.getByText("Fever").closest("tr");
    fireEvent.click(within(other).getByRole("button", { name: "Review" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Review leave request",
    });
    fireEvent.change(
      within(dialog).getByLabelText("Note to the employee (optional)"),
      { target: { value: "Get well" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await screen.findByText("Request approved");
    expect(posted("/admin/attendance/leave/l1/review")).toEqual([
      { decision: "approved", note: "Get well" },
    ]);
  });
  it("schedules a rule change from a future date", async () => {
    open("/attendance-management?tab=settings");
    expect(
      await screen.findByText("Asia/Karachi (Pakistan time, fixed)"),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Shift ends"), {
      target: { value: "09:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    expect(
      await screen.findByText("The shift must end after it starts."),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Shift ends"), {
      target: { value: "17:30" },
    });
    fireEvent.change(screen.getByLabelText("Grace period (minutes)"), {
      target: { value: "10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save rules" }));
    await screen.findByText(/Attendance rules saved from/);
    const body = mocks.api.mock.calls.find(
      ([p, o]) => p === "/admin/attendance/settings" && o?.method === "PATCH",
    )[1].body;
    expect(body).toMatchObject({
      shift_start: "10:00",
      shift_end: "17:30",
      grace_minutes: 10,
      work_days: [1, 2, 3, 4, 5, 6],
    });
    expect(body.effective_from > today).toBe(true);
  });
});

// Update 042: the Manage tab and per-row Manage actions enter or correct
// attendance for earlier days. The server decides each date; these checks
// cover what the screens send and show.
describe("Manage attendance", () => {
  const addDay = (d, n) =>
    new Date(Date.parse(d + "T00:00:00Z") + n * 864e5)
      .toISOString()
      .slice(0, 10);
  const isSunday = (d) => new Date(d + "T00:00:00Z").getUTCDay() === 0;
  let pastDay = addDay(today, -1);
  while (isSunday(pastDay)) pastDay = addDay(pastDay, -1);
  const info = (date, extra = {}) => ({
    date,
    today,
    self: false,
    employee: { id: ali.id, name: "Ali Agent", uid: 775610, role: "agent" },
    state: "absent",
    record: null,
    leave: null,
    rules: {
      shift_start: "10:00",
      shift_end: "18:00",
      grace_minutes: 15,
      work_days: [1, 2, 3, 4, 5, 6, 7],
    },
    holiday: null,
    pending_correction: false,
    attendance_start: today,
    counted: true,
    entered: false,
    tracking_started: today,
    history: [],
    ...extra,
  });
  const plan = (body, extra = {}) => ({
    dry_run: body.dry_run,
    employee: { id: ali.id, name: "Ali Agent" },
    results: body.entries.map((e) => ({
      date: e.date,
      status: e.status,
      result: "create",
      message: null,
      before: { state: "not_counted" },
      after: {
        state: "checked_out",
        check_in_at: `${e.date}T${e.check_in}:00+05:00`,
        check_out_at: `${e.date}T${e.check_out}:00+05:00`,
        punctuality: "on_time",
      },
    })),
    summary: {
      created: body.entries.length,
      updated: 0,
      unchanged: 0,
      skipped: 0,
      failed: 0,
    },
    counted_days: [],
    tracking_start: null,
    ...extra,
  });
  let dayInfo, respond;
  beforeEach(() => {
    mocks.user = { ...admin };
    dayInfo = (date) => info(date);
    respond = (body) => plan(body);
    const base = mocks.api.getMockImplementation();
    mocks.api.mockImplementation(async (path, options) => {
      if (path.startsWith("/admin/attendance/manage?"))
        return dayInfo(new URLSearchParams(path.split("?")[1]).get("date"));
      if (path === "/admin/attendance/manage") return respond(options.body);
      return base(path, options);
    });
  });
  const manageCalls = () =>
    mocks.api.mock.calls
      .filter(
        ([p, o]) => p === "/admin/attendance/manage" && o?.method === "POST",
      )
      .map(([, o]) => o.body);

  it("opens the Manage tab, which used to be only a label", async () => {
    open("/attendance-management");
    fireEvent.click(await screen.findByRole("tab", { name: "Manage" }));
    expect(
      await screen.findByRole("heading", { name: "Manage attendance" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Choose an employee to begin."),
    ).toBeInTheDocument();
    fireEvent.change(
      await screen.findByRole("combobox", { name: "Employee" }),
      {
        target: { value: ali.id },
      },
    );
    expect(
      await screen.findByRole("button", { name: "Review entry" }),
    ).toBeInTheDocument();
    expect(calls("/admin/attendance/manage?")[0]).toContain(`user=${ali.id}`);
    expect(screen.getByRole("radio", { name: "Present" })).toBeChecked();
  });

  it("adds an earlier day after a preview and a confirmation", async () => {
    respond = (body) =>
      plan(body, {
        counted_days: [pastDay],
      });
    open(`/attendance-management?tab=manage&user=${ali.id}&date=${pastDay}`);
    const checkIn = await screen.findByLabelText("Check-in (Pakistan time)");
    expect(checkIn).toHaveValue("10:00");
    fireEvent.change(checkIn, { target: { value: "10:30" } });
    expect(
      screen.getByText(/Arrival: Late \(30 min after the shift starts\)/),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Reason or note (optional)"), {
      target: { value: "Paper register" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review entry" }));
    expect(
      await screen.findByRole("heading", { name: "Add this day?" }),
    ).toBeInTheDocument();
    expect(manageCalls()).toEqual([
      {
        user_id: ali.id,
        entries: [
          {
            date: pastDay,
            status: "present",
            check_in: "10:30",
            check_out: "18:00",
          },
        ],
        reason: "Paper register",
        replace: false,
        dry_run: true,
      },
    ]);
    expect(
      screen.getByText(
        /before Ali Agent's own attendance and will now be counted/,
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
    expect(
      await screen.findByText(
        `Attendance added for Ali Agent on ${dayLabel(pastDay)}`,
      ),
    ).toBeInTheDocument();
    expect(manageCalls().map((b) => b.dry_run)).toEqual([true, false]);
  });

  it("loads an existing day into the form and changes it only after confirming", async () => {
    dayInfo = (date) =>
      info(date, {
        state: "checked_out",
        record: {
          id: "r1",
          check_in_at: `${date}T05:20:00.000Z`,
          check_out_at: `${date}T12:00:00.000Z`,
          state: "checked_out",
          punctuality: "late",
          corrected: false,
        },
        history: [
          {
            at: `${date}T05:20:00.000Z`,
            action: "attendance.check_in",
            by: "Ali Agent",
          },
        ],
      });
    respond = (body) => {
      const p = plan(body);
      p.results[0] = {
        ...p.results[0],
        result: "update",
        before: {
          state: "checked_out",
          check_in_at: `${pastDay}T05:20:00.000Z`,
          check_out_at: `${pastDay}T12:00:00.000Z`,
          punctuality: "late",
        },
      };
      return p;
    };
    open(`/attendance-management?tab=manage&user=${ali.id}&date=${pastDay}`);
    expect(
      await screen.findByLabelText("Check-in (Pakistan time)"),
    ).toHaveValue("10:20");
    expect(screen.getByLabelText("Check-out (Pakistan time)")).toHaveValue(
      "17:00",
    );
    expect(screen.getByText("Change history")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Check-in (Pakistan time)"), {
      target: { value: "10:00" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    const confirm = await screen.findByRole("group", {
      name: "Confirm change",
    });
    expect(within(confirm).getByText(/Late$/)).toBeInTheDocument();
    expect(manageCalls()[0]).toMatchObject({ replace: true, dry_run: true });
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
    expect(
      await screen.findByText(
        `Attendance updated for Ali Agent on ${dayLabel(pastDay)}`,
      ),
    ).toBeInTheDocument();
  });

  it("removes an entered day so it is no longer counted", async () => {
    dayInfo = (date) =>
      info(date, {
        state: "checked_out",
        entered: true,
        record: {
          id: "r1",
          check_in_at: `${date}T05:00:00.000Z`,
          check_out_at: `${date}T13:00:00.000Z`,
          state: "checked_out",
          punctuality: "on_time",
          corrected: true,
        },
      });
    respond = (body) => {
      const p = plan(body);
      p.results[0] = {
        ...p.results[0],
        result: "update",
        before: { state: "checked_out" },
        after: { state: "not_counted" },
      };
      return p;
    };
    open(`/attendance-management?tab=manage&user=${ali.id}&date=${pastDay}`);
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove entry" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Remove this entry?" }),
    ).toBeInTheDocument();
    expect(manageCalls()[0]).toEqual({
      user_id: ali.id,
      entries: [{ date: pastDay, status: "clear" }],
      replace: true,
      dry_run: true,
    });
    const confirm = screen.getByRole("group", { name: "Confirm change" });
    expect(within(confirm).getByText("Not counted")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm and save" }));
    expect(
      await screen.findByText(
        `Attendance entry removed for Ali Agent on ${dayLabel(pastDay)}`,
      ),
    ).toBeInTheDocument();
  });

  it("explains why a day cannot be changed and shows the server's reasons", async () => {
    dayInfo = (date) => info(date, { self: true });
    open(`/attendance-management?tab=manage&user=${ali.id}&date=${pastDay}`);
    expect(
      await screen.findByText(
        "You can't change your own attendance. Another administrator must do it.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Review entry" })).toBeNull();
  });

  it("refuses a late day inside the grace period with the server's message", async () => {
    respond = (body) => {
      const p = plan(body);
      p.results[0] = {
        ...p.results[0],
        result: "error",
        message:
          "A 10:10 check-in is within the 15-minute grace period, so the day is not late",
        after: null,
      };
      return p;
    };
    open(`/attendance-management?tab=manage&user=${ali.id}&date=${pastDay}`);
    fireEvent.click(await screen.findByRole("radio", { name: "Late" }));
    expect(screen.getByLabelText("Check-in (Pakistan time)")).toHaveValue(
      "10:30",
    );
    fireEvent.change(screen.getByLabelText("Check-in (Pakistan time)"), {
      target: { value: "10:10" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Review entry" }));
    expect(
      await screen.findByText(/within the 15-minute grace period/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Confirm and save" }),
    ).toBeNull();
  });

  it("previews several days, leaves out Sundays and saves only the ticked days", async () => {
    const from = addDay(today, -8),
      to = addDay(today, -2);
    respond = (body) => {
      const p = plan(body);
      p.results = p.results.map((r, i) =>
        isSunday(r.date)
          ? { ...r, result: "error", message: "Scheduled day off", after: null }
          : i === 1
            ? {
                ...r,
                result: "skip",
                message: "Already recorded.",
                after: null,
              }
            : r,
      );
      if (!body.dry_run)
        p.summary = {
          created: body.entries.length,
          updated: 0,
          unchanged: 0,
          skipped: 0,
          failed: 0,
        };
      return p;
    };
    open(`/attendance-management?tab=manage&user=${ali.id}`);
    fireEvent.click(await screen.findByRole("radio", { name: "Several days" }));
    fireEvent.change(await screen.findByLabelText("First day"), {
      target: { value: from },
    });
    fireEvent.change(screen.getByLabelText("Last day"), {
      target: { value: to },
    });
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const preview = await screen.findByRole("region", { name: "Preview" });
    expect(manageCalls()[0].entries).toHaveLength(7);
    expect(manageCalls()[0]).toMatchObject({ replace: false, dry_run: true });
    const sunday = [0, 1, 2, 3, 4, 5, 6]
      .map((n) => addDay(from, n))
      .find(isSunday);
    expect(
      within(preview).getByRole("checkbox", {
        name: `Save ${dayLabel(sunday)}`,
      }),
    ).toBeDisabled();
    const creatable = manageCalls()[0]
      .entries.map((e) => e.date)
      .filter((d, i) => !isSunday(d) && i !== 1);
    fireEvent.click(
      within(preview).getByRole("checkbox", {
        name: `Save ${dayLabel(creatable[0])}`,
      }),
    );
    fireEvent.click(
      within(preview).getByRole("button", {
        name: `Save ${creatable.length - 1} days`,
      }),
    );
    expect(
      await screen.findByRole("region", { name: "Saved" }),
    ).toBeInTheDocument();
    expect(manageCalls()[1].dry_run).toBe(false);
    expect(manageCalls()[1].entries.map((e) => e.date)).toEqual(
      creatable.slice(1),
    );
  });

  it("opens the same editor from an earlier day in the daily register", async () => {
    open("/attendance-management?tab=daily");
    await screen.findByText("Sara Agent");
    expect(
      screen.queryByRole("button", { name: "Manage Ali Agent's attendance" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Previous day" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Manage Ali Agent's attendance",
      }),
    );
    expect(
      await screen.findByRole("dialog", {
        name: "Manage attendance · Ali Agent",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(calls("/admin/attendance/manage?").at(-1)).toContain(
        `date=${addDay(today, -1)}`,
      ),
    );
  });
});
