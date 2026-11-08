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
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../src/components/common/UI";
import LeadDetail from "../src/pages/agent/LeadDetail";
import { nameError } from "../src/components/leads/EditLeadName";
// Update 054: correcting a customer's name from the lead's details, opened
// from Assigned leads or the Lead pipeline. The server tests check the same
// rules and permissions against the database.
const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const agent = "11000000-0000-4000-8000-000000000001";
let lead;
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
  lead = {
    id: "22000000-0000-4000-8000-000000000001",
    name: "Unknown",
    lead_no: 123,
    assigned_agent: agent,
    masked_phone: "+92******567",
    phone: "+923001234567",
    status: "contacted",
    source: "CSV",
    budget_min: 0,
  };
  mocks.auth.user = { id: agent, role: "agent", name: "Ali Agent" };
  mocks.api.mockImplementation(async (path, options) => {
    if (path === `/leads/${lead.id}/name`) {
      if (options.body.name === "Server refuses")
        throw Object.assign(new Error("Lead not found"), { status: 404 });
      lead = { ...lead, name: options.body.name };
      return { id: lead.id, lead_no: 123, name: lead.name, changed: true };
    }
    if (path === "/leads/" + lead.id) return lead;
    if (path.endsWith("/timeline") || path === "/users") return [];
    if (path === "/call-capabilities") return { manual: true, mock: false };
    return { data: [], count: 0 };
  });
});
function open() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[`/leads/${lead.id}`]}>
          <Routes>
            <Route path="/leads/:id" element={<LeadDetail />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
describe("editing a customer's name", () => {
  it("lets the lead's agent correct it, and shows it at once", async () => {
    const user = userEvent.setup();
    open();
    expect(
      await screen.findByRole("heading", { name: "Unknown" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Edit customer name: Unknown" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Edit customer name" });
    const input = within(dialog).getByLabelText("Customer name");
    expect(input).toHaveValue("Unknown");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      within(dialog).getByText("Enter the customer's real name"),
    ).toBeInTheDocument();
    await user.clear(input);
    await user.type(input, "  Ayesha   Malik ");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(`/leads/${lead.id}/name`, {
        method: "PUT",
        body: { name: "Ayesha Malik" },
      }),
    );
    expect(
      await screen.findByRole("heading", { name: "Ayesha Malik" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Customer name updated")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps the dialog open with the server's reason, and Cancel changes nothing", async () => {
    const user = userEvent.setup();
    open();
    await user.click(
      await screen.findByRole("button", { name: /^Edit customer name/ }),
    );
    const dialog = screen.getByRole("dialog");
    const input = within(dialog).getByLabelText("Customer name");
    await user.clear(input);
    await user.type(input, "Server refuses");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText("Lead not found"),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(
      screen.getByRole("heading", { name: "Unknown" }),
    ).toBeInTheDocument();
  });
  it("is offered to administrators and to the lead's own agent only", async () => {
    lead.assigned_agent = "11000000-0000-4000-8000-000000000009";
    open();
    await screen.findByRole("heading", { name: "Unknown" });
    expect(
      screen.queryByRole("button", { name: /^Edit customer name/ }),
    ).toBeNull();
  });
  it("checks names as the server does", () => {
    expect(
      [
        "",
        "  ",
        "N/A",
        "unknown",
        "03001234567",
        "A".repeat(101),
        "Ali Khan",
        "محمد احمد",
      ].map(nameError),
    ).toEqual([
      "Enter the customer's name",
      "Enter the customer's name",
      "Enter the customer's real name",
      "Enter the customer's real name",
      "Enter a name with letters",
      "Use a name of up to 100 characters",
      "",
      "",
    ]);
  });
});
