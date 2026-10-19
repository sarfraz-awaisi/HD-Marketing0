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
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LeadDetail from "../src/pages/agent/LeadDetail";
import Leads from "../src/pages/admin/Leads";
import { ActivityForm } from "../src/components/common/RecordsPage";
import { LostReasonForm } from "../src/components/leads/LeadStatusControl";
import { ToastProvider } from "../src/components/common/UI";

const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal()),
  api: mocks.api,
}));

const leadId = "30000000-0000-4000-8000-000000000001";
const propertyId = "30000000-0000-4000-8000-000000000002";
const agentId = "30000000-0000-4000-8000-000000000003";
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

let currentLead, saveFailure;
beforeEach(() => {
  vi.clearAllMocks();
  saveFailure = null;
  mocks.auth.user = { id: agentId, name: "Pipeline agent", role: "agent" };
  currentLead = {
    id: leadId,
    name: "Pipeline customer",
    status: "new",
    masked_phone: "+92******123",
    source: "manual",
    budget_min: 0,
    assigned_agent: agentId,
    created_at: "2026-10-08T10:00:00Z",
  };
  mocks.api.mockImplementation(async (path, options) => {
    if (options?.method === "PATCH") {
      if (saveFailure) throw saveFailure;
      currentLead = { ...currentLead, ...options.body };
      return currentLead;
    }
    if (path === "/leads/" + leadId) return currentLead;
    if (path.endsWith("/timeline"))
      return [
        {
          id: "history-1",
          kind: "lead_status_history",
          from_status: "new",
          to_status: "contacted",
          created_at: "2026-10-08T10:00:00Z",
        },
      ];
    if (path === "/users")
      return [
        { id: agentId, name: "Pipeline agent", role: "agent", active: true },
      ];
    if (path.startsWith("/properties"))
      return { data: [{ id: propertyId, title: "Pipeline house" }], count: 1 };
    if (path.startsWith("/leads?")) return { data: [currentLead], count: 1 };
    return { data: [], count: 0 };
  });
});

