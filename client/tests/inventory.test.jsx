import React from "react";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import Inventory from "../src/pages/shared/Inventory";
import { ToastProvider } from "../src/components/common/UI";
// Update 041. API responses are mocked here; the server tests check the
// same rules against the real database functions.
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: null },
}));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const agentRow = {
  id: "60000000-0000-4000-8000-000000000002",
  uid: 123456,
  name: "Ali Agent",
  email: "ali@gmail.com",
  status: "active",
  total: 3,
  available: 2,
  reserved: 0,
  sold: 1,
  rented: 0,
  last_updated: "2026-10-20T10:00:00Z",
};
const listing = {
  id: "60000000-0000-4000-8000-000000000010",
  property_no: 12,
  title: "DHA corner house",
  location: "Block C, DHA Phase 6, Lahore",
  city: "Lahore",
  type: "House",
  purpose: "sale",
  price: 45000000,
  area: 1,
  area_unit: "kanal",
  availability: "available",
  amenities: [],
};
const originalDialog = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
});
afterAll(() => {
  if (originalDialog)
    Object.defineProperty(
      HTMLDialogElement.prototype,
      "showModal",
      originalDialog,
    );
  else delete HTMLDialogElement.prototype.showModal;
});
let detail;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = { id: "admin-1", name: "Owner", role: "admin" };
  detail = { ...listing, ownership: "company", can_edit: true };
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/inventory/summary")
      return mocks.auth.user.role === "admin"
        ? {
            role: "admin",
            company: { total: 4 },
            agents: { total: 7 },
            all: { total: 11, available: 8, sold: 2, rented: 1 },
            agents_with_properties: 2,
          }
        : {
            role: "agent",
            mine: { total: 5, available: 3, reserved: 1, sold: 1, rented: 0 },
            company: { total: 4 },
          };
    if (path.startsWith("/inventory/agents"))
      return { data: [agentRow], count: 1, page: 1, limit: 20 };
    if (path.endsWith("/photos")) return [];
    if (path === "/properties/" + listing.id && !options?.method) return detail;
    if (["POST", "PATCH"].includes(options?.method))
      return { ...detail, ...options.body };
    if (path.includes("scope=agent"))
      return {
        data: [listing],
        count: 1,
        agent: {
          id: agentRow.id,
          name: "Ali Agent",
          email: agentRow.email,
          status: "active",
        },
      };
    return { data: [listing], count: 1 };
  });
});
function workspace(entry = "/inventory") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Inventory />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const listCalls = () =>
  mocks.api.mock.calls
    .map(([path]) => path)
    .filter((path) => path.startsWith("/properties?"));

describe("inventory tabs and statistics", () => {
  it("shows administrators the company inventory, agent directory and CRM totals", async () => {
    workspace();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent);
    expect(tabs).toEqual(["Admin properties", "Agent inventories"]);
    const stats = screen.getByRole("region", { name: "Inventory summary" });
    await within(stats).findByText("11");
    expect(within(stats).getByText("Agents with listings")).toBeInTheDocument();
    expect(within(stats).getByText("3")).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "+ Add property" }),
    ).toBeInTheDocument();
    expect(listCalls()[0]).toMatch(/^\/properties\?scope=company&/);
  });
  it("shows agents their own inventory and the read-only company inventory", async () => {
    mocks.auth.user = { id: "agent-1", name: "Ali", role: "agent" };
    const user = userEvent.setup();
    workspace();
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual([
      "My properties",
      "Admin inventory",
    ]);
    const stats = screen.getByRole("region", { name: "Inventory summary" });
    expect(await within(stats).findByText("5")).toBeInTheDocument();
    expect(within(stats).queryByText("Agents with listings")).toBeNull();
    expect(listCalls()[0]).toMatch(/scope=mine/);
    await user.click(screen.getByRole("tab", { name: "Admin inventory" }));
    expect(
      await screen.findByText(/You can view them but not change them/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "+ Add property" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(listCalls().at(-1)).toMatch(/scope=company/));
    expect(mocks.api).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/inventory\/agents/),
      expect.anything(),
    );
  });
  it("reports a missing database update once, without the empty-inventory text", async () => {
    mocks.auth.user = { id: "agent-1", name: "Ali", role: "agent" };
    mocks.api.mockRejectedValue(
      Object.assign(
        new Error("Inventory needs CRM database update 041 after 040."),
        { status: 503 },
      ),
    );
    workspace();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "database update 041",
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("region", { name: "Inventory summary" }),
      ).toBeNull(),
    );
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText(/not added any properties/)).toBeNull();
  });
  it("moves between tabs with the arrow keys", async () => {
    const user = userEvent.setup();
    workspace();
    screen.getByRole("tab", { name: "Admin properties" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(
      screen.getByRole("tab", { name: "Agent inventories", selected: true }),
    ).toHaveFocus();
  });
});

