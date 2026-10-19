import React from "react";
import {
  afterAll,
  afterEach,
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
import Properties from "../src/pages/admin/Properties";
import { ToastProvider } from "../src/components/common/UI";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: { id: "admin", role: "admin" } },
}));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
const property = {
  id: "50000000-0000-4000-8000-000000000001",
  title: "Picture residence",
  location: "Lahore",
  price: 100,
  type: "House",
  area: 5,
  area_unit: "marla",
  availability: "available",
  description: "",
};
let records, uploaded, failProperty, failPhoto, pending;
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
  records = [];
  uploaded = [];
  failProperty = false;
  failPhoto = "";
  pending = null;
  mocks.auth.user = { id: "admin", role: "admin" };
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:test-picture");
      static revokeObjectURL = vi.fn();
    },
  );
  mocks.api.mockImplementation(async (path, options) => {
    if (path.endsWith("/photos")) {
      if (options?.method === "POST") {
        const file = options.body.get("file");
        if (file.name === failPhoto)
          throw new Error("Photo service unavailable");
        if (pending) await pending;
        const photo = {
          id: "picture-" + uploaded.length,
          url: "/test-picture.png",
          name: file.name,
        };
        uploaded.push(photo);
        return { id: photo.id };
      }
      return uploaded;
    }
    if (["POST", "PATCH"].includes(options?.method)) {
      if (failProperty) throw new Error("Could not save property");
      const saved = { ...property, ...options.body };
      records = [saved];
      return saved;
    }
    return { data: records, count: records.length };
  });
});
afterEach(() => vi.unstubAllGlobals());
function workspace() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <MemoryRouter>
          <Properties />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const picture = (name = "front.png", type = "image/png", size = 10) =>
  new File([new Uint8Array(size)], name, { type, lastModified: 123 });
const saveCalls = () =>
  mocks.api.mock.calls.filter(
    ([path, options]) => options?.method === "POST" && path === "/properties",
  );
const photoCalls = () =>
  mocks.api.mock.calls.filter(
    ([path, options]) => options?.method === "POST" && path.endsWith("/photos"),
  );
async function openNew(user) {
  await user.click(
    await screen.findByRole("button", { name: "+ Add property" }),
  );
  await user.type(screen.getByLabelText("Property title"), property.title);
  await user.type(screen.getByLabelText("Location"), property.location);
  await user.type(screen.getByLabelText("Price (PKR)"), "100");
  await user.type(screen.getByLabelText("Area"), "5");
  await user.selectOptions(screen.getByLabelText("Property type"), "House");
}
const select = (files) =>
  fireEvent.change(screen.getByLabelText("Property pictures"), {
    target: { files },
  });

