import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
// Update 057: administrators' All leads. API responses are mocked; the
// server tests check the search, filters, counts and assignment rules.
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
  id: "57200000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
  active: true,
};
const ali = {
  id: "57200000-0000-4000-8000-0000000000a2",
  role: "agent",
  name: "Ali Agent",
  active: true,
};
const sara = {
  id: "57200000-0000-4000-8000-0000000000a3",
  role: "agent",
  name: "Sara Agent",
  active: true,
};
const sheet = "57200000-0000-4000-8000-0000000000f1";
const lead = (n, extra = {}) => ({
  id: `57200000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  lead_no: 900 + n,
  name: `Customer ${n}`,
  email: `customer${n}@example.com`,
  phone: "+9230099000" + String(n).padStart(2, "0"),
  masked_phone: "+92******0" + n,
  status: "new",
  source: "Meta",
  import_id: sheet,
  assigned_agent: null,
  assigned_name: null,
  assigned_active: null,
  created_at: "2026-11-09T08:00:00Z",
  assigned_at: null,
  call_due_at: null,
  first_call_at: null,
  missed_at: null,
  last_call_at: null,
  last_call_outcome: null,
  last_call_connected: null,
  ...extra,
});
let rows, posts;
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  mocks.user = { ...owner };
  posts = [];
  rows = [
    lead(1),
    lead(2, {
      assigned_agent: ali.id,
      assigned_name: "Ali Agent",
      assigned_active: true,
      last_call_at: "2026-11-09T09:00:00Z",
      last_call_outcome: "Interested",
      last_call_connected: true,
    }),
  ];
  mocks.api.mockImplementation(async (path, options = {}) => {
    if (path.startsWith("/leads/all/selection?"))
      return { ids: rows.map((r) => r.id) };
    if (path.startsWith("/leads/all?"))
      return {
        page: Number(new URLSearchParams(path.split("?")[1]).get("page")) || 1,
        limit: 20,
        count: rows.length,
        totals: { total: 41, assigned: 30, unassigned: 11 },
        data: rows,
      };
    if (path === "/users") return [owner, ali, sara];
    if (path.startsWith("/lead-imports?"))
      return {
        data: [{ id: sheet, file_name: "DHA plots", file_format: "sheets" }],
        count: 1,
      };
    if (options.method === "POST") {
      posts.push([path, options.body]);
      return path === "/leads/assign-unassigned" &&
        options.body.lead_ids.length > 1
        ? {
            assigned: 1,
            skipped: 1,
            failed: 0,
            results: [
              { id: rows[0].id, name: "Customer 1", result: "assigned" },
              {
                id: rows[1].id,
                name: "Customer 2",
                result: "skipped",
                reason: "Already assigned to Ali Agent",
              },
            ],
          }
        : {
            assigned: 1,
            skipped: 0,
            failed: 0,
            results: [{ id: options.body.lead_ids[0], result: "assigned" }],
          };
    }
    if (/^\/leads\/[0-9a-f-]+$/.test(path))
      return rows.find((r) => path.endsWith(r.id));
    if (path.endsWith("/timeline") || path.endsWith("/inquiries")) return [];
    if (path === "/call-capabilities") return { manual: true, mock: false };
    return { data: [], count: 0 };
  });
});
function Where() {
  const location = useLocation();
  return (
    <output aria-label="Address">{location.pathname + location.search}</output>
  );
}
function open(path) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const listCalls = () =>
  mocks.api.mock.calls
    .map(([p]) => p)
    .filter((p) => p.startsWith("/leads/all?"));
const address = () => screen.getByLabelText("Address").textContent;

describe("administrators' All leads", () => {
  it("shows the simple table, with counts, and no HD numbers, emails or file names", async () => {
    open("/leads");
    await screen.findByText("Customer 1");
    expect(
      screen.getByRole("heading", { name: "All leads" }),
    ).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent)
        .filter((t) => t),
    ).toEqual([
      "#",
      "Customer name",
      "Phone number",
      "First call",
      "Assigned to",
      "Last contact",
      "Actions",
    ]);
    expect(table).not.toHaveTextContent(/HD-0/);
    expect(table).not.toHaveTextContent("example.com");
    expect(table).not.toHaveTextContent("DHA plots");
    const [, first, second] = within(table).getAllByRole("row");
    expect(first).toHaveTextContent("Unassigned");
    expect(
      within(first).getByRole("button", { name: "Assign Customer 1" }),
    ).toBeInTheDocument();
    expect(second).toHaveTextContent("Ali Agent");
    expect(second).toHaveTextContent("Interested");
    expect(
      within(second).getByRole("button", { name: "Reassign Customer 2" }),
    ).toBeInTheDocument();
    expect(within(first).getByText(rows[0].phone)).toBeInTheDocument();
    const counts = screen.getByRole("group", { name: "Lead counts" });
    expect(counts).toHaveTextContent("Total 41");
    expect(counts).toHaveTextContent("Assigned 30");
    expect(counts).toHaveTextContent("Unassigned 11");
    expect(
      screen.getByText(
        "Counts of every lead in the CRM, not in Deleted leads.",
      ),
    ).toBeInTheDocument();
  });

  it("searches and filters together in the address, says the counts are filtered, and resets", async () => {
    const user = userEvent.setup();
    open("/leads");
    await screen.findByText("Customer 1");
    await user.type(screen.getByLabelText("Search leads"), "0300 1234");
    await waitFor(() =>
      expect(listCalls().at(-1)).toBe("/leads/all?search=0300+1234&page=1"),
    );
    await user.selectOptions(
      screen.getByLabelText("Filter by assignment"),
      "agent:" + ali.id,
    );
    await user.selectOptions(
      screen.getByLabelText("Filter by first call"),
      "missed",
    );
    await user.selectOptions(screen.getByLabelText("Filter by source"), "Meta");
    await user.selectOptions(
      await screen.findByLabelText("Filter by lead file"),
      sheet,
    );
    await waitFor(() =>
      expect(listCalls().at(-1)).toBe(
        `/leads/all?search=0300+1234&agent=${ali.id}&call=missed&source=Meta&import_id=${sheet}&page=1`,
      ),
    );
    expect(address()).toContain(`agent=${ali.id}`);
    expect(
      screen.getByText("Counts of the leads matching your search and filters."),
    ).toBeInTheDocument();
    const chips = screen.getByRole("group", { name: "Active filters" });
    for (const chip of [
      "Search: 0300 1234",
      "Assigned to Ali Agent",
      "Missed first call",
      "Source: Meta",
      "File: DHA plots",
    ])
      expect(
        within(chips).getByRole("button", { name: `Remove filter ${chip}` }),
      ).toBeInTheDocument();
    // The counts choose assignment.
    await user.click(
      within(screen.getByRole("group", { name: "Lead counts" })).getByRole(
        "button",
        { name: /Unassigned/ },
      ),
    );
    await waitFor(() =>
      expect(listCalls().at(-1)).toContain("assignment=unassigned"),
    );
    expect(listCalls().at(-1)).not.toContain("agent=");
    await user.click(
      within(chips).getByRole("button", { name: "Reset filters" }),
    );
    await waitFor(() => expect(listCalls().at(-1)).toBe("/leads/all?page=1"));
    expect(screen.getByLabelText("Search leads")).toHaveValue("");
  });

  it("returns from a lead to the same search, filters and page", async () => {
    const user = userEvent.setup();
    open(`/leads?q=Customer&source=Meta&page=2`);
    await user.click(await screen.findByRole("link", { name: /Customer 2/ }));
    await user.click(
      await screen.findByRole("link", { name: "← Back to leads" }),
    );
    await waitFor(() =>
      expect(address()).toBe("/leads?q=Customer&source=Meta&page=2"),
    );
    await screen.findByText("Customer 1");
    expect(listCalls().at(-1)).toBe(
      "/leads/all?search=Customer&source=Meta&page=2",
    );
  });

  it("assigns one lead without taking it from an agent, and reassigns only after confirming", async () => {
    const user = userEvent.setup();
    open("/leads");
    await user.click(
      await screen.findByRole("button", { name: "Assign Customer 1" }),
    );
    let dialog = await screen.findByRole("dialog", {
      name: "Assign Customer 1",
    });
    await user.selectOptions(
      within(dialog).getByLabelText("Assign to"),
      sara.id,
    );
    await user.click(within(dialog).getByRole("button", { name: "Assign" }));
    await waitFor(() =>
      expect(posts.at(-1)).toEqual([
        "/leads/assign-unassigned",
        { lead_ids: [rows[0].id], mode: "agent", agent_id: sara.id },
      ]),
    );
    await user.click(
      screen.getByRole("button", { name: "Reassign Customer 2" }),
    );
    dialog = await screen.findByRole("dialog", { name: "Reassign Customer 2" });
    expect(dialog).toHaveTextContent("Customer 2 is assigned to Ali Agent.");
    // The current agent is not offered.
    expect(
      within(within(dialog).getByLabelText("Move to")).queryByRole("option", {
        name: "Ali Agent",
      }),
    ).toBeNull();
    await user.selectOptions(within(dialog).getByLabelText("Move to"), sara.id);
    await user.click(within(dialog).getByRole("button", { name: "Reassign" }));
    await waitFor(() =>
      expect(posts.at(-1)).toEqual([
        "/leads/assign-bulk",
        { lead_ids: [rows[1].id], mode: "agent", agent_id: sara.id },
      ]),
    );
  });

  it("bulk-assigns the selected unassigned leads after confirming and reports each one", async () => {
    const user = userEvent.setup();
    open("/leads?assignment=unassigned");
    await user.click(
      await screen.findByRole("button", {
        name: "Select all 2 matching leads",
      }),
    );
    const bar = await screen.findByRole("toolbar", {
      name: "Selected lead actions",
    });
    expect(bar).toHaveTextContent("2 leads selected");
    await user.selectOptions(
      within(bar).getByLabelText("Agent for the selected unassigned leads"),
      sara.id,
    );
    await user.click(
      within(bar).getByRole("button", { name: "Assign unassigned" }),
    );
    const confirm = await screen.findByRole("dialog", {
      name: "Assign the selected leads",
    });
    expect(confirm).toHaveTextContent(
      "Leads that already have an agent stay with that agent",
    );
    expect(posts).toEqual([]);
    await user.click(within(confirm).getByRole("button", { name: "Assign" }));
    const report = await screen.findByRole("dialog", {
      name: "Assignment results",
    });
    expect(posts).toEqual([
      [
        "/leads/assign-unassigned",
        { lead_ids: rows.map((r) => r.id), mode: "agent", agent_id: sara.id },
      ],
    ]);
    expect(report).toHaveTextContent(
      "1 lead assigned · 1 lead not changed · 0 leads failed",
    );
    expect(report).toHaveTextContent("Customer 2");
    expect(report).toHaveTextContent("Already assigned to Ali Agent");
    expect(
      mocks.api.mock.calls.some(([p]) =>
        p.startsWith("/leads/all/selection?assignment=unassigned"),
      ),
    ).toBe(true);
  });

  it("says when nothing matches", async () => {
    rows = [];
    open("/leads?q=nobody");
    expect(
      await screen.findByText(
        "No leads match your search or filters. Reset filters to see every lead.",
      ),
    ).toBeInTheDocument();
  });
});
