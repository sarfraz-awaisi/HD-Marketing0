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
import { firstCallState, lateBy } from "../src/lib/firstCall";
// Update 038 screens: admin review list, team calling, agent call queue,
// first-call lead filter and working hours.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = {
  id: "c1000000-0000-4000-8000-000000000001",
  uid: 674892,
  name: "Owner",
  role: "admin",
  active: true,
};
const ali = {
  id: "c1000000-0000-4000-8000-000000000002",
  uid: 775610,
  name: "Ali Agent",
  role: "agent",
  active: true,
};
const sara = {
  id: "c1000000-0000-4000-8000-000000000003",
  uid: 876679,
  name: "Sara Agent",
  role: "agent",
  active: true,
};
const late = {
  id: "c2000000-0000-4000-8000-000000000001",
  lead_no: 42,
  name: "Ayesha Khan",
  status: "new",
  assigned_agent: ali.id,
  agent_name: "Ali Agent",
  call_due_at: new Date(Date.now() - 3 * 3600000).toISOString(),
  last_activity_at: "2026-10-10T07:00:00Z",
};
const quiet = {
  ...late,
  id: "c2000000-0000-4000-8000-000000000002",
  lead_no: 43,
  name: "Bilal Ahmed",
};
const reviewPaths = () =>
  mocks.api.mock.calls.filter(([path]) => path.startsWith("/lead-review"));
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
  mocks.user = { ...admin };
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/users") return [admin, ali, sara];
    if (path.startsWith("/dashboard"))
      return {
        metrics: {
          total_leads: 3,
          first_calls: 4,
          first_calls_with_deadline: 4,
          on_time_first_calls: 3,
          avg_first_call_minutes: 95,
          uncalled_leads: 2,
          missed_first_calls: 1,
          by_status: {},
        },
        leaders: [],
        followups: [],
        visits: [],
        targets: [],
      };
    if (path.startsWith("/lead-review?kind=missed"))
      return {
        data: [late],
        count: 1,
        page: 1,
        limit: 10,
        idle_days: 7,
        counts: { missed: 1, idle: 1 },
      };
    if (path.startsWith("/lead-review?kind=idle"))
      return {
        data: [quiet],
        count: 1,
        page: 1,
        limit: 10,
        idle_days: 7,
        counts: { missed: 1, idle: 1 },
      };
    if (path === "/lead-review/keep")
      return { kept: options.body.lead_ids.length, skipped: 0, results: [] };
    if (path === "/lead-review/reassign")
      return {
        assigned: options.body.lead_ids.length,
        skipped: 0,
        failed: 0,
        results: [],
      };
    if (path === "/call-activity")
      return {
        date: "2026-10-19",
        is_workday: true,
        work_start: "00:00",
        work_end: "23:59",
        idle_days: 7,
        agents: [
          {
            agent_id: ali.id,
            name: "Ali Agent",
            calls_today: 0,
            connected_today: 0,
            first_calls_today: 0,
            waiting: 2,
            missed: 1,
            idle: 1,
            followups_overdue: 0,
          },
          {
            agent_id: sara.id,
            name: "Sara Agent",
            calls_today: 6,
            connected_today: 4,
            first_calls_today: 3,
            waiting: 0,
            missed: 0,
            idle: 0,
            followups_overdue: 2,
          },
        ],
      };
    if (path === "/first-call-queue")
      return {
        data: [{ ...late, missed: true }],
        waiting: 0,
        missed: 1,
      };
    if (path === "/notifications") return { data: [], unread: 0 };
    if (path === "/security-alerts/summary") return { count: 0 };
    if (path === "/settings/work-hours" && options?.method === "PUT")
      return { ...options.body, updated_at: "2026-10-19T05:00:00Z" };
    if (path === "/settings/work-hours")
      return {
        work_days: [1, 2, 3, 4, 5, 6],
        work_start: "10:00",
        work_end: "18:00",
        first_call_grace_minutes: 120,
        idle_days: 7,
        updated_at: "2026-10-17T05:00:00Z",
      };
    if (path === "/account-security") return { configured: true };
    if (path.startsWith("/leads?"))
      return {
        data: [{ ...late, email: null, source: "CSV", phone: "+923001234567" }],
        count: 1,
      };
    return { data: [], count: 0 };
  });
});

