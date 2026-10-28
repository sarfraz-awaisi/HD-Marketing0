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
import { categorySummary } from "../src/lib/inventory";
// Update 046: building categories in the property form, details and cards.
// API responses are mocked; the server tests check the same rules against
// the real database functions.
const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const listing = {
  id: "46000000-0000-4000-8000-000000000010",
  property_no: 1024,
  title: "Main Boulevard Plaza",
  location: "Gulberg, Lahore",
  city: "Lahore",
  type: "Building",
  purpose: "sale",
  price: 250000000,
  area: 2,
  area_unit: "kanal",
  availability: "available",
  amenities: [],
  building_categories: [
    "residential_1_bed",
    "residential_2_bed",
    "residential_3_bed",
    "hotel_apartment_1_bed",
    "hotel_apartment_2_bed",
    "commercial_outlet",
    "workspace",
  ],
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
let detail, rows;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = { id: "admin-1", name: "Owner", role: "admin" };
  detail = { ...listing, ownership: "company", can_edit: true };
  rows = [listing];
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/inventory/summary")
      return {
        role: "admin",
        company: { total: 1 },
        agents: { total: 0 },
        all: { total: 1 },
      };
    if (path.endsWith("/photos")) return [];
    if (path === "/properties/" + listing.id && !options?.method) return detail;
    if (["POST", "PATCH"].includes(options?.method))
      return { ...detail, ...options.body };
    return { data: rows, count: rows.length };
  });
});
function workspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/inventory"]}>
          <Inventory />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const box = (name) => screen.getByRole("checkbox", { name });
const sent = (method) =>
  mocks.api.mock.calls.find(([, o]) => o?.method === method)?.[1].body;
async function openNew(user, type = "Building") {
  await user.click(
    await screen.findByRole("button", { name: "+ Add property" }),
  );
  await user.type(screen.getByLabelText("Property title"), "Mixed-use tower");
  await user.selectOptions(screen.getByLabelText("Property type"), type);
  await user.type(screen.getByLabelText("City"), "Lahore");
  await user.type(screen.getByLabelText("Size"), "4");
  await user.type(screen.getByLabelText("Price (PKR)"), "500000000");
}

describe("the property form", () => {
  it("offers the categories inside Building details, several at once", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    const building = screen.getByRole("group", { name: "Building details" });
    const picker = within(building).getByRole("group", {
      name: "Building categories",
    });
    for (const group of [
      "Residential",
      "Hotel Apartments",
      "Commercial",
      "Workspaces",
    ])
      expect(
        within(picker).getByRole("group", { name: group }),
      ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Location" }),
    ).not.toContainElement(picker);
    await user.click(box("Residential — 1 Bedroom"));
    await user.click(box("Residential — 2 Bedrooms"));
    // Each box is independent: residential is not hotel.
    expect(box("Hotel Apartments — 1 Bedroom")).not.toBeChecked();
    await user.click(box("Hotel Apartments — 1 Bedroom"));
    await user.click(box("Commercial Outlets / Retail Shops"));
    await user.click(box("Office Spaces / Workspaces"));
    await user.click(box("Residential — 2 Bedrooms"));
    expect(box("Residential — 2 Bedrooms")).not.toBeChecked();
    // The bedroom count of the listed unit is a separate field.
    await user.type(screen.getByLabelText("Bedrooms"), "3");
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property saved");
    expect(sent("POST")).toMatchObject({
      type: "Building",
      bedrooms: 3,
      building_categories: [
        "residential_1_bed",
        "hotel_apartment_1_bed",
        "commercial_outlet",
        "workspace",
      ],
    });
  });
  it("lets agents choose every category", async () => {
    mocks.auth.user = { id: "agent-1", name: "Ali", role: "agent" };
    const user = userEvent.setup();
    workspace();
    await openNew(user, "Apartment");
    const picker = screen.getByRole("group", { name: "Building categories" });
    const boxes = within(picker).getAllByRole("checkbox");
    expect(boxes).toHaveLength(8);
    for (const b of boxes) await user.click(b);
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property saved");
    expect(sent("POST").building_categories).toHaveLength(8);
  });
  it("hides the categories for plots and land and sends none", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    await user.click(box("Office Spaces / Workspaces"));
    await user.selectOptions(screen.getByLabelText("Property type"), "Land");
    expect(
      screen.queryByRole("group", { name: "Building categories" }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property saved");
    expect(sent("POST")).not.toHaveProperty("building_categories");
  });
});

describe("viewing and editing", () => {
  it("shows the chosen categories by group, in words", async () => {
    const user = userEvent.setup();
    workspace();
    await user.click(
      await screen.findByRole("button", { name: /View property/ }),
    );
    const heading = await screen.findByRole("heading", {
      name: "Building categories",
    });
    const list = heading.nextElementSibling;
    expect(list).toHaveTextContent(
      "Residential1 Bedroom2 Bedrooms3 BedroomsHotel Apartments1 Bedroom2 BedroomsCommercialCommercial Outlets / Retail ShopsWorkspacesOffice Spaces / Workspaces",
    );
    expect(
      screen.getByRole("dialog").textContent.includes("residential_1_bed"),
    ).toBe(false);
  });
  it("omits the section for properties without categories", async () => {
    detail = { ...detail, building_categories: [] };
    rows = [{ ...listing, building_categories: [] }];
    const user = userEvent.setup();
    workspace();
    await user.click(
      await screen.findByRole("button", { name: /View property/ }),
    );
    await screen.findByRole("heading", { name: "Description" });
    expect(
      screen.queryByRole("heading", { name: "Building categories" }),
    ).toBeNull();
  });
  it("loads saved categories, saves changes and keeps them when an edit is closed", async () => {
    detail = {
      ...detail,
      building_categories: ["residential_1_bed", "commercial_outlet"],
      updated_at: "2026-10-29T08:00:00.000000+00:00",
    };
    const user = userEvent.setup();
    workspace();
    const edit = async () => {
      await user.click(
        await screen.findByRole("button", { name: /View property/ }),
      );
      await user.click(
        await screen.findByRole("button", { name: "Edit property" }),
      );
    };
    await edit();
    expect(box("Residential — 1 Bedroom")).toBeChecked();
    expect(box("Commercial Outlets / Retail Shops")).toBeChecked();
    expect(box("Office Spaces / Workspaces")).not.toBeChecked();
    // Changed, then closed without saving: nothing is sent.
    await user.click(box("Residential — 1 Bedroom"));
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(sent("PATCH")).toBeUndefined();
    await edit();
    expect(box("Residential — 1 Bedroom")).toBeChecked();
    await user.click(box("Residential — 1 Bedroom"));
    await user.click(box("Office Spaces / Workspaces"));
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property saved");
    expect(sent("PATCH")).toMatchObject({
      building_categories: ["commercial_outlet", "workspace"],
      expected_updated_at: "2026-10-29T08:00:00.000000+00:00",
    });
  });
});

describe("property cards", () => {
  it("summarize the categories in one short line", async () => {
    workspace();
    expect(
      await screen.findByText(
        "Residential 1, 2, 3 bed · Hotel apartments 1, 2 bed · Retail shops · Workspaces",
      ),
    ).toBeInTheDocument();
    expect(categorySummary(["workspace", "commercial_outlet"])).toBe(
      "Retail shops · Workspaces",
    );
    expect(categorySummary([])).toBe("");
  });
});
