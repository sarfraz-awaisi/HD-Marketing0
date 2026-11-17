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
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import Reports from "../src/pages/admin/Reports";
import {
  drillInfo,
  relatedNumbers,
  reportNumber,
} from "../src/lib/reportDrilldown";
// Report drill-down (update 050). API responses are mocked;
// server/tests/report-drilldown.test.js checks the records against each
// report in the database.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));
const admin = {
    id: "a0000000-0000-4000-8000-000000000001",
    name: "Owner",
    role: "admin",
  },
  ali = {
    id: "a0000000-0000-4000-8000-000000000002",
    name: "Ali Agent",
    role: "agent",
  },
  sara = {
    id: "a0000000-0000-4000-8000-000000000003",
    name: "Sara Agent",
    role: "agent",
  };
const originalDialog = Object.getOwnPropertyDescriptor(
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
  if (originalDialog)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      originalDialog,
    );
  else delete HTMLDialogElement.prototype.showModal;
});
const funnel = {
  total: 104,
  lost: 9,
  stages: [
    ["new", 104],
    ["contacted", 41],
    ["interested", 20],
    ["visit_scheduled", 9],
    ["visit_done", 6],
    ["negotiation", 3],
    ["won", 2],
  ].map(([stage, reached]) => ({ stage, reached })),
};
const call = {
  id: "c1",
  started_at: "2026-11-05T09:35:00Z",
  status: "completed",
  outcome: "Follow-up required",
  duration_seconds: 240,
  recorded_agent: { id: ali.id, name: "Ali Agent", role: "agent" },
  caller: { id: sara.id, name: "Sara Agent", role: "agent" },
};
const leadRow = (n, extra = {}) => ({
  id: "l" + n,
  kind: "lead",
  reason: "contacted",
  lead: {
    id: "l" + n,
    number: "HD-" + String(n).padStart(6, "0"),
    name: "Buyer " + n,
    masked_phone: "+92******" + String(n).padStart(3, "0").slice(-3),
    source: "Meta",
    status: "contacted",
    created_at: "2026-11-02T06:00:00Z",
    last_activity_at: "2026-11-05T09:40:00Z",
    assigned_agent: { id: ali.id, name: "Ali Agent", role: "agent" },
  },
  last_call: null,
  calls: 0,
  ...extra,
});
let drill;
const requests = () =>
  mocks.api.mock.calls
    .map(([path]) => path)
    .filter((p) => p.startsWith("/reports/drilldown?"))
    .map((p) => Object.fromEntries(new URLSearchParams(p.split("?")[1])));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = admin;
  drill = (params) => {
    const page = Number(params.page);
    return {
      report: params.report,
      metric: params.metric,
      kind: "lead",
      measure: "count",
      count: 41,
      leads: 41,
      records: 41,
      value: 41,
      page,
      limit: 25,
      ...(page === 1 ? { report_value: 41 } : {}),
      data: [
        leadRow(145, { last_call: call, calls: 3, temperature: "Warm lead" }),
        leadRow(146, {
          last_call: { ...call, id: "c2", caller: null },
          calls: 1,
        }),
        leadRow(147),
      ],
    };
  };
  mocks.api.mockImplementation(async (path) => {
    if (path === "/users") return [admin, ali, sara];
    if (path.startsWith("/reports/drilldown?"))
      return drill(Object.fromEntries(new URLSearchParams(path.split("?")[1])));
    if (path.startsWith("/reports/funnel?")) return funnel;
    if (path.startsWith("/reports/sources?"))
      return [
        {
          source: "Meta",
          leads: 10,
          contacted: 8,
          visited: 3,
          won: 2,
          lost: 1,
          revenue: 7500000,
        },
      ];
    if (path.startsWith("/reports/agents?"))
      return [
        {
          agent_id: ali.id,
          name: "Ali Agent",
          active: true,
          assigned: 12,
          first_calls: 10,
          on_time_first_calls: 8,
          first_calls_with_deadline: 9,
          avg_first_call_minutes: 20,
          missed_first_calls: 1,
          calls: 30,
          connected_calls: 22,
          talk_minutes: 90,
          visits_completed: 4,
          won_deals: 2,
          revenue: 100,
          lost: 3,
        },
      ];
    if (path.startsWith("/reports/lost?"))
      return {
        total: 3,
        by_reason: [{ reason: "price", count: 3 }],
        by_source: [{ source: "Meta", count: 3 }],
        by_agent: [{ agent_id: null, name: "Unassigned", count: 3 }],
      };
    if (path.startsWith("/reports?"))
      return {
        leads_contacted: 18,
        active_agents: 4,
        revenue: 0,
        by_status: { new: 7, contacted: 5 },
      };
    if (path.endsWith("/timeline"))
      return [
        {
          kind: "calls",
          id: "c1",
          started_at: call.started_at,
          outcome: "Follow-up required",
          status: "completed",
          actor_name: "Sara Agent",
          agent_name: "Ali Agent",
          created_at: call.started_at,
        },
        {
          kind: "calls",
          id: "c0",
          started_at: "2026-11-01T06:00:00Z",
          outcome: "No answer",
          status: "failed",
          actor_name: null,
          agent_name: "Ali Agent",
          created_at: "2026-11-01T06:00:00Z",
        },
        {
          kind: "notes",
          id: "n1",
          body: "Prefers DHA",
          created_at: "2026-11-01T06:00:00Z",
        },
      ];
    throw new Error("Unexpected request " + path);
  });
});
function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">{location.pathname + location.search}</output>
  );
}
function open(path = "/reports") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reports" element={<Reports />} />
          <Route path="/leads/:id" element={<p>Lead details page</p>} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const where = () => screen.getByTestId("where").textContent;
