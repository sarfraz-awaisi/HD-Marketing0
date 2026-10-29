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
// Update 043: the Audit history page shows server-described entries in
// plain English. All data comes from mocked server responses.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: mocks.user, loading: false, logout: vi.fn() }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const admin = {
  id: "e1000000-0000-4000-8000-000000000001",
  uid: 663118,
  name: "HD Administrator",
  role: "admin",
  active: true,
};
const agentId = "e1000000-0000-4000-8000-000000000002";
const corrected = {
  id: 7,
  at: "2026-10-28T11:14:00Z",
  module: { key: "attendance", label: "Attendance" },
  kind: { key: "update", label: "Changed" },
  title: "Corrected an attendance record",
  description:
    "Changed HD Agent's attendance on October 22, 2026 from Present (10:00 AM – 6:00 PM) to Late (10:40 AM – 6:00 PM).",
  actor: {
    type: "person",
    name: "HD Administrator",
    detail: "Admin · UID 663118",
    note: null,
  },
  record: { label: "HD Agent", detail: "October 22, 2026", note: null },
  fields: null,
  changes: [
    {
      label: "Attendance",
      before: "Present (10:00 AM – 6:00 PM)",
      after: "Late (10:40 AM – 6:00 PM)",
    },
  ],
  reason: "Door log shows 10:40",
  technical: {
    action: "attendance.manual_update",
    entity: "attendance_records",
    actor_id: admin.id,
    entity_id: "c0ffee00-0000-4000-8000-000000000009",
    request_id: "5b7f0c1e-req",
    metadata: { user_id: agentId, status: "late", token: "[hidden]" },
  },
};
const photo = {
  id: 6,
  at: "2026-10-27T05:30:00Z",
  module: { key: "properties", label: "Properties" },
  kind: { key: "create", label: "Added or created" },
  title: "Uploaded a property photo",
  description: "Added a photo to “Park View Residence” (PR-000012).",
  actor: {
    type: "person",
    name: "Sara (deleted account)",
    detail: "Agent · UID 445566",
    note: "Account deleted",
  },
  record: { label: "Park View Residence", detail: "PR-000012" },
  fields: null,
  changes: [],
  reason: null,
  technical: {
    action: "upload_photo",
    entity: "properties",
    actor_id: "x",
    entity_id: "y",
    request_id: "z",
    metadata: {},
  },
};
const automatic = {
  ...photo,
  id: 5,
  module: { key: "system", label: "Automatic CRM tasks" },
  kind: { key: "automatic", label: "Automatic" },
  title: "Permanently removed old deleted leads",
  description:
    "Permanently removed 3 leads whose recovery period in Deleted leads had ended.",
  actor: {
    type: "system",
    name: "System",
    detail: "Automatic CRM task",
    note: null,
  },
  record: null,
};
const page = (data, extra = {}) => ({
  data,
  count: data.length,
  page: 1,
  limit: 20,
  modules: [
    { key: "attendance", label: "Attendance" },
    { key: "properties", label: "Properties" },
  ],
  kinds: [
    { key: "update", label: "Changed" },
    { key: "create", label: "Added or created" },
  ],
  ...extra,
});
let respond;
const calls = () =>
  mocks.api.mock.calls
    .map(([p]) => p)
    .filter((p) => p.startsWith("/audit?"))
    .map((p) => Object.fromEntries(new URLSearchParams(p.split("?")[1])));
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
  respond = () => page([corrected, photo, automatic]);
  mocks.api.mockImplementation(async (path) => {
    if (path.startsWith("/audit?")) return respond(path);
    if (path === "/audit/actors")
      return [
        {
          id: admin.id,
          name: "HD Administrator",
          detail: "Admin · UID 663118",
        },
      ];
    if (path === "/notifications") return { data: [], unread: 0 };
    return { data: [], count: 0 };
  });
});