describe("first-call helpers", () => {
  it("labels called, waiting and missed leads", () => {
    const now = Date.parse("2026-10-19T12:00:00Z");
    expect(firstCallState({ first_call_at: "x" }, now)).toEqual({
      tone: "completed",
      label: "Called",
    });
    expect(
      firstCallState(
        { assigned_agent: "a", call_due_at: "2026-10-19T13:00:00Z" },
        now,
      ),
    ).toMatchObject({
      tone: "warning",
      label: expect.stringMatching(/^Call by /),
    });
    expect(
      firstCallState(
        { assigned_agent: "a", call_due_at: "2026-10-19T11:00:00Z" },
        now,
      ),
    ).toEqual({ tone: "overdue", label: "Missed first call" });
    expect(
      firstCallState({
        assigned_agent: "a",
        call_due_at: "2026-10-19T11:00:00Z",
        status: "won",
      }),
    ).toBeNull();
    expect(lateBy("2026-10-19T09:00:00Z", now)).toBe("3 hours late");
    expect(lateBy("2026-10-17T09:00:00Z", now)).toBe("2 days late");
  });
});

describe("admin review of missed first calls", () => {
  it("keeps or reassigns a lead only when the admin decides", async () => {
    open("/");
    const panel = (
      await screen.findByRole("heading", {
        name: "Leads waiting for your decision",
      })
    ).closest("section");
    expect(await within(panel).findByText("Ayesha Khan")).toBeInTheDocument();
    expect(within(panel).getByText("3 hours late")).toBeInTheDocument();
    expect(
      within(panel).getByRole("tab", { name: "Missed first call 1" }),
    ).toHaveAttribute("aria-selected", "true");
    // Nothing is decided until the admin acts.
    expect(
      mocks.api.mock.calls.some(([, options]) => options?.method === "POST"),
    ).toBe(false);
    fireEvent.click(within(panel).getByRole("button", { name: "Keep" }));
    await screen.findByText("1 kept with their agent");
    expect(
      mocks.api.mock.calls.find(([path]) => path === "/lead-review/keep")[1]
        .body,
    ).toEqual({ lead_ids: [late.id], kind: "missed" });
    const reassign = within(panel).getByRole("combobox", {
      name: "Reassign Ayesha Khan",
    });
    // The current owner is not offered as a new owner.
    expect(
      within(reassign).queryByRole("option", { name: "Ali Agent" }),
    ).toBeNull();
    fireEvent.change(reassign, { target: { value: sara.id } });
    await screen.findByText("1 reassigned");
    fireEvent.change(reassign, { target: { value: "unassigned" } });
    await waitFor(() =>
      expect(
        mocks.api.mock.calls.filter(
          ([path]) => path === "/lead-review/reassign",
        ),
      ).toHaveLength(2),
    );
    expect(
      mocks.api.mock.calls
        .filter(([path]) => path === "/lead-review/reassign")
        .map(([, options]) => options.body),
    ).toEqual([
      { lead_ids: [late.id], kind: "missed", mode: "agent", agent_id: sara.id },
      { lead_ids: [late.id], kind: "missed", mode: "unassign" },
    ]);
  });
  it("switches to quiet leads and decides for a selection", async () => {
    open("/?review=idle");
    const panel = (
      await screen.findByRole("heading", {
        name: "Leads waiting for your decision",
      })
    ).closest("section");
    expect(await within(panel).findByText("Bilal Ahmed")).toBeInTheDocument();
    expect(reviewPaths()[0][0]).toContain("kind=idle");
    fireEvent.click(
      within(panel).getByRole("checkbox", { name: "Select Bilal Ahmed" }),
    );
    fireEvent.change(
      within(panel).getByRole("combobox", {
        name: "Reassign selected leads to",
      }),
      { target: { value: ali.id } },
    );
    fireEvent.click(
      within(panel).getByRole("button", { name: "Reassign selected" }),
    );
    await screen.findByText("1 reassigned");
    expect(
      mocks.api.mock.calls.find(([path]) => path === "/lead-review/reassign")[1]
        .body,
    ).toEqual({
      lead_ids: [quiet.id],
      kind: "idle",
      mode: "agent",
      agent_id: ali.id,
    });
    fireEvent.click(
      within(panel).getByRole("tab", { name: "Missed first call 1" }),
    );
    expect(await within(panel).findByText("Ayesha Khan")).toBeInTheDocument();
  });
  it("shows each agent's calling today and first-call measures", async () => {
    open("/");
    const table = (
      await screen.findByRole("heading", { name: "Today's calling" })
    ).closest("section");
    const aliRow = (await within(table).findByText("Ali Agent")).closest("tr");
    expect(within(aliRow).getByText("No calls yet today")).toBeInTheDocument();
    const saraRow = within(table).getByText("Sara Agent").closest("tr");
    expect(within(saraRow).getByText("6 (4 answered)")).toBeInTheDocument();
    expect(within(saraRow).queryByText("No calls yet today")).toBeNull();
    expect(screen.getByText("75%")).toBeInTheDocument();
    expect(screen.getByText("1 h 35 min")).toBeInTheDocument();
  });
});

