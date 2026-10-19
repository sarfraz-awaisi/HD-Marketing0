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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import Leads from "../src/pages/admin/Leads";
import { ToastProvider } from "../src/components/common/UI";

const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
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
  mocks.auth.user = { id: "admin-id", name: "Administrator", role: "admin" };
  mocks.api.mockImplementation(async (path) =>
    path === "/leads/import"
      ? {
          format: "xlsx",
          worksheet: "Leads",
          rows: [
            { row: 2, id: "lead-id", success: true },
            { row: 4, success: false, error: "Duplicate phone" },
          ],
        }
      : { data: [], count: 0 },
  );
});
function workspace() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <Leads />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const uploads = () =>
  mocks.api.mock.calls.filter(([path]) => path === "/leads/import");
const defaultColumns = [
  { index: 0, label: "Full Name", suggested: "name" },
  { index: 1, label: "Mobile Number", suggested: "phone" },
  { index: 2, label: "Notes", suggested: null },
];
const matchingError = (columns = defaultColumns) =>
  Object.assign(new Error("Unsupported column name"), {
    code: "IMPORT_COLUMNS_REQUIRED",
    columns,
  });
function requireColumnMatching(columns = defaultColumns) {
  const original = mocks.api.getMockImplementation();
  mocks.api.mockImplementation(async (path, options) => {
    if (path === "/leads/import" && !options.body.has("mapping"))
      throw matchingError(columns);
    const result = await original(path, options);
    return path === "/leads/import"
      ? { ...result, ignored_columns: ["Notes"] }
      : result;
  });
}

