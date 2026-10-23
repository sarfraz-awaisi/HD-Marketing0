import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import Dashboard from "../src/pages/admin/Dashboard";
import KycClientPicker from "../src/components/documents/KycClientPicker";
import { api } from "../src/lib/api";
import { useMetaSummary } from "../src/lib/meta";
import { useSecurityAlertSummary } from "../src/lib/securityAlerts";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = { id: "fixture-admin", role: "admin", name: "Admin User" };
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: admin }),
}));
beforeEach(() => {
  vi.useFakeTimers();
  mocks.api
    .mockReset()
    .mockImplementation(async (path) =>
      path === "/health/status"
        ? { ready: true, jobs: [] }
        : path.startsWith("/dashboard")
          ? { metrics: {}, leaders: [], followups: [], visits: [] }
          : path.startsWith("/documents/clients")
            ? []
            : { data: [] },
    );
});
afterEach(() => vi.useRealTimers());
// The app's query defaults (main.jsx), without retries.
const client = () =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 15000 } },
  });
const requests = (path) =>
  mocks.api.mock.calls.filter(([url]) => url === path).length;
const wait = (ms) => act(() => vi.advanceTimersByTimeAsync(ms));
// The queries the layout keeps polling around every page (Layout.jsx).
function LayoutPolls() {
  useSecurityAlertSummary(true);
  useMetaSummary(admin);
  useQuery({
    queryKey: ["notifications"],
    queryFn: ({ signal }) => api("/notifications", { signal }),
    refetchInterval: 60000,
  });
  return null;
}

// The admin Overview's polling budget, which the API's per-user limits are
// sized against (docs/RATE_LIMITS.md). The layout and the Overview both show
// these queries; React Query restarts every component's interval whenever the
// shared query updates, so they poll together, once per interval.
describe("polling shared by the layout and a page", () => {
  it("fetches each of the Overview's shared queries once per interval", async () => {
    const cache = client();
    const page = (overview) => (
      <QueryClientProvider client={cache}>
        <MemoryRouter>
          <LayoutPolls />
          {overview && <Dashboard />}
        </MemoryRouter>
      </QueryClientProvider>
    );
    // Signed in at 0 s; the Overview opens 10 s later and stays open.
    const { rerender } = render(page(false));
    await wait(10000);
    rerender(page(true));
    await wait(300000);
    // Once on sign-in, then every 30 s or 60 s until 310 s.
    expect(requests("/integrations/meta/summary")).toBe(11);
    expect(requests("/security-alerts/summary")).toBe(6);
    expect(requests("/notifications")).toBe(6);
  });
});

describe("client search", () => {
  it("searches KYC clients once typing pauses, not on every keystroke", async () => {
    render(
      <QueryClientProvider client={client()}>
        <KycClientPicker value="" onChange={() => {}} />
      </QueryClientProvider>,
    );
    await wait(0);
    const box = screen.getByLabelText("Search clients for KYC");
    for (const text of ["A", "Ah", "Ahm", "Ahme", "Ahmed"]) {
      fireEvent.change(box, { target: { value: text } });
      await wait(80);
    }
    await wait(500);
    expect(
      mocks.api.mock.calls
        .map(([url]) => url)
        .filter((url) => url.startsWith("/documents/clients?")),
    ).toEqual([
      "/documents/clients?search=&limit=20",
      "/documents/clients?search=Ahmed&limit=20",
    ]);
  });
});
