import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import {
  adminNavigation,
  breadcrumb,
} from "../src/components/layout/navigation";
// Update 055: administrators' Lead pipeline, agent by agent. API responses
// are mocked; the server tests check who spoke to each lead and who may see
// it.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const owner = {
  id: "55200000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
};
const ali = "55200000-0000-4000-8000-000000000001",
  sara = "55200000-0000-4000-8000-000000000002";
const numbers = (extra = {}) => ({
  contacted: 0,
  hot: 0,
  warm: 0,
  cold: 0,
  none: 0,
  followups_due: 0,
  followups_overdue: 0,
  earlier: 0,
  answered_by_others: 0,
  answered_by_admins: 0,
  answered_by_other_agents: 0,
  answered_unrecorded: 0,
  ...extra,
});
const directory = [
  {
    id: ali,
    uid: 482913,
    name: "Ali Agent",
    active: true,
    ...numbers({
      contacted: 23,
      hot: 4,
      warm: 7,
      cold: 2,
      none: 10,
      followups_due: 5,
      followups_overdue: 2,
      earlier: 1,
      answered_by_others: 3,
      answered_by_admins: 2,
      answered_unrecorded: 1,
    }),
  },
  { id: sara, uid: 517204, name: "Sara Agent", active: false, ...numbers() },
];
const lead = (n, extra = {}) => ({
  id: `55200000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  lead_no: 700 + n,
  name: `Customer ${n}`,
  email: null,
  assigned_agent: ali,
  phone: "+9230077000" + String(n).padStart(2, "0"),
  status: "contacted",
  last_contact_at: "2026-11-08T10:00:00Z",
  last_contact_outcome: "Interested",
  last_call_at: "2026-11-08T10:00:00Z",
  last_call_outcome: "Interested",
  last_call_connected: true,
  temperature: null,
  note: null,
  note_at: null,
  next_followup_at: null,
  owner: null,
  ...extra,
});
let current, earlier;
const calls = (prefix) =>
  mocks.api.mock.calls
    .map(([path]) => path)
    .filter((path) => path.startsWith(prefix))
    .map((path) => Object.fromEntries(new URLSearchParams(path.split("?")[1])));
beforeEach(() => {
  vi.clearAllMocks();
  // "All agents" returns to the list as last seen in this tab.
  sessionStorage.clear();
  mocks.user = { ...owner };
  current = Array.from({ length: 23 }, (_, i) =>
    lead(i + 1, i === 1 ? { temperature: "hot" } : {}),
  );
  earlier = [
    lead(90, {
      assigned_agent: sara,
      owner: { id: sara, name: "Sara Agent", role: "agent", former: false },
      note: "Budget too low for DHA",
      note_at: "2026-11-07T10:00:00Z",
    }),
  ];
  mocks.api.mockImplementation(async (path) => {
    if (path.startsWith("/pipeline/agents?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const search = (q.get("search") || "").toLowerCase();
      const rows = directory.filter(
        (a) =>
          !search ||
          a.name.toLowerCase().includes(search) ||
          String(a.uid).startsWith(search),
      );
      return { data: rows, count: rows.length, page: 1, limit: 20 };
    }
    if (path.startsWith("/pipeline/agents/")) {
      const [id, query] = path.slice("/pipeline/agents/".length).split("?");
      const agent = directory.find((a) => a.id === id);
      if (!agent)
        throw Object.assign(new Error("Choose an agent from the list"), {
          status: 404,
        });
      const q = new URLSearchParams(query);
      const rows = (q.get("view") === "earlier" ? earlier : current).filter(
        (l) =>
          !q.get("temperature") ||
          (l.temperature || "none") === q.get("temperature"),
      );
      const page = Number(q.get("page")) || 1;
      const { id: _, uid, name, active, ...summary } = agent;
      return {
        agent: { id, uid, name, active },
        view: q.get("view") || "current",
        page,
        limit: 20,
        count: rows.length,
        summary,
        data: rows.slice((page - 1) * 20, page * 20),
      };
    }
    if (path === "/call-capabilities") return { manual: true, mock: false };
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
const cells = (table, column) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[column].textContent);

describe("the administrator's Leads menu", () => {
  it("holds All leads and the Lead pipeline", async () => {
    open("/leads/pipeline");
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    expect(within(nav).getByRole("button", { name: "Leads" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(
      within(nav).getByRole("link", { name: "Lead pipeline" }),
    ).toHaveClass("active");
    expect(
      within(nav).getByRole("link", { name: "All leads" }),
    ).not.toHaveClass("active");
    expect(breadcrumb(adminNavigation, "/leads")).toEqual([
      "Sales",
      "Leads",
      "All leads",
    ]);
    expect(breadcrumb(adminNavigation, "/leads/pipeline")).toEqual([
      "Sales",
      "Leads",
      "Lead pipeline",
    ]);
    expect(breadcrumb(adminNavigation, "/leads/pipeline/" + ali)).toEqual([
      "Sales",
      "Leads",
      "Agent pipeline",
    ]);
  });
});

describe("the agent directory", () => {
  it("lists every agent with their numbers, found by name or UID", async () => {
    const user = userEvent.setup();
    open("/leads/pipeline");
    expect(
      await screen.findByRole("heading", { name: "Lead pipeline" }),
    ).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Agent",
      "Personally contacted",
      "Hot",
      "Warm",
      "Cold",
      "Follow-ups due",
      "Pipeline",
    ]);
    expect(cells(table, 0)).toEqual([
      expect.stringContaining("UID 482913"),
      expect.stringMatching(/Sara Agent.*UID 517204.*Disabled/),
    ]);
    expect(cells(table, 1)).toEqual(["23", "0"]);
    expect(cells(table, 2)).toEqual(["4", "0"]);
    expect(cells(table, 5)[0]).toBe("52 overdue");
    await user.type(screen.getByLabelText("Search agents"), "5172");
    await waitFor(() =>
      expect(calls("/pipeline/agents?").at(-1)).toEqual({
        page: "1",
        search: "5172",
      }),
    );
    await waitFor(() =>
      expect(cells(screen.getByRole("table"), 0)).toEqual([
        expect.stringContaining("Sara Agent"),
      ]),
    );
  });
  it("opens an agent's pipeline and comes back to the same search", async () => {
    const user = userEvent.setup();
    open("/leads/pipeline?q=ali");
    await user.click(
      await screen.findByRole("link", { name: "Open Ali Agent's pipeline" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Ali Agent" }),
    ).toBeInTheDocument();
    expect(calls("/pipeline/agents/" + ali).at(-1)).toEqual({ page: "1" });
    await user.click(screen.getByRole("link", { name: "← All agents" }));
    expect(await screen.findByLabelText("Search agents")).toHaveValue("ali");
    expect(calls("/pipeline/agents?").at(-1)).toEqual({
      page: "1",
      search: "ali",
    });
  });
});

describe("one agent's pipeline", () => {
  it("shows the agent's numbers, pages with running row numbers, and filters", async () => {
    const user = userEvent.setup();
    open(`/leads/pipeline/${ali}`);
    const stats = await screen.findByRole("group", {
      name: "Ali Agent's pipeline numbers",
    });
    expect(stats.textContent).toContain("Personally contacted23");
    expect(stats.textContent).toContain("Follow-ups due52 overdue");
    // Who answered the leads that are not the agent's contacts, including
    // older calls with no recorded caller.
    expect(screen.getByRole("note").textContent).toBe(
      "On the agent's own Lead pipeline, My pipeline shows 26: these 23 personally contacted leads and 3 more with an answered call from someone else only (2 last answered by an administrator; 1 last answered in an older call with no recorded caller). Only personally contacted leads count here and in the agent list.",
    );
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "#",
      "Customer",
      "Phone",
      "Temperature",
      "Agent notes",
      "Latest contact",
      "Next follow-up",
      "Details",
    ]);
    expect(screen.getByText("Showing 1–20 of 23 leads")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Next/ }));
    await waitFor(() =>
      expect(cells(screen.getByRole("table"), 0)).toEqual(["21", "22", "23"]),
    );
    expect(screen.queryByLabelText("Filter by status")).toBe(null);
    await user.click(within(stats).getByRole("button", { name: /Hot/ }));
    await user.selectOptions(
      screen.getByLabelText("Filter by call outcome"),
      "Number off",
    );
    await waitFor(() =>
      expect(calls("/pipeline/agents/" + ali).at(-1)).toEqual({
        page: "1",
        temperature: "hot",
        outcome: "Number off",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() =>
      expect(calls("/pipeline/agents/" + ali).at(-1)).toEqual({ page: "1" }),
    );
  });
  it("keeps earlier contacts apart, with who has each lead now", async () => {
    const user = userEvent.setup();
    open(`/leads/pipeline/${ali}?temperature=hot`);
    const tabs = await screen.findByRole("tablist", {
      name: "Ali Agent's leads",
    });
    expect(
      within(tabs)
        .getAllByRole("tab")
        .map((t) => [t.textContent, t.getAttribute("aria-selected")]),
    ).toEqual([
      ["Current pipeline 23", "true"],
      ["Earlier contacts 1", "false"],
    ]);
    await user.click(within(tabs).getByRole("tab", { name: /Earlier/ }));
    await waitFor(() =>
      expect(calls("/pipeline/agents/" + ali).at(-1)).toEqual({
        page: "1",
        view: "earlier",
      }),
    );
    const table = await screen.findByRole("table");
    await waitFor(() =>
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((h) => h.textContent),
      ).toEqual([
        "#",
        "Customer",
        "Phone",
        "Now assigned to",
        "Ali Agent's latest contact",
        "Agent notes",
        "Details",
      ]),
    );
    expect(cells(screen.getByRole("table"), 3)).toEqual(["Sara Agent"]);
    expect(cells(screen.getByRole("table"), 5)[0]).toMatch(
      /^Budget too low for DHA/,
    );
    expect(screen.queryByLabelText("Filter by temperature")).toBe(null);
    expect(screen.getByText(/not part of this agent's workload/)).toBeTruthy();
  });
  it("says when the agent cannot be found", async () => {
    open("/leads/pipeline/55200000-0000-4000-8000-0000000000ff");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose an agent from the list",
    );
    expect(screen.getByRole("link", { name: "← All agents" })).toHaveAttribute(
      "href",
      "/leads/pipeline",
    );
  });
  it("is for administrators only", async () => {
    mocks.user = {
      id: ali,
      role: "agent",
      name: "Ali Agent",
    };
    open(`/leads/pipeline/${sara}`);
    expect(
      await screen.findByRole("navigation", { name: "Workspace" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Sara Agent" })).toBe(null),
    );
    expect(calls("/pipeline/agents")).toHaveLength(0);
  });
});
