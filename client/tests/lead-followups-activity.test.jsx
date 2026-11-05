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
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import LeadDetail from "../src/pages/agent/LeadDetail";
import FollowUps from "../src/pages/agent/FollowUps";
import { ToastProvider } from "../src/components/common/UI";
import { localISO, localInput } from "../src/lib/api";
// Follow-ups promised on calls, the Follow-ups page and the lead activity
// timeline. API responses are mocked; the server tests check the same rules
// against the database.
const mocks = vi.hoisted(() => ({ api: vi.fn(), auth: { user: null } }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const leadId = "84000000-0000-4000-8000-000000000001",
  agent = "84000000-0000-4000-8000-000000000002";
const hours = (h) => new Date(Date.now() + h * 3600000).toISOString();
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
let timeline, saved, followupResponse;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = { id: agent, role: "agent", name: "Ali Agent" };
  timeline = [];
  saved = [];
  followupResponse = null;
  mocks.api.mockImplementation(async (path, options) => {
    if (options?.method) {
      saved.push([path, options]);
      if (path.endsWith("/calls/manual"))
        return { id: "call-1", lead_id: leadId, ...followupResponse };
      return { id: "saved" };
    }
    if (path === "/call-capabilities")
      return { manual: true, mock: false, provider: false };
    if (path === `/leads/${leadId}`)
      return {
        id: leadId,
        lead_no: 41,
        name: "Timeline customer",
        assigned_agent: agent,
        status: "contacted",
        source: "manual",
        budget_min: 0,
        created_at: hours(-100),
        masked_phone: "+92******123",
      };
    if (path.endsWith("/timeline")) return timeline;
    if (path === "/followups/unscheduled")
      return {
        count: 1,
        data: [
          {
            lead_id: leadId,
            lead_no: 41,
            name: "Timeline customer",
            call_id: "c0",
            called_at: hours(-50),
          },
        ],
      };
    if (path.startsWith("/followups?"))
      return {
        count: 2,
        data: [
          {
            id: "f1",
            lead_id: leadId,
            leads: { lead_no: 41, name: "Timeline customer" },
            due_at: hours(-3),
            status: "pending",
            notes: "Call about the plot",
          },
          {
            id: "f2",
            lead_id: leadId,
            leads: { lead_no: 41, name: "Timeline customer" },
            due_at: hours(48),
            status: "pending",
            notes: "Send brochure",
          },
        ],
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
          <Routes>
            <Route path="/leads/:id" element={<LeadDetail />} />
            <Route path="/followups" element={<FollowUps />} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
async function logCall(outcome, followUp) {
  open(`/leads/${leadId}`);
  fireEvent.click(await screen.findByRole("button", { name: "Log a call" }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("Duration seconds"), {
    target: { value: "40" },
  });
  fireEvent.change(within(dialog).getByLabelText("Call outcome"), {
    target: { value: outcome },
  });
  if (followUp)
    fireEvent.change(within(dialog).getByLabelText("Follow-up date and time"), {
      target: { value: followUp },
    });
  fireEvent.click(within(dialog).getByRole("button", { name: "Save call" }));
  return dialog;
}

describe("logging a call that needs a follow-up", () => {
  it("requires the follow-up time and sends it with the call", async () => {
    const followUp = localInput(hours(30));
    followupResponse = {
      followup: { id: "f9", due_at: localISO(followUp), status: "pending" },
    };
    await logCall("Follow-up required", followUp);
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0][0]).toBe(`/leads/${leadId}/calls/manual`);
    expect(saved[0][1].body).toMatchObject({
      outcome: "Follow-up required",
      follow_up_at: localISO(followUp),
    });
    expect(
      await screen.findByText(/^Call saved\. Follow-up scheduled for /),
    ).toBeInTheDocument();
  });
  it("does not send the call without a follow-up time", async () => {
    const dialog = await logCall("Follow-up required");
    expect(
      within(dialog).getByLabelText("Follow-up date and time"),
    ).toBeRequired();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saved).toHaveLength(0);
  });
  it("keeps the follow-up optional for other outcomes", async () => {
    const dialog = await logCall("Interested");
    expect(
      within(dialog).getByLabelText("Follow-up date and time"),
    ).not.toBeRequired();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0][1].body.follow_up_at).toBeUndefined();
  });
  it("reopens only the follow-up when the call was saved but its follow-up was not", async () => {
    const due = localISO(localInput(hours(30)));
    followupResponse = {
      followup_error: "The follow-up could not be saved.",
      followup_due_at: due,
      followup_notes: "Call outcome: Follow-up required",
    };
    await logCall("Follow-up required", localInput(hours(30)));
    // No success message: the follow-up form opens with the chosen time.
    const dialog = await screen.findByRole("dialog", {
      name: "Schedule follow-up",
    });
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "The call was saved, but its follow-up was not: The follow-up could not be saved.",
    );
    expect(screen.queryByText(/Follow-up scheduled for/)).toBeNull();
    expect(within(dialog).getByLabelText(/Date and time/)).toHaveValue(
      localInput(due),
    );
    expect(within(dialog).getByLabelText("Notes")).toHaveValue(
      "Call outcome: Follow-up required",
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save record" }),
    );
    await waitFor(() => expect(saved).toHaveLength(2));
    // The call was sent once; only the follow-up was sent again.
    expect(saved.map(([path]) => path)).toEqual([
      `/leads/${leadId}/calls/manual`,
      "/followups",
    ]);
    expect(saved[1][1].body).toMatchObject({
      lead_id: leadId,
      due_at: due,
      status: "pending",
    });
    expect(await screen.findByText("Follow-up scheduled")).toBeInTheDocument();
  });
});

