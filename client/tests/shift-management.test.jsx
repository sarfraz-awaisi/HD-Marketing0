import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import { addDays, todayPk } from "../src/lib/calendar";
// Update 048: Shift management in Attendance management, and employees
// seeing where their timing comes from. API responses are mocked; the server
// tests check the same rules against the database.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = {
  id: "e8000000-0000-4000-8000-000000000001",
  uid: 663118,
  name: "HD Administrator",
  role: "admin",
  active: true,
};
const ali = "e8000000-0000-4000-8000-000000000002";
const MEDIA = "d8000000-0000-4000-8000-000000000020";
const V = (n) => String(n).repeat(32);
const company = {
  name: "HD Marketing standard",
  shift_start: "10:00",
  shift_end: "18:00",
  work_days: [1, 2, 3, 4, 5, 6],
  grace_minutes: 15,
  effective_from: "2026-10-01",
};
const timing = (start, end, days = [1, 2, 3, 4, 5, 6], grace = 15) => ({
  shift_start: start,
  shift_end: end,
  work_days: days,
  grace_minutes: grace,
});
const overview = () => ({
  today: todayPk(),
  company,
  roles: [
    {
      role: "agent",
      name: "Agents",
      current: null,
      planned: [],
      version: V(1),
      members: 2,
      following: 0,
    },
    {
      role: "staff",
      name: "Staff",
      current: {
        id: "s1",
        effective_from: "2026-10-20",
        inherits: false,
        ...timing("09:00", "17:00", [1, 2, 3, 4, 5], 10),
      },
      planned: [],
      version: V(2),
      members: 3,
      following: 1,
    },
  ],
  departments: [
    {
      id: MEDIA,
      name: "Media",
      active: true,
      current: {
        id: "d1",
        effective_from: "2026-10-20",
        inherits: false,
        ...timing("12:00", "20:00"),
      },
      planned: [
        {
          id: "d2",
          effective_from: "2026-11-10",
          inherits: false,
          ...timing("11:00", "19:00"),
        },
      ],
      version: V(3),
      members: 2,
      following: 1,
    },
    {
      id: "d8000000-0000-4000-8000-000000000030",
      name: "Technical",
      active: true,
      current: null,
      planned: [],
      version: V(4),
      members: 1,
      following: 0,
    },
  ],
  individual: 1,
});
const aliShift = {
  source: "individual",
  source_label: "Individual shift",
  label: "Individual shift",
  ...timing("14:00", "22:00", [1, 2, 3, 4, 5, 6], 10),
  effective_from: "2026-10-25",
  upcoming: null,
};
const row = (extra = {}) => ({
  id: ali,
  uid: 962837,
  name: "Ali Editor",
  email: "ali@gmail.com",
  role: "staff",
  active: true,
  department_id: MEDIA,
  department: "Media",
  shift: aliShift,
  version: V(5),
  planned: [],
  ...extra,
});
let routes;
const calls = (method, path) =>
  mocks.api.mock.calls.filter(
    ([p, o]) => p.startsWith(path) && (o?.method || "GET") === method,
  );