describe("agent call queue", () => {
  it("lists leads to call without loading contact numbers", async () => {
    mocks.user = { ...ali };
    open("/");
    const panel = (
      await screen.findByRole("heading", { name: "My calls today" })
    ).closest("section");
    expect(
      await within(panel).findByText("HD-000042 · Ayesha Khan"),
    ).toBeInTheDocument();
    expect(within(panel).getByText("Missed first call")).toBeInTheDocument();
    expect(
      within(panel).getByRole("link", { name: "All leads to call ↗" }),
    ).toHaveAttribute("href", "/leads?view=all&call=uncalled");
    expect(
      mocks.api.mock.calls.some(([path]) => path.startsWith("/leads?")),
    ).toBe(false);
    expect(reviewPaths()).toEqual([]);
  });
  it("filters the lead list by first-call state", async () => {
    mocks.user = { ...ali };
    open("/leads?view=all&call=missed");
    expect(await screen.findByText("Missed first call")).toBeInTheDocument();
    const first = mocks.api.mock.calls.find(([path]) =>
      path.startsWith("/leads?"),
    )[0];
    const query = new URLSearchParams(first.split("?")[1]);
    expect(Object.fromEntries(query)).toMatchObject({
      call: "missed",
      sort: "call_due_at",
      direction: "asc",
    });
    fireEvent.change(
      screen.getByRole("combobox", { name: "Filter by first call" }),
      { target: { value: "" } },
    );
    await waitFor(() =>
      expect(
        mocks.api.mock.calls.some(
          ([path]) => path.startsWith("/leads?") && !path.includes("call="),
        ),
      ).toBe(true),
    );
  });
});

describe("working hours", () => {
  it("validates and saves the working days and hours", async () => {
    open("/settings/security");
    const form = (
      await screen.findByRole("heading", {
        name: "Working hours and first calls",
      })
    ).closest("section");
    const sunday = await within(form).findByRole("checkbox", { name: "Sun" });
    expect(sunday).not.toBeChecked();
    expect(within(form).getByRole("checkbox", { name: "Sat" })).toBeChecked();
    fireEvent.change(within(form).getByLabelText("Day ends"), {
      target: { value: "09:00" },
    });
    fireEvent.click(
      within(form).getByRole("button", { name: "Save working hours" }),
    );
    expect(await within(form).findByRole("alert")).toHaveTextContent(
      "The working day must end after it starts.",
    );
    fireEvent.change(within(form).getByLabelText("Day ends"), {
      target: { value: "18:30" },
    });
    fireEvent.click(sunday);
    fireEvent.click(
      within(form).getByRole("button", { name: "Save working hours" }),
    );
    await screen.findByText(
      "Working hours saved. New deadlines use them from now on.",
    );
    expect(
      mocks.api.mock.calls.find(
        ([path, options]) =>
          path === "/settings/work-hours" && options?.method === "PUT",
      )[1].body,
    ).toEqual({
      work_days: [1, 2, 3, 4, 5, 6, 7],
      work_start: "10:00",
      work_end: "18:30",
      first_call_grace_minutes: 120,
      idle_days: 7,
    });
  });
});
