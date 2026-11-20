import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import { fullDayLabel } from "../src/lib/calendar";
import { rulesProblem, rulesStart, sameRules } from "../src/lib/kpiRules";
import { cellText } from "../src/components/kpis/KpiReport";
// The server's own table of what each CRM source can measure, as
// /kpis/manage sends it.
import { kpiSources } from "../../server/src/services/kpis.js";
// Update 076: administrators manage every KPI's rules, including the KPIs
// the CRM fills in. API responses are mocked; the server tests check the
// rules, dates, history and permissions in the database.
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
  id: "76200000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
  active: true,
};
const ali = {
  id: "76200000-0000-4000-8000-0000000000a2",
  role: "agent",
  name: "Ali Agent",
  active: true,
};
const kid = (n) => `76200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
// Wednesday 18 November 2026.
const list = {
  today: "2026-11-18",
  next_day: "2026-11-19",
  next_monday: "2026-11-23",
  sources: kpiSources,
};
const rules = (extra) => ({
  frequency: "day",
  answer_type: "yes_no",
  target: 1,
  expected: "yes",
  active: true,
  agent_ids: null,
  effective_from: "2026-11-02",
  version: 2,
  measure: "self",
  ...extra,
});
const kpi = (n, title, r, extra) => ({
  id: kid(n),
  title,
  question: `${title}?`,
  description: null,
  position: n,
  archived_at: null,
  answers: 4,
  current_answers: 1,
  corrects_now: false,
  rules: rules(r),
  scheduled: null,
  ...extra,
});
const kpis = () => [
  kpi(1, "Assigned calls answered", { measure: "calls" }),
  kpi(2, "Social media activity", { measure: "social" }),
  kpi(4, "Verified inventory with owner details", {
    answer_type: "number",
    target: 1,
    expected: null,
    measure: "inventory",
  }),
  kpi(6, "Brochures shared", {}),
];
let patched;
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  mocks.user = { ...owner };
  patched = [];
  mocks.api.mockImplementation(async (path, options = {}) => {
    if (path === "/kpis/manage") return { ...list, kpis: kpis() };
    if (path === "/users") return [ali, owner];
    if (options.method === "PATCH") {
      patched.push([path, options.body]);
      return {
        id: path.split("/").pop(),
        title: options.body.title,
        rules_from: options.body.frequency === "week" ? "2026-11-23" : null,
      };
    }
    return { data: [], count: 0 };
  });
});
function open() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={["/kpis?tab=manage"]}>
          <App />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}
async function edit(user, title) {
  open();
  await user.click(
    await screen.findByRole("button", { name: `Edit ${title}` }),
  );
  return screen.findByRole("dialog", { name: "Edit KPI" });
}
const option = (dialog, label, value) =>
  within(within(dialog).getByLabelText(label)).getByRole("option", {
    name: value,
  });

describe("Manage KPIs (update 076)", () => {
  it("lists each KPI's rules in one compact row, with its actions side by side", async () => {
    open();
    const table = await screen.findByRole("table");
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((h) => h.textContent),
    ).toEqual(["#", "KPI", "Rules", "Agents", "Status", "Actions"]);
    const row = within(table).getAllByRole("row")[3];
    expect(row).toHaveTextContent(
      "Daily · Number · 1 a dayCRM: verified listings with owner details",
    );
    const actions = row.querySelector(".kpi-actions");
    expect(
      within(actions)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Edit", "Archive"]);
  });

  it("switches Verified inventory to a weekly number: a target is chosen for the week, the start is shown, and the change is confirmed", async () => {
    const user = userEvent.setup();
    const dialog = await edit(user, "Verified inventory with owner details");
    // Nothing is locked any more.
    expect(within(dialog).getByLabelText("Frequency")).toBeEnabled();
    expect(within(dialog).getByLabelText("Answer type")).toBeEnabled();
    expect(dialog).toHaveTextContent(
      "Filled in by the CRM from verified listings with owner details",
    );
    await user.clear(within(dialog).getByLabelText("Question shown to agents"));
    await user.type(
      within(dialog).getByLabelText("Question shown to agents"),
      "How many verified property inventories with owner details did you complete?",
    );
    await user.selectOptions(
      within(dialog).getByLabelText("Frequency"),
      "week",
    );
    // The daily target is not carried over as a weekly one.
    const target = within(dialog).getByLabelText("Target per week");
    expect(target).toHaveValue("");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "Enter a whole number from 1 to 10,000 as the target per week.",
    );
    expect(patched).toEqual([]);
    await user.type(target, "3");
    expect(dialog).toHaveTextContent("3 a week");
    // When it starts, before saving.
    const status = within(dialog).getByRole("status");
    expect(status).toHaveTextContent(
      `New rules start ${fullDayLabel("2026-11-23")} (Pakistan time). Until then: Daily, 1 a day.`,
    );
    expect(status).toHaveTextContent(
      `First weekly period: ${fullDayLabel("2026-11-23")} to ${fullDayLabel("2026-11-29")}.`,
    );
    // Confirmed first.
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    const confirm = within(dialog).getByRole("heading", {
      name: "Confirm the new rules for Verified inventory with owner details",
    });
    expect(confirm).toHaveFocus();
    expect(dialog).toHaveTextContent("NowDaily, Number, 1 a day");
    expect(dialog).toHaveTextContent(
      `From ${fullDayLabel("2026-11-23")}Weekly, Number, 3 a week`,
    );
    expect(dialog).toHaveTextContent(
      "Counted fromThe CRM: verified listings with the owner's name and phone",
    );
    expect(patched).toEqual([]);
    // Back keeps what was typed.
    await user.click(
      within(dialog).getByRole("button", { name: "Back to editing" }),
    );
    expect(within(dialog).getByLabelText("Target per week")).toHaveValue("3");
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Confirm and save" }),
    );
    await waitFor(() => expect(patched.length).toBe(1));
    expect(patched[0]).toEqual([
      `/kpis/${kid(4)}`,
      {
        title: "Verified inventory with owner details",
        question:
          "How many verified property inventories with owner details did you complete?",
        description: null,
        frequency: "week",
        answer_type: "number",
        target: 3,
        active: true,
        agent_ids: null,
      },
    ]);
  });

  it("offers only what a CRM source can measure, and says why", async () => {
    const user = userEvent.setup();
    let dialog = await edit(user, "Assigned calls answered");
    expect(
      option(dialog, "Frequency", "Weekly (Monday to Sunday)"),
    ).toBeDisabled();
    expect(option(dialog, "Answer type", "Number")).toBeDisabled();
    expect(option(dialog, "Expected answer", "No")).toBeDisabled();
    expect(dialog).toHaveTextContent(
      "Weekly is not available: Assigned calls is decided day by day",
    );
    expect(dialog).toHaveTextContent(
      "Number is not available: Assigned calls has no number to reach",
    );
    expect(dialog).toHaveTextContent(
      "Yes when: Every lead due that day got its first call by its deadline.",
    );
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    // Social as a number: at most 5 a day, refused before saving.
    dialog = await (async () => {
      await user.click(
        screen.getByRole("button", { name: "Edit Social media activity" }),
      );
      return screen.findByRole("dialog", { name: "Edit KPI" });
    })();
    await user.selectOptions(
      within(dialog).getByLabelText("Answer type"),
      "number",
    );
    await user.type(within(dialog).getByLabelText("Target per day"), "6");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Agents can add up to 5 social media links a day",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    expect(within(dialog).getByRole("alert")).toHaveTextContent(
      "at most 5 a day or 35 a week",
    );
    expect(patched).toEqual([]);
  });

  it("lets an agents' own Yes/No KPI expect No, and saves wording at once without asking", async () => {
    const user = userEvent.setup();
    const dialog = await edit(user, "Brochures shared");
    expect(option(dialog, "Expected answer", "No")).toBeEnabled();
    await user.selectOptions(
      within(dialog).getByLabelText("Expected answer"),
      "no",
    );
    expect(dialog).toHaveTextContent("Met on a day answered No.");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      `New rules start ${fullDayLabel("2026-11-19")}`,
    );
    // Back to Yes: only the wording changes.
    await user.selectOptions(
      within(dialog).getByLabelText("Expected answer"),
      "yes",
    );
    await user.type(within(dialog).getByLabelText("Title"), " today");
    expect(within(dialog).getByRole("status")).toHaveTextContent(
      "Only the wording changes. It shows at once",
    );
    await user.click(
      within(dialog).getByRole("button", { name: "Save changes" }),
    );
    await waitFor(() => expect(patched.length).toBe(1));
    expect(patched[0][1]).toMatchObject({
      title: "Brochures shared today",
      answer_type: "yes_no",
      expected: "yes",
    });
  });
});

describe("KPI rules helpers (update 076)", () => {
  const cur = rules({
    frequency: "day",
    answer_type: "number",
    target: 1,
    expected: null,
  });
  const k = { rules: cur, scheduled: null, corrects_now: false };
  it("says when new rules start, as the database decides", () => {
    expect(rulesStart(list, null, { frequency: "day" })).toEqual({
      date: "2026-11-18",
      now: true,
    });
    expect(rulesStart(list, null, { frequency: "week" })).toEqual({
      date: "2026-11-16",
      now: true,
    });
    expect(rulesStart(list, k, { ...cur, target: 2 })).toEqual({
      date: "2026-11-19",
      now: false,
    });
    expect(
      rulesStart(list, k, { ...cur, frequency: "week", target: 3 }),
    ).toEqual({ date: "2026-11-23", now: false });
    // Weekly to daily waits for the week too.
    const weekly = { ...k, rules: { ...cur, frequency: "week" } };
    expect(rulesStart(list, weekly, { ...cur, frequency: "day" })).toEqual({
      date: "2026-11-23",
      now: false,
    });
    // An agents' own KPI no one answered under today's rules: at once.
    expect(
      rulesStart(list, { ...k, corrects_now: true }, { ...cur, target: 2 }),
    ).toEqual({ date: "2026-11-18", now: true });
    expect(
      rulesStart(
        list,
        { ...k, corrects_now: true },
        { ...cur, frequency: "week" },
      ),
    ).toEqual({ date: "2026-11-23", now: false });
    // The rules in effect again cancel a waiting change; the waiting rules
    // keep it.
    const waiting = {
      ...k,
      scheduled: { ...cur, target: 5, effective_from: "2026-11-19" },
    };
    expect(rulesStart(list, waiting, { ...cur })).toEqual({
      cancels: "2026-11-19",
    });
    expect(rulesStart(list, waiting, { ...cur, target: 5 })).toEqual({
      date: "2026-11-19",
      keeps: true,
    });
    expect(rulesStart(list, k, { ...cur })).toBeNull();
    expect(sameRules({ ...cur, target: "1" }, cur)).toBe(true);
  });

  it("refuses what the server refuses", () => {
    const r = (x) => ({
      frequency: "day",
      answer_type: "number",
      target: 1,
      expected: "yes",
      ...x,
    });
    expect(
      rulesProblem(
        kpiSources,
        "self",
        r({ answer_type: "yes_no", expected: "no" }),
      ),
    ).toBeNull();
    expect(
      rulesProblem(
        kpiSources,
        "inventory",
        r({ frequency: "week", target: 500 }),
      ),
    ).toBeNull();
    expect(rulesProblem(kpiSources, "video", r({ target: 3 }))).toMatch(
      /at most 2 a day/,
    );
    expect(
      rulesProblem(
        kpiSources,
        "calls",
        r({ frequency: "week", answer_type: "yes_no" }),
      ),
    ).toMatch(/day by day/);
    expect(
      rulesProblem(
        kpiSources,
        "visits",
        r({ answer_type: "yes_no", expected: "no" }),
      ),
    ).toMatch(/expects Yes/);
  });

  it("shows each daily target a range used in Results", () => {
    const text = cellText(
      { id: kid(4), measure: "inventory", answer_type: "number", target: 2 },
      {
        entries: {},
        daily: {
          days: 4,
          met: 3,
          below: 1,
          missed: 0,
          pending: 0,
          total: 6,
          answer_type: "number",
          target: 1,
          rules: [
            {
              from: "2026-11-16",
              answer_type: "number",
              target: 1,
              expected: null,
            },
            {
              from: "2026-11-18",
              answer_type: "number",
              target: 2,
              expected: null,
            },
          ],
          review: 0,
          not_due: 0,
          detail: null,
        },
      },
      false,
    );
    expect(text).toMatch(
      /^Met 3\/4 days · 6 total · 1 a day from .*16.*, 2 a day from .*18/,
    );
  });
});
