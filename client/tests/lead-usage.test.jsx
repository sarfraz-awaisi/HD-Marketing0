import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import { date } from "../src/lib/api";
import { periodWork, summaryText } from "../src/lib/leadUsage";
// Update 075: Lead Usage next to Export on administrators' All leads, and a
// lead's agent history. API responses are mocked; the server tests check the
// counting rules and the history the database returns.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const id = (n) => `75200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = { id: id(901), role: "admin", name: "Owner", active: true };
const ali = { id: id(902), role: "agent", name: "Ali Agent", active: true };
const sara = { id: id(903), role: "agent", name: "Sara Agent", active: true };
const usman = {
  id: id(904),
  role: "agent",
  name: "Usman Agent",
  active: false,
};
const lead = (n, extra = {}) => ({
  id: id(n),
  lead_no: 900 + n,
  name: `Customer ${n}`,
  phone: "+9230099000" + String(n).padStart(2, "0"),
  masked_phone: "+92******0" + n,
  status: "new",
  source: "Meta",
  import_id: null,
  assigned_agent: ali.id,
  assigned_name: "Ali Agent",
  assigned_active: true,
  created_at: "2026-11-09T08:00:00Z",
  assigned_at: "2026-11-09T08:00:00Z",
  call_due_at: null,
  first_call_at: null,
  missed_at: null,
  last_call_at: null,
  last_call_outcome: null,
  last_call_connected: null,
  agents_used: 1,
  ...extra,
});
const counts = { all: 41, 2: 12, 3: 5, 4: 2, 5: 1 };
// Ali worked it (and the owner logged a call meanwhile), Sara never did,
// then the admin team, then Usman tried once; Usman's end was never saved.
const call = (n, extra) => ({
  id: id(100 + n),
  started_at: `2026-11-10T0${n}:00:00Z`,
  saved_at: `2026-11-10T0${n}:01:00Z`,
  outcome: "No answer",
  status: "no_answer",
  connected: false,
  method: "manual",
  duration_seconds: 0,
  notes: null,
  tags: [],
  filed_under: ali.id,
  recorded_by: ali.id,
  ...extra,
});
const empty = {
  calls: [],
  notes: [],
  status_changes: [],
  followups: [],
  visits: [],
  deals: [],
  assigned_again: [],
  first_call_at: null,
  missed_at: null,
  reason: null,
  assigned_by: owner.id,
};
const history = {
  lead: {
    id: id(2),
    lead_no: 902,
    name: "Customer 2",
    status: "interested",
    assigned_agent: null,
  },
  agents_used: 3,
  current_recorded: true,
  periods: [
    {
      ...empty,
      seq: 1,
      kind: "agent",
      agent_id: ali.id,
      started_at: "2026-11-10T00:00:00Z",
      ended_at: "2026-11-11T00:00:00Z",
      end: "next",
      first_call_at: "2026-11-10T01:00:00Z",
      calls: [
        call(1),
        call(2, {
          outcome: "Interested",
          status: "completed",
          connected: true,
          duration_seconds: 75,
          notes: "Customer requested the payment plan.",
          tags: ["Warm lead"],
        }),
        call(3, {
          outcome: "Follow-up required",
          status: "completed",
          connected: true,
          notes: "Owner checked the budget.",
          recorded_by: owner.id,
        }),
      ],
      notes: [
        {
          id: id(201),
          at: "2026-11-10T04:00:00Z",
          body: "Prefers Bahria Town.",
          written_by: ali.id,
        },
      ],
      followups: [
        {
          id: id(301),
          created_at: "2026-11-10T05:00:00Z",
          due_at: "2026-11-10T09:00:00Z",
          status: "completed",
          completed_at: "2026-11-10T09:05:00Z",
          notes: "Call back about the plan",
          created_by: ali.id,
          responsible: ali.id,
          cancelled_on_reassignment: false,
        },
      ],
    },
    {
      ...empty,
      seq: 2,
      kind: "agent",
      agent_id: sara.id,
      started_at: "2026-11-11T00:00:00Z",
      ended_at: "2026-11-12T00:00:00Z",
      end: "next",
    },
    {
      ...empty,
      seq: 3,
      kind: "admin_team",
      agent_id: null,
      started_at: "2026-11-12T00:00:00Z",
      ended_at: "2026-11-13T00:00:00Z",
      end: "next",
    },
    {
      ...empty,
      seq: 4,
      kind: "agent",
      agent_id: usman.id,
      started_at: "2026-11-13T00:00:00Z",
      ended_at: null,
      end: "not_recorded",
      calls: [call(5, { filed_under: usman.id, recorded_by: usman.id })],
    },
  ],
  people: {
    [owner.id]: { name: "Owner", uid: 663118, role: "admin", active: true },
    [ali.id]: { name: "Ali Agent", uid: 962837, role: "agent", active: true },
    [sara.id]: { name: "Sara Agent", uid: 815678, role: "agent", active: true },
    [usman.id]: {
      name: "Usman Agent",
      uid: 351728,
      role: "agent",
      active: false,
    },
  },
};
let rows, usage;
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  mocks.user = { ...owner };
  usage = counts;
  rows = [lead(1), lead(2, { agents_used: 3, assigned_agent: null })];
  mocks.api.mockImplementation(async (path) => {
    if (path.startsWith("/leads/all?"))
      return {
        page: 1,
        limit: 20,
        count: rows.length,
        totals: { total: 41, assigned: 30, unassigned: 11 },
        ...(usage ? { usage } : {}),
        data: rows,
      };
    if (path === `/leads/${id(2)}/agent-history`) return history;
    if (path === "/users") return [owner, ali, sara, usman];
    if (path === "/call-capabilities") return { manual: true, mock: false };
    return { data: [], count: 0 };
  });
});
function Where() {
  const location = useLocation();
  return (
    <output aria-label="Address">{location.pathname + location.search}</output>
  );
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
          <Where />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const listCalls = () =>
  mocks.api.mock.calls
    .map(([p]) => p)
    .filter((p) => p.startsWith("/leads/all?"));
const address = () => screen.getByLabelText("Address").textContent;
const usageSelect = () => screen.getByRole("combobox", { name: "Lead Usage" });

describe("Lead Usage on All leads (update 075)", () => {
  it("sits next to Export with the database's counts, and lists exactly that usage", async () => {
    const user = userEvent.setup();
    open("/leads?temperature=hot");
    await screen.findByText("Customer 1");
    const select = usageSelect();
    // Right before Export, in the page heading.
    expect(select.closest("label").nextElementSibling).toBe(
      screen.getByRole("button", { name: "Export" }),
    );
    await waitFor(() =>
      expect(
        within(select)
          .getAllByRole("option")
          .map((o) => o.textContent),
      ).toEqual([
        "All Leads (41)",
        "Used 2 Times (12)",
        "Used 3 Times (5)",
        "Used 4 Times (2)",
        "Used 5 Times (1)",
      ]),
    );
    await user.selectOptions(select, "3");
    await waitFor(() => expect(address()).toContain("usage=3"));
    // With the other filters, from the first page.
    const asked = new URLSearchParams(listCalls().at(-1).split("?")[1]);
    expect(Object.fromEntries(asked)).toEqual({
      temperature: "hot",
      usage: "3",
      page: "1",
    });
    expect(usageSelect()).toHaveValue("3");
    await user.click(
      screen.getByRole("button", { name: /Lead Usage: Used 3 Times/ }),
    );
    await waitFor(() => expect(address()).not.toContain("usage="));
    expect(usageSelect()).toHaveValue("");
  });

  it("shows Used N times only for leads more than one agent has had, and opens the agent history", async () => {
    const user = userEvent.setup();
    open("/leads");
    const table = await screen.findByRole("table");
    await within(table).findByText("Customer 2");
    expect(within(table).queryByText("Used 1 time")).toBeNull();
    await user.click(
      within(table).getByRole("button", {
        name: "Used 3 times: open the agent history of Customer 2",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Agent history · Customer 2",
    });
    await within(dialog).findByText("HD-000902");
    expect(mocks.api).toHaveBeenCalledWith(
      `/leads/${id(2)}/agent-history`,
      expect.anything(),
    );
    // Precise: assigned is not worked, worked is not reached. The owner's
    // call is never Ali's.
    expect(
      within(dialog).getByText(
        "Assigned to 3 different agents. 2 of them saved work on it; 1 reached the customer.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("No agent (admin team)"),
    ).toBeInTheDocument();
    const periods = within(dialog)
      .getAllByRole("listitem")
      .filter((li) => li.classList.contains("lead-history-period"));
    expect(
      periods.map((p) => within(p).getByRole("heading").textContent),
    ).toEqual([
      "Ali Agent",
      "Sara Agent",
      "Admin team (no agent)",
      "Usman Agent",
    ]);
    const [aliPeriod, saraPeriod, adminTeam, usmanPeriod] = periods;
    expect(aliPeriod).toHaveTextContent("Agent ID 962837");
    expect(aliPeriod).toHaveTextContent(
      `Assigned ${date("2026-11-10T00:00:00Z")} by Owner`,
    );
    expect(aliPeriod).toHaveTextContent(
      `Until ${date("2026-11-11T00:00:00Z")}`,
    );
    const numbers = (p) =>
      Object.fromEntries(
        within(p)
          .getAllByRole("term")
          .filter((dt) => dt.closest(".lead-history-numbers"))
          .map((dt) => [dt.textContent, dt.nextElementSibling.textContent]),
      );
    expect(numbers(aliPeriod)).toMatchObject({
      Calls: "2",
      "Successful contacts": "1",
    });
    for (const text of [
      "Successfully contacted",
      "Customer response: Interested",
      "Follow-up performed",
      "Customer requested the payment plan.",
      "1 record in this period saved by someone else",
    ])
      expect(aliPeriod).toHaveTextContent(text);
    expect(
      within(aliPeriod).getByText("Temperature").closest("p"),
    ).toHaveTextContent("Temperature🌤️ Warm");
    // Every record, with who saved it.
    await user.click(
      within(aliPeriod).getByText(/All records in this period \(5\)/),
    );
    const records = within(aliPeriod)
      .getAllByRole("listitem")
      .filter((li) => li.classList.contains("lead-history-record"));
    // Oldest first, as saved.
    expect(records.map((r) => r.querySelector("b").textContent)).toEqual([
      "Manual call",
      "Manual call",
      "Manual call",
      "Note",
      "Follow-up for " + date("2026-11-10T09:00:00Z"),
    ]);
    expect(records[2]).toHaveTextContent(
      "By Owner (administrator) · not this agent's",
    );
    expect(records[2]).toHaveTextContent("Owner checked the budget.");
    expect(records[1]).toHaveTextContent("By Ali Agent");
    expect(records[1]).not.toHaveTextContent("not this agent's");
    expect(saraPeriod).toHaveTextContent("Assigned but never worked");
    expect(saraPeriod).toHaveTextContent("Nothing saved in this period.");
    expect(adminTeam).not.toHaveTextContent("never worked");
    expect(usmanPeriod).toHaveTextContent("Disabled account");
    expect(usmanPeriod).toHaveTextContent("Call attempted, not reached");
    expect(usmanPeriod).toHaveTextContent("End not recorded");
    expect(usmanPeriod).toHaveTextContent(
      "Historical value unavailable: none saved in this assignment",
    );
    expect(usmanPeriod).toHaveTextContent("Earlier");
    // Usman's call was logged with an earlier time: it shows when it was
    // saved, which is what puts it in Usman's assignment.
    expect(usmanPeriod).toHaveTextContent(
      `By Usman Agent · saved ${date("2026-11-10T05:01:00Z")}`,
    );
    expect(records[1]).not.toHaveTextContent("saved");
    expect(dialog).toHaveTextContent("Times are Pakistan time.");
  });

  it("offers only All Leads and Used 2–5 Times; a lead with more agents stays in All Leads with its history", async () => {
    const user = userEvent.setup();
    usage = { ...counts, 6: 3, 7: 1 };
    rows = [lead(1), lead(3, { agents_used: 7 })];
    open("/leads");
    await screen.findByText("Customer 3");
    await waitFor(() =>
      expect(
        within(usageSelect())
          .getAllByRole("option")
          .map((o) => [o.value, o.textContent]),
      ).toEqual([
        ["", "All Leads (41)"],
        ["2", "Used 2 Times (12)"],
        ["3", "Used 3 Times (5)"],
        ["4", "Used 4 Times (2)"],
        ["5", "Used 5 Times (1)"],
      ]),
    );
    // Its row says how many agents had it, and opens the full history.
    await user.click(
      screen.getByRole("button", {
        name: "Used 7 times: open the agent history of Customer 3",
      }),
    );
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        `/leads/${id(3)}/agent-history`,
        expect.anything(),
      ),
    );
  });

  it("says in Export that the export does not use Lead Usage", async () => {
    const user = userEvent.setup();
    open("/leads?usage=2");
    await screen.findByText("Customer 1");
    await user.click(screen.getByRole("button", { name: "Export" }));
    const dialog = await screen.findByRole("dialog", { name: "Export leads" });
    expect(within(dialog).getByRole("note")).toHaveTextContent(
      "All leads is showing Used 2 Times only. The export does not use Lead Usage",
    );
  });

  it("asks for update 075 when the database has no Lead Usage yet", async () => {
    usage = null;
    open("/leads");
    await screen.findByText("Customer 1");
    await waitFor(() => expect(usageSelect()).toBeDisabled());
    expect(usageSelect().closest("label")).toHaveAttribute(
      "title",
      "Lead Usage needs CRM database update 075.",
    );
    expect(
      within(usageSelect())
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([
      "All Leads",
      "Used 2 Times",
      "Used 3 Times",
      "Used 4 Times",
      "Used 5 Times",
    ]);
  });
});

describe("Lead Usage wording", () => {
  it("never calls a lead worked or reached unless its agent did it", () => {
    const owners = { agent_id: ali.id, ...empty };
    expect(periodWork({ ...owners }).level).toBe("never");
    // Only the owner's call: still never worked by Ali.
    const adminOnly = periodWork({
      ...owners,
      calls: [call(1, { recorded_by: owner.id, connected: true })],
    });
    expect([adminOnly.level, adminOnly.others, adminOnly.calls.length]).toEqual(
      ["never", 1, 0],
    );
    expect(
      periodWork({
        ...owners,
        notes: [{ id: "n", at: "x", written_by: ali.id }],
      }).level,
    ).toBe("other");
    expect(summaryText({ used: 0, worked: 0, reached: 0 })).toBe(
      "Not assigned to any agent yet.",
    );
    expect(summaryText({ used: 1, worked: 1, reached: 0 })).toBe(
      "Assigned to 1 agent, who saved work on it and did not reach the customer.",
    );
    expect(summaryText({ used: 4, worked: 0, reached: 0 })).toBe(
      "Assigned to 4 different agents. None of them saved any work on it.",
    );
    expect(summaryText({ used: 2, worked: 2, reached: 2 })).toBe(
      "Assigned to 2 different agents. All of them saved work on it; all reached the customer.",
    );
  });
});
