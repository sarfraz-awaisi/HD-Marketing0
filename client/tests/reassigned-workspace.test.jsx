import React from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import { WorkspaceBadges } from "../src/components/leads/LeadCells";
import { firstCallState } from "../src/lib/firstCall";
// Update 061: what an agent sees of a lead reassigned to them. API responses
// are mocked; the server tests check what the database leaves out.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const sara = {
  id: "61000000-0000-4000-8000-000000000003",
  role: "agent",
  name: "Sara Agent",
};
const id = "61000000-0000-4000-8000-0000000000a1";
const lead = (extra = {}) => ({
  id,
  lead_no: 4501,
  name: "Hamza Buyer",
  email: null,
  assigned_agent: sara.id,
  phone: "+923001234567",
  status: "new",
  source: "CSV",
  budget_min: 0,
  budget_max: null,
  created_at: "2026-11-01T10:00:00Z",
  last_activity_at: "2026-11-12T09:00:00Z",
  assigned_at: "2026-11-12T09:00:00Z",
  call_due_at: "2099-11-12T11:00:00Z",
  first_call_at: null,
  reassigned: true,
  reassigned_at: "2026-11-12T09:00:00Z",
  previous_result: null,
  first_call_reopened: false,
  contact: "none",
  last_call_at: null,
  ...extra,
});
let current, timeline;
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { ...sara };
  current = lead();
  timeline = [];
  mocks.api.mockImplementation(async (path) => {
    if (path.startsWith("/my-leads?"))
      return { data: [current], count: 1, page: 1, limit: 20 };
    if (path === `/leads/${id}/timeline`) return timeline;
    if (path === `/leads/${id}`) return current;
    if (path === "/call-capabilities") return { manual: true, mock: false };
    if (path.startsWith("/followups?"))
      return {
        data: [
          {
            id: "61000000-0000-4000-8000-0000000000f1",
            lead_id: id,
            leads: { lead_no: 4501, name: "Hamza Buyer" },
            due_at: "2099-11-14T10:00:00Z",
            status: "pending",
            notes: null,
            carried_over: true,
          },
        ],
        count: 1,
      };
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
const flags = (container) =>
  [...container.querySelectorAll(".workspace-flag")].map((f) => f.textContent);

describe("the indicators", () => {
  it("show Reassigned for the whole assignment, New and the earlier result only before the first call", () => {
    const shown = (extra) =>
      flags(render(<WorkspaceBadges lead={lead(extra)} />).container);
    expect(shown({})).toEqual(["Reassigned", "New"]);
    expect(shown({ previous_result: "not_interested" })).toEqual([
      "Reassigned",
      "New",
      "Previously not interested",
    ]);
    expect(
      shown({
        previous_result: "not_interested",
        first_call_at: "2026-11-12T10:00:00Z",
      }),
    ).toEqual(["Reassigned"]);
    expect(shown({ reassigned: false })).toEqual([]);
  });
  it("put a reassigned Lost lead in the first-call workflow, and no other Lost lead", () => {
    const now = Date.parse("2026-11-12T10:00:00Z");
    expect(
      firstCallState(
        { ...lead(), status: "lost", first_call_reopened: true },
        now,
      ),
    ).toMatchObject({ tone: "warning" });
    expect(firstCallState({ ...lead(), status: "lost" }, now)).toBeNull();
  });
});

describe("a reassigned lead for its new agent", () => {
  it("lists it as Reassigned and New, and filters by it", async () => {
    const user = userEvent.setup();
    const { container } = open("/leads?view=all");
    await screen.findByText("Hamza Buyer");
    expect(flags(container)).toEqual(["Reassigned", "New"]);
    expect(screen.getByText("Not called yet")).toBeInTheDocument();
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Filter by assignment" }),
      "reassigned",
    );
    expect(
      mocks.api.mock.calls.some(([path]) =>
        path.includes("assignment=reassigned"),
      ),
    ).toBe(true);
    // The choice, and the active filter that clears it.
    expect(screen.getAllByText("Reassigned to me")).toHaveLength(2);
  });
  it("opens a fresh workspace, with carried-over commitments first", async () => {
    current = lead({ previous_result: "not_interested" });
    timeline = [
      {
        kind: "assignments",
        id: "a1",
        lead_id: id,
        agent_id: sara.id,
        agent_name: "Sara Agent",
        actor_name: "Owner",
        created_at: "2026-11-12T09:00:00Z",
      },
      {
        kind: "followups",
        id: "f1",
        lead_id: id,
        due_at: "2099-11-14T10:00:00Z",
        status: "pending",
        notes: null,
        carried_over: true,
        agent_name: "Sara Agent",
        created_at: "2026-11-10T09:00:00Z",
      },
    ];
    const { container } = open(`/leads/${id}`);
    expect(
      await screen.findByRole("heading", { name: /Your current assignment/ }),
    ).toBeInTheDocument();
    expect(flags(container)).toEqual([
      "Reassigned",
      "New",
      "Previously not interested",
    ]);
    expect(
      screen.getByText("No notes added during your current assignment."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Activity from earlier assignments is kept/),
    ).toBeInTheDocument();
    const carried = screen
      .getByRole("heading", {
        name: "Carried over from the previous assignment",
      })
      .closest(".carried-over");
    expect(within(carried).getByText("Follow-up")).toBeInTheDocument();
    expect(
      within(carried).getByText("Carried over from an earlier assignment"),
    ).toBeInTheDocument();
  });
  it("shows the agent's own notes once added", async () => {
    timeline = [
      {
        kind: "notes",
        id: "n1",
        lead_id: id,
        body: "Sara: wants 10 marla",
        actor_name: "Sara Agent",
        created_at: "2026-11-12T10:00:00Z",
      },
    ];
    open(`/leads/${id}`);
    expect(await screen.findByText("Sara: wants 10 marla")).toBeInTheDocument();
    expect(
      screen.queryByText("No notes added during your current assignment."),
    ).toBeNull();
  });
  it("shows a lead that was never anyone else's as before", async () => {
    current = lead({ reassigned: false });
    const { container } = open(`/leads/${id}`);
    expect(
      await screen.findByRole("heading", { name: /Activity timeline/ }),
    ).toBeInTheDocument();
    expect(flags(container)).toEqual([]);
    expect(
      screen.getByText("No activity yet. Start a conversation."),
    ).toBeInTheDocument();
  });
  it("lists carried-over follow-ups without earlier comments, and edits them without a notes field", async () => {
    const user = userEvent.setup();
    open("/followups");
    expect(
      await screen.findByText("Carried over from an earlier assignment"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).queryByLabelText(/Notes/)).toBeNull();
    expect(within(dialog).getByLabelText(/Status/)).toBeInTheDocument();
  });
});
