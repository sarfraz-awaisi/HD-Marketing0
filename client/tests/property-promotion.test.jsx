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
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router-dom";
import Inventory from "../src/pages/shared/Inventory";
import { ToastProvider } from "../src/components/common/UI";
// Update 044: Add to Admin List. API responses are mocked here; the server
// tests check the same rules against the real database functions.
const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const agentId = "60000000-0000-4000-8000-000000000002";
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
  ownership: "agent",
  owner_agent_id: agentId,
  owner_agent_name: "Ali Agent",
};
const copy = {
  ...listing,
  id: "60000000-0000-4000-8000-000000000020",
  property_no: 20,
  ownership: "company",
  owner_agent_id: null,
  owner_agent_name: null,
  promoted_from: {
    agent_name: "Ali Agent",
    agent_uid: 123456,
    agent_status: "active",
    promoted_at: "2026-10-28T09:00:00Z",
  },
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
let detail, promoteReply;
const posts = () =>
  mocks.api.mock.calls.filter(([path]) => path.endsWith("/promote"));
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = { id: "admin-1", name: "Owner", role: "admin" };
  detail = { ...listing, can_edit: false, can_promote: true, admin_copy: null };
  promoteReply = async () => ({ ...copy, can_edit: true, photos_missing: 0 });
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/inventory/summary")
      return {
        role: "admin",
        company: { total: 5 },
        agents: { total: 18 },
        all: { total: 23, available: 20, sold: 1, rented: 0 },
        unique: { total: 21, available: 18, sold: 1, rented: 0 },
        promoted: 2,
        agents_with_properties: 2,
      };
    if (path.endsWith("/photos")) return [];
    if (path.endsWith("/promote")) return promoteReply();
    if (path === "/properties/" + listing.id) return detail;
    if (path === "/properties/" + copy.id)
      return {
        ...copy,
        can_edit: mocks.auth.user.role === "admin",
        ...(mocks.auth.user.role === "admin"
          ? {
              promoted_from: {
                ...copy.promoted_from,
                source_id: listing.id,
                source_property_no: 12,
                source_removed: false,
                promoted_by_name: "Owner",
              },
            }
          : {}),
      };
    if (path.includes("scope=agent"))
      return {
        data: [listing],
        count: 1,
        agent: {
          id: agentId,
          uid: 123456,
          name: "Ali Agent",
          status: "active",
        },
      };
    if (path.includes("scope=company")) return { data: [copy], count: 1 };
    return { data: [], count: 0 };
  });
});
let location;
function Where() {
  location = useLocation();
  return null;
}
function workspace(entry) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Inventory />
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
async function openAgentListing(user) {
  workspace(`/inventory?tab=agents&agent=${agentId}`);
  await user.click(
    await screen.findByRole("button", {
      name: "Open DHA corner house details",
    }),
  );
  return screen.findByRole("dialog", { name: "DHA corner house" });
}

