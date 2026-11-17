import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import {
  adminNavigation,
  agentNavigation,
} from "../src/components/layout/navigation";
import { kpiRange } from "../src/lib/kpiPeriods";
import { cellText } from "../src/components/kpis/KpiReport";
// Update 070: Daily KPIs replace Team targets and My targets. API responses
// are mocked; the server tests check the rules, permissions and numbers.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const owner = {
  id: "70200000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
  active: true,
};
const ali = {
  id: "70200000-0000-4000-8000-0000000000a2",
  role: "agent",
  name: "Ali Agent",
  active: true,
};
const kid = (n) => `70200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const item = (n, extra) => ({
  id: kid(n),
  description: null,
  answer: null,
  answered_question: null,
  submitted_at: null,
  updated_at: null,
  editable: true,
  ...extra,
});
function myDay(answers = {}) {
  return {
    agent: { id: ali.id, name: "Ali Agent" },
    today,
    day: today,
    day_status: "work",
    week: { start: today, end: today },
    editable_from: today,
    answered: 0,
    expected: 3,
    kpis: [
      item(1, {
        title: "Assigned calls answered",
        question: "Did you answer your assigned calls today?",
        frequency: "day",
        answer_type: "yes_no",
        target: 1,
        met: null,
        answer: answers[1] ?? null,
      }),
      item(2, {
        title: "Verified inventory",
        question: "How many verified inventories today?",
        frequency: "day",
        answer_type: "number",
        target: 1,
        met: null,
        answer: answers[2] ?? null,
      }),
      item(3, {
        title: "Project visits",
        question: "How many project visits did you complete today?",
        frequency: "week",
        answer_type: "number",
        target: 3,
        week: {
          start: today,
          end: today,
          total: 2,
          target: 3,
          status: "in_progress",
          days: [{ day: today, value: 2 }],
        },
        answer: 2,
      }),
    ],
    history: { kpis: [], days: [], weeks: [] },
  };
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
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const calls = (prefix) =>
  mocks.api.mock.calls.filter(([p]) => p.startsWith(prefix));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  mocks.api.mockReset();
});

describe("menus", () => {
  it("shows Daily KPIs in place of Team targets and My targets", () => {
    const labels = (nav) =>
      nav.flatMap((s) => s.links.map(([to, label]) => `${to} ${label}`));
    expect(labels(adminNavigation)).toContain("/kpis Daily KPIs");
    expect(labels(agentNavigation)).toContain("/kpis Daily KPIs");
    expect(labels(adminNavigation).join()).not.toMatch(/Team targets/);
    expect(labels(agentNavigation).join()).not.toMatch(/My targets/);
  });
  it("works out each period in Pakistan days, weeks from Monday", () => {
    const thursday = "2026-11-12";
    expect(kpiRange("today", thursday)).toEqual({
      from: thursday,
      to: thursday,
    });
    expect(kpiRange("yesterday", thursday)).toEqual({
      from: "2026-11-11",
      to: "2026-11-11",
    });
    expect(kpiRange("this_week", thursday)).toEqual({
      from: "2026-11-09",
      to: thursday,
    });
    expect(kpiRange("last_week", thursday)).toEqual({
      from: "2026-11-02",
      to: "2026-11-08",
    });
    expect(kpiRange("this_month", thursday)).toEqual({
      from: "2026-11-01",
      to: thursday,
    });
    expect(kpiRange("this_week", "2026-11-09")).toEqual({
      from: "2026-11-09",
      to: "2026-11-09",
    });
    expect(kpiRange("custom", thursday)).toBeNull();
  });
});

describe("an agent's Daily KPIs", () => {
  beforeEach(() => {
    mocks.user = { ...ali };
  });
  it("starts with nothing chosen, keeps 0 apart from blank, refuses non-numbers and saves only changes", async () => {
    const user = userEvent.setup();
    let body;
    mocks.api.mockImplementation(async (path, options = {}) => {
      if (path.startsWith("/kpis/my/") && options.method === "PUT") {
        body = options.body;
        return { ...myDay({ 1: false, 2: 0 }), answered: 3, saved: 2 };
      }
      if (path.startsWith("/kpis/my")) return myDay();
      return { data: [], count: 0 };
    });
    open("/kpis");
    const yesNo = await screen.findByRole("radiogroup", {
      name: "Did you answer your assigned calls today?",
    });
    for (const option of within(yesNo).getAllByRole("radio"))
      expect(option).toHaveAttribute("aria-checked", "false");
    const save = screen.getByRole("button", { name: "Saved" });
    expect(save).toBeDisabled();
    // Weekly progress so far.
    expect(screen.getByText("This week: 2/3")).toBeInTheDocument();
    await user.click(within(yesNo).getByRole("radio", { name: "No" }));
    expect(within(yesNo).getByRole("radio", { name: "No" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const count = screen.getByRole("textbox", {
      name: "How many verified inventories today?",
    });
    await user.type(count, "abc");
    expect(
      screen.getByText("Enter a whole number from 0 to 1,000."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Save 1 answer" }),
    ).toBeDisabled();
    await user.clear(count);
    // Blank is no answer; 0 is an answer.
    expect(screen.getByRole("button", { name: "Save 1 answer" })).toBeEnabled();
    await user.type(count, "0");
    await user.click(screen.getByRole("button", { name: "Save 2 answers" }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({
      answers: [
        { kpi_id: kid(1), answer: false },
        { kpi_id: kid(2), answer: 0 },
      ],
    });
    expect(calls("/kpis/my/")[0][0]).toBe(`/kpis/my/${today}`);
    expect(await screen.findByText(/Saved 2 answers for/)).toBeInTheDocument();
  });
  it("shows a closed answer as read only", async () => {
    mocks.api.mockImplementation(async (path) => {
      if (path.startsWith("/kpis/my")) {
        const day = myDay({ 1: true });
        day.kpis[0].editable = false;
        return day;
      }
      return { data: [], count: 0 };
    });
    open("/kpis");
    const yesNo = await screen.findByRole("radiogroup", {
      name: "Did you answer your assigned calls today?",
    });
    expect(within(yesNo).getByRole("radio", { name: "Yes" })).toBeDisabled();
    expect(within(yesNo).getByRole("radio", { name: "Yes" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(
      screen.getByText("Daily KPIs are answered on the day."),
    ).toBeInTheDocument();
  });
});

describe("administrators' Daily KPIs", () => {
  beforeEach(() => {
    mocks.user = { ...owner };
  });
  const report = {
    from: today,
    to: today,
    today,
    weeks: [{ start: today, end: today }],
    kpis: [
      {
        id: kid(1),
        title: "Assigned calls answered",
        frequency: "day",
        answer_type: "yes_no",
        target: 1,
      },
      {
        id: kid(3),
        title: "Project visits",
        frequency: "week",
        answer_type: "number",
        target: 3,
      },
    ],
    agents: [
      {
        id: ali.id,
        name: "Ali Agent",
        active: true,
        entries: { expected: 2, answered: 1, missing: 0, pending: 1 },
        overall: { met: 1, due: 1, pending: 1, missing: 0, status: "on_track" },
        cells: {
          [kid(1)]: {
            entries: {},
            daily: {
              days: 1,
              met: 1,
              below: 0,
              missed: 0,
              pending: 0,
              total: 1,
              answer_type: "yes_no",
            },
            day: { value: true, met: true, state: "answered" },
          },
          [kid(3)]: {
            entries: {},
            weekly: {
              weeks: [
                {
                  start: today,
                  end: today,
                  total: 3,
                  target: 3,
                  status: "met",
                },
              ],
              met: 1,
              missed: 0,
              in_progress: 0,
              total: 3,
            },
            day: { value: 1, met: null, state: "answered" },
          },
        },
      },
      {
        id: kid(9),
        name: "Sara Agent",
        active: false,
        entries: { expected: 2, answered: 0, missing: 0, pending: 2 },
        overall: { met: 0, due: 0, pending: 2, missing: 0, status: "pending" },
        cells: {
          [kid(1)]: {
            entries: {},
            day: { value: null, met: null, state: "pending" },
          },
        },
      },
    ],
  };
  it("shows each agent's day, with weekly progress, and opens an agent's history", async () => {
    const user = userEvent.setup();
    mocks.api.mockImplementation(async (path) => {
      if (path.startsWith("/kpis/report?")) return report;
      if (path.startsWith("/kpis/history?"))
        return {
          agent: { id: ali.id },
          from: today,
          to: today,
          today,
          kpis: report.kpis,
          days: [
            {
              day: today,
              status: "work",
              answers: {
                [kid(1)]: { value: true, met: true, state: "answered" },
              },
            },
          ],
          weeks: [],
        };
      if (path === "/users") return [ali, owner];
      return { data: [], count: 0 };
    });
    open("/kpis");
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual([
      "Agent",
      "Answers",
      "Assigned calls answeredYes daily",
      "Project visits3 a week",
      "Overall",
    ]);
    const [, aliRow, saraRow] = within(table).getAllByRole("row");
    expect(aliRow).toHaveTextContent("Yes");
    expect(aliRow).toHaveTextContent("1 today · week 3/3 · Met");
    expect(aliRow).toHaveTextContent("On track");
    expect(saraRow).toHaveTextContent("Pending");
    expect(saraRow).toHaveTextContent("Disabled");
    expect(calls("/kpis/report?")[0][0]).toBe(
      `/kpis/report?from=${today}&to=${today}`,
    );
    // Period and agent filters go to the server.
    await user.click(screen.getByRole("tab", { name: "This month" }));
    await waitFor(() =>
      expect(calls("/kpis/report?").at(-1)[0]).toContain(
        `from=${today.slice(0, 8)}01`,
      ),
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Agent" }),
      ali.id,
    );
    await waitFor(() =>
      expect(calls("/kpis/report?").at(-1)[0]).toContain(`agent=${ali.id}`),
    );
    await user.click(screen.getByRole("button", { name: "Ali Agent" }));
    expect(
      await screen.findByRole("dialog", {
        name: "Ali Agent: Daily KPI history",
      }),
    ).toBeInTheDocument();
    expect(calls("/kpis/history?")[0][0]).toContain(`agent=${ali.id}`);
  });
  it("lists KPIs with any waiting change, creates one, and offers Delete only without answers", async () => {
    const user = userEvent.setup();
    let created;
    mocks.api.mockImplementation(async (path, options = {}) => {
      if (path === "/kpis" && options.method === "POST") {
        created = options.body;
        return { id: kid(7), title: options.body.title };
      }
      if (path === "/kpis/manage")
        return {
          today,
          kpis: [
            {
              id: kid(1),
              title: "Assigned calls answered",
              question: "Did you answer?",
              position: 1,
              archived_at: null,
              answers: 12,
              rules: {
                frequency: "day",
                answer_type: "yes_no",
                target: 1,
                active: true,
                agent_ids: null,
              },
              scheduled: null,
            },
            {
              id: kid(3),
              title: "Project visits",
              question: "How many visits?",
              position: 3,
              archived_at: null,
              answers: 0,
              rules: {
                frequency: "week",
                answer_type: "number",
                target: 3,
                active: true,
                agent_ids: null,
              },
              scheduled: {
                frequency: "week",
                answer_type: "number",
                target: 4,
                active: true,
                agent_ids: null,
                effective_from: "2026-11-23",
              },
            },
          ],
        };
      if (path === "/users") return [ali, owner];
      return { data: [], count: 0 };
    });
    open("/kpis?tab=manage");
    const table = await screen.findByRole("table");
    const [, calls_, visits] = within(table).getAllByRole("row");
    expect(calls_).toHaveTextContent("Yes / No");
    expect(within(calls_).queryByRole("button", { name: /Delete/ })).toBeNull();
    expect(visits).toHaveTextContent("3 a week");
    expect(visits).toHaveTextContent("Change waiting from");
    expect(visits).toHaveTextContent("4 a week");
    expect(
      within(visits).getByRole("button", { name: "Delete Project visits" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "+ New KPI" }));
    const dialog = await screen.findByRole("dialog", { name: "New KPI" });
    expect(
      within(dialog).getByText("Expected answer: Yes"),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Title"), "Video");
    await user.type(
      within(dialog).getByLabelText("Question shown to agents"),
      "How many videos today?",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("Frequency"),
      "week",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("Answer type"),
      "number",
    );
    await user.clear(within(dialog).getByLabelText("Target (per week)"));
    await user.type(within(dialog).getByLabelText("Target (per week)"), "1");
    await user.click(
      within(dialog).getByRole("button", { name: "Create KPI" }),
    );
    await waitFor(() => expect(created).toBeDefined());
    expect(created).toEqual({
      title: "Video",
      question: "How many videos today?",
      description: null,
      frequency: "week",
      answer_type: "number",
      target: 1,
      active: true,
      agent_ids: null,
    });
  });
});

describe("report cells", () => {
  const visits = { frequency: "week", answer_type: "number", target: 3 };
  const calls = { frequency: "day", answer_type: "yes_no", target: 1 };
  it("reads a range's daily days, weekly weeks and the running week", () => {
    expect(
      cellText(
        calls,
        {
          daily: {
            answer_type: "yes_no",
            days: 6,
            met: 4,
            below: 1,
            missed: 1,
            pending: 0,
            total: 4,
          },
        },
        false,
      ),
    ).toBe("Yes 4/6 days · 1 missed");
    expect(
      cellText(
        visits,
        {
          weekly: {
            weeks: [
              { start: "2026-11-02", total: 4, target: 3, status: "met" },
              { start: "2026-11-09", total: 1, target: 3, status: "missed" },
              {
                start: "2026-11-16",
                total: 2,
                target: 3,
                status: "in_progress",
              },
            ],
            met: 1,
            missed: 1,
            in_progress: 1,
            total: 7,
          },
        },
        false,
      ),
    ).toBe("Met 1/2 weeks · this week 2/3 · 7 total");
    expect(cellText(calls, { day: { state: "missed" } }, true)).toBe("Missed");
    expect(cellText(calls, undefined, true)).toBe("—");
  });
});
