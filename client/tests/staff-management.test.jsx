import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
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
import { staffNavigation } from "../src/components/layout/navigation";
// Update 047: the Staff workspace, Employee management and staff in task
// assignment. API responses are mocked; the server tests check the same rules
// against the database.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = {
  id: "e7000000-0000-4000-8000-000000000001",
  uid: 663118,
  name: "HD Administrator",
  role: "admin",
  active: true,
};
const staff = {
  id: "e7000000-0000-4000-8000-000000000002",
  uid: 771122,
  name: "Ali Editor",
  role: "staff",
  active: true,
};
const MEDIA = "d7000000-0000-4000-8000-000000000020",
  TECH = "d7000000-0000-4000-8000-000000000030";
const departments = [
  {
    id: "d7000000-0000-4000-8000-000000000010",
    name: "Sales",
    active: true,
    members: 2,
    agents: 2,
    staff: 0,
  },
  { id: MEDIA, name: "Media", active: true, members: 1, agents: 0, staff: 1 },
  {
    id: TECH,
    name: "Technical",
    active: true,
    members: 1,
    agents: 0,
    staff: 1,
  },
];
const shift = {
  source: "company",
  label: "HD Marketing standard",
  shift_start: "10:00",
  shift_end: "18:00",
  work_days: [1, 2, 3, 4, 5, 6],
  grace_minutes: 15,
  upcoming: null,
};
const employee = (extra = {}) => ({
  id: staff.id,
  uid: staff.uid,
  name: staff.name,
  email: "editor@gmail.com",
  role: "staff",
  department_id: MEDIA,
  department: "Media",
  job_title: "Video Editor",
  joined_on: null,
  active: true,
  attendance_state: "checked_in",
  punctuality: "on_time",
  check_in_at: "2026-10-29T05:00:00Z",
  check_out_at: null,
  tasks: 2,
  completed: 1,
  task_percent: 50,
  report_submitted: false,
  shift,
  ...extra,
});
let routes;
const calls = (method, path) =>
  mocks.api.mock.calls.filter(
    ([p, o]) => p.startsWith(path) && (o?.method || "GET") === method,
  );
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
  mocks.user = { ...staff };
  routes = {
    "/profile": () => ({
      ...staff,
      email: "editor@gmail.com",
      department: "Media",
      job_title: "Video Editor",
      joined_on: "2026-09-01",
      shift,
    }),
    "/tasks/my": () => ({
      date: "2026-10-29",
      role: "staff",
      today: [
        {
          id: "a7000000-0000-4000-8000-000000000001",
          title: "Edit the DHA promotional video",
          kind: "simple",
          status: "in_progress",
          priority: "high",
          task_date: "2026-10-29",
          due_on: "2026-10-29",
          percent: 0,
        },
      ],
      overdue: [],
      upcoming: [],
      completed: [],
      summary: {
        task_count: 2,
        completed: 1,
        completion_percent: 50,
        due_count: 2,
        due_completed: 1,
        overdue: 0,
      },
      report: null,
      missing_reports: [],
      reports: [],
      requests: [],
      checkout: { required: false },
    }),
    "/attendance/me": () => ({
      date: "2026-10-29",
      policy: {
        name: "HD Marketing standard",
        shift_start: "10:00",
        shift_end: "18:00",
        work_days: [1, 2, 3, 4, 5, 6],
        grace_minutes: 15,
      },
      today: {
        state: "checked_in",
        scheduled: true,
        check_in_at: "2026-10-29T05:00:00Z",
      },
      month: {},
      recent: [],
      incomplete: [],
    }),
    "/notifications": () => ({
      data: [
        {
          id: "n1",
          type: "task_assigned",
          title: "New task: Edit the DHA promotional video",
          body: "HD Administrator assigned this for today.",
          link: "/my-tasks",
          created_at: "2026-10-29T04:00:00Z",
        },
      ],
      unread: 1,
    }),
    "/admin/departments": () => departments,
    "/admin/employees": () => ({
      date: "2026-10-29",
      data: [employee()],
      count: 1,
      page: 1,
      limit: 20,
      summary: {
        active: 4,
        admins: 1,
        agents: 2,
        staff: 1,
        present: 3,
        late: 1,
        absent: 0,
        on_leave: 0,
        without_department: 1,
      },
    }),
    "/users": () => [
      admin,
      { ...staff },
      {
        id: "e7000000-0000-4000-8000-000000000003",
        uid: 555111,
        name: "Sara Agent",
        role: "agent",
        active: true,
      },
      {
        id: "e7000000-0000-4000-8000-000000000004",
        uid: 555222,
        name: "Hassan Developer",
        role: "staff",
        active: true,
      },
    ],
  };
  mocks.api.mockImplementation(async (path, options) => {
    // The longest matching route wins (/admin/employees/<id> before the list).
    const handler = Object.entries(routes)
      .sort(([a], [b]) => b.length - a.length)
      .find(
        ([p]) =>
          path === p ||
          path.startsWith(p + "?") ||
          (p.endsWith("/") ? path.startsWith(p) : path.startsWith(p + "/")),
      )?.[1];
    if (handler) return handler(path, options);
    if (options?.method === "POST")
      return { id: "x", title: "Saved", assignments: [{}, {}], scope: "team" };
    return { data: [], count: 0 };
  });
});

