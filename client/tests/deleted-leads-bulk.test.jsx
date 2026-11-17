import React from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../src/components/common/UI";
import DeletedLeads from "../src/pages/admin/DeletedLeads";
// Update 071: Select this page, Select all matching deleted leads, and Delete
// instantly for many leads: reviewed by the database first, DELETE typed,
// the number typed too for more than 50, then erased 250 at a time and
// stopped at the first lead kept or request failed. API responses are
// mocked; the server tests check the database.
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
const id = (n) => `71000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const lead = (n) => ({
  id: id(n),
  lead_no: n,
  name: `Buyer ${n}`,
  deleted_by_name: "Admin",
  deleted_at: "2026-11-15",
  delete_reason: "Junk",
  days_left: 12,
});
let total, preview, erase, storage;
// A server storage report (update 071): removed now, still waiting.
const storageReport = (removed = {}, pending = {}, failed = false) => {
  const left = { recordings: 0, documents: 0, more: false, ...pending };
  return {
    removed: { recordings: 0, documents: 0, ...removed },
    pending: left,
    failed,
    done: !failed && !left.recordings && !left.documents,
  };
};
function mount() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <ToastProvider>
          <DeletedLeads />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const review = (ids, extra = {}) => ({
  selected: ids.length,
  eligible: ids.length,
  eligible_ids: ids,
  won_deal: 0,
  not_in_bin: 0,
  missing: 0,
  records: {
    calls: 7,
    recordings: 2,
    notes: 3,
    followups: 1,
    visits: 1,
    deals: 0,
    documents: 1,
  },
  sheet_leads: 0,
  erased_today: 0,
  alert_over: 50,
  ...extra,
});
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  total = 45;
  preview = (ids) => review(ids);
  erase = (ids) => ({
    erased: ids.length,
    failed: 0,
    results: ids.map((x) => ({ id: x, result: "erased" })),
    files_removed: true,
    storage: storageReport(),
  });
  storage = { recordings: 0, documents: 0, more: false };
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path, options) => {
    if (path.startsWith("/leads/deleted/selection?")) {
      const search = new URLSearchParams(path.split("?")[1]).get("search");
      const count = search ? 2 : total;
      return {
        count,
        limit: 2000,
        ids: Array.from({ length: Math.min(count, 2000) }, (_, i) => id(i + 1)),
      };
    }
    if (path.startsWith("/leads/deleted?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const count = q.get("search") ? 2 : total;
      const first = (Number(q.get("page")) - 1) * 20 + 1;
      return {
        data: Array.from(
          { length: Math.max(0, Math.min(20, count - first + 1)) },
          (_, i) => lead(first + i),
        ),
        count,
      };
    }
    if (path === "/deleted-lead-imports") return [];
    if (path === "/leads/erase/preview") return preview(options.body.lead_ids);
    if (path === "/leads/erase") return erase(options.body.lead_ids);
    if (path === "/leads/erase/storage") return { pending: storage };
    if (path === "/leads/restore")
      return { restored: options.body.lead_ids.length, failed: 0 };
    throw new Error("Unexpected " + path);
  });
});
const calls = (path) =>
  mocks.api.mock.calls.filter(([p]) => p === path).map(([, o]) => o.body);
const bar = () =>
  screen.findByRole("toolbar", { name: "Selected deleted leads" });

describe("Select all in Deleted leads (update 071)", () => {
  it("selects one, this page or every matching lead, counts exactly, and clears", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("checkbox", { name: "Select Buyer 1" }),
    );
    expect(await bar()).toHaveTextContent("1 lead selected");
    await user.click(
      screen.getByRole("button", { name: "Select this page (20)" }),
    );
    expect(await bar()).toHaveTextContent("20 leads selected");
    await user.click(
      screen.getByRole("button", {
        name: "Select all 45 matching deleted leads",
      }),
    );
    expect(await bar()).toHaveTextContent(
      "All 45 matching deleted leads selected",
    );
    // Selected across pages: page 2 shows its leads checked.
    await user.click(screen.getByRole("button", { name: /next/i }));
    expect(
      await screen.findByRole("checkbox", { name: "Select Buyer 21" }),
    ).toBeChecked();
    // Unchecking one makes it a chosen set.
    await user.click(screen.getByRole("checkbox", { name: "Select Buyer 21" }));
    expect(await bar()).toHaveTextContent("44 leads selected");
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(
      screen.queryByRole("toolbar", { name: "Selected deleted leads" }),
    ).not.toBeInTheDocument();
  });

  it("clears the selection when the search changes, and selects only what the new search matches", async () => {
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", {
        name: "Select all 45 matching deleted leads",
      }),
    );
    expect(await bar()).toHaveTextContent("All 45");
    await user.type(screen.getByLabelText("Search deleted leads"), "Buyer 1");
    expect(
      screen.queryByRole("toolbar", { name: "Selected deleted leads" }),
    ).not.toBeInTheDocument();
    // Back to the first search: the old selection does not come back.
    await user.clear(screen.getByLabelText("Search deleted leads"));
    await screen.findByRole("button", {
      name: "Select all 45 matching deleted leads",
    });
    expect(
      screen.queryByRole("toolbar", { name: "Selected deleted leads" }),
    ).not.toBeInTheDocument();
    await user.type(screen.getByLabelText("Search deleted leads"), "Buyer 1");
    await user.click(
      await screen.findByRole("button", {
        name: "Select all 2 matching deleted leads",
      }),
    );
    expect(await bar()).toHaveTextContent(
      "All 2 matching deleted leads selected (search “Buyer 1”)",
    );
    expect(
      mocks.api.mock.calls.some(
        ([p]) => p === "/leads/deleted/selection?search=Buyer+1",
      ),
    ).toBe(true);
  });

  it("asks for a narrower search over 2,000 matching leads", async () => {
    total = 2500;
    mount();
    expect(
      await screen.findByText(/Narrow your search to select all matching/),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Select all .* matching/ }),
    ).not.toBeInTheDocument();
  });

  it("restores a large selection 500 at a time", async () => {
    total = 1200;
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", {
        name: "Select all 1,200 matching deleted leads",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Restore selected" }));
    await waitFor(() =>
      expect(calls("/leads/restore").map((b) => b.lead_ids.length)).toEqual([
        500, 500, 200,
      ]),
    );
    expect(await screen.findByText("1200 restored")).toBeInTheDocument();
  });
});

describe("Delete instantly for many leads (update 071)", () => {
  async function openDialog(n) {
    total = n;
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", {
        name: `Select all ${n.toLocaleString("en-US")} matching deleted leads`,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Delete instantly" }));
    const dialog = screen.getByRole("dialog", { name: "Delete permanently" });
    await within(dialog).findByText(/will be deleted permanently/);
    return { user, dialog };
  }
  it("shows the review, needs DELETE and the number, and erases 250 at a time", async () => {
    preview = (ids) =>
      review(ids.slice(3), {
        selected: ids.length,
        won_deal: 2,
        not_in_bin: 1,
        sheet_leads: 4,
        erased_today: 10,
      });
    const { user, dialog } = await openDialog(603);
    expect(calls("/leads/erase/preview")[0].lead_ids).toHaveLength(603);
    expect(dialog).toHaveTextContent(
      "600 leads will be deleted permanently (of the 603 selected)",
    );
    for (const text of [
      "7 calls",
      "2 call recordings",
      "3 notes",
      "1 follow-up",
      "1 site visit",
      "0 deals",
      "1 KYC document",
      "3 selected leads will not be deleted: 2 with a won deal, 1 restored since they were selected",
      "4 leads came from Google Sheets",
      "raise a security alert",
      "This cannot be undone",
    ])
      expect(dialog).toHaveTextContent(text);
    const next = within(dialog).getByRole("button", { name: "Continue" });
    expect(next).toBeDisabled();
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(next);
    // The second step, for the scale.
    expect(dialog).toHaveTextContent(
      "You are about to delete 600 leads permanently.",
    );
    const go = within(dialog).getByRole("button", {
      name: "Delete 600 leads permanently",
    });
    await user.type(
      within(dialog).getByLabelText("Type the number of leads to confirm"),
      "60",
    );
    expect(go).toBeDisabled();
    expect(calls("/leads/erase")).toHaveLength(0);
    await user.type(
      within(dialog).getByLabelText("Type the number of leads to confirm"),
      "0",
    );
    await user.click(go);
    expect(
      await screen.findByText("600 permanently deleted"),
    ).toBeInTheDocument();
    expect(calls("/leads/erase").map((b) => b.lead_ids.length)).toEqual([
      250, 250, 100,
    ]);
    // Only the leads the review found can be erased are sent.
    expect(calls("/leads/erase").flatMap((b) => b.lead_ids)).toEqual(
      Array.from({ length: 600 }, (_, i) => id(i + 4)),
    );
  });

  it("stops at a lead that can no longer be erased and says what was done and left", async () => {
    let batch = 0;
    erase = (ids) =>
      ++batch === 2
        ? {
            erased: ids.length - 1,
            failed: 1,
            results: ids.map((x, i) =>
              i === 0
                ? { id: x, result: "failed", reason: "Not in Deleted leads" }
                : { id: x, result: "erased" },
            ),
            files_removed: true,
          }
        : {
            erased: ids.length,
            failed: 0,
            results: ids.map((x) => ({ id: x, result: "erased" })),
            files_removed: true,
          };
    const { user, dialog } = await openDialog(600);
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(within(dialog).getByRole("button", { name: "Continue" }));
    await user.type(
      within(dialog).getByLabelText("Type the number of leads to confirm"),
      "600",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Delete 600 leads permanently",
      }),
    );
    const done = await screen.findByRole("dialog", {
      name: "Delete permanently: finished",
    });
    expect(calls("/leads/erase")).toHaveLength(2);
    expect(done).toHaveTextContent(
      "499 leads permanently deleted from the CRM database.",
    );
    expect(done).toHaveTextContent("1 lead kept: Not in Deleted leads (1).");
    expect(done).toHaveTextContent(
      "100 leads not attempted after the stop. They are still in Deleted leads.",
    );
    await user.click(within(done).getByRole("button", { name: "Done" }));
    expect(
      await screen.findByText(
        "499 permanently deleted, 1 kept (won deal or no longer here), 100 not deleted: check Deleted leads",
      ),
    ).toBeInTheDocument();
  });

  it("checks again after a failed request instead of guessing", async () => {
    erase = async () => {
      throw new Error("The lead operation could not be completed.");
    };
    // Checked again: the database erased none of them.
    const first = preview;
    let checks = 0;
    preview = (ids) => (++checks === 1 ? first(ids) : review(ids));
    const { user, dialog } = await openDialog(20);
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Delete 20 leads permanently",
      }),
    );
    const done = await screen.findByRole("dialog", {
      name: "Delete permanently: finished",
    });
    expect(calls("/leads/erase/preview")).toHaveLength(2);
    expect(done).toHaveTextContent(
      "0 leads permanently deleted from the CRM database.",
    );
    expect(done).toHaveTextContent(
      "20 leads not deleted: The lead operation could not be completed. They are still in Deleted leads.",
    );
  });

  it("cancels without erasing, and a double click erases once", async () => {
    let { user, dialog } = await openDialog(3);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(calls("/leads/erase")).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "Delete instantly" }));
    dialog = screen.getByRole("dialog", { name: "Delete permanently" });
    await within(dialog).findByText(/will be deleted permanently/);
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.dblClick(
      within(dialog).getByRole("button", {
        name: "Delete 3 leads permanently",
      }),
    );
    await screen.findByText("3 permanently deleted");
    expect(calls("/leads/erase")).toHaveLength(1);
  });

  it("says when nothing selected can be erased", async () => {
    preview = (ids) =>
      review([], {
        selected: ids.length,
        eligible: 0,
        won_deal: 1,
        not_in_bin: 1,
      });
    total = 2;
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", {
        name: "Select all 2 matching deleted leads",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Delete instantly" }));
    expect(
      await screen.findByText(/None of the 2 selected leads can be deleted/),
    ).toHaveTextContent("1 has a won deal, 1 restored since");
    expect(
      screen.queryByLabelText("Type DELETE to confirm"),
    ).not.toBeInTheDocument();
  });
});

describe("Delete instantly: files in storage (update 071)", () => {
  async function erase3() {
    total = 3;
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", {
        name: "Select all 3 matching deleted leads",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Delete instantly" }));
    const dialog = screen.getByRole("dialog", { name: "Delete permanently" });
    await within(dialog).findByText(/will be deleted permanently/);
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Delete 3 leads permanently",
      }),
    );
    return {
      user,
      done: await screen.findByRole("dialog", {
        name: "Delete permanently: finished",
      }),
    };
  }
  it("never says all is gone while files wait in storage, and says how they will go", async () => {
    erase = (ids) => ({
      erased: ids.length,
      failed: 0,
      results: ids.map((x) => ({ id: x, result: "erased" })),
      files_removed: false,
      storage: storageReport(
        { recordings: 2000, documents: 1 },
        { recordings: 100, documents: 2, more: true },
      ),
    });
    const { user, done } = await erase3();
    expect(done).toHaveTextContent(
      "3 leads permanently deleted from the CRM database.",
    );
    expect(done).toHaveTextContent(
      "Removed from storage now: 2,000 call recordings and 1 KYC file.",
    );
    expect(done).toHaveTextContent(
      "Still waiting to be removed from storage: 102 or more files (100 call recordings, 2 KYC files), counting any left from earlier deletions.",
    );
    expect(done).toHaveTextContent(
      "While that job is off, they stay in storage until then, or until an approved clean-up is run.",
    );
    expect(done).not.toHaveTextContent("No files are left to remove");
    await user.click(within(done).getByRole("button", { name: "Done" }));
    expect(
      await screen.findByText(
        "3 permanently deleted. 102 or more storage files still waiting to be removed",
      ),
    ).toBeInTheDocument();
  });

  it("says when Storage failed", async () => {
    erase = (ids) => ({
      erased: ids.length,
      failed: 0,
      results: ids.map((x) => ({ id: x, result: "erased" })),
      files_removed: false,
      storage: storageReport(
        { recordings: 4 },
        { recordings: 6, documents: 1 },
        true,
      ),
    });
    const { done } = await erase3();
    expect(done).toHaveTextContent(
      "Storage reported an error, so removal stopped. The files not removed stay queued.",
    );
    expect(done).toHaveTextContent(
      "Still waiting to be removed from storage: 7 files",
    );
  });

  it("after a lost answer, reports the leads the database erased and the files the queue still holds", async () => {
    erase = async () => {
      throw new Error("Network connection lost");
    };
    // Checked again: the database had erased all three.
    const first = preview;
    let checks = 0;
    preview = (ids) =>
      ++checks === 1
        ? first(ids)
        : review([], {
            selected: ids.length,
            eligible: 0,
            missing: ids.length,
          });
    storage = { recordings: 3, documents: 0, more: false };
    const { done } = await erase3();
    expect(calls("/leads/erase/preview")).toHaveLength(2);
    expect(
      mocks.api.mock.calls.filter(([p]) => p === "/leads/erase/storage"),
    ).toHaveLength(1);
    expect(done).toHaveTextContent(
      "3 leads permanently deleted from the CRM database.",
    );
    expect(done).toHaveTextContent(
      "Still waiting to be removed from storage: 3 files (3 call recordings, 0 KYC files)",
    );
    expect(done).not.toHaveTextContent("not deleted");
  });

  it("knows a refused request deleted nothing, without checking again", async () => {
    erase = async () => {
      throw Object.assign(
        new Error(
          "Too many changes in a short time. Wait a minute and try again.",
        ),
        { status: 429 },
      );
    };
    const { done } = await erase3();
    expect(done).toHaveTextContent(
      "0 leads permanently deleted from the CRM database.",
    );
    expect(done).toHaveTextContent(
      "3 leads not deleted: Too many changes in a short time. Wait a minute and try again. They are still in Deleted leads.",
    );
    expect(calls("/leads/erase/preview")).toHaveLength(1);
    expect(
      mocks.api.mock.calls.some(([p]) => p === "/leads/erase/storage"),
    ).toBe(false);
  });

  it("says it cannot confirm the files when the queue cannot be checked either", async () => {
    erase = async () => {
      throw new Error("Network connection lost");
    };
    const first = preview;
    let checks = 0;
    preview = (ids) =>
      ++checks === 1
        ? first(ids)
        : review([], {
            selected: ids.length,
            eligible: 0,
            missing: ids.length,
          });
    const base = mocks.api.getMockImplementation();
    mocks.api.mockImplementation(async (path, options) => {
      if (path === "/leads/erase/storage")
        throw new Error("The storage clean-up queue could not be checked.");
      return base(path, options);
    });
    const { done } = await erase3();
    expect(done).toHaveTextContent(
      "Whether every file has left storage could not be confirmed.",
    );
  });

  it("closes by itself only when every file is gone", async () => {
    erase = (ids) => ({
      erased: ids.length,
      failed: 0,
      results: ids.map((x) => ({ id: x, result: "erased" })),
      files_removed: true,
      storage: storageReport({ recordings: 5 }),
    });
    total = 3;
    const user = userEvent.setup();
    mount();
    await user.click(
      await screen.findByRole("button", {
        name: "Select all 3 matching deleted leads",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Delete instantly" }));
    const dialog = screen.getByRole("dialog", { name: "Delete permanently" });
    await within(dialog).findByText(/will be deleted permanently/);
    await user.type(
      within(dialog).getByLabelText("Type DELETE to confirm"),
      "DELETE",
    );
    await user.click(
      within(dialog).getByRole("button", {
        name: "Delete 3 leads permanently",
      }),
    );
    expect(
      await screen.findByText("3 permanently deleted"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: /Delete permanently/ }),
    ).not.toBeInTheDocument();
  });
});
