import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
// Update 091: Auto Assign Settings on All leads → Unassigned. API responses
// are mocked; the server tests check the rules, the batches and the locks.
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
  id: "91c00000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
  active: true,
};
const agent = (n, name) => ({
  id: `91c00000-0000-4000-8000-0000000000b${n}`,
  role: "agent",
  name,
  active: true,
});
const abru = agent(1, "Abru"),
  shiza = agent(2, "Shiza"),
  alisha = agent(3, "Alisha");
let saved, sent;
const statusFor = (values = {}) => ({
  version: 0,
  state: "off",
  batch_size: 20,
  scope: "new",
  active_since: null,
  updated_at: "2026-11-27T08:00:00Z",
  updated_by: null,
  updated_by_name: null,
  last_batch_at: null,
  last_error: null,
  last_error_at: null,
  failures: 0,
  rules: [],
  problem: null,
  counts: {
    eligible: 47,
    new: 0,
    backlog: 47,
    waiting: 0,
    batches: 0,
    leftover: 0,
  },
  next: null,
  today: 0,
  worker: {
    running: false,
    has_job: false,
    last_run_at: null,
    last_status: null,
  },
  batches: [],
  ...values,
});
beforeEach(() => {
  vi.clearAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  mocks.user = { ...owner };
  saved = statusFor();
  sent = [];
  mocks.api.mockImplementation(async (path, options = {}) => {
    if (options.method && options.method !== "GET")
      sent.push([options.method, path, options.body]);
    if (path === "/leads/auto-assign") {
      if (options.method === "PUT") {
        if (options.body.version !== saved.version)
          throw new Error(
            "Another administrator changed these settings after you opened them. Check them and save again.",
          );
        saved = statusFor({
          ...saved,
          version: saved.version + 1,
          state: options.body.state,
          batch_size: options.body.batch_size,
          scope: options.body.scope,
          updated_by_name: "Owner",
          rules: options.body.agents.map((a) => ({
            ...a,
            name: [abru, shiza, alisha].find((x) => x.id === a.agent_id).name,
            active: true,
          })),
        });
      }
      return saved;
    }
    if (path === "/leads/auto-assign/preview") {
      const n = options.body.batch_size;
      const waiting = options.body.scope === "backlog" ? 47 : 0;
      return {
        agents: options.body.agents.map((a) => ({
          agent_id: a.agent_id,
          count: Math.round((n * a.percent) / 100),
        })),
        counts: {
          waiting,
          batches: Math.floor(waiting / n),
          leftover: waiting % n,
        },
      };
    }
    if (path === "/leads/auto-assign/state") {
      saved = statusFor({
        ...saved,
        version: saved.version + 1,
        state: options.body.state,
      });
      return saved;
    }
    if (path === "/leads/auto-assign/run")
      return { status: "assigned", assigned: 40, batches: [{}, {}] };
    if (path.startsWith("/leads/all?"))
      return {
        page: 1,
        limit: 20,
        count: 0,
        totals: { total: 60, assigned: 13, unassigned: 47 },
        data: [],
      };
    if (path === "/users") return [owner, abru, shiza, alisha];
    if (path.startsWith("/lead-imports?")) return { data: [], count: 0 };
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
const dialog = () =>
  screen.findByRole("dialog", { name: "Auto Assign Settings" });

describe("Auto Assign Settings (update 091)", () => {
  it("is offered with the Unassigned leads only, to administrators", async () => {
    const all = open("/leads");
    await screen.findByRole("button", { name: /^Unassigned/ });
    expect(
      screen.queryByRole("button", { name: "Auto Assign Settings" }),
    ).toBeNull();
    all.unmount();
    const unassigned = open("/leads?assignment=unassigned");
    expect(
      await screen.findByRole("button", { name: "Auto Assign Settings" }),
    ).toBeInTheDocument();
    unassigned.unmount();
    open("/leads/never-assigned");
    await screen.findByRole("heading", { name: "Never Worked" });
    expect(
      screen.queryByRole("button", { name: "Auto Assign Settings" }),
    ).toBeNull();
  });

  it("checks the numbers as they are typed, previews each agent's share, and switches on only after confirming which leads", async () => {
    const user = userEvent.setup();
    open("/leads?assignment=unassigned");
    await user.click(
      await screen.findByRole("button", { name: "Auto Assign Settings" }),
    );
    const box = await dialog();
    expect(within(box).getByText("Disabled")).toBeInTheDocument();
    expect(
      within(box).getByText(/^Not running: automatic batches wait/),
    ).toBeInTheDocument();
    const save = () =>
      within(box).getByRole("button", { name: "Save settings" });
    expect(save()).toBeDisabled();
    await user.click(
      within(box).getByRole("checkbox", {
        name: "Enable automatic assignment",
      }),
    );
    for (const a of [abru, shiza, alisha])
      await user.click(within(box).getByRole("checkbox", { name: a.name }));
    await user.type(within(box).getByLabelText("Percentage for Abru"), "20");
    await user.type(within(box).getByLabelText("Percentage for Shiza"), "30");
    await user.type(within(box).getByLabelText("Percentage for Alisha"), "40");
    expect(
      within(box).getByText("The percentages must add up to exactly 100."),
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await user.clear(within(box).getByLabelText("Percentage for Alisha"));
    await user.type(within(box).getByLabelText("Percentage for Alisha"), "50");
    // A batch of 0 is refused too.
    const batch = within(box).getByLabelText("Leads per batch");
    await user.clear(batch);
    await user.type(batch, "0");
    expect(
      within(box).getByText("Enter a batch of 1 to 500 leads."),
    ).toBeInTheDocument();
    await user.clear(batch);
    await user.type(batch, "20");
    // The preview: 4 / 6 / 10 of 20; including the waiting leads shows them.
    await user.click(
      within(box).getByRole("radio", {
        name: /Include the eligible leads already waiting \(47 leads\)/,
      }),
    );
    await within(box).findByText(
      /^Preview: 47 eligible leads waiting · 2 complete batches · 7 leads left until the next batch\./,
    );
    const rows = within(box)
      .getAllByRole("row")
      .slice(1, 4)
      .map((r) => r.textContent);
    expect(rows.map((r) => r.match(/(\d+)Remove$/)?.[1])).toEqual([
      "4",
      "6",
      "10",
    ]);
    await user.click(save());
    expect(
      within(box).getByText(
        /^Switch on automatic assignment\? Every 20 eligible leads will be shared among 3 agents\. The 47 leads already waiting are included: 2 batches can be assigned straight away\./,
      ),
    ).toBeInTheDocument();
    expect(sent.filter(([m]) => m === "PUT")).toEqual([]);
    await user.click(within(box).getByRole("button", { name: "Switch on" }));
    await waitFor(() =>
      expect(sent.filter(([m]) => m === "PUT")).toEqual([
        [
          "PUT",
          "/leads/auto-assign",
          {
            version: 0,
            state: "on",
            batch_size: 20,
            scope: "backlog",
            agents: [
              { agent_id: abru.id, percent: 20 },
              { agent_id: shiza.id, percent: 30 },
              { agent_id: alisha.id, percent: 50 },
            ],
          },
        ],
      ]),
    );
    expect(await within(box).findByText("Enabled")).toBeInTheDocument();
    // Every preview was asked only with numbers that add up.
    expect(
      sent
        .filter(([, p]) => p === "/leads/auto-assign/preview")
        .every(
          ([, , b]) => b.agents.reduce((n, a) => n + a.percent, 0) === 100,
        ),
    ).toBe(true);
  });

  it("pauses at once, runs now after confirming, resumes, and shows a change made by another administrator", async () => {
    const user = userEvent.setup();
    saved = statusFor({
      version: 4,
      state: "on",
      scope: "new",
      active_since: "2026-11-27T07:00:00Z",
      updated_by_name: "Owner",
      rules: [
        { agent_id: abru.id, name: "Abru", percent: 40, active: true },
        { agent_id: alisha.id, name: "Alisha", percent: 60, active: true },
      ],
      counts: {
        eligible: 47,
        new: 45,
        backlog: 2,
        waiting: 45,
        batches: 2,
        leftover: 5,
      },
      worker: {
        running: true,
        has_job: true,
        last_run_at: "2026-11-27T08:10:00Z",
        last_status: "success",
      },
      batches: [
        {
          id: "b1",
          created_at: "2026-11-27T08:05:00Z",
          trigger: "automatic",
          actor_name: null,
          assigned: 20,
          status: "assigned",
          allocation: [
            { agent_id: abru.id, name: "Abru", count: 8 },
            { agent_id: alisha.id, name: "Alisha", count: 12 },
          ],
        },
      ],
    });
    open("/leads?assignment=unassigned");
    await user.click(
      await screen.findByRole("button", { name: "Auto Assign Settings" }),
    );
    const box = await dialog();
    expect(within(box).getByText(/^Running auto assign/)).toBeInTheDocument();
    expect(within(box).getByText("Abru: 8 · Alisha: 12")).toBeInTheDocument();
    // Run now asks first.
    await user.click(within(box).getByRole("button", { name: "Run now" }));
    expect(
      within(box).getByText(
        /^Assign the complete batches waiting now \(2 batches of 20/,
      ),
    ).toBeInTheDocument();
    await user.click(
      within(box).getAllByRole("button", { name: "Run now" }).at(-1),
    );
    await waitFor(() =>
      expect(sent.at(-1)).toEqual(["POST", "/leads/auto-assign/run", {}]),
    );
    expect(await screen.findByText("40 leads assigned")).toBeInTheDocument();
    // Pause, then resume.
    await user.click(within(box).getByRole("button", { name: "Pause" }));
    expect(await within(box).findByText("Paused")).toBeInTheDocument();
    expect(sent.at(-1)).toEqual([
      "POST",
      "/leads/auto-assign/state",
      { state: "paused" },
    ]);
    expect(within(box).queryByRole("button", { name: "Run now" })).toBeNull();
    await user.click(within(box).getByRole("button", { name: "Resume" }));
    expect(await within(box).findByText("Enabled")).toBeInTheDocument();
    // Another administrator saved meanwhile: refused, nothing changed.
    saved = { ...saved, version: saved.version + 1 };
    await user.click(
      within(box).getByRole("button", { name: "Save settings" }),
    );
    await user.click(within(box).getByRole("button", { name: "Save" }));
    expect(
      await within(box).findByText(
        /^Another administrator changed these settings/,
      ),
    ).toBeInTheDocument();
  });
});
