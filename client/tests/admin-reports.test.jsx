import React from "react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import { dayRange, periodDays, periodOf } from "../src/lib/periods";
// Update 063: report periods, the dashboard's open pipeline and Not
// connected tile, and Today's calling numbers that open the team records.
// API responses are mocked; the server tests check the counting rules.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = {
  id: "c6300000-0000-4000-8000-000000000001",
  uid: 600001,
  name: "Owner",
  role: "admin",
  active: true,
};
const ali = {
  id: "c6300000-0000-4000-8000-000000000002",
  uid: 600002,
  name: "Ali Agent",
  role: "agent",
  active: true,
};
const sara = {
  id: "c6300000-0000-4000-8000-000000000003",
  uid: 600003,
  name: "Sara Agent",
  role: "agent",
  active: true,
};
const today = {
  date: "2026-11-13",
  is_workday: true,
  work_start: "00:00",
  work_end: "23:59",
  idle_days: 7,
  from: "2026-11-12T19:00:00Z",
  to: "2026-11-13T19:00:00Z",
  agents: [
    {
      agent_id: ali.id,
      name: "Ali Agent",
      received_today: 17,
      calls_today: 6,
      connected_today: 5,
      leads_called_today: 5,
      admin_calls_today: 1,
      first_calls_today: 4,
      waiting: 3,
      missed: 2,
      not_connected: 4,
      idle: 0,
      followups_overdue: 0,
    },
    {
      agent_id: sara.id,
      name: "Sara Agent",
      received_today: 0,
      calls_today: 0,
      connected_today: 0,
      leads_called_today: 0,
      admin_calls_today: 0,
      first_calls_today: 0,
      waiting: 0,
      missed: 1,
      not_connected: 2,
      idle: 0,
      followups_overdue: 0,
    },
  ],
};
const original = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
});
afterAll(() => {
  if (original)
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", original);
  else delete HTMLDialogElement.prototype.showModal;
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user = { ...admin };
  mocks.api.mockImplementation(async (path) => {
    if (path === "/users") return [admin, ali, sara];
    if (path.startsWith("/dashboard"))
      return {
        metrics: {
          total_leads: 40,
          first_calls: 4,
          first_calls_with_deadline: 4,
          on_time_first_calls: 3,
          uncalled_leads: 3,
          missed_first_calls: 3,
          // Created this month: only one; open now: many more.
          by_status: { new: 1 },
          leads: 1,
          open_by_status: { new: 9, contacted: 5, interested: 2 },
        },
        leaders: [],
        followups: [],
        visits: [],
        targets: [],
      };
    if (path === "/call-activity") return today;
    if (path.startsWith("/lead-review?"))
      return {
        data: [],
        count: 0,
        page: 1,
        limit: 10,
        idle_days: 7,
        counts: { missed: 0, idle: 0 },
      };
    if (path.startsWith("/reports/team/records?"))
      return { metric: "received", count: 0, page: 1, limit: 25, data: [] };
    if (path === "/notifications") return { data: [], unread: 0 };
    if (path === "/security-alerts/summary") return { count: 0 };
    return { data: [], count: 0 };
  });
});
function open(path) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("report periods", () => {
  // Friday 13 November 2026, 03:30 in Pakistan (22:30 UTC on the 12th).
  const now = Date.parse("2026-11-12T22:30:00Z");
  it("names Pakistan days, weeks from Sunday to Saturday, and months", () => {
    expect(periodDays("today", now)).toEqual({
      from: "2026-11-13",
      to: "2026-11-13",
    });
    expect(periodDays("yesterday", now)).toEqual({
      from: "2026-11-12",
      to: "2026-11-12",
    });
    expect(periodDays("this_week", now)).toEqual({
      from: "2026-11-08",
      to: "2026-11-13",
    });
    expect(periodDays("last_week", now)).toEqual({
      from: "2026-11-01",
      to: "2026-11-07",
    });
    expect(periodDays("this_month", now)).toEqual({
      from: "2026-11-01",
      to: "2026-11-13",
    });
    expect(periodDays("last_month", now)).toEqual({
      from: "2026-10-01",
      to: "2026-10-31",
    });
    // A Sunday starts its own week.
    expect(periodDays("this_week", Date.parse("2026-11-15T10:00:00Z"))).toEqual(
      {
        from: "2026-11-15",
        to: "2026-11-15",
      },
    );
    expect(periodOf("2026-11-08", "2026-11-13", now)).toBe("this_week");
    expect(periodOf("2026-11-02", "2026-11-13", now)).toBe("custom");
  });
  it("covers Pakistan midnight to midnight", () => {
    expect(dayRange("2026-11-12", "2026-11-12")).toEqual({
      from: "2026-11-11T19:00:00.000Z",
      to: "2026-11-12T19:00:00.000Z",
    });
  });
});

describe("the administrator's dashboard (update 063)", () => {
  it("shows every open lead by stage, and Not connected beside Missed first calls", async () => {
    open("/");
    const pipeline = (
      await screen.findByRole("heading", { name: "Lead pipeline" })
    ).closest("section");
    expect(pipeline).toHaveTextContent("All open leads now, by current stage");
    expect(pipeline).not.toHaveTextContent(/won/i);
    const counts = [...pipeline.querySelectorAll(".pipeline-row b")].map(
      (b) => b.textContent,
    );
    expect(counts.slice(0, 3)).toEqual(["9", "5", "2"]);
    const tile = (await screen.findByText("Not connected (overdue)")).closest(
      "a",
    );
    expect(tile).toHaveAttribute("href", "/leads?view=all&call=not_connected");
    expect(tile).toHaveTextContent("6");
  });
  it("shows leads received and called today, and an admin's calls apart, each opening its records", async () => {
    open("/");
    const table = (
      await screen.findByRole("heading", { name: "Today's calling" })
    ).closest("section");
    const row = within(table).getByRole("row", { name: /Ali Agent/ });
    expect(row).toHaveTextContent("17");
    expect(row).toHaveTextContent("6 (5 answered)");
    expect(row).toHaveTextContent("+ 1 by an admin");
    fireEvent.click(
      within(row).getByRole("button", {
        name: "Ali Agent: leads received today: 17. Show the records",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Leads received · Ali Agent",
    });
    expect(dialog).toBeInTheDocument();
    const path = mocks.api.mock.calls
      .map(([p]) => p)
      .find((p) => p.startsWith("/reports/team/records?"));
    expect(
      Object.fromEntries(new URLSearchParams(path.split("?")[1])),
    ).toMatchObject({
      metric: "received",
      agent: ali.id,
      from: today.from,
      to: today.to,
    });
  });
});
