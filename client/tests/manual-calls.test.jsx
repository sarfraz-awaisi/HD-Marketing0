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
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LeadDetail from "../src/pages/agent/LeadDetail";
import CallReview from "../src/pages/admin/CallReview";
import OutcomeForm from "../src/components/calls/OutcomeForm";
import { ToastProvider } from "../src/components/common/UI";
import { localInput } from "../src/lib/api";

const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const leadId = "82000000-0000-4000-8000-000000000001",
  agent = "82000000-0000-4000-8000-000000000002";
let lead, rows, mockEnabled, saveError, deferred, callCount;
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
  mockEnabled = false;
  saveError = null;
  deferred = null;
  callCount = 0;
  rows = [];
  mocks.auth.user = { id: agent, role: "agent", name: "Call fixture agent" };
  lead = {
    id: leadId,
    assigned_agent: agent,
    name: "Call fixture customer",
    source: "manual",
    status: "new",
    budget_min: 0,
    created_at: new Date().toISOString(),
    masked_phone: "+92******123",
  };
  mocks.api.mockImplementation(async (path, options) => {
    if (path.endsWith("/calls/manual") && options?.method === "POST") {
      if (deferred) await deferred;
      if (saveError) throw saveError;
      const body = options.body;
      const call = {
        ...body,
        id: "fixture-call-" + ++callCount,
        lead_id: leadId,
        method: "manual",
        status: body.answered ? "completed" : "failed",
        duration_seconds: body.duration_minutes * 60 + body.duration_seconds,
        created_at: new Date().toISOString(),
        kind: "calls",
      };
      rows = [call];
      if (body.answered) lead = { ...lead, status: "contacted" };
      return call;
    }
    if (path === "/call-capabilities")
      return { manual: true, mock: mockEnabled, provider: false };
    if (path === `/leads/${leadId}`) return lead;
    if (path.endsWith("/timeline")) return rows;
    if (path.endsWith("/phone")) return { phone: "+923001234123" };
    if (path === "/users")
      return [
        { id: agent, role: "agent", active: true, name: "Call fixture agent" },
      ];
    if (path.startsWith("/calls?")) {
      const q = new URLSearchParams(path.split("?")[1]);
      const filtered = rows.filter(
        (row) => !q.get("method") || row.method === q.get("method"),
      );
      return { data: filtered, count: 40 };
    }
    return { data: [], count: 0 };
  });
});
function workspace(element = <LeadDetail />, review = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={[review ? "/calls" : `/leads/${leadId}`]}>
          <Routes>
            <Route path={review ? "/calls" : "/leads/:id"} element={element} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const manualPosts = () =>
  mocks.api.mock.calls.filter(
    ([path, options]) =>
      path.endsWith("/calls/manual") && options?.method === "POST",
  );
async function openForm(user) {
  await user.click(await screen.findByRole("button", { name: "Log a call" }));
  return screen.getByRole("dialog");
}
async function fillAnswered(user) {
  fireEvent.change(screen.getByLabelText("Duration minutes"), {
    target: { value: "2" },
  });
  fireEvent.change(screen.getByLabelText("Duration seconds"), {
    target: { value: "7" },
  });
  await user.selectOptions(screen.getByLabelText("Call outcome"), "Interested");
}

describe("P1 manual calling screens", () => {
  it.each(["agent", "admin"])(
    "offers manual logging without mock controls for %s when the server is in production",
    async (role) => {
      mocks.auth.user.role = role;
      workspace();
      expect(
        await screen.findByRole("button", { name: "Log a call" }),
      ).toBeEnabled();
      await waitFor(() =>
        expect(mocks.api).toHaveBeenCalledWith(
          "/call-capabilities",
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(
        screen.queryByRole("button", { name: "Development mock call" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Call lead" }),
      ).not.toBeInTheDocument();
    },
  );
  it("shows development mock controls only when the server explicitly advertises them", async () => {
    mockEnabled = true;
    workspace();
    expect(
      await screen.findByRole("button", { name: "Development mock call" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Log a call" })).toBeEnabled();
  });
  it("logs an answered call with Pakistan time, duration, notes and tags; refreshes timeline and stage", async () => {
    const user = userEvent.setup();
    workspace();
    await openForm(user);
    expect(screen.getByLabelText("Call start (Pakistan time)")).toHaveValue(
      localInput(new Date().toISOString()),
    );
    const localStart = localInput(new Date(Date.now() - 600000).toISOString());
    fireEvent.change(screen.getByLabelText("Call start (Pakistan time)"), {
      target: { value: localStart },
    });
    await fillAnswered(user);
    await user.type(
      screen.getByLabelText("Agent notes"),
      "Fixture follow-through",
    );
    await user.click(screen.getByLabelText("Hot lead"));
    await user.click(screen.getByRole("button", { name: "Save call" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(manualPosts()).toHaveLength(1);
    expect(manualPosts()[0][1].body).toEqual({
      answered: true,
      started_at: new Date(localStart + "+05:00").toISOString(),
      duration_minutes: 2,
      duration_seconds: 7,
      outcome: "Interested",
      notes: "Fixture follow-through",
      deal_tags: ["Hot lead"],
    });
    expect(
      await screen.findByText("Manual call · completed · Answered · 127s"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Lead status")).toHaveValue("contacted");
  });
  it.each(["No answer", "Busy", "Wrong number"])(
    "logs unanswered %s with zero duration and leaves the lead New",
    async (outcome) => {
      const user = userEvent.setup();
      workspace();
      await openForm(user);
      await user.selectOptions(screen.getByLabelText("Call connected?"), "no");
      const labels = [...screen.getByLabelText("Call outcome").options].map(
        (option) => option.textContent,
      );
      expect(labels).toEqual([
        "Select an outcome",
        "No answer",
        "Busy",
        "Wrong number",
      ]);
      await user.selectOptions(screen.getByLabelText("Call outcome"), outcome);
      await user.click(screen.getByRole("button", { name: "Save call" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(manualPosts()[0][1].body).toMatchObject({
        answered: false,
        duration_minutes: 0,
        duration_seconds: 0,
        outcome,
      });
      expect(
        await screen.findByText("Manual call · failed · Unanswered · 0s"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Lead status")).toHaveValue("new");
    },
  );
  it("requires an outcome and a positive answered duration before saving", async () => {
    const user = userEvent.setup();
    workspace();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: "Save call" }));
    expect(
      await screen.findByText("Choose a call outcome"),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("Call outcome"),
      "Interested",
    );
    await user.click(screen.getByRole("button", { name: "Save call" }));
    expect(
      await screen.findByText(/Answered calls need at least 1 second/),
    ).toBeInTheDocument();
    expect(manualPosts()).toHaveLength(0);
  });
  it.each([3 * 60000, -49 * 3600000])(
    "rejects a future or too-old agent call start (%s)",
    async (offset) => {
      const user = userEvent.setup();
      workspace();
      await openForm(user);
      await fillAnswered(user);
      fireEvent.change(screen.getByLabelText("Call start (Pakistan time)"), {
        target: {
          value: localInput(new Date(Date.now() + offset).toISOString()),
        },
      });
      await user.click(screen.getByRole("button", { name: "Save call" }));
      expect(
        await screen.findByText(/Use a call start within the past 48 hours/),
      ).toBeInTheDocument();
      expect(manualPosts()).toHaveLength(0);
    },
  );
  it("allows an administrator to log a recent 10-day-old conversation", async () => {
    mocks.auth.user.role = "admin";
    const user = userEvent.setup();
    workspace();
    await openForm(user);
    await fillAnswered(user);
    fireEvent.change(screen.getByLabelText("Call start (Pakistan time)"), {
      target: {
        value: localInput(new Date(Date.now() - 10 * 86400000).toISOString()),
      },
    });
    await user.click(screen.getByRole("button", { name: "Save call" }));
    await waitFor(() => expect(manualPosts()).toHaveLength(1));
  });
  it("retains values on a rejected save and retries without closing or duplicating the successful call", async () => {
    saveError = new Error("Lead no longer belongs to this account");
    const user = userEvent.setup();
    workspace();
    await openForm(user);
    await fillAnswered(user);
    await user.type(screen.getByLabelText("Agent notes"), "Keep this draft");
    await user.click(screen.getByRole("button", { name: "Save call" }));
    expect(await screen.findByText(saveError.message)).toBeInTheDocument();
    expect(screen.getByLabelText("Agent notes")).toHaveValue("Keep this draft");
    saveError = null;
    await user.click(screen.getByRole("button", { name: "Save call" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(manualPosts()).toHaveLength(2);
    expect(callCount).toBe(1);
  });
  it("guards repeated submission and close/cancel while a call is saving", async () => {
    let resolve;
    deferred = new Promise((done) => {
      resolve = done;
    });
    const user = userEvent.setup();
    workspace();
    await openForm(user);
    await fillAnswered(user);
    await user.dblClick(screen.getByRole("button", { name: "Save call" }));
    await waitFor(() => expect(manualPosts()).toHaveLength(1));
    expect(screen.getByLabelText("Agent notes")).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent(
      screen.getByRole("dialog"),
      new Event("cancel", { bubbles: true, cancelable: true }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => {
      resolve();
    });
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(callCount).toBe(1);
  });
  it("cancels without creating a call", async () => {
    const user = userEvent.setup();
    workspace();
    await openForm(user);
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(manualPosts()).toHaveLength(0);
  });
  it("preserves unanswered restrictions in the existing outcome editor", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(
      <OutcomeForm
        call={{ method: "manual", answered: false, outcome: "Busy" }}
        onSave={save}
      />,
    );
    expect(
      screen.queryByRole("option", { name: "Interested" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Save outcome" }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        outcome: "Busy",
        notes: "",
        deal_tags: [],
      }),
    );
  });
  it("shows call methods and filters the administrator review with page reset", async () => {
    mocks.auth.user.role = "admin";
    rows = ["manual", "mock", "provider"].map((method) => ({
      id: method,
      method,
      answered: true,
      lead_id: leadId,
      started_at: new Date().toISOString(),
      status: "completed",
      duration_seconds: 45,
      outcome: "Interested",
    }));
    const user = userEvent.setup();
    workspace(<CallReview />, true);
    expect((await screen.findAllByText("Manual")).length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: "Recording" })).toHaveLength(
        2,
      ),
    );
    await user.click(await screen.findByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(screen.getByText("40 records · Page 2")).toBeInTheDocument(),
    );
    await user.selectOptions(screen.getByLabelText("Call method"), "manual");
    await waitFor(() =>
      expect(screen.getByText("40 records · Page 1")).toBeInTheDocument(),
    );
    expect(
      mocks.api.mock.calls.some(
        ([path]) =>
          path.startsWith("/calls?") &&
          new URLSearchParams(path.split("?")[1]).get("method") === "manual",
      ),
    ).toBe(true);
    expect(screen.getAllByRole("link", { name: /Customer ↗/ })).toHaveLength(1);
    expect(
      screen.queryByRole("button", { name: "Recording" }),
    ).not.toBeInTheDocument();
  });
});
