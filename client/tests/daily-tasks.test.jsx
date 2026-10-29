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
// Update 045: My tasks, Task management and the checkout panel. API responses
// are mocked; the server tests check the same rules against the database.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = {
  id: "e1000000-0000-4000-8000-000000000001",
  uid: 663118,
  name: "HD Administrator",
  role: "admin",
  active: true,
};
const agent = {
  id: "e1000000-0000-4000-8000-000000000002",
  uid: 962837,
  name: "HD Agent",
  role: "agent",
  active: true,
};
const task = (extra = {}) => ({
  id: "a1000000-0000-4000-8000-000000000001",
  task_id: "b1000000-0000-4000-8000-000000000001",
  scope: "team",
  title: "Contact potential buyers",
  kind: "measurable",
  target_quantity: 50,
  unit: "calls",
  task_date: "2026-10-29",
  due_on: "2026-10-29",
  priority: "high",
  category: "calls",
  assigned_by: "HD Administrator",
  status: "in_progress",
  completed_quantity: 40,
  remaining_quantity: 10,
  excess_quantity: 0,
  percent: 80,
  verified_status: null,
  ...extra,
});
const checkout = (extra = {}) => ({
  date: "2026-10-29",
  rules_active: true,
  required: true,
  attendance_state: "checked_in",
  shift_end: "18:00",
  before_shift_end: true,
  report_submitted: false,
  tasks: {
    task_count: 1,
    completed: 0,
    due_count: 1,
    due_completed: 0,
    overdue: 0,
    completion_percent: 80,
    all_due_completed: false,
  },
  pending_request: null,
  approved_request: null,
  can_check_out: false,
  blocked_reason:
    "Checking out before your shift ends at 6:00 PM needs an approved early or emergency checkout request.",
  can_request_early: false,
  early_blockers: ["Complete every task due today first (0 of 1 done)."],
  can_request_emergency: true,
  ...extra,
});
const my = (extra = {}) => ({
  date: "2026-10-29",
  role: "agent",
  rules_active: true,
  today: [task()],
  overdue: [],
  upcoming: [],
  completed: [],
  summary: {
    task_count: 1,
    completed: 0,
    due_count: 1,
    due_completed: 0,
    overdue: 0,
    completion_percent: 80,
    all_due_completed: false,
  },
  report: null,
  missing_reports: [],
  reports: [],
  requests: [],
  checkout: checkout(),
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
  mocks.user = { ...agent };
  routes = {
    "/tasks/my": () => my(),
    "/tasks/checkout": () => checkout(),
    "/users": () => [
      admin,
      agent,
      {
        id: "e1000000-0000-4000-8000-000000000003",
        uid: 555111,
        name: "Sara Agent",
        role: "agent",
        active: true,
      },
      {
        id: "e1000000-0000-4000-8000-000000000004",
        uid: 555222,
        name: "Gone Agent",
        role: "agent",
        active: false,
      },
    ],
  };
  mocks.api.mockImplementation(async (path, options) => {
    const handler = Object.entries(routes).find(
      ([p]) => path === p || path.startsWith(p + "?"),
    )?.[1];
    if (handler) return handler(path, options);
    if (options?.method === "POST")
      return {
        id: "x",
        title: "Contact potential buyers",
        assignments: [{}, {}],
        scope: "team",
      };
    if (path === "/notifications") return { data: [], unread: 0 };
    if (path === "/attendance/me")
      return {
        date: "2026-10-29",
        today: {
          state: "checked_in",
          scheduled: true,
          check_in_at: "2026-10-29T05:00:00Z",
        },
        month: {},
        recent: [],
        incomplete: [],
      };
    return { data: [], count: 0 };
  });
});

