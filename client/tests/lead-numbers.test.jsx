import React from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { Table, ToastProvider } from "../src/components/common/UI";
import RecordsPage from "../src/components/common/RecordsPage";
import Dashboard from "../src/pages/admin/Dashboard";
import { formatLeadNo } from "../src/lib/formatLeadNo";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  user: { id: "agent", role: "agent", name: "Agent" },
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/components/common/SystemStatus", () => ({
  default: () => null,
}));
function mount(element) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ToastProvider>
        <MemoryRouter>{element}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  mocks.user.role = "agent";
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path) =>
    path.startsWith("/dashboard")
      ? {
          metrics: { total_leads: 356, assigned_leads: 42 },
          followups: [],
          visits: [],
          targets: [],
          leaders: [],
        }
      : {
          data: [
            {
              id: "record",
              lead_id: "lead",
              leads: { lead_no: 123, name: "Customer" },
              status: "pending",
              stage: "discussion",
            },
          ],
          count: 1,
        },
  );
});
describe("lead numbering shared by both portals", () => {
  it("formats large database bigint strings without precision loss", () => {
    expect(formatLeadNo("9007199254740993")).toBe("HD-9007199254740993");
    expect(formatLeadNo(123)).toBe("HD-000123");
  });
  it("continues serials on page two in the current row order", () => {
    mount(
      <Table
        showSerial
        page={2}
        count={356}
        rows={[{ id: "a", name: "Second page" }]}
        columns={[{ key: "name", label: "Customer" }]}
      />,
    );
    expect(screen.getByRole("cell", { name: "21" })).toBeInTheDocument();
    expect(screen.getByText("Showing 21–40 of 356 leads")).toBeInTheDocument();
  });
  it.each(["agent", "admin"])(
    "shows HD numbers, serials and counts on all %s activity lists",
    async (role) => {
      mocks.user.role = role;
      for (const entity of ["followups", "visits", "deals"]) {
        const view = mount(<RecordsPage entity={entity} title={entity} />);
        expect(await screen.findByText(/HD-000123/)).toBeInTheDocument();
        expect(
          screen.getByRole("columnheader", { name: "#" }),
        ).toBeInTheDocument();
        expect(screen.getByText("Showing 1–1 of 1 leads")).toBeInTheDocument();
        view.unmount();
      }
    },
  );
  it.each([
    ["agent", "My leads", "42"],
    ["admin", "Total leads", "356"],
  ])(
    "shows the scoped total on the %s dashboard",
    async (role, label, total) => {
      mocks.user.role = role;
      mount(<Dashboard />);
      expect(await screen.findByText(label)).toBeInTheDocument();
      expect(screen.getByText(total)).toBeInTheDocument();
    },
  );
});
