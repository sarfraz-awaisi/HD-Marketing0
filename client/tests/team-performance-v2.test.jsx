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
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import Reports from "../src/pages/admin/Reports";
import { periodDays } from "../src/lib/periods";
// Update 071: Team performance's eight columns, its periods, sorting, name
// search, agent filter and CSV export. API responses are mocked; the server
// tests check the counting rules.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
  download: vi.fn(),
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false }),
}));
const admin = {
  id: "a7100000-0000-4000-8000-000000000001",
  name: "Owner",
  role: "admin",
};
const agentRow = (id, name, numbers, extra = {}) => ({
  agent_id: id,
  name,
  active: true,
  received: numbers[0],
  received_first_time: numbers[1],
  received_reassigned: numbers[2],
  moved_away: numbers[3],
  calls: numbers[4],
  followup_leads: numbers[5],
  worked_minutes: numbers[6],
  open_days: 0,
  incomplete_days: 0,
  attendance_tracked: true,
  // Numbers the table no longer shows.
  answered: 1,
  followups_overdue_now: 9,
  talk_minutes: 40,
  ...extra,
});
const ali = "a7100000-0000-4000-8000-000000000002",
  sara = "a7100000-0000-4000-8000-000000000003",
  omar = "a7100000-0000-4000-8000-000000000004";
let team;
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
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user = admin;
  const agents = [
    agentRow(ali, "Ali Agent", [12, 10, 2, 3, 40, 2, 465], {
      incomplete_days: 1,
    }),
    agentRow(omar, "Omar Agent", [1, 1, 0, 0, 5, 7, 0], {
      active: false,
      attendance_tracked: false,
    }),
    agentRow(sara, "Sara Agent", [30, 25, 5, 1, 12, 4, 960]),
  ];
  team = {
    metrics: [],
    agents,
    total: {
      received: 43,
      received_first_time: 36,
      received_reassigned: 7,
      moved_away: 4,
      calls: 57,
      followup_leads: 13,
      worked_minutes: 1425,
      open_days: 0,
      incomplete_days: 1,
    },
  };
  mocks.api.mockImplementation(async (path) => {
    if (path === "/users") return [admin];
    if (path.startsWith("/reports/team?")) return team;
    if (path.startsWith("/reports/team/days?"))
      return {
        metrics: ["received", "calls"],
        days: [{ day: "2026-11-02", received: 3, calls: 9 }],
      };
    if (path.startsWith("/reports/team/records?"))
      return {
        metric: "followup_leads",
        count: 0,
        page: 1,
        limit: 25,
        data: [],
      };
    if (path.startsWith("/reports/team/export?")) return new Blob(["csv"]);
    throw new Error("Unexpected request " + path);
  });
});
function Where() {
  const location = useLocation();
  return (
    <output data-testid="where">{location.pathname + location.search}</output>
  );
}
function open(path) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/reports" element={<Reports />} />
        </Routes>
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const url = "/reports?tab=team&from=2026-11-02&to=2026-11-05";
const table = () => screen.findByRole("table");
const names = async () =>
  within(await table())
    .getAllByRole("rowheader")
    .map((cell) => cell.textContent);
const requests = (start) =>
  mocks.api.mock.calls.map(([p]) => p).filter((p) => p.startsWith(start));