describe("My tasks", () => {
  it("shows the agent's tasks and saves progress", async () => {
    open("/my-tasks");
    const card = (
      await screen.findByRole("heading", { name: "Contact potential buyers" })
    ).closest("article");
    expect(card).toHaveTextContent("40 of 50 calls");
    expect(card).toHaveTextContent("10 to go");
    expect(within(card).getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "80",
    );
    fireEvent.change(within(card).getByLabelText("Completed (calls)"), {
      target: { value: "45" },
    });
    fireEvent.click(
      within(card).getByRole("button", { name: "Save progress" }),
    );
    await waitFor(() =>
      expect(calls("POST", "/tasks/assignments/")).toHaveLength(1),
    );
    expect(calls("POST", "/tasks/assignments/")[0]).toEqual([
      `/tasks/assignments/${task().id}/progress`,
      { method: "POST", body: { quantity: 45, note: "" } },
    ]);
  });
  it("submits an honest daily report and explains checkout", async () => {
    open("/my-tasks");
    const panel = await screen.findByRole("region", {
      name: "Checking out today",
    });
    expect(panel).toHaveTextContent("Daily work report not submitted yet");
    expect(panel).toHaveTextContent(
      "needs an approved early or emergency checkout request",
    );
    expect(
      within(panel).getByRole("button", { name: "Request Early Checkout" }),
    ).toBeDisabled();
    expect(panel).toHaveTextContent(
      "Complete every task due today first (0 of 1 done).",
    );
    const report = screen.getByRole("region", { name: "Daily work report" });
    expect(report).toHaveTextContent(
      "an honest report with unfinished work is fine",
    );
    fireEvent.change(within(report).getByLabelText("Remarks"), {
      target: { value: "Five customers want a call tomorrow" },
    });
    fireEvent.click(
      within(report).getByRole("button", { name: "Submit Daily Report" }),
    );
    await waitFor(() =>
      expect(calls("POST", "/tasks/reports")).toHaveLength(1),
    );
    expect(calls("POST", "/tasks/reports")[0][1].body).toEqual({
      remarks: "Five customers want a call tomorrow",
      amend: false,
    });
  });
  it("asks before amending a submitted report", async () => {
    routes["/tasks/my"] = () =>
      my({
        report: {
          id: "r1",
          status: "submitted",
          submitted_at: "2026-10-29T12:00:00Z",
          completion_percent: 80,
          task_count: 1,
          amendment_count: 0,
          remarks: "First",
        },
      });
    open("/my-tasks");
    const report = await screen.findByRole("region", {
      name: "Daily work report",
    });
    fireEvent.click(
      within(report).getByRole("button", { name: "Amend report" }),
    );
    fireEvent.click(
      within(report).getByRole("button", { name: "Submit amended report" }),
    );
    await waitFor(() =>
      expect(calls("POST", "/tasks/reports")[0][1].body).toEqual({
        remarks: "First",
        amend: true,
      }),
    );
  });
  it("sends early and emergency checkout requests", async () => {
    routes["/tasks/my"] = () =>
      my({
        checkout: checkout({
          can_request_early: true,
          early_blockers: [],
          report_submitted: true,
        }),
      });
    open("/my-tasks");
    fireEvent.click(
      await screen.findByRole("button", { name: "Request Early Checkout" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Request Early Checkout",
    });
    expect(dialog).toHaveTextContent("Normal shift end6:00 PM");
    expect(dialog).toHaveTextContent("Daily reportSubmitted");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send Request to Admin" }),
    );
    await waitFor(() =>
      expect(calls("POST", "/tasks/checkout-requests")[0][1].body).toEqual({
        kind: "early",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Request Emergency Checkout" }),
    );
    const emergency = await screen.findByRole("dialog", {
      name: "Request Emergency Checkout",
    });
    expect(emergency).toHaveTextContent("leave safely");
    expect(
      within(emergency).getByLabelText("What happened? (required)"),
    ).toBeRequired();
  });
  it("asks for a new explanation after a rejection and explains the limits", async () => {
    routes["/tasks/my"] = () =>
      my({
        checkout: checkout({
          can_request_early: true,
          early_blockers: [],
          report_submitted: true,
          can_request_emergency: false,
          early_resubmission: {
            count: 1,
            limit: 3,
            limit_reached: false,
            rejected: 1,
            explanation_required: true,
            last_rejected_at: "2026-10-29T11:05:00Z",
            last_rejected_by: "HD Administrator",
            last_rejection_note: "Busy afternoon",
            waiting: false,
          },
          emergency_resubmission: {
            count: 3,
            limit: 3,
            limit_reached: true,
            explanation_required: true,
          },
        }),
      });
    open("/my-tasks");
    expect(
      await screen.findByText(
        "You have used today's 3 emergency checkout requests. Please speak to an administrator.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Request Emergency Checkout" }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Request Early Checkout" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Request Early Checkout",
    });
    expect(dialog).toHaveTextContent(
      "Your last early checkout request was rejected by HD Administrator at 4:05 PM: “Busy afternoon”",
    );
    expect(dialog).toHaveTextContent("Request 2 of 3 today.");
    const why = within(dialog).getByLabelText(
      "What has changed since your last request? (required)",
    );
    expect(why).toBeRequired();
    expect(why).toHaveAttribute("minLength", "10");
    fireEvent.change(why, {
      target: { value: "  The site visit moved to tomorrow " },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Send Request to Admin" }),
    );
    await waitFor(() =>
      expect(calls("POST", "/tasks/checkout-requests")[0][1].body).toEqual({
        kind: "early",
        reason: "The site visit moved to tomorrow",
      }),
    );
  });
  it("keeps administrators out of My tasks and agents out of Task management", async () => {
    open("/task-management");
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Task management" }),
      ).toBeNull(),
    );
    expect(
      mocks.api.mock.calls.filter(([p]) => p.startsWith("/admin/tasks")),
    ).toEqual([]);
  });
});