function open(path) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  mocks.user = { ...admin };
  routes = {
    "/admin/attendance/shifts": () => overview(),
    "/admin/attendance/shifts/employees": () => ({
      date: todayPk(),
      count: 2,
      page: 1,
      limit: 20,
      data: [
        row(),
        row({
          id: "e8000000-0000-4000-8000-000000000003",
          uid: 555111,
          name: "Bilal Editor",
          email: "bilal@gmail.com",
          shift: {
            source: "department",
            source_label: "Media department shift",
            ...timing("12:00", "20:00"),
            upcoming: null,
          },
        }),
      ],
      summary: { individual: 1, department: 1, role: 3, company: 2 },
    }),
    [`/admin/attendance/shifts/employees/${ali}`]: () => ({
      id: ali,
      uid: 962837,
      name: "Ali Editor",
      role: "staff",
      department: "Media",
      shift: aliShift,
      shift_version: V(5),
      shifts: [
        {
          id: "i1",
          effective_from: "2026-10-25",
          source: "individual",
          inherits: false,
          label: "Individual shift",
          ...timing("14:00", "22:00", [1, 2, 3, 4, 5, 6], 10),
          upcoming: false,
          withdrawn_at: null,
        },
      ],
    }),
    "/admin/attendance/shifts/history": () => ({
      count: 3,
      page: 1,
      limit: 20,
      data: [
        {
          id: "h1",
          scope: "individual",
          target_name: "Ali Editor",
          uid: 962837,
          effective_from: "2026-10-25",
          inherits: false,
          ...timing("14:00", "22:00", [1, 2, 3, 4, 5, 6], 10),
          reason: "Evening shoots",
          status: "current",
          created_by_name: "HD Administrator",
          created_at: "2026-10-24T08:00:00Z",
        },
        {
          id: "h2",
          scope: "department",
          target_name: "Media",
          uid: null,
          effective_from: "2026-11-10",
          inherits: false,
          ...timing("11:00", "19:00"),
          reason: null,
          status: "planned",
          created_by_name: "HD Administrator",
          created_at: "2026-10-23T08:00:00Z",
        },
        {
          id: "h3",
          scope: "role",
          target_name: "Staff",
          uid: null,
          effective_from: "2026-10-22",
          inherits: true,
          reason: null,
          status: "withdrawn",
          created_by_name: "HD Administrator",
          created_at: "2026-10-21T08:00:00Z",
          withdrawn_by_name: "HD Administrator",
        },
      ],
    }),
    "/attendance/me": () => ({
      date: todayPk(),
      employee: { id: ali, name: "Ali Editor", role: "staff" },
      policy: {
        name: "Media department shift",
        ...timing("12:00", "20:00"),
        timezone: "Asia/Karachi",
        assigned: false,
        source: "department",
        source_label: "Media department shift",
        upcoming: {
          effective_from: "2026-11-10",
          source: "individual",
          source_label: "Individual shift",
          ...timing("14:00", "22:00"),
        },
      },
      today: { state: "not_checked_in", scheduled: true },
      month: {},
      recent: [],
      incomplete: [],
    }),
  };
  mocks.api.mockImplementation(async (path, options) => {
    const handler = Object.entries(routes)
      .sort(([a], [b]) => b.length - a.length)
      .find(
        ([p]) =>
          path === p ||
          path.startsWith(p + "?") ||
          (p.endsWith("/") ? path.startsWith(p) : path.startsWith(p + "/")),
      )?.[1];
    if (handler && (options?.method || "GET") === "GET")
      return handler(path, options);
    if (
      options?.method === "POST" &&
      path.startsWith("/admin/attendance/shifts/employees/")
    )
      return routes[`/admin/attendance/shifts/employees/${ali}`]();
    if (options?.method) return overview();
    return { data: [], count: 0 };
  });
});
const shiftsTab = async (view = "roles") => {
  open(`/attendance-management?tab=shifts&view=${view}`);
  return screen.findByRole("tab", { name: "Shift management" });
};