describe("the lead activity timeline", () => {
  it("shows who did each action, the call outcome, notes, tags and the follow-up state", async () => {
    timeline = [
      {
        kind: "lead_update",
        id: "u1",
        created_at: hours(-1),
        actor_name: "Owner",
        fields: ["preferred location", "maximum budget"],
      },
      {
        kind: "followups",
        id: "f1",
        created_at: hours(-2),
        due_at: hours(-1.5),
        status: "pending",
        notes: "Call outcome: Follow-up required",
        actor_name: "Ali Agent",
        agent_name: "Ali Agent",
        updates: [
          {
            at: hours(-1.8),
            actor_name: "Ali Agent",
            fields: ["follow-up time"],
          },
        ],
      },
      {
        kind: "calls",
        id: "c1",
        created_at: hours(-3),
        method: "manual",
        status: "completed",
        answered: true,
        duration_seconds: 75,
        started_at: hours(-3),
        outcome: "Follow-up required",
        notes: "Wants the payment plan",
        deal_tags: ["Warm lead"],
        actor_name: "Ali Agent",
      },
      {
        kind: "notes",
        id: "n1",
        created_at: hours(-4),
        body: "Customer prefers WhatsApp",
        actor_name: "Owner",
      },
    ];
    open(`/leads/${leadId}`);
    const call = (await screen.findByText("Wants the payment plan")).closest(
      "article",
    );
    expect(call).toHaveTextContent("Follow-up required");
    expect(call).toHaveTextContent("By Ali Agent");
    expect(within(call).getByLabelText("Lead tags")).toHaveTextContent(
      "Warm lead",
    );
    expect(call).toHaveTextContent("Manual call · completed · Answered · 75s");
    const note = screen
      .getByText("Customer prefers WhatsApp")
      .closest("article");
    expect(note).toHaveTextContent("By Owner");
    const followUp = screen
      .getByText("Call outcome: Follow-up required")
      .closest("article");
    expect(followUp).toHaveTextContent("Responsible: Ali Agent");
    expect(followUp).toHaveTextContent("Overdue");
    expect(followUp).toHaveTextContent("Ali Agent changed follow-up time");
    expect(
      screen.getByText("Changed preferred location and maximum budget."),
    ).toBeInTheDocument();
  });
});

describe("who did it", () => {
  it("never shows an unknown actor as the agent", async () => {
    timeline = [
      {
        kind: "calls",
        id: "c2",
        created_at: hours(-1),
        method: "manual",
        status: "completed",
        answered: true,
        duration_seconds: 30,
        started_at: hours(-1),
        outcome: "Interested",
        notes: "Logged by the owner",
        deal_tags: [],
        actor_name: "Owner",
        agent_name: "Ali Agent",
      },
      {
        kind: "calls",
        id: "c3",
        created_at: hours(-2),
        method: "manual",
        status: "completed",
        answered: true,
        duration_seconds: 30,
        started_at: hours(-2),
        outcome: "Busy",
        notes: "Old imported call",
        deal_tags: [],
        actor_name: null,
        agent_name: "Ali Agent",
      },
      {
        kind: "notes",
        id: "n2",
        created_at: hours(-3),
        body: "Imported note",
        actor_name: null,
      },
    ];
    open(`/leads/${leadId}`);
    const byOwner = (await screen.findByText("Logged by the owner")).closest(
      "article",
    );
    expect(byOwner).toHaveTextContent("By Owner · Agent: Ali Agent");
    const old = screen.getByText("Old imported call").closest("article");
    expect(old).toHaveTextContent("Agent: Ali Agent");
    expect(old).not.toHaveTextContent("By ");
    expect(
      screen.getByText("Imported note").closest("article"),
    ).not.toHaveTextContent("By ");
  });
});

describe("the Follow-ups page", () => {
  it("opens on pending follow-ups soonest first, with their state", async () => {
    open("/followups");
    const overdue = (await screen.findByText("Call about the plot")).closest(
      "tr",
    );
    expect(overdue).toHaveTextContent("Overdue");
    expect(screen.getByText("Send brochure").closest("tr")).toHaveTextContent(
      "Upcoming",
    );
    const list = mocks.api.mock.calls
      .map(([path]) => path)
      .find((path) => path.startsWith("/followups?"));
    const q = new URLSearchParams(list.split("?")[1]);
    expect([q.get("view"), q.get("sort"), q.get("direction")]).toEqual([
      "pending",
      "due_at",
      "asc",
    ]);
    expect(
      screen.getByRole("combobox", { name: "Filter records" }),
    ).toHaveValue("pending");
  });
  it("lists calls waiting for a follow-up date and schedules one", async () => {
    open("/followups");
    const panel = (
      await screen.findByRole("heading", {
        name: "Calls waiting for a follow-up date",
      })
    ).closest("section");
    fireEvent.click(
      within(panel).getByRole("button", { name: "Schedule follow-up" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: /^Schedule follow-up/,
    });
    const when = localInput(hours(20));
    fireEvent.change(within(dialog).getByLabelText(/Date and time/), {
      target: { value: when },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save record" }),
    );
    await waitFor(() =>
      expect(saved.find(([path]) => path === "/followups")).toBeTruthy(),
    );
    expect(saved.find(([path]) => path === "/followups")[1].body).toMatchObject(
      {
        lead_id: leadId,
        due_at: localISO(when),
        status: "pending",
      },
    );
  });
});