describe("pictures in the property form", () => {
  it("previews several pictures before saving and uploads only pictures not removed", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    const input = screen.getByLabelText("Property pictures");
    expect(input).toHaveAttribute("multiple");
    expect(input).toHaveAttribute("hidden");
    const front = picture(),
      room = picture("room.jpg", "image/jpeg");
    select([front, room]);
    expect(
      await screen.findAllByRole("img", { name: /Selected property picture/ }),
    ).toHaveLength(2);
    expect(saveCalls()).toHaveLength(0);
    expect(photoCalls()).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Remove front.png" }));
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property and pictures saved");
    expect(saveCalls()).toHaveLength(1);
    expect(saveCalls()[0][1].body).toMatchObject({
      title: property.title,
      price: 100,
      area: 5,
    });
    expect(saveCalls()[0][1].body).not.toHaveProperty("pictures");
    expect(photoCalls()).toHaveLength(1);
    expect(photoCalls()[0][0]).toBe(`/properties/${property.id}/photos`);
    expect(photoCalls()[0][1].body.get("file")).toBe(room);
    expect(
      screen.getByRole("dialog", { name: property.title }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("img", { name: "Property photograph" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("img", {
        name: `${property.title} — property photograph`,
      }),
    ).toHaveAttribute("src", "/test-picture.png");
  });
  it("keeps pictures optional and preserves the normal save flow", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property saved");
    expect(saveCalls()).toHaveLength(1);
    expect(photoCalls()).toHaveLength(0);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("skips unsupported, empty or oversized files, retains valid selections and avoids duplicate picks", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    const valid = picture();
    select([
      valid,
      picture("animation.gif", "image/gif"),
      picture("large.png", "image/png", 5 * 1024 * 1024 + 1),
      picture("empty.png", "image/png", 0),
    ]);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Some files were skipped/,
    );
    expect(screen.getByText("1 picture ready to upload")).toBeInTheDocument();
    select([valid]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("1 picture ready to upload")).toBeInTheDocument();
    expect(screen.getByLabelText("Property pictures")).toHaveValue("");
    expect(saveCalls()).toHaveLength(0);
  });
  it("cancels selections without creating records or uploading and releases previews", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    select([picture(), picture("room.webp", "image/webp")]);
    await screen.findAllByRole("img", { name: /Selected property picture/ });
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(saveCalls()).toHaveLength(0);
    expect(photoCalls()).toHaveLength(0);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });
  it("retains pictures and inputs when property creation fails, then retries", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    select([picture()]);
    failProperty = true;
    await user.click(screen.getByRole("button", { name: "Save record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not save property",
    );
    expect(photoCalls()).toHaveLength(0);
    expect(screen.getByLabelText("Property title")).toHaveValue(property.title);
    expect(screen.getByText("1 picture ready to upload")).toBeInTheDocument();
    failProperty = false;
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property and pictures saved");
    expect(photoCalls()).toHaveLength(1);
  });
  it("retries only remaining pictures on the same property after partial upload failure", async () => {
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    select([
      picture("front.png"),
      picture("room.jpg", "image/jpeg"),
      picture("garden.webp", "image/webp"),
    ]);
    failPhoto = "room.jpg";
    await user.click(screen.getByRole("button", { name: "Save record" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      /Property saved.*retry the remaining pictures/,
    );
    expect(
      screen.getByRole("dialog", { name: "Edit property" }),
    ).toBeInTheDocument();
    expect(screen.getByText("2 pictures ready to upload")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove front.png" }),
    ).not.toBeInTheDocument();
    expect(uploaded.map((p) => p.name)).toEqual(["front.png"]);
    failPhoto = "";
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property and pictures saved");
    expect(saveCalls()).toHaveLength(1);
    expect(mocks.api).toHaveBeenCalledWith(
      `/properties/${property.id}`,
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(uploaded.map((p) => p.name)).toEqual([
      "front.png",
      "room.jpg",
      "garden.webp",
    ]);
    expect(
      photoCalls().filter(
        ([, options]) => options.body.get("file").name === "front.png",
      ),
    ).toHaveLength(1);
    expect(
      await screen.findAllByRole("img", { name: "Property photograph" }),
    ).toHaveLength(3);
  });
  it("prevents editing, repeated saving, removing pictures or closing while uploading", async () => {
    let finish;
    pending = new Promise((resolve) => {
      finish = resolve;
    });
    const user = userEvent.setup();
    workspace();
    await openNew(user);
    select([picture()]);
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await waitFor(() => expect(photoCalls()).toHaveLength(1));
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add pictures" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Remove front.png" }),
    ).toBeDisabled();
    expect(screen.getByLabelText("Property title")).toBeDisabled();
    const dialog = screen.getByRole("dialog");
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(saveCalls()).toHaveLength(1);
    finish();
    await screen.findByText("Property and pictures saved");
  });
  it("also adds pictures while editing an existing property", async () => {
    records = [property];
    const user = userEvent.setup();
    workspace();
    await user.click(
      await screen.findByRole("button", { name: /View property/ }),
    );
    await user.click(screen.getByRole("button", { name: "Edit property" }));
    select([picture("updated.webp", "image/webp")]);
    await user.click(screen.getByRole("button", { name: "Save record" }));
    await screen.findByText("Property and pictures saved");
    expect(saveCalls()).toHaveLength(0);
    expect(photoCalls()).toHaveLength(1);
    expect(mocks.api).toHaveBeenCalledWith(
      `/properties/${property.id}`,
      expect.objectContaining({ method: "PATCH" }),
    );
  });
  it("keeps photo creation and upload controls out of the agent portal", async () => {
    records = [property];
    mocks.auth.user.role = "agent";
    const user = userEvent.setup();
    workspace();
    await user.click(
      await screen.findByRole("button", { name: /View property/ }),
    );
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).queryByText("Add pictures")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "+ Add property" }),
    ).not.toBeInTheDocument();
    expect(dialog.querySelector('input[type="file"]')).toBeNull();
  });
});