describe("the Staff workspace", () => {
  it("shows staff only their own work, attendance and profile in the menu", async () => {
    open("/");
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    for (const label of [
      "My dashboard",
      "My tasks",
      "My reports",
      "Attendance",
      "Leave requests",
      "Notifications",
      "My profile",
    ])
      expect(
        within(nav).getByRole("link", { name: label }),
      ).toBeInTheDocument();
    for (const label of [
      "Leads",
      "My leads",
      "Inventory",
      "Documentation & policies",
      "Accounts",
      "Audit history",
    ])
      expect(within(nav).queryByRole("link", { name: label })).toBeNull();
    expect(staffNavigation.flatMap((g) => g.links).map(([to]) => to)).toEqual([
      "/",
      "/my-tasks",
      "/my-reports",
      "/attendance",
      "/leave",
      "/notifications",
      "/profile",
    ]);
  });
  it("opens the Staff dashboard with today's attendance, tasks, report and notices", async () => {
    open("/");
    expect(
      await screen.findByRole("heading", { name: "Welcome, Ali" }),
    ).toBeInTheDocument();
    expect(await screen.findByText("Media · Video Editor")).toBeInTheDocument();
    const tiles = screen.getByRole("region", { name: "Today at a glance" });
    expect(tiles).toHaveTextContent("Attendance today");
    expect(tiles).toHaveTextContent("Checked in");
    expect(tiles).toHaveTextContent("Tasks today2");
    expect(tiles).toHaveTextContent("1 completed · 1 pending");
    expect(tiles).toHaveTextContent("Daily completion50%");
    expect(tiles).toHaveTextContent("Daily reportNot yet");
    expect(
      await screen.findByText("Edit the DHA promotional video"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("New task: Edit the DHA promotional video"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Check out on Attendance" }),
    ).toHaveAttribute("href", "/attendance");
    // Nothing from the sales workspace is requested.
    for (const [path] of mocks.api.mock.calls)
      expect(path).not.toMatch(/^\/(dashboard|leads|properties|reports|users)/);
  });
  it("keeps staff out of sales and administrator pages", async () => {
    for (const path of [
      "/leads",
      "/inventory",
      "/documents",
      "/followups",
      "/accounts",
      "/team",
      "/task-management",
      "/audit",
    ]) {
      open(path);
      expect(
        await screen.findByRole("heading", { name: "Welcome, Ali" }),
        path,
      ).toBeInTheDocument();
      cleanup();
    }
    expect(
      mocks.api.mock.calls.some(([p]) =>
        /^\/(leads|properties|documents|followups|accounts|admin|audit|users)/.test(
          p,
        ),
      ),
    ).toBe(false);
  });
  it("shows My profile with department, job title and shift", async () => {
    open("/profile");
    const details = await screen.findByRole("region", {
      name: "Profile details",
    });
    expect(details).toHaveTextContent("RoleStaff");
    expect(details).toHaveTextContent("DepartmentMedia");
    expect(details).toHaveTextContent("Job titleVideo Editor");
    expect(details).toHaveTextContent(
      "Office timing10:00 AM – 6:00 PM, Mon–Sat, 15 min grace",
    );
    expect(details).toHaveTextContent("ScheduleCompany default");
  });
  it("sends My reports and Leave requests to the existing pages", async () => {
    open("/my-reports");
    expect(
      await screen.findByRole("heading", { name: "My tasks" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "My reports" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});

describe("Employee management", () => {
  beforeEach(() => {
    mocks.user = { ...admin };
  });
  it("lists agents and staff with server-side filters", async () => {
    open("/team");
    expect(
      await screen.findByRole("heading", { name: "Employee management" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Ali Editor" }),
    ).toBeInTheDocument();
    const row = screen
      .getByRole("button", { name: "Ali Editor" })
      .closest("tr");
    expect(row).toHaveTextContent("Staff");
    expect(row).toHaveTextContent("Media");
    expect(row).toHaveTextContent("Video Editor");
    expect(row).toHaveTextContent("1 of 2 done · 50%");
    fireEvent.change(screen.getByRole("combobox", { name: "Role" }), {
      target: { value: "staff" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Department" }), {
      target: { value: MEDIA },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Tasks today" }), {
      target: { value: "incomplete" },
    });
    await waitFor(() => {
      const last = calls("GET", "/admin/employees").at(-1)[0];
      expect(last).toContain("role=staff");
      expect(last).toContain(`department=${MEDIA}`);
      expect(last).toContain("tasks=incomplete");
      expect(last).toContain("account=active");
    });
  });
  it("changes an employee's department and links to Shift management", async () => {
    routes["/admin/employees/"] = (path, options) =>
      options?.method
        ? employee({ department: "Technical", department_id: TECH, shifts: [] })
        : { ...employee(), shifts: [] };
    routes["/admin/attendance/employees"] = () => ({
      totals: { present_days: 3, late_days: 1 },
      leave: [],
    });
    routes["/admin/tasks/performance"] = () => ({
      employees: [
        {
          id: staff.id,
          assignments: 4,
          completed: 3,
          average_percent: 80,
          reports: 2,
          missing_reports: 0,
        },
      ],
    });
    open("/team");
    fireEvent.click(await screen.findByRole("button", { name: "Ali Editor" }));
    const dialog = await screen.findByRole("dialog", { name: "Ali Editor" });
    await within(dialog).findByText("Video Editor");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Edit department and title" }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Department" }),
      { target: { value: TECH } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save details" }),
    );
    await waitFor(() =>
      expect(calls("PATCH", "/admin/employees/")[0][1].body).toEqual({
        department_id: TECH,
        job_title: "Video Editor",
        joined_on: null,
      }),
    );
    // Office timings are changed in Shift management, not here (update 048).
    expect(
      within(dialog).getByText("Company default shift"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", {
        name: "Change office timing in Shift management",
      }),
    ).toHaveAttribute(
      "href",
      `/attendance-management?tab=shifts&view=individual&employee=${staff.id}`,
    );
    expect(
      within(dialog).queryByRole("button", { name: "Change shift" }),
    ).toBeNull();
  });
  it("adds a department", async () => {
    open("/team");
    fireEvent.click(await screen.findByRole("button", { name: "Departments" }));
    const dialog = await screen.findByRole("dialog", { name: "Departments" });
    expect(dialog).toHaveTextContent("Media");
    fireEvent.change(within(dialog).getByLabelText("New department"), {
      target: { value: "Customer Care" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Add department" }),
    );
    await waitFor(() =>
      expect(calls("POST", "/admin/departments")[0][1].body).toEqual({
        name: "Customer Care",
      }),
    );
  });
});

describe("tasks for staff", () => {
  beforeEach(() => {
    mocks.user = { ...admin };
  });
  it("assigns a team task to all staff and a department, alongside agents", async () => {
    open("/task-management?tab=assign");
    const form = (
      await screen.findByRole("button", { name: "Assign Team Task" })
    ).closest("form");
    await within(form).findByText("All active staff (2)");
    fireEvent.click(
      within(form).getByRole("checkbox", { name: "All active agents (1)" }),
    );
    fireEvent.click(
      within(form).getByRole("checkbox", { name: "All active staff (2)" }),
    );
    fireEvent.click(
      await within(form).findByRole("checkbox", { name: "Media team (1)" }),
    );
    fireEvent.change(within(form).getByRole("textbox", { name: /^Title/ }), {
      target: { value: "Prepare Instagram reels" },
    });
    fireEvent.change(
      within(form).getByRole("spinbutton", { name: /^Target/ }),
      { target: { value: "2" } },
    );
    fireEvent.change(within(form).getByRole("textbox", { name: /^Unit/ }), {
      target: { value: "reels" },
    });
    fireEvent.change(
      within(form).getByRole("combobox", { name: /^Category/ }),
      { target: { value: "media" } },
    );
    fireEvent.click(
      within(form).getByRole("button", { name: "Assign Team Task" }),
    );
    await waitFor(() => {
      const body = calls("POST", "/admin/tasks")[0][1].body;
      expect(body).toMatchObject({
        all_staff: true,
        departments: [MEDIA],
        category: "media",
      });
      expect(body).not.toHaveProperty("all_agents");
      expect(body).not.toHaveProperty("assignees");
    });
  });
  it("offers staff for individual tasks and filters performance by department", async () => {
    open("/task-management?tab=assign");
    const form = (
      await screen.findByRole("button", { name: "Assign Team Task" })
    ).closest("form");
    fireEvent.click(
      within(form).getByRole("radio", { name: /Individual Task/ }),
    );
    const select = within(form).getByRole("combobox", { name: "Employee" });
    expect(
      within(select).getByRole("group", { name: "Staff" }),
    ).toHaveTextContent("Hassan Developer · UID 555222");
    routes["/admin/tasks/performance"] = () => ({
      from: "2026-10-26",
      to: "2026-10-29",
      totals: {
        assignments: 4,
        completed: 3,
        average_percent: 80,
        verified: 0,
        verified_average_percent: null,
        reports: 2,
        early_approved: 0,
        emergency_approved: 0,
      },
      departments: [
        {
          id: MEDIA,
          name: "Media",
          employees: 1,
          assignments: 4,
          completed: 3,
          average_percent: 80,
          reports: 2,
        },
      ],
      employees: [],
      days: [],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Performance History" }));
    fireEvent.change(
      await screen.findByRole("combobox", { name: "Department" }),
      { target: { value: MEDIA } },
    );
    await waitFor(() =>
      expect(calls("GET", "/admin/tasks/performance").at(-1)[0]).toContain(
        `department=${MEDIA}`,
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "By department" }),
    ).toBeInTheDocument();
  });
});

describe("creating a staff account", () => {
  it("asks for the department and job title", async () => {
    const { default: CreateAccountForm } =
      await import("../src/components/accounts/CreateAccountForm");
    mocks.user = { ...admin };
    const onCreate = vi.fn(async () => {});
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <CreateAccountForm
          request={vi.fn(async () => ({ available: true }))}
          onCreate={onCreate}
        />
      </QueryClientProvider>,
    );
    fireEvent.change(screen.getByLabelText("Full name"), {
      target: { value: "Ali Editor" },
    });
    fireEvent.change(screen.getByLabelText("Account role"), {
      target: { value: "staff" },
    });
    fireEvent.change(screen.getByLabelText("Gmail address"), {
      target: { value: "editor@gmail.com" },
    });
    fireEvent.change(screen.getByLabelText("New password"), {
      target: { value: "staff-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "staff-password-123" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
    expect(
      await screen.findByText(
        "Choose the department this staff member works in.",
      ),
    ).toBeInTheDocument();
    expect(onCreate).not.toHaveBeenCalled();
    await screen.findByRole("option", { name: "Media" });
    fireEvent.change(screen.getByLabelText("Department"), {
      target: { value: MEDIA },
    });
    fireEvent.change(screen.getByLabelText("Job title"), {
      target: { value: "Video Editor" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Create account/ }));
    await waitFor(() =>
      expect(onCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          role: "staff",
          department_id: MEDIA,
          job_title: "Video Editor",
        }),
      ),
    );
  });
});