describe("Team performance (update 071)", () => {
  it("shows exactly eight columns, with Time as hours and minutes", async () => {
    open(url);
    const grid = await table();
    expect(
      within(grid)
        .getAllByRole("columnheader")
        .map((h) => h.textContent.replace(/[↑↓]/g, "").trim()),
    ).toEqual([
      "Agent",
      "Leads received",
      "New",
      "From another agent",
      "Moved away",
      "Total calls",
      "Follow-ups",
      "Time",
    ]);
    expect(grid).not.toHaveTextContent(/Overdue|Talk time|First time/);
    const row = (name) =>
      within(grid).getByRole("rowheader", { name: new RegExp(name) })
        .parentElement;
    expect(
      within(row("Ali Agent"))
        .getAllByRole("cell")
        .map((c) => c.textContent),
    ).toEqual([
      "12",
      "10",
      "2",
      "3",
      "40",
      "2",
      "7h 45m1 day without checkout",
    ]);
    // An inactive agent keeps their history; no tracked attendance shows "—".
    expect(row("Omar Agent")).toHaveTextContent("(inactive)");
    expect(
      within(row("Omar Agent")).getAllByRole("cell").at(-1),
    ).toHaveTextContent("—");
    expect(row("All agents")).toHaveTextContent("23h 45m");
  });

  it("sorts by leads, calls and follow-ups, and searches agent names", async () => {
    open(url);
    expect(await names()).toEqual([
      "Ali Agent",
      "Omar Agent (inactive)",
      "Sara Agent",
      "All agents",
    ]);
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by Total calls" }),
    );
    expect(await names()).toEqual([
      "Ali Agent",
      "Sara Agent",
      "Omar Agent (inactive)",
      "All agents",
    ]);
    expect(
      screen.getByRole("columnheader", { name: /Total calls/ }),
    ).toHaveAttribute("aria-sort", "descending");
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by Total calls" }),
    );
    expect((await names())[0]).toBe("Omar Agent (inactive)");
    fireEvent.click(
      screen.getByRole("button", { name: "Sort by Leads received" }),
    );
    expect((await names())[0]).toBe("Sara Agent");
    fireEvent.click(screen.getByRole("button", { name: "Sort by Follow-ups" }));
    expect((await names())[0]).toBe("Omar Agent (inactive)");
    fireEvent.change(screen.getByLabelText("Search agents"), {
      target: { value: "SAR" },
    });
    expect(await names()).toEqual(["Sara Agent", "Agents shown"]);
    // A searched total adds the rows shown, and opens nothing.
    const total = screen.getByRole("rowheader", {
      name: "Agents shown",
    }).parentElement;
    expect(within(total).queryByRole("button")).not.toBeInTheDocument();
    expect(total).toHaveTextContent("16h 0m");
    fireEvent.change(screen.getByLabelText("Search agents"), {
      target: { value: "nobody" },
    });
    expect(
      await screen.findByText("No agents match “nobody”."),
    ).toBeInTheDocument();
  });

  it("opens the follow-up leads behind a number, for that agent and period", async () => {
    open(url);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Ali Agent: Follow-ups 2. Show the records",
      }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Follow-ups · Ali Agent" }),
    ).toHaveTextContent("Each lead once");
    await waitFor(() =>
      expect(requests("/reports/team/records?")).toHaveLength(1),
    );
    expect(
      Object.fromEntries(
        new URLSearchParams(
          requests("/reports/team/records?")[0].split("?")[1],
        ),
      ),
    ).toMatchObject({
      metric: "followup_leads",
      agent: ali,
      from: "2026-11-01T19:00:00.000Z",
      to: "2026-11-05T19:00:00.000Z",
    });
  });

  it("filters to one agent, with their day by day, and exports what is shown", async () => {
    open(url);
    await table();
    fireEvent.change(screen.getByLabelText("Team performance agent"), {
      target: { value: sara },
    });
    expect(await names()).toEqual(["Sara Agent"]);
    expect(
      await screen.findByRole("heading", { name: "Sara Agent: day by day" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("where").textContent).toContain("agent=" + sara);
    fireEvent.change(screen.getByLabelText("Search agents"), {
      target: { value: "sara" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    await waitFor(() =>
      expect(requests("/reports/team/export?")).toHaveLength(1),
    );
    expect(
      Object.fromEntries(
        new URLSearchParams(requests("/reports/team/export?")[0].split("?")[1]),
      ),
    ).toEqual({
      from: "2026-11-01T19:00:00.000Z",
      to: "2026-11-05T19:00:00.000Z",
      agent: sara,
      search: "sara",
    });
  });

  it("offers Today, Yesterday, Last 7 days, This month and custom dates", async () => {
    open(url);
    await table();
    const select = screen.getByLabelText("Report period");
    expect(
      within(select)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "Today",
      "Yesterday",
      "Last 7 days",
      "This month",
      "Custom dates",
    ]);
    expect(select).toHaveValue("custom");
    fireEvent.change(select, { target: { value: "last_7_days" } });
    const week = periodDays("last_7_days");
    await waitFor(() =>
      expect(screen.getByTestId("where").textContent).toContain(
        `from=${week.from}&to=${week.to}`,
      ),
    );
    // Seven Pakistan days, today included.
    expect((Date.parse(week.to) - Date.parse(week.from)) / 86400000 + 1).toBe(
      7,
    );
    expect(select).toHaveValue("last_7_days");
  });

  it("says when Follow-ups and Time need update 071", async () => {
    team.agents = team.agents.map(
      ({ followup_leads, worked_minutes, ...rest }) => rest,
    );
    open(url);
    expect(
      await screen.findByText(
        "Follow-ups and Time need CRM database update 071.",
      ),
    ).toBeInTheDocument();
  });
});
