import React from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { ToastProvider } from "../src/components/common/UI";
import Leads from "../src/pages/admin/Leads";
import LeadDetail from "../src/pages/agent/LeadDetail";
import { localInput } from "../src/lib/api";

const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const agent = "91000000-0000-4000-8000-000000000001",
  other = "91000000-0000-4000-8000-000000000002";
const baseLead = {
  id: "92000000-0000-4000-8000-000000000001",
  name: "Dial fixture customer",
  lead_no: 42,
  assigned_agent: agent,
  phone: "+923001234567",
  status: "new",
  source: "manual",
  preferred_location: "DHA Phase 6",
  budget_min: 5000000,
  budget_max: 7500000,
  created_at: new Date().toISOString(),
};
let rows;
const originalDialog = Object.getOwnPropertyDescriptor(
  HTMLDialogElement.prototype,
  "showModal",
);
// jsdom cannot open tel: links; stop the navigation but keep React's handler.
const blockTel = (event) => {
  if (event.target.closest?.('a[href^="tel:"]')) event.preventDefault();
};
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value() {
      this.setAttribute("open", "");
    },
  });
  document.addEventListener("click", blockTel, true);
});
afterAll(() => {
  document.removeEventListener("click", blockTel, true);
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
  rows = [{ ...baseLead }];
  mocks.auth.user = { id: agent, role: "agent", name: "Dial agent" };
  mocks.api.mockImplementation(async (path, options) => {
    if (path.endsWith("/calls/manual") && options?.method === "POST")
      return { id: "call-1", ...options.body };
    if (path.startsWith("/leads?")) return { data: rows, count: rows.length };
    if (path === "/leads/" + baseLead.id) return rows[0];
    if (path.endsWith("/timeline") || path === "/users") return [];
    if (path === "/call-capabilities") return { manual: true, mock: false };
    return { data: [], count: 0 };
  });
});
afterEach(() => vi.useRealTimers());
function workspace(page = "list") {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter
          initialEntries={[
            page === "list" ? "/leads?view=all" : "/leads/" + baseLead.id,
          ]}
        >
          <Routes>
            <Route path="/leads" element={<Leads />} />
            <Route path="/leads/:id" element={<LeadDetail />} />
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
const phoneRequests = () =>
  mocks.api.mock.calls.filter(
    ([p]) => p === "/leads/phones" || p.endsWith("/phone"),
  );
async function openDialog(page = "list") {
  workspace(page);
  fireEvent.click(
    await screen.findByRole("button", { name: "Call " + baseLead.name }),
  );
  return screen.getByRole("dialog");
}
const dialLink = () =>
  screen.getByRole("link", { name: "Call " + baseLead.phone });

describe("call button and call dialog", () => {
  it.each(["agent", "admin"])(
    "puts a Call button beside the number for %s and opens the dialog with lead details",
    async (role) => {
      mocks.auth.user.role = role;
      const dialog = await openDialog();
      expect(
        within(dialog).getByRole("heading", {
          name: "Call " + baseLead.name,
        }),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("HD-000042")).toBeInTheDocument();
      expect(within(dialog).getByText("DHA Phase 6")).toBeInTheDocument();
      expect(dialLink()).toHaveAttribute("href", "tel:" + baseLead.phone);
      expect(
        within(dialog).getByText(/Microsoft Phone Link/),
      ).toBeInTheDocument();
      for (const label of [
        "Call connected?",
        "Call start (Pakistan time)",
        "Duration minutes",
        "Duration seconds",
        "Call outcome",
        "Agent notes",
      ])
        expect(within(dialog).getByLabelText(label)).toBeInTheDocument();
      expect(
        [...within(dialog).getByLabelText("Call connected?").options].map(
          (o) => o.textContent,
        ),
      ).toEqual(["Connected", "Not connected"]);
      expect(within(dialog).getByLabelText("Hot lead")).toBeInTheDocument();
      expect(phoneRequests()).toHaveLength(0);
    },
  );
  it("shows no Call button for another agent's lead", async () => {
    rows = [{ ...baseLead, assigned_agent: other }];
    workspace();
    expect(await screen.findByText("Number unavailable")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Call " + baseLead.name }),
    ).not.toBeInTheDocument();
  });
  it("times the call from Call to End call and saves the log", async () => {
    await openDialog();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-19T07:30:00Z"));
    fireEvent.click(dialLink());
    expect(screen.getByLabelText("Call start (Pakistan time)")).toHaveValue(
      localInput("2026-10-19T07:30:00.000Z"),
    );
    expect(screen.getByRole("timer")).toHaveTextContent("Call time 0:00");
    await act(async () => vi.advanceTimersByTime(127000));
    expect(screen.getByRole("timer")).toHaveTextContent("Call time 2:07");
    fireEvent.click(screen.getByRole("button", { name: "End call" }));
    expect(screen.getByLabelText("Duration minutes")).toHaveValue(2);
    expect(screen.getByLabelText("Duration seconds")).toHaveValue(7);
    expect(screen.getByText(/Call ended after 2:07/)).toBeInTheDocument();
    vi.useRealTimers();
    fireEvent.change(screen.getByLabelText("Call outcome"), {
      target: { value: "Interested" },
    });
    fireEvent.change(screen.getByLabelText("Agent notes"), {
      target: { value: "Wants a 10 marla house; call back Friday." },
    });
    fireEvent.click(screen.getByLabelText("Warm lead"));
    fireEvent.click(screen.getByRole("button", { name: "Save call" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(manualPosts()).toHaveLength(1);
    expect(manualPosts()[0][0]).toBe(`/leads/${baseLead.id}/calls/manual`);
    expect(manualPosts()[0][1].body).toEqual({
      answered: true,
      started_at: "2026-10-19T07:30:00.000Z",
      duration_minutes: 2,
      duration_seconds: 7,
      outcome: "Interested",
      notes: "Wants a 10 marla house; call back Friday.",
      deal_tags: ["Warm lead"],
    });
    expect(await screen.findByText("Call saved")).toBeInTheDocument();
  });
  it("stops the timer when the agent saves without pressing End call", async () => {
    await openDialog();
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2026-10-19T08:00:00Z"));
    fireEvent.click(dialLink());
    await act(async () => vi.advanceTimersByTime(65000));
    fireEvent.change(screen.getByLabelText("Call connected?"), {
      target: { value: "no" },
    });
    fireEvent.change(screen.getByLabelText("Call outcome"), {
      target: { value: "No answer" },
    });
    // Saving ends the call on the same clock that started it.
    fireEvent.click(screen.getByRole("button", { name: "Save call" }));
    vi.useRealTimers();
    await waitFor(() => expect(manualPosts()).toHaveLength(1));
    expect(manualPosts()[0][1].body).toMatchObject({
      answered: false,
      outcome: "No answer",
      duration_minutes: 1,
      duration_seconds: 5,
    });
  });
  it("asks before closing a started call without saving", async () => {
    await openDialog();
    fireEvent.click(dialLink());
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This call is not saved yet",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep logging" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Close without saving" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(manualPosts()).toHaveLength(0);
  });
  it("closes straight away when no call was started", async () => {
    await openDialog();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("offers the same dialog from the lead page and keeps Log a call for past calls", async () => {
    const dialog = await openDialog("profile");
    expect(dialLink()).toHaveAttribute("href", "tel:" + baseLead.phone);
    fireEvent.change(within(dialog).getByLabelText("Duration seconds"), {
      target: { value: "30" },
    });
    fireEvent.change(within(dialog).getByLabelText("Call outcome"), {
      target: { value: "Follow-up required" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save call" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(manualPosts()[0][1].body).toMatchObject({
      outcome: "Follow-up required",
      duration_seconds: 30,
    });
    fireEvent.click(screen.getByRole("button", { name: "Log a call" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: /^Call \+/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByText(/using your company phone/)).toBeInTheDocument();
  });
});
