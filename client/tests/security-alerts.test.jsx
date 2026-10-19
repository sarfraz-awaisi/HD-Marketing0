import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Protected } from "../src/App";
import Layout from "../src/components/layout/Layout";
import { ToastProvider } from "../src/components/common/UI";
import SecurityAlerts from "../src/pages/admin/SecurityAlerts";
import Dashboard from "../src/pages/admin/Dashboard";
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
let alerts;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = {
    id: "privacy-admin",
    role: "admin",
    name: "Privacy admin",
  };
  alerts = [
    {
      id: "privacy-alert",
      type: "phone_reveal_limit",
      severity: "critical",
      user_name: "Test agent",
      message: "Daily customer number limit reached.",
      metadata: { shown_today: 80, limit: 80 },
      created_at: "2026-10-13T07:00:00Z",
      reviewed_at: null,
    },
  ];
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/security-alerts/summary")
      return { count: alerts.filter((a) => !a.reviewed_at).length };
    if (path.startsWith("/security-alerts?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const visible = alerts.filter(
        (a) =>
          (q.get("view") === "all" ||
            (q.get("view") === "reviewed"
              ? !!a.reviewed_at
              : !a.reviewed_at)) &&
          (!q.get("severity") || q.get("severity") === a.severity),
      );
      return { data: visible, count: visible.length };
    }
    if (
      path === "/security-alerts/privacy-alert" &&
      options?.method === "PATCH"
    ) {
      alerts[0].reviewed_at = "2026-10-13T08:00:00Z";
      return alerts[0];
    }
    if (path === "/reminders" || path.startsWith("/leaderboard")) return [];
    if (path.startsWith("/reports?")) return { leads: 0, by_status: {} };
    return { data: [], count: 0 };
  });
});
function workspace(path = "/security-alerts") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route element={<Layout />}>
                <Route path="/" element={<Dashboard />} />
                <Route element={<Protected role="admin" />}>
                  <Route path="/security-alerts" element={<SecurityAlerts />} />
                </Route>
              </Route>
            </Routes>
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    ),
    client,
  };
}
describe("P2 admin security alerts", () => {
  it("shows safe alert details and sidebar count, then reviews and refreshes both", async () => {
    workspace();
    await screen.findByText("Test agent");
    expect(
      await screen.findByLabelText("1 unreviewed security alerts"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("80 numbers shown · Daily limit 80"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await screen.findByText("Alert reviewed");
    await screen.findByLabelText("0 unreviewed security alerts");
    expect(await screen.findByText(/No records to show/)).toBeInTheDocument();
    expect(mocks.api).toHaveBeenCalledWith("/security-alerts/privacy-alert", {
      method: "PATCH",
      body: { reviewed: true },
    });
    fireEvent.change(screen.getByLabelText("Alert review status"), {
      target: { value: "reviewed" },
    });
    await screen.findByText("Test agent");
    expect(
      screen.queryByRole("button", { name: "Mark reviewed" }),
    ).not.toBeInTheDocument();
  });
  it("sends strict review/severity filters and resets page on filter changes", async () => {
    workspace();
    await screen.findByText("Test agent");
    fireEvent.change(screen.getByLabelText("Alert severity"), {
      target: { value: "critical" },
    });
    await waitFor(() =>
      expect(
        mocks.api.mock.calls.some(
          ([p]) =>
            p === "/security-alerts?page=1&view=unreviewed&severity=critical",
        ),
      ).toBe(true),
    );
    fireEvent.change(screen.getByLabelText("Alert review status"), {
      target: { value: "all" },
    });
    await waitFor(() =>
      expect(
        mocks.api.mock.calls.some(
          ([p]) => p === "/security-alerts?page=1&view=all&severity=critical",
        ),
      ).toBe(true),
    );
  });
  it("disables review while pending and prevents duplicate requests", async () => {
    const original = mocks.api.getMockImplementation();
    let resolve;
    mocks.api.mockImplementation((path, options) =>
      options?.method === "PATCH"
        ? new Promise((done) => (resolve = done))
        : original(path, options),
    );
    workspace();
    await screen.findByText("Test agent");
    const button = screen.getByRole("button", { name: "Mark reviewed" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(
      mocks.api.mock.calls.filter(([, o]) => o?.method === "PATCH"),
    ).toHaveLength(1);
    await act(async () => resolve({}));
    await screen.findByText("Alert reviewed");
  });
  it("keeps a failed review unreviewed and displays a readable retry error", async () => {
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      options?.method === "PATCH"
        ? Promise.reject(new Error("Review could not be saved"))
        : original(path, options),
    );
    workspace();
    await screen.findByText("Test agent");
    fireEvent.click(screen.getByRole("button", { name: "Mark reviewed" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Review could not be saved",
    );
    expect(screen.getByRole("button", { name: "Mark reviewed" })).toBeEnabled();
    expect(
      screen.getByLabelText("1 unreviewed security alerts"),
    ).toBeInTheDocument();
  });
  it("shows the unreviewed count on the administrator dashboard", async () => {
    workspace("/");
    await screen.findByRole("heading", { name: "Workspace overview" });
    const title = await screen.findByRole("heading", {
      name: "Unreviewed security alerts",
    });
    expect(title.closest("section").querySelector("strong")).toHaveTextContent(
      "1",
    );
    expect(
      screen.getByRole("link", { name: "Review security alerts" }),
    ).toHaveAttribute("href", "/security-alerts");
  });
  it("rejects the agent route and omits its navigation and dashboard queries", async () => {
    mocks.auth.user = {
      id: "privacy-agent",
      role: "agent",
      name: "Privacy agent",
    };
    workspace();
    await screen.findByRole("heading", { name: "My overview" });
    expect(
      screen.queryByRole("link", { name: /security alerts/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Unreviewed security alerts"),
    ).not.toBeInTheDocument();
    expect(
      mocks.api.mock.calls.some(([p]) => p.startsWith("/security-alerts")),
    ).toBe(false);
  });
});
