import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
// Update 073: administrators export leads file by file from All leads. API
// responses are mocked; the server tests check the filters, files and
// worksheets.
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  download: vi.fn(),
  user: null,
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
  download: mocks.download,
}));
const owner = {
  id: "73200000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
  active: true,
};
const ali = {
  id: "73200000-0000-4000-8000-0000000000a2",
  role: "agent",
  name: "Ali Agent",
  active: true,
};
const fileId = (n) => `73200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Two Sheets with the same name, and an Excel file.
const sources = {
  files: [
    {
      id: fileId(1),
      name: "General Form Leads",
      format: "sheets",
      created_at: "2026-11-01T08:00:00Z",
      rows: 1000,
      created: 800,
      repeat: 40,
      rejected: 12,
      in_crm: 790,
      deleted: 6,
      sheet: {
        spreadsheet_id: "1AbcSheetOne0000000000000",
        worksheet: "Sheet1",
      },
    },
    {
      id: fileId(2),
      name: "General Form Leads",
      format: "sheets",
      created_at: "2026-11-05T08:00:00Z",
      rows: 50,
      created: 50,
      repeat: 0,
      rejected: 0,
      in_crm: 50,
      deleted: 0,
      sheet: {
        spreadsheet_id: "1AbcSheetTwo0000000000000",
        worksheet: "Leads",
      },
    },
    {
      id: fileId(3),
      name: "buyers.xlsx",
      format: "xlsx",
      created_at: "2026-11-07T08:00:00Z",
      rows: 20,
      created: 19,
      repeat: null,
      rejected: 1,
      in_crm: 19,
      deleted: 0,
      sheet: null,
    },
  ],
  no_file: { manual: 7, Meta: 3 },
};
let previews, exports;
function serve() {
  previews = [];
  exports = [];
  mocks.api.mockImplementation(async (path, options = {}) => {
    if (path === "/users") return [owner, ali];
    if (path === "/leads/export/sources") return sources;
    if (path === "/leads/export/preview") {
      previews.push(options.body.filters);
      const count = options.body.filters.status === "won" ? 0 : 42;
      return {
        count,
        calls: 120,
        notes: 30,
        assignments: 50,
        files: {},
        limits: { xlsxLeads: 10000, csvLeads: 50000 },
      };
    }
    if (path === "/leads/export") {
      exports.push(options);
      return new Blob(["file"]);
    }
    if (path.startsWith("/leads/all"))
      return {
        page: 1,
        limit: 20,
        count: 0,
        totals: { total: 0, assigned: 0, unassigned: 0 },
        data: [],
      };
    if (path.startsWith("/lead-imports")) return { data: [], count: 0 };
    return { data: [], count: 0 };
  });
}
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
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  mocks.api.mockReset();
  mocks.download.mockReset();
  mocks.user = { ...owner };
  serve();
});
const lastPreview = () => previews.at(-1);
const countLine = (dialog) =>
  dialog.querySelector(".lead-export-count").textContent;

describe("lead export (update 073)", () => {
  it("starts from All leads' filters, tells same-named Sheets apart and counts before exporting", async () => {
    const user = userEvent.setup();
    open(`/leads?agent=${ali.id}&temperature=hot&import_id=${fileId(1)}`);
    await user.click(await screen.findByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog", { name: "Export leads" });
    await waitFor(() =>
      expect(lastPreview()).toEqual({
        agent: ali.id,
        temperature: "hot",
        files: [fileId(1)],
      }),
    );
    await waitFor(() =>
      expect(countLine(dialog)).toMatch(
        /^42 leads match · 120 calls · 30 notes · 50 assignments/,
      ),
    );
    // The two Sheets named alike show their spreadsheet IDs; the figures are
    // apart: rows, new leads, repeats, rejected.
    expect(
      within(dialog).getByText(/tab Sheet1 · 1AbcSheetOne/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/tab Leads · 1AbcSheetTwo/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        /1,000 rows · 800 new leads · 40 repeats · 12 rejected · 790 in the CRM now/,
      ),
    ).toBeInTheDocument();
    const boxes = within(dialog).getAllByRole("checkbox", {
      name: /General Form Leads/,
    });
    expect(boxes.map((b) => b.checked)).toEqual([true, false]);
    await user.click(boxes[1]);
    await waitFor(() =>
      expect(lastPreview().files).toEqual([fileId(1), fileId(2)]),
    );
    await user.click(within(dialog).getByRole("checkbox", { name: /No file/ }));
    await waitFor(() => expect(lastPreview().no_file).toBe(true));
  });

  it("uses presets and exports Excel with the chosen worksheets, or one worksheet as CSV", async () => {
    const user = userEvent.setup();
    open("/leads?temperature=hot");
    await user.click(await screen.findByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog", { name: "Export leads" });
    await user.click(within(dialog).getByRole("button", { name: "Contacted" }));
    // A preset sets its own filters in place of the lead-state ones.
    await waitFor(() => expect(lastPreview()).toEqual({ contacted: "yes" }));
    expect(
      within(dialog).getByRole("button", { name: "Contacted" }),
    ).toHaveAttribute("aria-pressed", "true");
    await user.selectOptions(within(dialog).getByLabelText("Agent"), ali.id);
    await user.type(
      within(dialog).getByLabelText("Had a call from"),
      "2026-11-01",
    );
    await waitFor(() =>
      expect(lastPreview()).toEqual({
        contacted: "yes",
        agent: ali.id,
        calls_from: "2026-11-01",
      }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Export 42 leads" }),
    );
    await waitFor(() => expect(exports).toHaveLength(1));
    expect(exports[0]).toMatchObject({
      method: "POST",
      download: true,
      body: {
        filters: { contacted: "yes", agent: ali.id, calls_from: "2026-11-01" },
        format: "xlsx",
        sheets: [
          "summary",
          "calls",
          "notes",
          "assignments",
          "ad_quality",
          "files",
        ],
        preset: "contacted",
      },
    });
    expect(mocks.download.mock.calls[0][1]).toMatch(
      /^hd-leads-contacted-\d{4}-\d{2}-\d{2}\.xlsx$/,
    );
    expect(
      await within(dialog).findByText("Exported 42 leads."),
    ).toBeInTheDocument();
    // One worksheet as CSV.
    await user.click(within(dialog).getByRole("radio", { name: /CSV/ }));
    await user.selectOptions(
      within(dialog).getByLabelText("Worksheet"),
      "calls",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Export 42 leads" }),
    );
    await waitFor(() => expect(exports).toHaveLength(2));
    expect(exports[1].body).toMatchObject({ format: "csv", sheet: "calls" });
    expect(exports[1].body.sheets).toBeUndefined();
    expect(mocks.download.mock.calls[1][1]).toMatch(/-calls\.csv$/);
  });

  it("cannot export nothing, and is only on administrators' All leads", async () => {
    const user = userEvent.setup();
    open("/leads");
    await user.click(await screen.findByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog", { name: "Export leads" });
    await user.selectOptions(within(dialog).getByLabelText("Status"), "won");
    await waitFor(() => expect(countLine(dialog)).toMatch(/^0 leads match/));
    expect(
      within(dialog).getByRole("button", { name: "Export" }),
    ).toBeDisabled();
    expect(exports).toHaveLength(0);
  });
});
