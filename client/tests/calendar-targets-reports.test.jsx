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
import {
  addMonths,
  periodLabel,
  periodRange,
  periodStart,
  startOfWeek,
} from "../src/lib/calendar";
// Update 039 screens: visit calendar, period targets and reports.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = {
  id: "d1000000-0000-4000-8000-000000000001",
  uid: 674892,
  name: "Owner",
  role: "admin",
  active: true,
};
const ali = {
  id: "d1000000-0000-4000-8000-000000000002",
  uid: 775610,
  name: "Ali Agent",
  role: "agent",
  active: true,
};
const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const at = (time) => new Date(`${today}T${time}:00+05:00`).toISOString();
const lead = {
  id: "d2000000-0000-4000-8000-000000000001",
  lead_no: 42,
  name: "Ayesha Khan",
  assigned_agent: ali.id,
};
const visits = [
  {
    id: "v1",
    lead_id: lead.id,
    lead_no: 42,
    lead_name: "Ayesha Khan",
    property_title: "Gulberg House",
    agent_id: ali.id,
    agent_name: "Ali Agent",
    scheduled_at: at("11:00"),
    status: "scheduled",
  },
  {
    id: "v2",
    lead_id: lead.id,
    lead_no: 43,
    lead_name: "Bilal Ahmed",
    property_title: "DHA Plot",
    agent_id: ali.id,
    agent_name: "Ali Agent",
    scheduled_at: at("15:30"),
    status: "completed",
  },
];
const calls = (prefix) =>
  mocks.api.mock.calls.filter(([path]) => path.startsWith(prefix));
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
  // jsdom has no modal dialogs; open them as plain dialogs.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  mocks.user = { ...admin };
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/users") return [admin, ali];
    if (path.startsWith("/visits/calendar")) return visits;
    if (path.startsWith("/visits/conflicts"))
      return { agent_id: ali.id, conflicts: [{ ...visits[0], id: "v1" }] };
    if (path.startsWith("/leads?")) return { data: [lead], count: 1 };
    if (path.startsWith("/properties?"))
      return { data: [{ id: "p1", title: "Gulberg House" }], count: 1 };
    if (path === "/targets/copy") return { copied: 2, skipped: 0, from: "x" };
    if (path === "/targets" && options?.method === "POST")
      return { id: "t9", ...options.body };
    if (path.startsWith("/targets?"))
      return {
        data: [
          {
            id: "t1",
            agent_id: ali.id,
            agent_name: "Ali Agent",
            period: "week",
            period_start: startOfWeek(today),
            calls: 20,
            leads_contacted: 30,
            followups_completed: 0,
            visits: 0,
            deals: 0,
            revenue: 0,
          },
        ],
        count: 1,
      };
    if (path.startsWith("/reports/sources?"))
      return [
        {
          source: "CSV",
          leads: 10,
          contacted: 8,
          visited: 3,
          won: 2,
          lost: 1,
          revenue: 7500000,
        },
        {
          source: "Meta",
          leads: 4,
          contacted: 1,
          visited: 0,
          won: 0,
          lost: 0,
          revenue: 0,
        },
      ];
    if (path.startsWith("/reports/funnel?"))
      return {
        total: 10,
        lost: 2,
        stages: [
          { stage: "new", reached: 10 },
          { stage: "contacted", reached: 8 },
          { stage: "interested", reached: 4 },
          { stage: "visit_scheduled", reached: 3 },
          { stage: "visit_done", reached: 2 },
          { stage: "negotiation", reached: 1 },
          { stage: "won", reached: 1 },
        ],
      };
    if (path.startsWith("/reports/lost?"))
      return {
        total: 2,
        by_reason: [{ reason: "price", count: 2 }],
        by_source: [{ source: "CSV", count: 2 }],
        by_agent: [{ agent_id: ali.id, name: "Ali Agent", count: 2 }],
      };
    if (path.startsWith("/reports?"))
      return { completed_calls: 12, leads_contacted: 18, revenue: 0 };
    if (path === "/notifications") return { data: [], unread: 0 };
    return { data: [], count: 0 };
  });
});

describe("calendar dates", () => {
  it("computes Pakistan periods", () => {
    expect(startOfWeek("2026-10-21")).toBe("2026-10-19");
    expect(periodStart("month", "2026-10-21")).toBe("2026-10-01");
    expect(addMonths("2026-12-01", 1)).toBe("2027-01-01");
    expect(periodRange("week", "2026-10-19")).toEqual({
      from: "2026-10-18T19:00:00.000Z",
      to: "2026-10-25T19:00:00.000Z",
    });
    expect(periodLabel("month", "2026-10-01")).toBe("October 2026");
  });
});