describe("Add to Admin List", () => {
  it("confirms, adds once and then links to the admin copy", async () => {
    const user = userEvent.setup();
    let dialog = await openAgentListing(user);
    await user.click(
      await within(dialog).findByRole("button", { name: "Add to Admin List" }),
    );
    dialog = screen.getByRole("dialog", {
      name: "Add property to Admin List?",
    });
    expect(dialog).toHaveTextContent("PR-000012 · DHA corner house");
    expect(dialog).toHaveTextContent("Listed byAli Agent");
    expect(dialog).toHaveTextContent("Agent UID123456");
    expect(dialog).toHaveTextContent(
      "This creates an independent copy in Admin Properties",
    );
    expect(dialog).toHaveTextContent(
      "Ali Agent's original property stays unchanged",
    );
    expect(dialog).toHaveTextContent(
      "Future edits to the agent's property will not change the admin copy",
    );
    expect(dialog).toHaveTextContent(
      "Administrators will be notified when the agent updates",
    );
    // Cancel goes back without asking the server.
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    dialog = screen.getByRole("dialog", { name: "DHA corner house" });
    expect(posts()).toEqual([]);
    await user.click(
      within(dialog).getByRole("button", { name: "Add to Admin List" }),
    );
    dialog = screen.getByRole("dialog", {
      name: "Add property to Admin List?",
    });
    detail = {
      ...detail,
      can_promote: false,
      admin_copy: { id: copy.id, property_no: 20 },
    };
    const confirm = within(dialog).getByRole("button", {
      name: "Add to Admin List",
    });
    // A second click while the first is saving sends nothing more.
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(
      await screen.findByText("Added to Admin List as PR-000020"),
    ).toBeInTheDocument();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]).toEqual([
      `/properties/${listing.id}/promote`,
      { method: "POST", body: {} },
    ]);
    dialog = screen.getByRole("dialog", { name: "DHA corner house" });
    const status = within(dialog).getByRole("status");
    expect(status).toHaveTextContent("Added to Admin List");
    expect(status).toHaveTextContent("Admin copy PR-000020");
    expect(
      within(dialog).queryByRole("button", { name: "Add to Admin List" }),
    ).toBeNull();
    await user.click(
      within(status).getByRole("button", { name: "Open admin copy" }),
    );
    // The admin copy opens in Admin properties, with where it came from.
    const opened = await screen.findByRole("dialog", {
      name: "DHA corner house",
    });
    await waitFor(() =>
      expect(
        within(opened).getByRole("region", { name: "Original listing" }),
      ).toBeInTheDocument(),
    );
    const origin = within(opened).getByRole("region", {
      name: "Original listing",
    });
    expect(origin).toHaveTextContent("Promoted from Agent Inventory");
    expect(origin).toHaveTextContent("Originally listed byAli Agent");
    expect(origin).toHaveTextContent("Agent UID123456");
    expect(origin).toHaveTextContent("Original propertyPR-000012");
    expect(location.search).toBe("?tab=company");
    expect(
      screen.getByRole("tab", { name: "Admin properties" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("explains a refusal in the confirmation", async () => {
    const user = userEvent.setup();
    promoteReply = async () => {
      throw Object.assign(
        new Error("This property is already in the Admin list as PR-000020"),
        { status: 409 },
      );
    };
    const dialog = await openAgentListing(user);
    await user.click(
      await within(dialog).findByRole("button", { name: "Add to Admin List" }),
    );
    const confirm = screen.getByRole("dialog", {
      name: "Add property to Admin List?",
    });
    await user.click(
      within(confirm).getByRole("button", { name: "Add to Admin List" }),
    );
    expect(
      await within(confirm).findByText(
        "This property is already in the Admin list as PR-000020",
      ),
    ).toBeInTheDocument();
    expect(
      within(confirm).getByRole("button", { name: "Add to Admin List" }),
    ).toBeEnabled();
  });

  it("explains why a closed listing cannot be added", async () => {
    const user = userEvent.setup();
    detail = { ...detail, availability: "sold", can_promote: false };
    const dialog = await openAgentListing(user);
    expect(
      await within(dialog).findByText(
        "Only available or reserved listings can be added to the Admin list.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Add to Admin List" }),
    ).toBeNull();
  });

  it("is never offered in Admin properties", async () => {
    const user = userEvent.setup();
    workspace("/inventory?tab=company");
    await user.click(
      await screen.findByRole("button", {
        name: "Open DHA corner house details",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "DHA corner house",
    });
    await within(dialog).findByRole("button", { name: "Edit property" });
    expect(
      within(dialog).queryByRole("button", { name: "Add to Admin List" }),
    ).toBeNull();
  });
});

describe("promoted listings for agents", () => {
  it("shows the original listing agent, read-only", async () => {
    const user = userEvent.setup();
    mocks.auth.user = { id: "agent-9", name: "Sara Agent", role: "agent" };
    workspace("/inventory?tab=company");
    expect(
      await screen.findByText("Originally listed by Ali Agent · UID 123456"),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Open DHA corner house details" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "DHA corner house",
    });
    const origin = await within(dialog).findByRole("region", {
      name: "Original listing",
    });
    expect(origin).toHaveTextContent("Originally listed byAli Agent");
    expect(origin).toHaveTextContent("Agent UID123456");
    expect(origin).not.toHaveTextContent("Original property");
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/properties/" + copy.id,
        expect.anything(),
      ),
    );
    for (const name of [
      "Edit property",
      "Delete property",
      "Archive property",
      "Add to Admin List",
    ])
      expect(within(dialog).queryByRole("button", { name })).toBeNull();
  });
});

describe("inventory figures", () => {
  it("counts each listing once and shows how many came from agents", async () => {
    workspace("/inventory");
    const stats = await screen.findByRole("region", {
      name: "Inventory summary",
    });
    await waitFor(() =>
      expect(
        within(stats).getByText("Unique properties").closest(".kpi"),
      ).toHaveTextContent("21"),
    );
    expect(
      within(stats).getByText("Each listing counted once"),
    ).toBeInTheDocument();
    expect(
      within(stats).getByText("Admin properties").closest(".kpi"),
    ).toHaveTextContent("5");
    expect(
      within(stats).getByText("2 added from agent inventories"),
    ).toBeInTheDocument();
    expect(
      within(stats).getByText("Available").closest(".kpi"),
    ).toHaveTextContent("18");
    expect(within(stats).queryByText("All properties")).toBeNull();
  });
});

describe("notification links", () => {
  it("opens the linked property directly", async () => {
    workspace(`/inventory?tab=agents&agent=${agentId}&property=${listing.id}`);
    const dialog = await screen.findByRole("dialog", {
      name: "DHA corner house",
    });
    expect(
      await within(dialog).findByRole("button", { name: "Add to Admin List" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(location.search).toBe(`?tab=agents&agent=${agentId}`),
    );
  });
});
