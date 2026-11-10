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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Dealers from "../src/pages/shared/Dealers";
import { ToastProvider } from "../src/components/common/UI";
import { navigationFor } from "../src/components/layout/navigation";
import {
  cleanDealer,
  dealerErrors,
  dialable,
  normalizeDealerPhone,
} from "../src/lib/dealers";
// The dealer affiliate network page (update 049). API responses are mocked;
// server/tests/dealers.test.js checks the same rules against the database.
const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = { id: "49000000-0000-4000-8000-000000000001", role: "admin" },
  agent = { id: "49000000-0000-4000-8000-000000000002", role: "agent" };
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
const pending = {
  id: "d1",
  number: 12,
  reference: "DL-000012",
  name: "Khan Estate",
  phone: "+923001234567",
  address: "Shop 4, DHA Phase 6",
  company_name: "Khan Associates",
  city: "Lahore",
  area: "DHA",
  notes: null,
  status: "pending",
  rejection_reason: null,
  created_at: "2026-11-05T05:00:00.000000+00:00",
  updated_at: "2026-11-05T05:00:00.123456+00:00",
  reviewed_at: null,
};
const rejected = {
  ...pending,
  id: "d2",
  reference: "DL-000013",
  name: "Old Office",
  status: "rejected",
  rejection_reason: "Could not verify the office",
  reviewed_at: "2026-11-05T06:00:00Z",
};
const forAdmin = (d) => ({
  ...d,
  submitted_by: { id: agent.id, name: "Ali Agent", uid: 123456, role: "agent" },
  reviewed_by: d.reviewed_at ? { id: admin.id, name: "Owner" } : null,
  updated_by: null,
  deleted_at: null,
  deleted_by: null,
  duplicates: d.id === "d1" ? 1 : 0,
});
let sent, failNext, checkMatches;
// The server sends an agent only their own dealers, with the full number.
const own = (d) => ({ ...d, owner_id: agent.id });
beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  failNext = null;
  checkMatches = [];
  mocks.api.mockImplementation(async (path, options) => {
    const isAdmin = mocks.auth.user.role === "admin";
    const shape = (d) => (isAdmin ? forAdmin(d) : own(d));
    if (options?.method) {
      sent.push([path, options.method, options.body]);
      if (failNext) {
        const message = failNext;
        failNext = null;
        throw new Error(message);
      }
      if (path === "/dealers")
        return shape({
          ...pending,
          id: "new",
          reference: "DL-000014",
          name: options.body.name,
          status: isAdmin ? "approved" : "pending",
        });
      if (path.endsWith("/approve"))
        return shape({ ...pending, status: "approved", reviewed_at: "now" });
      if (path.endsWith("/reject"))
        return shape({
          ...pending,
          status: "rejected",
          rejection_reason: options.body.reason || null,
        });
      return shape({ ...pending, ...options.body });
    }
    if (path === "/users")
      return [
        { id: admin.id, name: "Owner", role: "admin", active: true },
        { id: agent.id, name: "Ali Agent", role: "agent", active: true },
        { id: "s", name: "Sam Staff", role: "staff", active: true },
      ];
    if (path.startsWith("/dealers/check-phone"))
      return { phone: "+923001234567", matches: checkMatches };
    if (path === "/dealers/d1")
      return isAdmin
        ? {
            ...forAdmin(pending),
            history: [
              {
                id: 1,
                action: "dealer.create",
                at: pending.created_at,
                actor: { name: "Ali Agent" },
              },
            ],
            possible_duplicates: [
              {
                id: "d9",
                reference: "DL-000020",
                name: "Khan Estate",
                status: "approved",
                created_at: pending.created_at,
                submitted_by: { name: "Sara Agent", uid: 654321 },
              },
            ],
          }
        : own(pending);
    if (path === "/dealers/d2") return shape(rejected);
    if (path.startsWith("/dealers?"))
      return {
        count: 2,
        page: 1,
        limit: 20,
        summary: {
          total: 2,
          pending: 1,
          approved: 0,
          rejected: 1,
          ...(isAdmin ? { deleted: 3, duplicates: 1 } : {}),
        },
        data: [pending, rejected].map(shape),
      };
    throw new Error("Unexpected request " + path);
  });
});
function open(user, path = "/dealers") {
  mocks.auth.user = user;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/dealers" element={<Dealers />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const listCalls = () =>
  mocks.api.mock.calls.map(([p]) => p).filter((p) => p.startsWith("/dealers?"));
// Field labels also hold the field's error message once one is shown.
const field = (dialog, label) =>
  within(dialog).getByLabelText(
    new RegExp("^" + label.replace(/[*()]/g, "\\$&")),
  );
const fill = (dialog, values) => {
  for (const [label, value] of Object.entries(values))
    fireEvent.change(field(dialog, label), { target: { value } });
};

describe("dealer rules in the browser", () => {
  it("normalizes Pakistani numbers the way the database does", () => {
    for (const same of [
      "03001234567",
      "+923001234567",
      "923001234567",
      "3001234567",
      "0092 300 123 4567",
      "(0300) 123-4567",
    ])
      expect(normalizeDealerPhone(same), same).toBe("+923001234567");
    for (const bad of ["", "12345", "0300-12ab567", "abc"])
      expect(normalizeDealerPhone(bad), bad).toBeNull();
  });
  it("offers call, WhatsApp and copy only for a full number", () => {
    expect(dialable("+923001234567")).toBe(true);
    for (const hidden of ["+92******567", "[number hidden]", "", null])
      expect(dialable(hidden), String(hidden)).toBe(false);
  });
  it("trims details and explains every problem", () => {
    expect(
      cleanDealer({
        name: "  Khan   Estate ",
        phone: " 0300 1234567 ",
        address: " Shop 4 \n Lahore ",
        city: "  ",
      }),
    ).toMatchObject({
      name: "Khan Estate",
      phone: "0300 1234567",
      address: "Shop 4 \n Lahore",
      city: null,
      notes: null,
    });
    expect(dealerErrors({ name: " ", phone: "123", address: "" })).toEqual({
      name: "Dealer name is required",
      phone: "Enter a valid contact number, for example 03XX XXXXXXX",
      address: "Address is required",
    });
    expect(
      dealerErrors({
        name: "Ok Name",
        phone: "03001234567",
        address: "Plot 5",
      }),
    ).toEqual({});
  });
  it("shows the dealer network to administrators and agents, never staff", () => {
    const links = (role) =>
      navigationFor(role)
        .flatMap((g) => g.links.map(([to, label]) => [g.label, to, label]))
        .filter(([, to]) => to === "/dealers");
    expect(links("admin")).toEqual([
      ["Dealer Affiliate Network", "/dealers", "Dealers"],
    ]);
    expect(links("agent")).toEqual([
      ["Dealer Affiliate Network", "/dealers", "My dealers"],
    ]);
    expect(links("staff")).toEqual([]);
  });
});

describe("an agent's dealers", () => {
  it("lists only what the server sends, with status, full numbers and no admin tools", async () => {
    open(agent);
    expect(
      await screen.findByRole("heading", { name: "My dealers" }),
    ).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getByText("Khan Estate")).toBeInTheDocument();
    expect(within(table).getAllByText("+92 300 1234567").length).toBe(2);
    expect(within(table).getByText("Pending review")).toBeInTheDocument();
    expect(within(table).getByText("Rejected")).toBeInTheDocument();
    expect(within(table).queryByText("Added by")).toBeNull();
    expect(screen.queryByRole("tab", { name: /Deleted/ })).toBeNull();
    expect(screen.queryByLabelText("Added by")).toBeNull();
    expect(screen.queryByText("Shared numbers only")).toBeNull();
    expect(listCalls()[0]).not.toMatch(/agent=|view=|duplicates=/);
  });
  it("shows the rejection reason and no way to change the dealer", async () => {
    open(agent);
    fireEvent.click(
      await screen.findByRole("button", { name: "View Old Office" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/Reason: Could not verify the office/),
    ).toBeInTheDocument();
    for (const name of ["Approve", "Reject", "Edit details", "Delete"])
      expect(within(dialog).queryByRole("button", { name })).toBeNull();
  });
  it("lets an agent call, message or copy their own dealer's number", async () => {
    const writeText = vi.fn().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    open(agent);
    fireEvent.click(
      await screen.findByRole("button", { name: "View Khan Estate" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByRole("link", { name: "Call" }),
    ).toHaveAttribute("href", "tel:+923001234567");
    const whatsapp = within(dialog).getByRole("link", { name: "WhatsApp" });
    expect(whatsapp).toHaveAttribute("href", "https://wa.me/923001234567");
    expect(whatsapp).toHaveAttribute("target", "_blank");
    expect(whatsapp).toHaveAttribute("rel", "noreferrer");
    fireEvent.click(within(dialog).getByRole("button", { name: "Copy" }));
    expect(
      await within(dialog).findByRole("button", { name: "Copied" }),
    ).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("+923001234567");
    delete navigator.clipboard;
  });
  it("checks the form before sending and never sends it twice", async () => {
    open(agent);
    fireEvent.click(
      await screen.findByRole("button", { name: "+ Add dealer" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Add dealer" }));
    expect(
      await within(dialog).findByText("Dealer name is required"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Contact number is required"));
    expect(sent).toEqual([]);
    fill(dialog, {
      "Dealer name *": "  Khan   Estate ",
      "Contact number *": " 0300-1234567 ",
      "Address *": "  Shop 4, DHA  ",
      City: " Lahore ",
    });
    // The server refuses the first try; the retry reuses the same form key.
    failNext = "The CRM server could not be reached.";
    const submit = within(dialog).getByRole("button", { name: "Add dealer" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    expect(
      await within(dialog).findByText("The CRM server could not be reached."),
    ).toBeInTheDocument();
    expect(sent.length).toBe(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Add dealer" }));
    expect(
      await screen.findByText("Dealer DL-000014 submitted for review"),
    ).toBeInTheDocument();
    expect(sent.length).toBe(2);
    const [[path, method, body], [, , retry]] = sent;
    expect([path, method]).toEqual(["/dealers", "POST"]);
    expect(body).toEqual({
      client_key: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: "Khan Estate",
      phone: "+923001234567",
      address: "Shop 4, DHA",
      company_name: null,
      city: "Lahore",
      area: null,
      notes: null,
    });
    expect(retry.client_key).toBe(body.client_key);
    expect(Object.keys(body)).not.toContain("submitted_by");
  });
  it("warns about the agent's own dealer with the same number", async () => {
    checkMatches = [
      {
        id: "d1",
        reference: "DL-000012",
        name: "Khan Estate",
        status: "pending",
        mine: true,
      },
    ];
    open(agent);
    fireEvent.click(
      await screen.findByRole("button", { name: "+ Add dealer" }),
    );
    const dialog = await screen.findByRole("dialog");
    const phone = field(dialog, "Contact number *");
    fireEvent.change(phone, { target: { value: "+92 300 1234567" } });
    fireEvent.blur(phone);
    expect(
      await within(dialog).findByText(
        /You already added this number: DL-000012 Khan Estate \(Pending review\)/,
      ),
    ).toBeInTheDocument();
    expect(
      mocks.api.mock.calls.find(([p]) =>
        p.startsWith("/dealers/check-phone"),
      )[0],
    ).toBe("/dealers/check-phone?phone=%2B923001234567");
  });
});

describe("administrators", () => {
  it("see every dealer with who added it, counts per tab and agent filters", async () => {
    open(admin);
    expect(
      await screen.findByRole("heading", { name: "Dealers" }),
    ).toBeInTheDocument();
    const table = await screen.findByRole("table");
    expect(within(table).getAllByText("Ali Agent").length).toBe(2);
    expect(within(table).getByText("Same number ×1")).toBeInTheDocument();
    expect(
      within(screen.getByRole("tab", { name: /Pending/ })).getByText("1"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole("tab", { name: /Deleted/ })).getByText("3"),
    ).toBeInTheDocument();
    const select = await screen.findByLabelText("Added by");
    await waitFor(() =>
      expect(within(select).getAllByRole("option").length).toBe(3),
    );
    expect(within(select).queryByText("Sam Staff")).toBeNull();
    fireEvent.change(select, { target: { value: agent.id } });
    await waitFor(() =>
      expect(listCalls().at(-1)).toContain(`agent=${agent.id}`),
    );
    fireEvent.click(screen.getByRole("tab", { name: /Pending/ }));
    await waitFor(() => expect(listCalls().at(-1)).toContain("status=pending"));
  });
  it("approve once, with call, WhatsApp and copy for the number", async () => {
    open(admin);
    fireEvent.click(
      await screen.findByRole("button", { name: "View Khan Estate" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByRole("link", { name: "Call" }),
    ).toHaveAttribute("href", "tel:+923001234567");
    expect(
      within(dialog).getByRole("link", { name: "WhatsApp" }),
    ).toHaveAttribute("href", "https://wa.me/923001234567");
    expect(within(dialog).getByText(/DL-000020 · Khan Estate/));
    expect(within(dialog).getByText(/Sara Agent/));
    const approve = within(dialog).getByRole("button", { name: "Approve" });
    fireEvent.click(approve);
    fireEvent.click(approve);
    expect(await screen.findByText("Dealer approved")).toBeInTheDocument();
    // The decision names the version reviewed (update 059).
    expect(sent).toEqual([
      [
        "/dealers/d1/approve",
        "POST",
        { expected_updated_at: pending.updated_at },
      ],
    ]);
  });
  it("reject with an optional reason, and delete only after confirming", async () => {
    open(admin);
    fireEvent.click(
      await screen.findByRole("button", { name: "View Khan Estate" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Reject" }),
    );
    fireEvent.change(within(dialog).getByLabelText(/Reason for rejecting/), {
      target: { value: "  Wrong address  " },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Reject dealer" }),
    );
    expect(await screen.findByText("Dealer rejected")).toBeInTheDocument();
    expect(sent).toEqual([
      [
        "/dealers/d1/reject",
        "POST",
        { reason: "Wrong address", expected_updated_at: pending.updated_at },
      ],
    ]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(within(dialog).getByText(/can be restored from Deleted/));
    expect(sent.length).toBe(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(sent.length).toBe(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete dealer" }),
    );
    expect(await screen.findByText("Dealer deleted")).toBeInTheDocument();
    expect(sent[1]).toEqual(["/dealers/d1/delete", "POST", {}]);
  });
  it("edit sends only the changed details with the version they started from", async () => {
    open(admin);
    fireEvent.click(
      await screen.findByRole("button", { name: "View Khan Estate" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(
      await within(dialog).findByRole("button", { name: "Edit details" }),
    );
    fill(dialog, { "Dealer name *": "Khan Estate & Co", City: "" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(await screen.findByText("Dealer updated")).toBeInTheDocument();
    expect(sent).toEqual([
      [
        "/dealers/d1",
        "PATCH",
        {
          name: "Khan Estate & Co",
          city: null,
          expected_updated_at: pending.updated_at,
        },
      ],
    ]);
  });
});