describe("site visit calendar", () => {
  it("shows the week and month in Pakistan time and moves between them", async () => {
    open("/visits?view=calendar");
    expect(
      await screen.findByText("Ayesha Khan", { exact: false }),
    ).toBeInTheDocument();
    const first = new URLSearchParams(
      calls("/visits/calendar")[0][0].split("?")[1],
    );
    expect(first.get("from")).toBe(
      periodRange("week", startOfWeek(today)).from,
    );
    const card = screen.getByText("HD-000042 · Ayesha Khan").closest("a");
    expect(card).toHaveAttribute("href", "/leads/" + lead.id);
    expect(
      within(card).getByText("Gulberg House · Ali Agent"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(calls("/visits/calendar")).toHaveLength(2));
    fireEvent.click(screen.getByRole("tab", { name: "Month" }));
    const cell = await screen.findByRole("button", { name: /, 2 visits$/ });
    fireEvent.click(cell);
    expect(cell).toHaveAttribute("aria-pressed", "true");
    fireEvent.change(screen.getByRole("combobox", { name: "Calendar agent" }), {
      target: { value: ali.id },
    });
    await waitFor(() =>
      expect(calls("/visits/calendar").at(-1)[0]).toContain("agent=" + ali.id),
    );
    fireEvent.click(screen.getByRole("tab", { name: "List" }));
    expect(
      await screen.findByRole("combobox", { name: "Filter records" }),
    ).toBeInTheDocument();
  });
  it("warns about an overlapping visit while scheduling", async () => {
    open("/visits?view=calendar");
    fireEvent.click(await screen.findByRole("button", { name: "+ Add visit" }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(
        within(dialog).getByRole("option", { name: "HD-000042 · Ayesha Khan" }),
      ).toBeInTheDocument(),
    );
    fireEvent.change(within(dialog).getByLabelText(/^Lead/), {
      target: { value: lead.id },
    });
    fireEvent.change(
      within(dialog).getByLabelText("Date and time (Asia/Karachi)"),
      {
        target: { value: `${today}T11:30` },
      },
    );
    expect(
      await within(dialog).findByText(
        /Ali Agent already has a visit within an hour/,
      ),
    ).toBeInTheDocument();
    const query = new URLSearchParams(
      calls("/visits/conflicts").at(-1)[0].split("?")[1],
    );
    expect(query.get("lead_id")).toBe(lead.id);
    expect(query.get("at")).toBe(
      new Date(`${today}T11:30:00+05:00`).toISOString(),
    );
  });
});

describe("period targets", () => {
  it("switches periods, copies the previous period and sets a target", async () => {
    open("/targets");
    expect(
      await screen.findByRole("heading", { name: "Team targets" }),
    ).toBeInTheDocument();
    expect(calls("/targets?")[0][0]).toContain("period=month");
    fireEvent.click(screen.getByRole("tab", { name: "Weekly" }));
    expect(await screen.findByText("Leads contacted")).toBeInTheDocument();
    expect(screen.getByText("18 / 30")).toBeInTheDocument();
    // Goals left at 0 are not shown.
    expect(screen.queryByText("Won deals")).toBeNull();
    const week = new URLSearchParams(
      calls("/targets?").at(-1)[0].split("?")[1],
    );
    expect(week.get("period")).toBe("week");
    expect(week.get("start")).toBe(startOfWeek(today));
    const metrics = new URLSearchParams(
      calls("/reports?").at(-1)[0].split("?")[1],
    );
    expect(metrics.get("from")).toBe(
      periodRange("week", startOfWeek(today)).from,
    );
    expect(metrics.get("agent")).toBe(ali.id);
    fireEvent.click(screen.getByRole("button", { name: "Copy previous week" }));
    await screen.findByText("2 targets copied from the previous week");
    expect(
      mocks.api.mock.calls.find(([p]) => p === "/targets/copy")[1].body,
    ).toEqual({
      period: "week",
      start: startOfWeek(today),
    });
    fireEvent.click(screen.getByRole("button", { name: "+ Set target" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Set weekly target",
    });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Agent" }), {
      target: { value: ali.id },
    });
    fireEvent.change(within(dialog).getByLabelText("Leads contacted"), {
      target: { value: "40" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save record" }),
    );
    await screen.findByText("Target saved");
    expect(
      mocks.api.mock.calls.find(
        ([p, o]) => p === "/targets" && o?.method === "POST",
      )[1].body,
    ).toEqual({
      agent_id: ali.id,
      period: "week",
      period_start: startOfWeek(today),
      calls: 0,
      leads_contacted: 40,
      followups_completed: 0,
      visits: 0,
      deals: 0,
      revenue: 0,
    });
  });
  it("shows an agent the targets running today on the overview", async () => {
    mocks.user = { ...ali };
    open("/");
    const panel = (
      await screen.findByRole("heading", { name: "My targets now" })
    ).closest("section");
    expect(
      await within(panel).findByText("Leads contacted"),
    ).toBeInTheDocument();
    expect(calls("/targets?")[0][0]).toContain("current=true");
  });
});

describe("reports", () => {
  it("shows source, funnel and lost-reason reports and exports the open tab", async () => {
    open("/reports");
    fireEvent.click(await screen.findByRole("tab", { name: "Lead sources" }));
    const row = (await screen.findByText("CSV / Excel")).closest("tr");
    expect(within(row).getByText("20%")).toBeInTheDocument();
    // The source filter does not apply to the sources report.
    expect(
      screen.queryByRole("combobox", { name: "Report source" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Sales funnel" }));
    expect(
      await screen.findByText("80% of all · 80% of previous"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Lost reasons" }));
    expect(await screen.findByText("Price")).toBeInTheDocument();
    mocks.api.mockImplementationOnce(async () => new Blob(["x"]));
    globalThis.URL.createObjectURL = vi.fn(() => "blob:x");
    globalThis.URL.revokeObjectURL = vi.fn();
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() => expect(calls("/reports/lost/export?")).toHaveLength(1));
  });
});
