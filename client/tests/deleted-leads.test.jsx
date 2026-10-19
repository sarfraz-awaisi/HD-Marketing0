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
    expect(
      screen.queryByRole("button", { name: /permanent|erase/i }),
    ).not.toBeInTheDocument();
  });
});