describe("Shift management", () => {
  it("is a section of Attendance management with four views", async () => {
    const errors = vi.spyOn(console, "error");
    expect(await shiftsTab()).toHaveAttribute("aria-selected", "true");
    const views = screen.getByRole("tablist", { name: "Shift management" });
    expect(
      within(views)
        .getAllByRole("tab")
        .map((t) => t.textContent),
    ).toEqual([
      "Role timings",
      "Department timings",
      "Individual timings",
      "Shift history",
    ]);
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Agents");
    expect(rows[1]).toHaveTextContent("10:00 AM");
    expect(rows[1]).toHaveTextContent("Follows the company default");
    expect(rows[2]).toHaveTextContent("9:00 AM");
    expect(rows[2]).toHaveTextContent("5:00 PM");
    expect(rows[2]).toHaveTextContent("Mon–Fri");
    expect(
      screen.getByText(/Company default shift:/).parentElement,
    ).toHaveTextContent("10:00 AM – 6:00 PM, Mon–Sat, 15 min grace");
    // Every row has its own key.
    expect(
      errors.mock.calls.filter((c) => String(c[0]).includes('unique "key"')),
    ).toEqual([]);
  });
  it("saves a role timing from tomorrow by default, with the version it started from", async () => {
    await shiftsTab();
    const table = await screen.findByRole("table");
    fireEvent.click(
      within(within(table).getAllByRole("row")[1]).getByRole("button", {
        name: "Edit",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Agent default shift",
    });
    expect(within(dialog).getByLabelText("Applies from")).toHaveValue(
      addDays(todayPk(), 1),
    );
    fireEvent.change(within(dialog).getByLabelText("Shift start"), {
      target: { value: "09:30" },
    });
    fireEvent.change(within(dialog).getByLabelText("Shift end"), {
      target: { value: "17:30" },
    });
    fireEvent.change(
      within(dialog).getByLabelText("Reason for the change (optional)"),
      { target: { value: "Winter hours" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save timing" }),
    );
    await waitFor(() =>
      expect(
        calls("POST", "/admin/attendance/shifts/roles/agent")[0][1].body,
      ).toEqual({
        effective_from: addDays(todayPk(), 1),
        expected_version: V(1),
        reason: "Winter hours",
        shift_start: "09:30",
        shift_end: "17:30",
        work_days: [1, 2, 3, 4, 5, 6],
        grace_minutes: 15,
      }),
    );
  });
  it("refuses overnight shifts before sending them", async () => {
    await shiftsTab();
    const table = await screen.findByRole("table");
    fireEvent.click(
      within(within(table).getAllByRole("row")[2]).getByRole("button", {
        name: "Edit",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Staff default shift",
    });
    fireEvent.change(within(dialog).getByLabelText("Shift start"), {
      target: { value: "22:00" },
    });
    fireEvent.change(within(dialog).getByLabelText("Shift end"), {
      target: { value: "06:00" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save timing" }),
    );
    expect(
      await within(dialog).findByText(
        "The shift must end after it starts, on the same day. Overnight shifts are not supported.",
      ),
    ).toBeInTheDocument();
    expect(calls("POST", "/admin/attendance/shifts")).toEqual([]);
  });
  it("shows the server's refusal when someone else saved first", async () => {
    await shiftsTab();
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      options?.method === "POST"
        ? Promise.reject(
            new Error(
              "This shift was changed a moment ago. Reload to see the latest before saving.",
            ),
          )
        : original(path, options),
    );
    const table = await screen.findByRole("table");
    fireEvent.click(
      within(within(table).getAllByRole("row")[2]).getByRole("button", {
        name: "Edit",
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Staff default shift",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save timing" }),
    );
    expect(
      await within(dialog).findByText(
        "This shift was changed a moment ago. Reload to see the latest before saving.",
      ),
    ).toBeInTheDocument();
  });
  it("sets, removes and withdraws department timings", async () => {
    await shiftsTab("departments");
    const table = await screen.findByRole("table");
    const [, media, tech] = within(table).getAllByRole("row");
    expect(media).toHaveTextContent("12:00 PM – 8:00 PM");
    expect(media).toHaveTextContent(
      "11:00 AM – 7:00 PM, Mon–Sat, 15 min grace",
    );
    expect(tech).toHaveTextContent("Role defaults");
    fireEvent.click(within(tech).getByRole("button", { name: "Set timing" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Technical department shift",
    });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Sat" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save timing" }),
    );
    await waitFor(() =>
      expect(
        calls("POST", "/admin/attendance/shifts/departments/")[0][1].body,
      ).toMatchObject({ expected_version: V(4), work_days: [1, 2, 3, 4, 5] }),
    );
    fireEvent.click(within(media).getByRole("button", { name: "Remove" }));
    const remove = await screen.findByRole("dialog", {
      name: "Remove the Media department shift",
    });
    expect(remove).toHaveTextContent(
      "Media employees without an individual timing follow their role default shift",
    );
    fireEvent.click(
      within(remove).getByRole("button", { name: "Remove timing" }),
    );
    await waitFor(() =>
      expect(
        calls("POST", `/admin/attendance/shifts/departments/${MEDIA}`).at(-1)[1]
          .body,
      ).toEqual({
        effective_from: addDays(todayPk(), 1),
        expected_version: V(3),
        inherit: true,
      }),
    );
    fireEvent.click(within(media).getByRole("button", { name: "Withdraw" }));
    await waitFor(() =>
      expect(
        calls(
          "DELETE",
          // Sent with the version shown, so a newer change is never withdrawn.
          `/admin/attendance/shifts/departments/${MEDIA}/2026-11-10?version=${V(3)}`,
        ),
      ).toHaveLength(1),
    );
  });
  it("searches employees and filters by role, department, source and account", async () => {
    await shiftsTab("individual");
    const table = await screen.findByRole("table");
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(
      "Ali EditorUID 962837 · ali@gmail.com",
    );
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent(
      "Individual shift",
    );
    expect(within(table).getAllByRole("row")[2]).toHaveTextContent(
      "Media department shift",
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search employees" }),
      {
        target: { value: "962837" },
      },
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Role" }), {
      target: { value: "staff" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Department" }), {
      target: { value: MEDIA },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Shift source" }), {
      target: { value: "individual" },
    });
    await waitFor(() =>
      expect(
        calls("GET", "/admin/attendance/shifts/employees?").some(([p]) => {
          const q = new URLSearchParams(p.split("?")[1]);
          return (
            q.get("search") === "962837" &&
            q.get("role") === "staff" &&
            q.get("department") === MEDIA &&
            q.get("source") === "individual" &&
            q.get("account") === "active"
          );
        }),
      ).toBe(true),
    );
  });
  it("edits an employee's individual timing and removes the override", async () => {
    await shiftsTab("individual");
    fireEvent.click(
      await screen.findByRole("button", { name: "Edit Ali Editor's timing" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Ali Editor's office timing",
    });
    expect(dialog).toHaveTextContent("Current scheduleIndividual shift");
    expect(dialog).toHaveTextContent(
      "2:00 PM – 10:00 PM, Mon–Sat, 10 min grace",
    );
    expect(within(dialog).getByLabelText("Shift start")).toHaveValue("14:00");
    fireEvent.change(within(dialog).getByLabelText("Shift end"), {
      target: { value: "21:00" },
    });
    fireEvent.change(
      within(dialog).getByLabelText("Reason for the change (optional)"),
      { target: { value: "Shorter evenings" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(
        calls("POST", `/admin/attendance/shifts/employees/${ali}`)[0][1].body,
      ).toEqual({
        effective_from: addDays(todayPk(), 1),
        expected_version: V(5),
        reason: "Shorter evenings",
        label: "Individual shift",
        shift_start: "14:00",
        shift_end: "21:00",
        work_days: [1, 2, 3, 4, 5, 6],
        grace_minutes: 10,
      }),
    );
    // The dialog closes after saving; open it again from the deep link.
    open(`/attendance-management?tab=shifts&view=individual&employee=${ali}`);
    const again = (
      await screen.findAllByRole("dialog", {
        name: "Ali Editor's office timing",
      })
    ).at(-1);
    fireEvent.click(
      await within(again).findByRole("button", {
        name: "Remove Individual Override",
      }),
    );
    expect(again).toHaveTextContent(
      "Ali Editor follows the Media department shift, or their role default if it has none",
    );
    fireEvent.click(
      within(again).getByRole("button", { name: "Remove override" }),
    );
    await waitFor(() =>
      expect(
        calls("POST", `/admin/attendance/shifts/employees/${ali}`).at(-1)[1]
          .body,
      ).toEqual({
        effective_from: addDays(todayPk(), 1),
        expected_version: V(5),
        inherit: true,
      }),
    );
  });
  it("starts a first individual timing from the current one, unnamed", async () => {
    const bilal = "e8000000-0000-4000-8000-000000000003";
    routes[`/admin/attendance/shifts/employees/${bilal}`] = () => ({
      id: bilal,
      uid: 555111,
      name: "Bilal Editor",
      role: "staff",
      department: "Media",
      shift: {
        source: "department",
        source_label: "Media department shift",
        label: "Media department shift",
        ...timing("12:00", "20:00"),
        upcoming: null,
      },
      shift_version: V(6),
      shifts: [],
    });
    open(`/attendance-management?tab=shifts&view=individual&employee=${bilal}`);
    const dialog = await screen.findByRole("dialog", {
      name: "Bilal Editor's office timing",
    });
    await within(dialog).findByRole("heading", {
      name: "Set an individual timing",
    });
    expect(within(dialog).getByLabelText("Shift name (optional)")).toHaveValue(
      "",
    );
    expect(within(dialog).getByLabelText("Shift start")).toHaveValue("12:00");
    expect(
      within(dialog).queryByRole("button", {
        name: "Remove Individual Override",
      }),
    ).toBeNull();
  });
  it("lists every saved version in the shift history", async () => {
    await shiftsTab("history");
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows[1]).toHaveTextContent("Ali Editor");
    expect(rows[1]).toHaveTextContent("Evening shoots");
    expect(rows[1]).toHaveTextContent("In effect");
    expect(rows[2]).toHaveTextContent("MediaDepartment");
    expect(rows[2]).toHaveTextContent("Planned");
    expect(rows[3]).toHaveTextContent("Removed: back to the company default");
    expect(rows[3]).toHaveTextContent("withdrawn by HD Administrator");
  });
  it("is not offered to agents or staff", async () => {
    for (const role of ["agent", "staff"]) {
      mocks.user = {
        id: ali,
        uid: 962837,
        name: "Ali Editor",
        role,
        active: true,
      };
      open("/attendance-management?tab=shifts");
      await waitFor(() =>
        expect(
          screen.queryByRole("tab", { name: "Shift management" }),
        ).toBeNull(),
      );
      expect(calls("GET", "/admin/attendance/shifts")).toEqual([]);
      document.body.innerHTML = "";
    }
  });
});

describe("an employee's own timing", () => {
  it("shows today's shift and where it comes from on Attendance, read-only", async () => {
    mocks.user = {
      id: ali,
      uid: 962837,
      name: "Ali Editor",
      role: "staff",
      active: true,
    };
    open("/attendance");
    expect(
      await screen.findByText(
        "Today's shift 12:00 PM – 8:00 PM · 15 min grace · Mon, Tue, Wed, Thu, Fri, Sat",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Schedule: Media department/)).toHaveTextContent(
      "Schedule: Media department · from",
    );
    expect(screen.getByText(/^Schedule: Media department/)).toHaveTextContent(
      "2:00 PM – 10:00 PM (Individual schedule)",
    );
    // Nothing to change it with: only administrators set timings.
    expect(document.querySelector('input[type="time"]')).toBeNull();
    expect(screen.queryByRole("button", { name: /timing|shift/i })).toBeNull();
  });
});
