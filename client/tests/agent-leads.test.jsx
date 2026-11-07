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
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import OutcomeForm from "../src/components/calls/OutcomeForm";
import {
  agentNavigation,
  adminNavigation,
  breadcrumb,
} from "../src/components/layout/navigation";
// Update 052: an agent's Assigned leads and Lead pipeline. API responses are
// mocked; the server tests check the database's search, filters and access.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const ali = {
  id: "53000000-0000-4000-8000-000000000001",
  role: "agent",
  name: "Ali Agent",
};
const file = "53000000-0000-4000-8000-0000000000f1";
const row = (n, extra = {}) => ({
  id: `53000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  lead_no: 900 + n,
  name: `Customer ${n}`,
  email: null,
  assigned_agent: ali.id,
  phone: "+9230055000" + String(n).padStart(2, "0"),
  status: "contacted",
  source: "CSV",
  import_id: file,
  file_row: n,
  file_name: "Lahore buyers.csv",
  contact: "contacted",
  last_contact_at: "2026-11-05T10:00:00Z",
  last_contact_outcome: "Interested",
  temperature: null,
  next_followup_at: null,
  created_at: "2026-11-01T10:00:00Z",
  ...extra,
});
let leads, counts;
const listCalls = () =>
  mocks.api.mock.calls
    .map(([path]) => path)
    .filter((path) => path.startsWith("/my-leads?"))
    .map((path) => Object.fromEntries(new URLSearchParams(path.split("?")[1])));
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
});
afterAll(() => {
  delete HTMLDialogElement.prototype.showModal;
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { ...ali };
  leads = [row(1), row(15, { temperature: "hot" }), row(22)];
  counts = { hot: 1, warm: 0, cold: 0, none: 2 };
  mocks.api.mockImplementation(async (path) => {
    if (path.startsWith("/my-leads?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const data = leads.filter(
        (l) =>
          (!q.get("search") || q.get("search") === "#" + l.file_row) &&
          (!q.get("status") || l.status === q.get("status")) &&
          (!q.get("temperature") ||
            (l.temperature || "none") === q.get("temperature")),
      );
      return {
        data,
        count: data.length,
        limit: 20,
        ...(q.get("view") === "pipeline" ? { temperatures: counts } : {}),
      };
    }
    if (path === "/lead-imports/" + file)
      return { id: file, file_name: "Lahore buyers.csv" };
    if (path.startsWith("/leads/") && path.endsWith("/timeline")) return [];
    if (path.startsWith("/leads/"))
      return leads.find((l) => l.id === path.split("/")[2]);
    if (path === "/call-capabilities") return { manual: true, mock: false };
    return { data: [], count: 0 };
  });
});
function open(path) {
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

describe("the agent's My leads menu", () => {
  it("opens and closes My leads, with Assigned leads and Lead pipeline under it", async () => {
    const user = userEvent.setup();
    open("/leads/pipeline");
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    const parent = within(nav).getByRole("button", { name: "My leads" });
    expect(parent).toHaveAttribute("aria-expanded", "true");
    const pipeline = within(nav).getByRole("link", { name: "Lead pipeline" });
    expect(pipeline).toHaveClass("active");
    expect(pipeline).toHaveAttribute("aria-current", "page");
    expect(
      within(nav).getByRole("link", { name: "Assigned leads" }),
    ).not.toHaveClass("active");
    await user.click(parent);
    expect(parent).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).queryByRole("link", { name: "Lead pipeline" })).toBe(
      null,
    );
    await user.click(parent);
    expect(
      within(nav).getByRole("link", { name: "Assigned leads" }),
    ).toBeInTheDocument();
  });
  it("names the pages in the breadcrumb, and leaves the admin menu as it was", () => {
    expect(breadcrumb(agentNavigation, "/leads")).toEqual([
      "Sales",
      "My leads",
      "Assigned leads",
    ]);
    expect(breadcrumb(agentNavigation, "/leads/pipeline")).toEqual([
      "Sales",
      "My leads",
      "Lead pipeline",
    ]);
    expect(breadcrumb(agentNavigation, "/leads/" + row(1).id)).toEqual([
      "Sales",
      "My leads",
      "Lead details",
    ]);
    expect(breadcrumb(adminNavigation, "/leads/" + row(1).id)).toEqual([
      "Sales",
      "Leads",
      "Lead details",
    ]);
  });
});

describe("Assigned leads", () => {
  it("shows each lead's fixed # and no status, lost-reason or HD-number columns", async () => {
    open(`/leads?import_id=${file}`);
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("columnheader")[0]).toHaveTextContent(
      "#",
    );
    const rows = within(table).getAllByRole("row").slice(1);
    expect(
      rows.map((r) => within(r).getAllByRole("cell")[0].textContent),
    ).toEqual(["1", "15", "22"]);
    expect(screen.queryByLabelText("Filter by status")).toBe(null);
    expect(screen.queryByLabelText("Filter by lost reason")).toBe(null);
    expect(screen.queryByRole("columnheader", { name: "Lead number" })).toBe(
      null,
    );
    expect(screen.queryByText(/HD-000901/)).toBe(null);
    expect(screen.getByLabelText("Filter by source")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter by first call")).toBeInTheDocument();
    expect(screen.getByLabelText("Sort leads")).toHaveValue("file");
    expect(screen.getByLabelText("Search leads")).toHaveAttribute(
      "placeholder",
      "Search by name, phone or #…",
    );
    expect(listCalls()[0]).toEqual({
      view: "assigned",
      page: "1",
      import_id: file,
    });
  });
  it("searches every page by #, keeps the search when a lead is opened and closed, and resets", async () => {
    const user = userEvent.setup();
    open(`/leads?import_id=${file}`);
    await screen.findByRole("table");
    await user.type(screen.getByLabelText("Search leads"), "#15");
    await waitFor(() =>
      expect(listCalls().at(-1)).toMatchObject({
        search: "#15",
        import_id: file,
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Remove filter Search: #15" }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole("link", { name: /Customer 1\b/ })).toBe(null),
    );
    await user.click(screen.getByRole("link", { name: /Customer 15/ }));
    await user.click(
      await screen.findByRole("link", { name: /Back to leads/ }),
    );
    expect(await screen.findByLabelText("Search leads")).toHaveValue("#15");
    expect(listCalls().at(-1)).toMatchObject({ search: "#15" });
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() =>
      expect(screen.getByLabelText("Search leads")).toHaveValue(""),
    );
    await waitFor(() =>
      expect(listCalls().at(-1)).toEqual({
        view: "assigned",
        page: "1",
        import_id: file,
      }),
    );
  });
  it("shows the file beside # when listing every file", async () => {
    leads = [
      row(3),
      row(7, { import_id: null, file_row: null, file_name: null }),
    ];
    open("/leads?view=all");
    const table = await screen.findByRole("table");
    const first = within(table).getAllByRole("row")[1];
    expect(within(first).getAllByRole("cell")[0]).toHaveTextContent(
      "3Lahore buyers.csv",
    );
    const second = within(table).getAllByRole("row")[2];
    expect(within(second).getAllByRole("cell")[0]).toHaveTextContent(
      "—No file",
    );
    expect(screen.getByLabelText("Sort leads")).toHaveValue("activity");
  });
});

describe("Lead pipeline", () => {
  it("filters by status and temperature together, from the menu or the counts", async () => {
    const user = userEvent.setup();
    leads = [
      row(1, { status: "interested", temperature: "hot" }),
      row(2, { status: "interested", temperature: null }),
      row(3, { status: "won", temperature: "hot" }),
    ];
    open("/leads/pipeline");
    expect(
      await screen.findByRole("heading", { name: "Lead pipeline" }),
    ).toBeInTheDocument();
    const summary = await screen.findByRole("group", {
      name: "Pipeline leads by temperature",
    });
    expect(
      within(summary)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["🔥 Hot1", "🌤️ Warm0", "❄️ Cold0", "Not recorded yet2"]);
    expect(
      [...screen.getByLabelText("Filter by status").options].map(
        (o) => o.textContent,
      ),
    ).toEqual([
      "All statuses",
      "New",
      "Contacted",
      "Interested",
      "Site visit scheduled",
      "Visit done",
      "Negotiation",
      "Won (booked)",
      "Lost",
    ]);
    expect(
      [...screen.getByLabelText("Filter by temperature").options].map(
        (o) => o.textContent,
      ),
    ).toEqual([
      "All temperatures",
      "🔥 Hot",
      "🌤️ Warm",
      "❄️ Cold",
      "Not recorded yet",
    ]);
    await user.selectOptions(
      screen.getByLabelText("Filter by status"),
      "interested",
    );
    await user.click(within(summary).getByRole("button", { name: /Hot/ }));
    await waitFor(() =>
      expect(listCalls().at(-1)).toEqual({
        view: "pipeline",
        page: "1",
        status: "interested",
        temperature: "hot",
      }),
    );
    expect(
      within(summary).getByRole("button", { name: /Hot/ }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByLabelText("Filter by temperature")).toHaveValue("hot");
    const table = await screen.findByRole("table");
    await waitFor(() =>
      expect(within(table).getAllByRole("row")).toHaveLength(2),
    );
    expect(within(table).getByText("Customer 1")).toBeInTheDocument();
    expect(within(table).getByText("Hot")).toBeInTheDocument();
    expect(
      within(table).getByRole("link", { name: "View details for Customer 1" }),
    ).toHaveAttribute("href", "/leads/" + row(1).id);
    await user.selectOptions(screen.getByLabelText("Filter by status"), "lost");
    expect(
      await screen.findByText(/No pipeline leads match these filters/),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() =>
      expect(listCalls().at(-1)).toEqual({ view: "pipeline", page: "1" }),
    );
  });
  it("explains an empty pipeline", async () => {
    leads = [];
    counts = { hot: 0, warm: 0, cold: 0, none: 0 };
    open("/leads/pipeline");
    expect(
      await screen.findByText(/A lead appears here after an answered call/),
    ).toBeInTheDocument();
  });
  it("is for agents only", async () => {
    mocks.user = {
      id: "53000000-0000-4000-8000-0000000000a1",
      role: "admin",
      name: "Owner",
    };
    open("/leads/pipeline");
    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Lead pipeline" })).toBe(
        null,
      ),
    );
    expect(listCalls()).toHaveLength(0);
  });
});

describe("the call's lead temperature", () => {
  const form = (props) =>
    render(<OutcomeForm call={{}} onSave={props.onSave} {...props} />);
  it("offers exactly Hot, Warm and Cold, one at a time, and can be cleared", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    form({ onSave, manual: true });
    const group = screen.getByRole("group", { name: "Lead temperature" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("aria-label")),
    ).toEqual(["Hot", "Warm", "Cold"]);
    await user.click(screen.getByLabelText("Hot"));
    await user.click(screen.getByLabelText("Cold"));
    expect(screen.getByLabelText("Hot")).not.toBeChecked();
    expect(screen.getByLabelText("Cold")).toBeChecked();
    await user.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByLabelText("Cold")).not.toBeChecked();
  });
  it("is only asked after speaking to the customer", async () => {
    const user = userEvent.setup();
    form({ onSave: vi.fn(), manual: true });
    await user.selectOptions(screen.getByLabelText("Call connected?"), "no");
    expect(screen.queryByRole("group", { name: "Lead temperature" })).toBe(
      null,
    );
    await user.selectOptions(screen.getByLabelText("Call connected?"), "yes");
    await user.selectOptions(
      screen.getByLabelText("Call outcome"),
      "Interested",
    );
    expect(
      screen.getByRole("group", { name: "Lead temperature" }),
    ).toBeInTheDocument();
  });
  it("keeps a call's other saved tags when its temperature changes", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(
      <OutcomeForm
        call={{
          outcome: "Interested",
          notes: "",
          deal_tags: ["Budget mismatch", "Hot lead"],
        }}
        onSave={onSave}
      />,
    );
    expect(screen.getByLabelText("Hot")).toBeChecked();
    expect(screen.queryByLabelText("Budget mismatch")).toBe(null);
    await user.click(screen.getByLabelText("Cold"));
    fireEvent.click(screen.getByRole("button", { name: "Save outcome" }));
    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave.mock.calls[0][0].deal_tags).toEqual([
      "Budget mismatch",
      "Cold lead",
    ]);
  });
});
