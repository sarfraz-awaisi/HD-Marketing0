import React from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../src/components/common/UI";
import DeleteLeadsDialog from "../src/components/leads/DeleteLeadsDialog";
import DeletedLeads from "../src/pages/admin/DeletedLeads";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
function mount(element) {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <ToastProvider>{element}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  mocks.api.mockReset();
  mocks.api.mockImplementation(async (path) =>
    path === "/leads/delete-preview"
      ? { leads: 20, followups: 3, visits: 2 }
      : path.startsWith("/leads/deleted?")
        ? {
            data: [
              {
                id: "lead",
                lead_no: 123,
                name: "Deleted customer",
                deleted_by_name: "Admin",
                deleted_at: "2026-10-15",
                delete_reason: "Duplicate",
                days_left: 30,
              },
            ],
            count: 1,
          }
        : path === "/deleted-lead-imports"
          ? []
          : { deleted: 20, failed: 0, restored: 1 },
  );
});
describe("deleted lead controls", () => {
  it("requires a reason and DELETE for 20 leads, and cancellation does not mutate data", async () => {
    const user = userEvent.setup(),
      close = vi.fn(),
      done = vi.fn();
    mount(
      <DeleteLeadsDialog ids={["lead"]} onClose={close} onDeleted={done} />,
    );
    await screen.findByText(
      "20 leads · 3 open follow-ups · 2 scheduled visits",
    );
    const button = screen.getByRole("button", {
      name: "Move to Deleted leads",
    });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Delete reason"), "Old inquiries");
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    expect(button).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(close).toHaveBeenCalledOnce();
    expect(
      mocks.api.mock.calls.some(([path]) => path === "/leads/delete"),
    ).toBe(false);
  });
  it("submits one confirmed deletion and blocks duplicate clicks while saving", async () => {
    const user = userEvent.setup(),
      done = vi.fn();
    let resolve;
    mocks.api.mockImplementation(async (path) =>
      path === "/leads/delete-preview"
        ? { leads: 1, followups: 0, visits: 0 }
        : new Promise((r) => {
            resolve = r;
          }),
    );
    mount(
      <DeleteLeadsDialog ids={["lead"]} onClose={() => {}} onDeleted={done} />,
    );
    await screen.findByText("1 leads · 0 open follow-ups · 0 scheduled visits");
    await user.type(screen.getByLabelText("Delete reason"), "Old lead");
    await user.dblClick(
      screen.getByRole("button", { name: "Move to Deleted leads" }),
    );
    expect(
      mocks.api.mock.calls.filter(([p]) => p === "/leads/delete"),
    ).toHaveLength(1);
    resolve({ deleted: 1, failed: 0 });
    await waitFor(() =>
      expect(done).toHaveBeenCalledWith({ deleted: 1, failed: 0 }),
    );
  });
  it("lets an admin choose file-only or file-and-leads deletion", async () => {
    const user = userEvent.setup();
    mount(
      <DeleteLeadsDialog
        file={{ id: "file", file_name: "customers.xls" }}
        onClose={() => {}}
        onDeleted={() => {}}
      />,
    );
    await screen.findByText(
      "20 leads · 3 open follow-ups · 2 scheduled visits",
    );
    await user.selectOptions(
      screen.getByLabelText("Delete mode"),
      "file_and_leads",
    );
    await user.type(screen.getByLabelText("Delete reason"), "Old import");
    await user.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(screen.getByRole("button", { name: "Delete file" }));
    expect(mocks.api).toHaveBeenCalledWith(
      "/lead-imports/file",
      expect.objectContaining({
        method: "DELETE",
        body: { mode: "file_and_leads", reason: "Old import" },
      }),
    );
  });
  it("shows HD numbers and serials in the bin, restores a selection and offers no permanent erase button", async () => {
    const user = userEvent.setup();
    mount(<DeletedLeads />);
    expect(await screen.findByText("HD-000123")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "#" })).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Select Deleted customer" }),
    );
    await user.click(screen.getByRole("button", { name: "Restore selected" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/leads/restore",
        expect.objectContaining({ body: { lead_ids: ["lead"] } }),
      ),
    );
    // Update 069: 14 days to restore.
    expect(screen.getByText(/Restore within 14 days/)).toBeInTheDocument();
  });
  it("deletes the selected leads instantly only after DELETE is typed (update 069)", async () => {
    const user = userEvent.setup();
    mount(<DeletedLeads />);
    await user.click(
      await screen.findByRole("checkbox", { name: "Select Deleted customer" }),
    );
    await user.click(screen.getByRole("button", { name: "Delete instantly" }));
    const dialog = screen.getByRole("dialog", { name: "Delete permanently" });
    expect(dialog).toHaveTextContent("This lead and all its records");
    expect(dialog).toHaveTextContent("This cannot be undone.");
    const button = screen.getByRole("button", {
      name: "Delete lead permanently",
    });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText("Type DELETE to confirm"), "delete");
    expect(button).toBeDisabled();
    await user.clear(screen.getByLabelText("Type DELETE to confirm"));
    await user.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    mocks.api.mockImplementationOnce(async () => ({
      erased: 1,
      failed: 0,
      files_removed: true,
    }));
    await user.click(button);
    expect(mocks.api).toHaveBeenCalledWith(
      "/leads/erase",
      expect.objectContaining({
        method: "POST",
        body: { lead_ids: ["lead"] },
      }),
    );
    expect(
      await screen.findByText("1 permanently deleted"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Delete permanently" }),
    ).not.toBeInTheDocument();
  });
  it("deletes a deleted file's leads instantly, and cancelling changes nothing (update 069)", async () => {
    const user = userEvent.setup();
    const base = mocks.api.getMockImplementation();
    mocks.api.mockImplementation(async (path, options) =>
      path === "/deleted-lead-imports"
        ? [
            {
              id: "file",
              file_name: "October buyers.csv",
              deleted_at: "2026-11-10",
              delete_reason: "Wrong list",
            },
          ]
        : path === "/lead-imports/file/erase"
          ? { erased: 12, failed: 1, files_removed: false }
          : base(path, options),
    );
    mount(<DeletedLeads />);
    await screen.findByText("October buyers.csv");
    await user.click(screen.getByRole("button", { name: "Delete instantly" }));
    expect(
      screen.getByRole("dialog", { name: "Delete permanently" }),
    ).toHaveTextContent(
      "The leads deleted with “October buyers.csv” and all their records",
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mocks.api.mock.calls.some(([path]) => path.endsWith("/erase"))).toBe(
      false,
    );
    await user.click(screen.getByRole("button", { name: "Delete instantly" }));
    await user.type(screen.getByLabelText("Type DELETE to confirm"), "DELETE");
    await user.click(
      screen.getByRole("button", {
        name: "Delete the file's leads permanently",
      }),
    );
    expect(mocks.api).toHaveBeenCalledWith(
      "/lead-imports/file/erase",
      expect.objectContaining({ method: "POST", body: {} }),
    );
    expect(
      await screen.findByText(
        "12 permanently deleted, 1 kept (won deal or no longer here). Some recordings or documents will be removed from storage later.",
      ),
    ).toBeInTheDocument();
  });
});
