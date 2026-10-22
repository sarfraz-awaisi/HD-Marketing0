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
import { MemoryRouter } from "react-router-dom";
import Inventory from "../src/pages/shared/Inventory";
import Layout from "../src/components/layout/Layout";
import { ToastProvider } from "../src/components/common/UI";

const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: null, logout: vi.fn() },
}));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const property = {
  id: "50000000-0000-4000-8000-000000000001",
  title: "Test residence",
  location: "Islamabad",
  city: "Islamabad",
  purpose: "sale",
  price: 25000000,
  type: "House",
  area: 10,
  area_unit: "marla",
  availability: "available",
  description: "Test description",
};
let records, ownProperty;
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
beforeEach(() => {
  vi.clearAllMocks();
  records = [property];
  ownProperty = false;
  mocks.auth.user = {
    id: "50000000-0000-4000-8000-000000000002",
    name: "Property admin",
    role: "admin",
  };
  mocks.api.mockImplementation(async (path, options) => {
    if (options?.method === "DELETE") {
      records = [];
      return null;
    }
    if (path.endsWith("/photos")) return [];
    if (path === "/reminders")
      return [{ id: "reminder-1", due_at: "2026-10-09T10:00:00Z" }];
    if (path === "/inventory/summary")
      return {
        role: mocks.auth.user.role,
        mine: { total: 0 },
        company: { total: records.length },
        agents: { total: 0 },
        all: { total: records.length, sold: 0, rented: 0 },
      };
    // The full record (GET /properties/:id) says whether the viewer may edit.
    const detail = /^\/properties\/([0-9a-f-]{36})$/.exec(path);
    if (detail) {
      const row = records.find((r) => r.id === detail[1]);
      const admin = mocks.auth.user.role === "admin";
      return {
        ...row,
        ownership: ownProperty ? "agent" : "company",
        created_at: "2026-10-01T10:00:00Z",
        can_edit: ownProperty ? !admin : admin,
      };
    }
    return { data: records, count: records.length };
  });
});
function workspace(element = <Inventory />, entry = "/inventory") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter initialEntries={[entry]}>{element}</MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}
async function openProperty(user) {
  await user.click(
    await screen.findByRole("button", { name: /View property/ }),
  );
}
// Management controls appear once the full record has loaded.
const control = (name) => screen.findByRole("button", { name });
const deletes = () =>
  mocks.api.mock.calls.filter(([, options]) => options?.method === "DELETE");

