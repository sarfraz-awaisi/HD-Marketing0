import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
// Updates 073 and 074: administrators export one lead file's assigned
// leads from All leads. API responses are mocked; the server tests check
// the leads, the columns and the file.
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
      const filters = options.body.filters;
      previews.push(filters);
      const count =
        filters.status === "won"
          ? 0
          : filters.temperature === "cold"
            ? 20000
            : 128;
      return { count, in_file: 790, assigned: 160, max: 10000 };
    }
    if (path === "/leads/export") {
      exports.push(options);
      if (options.body.filters.status === "lost")
        throw new Error("The export could not be prepared. Please try again.");
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
const counts = (dialog) =>
  Object.fromEntries(
    [...dialog.querySelectorAll(".lead-export-count dl > div")].map((d) => [
      d.querySelector("dt").textContent,
      d.querySelector("dd").textContent,
    ]),
  );
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Karachi",
}).format(new Date());
async function dialogFor(path) {
  const user = userEvent.setup();
  open(path);
  await user.click(await screen.findByRole("button", { name: "Export" }));
  return {
    user,
    dialog: await screen.findByRole("dialog", { name: "Export leads" }),
  };
}

describe("lead export: one file's assigned leads (update 074)", () => {
  it("starts from the file All leads is showing and nothing else, tells same-named Sheets apart, and counts before exporting", async () => {
    // All leads filtered by agent and temperature: the export still starts
    // with every assigned lead of the file.
    const { dialog } = await dialogFor(
      `/leads?agent=${ali.id}&temperature=hot&import_id=${fileId(1)}`,
    );
    await waitFor(() => expect(lastPreview()).toEqual({ file: fileId(1) }));
    const radios = within(dialog).getAllByRole("radio");
    expect(radios).toHaveLength(4);
    expect(radios[0]).toBeChecked();
    expect(dialog.textContent).toContain(
      "Google Sheet · tab Sheet1 · 1AbcSheetOne0000000000000",
    );
    expect(dialog.textContent).toContain(
      "Google Sheet · tab Leads · 1AbcSheetTwo0000000000000",
    );
    expect(dialog.textContent).toContain(
      "1,000 rows · 800 new leads · 40 repeat inquiries · 12 rejected · 790 in the CRM now",
    );
    await waitFor(() =>
      expect(counts(dialog)).toEqual({
        "Rows in the Sheet (last check)": "1,000",
        "Leads from it in the CRM": "790",
        "Assigned to an agent now": "160",
        "Leads to export": "128",
      }),
    );
    expect(dialog.textContent).toContain(
      "40 rows were repeat inquiries from customers who were already leads",
    );
    // No worksheet, format or preset choices: one Excel file.
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(
      within(dialog).getByRole("button", { name: "Export Excel" }),
    ).toBeEnabled();
  });

  it("narrows only when asked, and downloads one Excel file named after the lead file", async () => {
    const { user, dialog } = await dialogFor("/leads");
    expect(dialog.querySelector(".lead-export-count").textContent).toBe(
      "Choose a lead file.",
    );
    expect(
      within(dialog).getByRole("button", { name: "Export Excel" }),
    ).toBeDisabled();
    expect(previews).toHaveLength(0);
    await user.click(within(dialog).getAllByRole("radio")[0]);
    await waitFor(() => expect(lastPreview()).toEqual({ file: fileId(1) }));
    await user.selectOptions(within(dialog).getByLabelText("Agent"), ali.id);
    await user.selectOptions(
      within(dialog).getByLabelText("Temperature"),
      "hot",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("Last call outcome"),
      "No answer",
    );
    await user.selectOptions(within(dialog).getByLabelText("Contacted"), "no");
    await user.selectOptions(within(dialog).getByLabelText("Worked"), "yes");
    const narrowed = {
      file: fileId(1),
      agent: ali.id,
      temperature: "hot",
      outcome: "No answer",
      contacted: "no",
      worked: "yes",
    };
    await waitFor(() => expect(lastPreview()).toEqual(narrowed));
    // Back to any agent: the filter is gone, not sent empty.
    await user.selectOptions(within(dialog).getByLabelText("Agent"), "");
    const { agent, ...rest } = narrowed;
    await waitFor(() => expect(lastPreview()).toEqual(rest));
    expect(agent).toBe(ali.id);
    const button = within(dialog).getByRole("button", { name: "Export Excel" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1));
    expect(exports[0]).toMatchObject({
      method: "POST",
      body: { filters: rest },
      download: true,
    });
    expect(mocks.download.mock.calls[0][1]).toBe(
      `General-Form-Leads-Assigned-${today}.xlsx`,
    );
    expect(dialog.textContent).toContain(
      `Downloaded 128 leads: General-Form-Leads-Assigned-${today}.xlsx`,
    );
  });

  it("exports the leads with no file, and stops when nothing or too much matches", async () => {
    const { user, dialog } = await dialogFor("/leads");
    await user.click(within(dialog).getByRole("radio", { name: /No file/ }));
    await waitFor(() => expect(lastPreview()).toEqual({ no_file: true }));
    expect(counts(dialog)).not.toHaveProperty("Rows in the file");
    const button = within(dialog).getByRole("button", { name: "Export Excel" });
    await waitFor(() => expect(button).toBeEnabled());
    // Nothing matches.
    await user.selectOptions(within(dialog).getByLabelText("Status"), "won");
    await waitFor(() => expect(counts(dialog)["Leads to export"]).toBe("0"));
    expect(button).toBeDisabled();
    // Too many for one file.
    await user.selectOptions(within(dialog).getByLabelText("Status"), "");
    await user.selectOptions(
      within(dialog).getByLabelText("Temperature"),
      "cold",
    );
    expect(
      await within(dialog).findByText(
        "More than 10,000 leads match. Choose an agent or narrower filters.",
      ),
    ).toBeTruthy();
    expect(button).toBeDisabled();
    // A refused export says why.
    await user.selectOptions(within(dialog).getByLabelText("Temperature"), "");
    await user.selectOptions(within(dialog).getByLabelText("Status"), "lost");
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    expect(
      await within(dialog).findByText(
        "The export could not be prepared. Please try again.",
      ),
    ).toBeTruthy();
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("is for administrators only", async () => {
    mocks.user = { ...ali };
    open("/leads?view=all");
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByRole("button", { name: "Export" })).toBeNull();
  });
});
