import { QueryClient, QueryClientProvider, focusManager, useQuery } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL, metaActive } from "../src/lib/polling";

vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: vi.fn(),
}));
const { api } = await import("../src/lib/api");
const { useMetaSummary } = await import("../src/lib/meta");
const { useSecurityAlertSummary } = await import("../src/lib/securityAlerts");
const { queryDefaults } = await import("../src/lib/queryDefaults");

const quiet = {
  meta: 0,
  total: 0,
  review: 0,
  facebook: 0,
  failures: 0,
  instagram: 0,
  duplicates: 0,
  processing: 0,
  unassigned: 0,
  notifications: [],
  assigned_today: 0,
};
const active = { ...quiet, total: 1, unassigned: 1, meta: 1 };
function Summary() {
  useMetaSummary({ id: "admin-1", role: "admin" });
  return null;
}
function Notifications() {
  useQuery({
    queryKey: ["notifications"],
    queryFn: ({ signal }) => api("/notifications", { signal }),
    refetchInterval: POLL.notifications,
  });
  return null;
}
function Security() {
  useSecurityAlertSummary(true);
  return null;
}
// The application's own defaults (main.jsx), without retries.
const mount = (ui) => {
  const client = new QueryClient({ defaultOptions: { queries: { ...queryDefaults.queries, retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
};
const calls = (path) => api.mock.calls.filter(([p]) => p === path).length;
const wait = (ms) => act(async () => vi.advanceTimersByTimeAsync(ms));
const setFocused = (value) => act(() => focusManager.setFocused(value));

describe("polling", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.mockReset();
    api.mockImplementation(async (path) => (path === "/integrations/meta/summary" ? quiet : { data: [], count: 0 }));
    focusManager.setFocused(true);
  });
  afterEach(() => {
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  });

  it("keeps security alerts at a minute and slows routine refreshes", async () => {
    expect(POLL.securityAlerts).toBe(60000);
    expect(POLL.notifications).toBe(120000);
    expect(POLL.systemStatus).toBe(300000);
    mount(<Security />);
    await wait(5 * 60000 + 1000);
    expect(calls("/security-alerts/summary")).toBe(6);
  });

  it("treats a summary with no social lead as inactive", () => {
    expect(metaActive(undefined)).toBe(false);
    expect(metaActive(quiet)).toBe(false);
    expect(metaActive({ ...quiet, total: 3 })).toBe(true);
    expect(metaActive({ ...quiet, processing: 1 })).toBe(true);
    expect(metaActive({ ...quiet, failures: 1 })).toBe(true);
    expect(metaActive({ ...quiet, notifications: [{ id: 1 }] })).toBe(true);
  });

  it("checks an unused Meta integration every 10 minutes, then every minute once the first lead arrives", async () => {
    mount(<Summary />);
    await wait(9 * 60000);
    expect(calls("/integrations/meta/summary")).toBe(1);
    // The first social lead arrives; the next slow check sees it.
    api.mockImplementation(async (path) => (path === "/integrations/meta/summary" ? active : null));
    await wait(60000 + 1000);
    expect(calls("/integrations/meta/summary")).toBe(2);
    await wait(3 * 60000);
    expect(calls("/integrations/meta/summary")).toBe(5);
  });

  it("does not poll in a hidden tab and refreshes when it is shown again", async () => {
    mount(<Notifications />);
    await wait(1000);
    expect(calls("/notifications")).toBe(1);
    setFocused(false);
    await wait(10 * 60000);
    expect(calls("/notifications")).toBe(1);
    setFocused(true);
    await wait(1000);
    expect(calls("/notifications")).toBe(2);
  });

  it("reuses data when returning within a minute (e.g. from WhatsApp), refreshes after", async () => {
    mount(<Notifications />);
    await wait(1000);
    setFocused(false);
    await wait(30000);
    setFocused(true);
    await wait(1000);
    expect(calls("/notifications")).toBe(1);
    setFocused(false);
    await wait(45000);
    setFocused(true);
    await wait(1000);
    expect(calls("/notifications")).toBe(2);
  });

  it("stops every timer when the page unmounts", async () => {
    const view = mount(
      <>
        <Notifications />
        <Summary />
        <Security />
      </>,
    );
    await wait(1000);
    const before = api.mock.calls.length;
    view.unmount();
    await wait(30 * 60000);
    expect(api.mock.calls.length).toBe(before);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
  });

  it("shares one request between the sidebar and the Overview", async () => {
    mount(
      <>
        <Notifications />
        <Notifications />
      </>,
    );
    await wait(2 * 120000 + 1000);
    expect(calls("/notifications")).toBe(3);
  });
});
