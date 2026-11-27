import React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { Loader, ToastProvider } from "../src/components/common/UI";
// Skeleton screens: every loading place shows grey shapes like what is
// coming, with one "Loading workspace…" status for screen readers.
const mocks = vi.hoisted(() => ({ api: vi.fn(), user: null, loading: false }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    user: mocks.user,
    loading: mocks.loading,
    logout: vi.fn(),
  }),
}));
vi.mock("../src/lib/supabase", () => ({ supabase: null }));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
const owner = {
  id: "5c000000-0000-4000-8000-0000000000a1",
  role: "admin",
  name: "Owner",
  active: true,
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.user = { ...owner };
  mocks.loading = false;
  // Nothing answers: everything stays loading.
  mocks.api.mockImplementation(() => new Promise(() => {}));
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

describe("skeleton loading", () => {
  it("each shape is one status for screen readers, its shapes hidden from them", () => {
    for (const [variant, rows] of [
      ["lines", 0],
      ["table", 7],
      ["page", 7],
      ["cards", 0],
      ["detail", 0],
      ["app", 7],
    ]) {
      const { container, unmount } = render(<Loader variant={variant} />);
      const status = screen.getByRole("status");
      expect(status).toHaveTextContent(/^Loading workspace…$/);
      expect(status).toHaveAttribute("aria-busy", "true");
      expect(status).toHaveClass("skeleton", `skeleton--${variant}`);
      expect(
        container.querySelector(".skeleton-shapes[aria-hidden='true']"),
      ).not.toBeNull();
      // A list: its header row and six rows.
      expect(container.querySelectorAll(".skeleton-row")).toHaveLength(rows);
      unmount();
    }
    // Rows can be set; an unknown shape is lines.
    const { container } = render(<Loader variant="table" rows={3} />);
    expect(container.querySelectorAll(".skeleton-row")).toHaveLength(4);
    container.remove();
    render(<Loader variant="other" />);
    expect(
      screen.getByRole("status").querySelector(".skeleton-lines"),
    ).not.toBeNull();
  });

  it("while signing in, the whole workspace is a skeleton", () => {
    mocks.loading = true;
    open("/leads");
    expect(screen.getByRole("status")).toHaveClass("skeleton--app");
    expect(screen.queryByRole("navigation", { name: "Breadcrumb" })).toBeNull();
  });

  it("a page opening keeps the menu and top bar; its list shows rows while loading", async () => {
    open("/leads/never-assigned");
    const nav = await screen.findByRole("navigation", { name: "Breadcrumb" });
    expect(within(nav).getByText("Never Worked")).toBeInTheDocument();
    // The page itself, then its list, load in place.
    const list = await screen.findByRole("status");
    expect(list.className).toMatch(/skeleton--(page|table)/);
    expect(
      await screen.findByRole("heading", { name: "Never Worked" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveClass("skeleton--table");
    expect(screen.getByRole("link", { name: "All leads" })).toBeInTheDocument();
  });
});