describe("property administration", () => {
  it("shows Delete beside Edit and cancels without deleting", async () => {
    const user = userEvent.setup();
    workspace();
    await openProperty(user);
    expect(await control("Edit property")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete property" }));
    expect(
      screen.getByRole("dialog", { name: "Delete property?" }),
    ).toBeInTheDocument();
    expect(deletes()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("button", { name: "Edit property" }),
    ).toBeInTheDocument();
    expect(deletes()).toHaveLength(0);
  });
  it("deletes only after confirmation and refreshes the property list", async () => {
    const user = userEvent.setup();
    const { queryClient } = workspace();
    queryClient.setQueryData(["property-options"], { data: [property] });
    await openProperty(user);
    await user.click(await control("Delete property"));
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    await screen.findByText("Property deleted");
    expect(deletes()).toEqual([
      ["/properties/" + property.id, { method: "DELETE" }],
    ]);
    expect(await screen.findByText("No properties found.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(queryClient.getQueryState(["property-options"]).isInvalidated).toBe(
      true,
    );
  });
  it("shows linked-record errors and retains the property", async () => {
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      options?.method === "DELETE"
        ? Promise.reject(
            new Error("This property has linked deals. Archive it."),
          )
        : original(path, options),
    );
    const user = userEvent.setup();
    workspace();
    await openProperty(user);
    await user.click(await control("Delete property"));
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/Archive/);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByText("Property deleted")).not.toBeInTheDocument();
  });
  it("prevents repeated deletion or dismissing the dialog during a pending delete", async () => {
    const original = mocks.api.getMockImplementation();
    let finish;
    mocks.api.mockImplementation((path, options) =>
      options?.method === "DELETE"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(path, options),
    );
    const user = userEvent.setup();
    workspace();
    await openProperty(user);
    await user.click(await control("Delete property"));
    await user.click(
      screen.getByRole("button", { name: "Delete permanently" }),
    );
    expect(screen.getByRole("button", { name: "Deleting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { cancelable: true }),
    );
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(deletes()).toHaveLength(1);
    finish(null);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("lets agents view company properties without edit/delete/archive controls", async () => {
    mocks.auth.user.role = "agent";
    const user = userEvent.setup();
    workspace(<Inventory />, "/inventory?tab=company");
    await openProperty(user);
    // Wait for the full record before checking that nothing can be changed.
    expect(
      await within(screen.getByRole("dialog")).findByText("Company inventory"),
    ).toBeInTheDocument();
    for (const name of [
      "Edit property",
      "Delete property",
      "Archive property",
      "+ Add property",
    ])
      expect(screen.queryByRole("button", { name })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Change status")).not.toBeInTheDocument();
    expect(deletes()).toHaveLength(0);
    expect(
      mocks.api.mock.calls.some(([path]) =>
        path.startsWith("/properties?scope=company&"),
      ),
    ).toBe(true);
  });
  it("lets agents add and manage the properties in their own inventory", async () => {
    mocks.auth.user.role = "agent";
    ownProperty = true;
    const user = userEvent.setup();
    workspace();
    expect(
      screen.getByRole("tab", { name: "My properties", selected: true }),
    ).toBeInTheDocument();
    expect(await control("+ Add property")).toBeInTheDocument();
    await openProperty(user);
    for (const name of ["Edit property", "Delete property", "Archive property"])
      expect(await control(name)).toBeInTheDocument();
    expect(
      mocks.api.mock.calls.some(([path]) =>
        path.startsWith("/properties?scope=mine&"),
      ),
    ).toBe(true);
  });
  it("keeps the Edit action available and opens its existing form", async () => {
    const user = userEvent.setup();
    workspace();
    await openProperty(user);
    await user.click(await control("Edit property"));
    expect(screen.getByLabelText("Property title")).toHaveValue(property.title);
    expect(
      screen.getByRole("button", { name: "Save record" }),
    ).toBeInTheDocument();
  });
});

describe("property card pictures and details", () => {
  it.each(["admin", "agent"])(
    "shows each property's own cover and full details for an %s",
    async (role) => {
      mocks.auth.user.role = role;
      const other = {
        ...property,
        id: "50000000-0000-4000-8000-000000000003",
        title: "Second residence",
      };
      records = [property, other];
      const original = mocks.api.getMockImplementation();
      mocks.api.mockImplementation((path, options) =>
        path.endsWith("/photos")
          ? Promise.resolve(
              path.includes(property.id)
                ? [
                    { id: "front", url: "/front.png" },
                    { id: "room", url: "/room.png" },
                  ]
                : [{ id: "second-front", url: "/second-front.png" }],
            )
          : original(path, options),
      );
      const user = userEvent.setup();
      workspace();
      const cover = await screen.findByRole("img", {
        name: `${property.title} — property photograph`,
      });
      expect(cover).toHaveAttribute("src", "/front.png");
      expect(
        await screen.findByRole("img", {
          name: `${other.title} — property photograph`,
        }),
      ).toHaveAttribute("src", "/second-front.png");
      expect(screen.getByText("2 photos")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      const photoReads = () =>
        mocks.api.mock.calls.filter(([path]) => path.endsWith("/photos"));
      expect(photoReads()).toHaveLength(2);
      await user.click(
        screen.getByRole("button", {
          name: `Open ${property.title} details`,
        }),
      );
      const dialog = screen.getByRole("dialog", { name: property.title });
      const details = within(dialog).getByRole("region", {
        name: "Property details",
      });
      for (const text of [
        property.location,
        property.type,
        "10 Marla",
        "Available",
        property.description,
      ])
        expect(within(details).getByText(text)).toBeInTheDocument();
      expect(within(details).getByText(/25,000,000/)).toBeInTheDocument();
      expect(
        within(dialog).getAllByRole("img", { name: "Property photograph" }),
      ).toHaveLength(2);
      expect(photoReads()).toHaveLength(2);
      if (role === "agent") {
        expect(dialog.querySelector('input[type="file"]')).toBeNull();
        expect(
          within(dialog).queryByRole("button", { name: "Edit property" }),
        ).not.toBeInTheDocument();
      }
    },
  );
  it("updates the card's cover after a gallery photo is deleted", async () => {
    let photos = [
      { id: "front", url: "/front.png" },
      { id: "room", url: "/room.png" },
    ];
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) => {
      if (options?.method === "DELETE" && path.endsWith("/photos/front")) {
        photos = photos.slice(1);
        return Promise.resolve(null);
      }
      if (path.endsWith("/photos")) return Promise.resolve(photos);
      return original(path, options);
    });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    try {
      const user = userEvent.setup();
      workspace();
      await screen.findByRole("img", {
        name: `${property.title} — property photograph`,
      });
      await openProperty(user);
      await user.click(
        within(screen.getByRole("dialog")).getAllByRole("button", {
          name: "Delete photo",
        })[0],
      );
      await waitFor(() =>
        expect(
          screen.getByRole("img", {
            name: `${property.title} — property photograph`,
          }),
        ).toHaveAttribute("src", "/room.png"),
      );
      expect(screen.queryByText("2 photos")).not.toBeInTheDocument();
      expect(
        within(screen.getByRole("dialog")).getAllByRole("img", {
          name: "Property photograph",
        }),
      ).toHaveLength(1);
    } finally {
      confirm.mockRestore();
    }
  });
  it("keeps details usable without a picture and recovers after a failed image URL refreshes", async () => {
    const user = userEvent.setup();
    const { queryClient } = workspace();
    await screen.findByText("No pictures added");
    await openProperty(user);
    expect(
      within(screen.getByRole("dialog")).getByText(property.description),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    const original = mocks.api.getMockImplementation();
    let url = "/expired.png";
    mocks.api.mockImplementation((path, options) =>
      path.endsWith("/photos")
        ? Promise.resolve([{ id: "front", url }])
        : original(path, options),
    );
    await queryClient.invalidateQueries({ queryKey: ["photos", property.id] });
    fireEvent.error(
      await screen.findByRole("img", {
        name: `${property.title} — property photograph`,
      }),
    );
    expect(screen.getByText("Picture unavailable")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: `Open ${property.title} details` }),
    ).toBeEnabled();
    url = "/renewed.png";
    await queryClient.invalidateQueries({ queryKey: ["photos", property.id] });
    expect(
      await screen.findByRole("img", {
        name: `${property.title} — property photograph`,
      }),
    ).toHaveAttribute("src", "/renewed.png");
    expect(screen.queryByText("Picture unavailable")).not.toBeInTheDocument();
  });
});

describe("navigation and notification controls", () => {
  it("closes navigation using the close button, backdrop or Escape", async () => {
    const user = userEvent.setup();
    workspace(<Layout />);
    const toggle = screen.getByRole("button", { name: "Toggle navigation" });
    for (const close of [
      "Close navigation",
      "Close navigation backdrop",
      "Escape",
    ]) {
      await user.click(toggle);
      expect(toggle).toHaveAttribute("aria-expanded", "true");
      if (close === "Escape") await user.keyboard("{Escape}");
      else await user.click(screen.getByRole("button", { name: close }));
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
  });
  it("closes the notification and profile menus on a click outside them", async () => {
    const user = userEvent.setup();
    const { container } = workspace(<Layout />);
    const bell = screen.getByRole("button", { name: /^View notifications/ });
    await user.click(bell);
    expect(bell).toHaveAttribute("aria-expanded", "true");
    // Clicks inside the open menu keep it open.
    await user.click(screen.getByRole("heading", { name: "Notifications" }));
    expect(bell).toHaveAttribute("aria-expanded", "true");
    await user.click(container.querySelector("main"));
    expect(bell).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("#workspace-reminders")).toBeNull();
    // Its own button still toggles it closed.
    await user.click(bell);
    await user.click(bell);
    expect(bell).toHaveAttribute("aria-expanded", "false");
    const profile = screen.getByRole("button", { name: /^My profile:/ });
    await user.click(profile);
    const panel = screen.getByRole("region", { name: "My profile" });
    await user.click(within(panel).getByText("Employee UID"));
    expect(profile).toHaveAttribute("aria-expanded", "true");
    await user.click(document.body);
    expect(profile).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: "My profile" }),
    ).not.toBeInTheDocument();
  });
  it("keeps follow-up reminders working before database update 038", async () => {
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      path === "/notifications"
        ? Promise.reject(
            Object.assign(new Error("needs update 038"), { status: 503 }),
          )
        : options?.method === "PATCH"
          ? Promise.reject(new Error("Could not dismiss reminder"))
          : original(path, options),
    );
    const user = userEvent.setup();
    workspace(<Layout />);
    await user.click(
      await screen.findByRole("button", {
        name: "View notifications, 1 unread",
      }),
    );
    expect(
      screen.getByRole("heading", { name: "Follow-up reminders" }),
    ).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Dismiss" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not dismiss reminder",
    );
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeEnabled();
  });
  it("lists notifications, opens their link and marks them read", async () => {
    let unread = true;
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) => {
      if (path === "/notifications")
        return Promise.resolve({
          unread: unread ? 1 : 0,
          data: [
            {
              id: "n1000000-0000-4000-8000-000000000001",
              type: "lead_assigned",
              title: "New lead assigned: HD-000042",
              body: "Ayesha Khan · First call due by Mon 20 Oct, 06:00 PM",
              link: "/leads/lead-42",
              updated_at: "2026-10-17T07:00:00Z",
              read_at: unread ? null : "2026-10-17T08:00:00Z",
            },
          ],
        });
      if (path === "/notifications/read") {
        if (options.body.ids && mocks.failRead) {
          mocks.failRead = false;
          return Promise.reject(new Error("Could not mark it read"));
        }
        unread = false;
        return Promise.resolve({ read: 1 });
      }
      return original(path, options);
    });
    mocks.failRead = true;
    const user = userEvent.setup();
    workspace(<Layout />);
    await user.click(
      await screen.findByRole("button", {
        name: "View notifications, 1 unread",
      }),
    );
    expect(
      screen.getByRole("link", { name: "New lead assigned: HD-000042" }),
    ).toHaveAttribute("href", "/leads/lead-42");
    expect(screen.getByText(/First call due by/)).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", {
        name: "Mark read: New lead assigned: HD-000042",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not mark it read",
    );
    await user.click(screen.getByRole("button", { name: "Mark all read" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Mark all read" }),
      ).toBeNull(),
    );
    expect(
      mocks.api.mock.calls
        .filter(([path]) => path === "/notifications/read")
        .map(([, options]) => options.body),
    ).toEqual([{ ids: ["n1000000-0000-4000-8000-000000000001"] }, {}]);
    expect(
      screen.getByRole("button", { name: "View notifications" }),
    ).toBeInTheDocument();
  });
});
