import React from "react";
import { beforeEach, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import SystemStatus from "../src/components/common/SystemStatus";
import Dashboard from "../src/pages/admin/Dashboard";
import { MemoryRouter } from "react-router-dom";
const mocks = vi.hoisted(() => ({ api: vi.fn(), role: "admin" }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    user: { role: mocks.role, name: "Team member", id: "fixture" },
  }),
}));
function open(child = <SystemStatus />) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>{child}</MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.role = "admin";
  mocks.api.mockReset().mockImplementation(async (path) =>
    path === "/health/status"
      ? {
          ready: true,
          jobs: [],
          last_job_at: "2026-10-14T05:00:00Z",
          backup: {
            status: "success",
            last_success_at: new Date().toISOString(),
          },
        }
      : path.startsWith("/reports")
        ? {}
        : path.startsWith("/leaderboard")
          ? []
          : { data: [] },
  );
});
it("shows real job and backup state", async () => {
  open();
  expect(
    await screen.findByText("Background jobs are running"),
  ).toBeInTheDocument();
  expect(screen.getByText("Last database backup")).toBeInTheDocument();
  expect(mocks.api).toHaveBeenCalledWith("/health/status");
});
it("reports missing migration without inventing success", async () => {
  mocks.api.mockResolvedValue({
    ready: false,
    message: "System monitoring needs database update 026 after 025.",
    jobs: [],
    last_job_at: null,
    backup: null,
  });
  open();
  expect(await screen.findByText(/026 after 025/)).toBeInTheDocument();
  expect(screen.getByText("No successful backup recorded")).toBeInTheDocument();
});
it("shows stale/failed jobs and old or failed backups", async () => {
  mocks.api.mockResolvedValue({
    ready: false,
    jobs: [
      { job: "followUpReminders", status: "stale" },
      { job: "processMetaLeads", status: "failed" },
    ],
    backup: { status: "failed", last_success_at: "2000-01-01T00:00:00Z" },
  });
  open();
  expect(
    await screen.findByText("Follow-up reminders: stale"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("Social lead processing: failed"),
  ).toBeInTheDocument();
  expect(
    screen.getByText("The latest database backup failed."),
  ).toBeInTheDocument();
  expect(screen.getByText(/over 36 hours/)).toBeInTheDocument();
});
it("shows API errors rather than a healthy state", async () => {
  mocks.api.mockRejectedValue(new Error("Status unavailable"));
  open();
  expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
  expect(screen.queryByText("Background jobs are running")).toBeNull();
});
it("mounts monitoring only for administrators", async () => {
  mocks.role = "agent";
  open(<Dashboard />);
  await screen.findByRole("heading", { name: "My overview" });
  expect(screen.queryByRole("heading", { name: "System status" })).toBeNull();
  expect(mocks.api.mock.calls.some(([path]) => path === "/health/status")).toBe(
    false,
  );
});