const funnelUrl = "/reports?tab=funnel&from=2026-11-01&to=2026-11-04";

describe("sales funnel drill-down", () => {
  it("opens every stage's leads with the report's own filters", async () => {
    open(funnelUrl + "&agent=" + ali.id + "&source=Meta");
    for (const [stage, label, count] of [
      ["new", "New", 104],
      ["contacted", "Contacted", 41],
      ["interested", "Interested", 20],
      ["visit_scheduled", "Site visit scheduled", 9],
      ["visit_done", "Visit done", 6],
      ["negotiation", "Negotiation", 3],
      ["won", "Won (booked)", 2],
    ]) {
      fireEvent.click(
        await screen.findByRole("button", {
          name: `${label}: ${count} leads. Show the leads`,
        }),
      );
      const dialog = await screen.findByRole("dialog");
      expect(
        within(dialog).getByRole("heading", { name: `${label} leads` }),
      ).toBeInTheDocument();
      await waitFor(() =>
        expect(requests().at(-1)).toMatchObject({
          report: "funnel",
          metric: "stage",
          key: stage,
        }),
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Close dialog" }),
      );
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    }
    // The same range, in Pakistan time, and the same agent and source.
    expect(requests()[0]).toEqual({
      report: "funnel",
      metric: "stage",
      key: "new",
      from: "2026-10-31T19:00:00.000Z",
      to: "2026-11-04T19:00:00.000Z",
      agent: ali.id,
      source: "Meta",
      page: "1",
      limit: "25",
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Lost: 9 leads. Show the leads" }),
    );
    await waitFor(() =>
      expect(requests().at(-1)).toMatchObject({ metric: "lost" }),
    );
    expect(requests().at(-1)).not.toHaveProperty("key");
  });
  it("shows each lead's assigned agent, who really called, and the latest call", async () => {
    open(funnelUrl + "&dm=stage&dk=contacted");
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText("Showing 1–25 of 41 leads"),
    ).toBeInTheDocument();
    const row = within(dialog)
      .getByRole("link", { name: "Open lead HD-000145 Buyer 145" })
      .closest("tr");
    expect(within(row).getByText("Ali Agent")).toBeInTheDocument();
    expect(
      within(row).getByText("Called by Sara Agent · filed under Ali Agent"),
    ).toBeInTheDocument();
    expect(
      within(row).getByText("Follow-up required · 4 min"),
    ).toBeInTheDocument();
    expect(within(row).getByText("Warm lead")).toBeInTheDocument();
    // Lists show the masked number; the full one is on the lead's page.
    expect(within(row).getByText("+92******145")).toBeInTheDocument();
    const unknown = within(dialog)
      .getByRole("link", { name: /HD-000146/ })
      .closest("tr");
    expect(
      within(unknown).getByText("Caller not recorded · filed under Ali Agent"),
    ).toBeInTheDocument();
    const none = within(dialog)
      .getByRole("link", { name: /HD-000147/ })
      .closest("tr");
    expect(within(none).getByText("No call recorded")).toBeInTheDocument();
    // Related stages switch the list in place.
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Interested 20" }),
    );
    await waitFor(() =>
      expect(requests().at(-1)).toMatchObject({ key: "interested" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Interested leads" }),
    ).toBeInTheDocument();
  });
  it("loads a lead's call history only when asked", async () => {
    open(funnelUrl + "&dm=stage&dk=contacted");
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", {
        name: "Call history for HD-000145",
      }),
    );
    const history = await within(dialog).findByRole("region", {
      name: "Call history for HD-000145",
    });
    expect(mocks.api).toHaveBeenCalledWith(
      "/leads/l145/timeline",
      expect.anything(),
    );
    expect(await within(history).findByText("Sara Agent")).toBeInTheDocument();
    expect(within(history).getByText("Not recorded")).toBeInTheDocument();
    expect(within(history).queryByText("Prefers DHA")).toBeNull();
  });
  it("opens the full lead details, and the address brings the list back", async () => {
    const view = open(funnelUrl + "&dm=stage&dk=contacted&dp=2");
    const dialog = await screen.findByRole("dialog");
    await waitFor(() =>
      expect(requests().at(-1)).toMatchObject({ page: "2", key: "contacted" }),
    );
    expect(
      within(dialog).getByRole("link", { name: /HD-000145/ }),
    ).toHaveAttribute("href", "/leads/l145");
    expect(where()).toBe(funnelUrl + "&dm=stage&dk=contacted&dp=2");
    fireEvent.click(within(dialog).getByRole("link", { name: /HD-000145/ }));
    expect(await screen.findByText("Lead details page")).toBeInTheDocument();
    view.unmount();
  });
});

