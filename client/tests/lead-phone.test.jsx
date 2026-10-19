import React from "react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { ToastProvider } from "../src/components/common/UI";
import LeadPhone from "../src/components/leads/LeadPhone";
import Leads from "../src/pages/admin/Leads";
import LeadDetail from "../src/pages/agent/LeadDetail";
const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const agent = "11000000-0000-4000-8000-000000000001",
  other = "11000000-0000-4000-8000-000000000002";
const lead = {
  id: "22000000-0000-4000-8000-000000000001",
  name: "Visible contact",
  lead_no: 123,
  assigned_agent: agent,
  masked_phone: "+92******567",
  phone: "+923001234567",
  status: "new",
  source: "CSV",
  budget_min: 0,
};
let rows;
beforeEach(() => {
  vi.clearAllMocks();
  rows = [lead];
  mocks.auth.user = { id: agent, role: "agent", name: "Agent" };
  mocks.api.mockImplementation(async (path) => {
    if (path.startsWith("/leads?")) return { data: rows, count: rows.length };
    if (path === "/leads/" + lead.id) return lead;
    if (path.endsWith("/timeline") || path === "/users") return [];
    if (path === "/call-capabilities") return { manual: true, mock: false };
    return { data: [], count: 0 };
  });
});
afterEach(() => vi.useRealTimers());
function workspace(element) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  const Wrapper = ({ children }) => (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/leads/${lead.id}?view=all`]}>
          {children}
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
  return { ...render(element, { wrapper: Wrapper }), client };
}
const profile = (
  <Routes>
    <Route path="/leads/:id" element={<LeadDetail />} />
  </Routes>
);
const extraPhoneCalls = () =>
  mocks.api.mock.calls.filter(
    ([p]) =>
      p === "/leads/phones" ||
      p.endsWith("/phone") ||
      p === "/phone-reveals/status",
  );
describe("automatic visible lead contacts", () => {
  it.each([
    ["agent", "list"],
    ["admin", "list"],
    ["agent", "profile"],
    ["admin", "profile"],
  ])("shows full numbers automatically for %s on %s", async (role, page) => {
    mocks.auth.user.role = role;
    workspace(page === "list" ? <Leads /> : profile);
    expect(await screen.findByText(lead.phone)).toBeInTheDocument();
    expect(screen.queryByText(lead.masked_phone)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /(show|hide|view).*(phone|number)/i,
      }),
    ).not.toBeInTheDocument();
    expect(extraPhoneCalls()).toHaveLength(0);
    expect(screen.getAllByText(/HD-000123/).length).toBeGreaterThan(0);
    if (page === "list") {
      expect(
        screen.getByRole("columnheader", { name: "#" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("checkbox", { name: "Select all on this page" }) !==
          null,
      ).toBe(role === "admin");
      expect(screen.getByText("Showing 1–1 of 1 leads")).toBeInTheDocument();
    }
    // Both pages put a Call button beside the number; dialling happens in
    // the call dialog so the call is always logged.
    expect(
      screen.getByRole("button", { name: "Call " + lead.name }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: lead.phone }),
    ).not.toBeInTheDocument();
    if (page === "profile") {
      expect(
        screen.getByRole("button", { name: "Log a call" }),
      ).toBeInTheDocument();
    }
  });
  it("shows every row through one lead-list query without individual number requests", async () => {
    rows = Array.from({ length: 20 }, (_, i) => ({
      ...lead,
      id: `33000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      name: "Visible customer " + i,
      phone: "+92305" + String(i).padStart(7, "0"),
    }));
    workspace(<Leads />);
    await screen.findByText(rows[19].phone);
    for (const row of rows)
      expect(screen.getByText(row.phone)).toBeInTheDocument();
    expect(
      mocks.api.mock.calls.filter(([p]) => p.startsWith("/leads?")),
    ).toHaveLength(1);
    expect(extraPhoneCalls()).toHaveLength(0);
  });
  it("keeps numbers visible after two minutes with no timers or usage controls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    workspace(<LeadPhone lead={lead} />);
    expect(screen.getByText(lead.phone)).toBeInTheDocument();
    await act(async () => vi.advanceTimersByTime(180000));
    expect(screen.getByText(lead.phone)).toBeInTheDocument();
    expect(screen.queryByText(/Numbers shown today/)).not.toBeInTheDocument();
    expect(extraPhoneCalls()).toHaveLength(0);
  });
  it.each([other, null])(
    "does not display another owner or an unassigned contact for an agent: %s",
    (owner) => {
      workspace(<LeadPhone lead={{ ...lead, assigned_agent: owner }} />);
      expect(screen.queryByText(lead.phone)).not.toBeInTheDocument();
      expect(screen.getByText("Number unavailable")).toBeInTheDocument();
    },
  );
  it("allows an admin to see an unassigned contact", () => {
    mocks.auth.user.role = "admin";
    workspace(<LeadPhone lead={{ ...lead, assigned_agent: null }} />);
    expect(screen.getByText(lead.phone)).toBeInTheDocument();
  });
  it.each([null, undefined, "not a number"])(
    "does not invent a number or substitute a masked value: %s",
    (phone) => {
      workspace(<LeadPhone lead={{ ...lead, phone }} />);
      expect(screen.getByText("Number unavailable")).toBeInTheDocument();
      expect(screen.queryByText(lead.masked_phone)).not.toBeInTheDocument();
    },
  );
  it("hides an old number when current ownership/account changes", () => {
    const view = workspace(<LeadPhone lead={lead} />);
    expect(screen.getByText(lead.phone)).toBeInTheDocument();
    mocks.auth.user = { ...mocks.auth.user, id: other };
    view.rerender(<LeadPhone lead={lead} />);
    expect(screen.queryByText(lead.phone)).not.toBeInTheDocument();
  });
  it("does not persist contacts in browser storage", async () => {
    const before = JSON.stringify({ ...localStorage });
    workspace(profile);
    await screen.findByText(lead.phone);
    expect(JSON.stringify({ ...localStorage })).toBe(before);
  });
  it("shows a migration/read error on the profile without a misleading masked fallback", async () => {
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((p, o) =>
      p === "/leads/" + lead.id
        ? Promise.reject(
            new Error(
              "Visible lead numbers need database migration 021 after 020.",
            ),
          )
        : original(p, o),
    );
    workspace(profile);
    expect(await screen.findByRole("alert")).toHaveTextContent("migration 021");
    expect(screen.queryByText(lead.masked_phone)).not.toBeInTheDocument();
  });
  it.each(["admin", "agent"])(
    "shows a load error without claiming there are zero leads in the %s list",
    async (role) => {
      mocks.auth.user.role = role;
      const original = mocks.api.getMockImplementation();
      mocks.api.mockImplementation((p, o) =>
        p.startsWith("/leads?")
          ? Promise.reject(
              new Error(
                "Visible lead numbers need database migration 021 after 020.",
              ),
            )
          : original(p, o),
      );
      workspace(<Leads />);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "migration 021",
      );
      expect(screen.queryByText(/No records to show/)).not.toBeInTheDocument();
      expect(screen.queryByText(/0 records/)).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Next" }),
      ).not.toBeInTheDocument();
    },
  );
});
