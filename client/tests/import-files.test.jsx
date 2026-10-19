import React from "react";
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { act, render, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  auth: { user: null, loading: false },
}));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = "51000000-0000-4000-8000-000000000001",
  agent = "51000000-0000-4000-8000-000000000002",
  other = "51000000-0000-4000-8000-000000000003";
const first = "52000000-0000-4000-8000-000000000001",
  second = "52000000-0000-4000-8000-000000000002";
let files, leads, failure, pending;
const originalDialog = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
beforeAll(() =>
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  }),
);
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
  failure = false;
  pending = null;
  mocks.auth.user = { id: admin, role: "admin", name: "File admin" };
  files = [
    {
      id: first,
      file_name: "Lahore leads.csv",
      file_format: "csv",
      lead_count: 2,
      imported_count: 2,
      rejected_count: 0,
      created_at: "2026-10-09T08:00:00Z",
      assigned_agent: null,
      assigned_name: null,
    },
    {
      id: second,
      file_name: "Karachi leads.xls",
      file_format: "xls",
      lead_count: 1,
      imported_count: 1,
      rejected_count: 0,
      created_at: "2026-10-09T08:00:00Z",
      assigned_agent: agent,
      assigned_name: "File agent",
    },
    {
      id: "52000000-0000-4000-8000-000000000003",
      file_name: "New leads.xlsx",
      file_format: "xlsx",
      lead_count: 0,
      imported_count: 0,
      rejected_count: 2,
      created_at: "2026-10-09T08:00:00Z",
    },
  ];
  leads = [
    {
      id: "53000000-0000-4000-8000-000000000001",
      name: "Lahore customer",
      masked_phone: "+92******560",
      phone: "+923001234560",
      import_id: first,
      assigned_agent: agent,
      status: "new",
      source: "CSV",
      budget_min: 0,
    },
    {
      id: "53000000-0000-4000-8000-000000000002",
      name: "Karachi customer",
      import_id: second,
      assigned_agent: agent,
      status: "new",
      source: "CSV",
      budget_min: 0,
    },
    {
      id: "53000000-0000-4000-8000-000000000003",
      name: "Individual customer",
      import_id: null,
      assigned_agent: agent,
      status: "new",
      source: "manual",
      budget_min: 0,
    },
  ];
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/users")
      return [
        { id: admin, role: "admin", active: true, name: "File admin" },
        { id: agent, role: "agent", active: true, name: "File agent" },
        { id: other, role: "agent", active: false, name: "Disabled agent" },
      ];
    if (path === "/reminders" || path.endsWith("/timeline")) return [];
    if (path.startsWith("/lead-imports?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      let visible = files.filter(
        (file) =>
          (mocks.auth.user.role === "admin" ||
            file.assigned_agent === mocks.auth.user.id) &&
          file.file_name
            .toLowerCase()
            .includes((q.get("search") || "").toLowerCase()),
      );
      const page = Number(q.get("page") || 1);
      return {
        data: visible.slice((page - 1) * 20, page * 20),
        count: visible.length,
      };
    }
    if (path.startsWith("/lead-imports/")) {
      const id = path.split("/")[2],
        file = files.find((file) => file.id === id);
      if (options?.method === "POST") {
        if (pending) await pending;
        if (failure) throw new Error("Assignment failed");
        file.assigned_agent = options.body.agent_id;
        file.assigned_name = "File agent";
        return { lead_count: file.lead_count };
      }
      if (!file) throw new Error("File not found");
      return file;
    }
    if (path.startsWith("/leads?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      return {
        data: leads.filter(
          (lead) =>
            (mocks.auth.user.role === "admin" ||
              lead.assigned_agent === mocks.auth.user.id) &&
            (!q.get("import_id") || lead.import_id === q.get("import_id")) &&
            (!q.get("status") || lead.status === q.get("status")),
        ),
        count: leads.length,
      };
    }
    if (path.startsWith("/leads/"))
      return leads.find((lead) => lead.id === path.split("/")[2]);
    return { data: [], count: 0 };
  });
});
function workspace(path = "/tasks") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[path]}>
          <App />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const assignments = () =>
  mocks.api.mock.calls.filter(
    ([path, options]) => path.endsWith("/assign") && options?.method === "POST",
  );