describe("Audit history", () => {
  it("explains each activity in plain English without technical identifiers", async () => {
    open("/audit");
    const row = (
      await screen.findByText("Corrected an attendance record")
    ).closest("tr");
    expect(
      within(row).getByText(/from Present \(10:00 AM – 6:00 PM\) to Late/),
    ).toBeInTheDocument();
    expect(within(row).getByText("HD Administrator")).toBeInTheDocument();
    expect(within(row).getByText("Admin · UID 663118")).toBeInTheDocument();
    expect(within(row).getByText("HD Agent")).toBeInTheDocument();
    expect(within(row).getByText("October 22, 2026")).toBeInTheDocument();
    expect(screen.getByText("Account deleted")).toBeInTheDocument();
    expect(screen.getByText("System")).toBeInTheDocument();
    expect(screen.getByText("3 activities recorded")).toBeInTheDocument();
    const table = screen.getByRole("table");
    for (const technical of [
      admin.id,
      "attendance.manual_update",
      "5b7f0c1e-req",
      "upload_photo",
      "{",
    ])
      expect(table.textContent).not.toContain(technical);
    expect(
      screen.queryByRole("columnheader", { name: /request id/i }),
    ).toBeNull();
    expect(
      within(table).queryByRole("button", { name: /^(edit|delete|remove)/i }),
    ).toBeNull();
  });

  it("shows the full details with the technical part collapsed", async () => {
    open("/audit");
    fireEvent.click(
      await screen.findByRole("button", {
        name: /View details: Corrected an attendance record/,
      }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Corrected an attendance record",
    });
    expect(
      within(dialog).getByText("Door log shows 10:40"),
    ).toBeInTheDocument();
    const changes = within(dialog).getByRole("table", { name: "What changed" });
    expect(
      within(changes).getByText("Late (10:40 AM – 6:00 PM)"),
    ).toBeInTheDocument();
    const technical = within(dialog)
      .getByText("Technical details")
      .closest("details");
    expect(technical.open).toBe(false);
    expect(
      within(technical).getByText("attendance.manual_update"),
    ).toBeInTheDocument();
    expect(
      within(technical).getByLabelText("Recorded details").textContent,
    ).toContain('"token": "[hidden]"');
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("filters, searches and sorts on the server", async () => {
    open("/audit");
    await screen.findByText("Corrected an attendance record");
    fireEvent.change(screen.getByRole("combobox", { name: "Module" }), {
      target: { value: "attendance" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Action" }), {
      target: { value: "update" },
    });
    await screen.findByRole("option", { name: /HD Administrator · Admin/ });
    fireEvent.change(screen.getByRole("combobox", { name: "Performed by" }), {
      target: { value: admin.id },
    });
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), {
      target: { value: "663118" },
    });
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-10-20" },
    });
    fireEvent.change(screen.getByLabelText("Through"), {
      target: { value: "2026-10-28" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Order" }), {
      target: { value: "oldest" },
    });
    await waitFor(() =>
      expect(calls().at(-1)).toEqual({
        page: "1",
        limit: "20",
        sort: "oldest",
        search: "663118",
        module: "attendance",
        kind: "update",
        actor: admin.id,
        from: "2026-10-20",
        to: "2026-10-28",
      }),
    );
    expect(screen.getByText(/match these filters/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() =>
      expect(calls().at(-1)).toEqual({
        page: "1",
        limit: "20",
        sort: "newest",
      }),
    );
  });

  it("refuses a backwards date range without asking the server", async () => {
    open("/audit");
    await screen.findByText("Corrected an attendance record");
    const before = calls().length;
    fireEvent.change(screen.getByLabelText("From"), {
      target: { value: "2026-10-28" },
    });
    fireEvent.change(screen.getByLabelText("Through"), {
      target: { value: "2026-10-01" },
    });
    expect(
      await screen.findByText("The date range must end on or after its start."),
    ).toBeInTheDocument();
    expect(
      calls().filter((c) => c.from === "2026-10-28" && c.to === "2026-10-01"),
    ).toEqual([]);
    expect(calls().length).toBeGreaterThanOrEqual(before);
  });

  it("pages through the history and shows an empty state", async () => {
    respond = (path) =>
      path.includes("page=2")
        ? page([photo], { count: 45, page: 2 })
        : page([corrected], { count: 45 });
    open("/audit");
    await screen.findByText("45 activities recorded");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByText("Uploaded a property photo");
    expect(calls().at(-1).page).toBe("2");
    respond = () => page([], { count: 0 });
    fireEvent.change(screen.getByRole("combobox", { name: "Module" }), {
      target: { value: "properties" },
    });
    expect(
      await screen.findByText(/No activity matches these filters/),
    ).toBeInTheDocument();
  });

  it("shows recorded text as text, never as page markup", async () => {
    const markup = '<img src=x onerror="window.hacked=1">';
    respond = () =>
      page([
        {
          ...photo,
          title: "Uploaded a property photo",
          description: `Added a photo to “${markup}” (PR-000012).`,
          record: { label: markup, detail: "PR-000012" },
          technical: { ...photo.technical, metadata: { title: markup } },
        },
      ]);
    open("/audit");
    const row = (await screen.findByText(markup)).closest("tr");
    expect(row.querySelector("img")).toBeNull();
    fireEvent.click(within(row).getByRole("button", { name: /View details/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.querySelector("img")).toBeNull();
    expect(
      within(dialog).getByLabelText("Recorded details").textContent,
    ).toContain(markup.replace(/"/g, '\\"'));
    expect(window.hacked).toBeUndefined();
  });

  it("keeps agents away from the audit history", async () => {
    mocks.user = { ...admin, id: agentId, role: "agent", name: "HD Agent" };
    open("/audit");
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { name: "Audit history" }),
      ).toBeNull(),
    );
    expect(
      mocks.api.mock.calls.filter(([p]) => p.startsWith("/audit")),
    ).toEqual([]);
  });
});
