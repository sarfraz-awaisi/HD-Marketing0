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
import { whatsappLink } from "../src/lib/whatsapp";
import {
  agentNavigation,
  adminNavigation,
  breadcrumb,
} from "../src/components/layout/navigation";
// Updates 052 and 053: an agent's Assigned leads and Lead pipeline. API responses are
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
  file_row: 400 + n,
  file_name: "Lahore buyers.csv",
  contact: "contacted",
  last_contact_at: "2026-11-05T10:00:00Z",
  last_contact_outcome: "Interested",
  last_call_at: "2026-11-05T10:00:00Z",
  last_call_outcome: "Interested",
  last_call_connected: true,
  temperature: null,
  note: null,
  note_at: null,
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
      const search = (q.get("search") || "").toLowerCase();
      const matched = leads.filter(
        (l) =>
          (!search ||
            l.name.toLowerCase().includes(search) ||
            l.phone.includes(search)) &&
          (!q.get("outcome") || l.last_call_outcome === q.get("outcome")) &&
          (!q.get("temperature") ||
            (l.temperature || "none") === q.get("temperature")),
      );
      const page = Number(q.get("page")) || 1;
      return {
        data: matched.slice((page - 1) * 20, page * 20),
        count: matched.length,
        page,
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

const cells = (table, column) =>
  within(table)
    .getAllByRole("row")
    .slice(1)
    .map((r) => within(r).getAllByRole("cell")[column].textContent);

describe("Assigned leads", () => {
  it("numbers rows 1, 2, 3 by position, page after page, with only the columns for calling", async () => {
    const user = userEvent.setup();
    leads = Array.from({ length: 23 }, (_, i) => row(i + 1));
    open(`/leads?import_id=${file}`);
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "#",
      "Customer",
      "Phone",
      "First call",
      "Last contact",
      "Actions",
    ]);
    expect(cells(table, 0).slice(0, 3)).toEqual(["1", "2", "3"]);
    expect(within(table).queryByText(/Lahore buyers.csv/)).toBe(null);
    expect(within(table).queryByText(/HD-0009/)).toBe(null);
    expect(within(table).queryByText("401")).toBe(null);
    await user.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(cells(screen.getByRole("table"), 0)).toEqual(["21", "22", "23"]),
    );
    for (const label of [
      "Filter by status",
      "Filter by lost reason",
      "Filter by source",
      "Sort leads",
    ])
      expect(screen.queryByLabelText(label)).toBe(null);
    expect(screen.getByLabelText("Filter by first call")).toBeInTheDocument();
    expect(screen.getByLabelText("Search leads")).toHaveAttribute(
      "placeholder",
      "Search by name or phone number…",
    );
  });
  it("numbers search results from 1, keeps the search when a lead is opened and closed, and resets", async () => {
    const user = userEvent.setup();
    open(`/leads?import_id=${file}`);
    await screen.findByRole("table");
    await user.type(screen.getByLabelText("Search leads"), "customer 2#");
    await waitFor(() =>
      expect(listCalls().at(-1)).toMatchObject({
        search: "customer 2",
        import_id: file,
      }),
    );
    await waitFor(() =>
      expect(cells(screen.getByRole("table"), 1)).toEqual([
        expect.stringContaining("Customer 22"),
      ]),
    );
    expect(cells(screen.getByRole("table"), 0)).toEqual(["1"]);
    await user.click(
      screen.getByRole("link", { name: "View details for Customer 22" }),
    );
    await user.click(
      await screen.findByRole("link", { name: /Back to leads/ }),
    );
    expect(await screen.findByLabelText("Search leads")).toHaveValue(
      "customer 2",
    );
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() =>
      expect(listCalls().at(-1)).toEqual({
        view: "assigned",
        page: "1",
        import_id: file,
      }),
    );
  });
  it("finds Number off leads by their last call, and shows each lead's last contact", async () => {
    const user = userEvent.setup();
    leads = [
      row(1, {
        contact: "attempted",
        last_contact_at: null,
        last_call_outcome: "Number off",
        last_call_connected: false,
      }),
      row(2, { last_call_at: null, last_call_outcome: null, contact: "none" }),
    ];
    open("/leads?view=all");
    const table = await screen.findByRole("table");
    expect(cells(table, 4)[0]).toMatch(/^Number off/);
    expect(cells(table, 4)[1]).toBe("Not called yet");
    await user.selectOptions(
      screen.getByLabelText("Filter by last call"),
      "Number off",
    );
    await waitFor(() =>
      expect(listCalls().at(-1)).toEqual({
        view: "assigned",
        page: "1",
        outcome: "Number off",
      }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Remove filter Last call: Number off",
      }),
    ).toBeInTheDocument();
  });
});