describe("agent inventories for administrators", () => {
  it("lists agents with counts and opens a read-only agent inventory", async () => {
    const user = userEvent.setup();
    workspace("/inventory?tab=agents");
    expect(await screen.findByText("Ali Agent")).toBeInTheDocument();
    expect(screen.getByText("ali@gmail.com")).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Open Ali Agent's inventory" }),
    );
    expect(
      await screen.findByText(
        "Agent inventories are read-only for administrators.",
      ),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(listCalls().at(-1)).toMatch(
        new RegExp(`scope=agent&page=1&covers=true&agent=${agentRow.id}`),
      ),
    );
    expect(await screen.findByRole("status")).toHaveTextContent("Ali Agent");
    expect(
      screen.queryByRole("button", { name: "+ Add property" }),
    ).not.toBeInTheDocument();
    detail = {
      ...listing,
      ownership: "agent",
      owner_agent_name: "Ali Agent",
      can_edit: false,
    };
    await user.click(screen.getByRole("button", { name: /View property/ }));
    const dialog = screen.getByRole("dialog");
    expect(
      await within(dialog).findByText("Ali Agent's inventory"),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Edit property" }),
    ).toBeNull();
    expect(dialog.querySelector('input[type="file"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await user.click(screen.getByRole("button", { name: "← All agents" }));
    expect(
      await screen.findByRole("button", { name: /Open Ali Agent/ }),
    ).toBeInTheDocument();
  });
});

describe("filters", () => {
  it("sends search, type, purpose, status, area and price filters to the server", async () => {
    const user = userEvent.setup();
    workspace();
    await screen.findByText(listing.title);
    await user.selectOptions(
      screen.getByLabelText("Filter by purpose"),
      "rent",
    );
    await user.selectOptions(
      screen.getByLabelText("Filter by status"),
      "rented",
    );
    await user.selectOptions(
      screen.getByLabelText("Filter by type"),
      "Apartment",
    );
    await user.type(screen.getByLabelText("Filter by city or area"), "DHA");
    await user.type(screen.getByLabelText("Maximum price"), "90000");
    await user.selectOptions(
      screen.getByLabelText("Sort properties"),
      "price_low",
    );
    await waitFor(() => {
      const query = new URLSearchParams(listCalls().at(-1).split("?")[1]);
      expect(Object.fromEntries(query)).toMatchObject({
        scope: "company",
        purpose: "rent",
        status: "rented",
        type: "Apartment",
        city: "DHA",
        max_price: "90000",
        sort: "price_low",
      });
    });
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(listCalls().at(-1)).toBe(
        "/properties?scope=company&page=1&covers=true",
      ),
    );
  });
});

describe("property form", () => {
  async function openNew(user) {
    await user.click(
      await screen.findByRole("button", { name: "+ Add property" }),
    );
    await user.type(screen.getByLabelText("Property title"), "Plot in Bahria");
    await user.type(screen.getByLabelText("City"), "Rawalpindi");
    await user.type(screen.getByLabelText("Size"), "10");
    await user.type(screen.getByLabelText("Price (PKR)"), "9000000");
  }
  const saved = () =>
    mocks.api.mock.calls.find(
      ([path, options]) => path === "/properties" && options?.method === "POST",
    )?.[1].body;
  it("hides building details for plots and matches status to the purpose", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    await user.selectOptions(screen.getByLabelText("Property type"), "House");
    expect(screen.getByLabelText("Bedrooms")).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("Property type"),
      "Residential Plot",
    );
    expect(screen.queryByLabelText("Bedrooms")).not.toBeInTheDocument();
    const status = screen.getByLabelText("Status");
    expect(
      within(status).getByRole("option", { name: "Sold" }),
    ).toBeInTheDocument();
    expect(within(status).queryByRole("option", { name: "Rented" })).toBeNull();
    await user.selectOptions(screen.getByLabelText("Purpose"), "rent");
    expect(screen.getByText("Monthly rent")).toBeInTheDocument();
    expect(within(status).queryByRole("option", { name: "Sold" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property saved");
    expect(saved()).toMatchObject({
      title: "Plot in Bahria",
      type: "Residential Plot",
      purpose: "rent",
      city: "Rawalpindi",
      area: 10,
      price: 9000000,
    });
    expect(saved()).not.toHaveProperty("bedrooms");
  });
  it("never sends an owner and shares owner contact only for company listings", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    await user.selectOptions(screen.getByLabelText("Property type"), "House");
    await user.type(screen.getByLabelText("Owner phone"), "12");
    await user.click(screen.getByRole("button", { name: "Save record" }));
    expect(
      await screen.findByText("Enter a phone number such as 0300 1234567"),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Owner phone"));
    await user.type(screen.getByLabelText("Owner phone"), "0300 1234567");
    await user.click(
      screen.getByLabelText("Share owner name and phone with agents"),
    );
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property saved");
    expect(saved().owner_contact).toMatchObject({
      owner_phone: "0300 1234567",
      share_with_agents: true,
    });
    for (const key of ["owner_agent_id", "created_by", "ownership"])
      expect(saved()).not.toHaveProperty(key);
  });
  it("gives agents a private owner contact without a sharing option", async () => {
    mocks.auth.user = { id: "agent-1", name: "Ali", role: "agent" };
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    await user.selectOptions(screen.getByLabelText("Property type"), "Shop");
    expect(
      screen.getByText("Visible only to you and administrators."),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Share owner name and phone with agents"),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property saved");
    expect(saved().owner_contact.share_with_agents).toBe(false);
  });
  it("sends the loaded version when editing so a newer save is not overwritten", async () => {
    detail = {
      ...detail,
      updated_at: "2026-10-21T08:00:00.123456+00:00",
      owner_contact: { owner_name: "Mr Khan", owner_phone: "+923001234567" },
    };
    const user = userEvent.setup();
    workspace();
    await user.click(
      await screen.findByRole("button", { name: /View property/ }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Edit property" }),
    );
    // The private contact loaded with the full record, so saving keeps it.
    expect(screen.getByLabelText("Owner name")).toHaveValue("Mr Khan");
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property saved");
    const patch = mocks.api.mock.calls.find(([, o]) => o?.method === "PATCH");
    expect(patch[0]).toBe("/properties/" + listing.id);
    expect(patch[1].body).toMatchObject({
      expected_updated_at: "2026-10-21T08:00:00.123456+00:00",
      owner_contact: { owner_name: "Mr Khan", owner_phone: "+923001234567" },
    });
  });
});