describe("the report's address", () => {
  it("keeps every change when two happen before the page updates", async () => {
    open("/reports");
    const tab = await screen.findByRole("tab", { name: "Sales funnel" });
    const from = screen.getByLabelText("From");
    // A tab and a date chosen in quick succession, as a fast user might.
    act(() => {
      fireEvent.click(tab);
      fireEvent.change(from, { target: { value: "2026-10-15" } });
    });
    await waitFor(() => expect(where()).toContain("tab=funnel"));
    expect(where()).toContain("from=2026-10-15");
    await waitFor(() =>
      expect(
        mocks.api.mock.calls.some(([p]) =>
          p.startsWith("/reports/funnel?from=2026-10-14T19%3A00%3A00.000Z"),
        ),
      ).toBe(true),
    );
  });
});

describe("searching, sorting and paging", () => {
  it("narrows on the server and keeps the full count", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open(funnelUrl + "&dm=stage&dk=contacted");
      const dialog = await screen.findByRole("dialog");
      await within(dialog).findByText("Showing 1–25 of 41 leads");
      fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
      await waitFor(() =>
        expect(requests().at(-1)).toMatchObject({ page: "2" }),
      );
      fireEvent.change(
        within(dialog).getByRole("searchbox", { name: "Search these records" }),
        {
          target: { value: "HD-000145" },
        },
      );
      await act(() => vi.advanceTimersByTimeAsync(400));
      await waitFor(() =>
        expect(requests().at(-1)).toMatchObject({
          search: "HD-000145",
          page: "1",
        }),
      );
      fireEvent.change(
        within(dialog).getByRole("combobox", { name: "Current status" }),
        { target: { value: "lost" } },
      );
      fireEvent.change(
        within(dialog).getByRole("combobox", { name: "Assigned agent" }),
        { target: { value: "none" } },
      );
      fireEvent.change(
        within(dialog).getByRole("combobox", { name: "Sort by" }),
        { target: { value: "call" } },
      );
      await waitFor(() =>
        expect(requests().at(-1)).toMatchObject({
          search: "HD-000145",
          status: "lost",
          owner: "none",
          sort: "call",
        }),
      );
      expect(where()).toContain("dq=HD-000145");
      expect(
        within(dialog).getByText(/\(narrowed from 41\)/),
      ).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
  it("warns if the records and the report's number ever disagree", async () => {
    drill = (params) => ({
      kind: "lead",
      measure: "count",
      count: 40,
      leads: 40,
      records: 40,
      value: 40,
      report_value: 41,
      page: 1,
      limit: 25,
      data: [],
      ...params.x,
    });
    open(funnelUrl + "&dm=stage&dk=contacted");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "These records add up to 40, but the report works out 41.",
    );
  });
  it("says when the report changed after it loaded", async () => {
    drill = () => ({
      kind: "lead",
      measure: "count",
      count: 43,
      leads: 43,
      records: 43,
      value: 43,
      report_value: 43,
      page: 1,
      limit: 25,
      data: [],
    });
    open(funnelUrl + "&dm=stage&dk=contacted");
    expect(
      await screen.findByText(
        /The report showed 41 when it loaded; it is 43 now/,
      ),
    ).toBeInTheDocument();
  });
});

