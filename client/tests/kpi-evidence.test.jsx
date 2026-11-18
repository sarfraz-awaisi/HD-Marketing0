import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import { cellText } from "../src/components/kpis/KpiReport";
// Update 072: KPIs the CRM fills in, the evidence agents add and the
// administrators' Reviews. API responses are mocked; the server tests check
// the rules, permissions and numbers.
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
  id: "72200000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
  active: true,
};
const ali = {
  id: "72200000-0000-4000-8000-0000000000a2",
  role: "agent",
  name: "Ali Agent",
  active: true,
};
const kid = (n) => `72200000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const today = new Date(Date.now() + 5 * 3600000).toISOString().slice(0, 10);
const base = (n, extra) => ({
  id: kid(n),
  description: null,
  answer: null,
  answered_question: null,
  submitted_at: null,
  updated_at: null,
  editable: false,
  ...extra,
});
const evidence = (n, extra) => ({
  id: kid(100 + n),
  agent: { id: ali.id, name: "Ali Agent", uid: 7 },
  day: today,
  week: today,
  url: null,
  platform: null,
  project: null,
  has_photo: false,
  status: "pending",
  reason: null,
  reviewed_by: null,
  reviewed_at: null,
  submitted_at: `${today}T06:00:00Z`,
  ...extra,
});
function myDay(extra = {}) {
  return {
    agent: { id: ali.id, name: "Ali Agent" },
    today,
    day: today,
    day_status: "work",
    week: { start: today, end: today },
    editable_from: today,
    answered: 0,
    expected: 0,
    kpis: [
      base(1, {
        title: "Assigned calls answered",
        question: "Did you answer your assigned calls today?",
        frequency: "day",
        answer_type: "yes_no",
        target: 1,
        measure: "calls",
        answer: false,
        met: false,
        state: "answered",
        detail: {
          due: 20,
          on_time: 18,
          late: 1,
          not_called: 1,
          waiting: 0,
          attempts: 31,
          answered: 9,
        },
      }),
      base(2, {
        title: "Social media activity",
        question: "Did you complete your social media activity today?",
        frequency: "day",
        answer_type: "yes_no",
        target: 1,
        measure: "social",
        state: "review",
        met: null,
        detail: { submitted: 2, pending: 1, approved: 0, rejected: 1 },
      }),
      base(3, {
        title: "Verified inventory",
        question: "How many verified inventories?",
        frequency: "day",
        answer_type: "number",
        target: 1,
        measure: "inventory",
        answer: 0,
        state: "pending",
        met: null,
        detail: { uploaded: 1, pending: 1, verified: 0, rejected: 0 },
      }),
      base(4, {
        title: "Project visits",
        question: "How many project visits did you complete?",
        frequency: "week",
        answer_type: "number",
        target: 3,
        measure: "visits",
        state: "not_due",
        week: {
          start: today,
          end: today,
          total: 1,
          target: 3,
          status: "in_progress",
          measure: "visits",
          detail: { submitted: 2, pending: 1, approved: 1, rejected: 0 },
          days: [],
        },
      }),
    ],
    evidence: [
      evidence(1, {
        kind: "social",
        url: "https://www.facebook.com/hd/posts/1",
        platform: "facebook",
      }),
      evidence(2, {
        kind: "social",
        url: "https://www.instagram.com/p/A1",
        platform: "instagram",
        status: "rejected",
        reason: "Private post",
        reviewed_at: `${today}T08:00:00Z`,
      }),
      evidence(3, {
        kind: "visit",
        project: "DHA Phase 6",
        has_photo: true,
        status: "approved",
        reviewed_at: `${today}T08:00:00Z`,
      }),
    ],
    inventory: [
      {
        id: kid(200),
        property_no: 41,
        title: "Corner house",
        city: "Lahore",
        area: "DHA Phase 6",
        day: today,
        status: "pending",
        reason: null,
        owner_details: false,
      },
    ],
    history: { kpis: [], days: [], weeks: [] },
    ...extra,
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
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  mocks.api.mockReset();
});

describe("an agent's KPIs filled in by the CRM", () => {
  beforeEach(() => {
    mocks.user = { ...ali };
  });
  it("shows the counts behind each KPI, with no answer to give", async () => {
    mocks.api.mockImplementation(async (path) =>
      path.startsWith("/kpis/my") ? myDay() : { data: [], count: 0 },
    );
    open("/kpis");
    expect(
      await screen.findByText("No: 2 of 20 not called by the deadline"),
    ).toBeInTheDocument();
    const counts = (label) =>
      screen.getByText(label, { selector: "dt" }).nextSibling.textContent;
    expect(counts("Assigned workload")).toBe("20");
    expect(counts("Called by the deadline")).toBe("18");
    expect(counts("Answered (connected)")).toBe("9");
    expect(counts("Remaining")).toBe("1");
    expect(
      screen.getByText("All 4 KPIs are filled in by the CRM"),
    ).toBeInTheDocument();
    // No Yes/No to choose and nothing to save.
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    expect(
      screen.getByText("Waiting for an administrator's review"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("This week: 1/3 · In progress"),
    ).toBeInTheDocument();
    // Each link opens safely; each decision shows with its reason.
    const link = screen.getByRole("link", { name: "facebook.com/hd/posts/1" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByText(/Reason: Private post/)).toBeInTheDocument();
    // The listing opens in Inventory; missing owner details are pointed out.
    expect(
      screen.getByRole("link", { name: "#41 Corner house" }),
    ).toHaveAttribute("href", `/inventory?property=${kid(200)}`);
    expect(
      screen.getByText(/add the owner's name and phone to have it verified/),
    ).toBeInTheDocument();
  });

  it("adds a social link and a visit photo", async () => {
    const user = userEvent.setup();
    const posted = [];
    mocks.api.mockImplementation(async (path, options = {}) => {
      if (options.method === "POST") {
        posted.push([path, options.body]);
        return evidence(9, { kind: "social" });
      }
      return path.startsWith("/kpis/my") ? myDay() : { data: [], count: 0 };
    });
    open("/kpis");
    const add = await screen.findByRole("group", { name: "Add link" });
    await user.type(
      within(add).getByRole("textbox"),
      "https://www.tiktok.com/@hd/video/7{Enter}",
    );
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([
      "/kpis/evidence",
      { kind: "social", url: "https://www.tiktok.com/@hd/video/7" },
    ]);
    expect(
      await screen.findByText(/Link added; it counts once an administrator/),
    ).toBeInTheDocument();
    // A visit photo: project, date and the file, in one upload.
    const photo = screen.getByRole("group", { name: "Upload a visit photo" });
    const upload = within(photo).getByRole("button", { name: "Upload photo" });
    expect(upload).toBeDisabled();
    await user.type(within(photo).getByLabelText("Project"), "DHA Phase 6");
    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.png", {
      type: "image/png",
    });
    await user.upload(within(photo).getByLabelText("Photo"), big);
    await user.click(upload);
    expect(
      await within(photo).findByText("Choose a photo up to 5 MB."),
    ).toBeInTheDocument();
    expect(posted).toHaveLength(1);
    const file = new File([new Uint8Array([137, 80, 78, 71])], "visit.png", {
      type: "image/png",
    });
    await user.upload(within(photo).getByLabelText("Photo"), file);
    await user.click(upload);
    await waitFor(() => expect(posted).toHaveLength(2));
    const [path, body] = posted[1];
    expect(path).toBe("/kpis/evidence/photo");
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("project")).toBe("DHA Phase 6");
    expect(body.get("visit_date")).toBe(today);
    expect(body.get("file").name).toBe("visit.png");
  });
});

describe("administrators' Reviews", () => {
  beforeEach(() => {
    mocks.user = { ...owner };
  });
  const pending = evidence(1, {
    kind: "social",
    url: "https://www.facebook.com/hd/posts/1",
    platform: "facebook",
  });
  const photo = evidence(3, {
    kind: "visit",
    project: "DHA Phase 6",
    has_photo: true,
  });
  function serve(posted) {
    mocks.api.mockImplementation(async (path, options = {}) => {
      if (options.method === "POST") {
        posted.push([path, options.body]);
        return { ...pending, status: options.body.status };
      }
      if (path === "/users") return [ali];
      if (path.includes("/photo")) return { url: "https://storage.test/p" };
      if (path.startsWith("/kpis/inventory"))
        return {
          count: 1,
          data: [
            {
              id: kid(200),
              property_no: 41,
              title: "Corner house",
              city: "Lahore",
              area: "DHA",
              day: today,
              status: "pending",
              owner_details: false,
              agent: { id: ali.id, name: "Ali Agent", uid: 7 },
            },
          ],
        };
      if (path.startsWith("/kpis/evidence")) {
        const q = new URLSearchParams(path.split("?")[1]);
        if (q.get("limit") === "1")
          return { count: q.get("kind") === "social" ? 3 : 0, data: [] };
        return {
          count: 1,
          data: [q.get("kind") === "visit" ? photo : pending],
        };
      }
      return { data: [], count: 0 };
    });
  }

  it("approves, and rejects with a reason, each link", async () => {
    const user = userEvent.setup();
    const posted = [];
    serve(posted);
    open("/kpis?tab=reviews");
    expect(
      await screen.findByRole("tab", { name: "Social links · 3 waiting" }),
    ).toHaveAttribute("aria-selected", "true");
    const link = await screen.findByRole("link", {
      name: "facebook.com/hd/posts/1",
    });
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0]).toEqual([
      `/kpis/evidence/${pending.id}/review`,
      { status: "approved", reason: null },
    ]);
    await user.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByRole("textbox"), "Not our page");
    await user.click(within(dialog).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1][1]).toEqual({
      status: "rejected",
      reason: "Not our page",
    });
  });

  it("shows a visit photo through a signed link, and verifies listings only with owner details", async () => {
    const user = userEvent.setup();
    serve([]);
    open("/kpis?tab=reviews&kind=visit");
    await user.click(await screen.findByRole("button", { name: "View photo" }));
    const img = await screen.findByRole("img", { name: /Visit photo: DHA/ });
    expect(img).toHaveAttribute("src", "https://storage.test/p");
    await user.click(screen.getByRole("button", { name: "Close dialog" }));
    await user.click(
      screen.getByRole("tab", { name: /^Inventory · 1 waiting/ }),
    );
    expect(
      await screen.findByRole("link", { name: "#41 Corner house" }),
    ).toHaveAttribute("href", `/inventory?property=${kid(200)}`);
    expect(screen.getByText("Name or phone missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Verify" })).toBeDisabled();
  });
});

describe("results for KPIs the CRM fills in", () => {
  const calls = {
    id: kid(1),
    frequency: "day",
    answer_type: "yes_no",
    target: 1,
    measure: "calls",
  };
  it("says when no calls were due, and shows the numbers behind a day", () => {
    expect(cellText(calls, { day: { state: "not_due" } }, true)).toBe(
      "No assigned calls due",
    );
    expect(
      cellText(
        calls,
        {
          day: {
            state: "answered",
            value: true,
            met: true,
            detail: { due: 4, on_time: 4 },
          },
        },
        true,
      ),
    ).toBe("Yes · 4/4 called on time");
    expect(
      cellText(
        calls,
        {
          daily: {
            days: 3,
            met: 2,
            below: 1,
            missed: 0,
            pending: 0,
            review: 0,
            not_due: 2,
            total: 2,
            answer_type: "yes_no",
            detail: { due: 9, on_time: 8 },
          },
        },
        false,
      ),
    ).toBe("Yes 2/3 days · 2 days nothing due · 8/9 called on time");
  });
});
