import React from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Protected } from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import Layout from "../src/components/layout/Layout";
import MetaIntegration from "../src/pages/admin/MetaIntegration";
import IncomingSocial from "../src/pages/admin/IncomingSocial";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: null, loading: false, logout: vi.fn() },
}));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
const base = "/integrations/meta";
let settings,
  rows,
  summary,
  failAssignment = false,
  delayAssignment;
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.clearAllMocks();
  failAssignment = false;
  delayAssignment = null;
  mocks.auth.user = { id: "admin", name: "Administrator", role: "admin" };
  settings = { configured: false, connections: [], pages: [], forms: [] };
  summary = {
    total: 2,
    unassigned: 2,
    facebook: 1,
    instagram: 1,
    review: 0,
    assigned_today: 0,
    duplicates: 0,
    failures: 0,
    notifications: [
      { id: "submission-1", platform: "facebook", name: "Buyer One" },
    ],
  };
  rows = [
    {
      id: "submission-1",
      lead_id: "lead-1",
      provider_lead_id: "301",
      customer_name: "Buyer One",
      phone: "+923001234567",
      platform: "facebook",
      received_at: "2026-10-14T07:00:00Z",
      status: "created",
      meta_pending_assignment: true,
      assigned_agent: null,
    },
    {
      id: "submission-2",
      lead_id: "lead-2",
      provider_lead_id: "302",
      customer_name: "Buyer Two",
      phone: "+923007654321",
      platform: "instagram",
      status: "created",
      meta_pending_assignment: true,
      assigned_agent: null,
    },
  ];
  mocks.api.mockImplementation(async (path, options) => {
    if (path === base + "/settings") return settings;
    if (path === base + "/summary") return summary;
    if (path.startsWith(base + "/inbox?")) return { data: rows, count: 42 };
    if (path === base + "/submissions/submission-1")
      return {
        ...rows[0],
        lead: { name: "Buyer One", meta_pending_assignment: true },
        normalized: { name: "Buyer One" },
        answers: [{ name: "custom_answer", values: ["Interested in Lahore"] }],
        assignments: [],
      };
    if (path === base + "/assign") {
      if (delayAssignment) return delayAssignment;
      if (failAssignment)
        throw new Error("Some records changed. Refresh and try again.");
      summary = { ...summary, unassigned: 0 };
      rows = rows.map((r) => ({
        ...r,
        meta_pending_assignment: false,
        assigned_agent: "agent",
        agent_name: "Active Agent",
      }));
      return { assigned: options.body.lead_ids.length };
    }
    if (path === base + "/notices/submission-1/read") {
      summary = { ...summary, notifications: [] };
      return null;
    }
    if (path.startsWith(base + "/report?"))
      return {
        submissions: 2,
        unique_customers: 1,
        assigned: 0,
        unassigned: 1,
        completed_visits: 0,
        won_deals: 0,
        revenue: 0,
        stages: { new: 1 },
        groups: [
          {
            platform: "facebook",
            campaign_name: "Autumn",
            form_id: "201",
            submissions: 2,
            customer_references: 1,
          },
        ],
      };
    if (path === base + "/forms/201") {
      settings = {
        ...settings,
        forms: [{ ...settings.forms[0], ...options.body }],
      };
      return { saved: true };
    }
    if (path === base + "/pages/101/forms")
      return { forms: 1, truncated: false };
    if (path === base + "/forms/201/sync")
      return { queued: 1, checked: 1, truncated: false };
    if (path === base + "/connections/connection-1") {
      settings = {
        ...settings,
        connections: [{ ...settings.connections[0], status: "disconnected" }],
      };
      return { disconnected: true, message: "Local synchronization stopped" };
    }
    if (path === "/users")
      return [
        { id: "agent", name: "Active Agent", role: "agent", active: true },
        {
          id: "inactive",
          name: "Inactive Agent",
          role: "agent",
          active: false,
        },
        { id: "admin", name: "Administrator", role: "admin", active: true },
      ];
    if (path === "/reminders") return [];
    if (path === "/notifications") return { data: [], unread: 0 };
    if (path === "/security-alerts/summary") return { count: 0 };
    throw new Error("Unexpected fixture API " + path);
  });
});
function workspace(path = "/incoming-social", shell = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const routes = (
    <Routes>
      <Route path="/" element={<p>Workspace home</p>} />
      <Route element={shell ? <Layout /> : <Protected role="admin" />}>
        {shell ? (
          <Route element={<Protected role="admin" />}>
            <Route path="/integrations/meta" element={<MetaIntegration />} />
            <Route path="/incoming-social" element={<IncomingSocial />} />
            <Route path="/incoming-social/:id" element={<IncomingSocial />} />
          </Route>
        ) : (
          <>
            <Route path="/integrations/meta" element={<MetaIntegration />} />
            <Route path="/incoming-social" element={<IncomingSocial />} />
            <Route path="/incoming-social/:id" element={<IncomingSocial />} />
          </>
        )}
      </Route>
    </Routes>
  );
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>{routes}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return client;
}
function connected() {
  settings = {
    configured: true,
    connections: [
      {
        id: "connection-1",
        status: "connected",
        provider_user_id: "999",
        created_at: "2026-10-14T07:00:00Z",
      },
    ],
    pages: [
      {
        id: "101",
        connection_id: "connection-1",
        name: "Sales Page",
        enabled: true,
        subscribed: true,
        instagram_name: "property.sales",
      },
    ],
    forms: [
      {
        id: "201",
        page_id: "101",
        name: "Property enquiries",
        enabled: true,
        mapping: {},
        questions: [{ key: "custom_phone", label: "Mobile contact" }],
      },
    ],
  };
}
describe("Meta integration and incoming leads interface", () => {
  it("shows honest unconfigured state with connection disabled and website-form limitation", async () => {
    workspace("/integrations/meta");
    await screen.findByText("Not connected");
    expect(
      screen.getByRole("button", { name: "Connect / reconnect Meta" }),
    ).toBeDisabled();
    expect(
      screen.getByText(/Website forms require a separate connection/),
    ).toBeInTheDocument();
    expect(mocks.api).not.toHaveBeenCalledWith(
      base + "/connect",
      expect.anything(),
    );
  });
  it.each([
    "/integrations/meta",
    "/incoming-social",
    "/incoming-social/submission-1",
  ])(
    "denies an agent the admin route %s without fetching its data",
    async (path) => {
      mocks.auth.user = { id: "agent", role: "agent", name: "Agent" };
      workspace(path);
      await screen.findByText("Workspace home");
      expect(mocks.api).not.toHaveBeenCalled();
    },
  );
  it("displays connection, selected Page, Instagram identity and form mapping controls", async () => {
    connected();
    workspace("/integrations/meta");
    await screen.findByText("Sales Page");
    expect(screen.getByText(/@property.sales/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Map custom_phone"), {
      target: { value: "phone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save mapping" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(base + "/forms/201", {
        method: "PATCH",
        body: { enabled: true, mapping: { custom_phone: "phone" } },
      }),
    );
    await screen.findByText("Form updated");
  });
  it("refreshes forms and requests a bounded missed-submission check", async () => {
    connected();
    workspace("/integrations/meta");
    await screen.findByText("Sales Page");
    fireEvent.click(screen.getByRole("button", { name: "Refresh forms" }));
    await screen.findByText("1 forms found");
    fireEvent.click(
      screen.getByRole("button", { name: "Check missed submissions" }),
    );
    await screen.findByText(/1 new submissions queued from the last day/);
    expect(mocks.api).toHaveBeenCalledWith(base + "/forms/201/sync", {
      method: "POST",
      body: { days: 1 },
    });
  });
  it("requires a confirmation before disconnect and reports real API success", async () => {
    connected();
    workspace("/integrations/meta");
    await screen.findByText("Sales Page");
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    const modal = screen.getByRole("dialog");
    expect(
      mocks.api.mock.calls.some(
        ([p]) => p === base + "/connections/connection-1",
      ),
    ).toBe(false);
    fireEvent.click(within(modal).getByRole("button", { name: "Disconnect" }));
    await screen.findByText("Local synchronization stopped");
  });
  it("renders full phones and distinguishes real summary counts", async () => {
    workspace();
    await screen.findByText("+923001234567");
    expect(screen.getByText("+923007654321")).toBeInTheDocument();
    expect(screen.queryByText(/View phone|Hide phone/)).toBeNull();
    expect(screen.getByText("Total submissions")).toBeInTheDocument();
    expect(screen.getByText("Repeat inquiries")).toBeInTheDocument();
  });
  it("supports search, platform, assignment, sort, date and pagination queries", async () => {
    workspace();
    await screen.findByText("Buyer One");
    fireEvent.change(screen.getByLabelText("Platform"), {
      target: { value: "instagram" },
    });
    fireEvent.change(screen.getByLabelText("Assignment"), {
      target: { value: "unassigned" },
    });
    fireEvent.change(screen.getByLabelText("Sort submissions"), {
      target: { value: "oldest" },
    });
    fireEvent.change(screen.getByLabelText("Search social leads"), {
      target: { value: "Buyer" },
    });
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-10-14" },
    });
    fireEvent.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() => {
      const query = new URLSearchParams(
        mocks.api.mock.calls
          .filter(([p]) => p.startsWith(base + "/inbox?"))
          .at(-1)[0]
          .split("?")[1],
      );
      expect(query.get("page")).toBe("2");
      expect(query.get("platform")).toBe("instagram");
      expect(query.get("assignment")).toBe("unassigned");
      expect(query.get("sort")).toBe("oldest");
      expect(query.get("search")).toBe("Buyer");
      expect(query.get("from")).toBe("2026-10-13T19:00:00.000Z");
    });
  });
  it("lets an admin select two customers, choose an active agent and confirm once", async () => {
    workspace();
    await screen.findByText("Buyer One");
    fireEvent.click(screen.getByLabelText("Select Buyer One"));
    fireEvent.click(screen.getByLabelText("Select Buyer Two"));
    fireEvent.click(
      screen.getByRole("button", { name: "Assign selected (2)" }),
    );
    await screen.findByRole("option", { name: "Active Agent" });
    expect(
      within(screen.getByLabelText("Selected customers")).getByText(
        "Buyer One",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Inactive Agent" })).toBeNull();
    expect(screen.queryByRole("option", { name: "Administrator" })).toBeNull();
    expect(
      screen.getByRole("button", { name: "Confirm assignment" }),
    ).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Receiving agent *"), {
      target: { value: "agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm assignment" }));
    await screen.findByText("2 customers assigned");
    expect(mocks.api).toHaveBeenCalledWith(base + "/assign", {
      method: "POST",
      body: { lead_ids: ["lead-1", "lead-2"], agent_id: "agent" },
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("preserves the selection and reports conflict without a false success", async () => {
    failAssignment = true;
    workspace();
    await screen.findByText("Buyer One");
    fireEvent.click(screen.getAllByRole("button", { name: "Assign Agent" })[0]);
    await screen.findByRole("option", { name: "Active Agent" });
    fireEvent.change(screen.getByLabelText("Receiving agent *"), {
      target: { value: "agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm assignment" }));
    await screen.findByText("Some records changed. Refresh and try again.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("1 customers assigned")).toBeNull();
    expect(
      screen.getAllByRole("button", { name: "Assign Agent" }),
    ).toHaveLength(2);
  });
  it("guards a pending assignment against double submission and dismissal", async () => {
    delayAssignment = new Promise(() => {});
    workspace();
    await screen.findByText("Buyer One");
    fireEvent.click(screen.getAllByRole("button", { name: "Assign Agent" })[0]);
    await screen.findByRole("option", { name: "Active Agent" });
    fireEvent.change(screen.getByLabelText("Receiving agent *"), {
      target: { value: "agent" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm assignment" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Assigning…" })).toBeDisabled(),
    );
    fireEvent.click(screen.getByLabelText("Close dialog"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      mocks.api.mock.calls.filter(([p]) => p === base + "/assign"),
    ).toHaveLength(1);
  });
  it("opens real submission answers and assignment history", async () => {
    workspace("/incoming-social/submission-1");
    await screen.findByText("Interested in Lahore");
    expect(
      screen.getByRole("heading", { name: "Buyer One" }),
    ).toBeInTheDocument();
    expect(screen.getByText("No assignment yet.")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Customer activity" }),
    ).toHaveAttribute("href", "/leads/lead-1");
  });
  it("reports submission and unique-customer totals using valid Pakistan month boundaries", async () => {
    workspace();
    await screen.findByText("Buyer One");
    fireEvent.click(
      screen.getByRole("button", { name: "View current-month report" }),
    );
    await screen.findByText(/2 submissions · 1 unique customers/);
    const query = new URLSearchParams(
      mocks.api.mock.calls
        .find(([p]) => p.startsWith(base + "/report?"))[0]
        .split("?")[1],
    );
    expect(Number.isFinite(Date.parse(query.get("from")))).toBe(true);
    expect(query.get("from")).toContain("19:00:00.000Z");
    expect(screen.getByText("Autumn")).toBeInTheDocument();
  });
  it("shows admin sidebar counts and dismisses each saved social notice", async () => {
    workspace("/incoming-social", true);
    await screen.findByLabelText("2 unassigned social leads");
    fireEvent.click(
      screen.getByRole("button", { name: /^View notifications/ }),
    );
    const notification = await screen.findByRole("link", {
      name: "Facebook · Buyer One",
    });
    expect(notification).toHaveAttribute(
      "href",
      "/incoming-social/submission-1",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("link", { name: "Facebook · Buyer One" }),
      ).toBeNull(),
    );
  });
});
