import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
import { countryName, flagOf } from "../src/lib/countries";
// Update 065: a flag beside each number, from the country the server works
// out (a globe when it cannot), and the Country filter on All leads and the
// Lead pipeline. API responses are mocked; the server tests check the
// countries, the filtering, the counts and who sees what.
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
  id: "65200000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
  active: true,
};
const ali = {
  id: "65200000-0000-4000-8000-0000000000a2",
  role: "agent",
  name: "Ali Agent",
  active: true,
};
const lead = (n, phone, country, extra = {}) => ({
  id: `65200000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  lead_no: 650 + n,
  name: `Customer ${n}`,
  phone,
  phone_country: country,
  masked_phone: phone.slice(0, 3) + "******" + phone.slice(-3),
  status: "contacted",
  source: "Meta",
  assigned_agent: ali.id,
  assigned_name: "Ali Agent",
  assigned_active: true,
  created_at: "2026-11-09T08:00:00Z",
  last_contact_at: "2026-11-12T08:00:00Z",
  last_contact_outcome: "Interested",
  ...extra,
});
const rows = [
  lead(1, "+923001234567", "PK"),
  lead(2, "+971501234567", "AE"),
  lead(3, "+12025550123", "US"),
  lead(4, "+15550123456", null),
];
const countries = [
  { code: "CA", name: "Canada", calling_code: "1" },
  { code: "PK", name: "Pakistan", calling_code: "92" },
  { code: "SA", name: "Saudi Arabia", calling_code: "966" },
  { code: "AE", name: "United Arab Emirates", calling_code: "971" },
  { code: "US", name: "United States", calling_code: "1" },
];
const numbers = {
  contacted: 23,
  hot: 4,
  warm: 7,
  cold: 2,
  none: 10,
  followups_due: 5,
  followups_overdue: 2,
  earlier: 1,
  answered_by_others: 0,
};
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user = { ...owner };
  mocks.api.mockImplementation(async (path) => {
    const query = Object.fromEntries(
      new URLSearchParams(path.split("?")[1] || ""),
    );
    const shown = query.country
      ? rows.filter((r) =>
          query.country === "unknown"
            ? !r.phone_country
            : r.phone_country === query.country,
        )
      : rows;
    if (path === "/phone-countries") return { countries };
    if (path.startsWith("/leads/all?"))
      return {
        page: 1,
        limit: 20,
        count: shown.length,
        totals: { total: 4, assigned: 4, unassigned: 0 },
        data: shown,
      };
    if (path.startsWith("/my-leads?"))
      return {
        view: "pipeline",
        page: 1,
        limit: 20,
        count: shown.length,
        temperatures: { hot: shown.length, warm: 0, cold: 0, none: 0 },
        pipeline_counts: { pipeline: 4, personally_contacted: 4 },
        data: shown,
      };
    if (path.startsWith(`/pipeline/agents/${ali.id}`))
      return {
        agent: { id: ali.id, uid: 482913, name: "Ali Agent", active: true },
        view: "current",
        page: 1,
        limit: 20,
        count: shown.length,
        summary: numbers,
        temperatures: {
          contacted: shown.length,
          hot: shown.length,
          warm: 0,
          cold: 0,
          none: 0,
        },
        data: shown,
      };
    if (path === "/users") return [owner, ali];
    if (path.startsWith("/lead-imports?")) return { data: [], count: 0 };
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
const address = () => screen.getByLabelText("Address").textContent;
const asked = (prefix) =>
  mocks.api.mock.calls
    .map(([p]) => p)
    .filter((p) => p.startsWith(prefix))
    .map((p) => Object.fromEntries(new URLSearchParams(p.split("?")[1])));
async function choose(user, text, option) {
  const box = screen.getByRole("combobox", { name: "Filter by country" });
  await user.click(box);
  await user.type(box, text);
  await user.click(
    within(screen.getByRole("listbox", { name: "Countries" })).getByRole(
      "option",
      { name: option },
    ),
  );
}

describe("a number's flag", () => {
  it("is the country's flag, or a globe, never a guess", () => {
    expect(flagOf("PK")).toBe("🇵🇰");
    expect(flagOf("AE")).toBe("🇦🇪");
    expect(flagOf("SA")).toBe("🇸🇦");
    expect(flagOf("GB")).toBe("🇬🇧");
    expect(flagOf("US")).toBe("🇺🇸");
    expect(flagOf(null)).toBe("🌐");
    expect(flagOf("unknown")).toBe("🌐");
    expect(countryName("AE")).toBe("United Arab Emirates");
    expect(countryName(null)).toBe("Country not identified");
  });
  it("shows beside every number on All leads, the number unchanged", async () => {
    open("/leads");
    await screen.findByText("Customer 1");
    const flag = (name) => screen.getByRole("img", { name });
    expect(flag("Pakistan")).toHaveTextContent("🇵🇰");
    expect(flag("United Arab Emirates")).toHaveTextContent("🇦🇪");
    expect(flag("United States")).toHaveTextContent("🇺🇸");
    expect(flag("Country not identified")).toHaveTextContent("🌐");
    // The number as stored, in its own element.
    expect(screen.getByText("+971501234567")).toBeInTheDocument();
  });
});

describe("the Country filter", () => {
  it("All leads: searchable by name or calling code, then filtered in the database", async () => {
    const user = userEvent.setup();
    open("/leads");
    await screen.findByText("Customer 1");
    const box = screen.getByRole("combobox", { name: "Filter by country" });
    expect(box).toHaveValue("All countries");
    await user.click(box);
    const list = screen.getByRole("listbox", { name: "Countries" });
    // All countries first, then Pakistan and Unknown country.
    expect(
      within(list)
        .getAllByRole("option")
        .slice(0, 3)
        .map((o) => o.textContent),
    ).toEqual(["🌍All countries", "🇵🇰Pakistan+92", "🌐Unknown country"]);
    await user.type(box, "+971");
    expect(
      within(screen.getByRole("listbox", { name: "Countries" }))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["🇦🇪United Arab Emirates+971"]);
    await user.clear(box);
    await user.type(box, "zz");
    expect(screen.getByRole("note")).toHaveTextContent(
      "No country matches “zz”",
    );
    await user.clear(box);
    await user.type(box, "arab");
    await user.click(
      screen.getByRole("option", { name: /United Arab Emirates/ }),
    );
    await waitFor(() => expect(address()).toContain("country=AE"));
    await waitFor(() =>
      expect(asked("/leads/all?").at(-1)).toMatchObject({ country: "AE" }),
    );
    expect(
      screen.getByRole("combobox", { name: "Filter by country" }),
    ).toHaveValue("United Arab Emirates");
    await waitFor(() => expect(screen.queryByText("Customer 1")).toBeNull());
    expect(screen.getByText("Customer 2")).toBeInTheDocument();
    // A chip says so and removes it.
    await user.click(
      screen.getByRole("button", {
        name: "Remove filter Country: 🇦🇪 United Arab Emirates",
      }),
    );
    await waitFor(() => expect(address()).not.toContain("country="));
  });
  it("All leads: Unknown country, with the other filters", async () => {
    const user = userEvent.setup();
    open("/leads?source=Meta");
    await screen.findByText("Customer 1");
    await choose(user, "unknown", /Unknown country/);
    await waitFor(() =>
      expect(asked("/leads/all?").at(-1)).toMatchObject({
        country: "unknown",
        source: "Meta",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Customer 2")).toBeNull());
    expect(screen.getByText("Customer 4")).toBeInTheDocument();
  });
  it("an agent's Lead pipeline", async () => {
    mocks.user = { ...ali };
    const user = userEvent.setup();
    open("/leads/pipeline");
    await screen.findByText("Customer 1");
    await choose(user, "united s", /United States/);
    await waitFor(() =>
      expect(asked("/my-leads?").at(-1)).toMatchObject({
        view: "pipeline",
        country: "US",
      }),
    );
    await waitFor(() => expect(screen.queryByText("Customer 1")).toBeNull());
    expect(screen.getByText("Customer 3")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Remove filter Country: 🇺🇸 United States",
      }),
    ).toBeInTheDocument();
  });
  it("an agent's pipeline as administrators see it: its numbers for that country", async () => {
    const user = userEvent.setup();
    open(`/leads/pipeline/${ali.id}`);
    await screen.findByText("Customer 1");
    const stats = screen.getByRole("group", {
      name: "Ali Agent's pipeline numbers",
    });
    expect(stats).toHaveTextContent("Personally contacted23");
    await choose(user, "pakistan", /Pakistan/);
    await waitFor(() =>
      expect(asked(`/pipeline/agents/${ali.id}`).at(-1)).toMatchObject({
        country: "PK",
      }),
    );
    await waitFor(() =>
      expect(stats).toHaveTextContent("Personally contacted1"),
    );
    expect(
      screen.getByText(/Personally contacted and temperatures: 🇵🇰 Pakistan/),
    ).toBeInTheDocument();
  });
});