describe("lead file picker", () => {
  it("shows successful imports with agent warnings separately from rejected fields", async () => {
    const original = mocks.api.getMockImplementation();
    const warning =
      "Agent was not found among active agents; lead left unassigned. Assign it from Leads.";
    mocks.api.mockImplementation(async (path, options) =>
      path === "/leads/import"
        ? {
            format: "xlsx",
            worksheet: "Leads",
            rows: [
              { row: 2, id: "lead-id", success: true, warnings: [warning] },
              {
                row: 3,
                success: false,
                error: "Email must be a valid email address or blank.",
              },
            ],
          }
        : original(path, options),
    );
    const user = userEvent.setup();
    workspace();
    await user.upload(
      screen.getByLabelText("Import CSV or Excel leads"),
      new File(["workbook"], "leads.xlsx"),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Lead import results",
    });
    expect(
      within(dialog).getByText("1 imported · 1 rejected"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/1 imported with warnings/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Imported · " + warning),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Email must be a valid email address or blank."),
    ).toBeInTheDocument();
  });
  it("matches or skips extra columns through the same picker and reports skipped columns", async () => {
    requireColumnMatching();
    const user = userEvent.setup();
    workspace();
    const file = new File(["workbook"], "leads.xlsx");
    await user.upload(screen.getByLabelText("Import CSV or Excel leads"), file);
    const dialog = await screen.findByRole("dialog", {
      name: "Match file columns",
    });
    expect(
      within(dialog).getByRole("combobox", {
        name: "Match column 1: Full Name",
      }),
    ).toHaveValue("name");
    expect(
      within(dialog).getByRole("combobox", {
        name: "Match column 2: Mobile Number",
      }),
    ).toHaveValue("phone");
    expect(
      within(dialog).getByRole("combobox", { name: "Match column 3: Notes" }),
    ).toHaveValue("");
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(uploads()).toHaveLength(1);
    await user.click(
      within(dialog).getByRole("button", { name: "Import leads" }),
    );
    await screen.findByRole("dialog", { name: "Lead import results" });
    expect(uploads()).toHaveLength(2);
    const body = uploads()[1][1].body;
    expect(body.get("file")).toBe(file);
    expect(JSON.parse(body.get("mapping"))).toEqual({ name: 0, phone: 1 });
    expect(screen.getByText("Skipped columns: Notes")).toBeInTheDocument();
  });
  it("requires name and phone mappings and prevents assigning one field to two columns", async () => {
    requireColumnMatching([
      { index: 0, label: "Purchaser", suggested: null },
      { index: 1, label: "Reach me", suggested: null },
      { index: 2, label: "Neighborhood", suggested: null },
    ]);
    const user = userEvent.setup();
    workspace();
    await user.upload(
      screen.getByLabelText("Import CSV or Excel leads"),
      new File(["csv"], "leads.csv"),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Match file columns",
    });
    const submit = within(dialog).getByRole("button", { name: "Import leads" });
    await user.click(submit);
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Match customer name and phone number",
    );
    expect(uploads()).toHaveLength(1);
    await user.selectOptions(
      within(dialog).getByRole("combobox", {
        name: "Match column 1: Purchaser",
      }),
      "name",
    );
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    await user.selectOptions(
      within(dialog).getByRole("combobox", {
        name: "Match column 2: Reach me",
      }),
      "phone",
    );
    const location = within(dialog).getByRole("combobox", {
      name: "Match column 3: Neighborhood",
    });
    expect(
      within(location).getByRole("option", {
        name: "Phone number (required) (matched to column 2)",
      }),
    ).toBeDisabled();
    expect(
      within(location).getByRole("option", {
        name: "Customer name (required) (matched to column 1)",
      }),
    ).toBeDisabled();
    await user.selectOptions(location, "phone");
    expect(location).toHaveValue("");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    for (const select of within(dialog).getAllByRole("combobox"))
      expect(
        within(select).getByRole("option", { name: "Skip column" }),
      ).toBeEnabled();
    expect(uploads()).toHaveLength(1);
    await user.selectOptions(location, "preferred_location");
    await user.click(submit);
    await screen.findByRole("dialog", { name: "Lead import results" });
    expect(JSON.parse(uploads()[1][1].body.get("mapping"))).toEqual({
      name: 0,
      phone: 1,
      preferred_location: 2,
    });
  });
  it("releases a matched field when its column is skipped so it can be moved", async () => {
    requireColumnMatching([
      { index: 0, label: "Name", suggested: "name" },
      { index: 1, label: "Phone", suggested: "phone" },
      { index: 2, label: "Mobile", suggested: "phone" },
    ]);
    const user = userEvent.setup();
    workspace();
    await user.upload(
      screen.getByLabelText("Import CSV or Excel leads"),
      new File(["csv"], "leads.csv"),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Match file columns",
    });
    const phone = within(dialog).getByRole("combobox", {
      name: "Match column 2: Phone",
    });
    const mobile = within(dialog).getByRole("combobox", {
      name: "Match column 3: Mobile",
    });
    await user.selectOptions(phone, "phone");
    expect(
      within(phone).getByRole("option", { name: "Phone number (required)" }),
    ).toBeEnabled();
    expect(
      within(mobile).getByRole("option", {
        name: "Phone number (required) (matched to column 2)",
      }),
    ).toBeDisabled();
    await user.selectOptions(phone, "");
    expect(
      within(mobile).getByRole("option", { name: "Phone number (required)" }),
    ).toBeEnabled();
    await user.selectOptions(mobile, "phone");
    expect(phone).toHaveValue("");
    expect(mobile).toHaveValue("phone");
    expect(
      within(phone).getByRole("option", {
        name: "Phone number (required) (matched to column 3)",
      }),
    ).toBeDisabled();
    await user.click(
      within(dialog).getByRole("button", { name: "Import leads" }),
    );
    await screen.findByRole("dialog", { name: "Lead import results" });
    expect(JSON.parse(uploads()[1][1].body.get("mapping"))).toEqual({
      name: 0,
      phone: 2,
    });
  });
  it("rejects a conflicting change with the field and owning column identified", async () => {
    requireColumnMatching();
    const user = userEvent.setup();
    workspace();
    await user.upload(
      screen.getByLabelText("Import CSV or Excel leads"),
      new File(["csv"], "leads.csv"),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Match file columns",
    });
    const extra = within(dialog).getByRole("combobox", {
      name: "Match column 3: Notes",
    });
    fireEvent.change(extra, { target: { value: "phone" } });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Phone number (required) is already matched to column 2: Mobile Number. Set that column to Skip column before using it here.",
    );
    expect(extra).toHaveValue("");
    expect(
      within(dialog).getByRole("combobox", {
        name: "Match column 2: Mobile Number",
      }),
    ).toHaveValue("phone");
    expect(uploads()).toHaveLength(1);
    await user.selectOptions(extra, "preferred_location");
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
  });
  it("cancels column matching without submitting an import and lets the same file be chosen again", async () => {
    requireColumnMatching();
    const user = userEvent.setup();
    workspace();
    const input = screen.getByLabelText("Import CSV or Excel leads");
    const file = new File(["workbook"], "leads.xls");
    await user.upload(input, file);
    const dialog = await screen.findByRole("dialog", {
      name: "Match file columns",
    });
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(input).toHaveValue("");
    expect(uploads()).toHaveLength(1);
    await user.upload(input, file);
    await screen.findByRole("dialog", { name: "Match file columns" });
    expect(uploads()).toHaveLength(2);
  });
  it("does not guess between duplicate phone headings", async () => {
    requireColumnMatching([
      { index: 0, label: "Name", suggested: "name" },
      { index: 1, label: "Phone", suggested: "phone" },
      { index: 2, label: "Mobile", suggested: "phone" },
    ]);
    const user = userEvent.setup();
    workspace();
    await user.upload(
      screen.getByLabelText("Import CSV or Excel leads"),
      new File(["csv"], "leads.csv"),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Match file columns",
    });
    for (const name of ["Match column 2: Phone", "Match column 3: Mobile"])
      expect(within(dialog).getByRole("combobox", { name })).toHaveValue("");
    await user.click(
      within(dialog).getByRole("button", { name: "Import leads" }),
    );
    expect(uploads()).toHaveLength(1);
  });
  it("retains the mapping after a failed import and blocks dismissal while uploading", async () => {
    const original = mocks.api.getMockImplementation();
    let rejectImport;
    let matchedAttempts = 0;
    mocks.api.mockImplementation((path, options) => {
      if (path !== "/leads/import") return original(path, options);
      if (!options.body.has("mapping")) return Promise.reject(matchingError());
      matchedAttempts++;
      return matchedAttempts === 1
        ? new Promise((_, reject) => {
            rejectImport = reject;
          })
        : original(path, options);
    });
    const user = userEvent.setup();
    workspace();
    await user.upload(
      screen.getByLabelText("Import CSV or Excel leads"),
      new File(["xlsx"], "leads.xlsx"),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Match file columns",
    });
    await user.click(
      within(dialog).getByRole("button", { name: "Import leads" }),
    );
    expect(
      within(dialog).getByRole("button", { name: "Importing…" }),
    ).toBeDisabled();
    expect(
      within(dialog).getByRole("button", { name: "Cancel" }),
    ).toBeDisabled();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    await user.click(
      within(dialog).getByRole("button", { name: "Close dialog" }),
    );
    expect(dialog).toBeInTheDocument();
    rejectImport(new Error("The CRM server could not be reached."));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "could not be reached",
    );
    expect(
      within(dialog).getByRole("combobox", {
        name: "Match column 1: Full Name",
      }),
    ).toHaveValue("name");
    await user.click(
      within(dialog).getByRole("button", { name: "Import leads" }),
    );
    await screen.findByRole("dialog", { name: "Lead import results" });
    expect(matchedAttempts).toBe(2);
  });
  it.each([
    ["leads.csv", "text/csv"],
    [
      "leads.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ],
    ["leads.xls", "application/vnd.ms-excel"],
  ])(
    "uploads %s as multipart data and shows row results",
    async (filename, type) => {
      const user = userEvent.setup();
      workspace();
      const input = screen.getByLabelText("Import CSV or Excel leads");
      const file = new File(["file content"], filename, { type });
      await user.upload(input, file);
      expect(uploads()).toHaveLength(1);
      expect(uploads()[0][1].method).toBe("POST");
      expect(uploads()[0][1].body.get("file")).toBe(file);
      const dialog = await screen.findByRole("dialog", {
        name: "Lead import results",
      });
      expect(
        within(dialog).getByText("1 imported · 1 rejected"),
      ).toBeInTheDocument();
      expect(
        within(dialog).getByText("XLSX · Worksheet: Leads"),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("File row")).toBeInTheDocument();
      expect(within(dialog).getByText("4")).toBeInTheDocument();
      expect(within(dialog).getByText("Duplicate phone")).toBeInTheDocument();
      expect(input).toHaveValue("");
    },
  );
  it("opens the native file chooser from a keyboard-accessible button", async () => {
    const user = userEvent.setup();
    workspace();
    const input = screen.getByLabelText("Import CSV or Excel leads");
    const choose = vi.spyOn(input, "click");
    screen.getByRole("button", { name: "Import CSV / Excel" }).focus();
    await user.keyboard("{Enter}");
    expect(choose).toHaveBeenCalledOnce();
    for (const extension of [".csv", ".xlsx", ".xls"])
      expect(input.accept).toContain(extension);
  });
  it("blocks unsupported formats and files over 5 MB without uploading", async () => {
    const user = userEvent.setup({ applyAccept: false });
    workspace();
    const input = screen.getByLabelText("Import CSV or Excel leads");
    await user.upload(
      input,
      new File(["text"], "leads.pdf", { type: "application/pdf" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a .csv, .xlsx or .xls file.",
    );
    await user.upload(
      input,
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], "leads.xlsx"),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("5 MB");
    expect(uploads()).toHaveLength(0);
    expect(input).toHaveValue("");
  });
  it("disables repeated imports while pending and allows retrying the same file after an error", async () => {
    let rejectUpload;
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path) =>
      path === "/leads/import"
        ? new Promise((_, reject) => {
            rejectUpload = reject;
          })
        : original(path),
    );
    const user = userEvent.setup();
    workspace();
    const input = screen.getByLabelText("Import CSV or Excel leads");
    const file = new File(["xlsx"], "leads.xlsx");
    await user.upload(input, file);
    expect(screen.getByRole("button", { name: "Importing…" })).toBeDisabled();
    expect(input).toBeDisabled();
    fireEvent.change(input, { target: { files: [file] } });
    expect(uploads()).toHaveLength(1);
    rejectUpload(
      new Error("The header row must include name and phone columns."),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "name and phone",
    );
    expect(input).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Import CSV / Excel" }),
    ).toBeEnabled();
    mocks.api.mockImplementation(original);
    await user.upload(input, file);
    await screen.findByRole("dialog", { name: "Lead import results" });
    expect(uploads()).toHaveLength(2);
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });
  it("hides the importer from agents", () => {
    mocks.auth.user.role = "agent";
    workspace();
    expect(
      screen.queryByRole("button", { name: "Import CSV / Excel" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("Import CSV or Excel leads"),
    ).not.toBeInTheDocument();
  });
});