describe("other reports", () => {
  it("opens summary numbers, and explains numbers that have no lead list", async () => {
    open("/reports?from=2026-11-01&to=2026-11-04&source=Meta");
    // Each number is a tile with its name and a note; the tile opens it.
    const tile = await screen.findByRole("button", {
      name: "Contacted leads: 18. Show the records",
    });
    expect(tile).toHaveTextContent(
      "Contacted leads18Called at least once in this period",
    );
    fireEvent.click(tile);
    await waitFor(() =>
      expect(requests().at(-1)).toMatchObject({
        report: "summary",
        metric: "leads_contacted",
        source: "Meta",
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Contacted leads" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Contacted: 5. Show the leads",
      }),
    );
    await waitFor(() =>
      expect(requests().at(-1)).toMatchObject({
        metric: "by_status",
        key: "contacted",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    const count = requests().length;
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Active agents: 4. Show the records",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/counts active agent accounts, not leads/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("link", { name: "Open employee management" }),
    ).toHaveAttribute("href", "/team");
    expect(requests()).toHaveLength(count);
  });
  it("lays the summary out in boxes: the period, first calls, what needs attention now and totals", async () => {
    const base = mocks.api.getMockImplementation();
    mocks.api.mockImplementation(async (path, options) =>
      path.startsWith("/reports?")
        ? {
            leads: 30,
            leads_contacted: 18,
            completed_calls: 40,
            completed_visits: 2,
            followups_completed: 11,
            won_deals: 1,
            revenue: 2500000,
            first_calls: 9,
            on_time_first_calls: 8,
            first_calls_with_deadline: 10,
            missed_in_period: 1,
            avg_first_call_minutes: 75,
            missed_first_calls: 3,
            uncalled_leads: 4,
            overdue_followups: 5,
            due_followups: 6,
            scheduled_visits: 7,
            today_completed_calls: 8,
            total_leads: 1234567,
            assigned_leads: 60,
            active_agents: 4,
            deleted_today: 0,
            by_status: { new: 20, contacted: 10 },
            by_source: { manual: 12, Meta: 18 },
            open_by_status: { new: 50, contacted: 25 },
          }
        : base(path, options),
    );
    open("/reports?from=2026-11-01&to=2026-11-04");
    const box = async (name) =>
      (await screen.findByRole("heading", { name })).closest("section");
    const period = await box("This period");
    expect(period).toHaveTextContent(
      "1 Nov 2026 – 4 Nov 2026 · All agents · All sources",
    );
    expect(
      within(period)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "Leads created: 30. Show the records",
      "Contacted leads: 18. Show the records",
      "Completed calls: 40. Show the records",
      "Completed follow-ups: 11. Show the records",
      "Completed visits: 2. Show the records",
      "Won deals: 1. Show the records",
      // The amount as the CRM formats rupees.
      expect.stringMatching(
        /^Won revenue: Rs\s?2,?500,000\. Show the records$/,
      ),
    ]);
    const first = await box("First-call performance");
    expect(
      within(first).getByRole("button", {
        name: "First calls with a deadline: 10. Show the records",
      }),
    ).toBeInTheDocument();
    expect(first).toHaveTextContent("80%");
    expect(first).toHaveTextContent("8 of 10 with a deadline");
    expect(first).toHaveTextContent("1 h 15 min");
    // Live numbers are apart, and say the dates do not change them.
    const now = await box("Needs attention now");
    expect(now).toHaveTextContent(
      "Live: the dates above do not change these; the agent and source filters do",
    );
    for (const label of [
      "Missed first calls: 3",
      "Waiting for a first call: 4",
      "Overdue follow-ups: 5",
      "Follow-ups due: 6",
      "Upcoming visits: 7",
      "Calls completed today: 8",
    ])
      expect(
        within(now).getByRole("button", {
          name: `${label}. Show the records`,
        }),
      ).toBeInTheDocument();
    // One lead total (the filtered count was the same number), with large
    // numbers grouped; the whole-CRM numbers say so.
    const totals = await box("Totals");
    expect(
      within(totals)
        .getAllByRole("button")
        .map((b) => b.getAttribute("aria-label")),
    ).toEqual([
      "All leads: 1,234,567. Show the records",
      "Active agents: 4. Show the records",
      "Leads deleted today: 0. Show the records",
    ]);
    expect(totals).toHaveTextContent(
      "Whole CRM: agent accounts that can sign in",
    );
    // The on-time tile opens its first calls.
    fireEvent.click(
      within(first).getByRole("button", {
        name: "On-time first calls: 8 of 10. Show the records",
      }),
    );
    await waitFor(() =>
      expect(requests().at(-1)).toMatchObject({
        report: "summary",
        metric: "on_time_first_calls",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    // Sources, largest first, and the way to the full source report.
    const sources = (
      await screen.findByRole("heading", {
        name: "Leads created in this period, by source",
      })
    ).closest("section");
    expect(sources).toHaveTextContent("Meta18Manual12");
    // The definitions are folded away until asked for.
    expect(
      screen.getByText("How these numbers are counted").closest("details"),
    ).not.toHaveAttribute("open");
    fireEvent.click(
      within(sources).getByRole("button", {
        name: "Open the Lead sources report",
      }),
    );
    await waitFor(() => expect(where()).toContain("tab=sources"));
  });
  it("opens a source's numbers without the source filter the report ignores", async () => {
    open(
      "/reports?tab=sources&from=2026-11-01&to=2026-11-04&source=CSV&agent=" +
        sara.id,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Meta Contacted: 8. Show the records",
      }),
    );
    await waitFor(() =>
      expect(requests().at(-1)).toMatchObject({
        report: "sources",
        metric: "contacted",
        key: "Meta",
        agent: sara.id,
      }),
    );
    expect(requests().at(-1)).not.toHaveProperty("source");
    expect(
      await screen.findByRole("heading", { name: "Meta: Contacted" }),
    ).toBeInTheDocument();
  });
  it("opens Team performance in place of Agents, every number with its records (update 063)", async () => {
    const teamRow = {
      agent_id: ali.id,
      name: "Ali Agent",
      active: true,
      received: 12,
      received_first_time: 10,
      received_reassigned: 2,
      calls: 30,
      answered: 22,
      talk_minutes: 90,
    };
    mocks.api.mockImplementation(async (path) => {
      if (path === "/users") return [admin, ali, sara];
      if (path.startsWith("/reports/team/records?"))
        return {
          metric: "calls",
          count: 1,
          page: 1,
          limit: 25,
          data: [
            {
              id: "c1",
              kind: "call",
              at: "2026-11-02T06:00:00Z",
              agent: { id: ali.id, name: "Ali Agent", role: "agent" },
              lead: {
                id: "l1",
                number: "HD-000101",
                name: "Hamza",
                status: "contacted",
              },
              record: {
                outcome: "Interested",
                status: "completed",
                duration_seconds: 120,
                caller: { id: ali.id, name: "Ali Agent", role: "agent" },
              },
            },
          ],
        };
      if (path.startsWith("/reports/team/days?"))
        return {
          metrics: ["received", "calls"],
          days: [{ day: "2026-11-01", received: 12, calls: 30 }],
        };
      if (path.startsWith("/reports/team?"))
        return { metrics: [], agents: [teamRow], total: { ...teamRow } };
      return [];
    });
    open("/reports?tab=agents&from=2026-11-01&to=2026-11-04");
    expect(
      await screen.findByRole("tab", {
        name: "Team performance",
        selected: true,
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Ali Agent: Total calls 30. Show the records",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Total calls · Ali Agent",
    });
    expect(
      await within(dialog).findByText("HD-000101 · Hamza"),
    ).toBeInTheDocument();
    expect(dialog).toHaveTextContent("Recorded by Ali Agent");
    const records = mocks.api.mock.calls
      .map(([p]) => p)
      .find((p) => p.startsWith("/reports/team/records?"));
    expect(
      Object.fromEntries(new URLSearchParams(records.split("?")[1])),
    ).toMatchObject({
      metric: "calls",
      agent: ali.id,
      from: "2026-10-31T19:00:00.000Z",
      to: "2026-11-04T19:00:00.000Z",
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /close/i }));
    // One agent: their row and day by day (update 071).
    fireEvent.click(
      screen.getByRole("button", { name: "Open Ali Agent's performance" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Ali Agent: day by day" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Team performance agent")).toHaveValue(ali.id);
    // Day by day, each Pakistan day with its weekday.
    expect(await screen.findByText("Sun 1 Nov")).toBeInTheDocument();
  });
  it("opens lost leads by reason and those without an agent", async () => {
    open("/reports?tab=lost&from=2026-11-01&to=2026-11-04");
    fireEvent.click(
      await screen.findByRole("button", { name: "Price: 3. Show the leads" }),
    );
    await waitFor(() =>
      expect(requests().at(-1)).toMatchObject({
        report: "lost",
        metric: "reason",
        key: "price",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Unassigned: 3. Show the leads",
      }),
    );
    await waitFor(() =>
      expect(requests().at(-1)).toMatchObject({ metric: "agent", key: "none" }),
    );
  });
});

describe("an agent's own reports (update 051)", () => {
  it("shows My performance with only the agent's numbers", async () => {
    mocks.user = ali;
    open("/reports");
    expect(
      await screen.findByRole("heading", { name: "My performance" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Report agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Export CSV" })).toBeNull();
    expect(
      screen.getByRole("tab", { name: "My activity" }),
    ).toBeInTheDocument();
    // Numbers that are not about the agent's work are left out.
    expect(
      await screen.findByRole("button", {
        name: "Contacted leads: 18. Show the records",
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Active agents/ })).toBeNull();
    expect(mocks.api.mock.calls.some(([path]) => path === "/users")).toBe(
      false,
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "Contacted leads: 18. Show the records",
      }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText(/Only your own work is listed/),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("combobox", { name: "Assigned agent" }),
    ).toBeNull();
    expect(
      within(dialog).queryByRole("columnheader", { name: "Assigned agent" }),
    ).toBeNull();
    await waitFor(() => expect(requests()).toHaveLength(1));
    expect(requests()[0]).toMatchObject({
      report: "summary",
      metric: "leads_contacted",
    });
    expect(requests()[0]).not.toHaveProperty("agent");
  });
});
describe("drill-down words", () => {
  it("words an agent's own numbers as theirs, and today's calling", () => {
    const names = { [ali.id]: "Ali Agent" };
    expect(drillInfo("agents", "calls", ali.id, names, true)).toEqual({
      title: "Calls",
      about:
        "Calls started in this range and recorded under you. “Called by” shows who actually made each call.",
    });
    expect(drillInfo("today", "waiting", ali.id, names)).toEqual({
      title: "Ali Agent: Waiting for a first call",
      about:
        "This agent's leads not called yet whose first-call deadline has not passed.",
    });
    expect(drillInfo("summary", "total_leads", undefined, {}, true).title).toBe(
      "All my leads",
    );
    const today = {
      agents: [{ agent_id: ali.id, calls_today: 5, connected_today: 3 }],
    };
    expect(reportNumber("today", today, "connected_today", ali.id)).toBe(3);
    expect(
      relatedNumbers("today", today, "calls_today", ali.id).map((r) => [
        r.label,
        r.value,
      ]),
    ).toContainEqual(["Answered calls today", 3]);
  });
  it("describes numbers and finds the report's own figure", () => {
    expect(drillInfo("funnel", "stage", "visit_done").title).toBe(
      "Visit done leads",
    );
    expect(drillInfo("lost", "agent", null).title).toBe("Lost: No agent");
    expect(
      drillInfo("agents", "calls", ali.id, { [ali.id]: "Ali Agent" }).title,
    ).toBe("Ali Agent: Calls");
    expect(reportNumber("funnel", funnel, "stage", "contacted")).toBe(41);
    expect(
      reportNumber(
        "lost",
        { by_agent: [{ agent_id: null, count: 2 }] },
        "agent",
        null,
      ),
    ).toBe(2);
    expect(
      relatedNumbers("funnel", funnel, "stage", "new").map((r) => r.label),
    ).toEqual([
      "New",
      "Contacted",
      "Interested",
      "Site visit scheduled",
      "Visit done",
      "Negotiation",
      "Won (booked)",
      "Lost",
    ]);
  });
});
