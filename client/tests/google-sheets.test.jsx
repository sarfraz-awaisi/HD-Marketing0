import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import AdInquiries from "../src/components/leads/AdInquiries";
import ImportedFiles from "../src/components/leads/ImportedFiles";
import { ToastProvider } from "../src/components/common/UI";
import {
  adminNavigation,
  agentNavigation,
  breadcrumb,
} from "../src/components/layout/navigation";
// Update 056: administrators' Google Sheets page and the advertisement
// inquiry on the lead page. API responses are mocked; the server tests check
// the import, the key and who may use them.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const owner = {
  id: "56300000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
};
const agent = {
  id: "56300000-0000-4000-8000-0000000000a2",
  role: "agent",
  name: "Ali Agent",
};
const file = "56300000-0000-4000-8000-0000000000f1";
const source = (extra = {}) => ({
  id: "56300000-0000-4000-8000-000000000001",
  name: "DHA plots",
  spreadsheet_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
  worksheet: "Sheet1",
  import_from: null,
  enabled: true,
  import_id: file,
  file_name: "DHA plots",
  file_deleted: false,
  new_leads: 41,
  repeat_inquiries: 3,
  rejected: 0,
  unassigned: 5,
  last_sync_at: new Date().toISOString(),
  last_check_at: new Date().toISOString(),
  last_error_code: null,
  last_error_at: null,
  sheet_rows: 44,
  ...extra,
});
let settings;
beforeEach(() => {
  vi.clearAllMocks();
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
  mocks.user = { ...owner };
  settings = {
    key: {
      hint: "x9Q_",
      created_at: "2026-11-09T08:00:00Z",
      created_by: "Owner",
      last_used_at: "2026-11-09T09:00:00Z",
      owner_active: true,
    },
    sources: [
      source(),
      source({
        id: "56300000-0000-4000-8000-000000000002",
        name: "Bahria flats",
        file_name: "Bahria flats",
        file_deleted: true,
        rejected: 2,
        new_leads: 7,
        unassigned: 0,
        last_error_code: "file_deleted",
        last_error_at: "2026-11-09T09:05:00Z",
        last_check_at: "2026-11-09T06:00:00Z",
      }),
    ],
  };
  mocks.api.mockImplementation(async (path, options = {}) => {
    if (path === "/integrations/sheets") return settings;
    if (path.endsWith("/rejections"))
      return [
        {
          row: 7,
          reason: "phone_invalid",
          meta_lead_id: "7100000000000007",
          last_seen_at: "2026-11-09T09:05:00Z",
        },
        {
          row: 9,
          reason: "lead_deleted",
          meta_lead_id: "7100000000000009",
          lead_no: "HD-000123",
          last_seen_at: "2026-11-09T09:05:00Z",
        },
      ];
    if (path === "/integrations/sheets/key" && options.method === "POST")
      return {
        key: "hdcrm_sheets_" + "k".repeat(39) + "WXYZ",
        hint: "WXYZ",
        replaced: false,
      };
    if (path.startsWith("/integrations/sheets/sources"))
      return { id: "new", changed: true };
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
const calls = (path, method) =>
  mocks.api.mock.calls.filter(
    ([p, o]) => p === path && (o?.method || "GET") === method,
  );

describe("the administrator's Integrations menu", () => {
  it("holds Meta Lead Ads and Google Sheets, for administrators only", async () => {
    open("/integrations/sheets");
    const nav = await screen.findByRole("navigation", { name: "Workspace" });
    expect(
      within(nav).getByRole("link", { name: "Google Sheets" }),
    ).toHaveClass("active");
    expect(
      within(nav).getByRole("link", { name: "Meta Lead Ads" }),
    ).not.toHaveClass("active");
    expect(breadcrumb(adminNavigation, "/integrations/sheets")).toEqual([
      "Administration",
      "Integrations",
      "Google Sheets",
    ]);
    expect(JSON.stringify(agentNavigation)).not.toContain("/integrations");
  });
  it("keeps agents out of the page", async () => {
    mocks.user = { ...agent };
    open("/integrations/sheets");
    await screen.findByRole("navigation", { name: "Workspace" });
    expect(screen.queryByRole("heading", { name: "Google Sheets" })).toBeNull();
    expect(
      mocks.api.mock.calls.filter(([p]) =>
        p.startsWith("/integrations/sheets"),
      ),
    ).toEqual([]);
  });
});

describe("the Google Sheets page", () => {
  it("shows each Sheet's file, counts, sync and errors, and its rejected rows", async () => {
    const user = userEvent.setup();
    open("/integrations/sheets");
    expect(
      await screen.findByRole("heading", { name: "Google Sheets" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        (_, el) =>
          el?.tagName === "P" && el.textContent.startsWith("Active key ending"),
      ),
    ).toHaveTextContent("Active key ending …x9Q_, created by Owner");
    const [, first, second] = screen.getAllByRole("row");
    expect(
      within(first).getByRole("link", { name: "DHA plots" }),
    ).toHaveAttribute("href", `/leads?import_id=${file}`);
    expect(first).toHaveTextContent("41 new leads");
    expect(first).toHaveTextContent("3 repeat inquiries");
    expect(first).toHaveTextContent("5 waiting for an agent");
    expect(first).not.toHaveTextContent("No check from the script");
    expect(second).toHaveTextContent("Deleted");
    expect(second).toHaveTextContent("This Sheet's lead file was deleted");
    expect(second).toHaveTextContent("No check from the script for 20 minutes");
    expect(
      within(second).getByRole("button", { name: "Start a new lead file" }),
    ).toBeInTheDocument();
    expect(
      within(first).queryByRole("button", { name: "Start a new lead file" }),
    ).toBeNull();
    await user.click(within(second).getByRole("button", { name: "2 · View" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Rejected rows · Bahria flats",
    });
    await within(dialog).findByText("Phone number missing or invalid");
    expect(dialog).toHaveTextContent(
      "This number is in Deleted leads (HD-000123)",
    );
    // No phone number, name or email is ever on this page.
    expect(document.body.textContent).not.toMatch(/\+92|@/);
  });
  it("adds a Sheet, off until it is turned on", async () => {
    const user = userEvent.setup();
    open("/integrations/sheets");
    await user.click(await screen.findByRole("button", { name: "Add Sheet" }));
    const dialog = await screen.findByRole("dialog", { name: "Add Sheet" });
    await user.type(
      within(dialog).getByLabelText("Name (also the lead file's name)"),
      "Gulberg shops",
    );
    await user.type(
      within(dialog).getByLabelText("Google Sheet link or ID"),
      "https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210/edit",
    );
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(calls("/integrations/sheets/sources", "POST")).toHaveLength(1),
    );
    expect(calls("/integrations/sheets/sources", "POST")[0][1].body).toEqual({
      name: "Gulberg shops",
      spreadsheet:
        "https://docs.google.com/spreadsheets/d/1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210/edit",
      worksheet: "Sheet1",
      import_from: null,
      enabled: false,
    });
  });
  it("asks to confirm the historical import before turning a Sheet on", async () => {
    settings.sources[1] = {
      ...settings.sources[1],
      enabled: false,
      history_pending: true,
      import_from: null,
    };
    const patches = [];
    mocks.api.mockImplementation(async (path, options = {}) => {
      if (path === "/integrations/sheets") return settings;
      if (options.method === "PATCH") {
        patches.push(options.body);
        if (!options.body.confirm_history)
          throw Object.assign(new Error("Confirm the historical import"), {
            status: 409,
            code: "SHEETS_CONFIRM_HISTORY",
          });
        return { id: "x", changed: true };
      }
      return { data: [], count: 0 };
    });
    const user = userEvent.setup();
    open("/integrations/sheets");
    const row = (await screen.findAllByRole("row"))[2];
    await user.click(within(row).getByRole("button", { name: "Turn on" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Confirm the historical import",
    });
    expect(dialog).toHaveTextContent(
      "Turning on Bahria flats imports every row already in the Sheet",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm and turn on" }),
    );
    await waitFor(() =>
      expect(patches).toEqual([
        { enabled: true },
        { enabled: true, confirm_history: true },
      ]),
    );
  });
  it("shows a new key once", async () => {
    settings.key = null;
    const user = userEvent.setup();
    open("/integrations/sheets");
    expect(
      await screen.findByText(
        /No key: the Google Apps Script cannot send leads/,
      ),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Create key" }));
    const confirm = await screen.findByRole("dialog", { name: "Create key" });
    await user.click(
      within(confirm).getByRole("button", { name: "Create key" }),
    );
    const shown = await screen.findByRole("dialog", {
      name: "Your new integration key",
    });
    expect(
      within(shown).getByLabelText("New integration key"),
    ).toHaveTextContent(/^hdcrm_sheets_k+WXYZ$/);
    await user.click(within(shown).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(document.body.textContent).not.toContain("hdcrm_sheets_"),
    );
  });
});

describe("the lead page", () => {
  const lead = {
    id: "56300000-0000-4000-8000-0000000000c1",
    name: "Bilal Khan",
    email: "bilal@example.com",
  };
  const show = () =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <AdInquiries lead={lead} />
      </QueryClientProvider>,
    );
  it("shows what the customer submitted through the advertisement", async () => {
    mocks.api.mockResolvedValue([
      {
        source: "DHA plots",
        repeat: true,
        submitted_at: "2026-11-01T05:15:30Z",
        platform: "instagram",
        ad_name: "DHA Phase 9 plots",
        campaign_name: "November plots",
        form_name: "Plot inquiry",
        full_name: "Bilal",
        email: "bilal@example.com",
        city: "Lahore",
        interest: "residential_plot",
        budget: "50_lakh_to_1_crore",
        extra: { "preferred_contact_time?_": "after_6_pm" },
      },
    ]);
    show();
    const panel = await screen.findByRole("heading", {
      name: "Advertisement inquiry",
    });
    const section = panel.closest("section");
    expect(mocks.api).toHaveBeenCalledWith(
      `/leads/${lead.id}/inquiries`,
      expect.anything(),
    );
    for (const text of [
      "Repeat inquiry",
      "Instagram",
      "residential plot",
      "50 lakh to 1 crore",
      "DHA Phase 9 plots",
      "November plots",
      "Lahore",
      "preferred contact time",
      "after 6 pm",
      "From the Sheet DHA plots",
    ])
      expect(section).toHaveTextContent(text);
    // The name they submitted differs from the lead's (corrected) name.
    expect(section).toHaveTextContent("Submitted as");
  });
  it("shows nothing for a lead without one", async () => {
    mocks.api.mockResolvedValue([]);
    const { container } = show();
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
  it("names a Sheet's lead file as Google Sheets", async () => {
    mocks.api.mockResolvedValue({
      data: [
        {
          id: file,
          file_name: "DHA plots",
          file_format: "sheets",
          lead_count: 41,
          created_at: "2026-11-09T08:00:00Z",
        },
      ],
      count: 1,
    });
    mocks.user = { ...agent };
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <ImportedFiles />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText(/Google Sheets · 41 leads/),
    ).toBeInTheDocument();
  });
});
