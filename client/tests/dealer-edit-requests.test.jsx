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
import Dealers from "../src/pages/shared/Dealers";
import { ToastProvider } from "../src/components/common/UI";
// Update 059: agents edit their own dealers; changes to an approved dealer
// wait for an administrator. API responses are mocked;
// server/tests/dealer-edit-requests.test.js checks the rules in the database.
const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = { id: "59200000-0000-4000-8000-000000000001", role: "admin" },
  agent = { id: "59200000-0000-4000-8000-000000000002", role: "agent" };
const original = Object.getOwnPropertyDescriptor(
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
  if (original)
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", original);
  else delete HTMLDialogElement.prototype.showModal;
});
const base = {
  owner_id: agent.id,
  phone: "+923001234567",
  address: "Shop 4, DHA Phase 6",
  company_name: "Khan Associates",
  city: "Lahore",
  area: "DHA",
  notes: null,
  rejection_reason: null,
  created_at: "2026-11-05T05:00:00.000000+00:00",
  reviewed_at: null,
  pending_change: null,
  last_change: null,
};
const pending = {
  ...base,
  id: "d1",
  reference: "DL-000012",
  name: "Waiting Estate",
  status: "pending",
  updated_at: "2026-11-05T05:00:00.111111+00:00",
};
const change = {
  id: "c1",
  status: "pending",
  changes: {
    name: { before: "Approved Estate", after: "Approved Estate & Sons" },
    phone: { before: "+923001234567", after: "+923017777777" },
  },
  base_changed: false,
  submitted_at: "2026-11-06T05:00:00Z",
  updated_at: "2026-11-06T05:00:00.222222+00:00",
  revisions: 0,
  rejection_reason: null,
  reviewed_at: null,
};
const approved = {
  ...base,
  id: "d3",
  reference: "DL-000014",
  name: "Approved Estate",
  status: "approved",
  reviewed_at: "2026-11-05T06:00:00Z",
  updated_at: "2026-11-05T06:00:00.333333+00:00",
  pending_change: change,
};
const plain = {
  ...base,
  id: "d4",
  reference: "DL-000015",
  name: "Plain Estate",
  status: "approved",
  reviewed_at: "2026-11-05T06:00:00Z",
  updated_at: "2026-11-05T06:00:00.444444+00:00",
  last_change: {
    ...change,
    id: "c0",
    status: "rejected",
    changes: { city: { before: "Lahore", after: "Karachi" } },
    rejection_reason: "The dealer is still in Lahore",
    reviewed_at: "2026-11-06T07:00:00Z",
  },
};
const rejected = {
  ...base,
  id: "d2",
  reference: "DL-000013",
  name: "Old Office",
  status: "rejected",
  rejection_reason: "Could not verify the office",
  reviewed_at: "2026-11-05T06:00:00Z",
  updated_at: "2026-11-05T06:00:00.555555+00:00",
};
const rows = [pending, rejected, approved, plain];
const forAdmin = (d) => ({
  ...d,
  submitted_by: { id: agent.id, name: "Ali Agent", uid: 123456, role: "agent" },
  pending_change: d.pending_change && {
    ...d.pending_change,
    submitted_by: { id: agent.id, name: "Ali Agent", uid: 123456 },
  },
  history: [],
  possible_duplicates: [],
});
let sent;
beforeEach(() => {
  vi.clearAllMocks();
  sent = [];
  mocks.api.mockImplementation(async (path, options) => {
    const isAdmin = mocks.auth.user.role === "admin";
    if (options?.method) {
      sent.push([path, options.method, options.body]);
      const d = rows.find((r) => path.startsWith(`/dealers/${r.id}/`));
      if (path.endsWith("/changes"))
        return d.status === "approved"
          ? { ...d, pending_change: { ...change, revisions: 1 } }
          : { ...d, status: "pending" };
      return forAdmin({ ...d, pending_change: null });
    }
    if (path.startsWith("/dealers?"))
      return {
        count: rows.length,
        page: 1,
        limit: 20,
        summary: { total: 4, pending: 1, approved: 2, rejected: 1, changes: 1 },
        data: isAdmin ? rows.map(forAdmin) : rows,
      };
    const d = rows.find((r) => path === `/dealers/${r.id}`);
    if (d) return isAdmin ? forAdmin(d) : d;
    if (path === "/users") return [];
    return { matches: [] };
  });
});
function open(user) {
  mocks.auth.user = user;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <Dealers />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const fields = (d, extra = {}) => ({
  name: d.name,
  phone: d.phone,
  address: d.address,
  company_name: d.company_name,
  city: d.city,
  area: d.area,
  notes: d.notes,
  ...extra,
});

describe("an agent's My dealers", () => {
  it("puts Edit beside View, marks waiting changes and lists them in Edit requests", async () => {
    open(agent);
    for (const d of rows) {
      expect(
        await screen.findByRole("button", { name: `View ${d.name}` }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `Edit ${d.name}` }),
      ).toBeInTheDocument();
    }
    const row = screen
      .getByRole("button", { name: "View Approved Estate" })
      .closest("tr");
    expect(within(row).getByText("Changes pending")).toBeInTheDocument();
    const tab = screen.getByRole("tab", { name: /Edit requests/ });
    expect(tab).toHaveTextContent("1");
    await userEvent.click(tab);
    await waitFor(() =>
      expect(
        mocks.api.mock.calls.some(
          ([p]) => p.startsWith("/dealers?") && p.includes("changes=true"),
        ),
      ).toBe(true),
    );
  });

  it("edits a dealer waiting for review in place", async () => {
    const user = userEvent.setup();
    open(agent);
    await user.click(
      await screen.findByRole("button", { name: "Edit Waiting Estate" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Edit dealer" });
    expect(dialog).toHaveTextContent(
      "Your changes update the dealer waiting for review.",
    );
    const name = within(dialog).getByRole("textbox", { name: /Dealer name/ });
    await user.clear(name);
    await user.type(name, "Waiting Estate & Co");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([
      "/dealers/d1/changes",
      "POST",
      {
        ...fields(pending, { name: "Waiting Estate & Co" }),
        expected_updated_at: pending.updated_at,
      },
    ]);
    expect(
      await screen.findByText("Changes saved; still waiting for review"),
    ).toBeInTheDocument();
  });

  it("revises the changes waiting for approval, starting from them", async () => {
    const user = userEvent.setup();
    open(agent);
    await user.click(
      await screen.findByRole("button", { name: "Edit Approved Estate" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Edit dealer" });
    expect(dialog).toHaveTextContent(
      "You're changing the changes waiting for approval.",
    );
    // The form shows the proposed values, not the approved ones.
    expect(
      within(dialog).getByRole("textbox", { name: /Dealer name/ }),
    ).toHaveValue("Approved Estate & Sons");
    expect(
      within(dialog).getByRole("textbox", { name: /Contact number/ }),
    ).toHaveValue("+923017777777");
    const city = within(dialog).getByRole("textbox", { name: /City/ });
    await user.clear(city);
    await user.type(city, "Islamabad");
    await user.click(
      within(dialog).getByRole("button", { name: "Send for approval" }),
    );
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual([
      "/dealers/d3/changes",
      "POST",
      {
        ...fields(approved, {
          name: "Approved Estate & Sons",
          phone: "+923017777777",
          city: "Islamabad",
        }),
        expected_updated_at: change.updated_at,
      },
    ]);
    expect(
      await screen.findByText("Changes sent for approval"),
    ).toBeInTheDocument();
  });

  it("shows the waiting changes, a rejection and its reason, and submits a rejected dealer again", async () => {
    const user = userEvent.setup();
    open(agent);
    await user.click(
      await screen.findByRole("button", { name: "View Approved Estate" }),
    );
    let dialog = await screen.findByRole("dialog");
    const waiting = await within(dialog).findByRole("region", {
      name: "Changes pending approval",
    });
    expect(waiting).toHaveTextContent(
      "The approved details below stay as they are until an administrator approves.",
    );
    const cells = within(waiting)
      .getAllByRole("row")
      .map((r) => r.textContent);
    expect(cells).toEqual([
      "DetailApproved nowProposed",
      "Dealer nameApproved Estate→ Approved Estate & Sons",
      "Contact number+92 300 1234567→ +92 301 7777777",
    ]);
    expect(
      within(dialog).getByRole("button", { name: "Edit proposed changes" }),
    ).toBeInTheDocument();
    await user.click(
      within(dialog).getByRole("button", { name: "Close dialog" }),
    );
    await user.click(screen.getByRole("button", { name: "View Plain Estate" }));
    dialog = await screen.findByRole("dialog");
    const rejection = await within(dialog).findByRole("region", {
      name: "Proposed changes rejected",
    });
    expect(rejection).toHaveTextContent(
      "Reason: The dealer is still in Lahore",
    );
    expect(rejection).toHaveTextContent("Karachi");
    await user.click(
      within(dialog).getByRole("button", { name: "Close dialog" }),
    );
    // A rejected dealer is submitted again, even unchanged.
    await user.click(screen.getByRole("button", { name: "Edit Old Office" }));
    dialog = await screen.findByRole("dialog", { name: "Edit dealer" });
    expect(dialog).toHaveTextContent(
      "Correct the details and submit the dealer again for review.",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Submit again" }),
    );
    await waitFor(() =>
      expect(sent).toEqual([
        [
          "/dealers/d2/changes",
          "POST",
          { ...fields(rejected), expected_updated_at: rejected.updated_at },
        ],
      ]),
    );
    expect(
      await screen.findByText("Dealer submitted again for review"),
    ).toBeInTheDocument();
  });
});

describe("an administrator's review of an edit request", () => {
  it("shows the agent, when, and Before → After, and approves the version reviewed", async () => {
    const user = userEvent.setup();
    open(admin);
    await user.click(
      await screen.findByRole("button", { name: "View Approved Estate" }),
    );
    const dialog = await screen.findByRole("dialog");
    const request = await within(dialog).findByRole("region", {
      name: "Changes pending approval",
    });
    expect(request).toHaveTextContent("Edit request");
    expect(request).toHaveTextContent("Proposed by Ali Agent (UID 123456)");
    expect(within(request).getAllByRole("row")).toHaveLength(3);
    await user.click(
      within(dialog).getByRole("button", { name: "Approve changes" }),
    );
    await waitFor(() =>
      expect(sent).toEqual([
        [
          "/dealers/d3/changes/approve",
          "POST",
          {
            expected_updated_at: change.updated_at,
            expected_dealer_updated_at: approved.updated_at,
          },
        ],
      ]),
    );
    expect(
      await screen.findByText("Proposed changes approved"),
    ).toBeInTheDocument();
  });

  it("rejects the changes with a reason the agent sees", async () => {
    const user = userEvent.setup();
    open(admin);
    await user.click(
      await screen.findByRole("button", { name: "View Approved Estate" }),
    );
    const dialog = await screen.findByRole("dialog");
    await user.click(
      await within(dialog).findByRole("button", { name: "Reject changes" }),
    );
    await user.type(
      within(dialog).getByRole("textbox", { name: /Reason for rejecting/ }),
      "Number not verified",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Reject changes" }),
    );
    await waitFor(() =>
      expect(sent).toEqual([
        [
          "/dealers/d3/changes/reject",
          "POST",
          {
            reason: "Number not verified",
            expected_updated_at: change.updated_at,
            expected_dealer_updated_at: approved.updated_at,
          },
        ],
      ]),
    );
  });

  it("marks a new dealer request as such", async () => {
    const user = userEvent.setup();
    open(admin);
    await user.click(
      await screen.findByRole("button", { name: "View Waiting Estate" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(
        "New dealer request: waiting for your review.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("region", {
        name: "Changes pending approval",
      }),
    ).toBeNull();
  });
});