describe("Task management", () => {
  beforeEach(() => {
    mocks.user = { ...admin };
  });
  it("assigns a team task to every active agent, once", async () => {
    open("/task-management?tab=assign");
    const form = (
      await screen.findByRole("button", { name: "Assign Team Task" })
    ).closest("form");
    expect(
      await within(form).findByText("All active agents (2)"),
    ).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText("Title"), {
      target: { value: "Contact potential buyers" },
    });
    fireEvent.change(within(form).getByLabelText("Target"), {
      target: { value: "50" },
    });
    fireEvent.change(within(form).getByLabelText("Unit"), {
      target: { value: "calls" },
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "Assign Team Task" }),
    );
    await waitFor(() => expect(calls("POST", "/admin/tasks")).toHaveLength(1));
    const body = calls("POST", "/admin/tasks")[0][1].body;
    expect(body).toMatchObject({
      scope: "team",
      title: "Contact potential buyers",
      kind: "measurable",
      target_quantity: 50,
      unit: "calls",
      all_agents: true,
      priority: "normal",
    });
    expect(body.client_key).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("offers Assign anyway after a duplicate, with the same key", async () => {
    let first = true;
    routes["/admin/tasks"] = async (path, options) => {
      if (options?.method !== "POST") return { data: [], count: 0 };
      if (first) {
        first = false;
        throw Object.assign(
          new Error(
            "HD Agent already has “Calls” on October 29, 2026. Choose Assign anyway to add it again.",
          ),
          { status: 409 },
        );
      }
      return {
        id: "t",
        title: "Calls",
        scope: "individual",
        assignments: [{}],
      };
    };
    open("/task-management?tab=assign");
    const form = (
      await screen.findByRole("button", { name: "Assign Team Task" })
    ).closest("form");
    fireEvent.click(within(form).getByLabelText(/Individual Task/));
    await within(form).findByRole("option", { name: "HD Agent · UID 962837" });
    expect(
      within(form).queryByRole("option", { name: /Gone Agent/ }),
    ).toBeNull();
    fireEvent.change(within(form).getByLabelText("Employee"), {
      target: { value: agent.id },
    });
    fireEvent.change(within(form).getByLabelText("Title"), {
      target: { value: "Calls" },
    });
    fireEvent.change(within(form).getByLabelText("Type"), {
      target: { value: "simple" },
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "Assign Individual Task" }),
    );
    expect(
      await within(form).findByText(/already has “Calls”/),
    ).toBeInTheDocument();
    const submit = within(form).getByRole("button", {
      name: "Assign Individual Task",
    });
    expect(submit).toBeDisabled();
    fireEvent.click(
      within(form).getByLabelText("Assign anyway, as a second task"),
    );
    fireEvent.click(submit);
    await waitFor(() => expect(calls("POST", "/admin/tasks")).toHaveLength(2));
    const [a, b] = calls("POST", "/admin/tasks").map(([, o]) => o.body);
    expect(b).toMatchObject({
      allow_duplicate: true,
      assignees: [agent.id],
      kind: "simple",
    });
    expect(b.client_key).toBe(a.client_key);
  });
  it("approves an emergency checkout with the report waived", async () => {
    routes["/admin/tasks/checkout-requests"] = (path, options) =>
      options?.method === "POST"
        ? { id: "q1", status: "approved" }
        : {
            count: 2,
            data: [
              {
                id: "q1",
                kind: "emergency",
                status: "pending",
                expired: false,
                user_name: "HD Agent",
                user_uid: 962837,
                work_date: "2026-10-29",
                requested_at: "2026-10-29T09:00:00Z",
                shift_end: "18:00:00",
                completion_percent: 30,
                report_id: null,
                attendance_state: "checked_in",
                reason: "Family emergency",
                tasks_now: { due_count: 1, due_completed: 0 },
              },
              {
                id: "q2",
                kind: "early",
                status: "pending",
                expired: true,
                user_name: "Sara Agent",
                user_uid: 555111,
                work_date: "2026-10-28",
                requested_at: "2026-10-28T11:00:00Z",
                shift_end: "18:00:00",
                completion_percent: 100,
                report_id: "r2",
                attendance_state: "incomplete",
                tasks_now: {},
              },
            ],
          };
    open("/task-management?tab=requests");
    const emergency = await waitFor(() => {
      const heading = screen
        .getAllByText("Emergency checkout")
        .find((el) => el.tagName === "B");
      if (!heading) throw new Error("requests not loaded yet");
      return heading.closest("li");
    });
    const cards = [...emergency.parentElement.children];
    expect(emergency).toHaveTextContent("Reason: “Family emergency”");
    expect(emergency).toHaveTextContent("Not submitted");
    const expired = cards.find((c) => c.textContent.includes("Sara Agent"));
    expect(expired).toHaveTextContent("Expired");
    expect(
      within(expired).queryByRole("button", { name: "Approve" }),
    ).toBeNull();
    fireEvent.click(within(emergency).getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Approve emergency checkout?",
    });
    fireEvent.click(
      within(dialog).getByLabelText(/Waive today's daily report/),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(
        calls("POST", "/admin/tasks/checkout-requests/q1/decide"),
      ).toHaveLength(1),
    );
    expect(
      calls("POST", "/admin/tasks/checkout-requests/q1/decide")[0][1].body,
    ).toEqual({ decision: "approve", waive_report: true });
  });
  it("shows overdue daily reports to administrators", async () => {
    const owed = (extra) => ({
      user_id: agent.id,
      name: "Sara Agent",
      uid: 555111,
      active: true,
      work_date: "2026-10-27",
      tasks: 2,
      completion_percent: 50,
      can_still_submit: true,
      submit_until: "2026-11-03",
      report_waived: false,
      ...extra,
    });
    routes["/admin/tasks/missing-reports"] = () => ({
      count: 3,
      data: [
        owed(),
        owed({ name: "HD Agent", uid: 962837, report_waived: true }),
        owed({
          name: "Gone Agent",
          uid: 555222,
          active: false,
          work_date: "2026-10-20",
          can_still_submit: false,
        }),
      ],
    });
    routes["/admin/tasks/overview"] = () => ({
      date: "2026-10-29",
      rules_active: false,
      active_tasks: 1,
      assigned_today: 1,
      assignments: 2,
      completed: 1,
      pending: 1,
      average_percent: 75,
      reports_submitted: 1,
      agents_with_tasks: 2,
      reports_to_review: 1,
      missing_reports: [],
      pending_early: 0,
      pending_emergency: 0,
      overdue_reports: 3,
      people: [],
    });
    open("/task-management");
    expect(
      await screen.findByText(
        "3 daily reports from the last 7 days are overdue.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "See overdue reports" }),
    );
    const section = (
      await screen.findByRole("heading", { name: "Overdue reports" })
    ).closest("section");
    await within(section).findByText("Sara Agent");
    expect(section).toHaveTextContent("3 missing");
    expect(within(section).getAllByText(/^Can submit until /)).toHaveLength(1);
    expect(
      within(section).getByText("Waived by emergency approval"),
    ).toBeInTheDocument();
    expect(within(section).getByText("Window closed")).toBeInTheDocument();
    expect(section).toHaveTextContent("inactive");
    expect(calls("GET", "/admin/tasks/missing-reports")[0][0]).toBe(
      "/admin/tasks/missing-reports?",
    );
  });
  it("starts the checkout rules only from a chosen day", async () => {
    routes["/admin/tasks/settings"] = (path, options) =>
      options?.method === "PATCH"
        ? { rules_from: options.body.rules_from }
        : { rules_from: null, rules_active_today: false, today: "2026-10-29" };
    open("/task-management?tab=settings");
    expect(
      await screen.findByText(/Off\. Agents and staff check out as before\./),
    ).toBeInTheDocument();
    const date = screen.getByLabelText("Start the rules on");
    expect(date).toHaveAttribute("min", "2026-10-29");
    fireEvent.change(date, { target: { value: "2026-11-02" } });
    fireEvent.click(screen.getByRole("button", { name: "Save start date" }));
    await waitFor(() =>
      expect(calls("PATCH", "/admin/tasks/settings")[0][1].body).toEqual({
        rules_from: "2026-11-02",
      }),
    );
  });
});

describe("My attendance", () => {
  it("shows what checking out needs, for agents only", async () => {
    open("/attendance");
    const panel = await screen.findByRole("region", {
      name: "Checking out today",
    });
    expect(
      within(panel).getByRole("link", { name: "Submit Daily Report" }),
    ).toHaveAttribute("href", "/my-tasks#daily-report");
    mocks.user = { ...admin };
  });
  it("adds nothing while the rules are off", async () => {
    routes["/tasks/checkout"] = () =>
      checkout({ required: false, rules_active: false });
    open("/attendance");
    await screen.findByRole("heading", { name: /This month/ });
    expect(
      screen.queryByRole("region", { name: "Checking out today" }),
    ).toBeNull();
  });
});