function workspace(element, detail = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={[detail ? "/leads/" + leadId : "/?view=all"]}
        >
          <Routes>
            <Route path={detail ? "/leads/:id" : "/"} element={element} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe("F1 pipeline screens", () => {
  it.each(["admin", "agent"])(
    "requires a lost reason and saves the lead as %s",
    async (role) => {
      mocks.auth.user.role = role;
      const user = userEvent.setup();
      workspace(<LeadDetail />, true);
      await user.selectOptions(
        await screen.findByLabelText("Lead status"),
        "lost",
      );
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        mocks.api.mock.calls.filter(
          ([, options]) => options?.method === "PATCH",
        ),
      ).toHaveLength(0);
      await user.click(screen.getByText("Save lost reason"));
      expect(
        await screen.findByText("Choose a lost reason"),
      ).toBeInTheDocument();
      await user.selectOptions(
        screen.getByLabelText("Lost reason", { exact: false }),
        "budget",
      );
      await user.type(
        screen.getByLabelText("Lost note", { exact: false }),
        "Outside their budget",
      );
      await user.click(screen.getByText("Save lost reason"));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(mocks.api).toHaveBeenCalledWith("/leads/" + leadId, {
        method: "PATCH",
        body: {
          status: "lost",
          lost_reason: "budget",
          lost_note: "Outside their budget",
        },
      });
      expect(screen.getByLabelText("Lead status")).toHaveValue("lost");
      expect(screen.getByText("Outside their budget")).toBeInTheDocument();
    },
  );

  it("cancels loss without saving or replacing the current stage", async () => {
    const user = userEvent.setup();
    workspace(<LeadDetail />, true);
    await user.selectOptions(
      await screen.findByLabelText("Lead status"),
      "lost",
    );
    await user.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Lead status")).toHaveValue("new");
    expect(
      mocks.api.mock.calls.filter(([, options]) => options?.method === "PATCH"),
    ).toHaveLength(0);
  });

  it("validates the 500-character note limit and shows the current count", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<LostReasonForm onSave={save} />);
    await user.selectOptions(
      screen.getByLabelText("Lost reason", { exact: false }),
      "price",
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "x".repeat(501) },
    });
    await user.click(screen.getByText("Save lost reason"));
    expect(
      await screen.findByText("Use 500 characters or fewer"),
    ).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "x".repeat(500) },
    });
    expect(screen.getByText("500 / 500 characters")).toBeInTheDocument();
    await user.click(screen.getByText("Save lost reason"));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        status: "lost",
        lost_reason: "price",
        lost_note: "x".repeat(500),
      }),
    );
  });

  it("keeps the reason and note available when the server rejects a save", async () => {
    const user = userEvent.setup();
    workspace(<LeadDetail />, true);
    await user.selectOptions(
      await screen.findByLabelText("Lead status"),
      "lost",
    );
    await user.selectOptions(
      screen.getByLabelText("Lost reason", { exact: false }),
      "location",
    );
    await user.type(screen.getByRole("textbox"), "Wants Lahore");
    saveFailure = new Error("Account no longer owns this lead");
    await user.click(screen.getByText("Save lost reason"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Account no longer owns this lead",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toHaveValue("Wants Lahore");
    expect(screen.getByLabelText("Lead status")).toHaveValue("new");
  });

  it("shows stage transitions in the lead timeline with readable labels", async () => {
    workspace(<LeadDetail />, true);
    expect(await screen.findByText("Stage changed")).toBeInTheDocument();
    expect(screen.getByText("New → Contacted")).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: "Site visit scheduled" }),
    ).toHaveValue("visit_scheduled");
    expect(screen.getByRole("option", { name: "Visit done" })).toHaveValue(
      "visit_done",
    );
    expect(
      screen.queryByRole("option", { name: "follow_up" }),
    ).not.toBeInTheDocument();
  });

  it.each(["admin", "agent"])(
    "filters the leads list by lost reason as %s",
    async (role) => {
      mocks.auth.user.role = role;
      const user = userEvent.setup();
      workspace(<Leads />);
      await screen.findByText("Pipeline customer");
      await user.selectOptions(
        screen.getByLabelText("Filter by lost reason"),
        "wrong_number",
      );
      await waitFor(() =>
        expect(mocks.api).toHaveBeenCalledWith(
          expect.stringMatching(/status=lost.*lost_reason=wrong_number/),
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(screen.getByLabelText("Filter by status")).toHaveValue("lost");
      await user.selectOptions(
        screen.getByLabelText("Filter by status"),
        "contacted",
      );
      expect(screen.getByLabelText("Filter by lost reason")).toHaveValue("");
      await waitFor(() =>
        expect(mocks.api).toHaveBeenCalledWith(
          "/leads?page=1&search=&status=contacted",
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
    },
  );

  it("requires a reason for a lost deal before submitting and includes it in the save", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    workspace(<ActivityForm entity="deals" leadId={leadId} onSave={save} />);
    await screen.findByRole("option", { name: "Pipeline house" });
    await user.selectOptions(
      screen.getByLabelText("Property", { exact: false }),
      propertyId,
    );
    await user.selectOptions(
      screen.getByLabelText("Stage", { exact: false }),
      "lost",
    );
    await user.type(
      screen.getByLabelText("Expected / closed value", { exact: false }),
      "100",
    );
    await user.click(screen.getByText("Save record"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose a lost reason",
    );
    expect(save).not.toHaveBeenCalled();
    await user.selectOptions(
      screen.getByLabelText("Lost reason", { exact: false }),
      "bought_elsewhere",
    );
    await user.click(screen.getByText("Save record"));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "lost",
          lost_reason: "bought_elsewhere",
          lead_id: leadId,
          property_id: propertyId,
        }),
      ),
    );
  });
});