describe("Lead pipeline", () => {
  it("filters by temperature and the latest call's outcome together, with no status filter", async () => {
    const user = userEvent.setup();
    leads = [
      row(1, { temperature: "hot" }),
      row(2, {
        temperature: "hot",
        last_call_at: "2026-11-06T10:00:00Z",
        last_call_outcome: "Number off",
        last_call_connected: false,
      }),
      row(3, { temperature: null }),
    ];
    open("/leads/pipeline");
    expect(
      await screen.findByRole("heading", { name: "Lead pipeline" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Filter by status")).toBe(null);
    expect(screen.queryByLabelText("Sort leads")).toBe(null);
    const outcome = screen.getByLabelText("Filter by call outcome");
    expect([...outcome.options].map((o) => o.textContent)).toEqual([
      "All outcomes",
      "No answer",
      "Busy",
      "Wrong number",
      "Number off",
      "Interested",
      "Not interested",
      "Follow-up required",
      "Site visit scheduled",
      "Deal discussion",
    ]);
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "#",
      "Customer",
      "Phone",
      "Temperature",
      "Agent notes",
      "Latest contact",
      "Next follow-up",
      "Details",
    ]);
    expect(cells(table, 0)).toEqual(["1", "2", "3"]);
    const summary = screen.getByRole("group", {
      name: "Pipeline leads by temperature",
    });
    await user.click(within(summary).getByRole("button", { name: /Hot/ }));
    await user.selectOptions(outcome, "Number off");
    await waitFor(() =>
      expect(listCalls().at(-1)).toEqual({
        view: "pipeline",
        page: "1",
        temperature: "hot",
        outcome: "Number off",
      }),
    );
    await waitFor(() =>
      expect(cells(screen.getByRole("table"), 1)).toEqual([
        expect.stringContaining("Customer 2"),
      ]),
    );
    expect(cells(screen.getByRole("table"), 0)).toEqual(["1"]);
    expect(cells(screen.getByRole("table"), 5)[0]).toContain(
      "Later call: Number off",
    );
    // Leads never reached are found in Assigned leads.
    expect(
      screen.getByRole("link", {
        name: "Assigned leads (last call: Number off)",
      }),
    ).toHaveAttribute("href", "/leads?view=all&outcome=Number%20off");
    await user.click(screen.getByRole("button", { name: "Reset filters" }));
    await waitFor(() =>
      expect(listCalls().at(-1)).toEqual({ view: "pipeline", page: "1" }),
    );
  });
  it("shows each lead's latest agent note, two lines at first, or says there is none", async () => {
    const user = userEvent.setup();
    const long =
      "Wants a 10 marla house in DHA Phase 6, close to the school; budget can stretch if the corner plot is available next month.";
    leads = [
      row(1, { note: long, note_at: "2026-11-05T11:00:00Z" }),
      row(2, { note: "Call after Friday", note_at: "2026-11-05T09:00:00Z" }),
      row(3),
    ];
    open("/leads/pipeline");
    const table = await screen.findByRole("table");
    expect(cells(table, 4)[1]).toMatch(/^Call after Friday/);
    expect(cells(table, 4)[2]).toBe("No notes yet");
    const more = within(table).getByRole("button", { name: "Read more" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    expect(
      within(table).getByRole("button", { name: "Show less" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(within(table).getByText(long)).toHaveClass("open");
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

describe("WhatsApp links", () => {
  it.each([
    ["+923001234567", "923001234567"],
    ["923001234567", "923001234567"],
    ["03001234567", "923001234567"],
    ["0300-1234567", "923001234567"],
    ["0092 300 1234567", "923001234567"],
    ["3001234567", "923001234567"],
    ["+971501234567", "971501234567"],
  ])("opens a chat with %s", (phone, number) => {
    expect(whatsappLink(phone)).toBe("https://wa.me/" + number);
  });
  it.each([null, "", "12345", "+92 0300 1234567", "0300 123 abc", "+1"])(
    "gives no link for %s",
    (phone) => expect(whatsappLink(phone)).toBe(null),
  );
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
  it("offers Number off only for a call that did not connect", async () => {
    const user = userEvent.setup();
    form({ onSave: vi.fn(), manual: true });
    const options = () =>
      [...screen.getByLabelText("Call outcome").options].map(
        (o) => o.textContent,
      );
    expect(options()).not.toContain("Number off");
    await user.selectOptions(screen.getByLabelText("Call connected?"), "no");
    expect(options()).toEqual([
      "Select an outcome",
      "No answer",
      "Busy",
      "Wrong number",
      "Number off",
    ]);
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
