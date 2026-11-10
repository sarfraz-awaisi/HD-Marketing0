import React from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import App from "../src/App";
import PropertyDetails from "../src/components/properties/PropertyDetails";
import { ToastProvider } from "../src/components/common/UI";
import { isPlot, propertyTypes } from "../src/lib/inventory";
// Opening any plot (Residential Plot, Commercial Plot, Land) showed "Page
// could not load": the details listed building details as false, and
// false?.map threw. Every property type must open, from every inventory tab.
const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ ...mocks.auth, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
});
afterAll(() => {
  if (original) Object.defineProperty(HTMLDialogElement.prototype, "showModal", original);
  else delete HTMLDialogElement.prototype.showModal;
});
const agentId = "61000000-0000-4000-8000-000000000002";
const property = (type, extra = {}) => ({
  id: "61000000-0000-4000-8000-0000000000" + String(10 + propertyTypes.indexOf(type)).padStart(2, "0"),
  property_no: 40 + propertyTypes.indexOf(type),
  title: `${type} in DHA`,
  location: "DHA Phase 6, Lahore",
  city: "Lahore",
  type,
  purpose: "sale",
  price: 25000000,
  area: 10,
  area_unit: "marla",
  availability: "available",
  amenities: ["corner"],
  building_categories: [],
  floor_level: null,
  bedrooms: isPlot(type) ? null : 3,
  floors: isPlot(type) ? null : 2,
  created_at: "2026-11-10T05:00:00Z",
  ...extra,
});

describe("property details", () => {
  it.each(propertyTypes)("open for a %s", (type) => {
    render(<PropertyDetails property={property(type)} />);
    const details = screen.getByRole("region", { name: "Property details" });
    expect(details).toHaveTextContent("PR-0000");
    expect(details).toHaveTextContent("10 Marla");
    expect(details).toHaveTextContent(type);
    // Plots and land show no building details.
    if (isPlot(type)) {
      expect(within(details).queryByText("Bedrooms")).toBeNull();
      expect(within(details).queryByText("Floors")).toBeNull();
    } else expect(within(details).getByText("Bedrooms")).toBeInTheDocument();
  });
});

describe("View on a plot in the inventory", () => {
  const plot = { ...property("Residential Plot"), owner_agent_id: agentId };
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.api.mockImplementation(async (path) => {
      if (path === "/inventory/summary")
        return { role: "admin", company: { total: 1 }, agents: { total: 1 }, all: { total: 2 }, mine: { total: 1 } };
      if (path.startsWith("/inventory/agents"))
        return { data: [{ id: agentId, uid: 123456, name: "Ali Agent", status: "active", total: 1 }], count: 1, page: 1, limit: 20 };
      if (path.startsWith("/properties?"))
        return {
          data: [plot],
          count: 1,
          ...(path.includes("scope=agent") ? { agent: { id: agentId, name: "Ali Agent", status: "active" } } : {}),
        };
      if (path === `/properties/${plot.id}`) return { ...plot, ownership: "agent", can_edit: false, can_promote: true };
      if (path.endsWith("/photos") || path.endsWith("/documents")) return [];
      return { data: [], count: 0 };
    });
  });
  it.each([
    ["admin", "/inventory?tab=company"],
    ["admin", `/inventory?tab=agents&agent=${agentId}`],
    ["agent", "/inventory?tab=mine"],
    ["agent", "/inventory?tab=company"],
  ])("opens for an %s at %s", async (role, entry) => {
    mocks.auth.user = { id: role === "admin" ? "61000000-0000-4000-8000-0000000000a1" : agentId, name: "User", role };
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ToastProvider>
          <MemoryRouter initialEntries={[entry]}>
            <App />
          </MemoryRouter>
        </ToastProvider>
      </QueryClientProvider>,
    );
    await user.click(await screen.findByRole("button", { name: "Open Residential Plot in DHA details" }));
    const dialog = await screen.findByRole("dialog", { name: "Residential Plot in DHA" });
    expect(within(dialog).getByRole("region", { name: "Property details" })).toHaveTextContent("Residential Plot");
    expect(screen.queryByText("Page could not load")).toBeNull();
  });
});