describe("file assignment screens", () => {
  it("shows CSV, XLS and XLSX files and disables assignment for rejected-only imports", async () => {
    workspace();
    expect(
      await screen.findByRole("heading", { name: "Task assign" }),
    ).toBeInTheDocument();
    await screen.findByRole("link", { name: "Lahore leads.csv" });
    expect(
      screen.getByRole("link", { name: "Karachi leads.xls" }),
    ).toBeInTheDocument();
    const empty = screen
      .getByRole("link", { name: "New leads.xlsx" })
      .closest("tr");
    expect(
      within(empty).getByRole("button", { name: "Assign file" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("link", { name: "Task assign" }),
    ).toBeInTheDocument();
  });
  it("assigns a whole file to an active agent and refreshes the file listing", async () => {
    const user = userEvent.setup();
    workspace();
    const row = (
      await screen.findByRole("link", { name: "Lahore leads.csv" })
    ).closest("tr");
    await user.click(within(row).getByRole("button", { name: "Assign file" }));
    const modal = screen.getByRole("dialog", { name: "Assign file" });
    expect(within(modal).getByText(/All 2 leads/)).toBeInTheDocument();
    expect(
      within(modal).queryByRole("option", { name: "File admin" }),
    ).not.toBeInTheDocument();
    expect(
      within(modal).queryByRole("option", { name: "Disabled agent" }),
    ).not.toBeInTheDocument();
    await user.selectOptions(within(modal).getByLabelText("Agent"), agent);
    await user.click(
      within(modal).getByRole("button", { name: "Assign file" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(assignments()[0]).toEqual([
      `/lead-imports/${first}/assign`,
      { method: "POST", body: { agent_id: agent } },
    ]);
    expect(await screen.findByText("File assigned")).toBeInTheDocument();
  });
  it("keeps the agent selection after a failed assignment and supports retry", async () => {
    const user = userEvent.setup();
    failure = true;
    workspace();
    const row = (
      await screen.findByRole("link", { name: "Lahore leads.csv" })
    ).closest("tr");
    await user.click(within(row).getByRole("button", { name: "Assign file" }));
    const modal = screen.getByRole("dialog", { name: "Assign file" });
    await user.selectOptions(within(modal).getByLabelText("Agent"), agent);
    await user.click(
      within(modal).getByRole("button", { name: "Assign file" }),
    );
    expect(await within(modal).findByRole("alert")).toHaveTextContent(
      "Assignment failed",
    );
    expect(within(modal).getByLabelText("Agent")).toHaveValue(agent);
    failure = false;
    await user.click(
      within(modal).getByRole("button", { name: "Assign file" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(assignments()).toHaveLength(2);
  });
  it("blocks repeated assignment and cancellation while saving", async () => {
    let done;
    pending = new Promise((resolve) => {
      done = resolve;
    });
    const user = userEvent.setup();
    workspace();
    const row = (
      await screen.findByRole("link", { name: "Lahore leads.csv" })
    ).closest("tr");
    await user.click(within(row).getByRole("button", { name: "Assign file" }));
    const modal = screen.getByRole("dialog", { name: "Assign file" });
    await user.selectOptions(within(modal).getByLabelText("Agent"), agent);
    await user.click(
      within(modal).getByRole("button", { name: "Assign file" }),
    );
    expect(
      within(modal).getByRole("button", { name: "Assigning…" }),
    ).toBeDisabled();
    expect(
      within(modal).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    await user.click(
      within(modal).getByRole("button", { name: "Close dialog" }),
    );
    expect(modal).toBeInTheDocument();
    expect(assignments()).toHaveLength(1);
    await act(async () => done());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("cancels a file assignment without making a change", async () => {
    const user = userEvent.setup();
    workspace();
    const row = (
      await screen.findByRole("link", { name: "Lahore leads.csv" })
    ).closest("tr");
    await user.click(within(row).getByRole("button", { name: "Assign file" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(assignments()).toHaveLength(0);
  });
  it("opens an agent’s assigned file as a filtered lead list with full phone numbers", async () => {
    mocks.auth.user = { id: agent, role: "agent", name: "File agent" };
    files[0].assigned_agent = agent;
    const user = userEvent.setup();
    workspace("/leads");
    const file = await screen.findByRole("link", { name: /Lahore leads.csv/ });
    expect(
      screen.queryByRole("button", { name: "Assign file" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Task assign" }),
    ).not.toBeInTheDocument();
    await user.click(file);
    expect(
      await screen.findByRole("link", { name: /Lahore customer/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /Karachi customer/ }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("+923001234560")).toBeInTheDocument();
    expect(
      mocks.api.mock.calls.some(
        ([path]) => path === "/leads/phones" || path.endsWith("/phone"),
      ),
    ).toBe(false);
    expect(
      mocks.api.mock.calls.some(
        ([path]) =>
          path.startsWith("/leads?") &&
          new URLSearchParams(path.split("?")[1]).get("import_id") === first,
      ),
    ).toBe(true);
    await user.selectOptions(
      screen.getByLabelText("Filter by status"),
      "contacted",
    );
    await screen.findByText(/No records to show/);
    expect(
      mocks.api.mock.calls
        .filter(([path]) => path.startsWith("/leads?"))
        .every(([path]) => path.includes("import_id=" + first)),
    ).toBe(true);
    await user.click(screen.getByRole("link", { name: /Assigned files/ }));
    await user.click(await screen.findByRole("link", { name: "All my leads" }));
    expect(
      await screen.findByRole("link", { name: /Individual customer/ }),
    ).toBeInTheDocument();
  });
  it("paginates file history and resets to page one when searching", async () => {
    files = Array.from({ length: 21 }, (_, index) => ({
      ...files[0],
      id: `52000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      file_name: `Import ${index}.csv`,
    }));
    const user = userEvent.setup();
    workspace();
    await screen.findByRole("link", { name: "Import 0.csv" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("link", { name: "Import 20.csv" });
    await user.type(screen.getByLabelText("Search imported files"), "Import 4");
    await screen.findByRole("link", { name: "Import 4.csv" });
    expect(screen.getByText(/Page 1/)).toBeInTheDocument();
  });
  it("keeps individual leads reachable when no files are assigned", async () => {
    mocks.auth.user = { id: other, role: "agent", name: "Other agent" };
    workspace("/leads");
    expect(
      await screen.findByText(/No files assigned yet/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All my leads" })).toHaveAttribute(
      "href",
      "/leads?view=all",
    );
  });
});
