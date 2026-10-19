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
import { deviceLabel } from "../src/pages/admin/LoginHistory";
import { securityAlertLabel } from "../src/lib/securityAlerts";
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = {
  id: "b1000000-0000-4000-8000-000000000001",
  uid: 741205,
  name: "Owner",
  role: "admin",
  active: true,
};
const agent = {
  id: "b1000000-0000-4000-8000-000000000002",
  uid: 583214,
  name: "Agent One",
  role: "agent",
  active: true,
};
const chrome =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";
const historyCalls = () =>
  mocks.api.mock.calls.filter(([path]) => path.startsWith("/login-history"));
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
  mocks.api.mockImplementation(async (path) => {
    if (path === "/users") return [admin, agent];
    if (path.startsWith("/login-history"))
      return {
        data: [
          {
            id: 2,
            created_at: "2026-10-17T03:00:00Z",
            email: "agent@gmail.com",
            portal: "agent",
            outcome: "locked",
            ip: "203.0.113.7",
            user_agent: chrome,
            user_name: "Agent One",
            user_uid: 583214,
          },
          {
            id: 1,
            created_at: "2026-10-17T02:59:00Z",
            email: "nobody@gmail.com",
            portal: "agent",
            outcome: "failed",
            ip: "203.0.113.7",
            user_agent: "",
            user_name: null,
            user_uid: null,
          },
        ],
        count: 2,
        page: 1,
        limit: 20,
        summary: { failed_24h: 6, locked_now: 1 },
      };
    if (path === "/reminders") return [];
    if (path === "/security-alerts/summary") return { count: 0 };
    return { data: [], count: 0 };
  });
});
describe("admin login history", () => {
  it("lists attempts with account UID, readable results and devices", async () => {
    open("/login-history");
    expect(
      await screen.findByRole("heading", { name: "Login history" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("cell", { name: "Agent One · UID 583214" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("table")).getByText("Unknown account"),
    ).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Locked")).toHaveClass(
      "account-status",
    );
    expect(
      within(screen.getByRole("table")).getByText("Wrong password"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("table")).getByText("Chrome on Windows"),
    ).toHaveAttribute("title", chrome);
    expect(screen.getByText("6")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Login history" }),
    ).toBeInTheDocument();
  });
  it("sends account, result and Pakistan-time date filters", async () => {
    open("/login-history");
    await screen.findByRole("cell", { name: "Agent One · UID 583214" });
    fireEvent.change(screen.getByLabelText("Filter by account"), {
      target: { value: agent.id },
    });
    fireEvent.change(screen.getByLabelText("Filter by result"), {
      target: { value: "failed" },
    });
    fireEvent.change(screen.getByLabelText("From date"), {
      target: { value: "2026-10-16" },
    });
    fireEvent.change(screen.getByLabelText("To date"), {
      target: { value: "2026-10-17" },
    });
    await waitFor(() => {
      const last = new URLSearchParams(historyCalls().at(-1)[0].split("?")[1]);
      expect(Object.fromEntries(last)).toEqual({
        page: "1",
        limit: "20",
        user: agent.id,
        outcome: "failed",
        from: "2026-10-15T19:00:00.000Z",
        to: "2026-10-17T19:00:00.000Z",
      });
    });
  });
  it("is not available to agents", async () => {
    mocks.user = { ...agent };
    open("/login-history");
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Login history" }),
      ).not.toBeInTheDocument(),
    );
    expect(historyCalls()).toHaveLength(0);
    expect(
      screen.queryByRole("link", { name: "Login history" }),
    ).not.toBeInTheDocument();
  });
  it("labels devices and the new security alerts", () => {
    expect(
      deviceLabel(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone/iPad");
    expect(deviceLabel("")).toBe("—");
    expect(securityAlertLabel("account_login_locked")).toBe(
      "Sign-in locked after wrong passwords",
    );
    expect(securityAlertLabel("after_hours_login")).toBe(
      "Sign-in outside business hours",
    );
  });
});
