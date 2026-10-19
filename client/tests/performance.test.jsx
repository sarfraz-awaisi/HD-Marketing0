import React, { useState } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";
import { createAuthClient } from "../src/lib/authClient";
import { useDebouncedValue } from "../src/lib/useDebouncedValue";
import { invalidateWorkspace } from "../src/lib/invalidateWorkspace";
import PropertyCard from "../src/components/properties/PropertyCard";
import PhotoGallery from "../src/components/properties/PhotoGallery";
const mocks = vi.hoisted(() => ({ getSession: vi.fn(), api: vi.fn() }));
vi.mock("../src/lib/supabase", () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}));
// Property components use a fixture API; the original API remains available below.
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  mocks.api.mockReset();
  mocks.getSession.mockReset();
});
describe("lighter native Supabase authentication client", () => {
  it("retains the existing session storage key and authentication behavior", async () => {
    const { auth } = createAuthClient(
      "https://fixture.supabase.co",
      "public-fixture",
      { autoRefreshToken: false, detectSessionInUrl: false },
    );
    await auth.initialize();
    expect(auth.storageKey).toBe("sb-fixture-auth-token");
    expect(auth.persistSession).toBe(true);
    expect(auth.flowType).toBe("implicit");
    expect(auth.headers).toMatchObject({
      apikey: "public-fixture",
      Authorization: "Bearer public-fixture",
    });
    expect(typeof auth.mfa.challengeAndVerify).toBe("function");
    auth.stopAutoRefresh();
  });
  it("keeps candidate portal login isolated and sends the native password request", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "Invalid login credentials",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );
    const { auth } = createAuthClient(
      "https://candidate.supabase.co",
      "public-fixture",
      {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storageKey: "candidate-" + crypto.randomUUID(),
        fetch,
      },
    );
    const result = await auth.signInWithPassword({
      email: "fixture@example.test",
      password: "fixture-password",
    });
    expect(result.error).toBeTruthy();
    expect(auth.persistSession).toBe(false);
    expect(fetch.mock.calls[0][0]).toBe(
      "https://candidate.supabase.co/auth/v1/token?grant_type=password",
    );
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      email: "fixture@example.test",
      password: "fixture-password",
    });
    expect(localStorage.getItem("sb-candidate-auth-token")).toBeNull();
    auth.stopAutoRefresh();
  });
  it.each([
    ["file:///tmp/database", "public"],
    ["https://user:pass@example.test", "public"],
    ["https://example.test", "sb_secret_fixture"],
  ])("rejects a non-browser configuration %s", (url, key) =>
    expect(() => createAuthClient(url, key)).toThrow(),
  );
});
describe("responsive searches and focused invalidation", () => {
  it("performs one search after rapid typing and cancels the obsolete request", async () => {
    vi.useFakeTimers();
    const searches = [],
      signals = [];
    function Search() {
      const [value, setValue] = useState("");
      const search = useDebouncedValue(value);
      useQuery({
        queryKey: ["search", search],
        queryFn: ({ signal }) => {
          searches.push(search);
          signals.push(signal);
          return new Promise(() => {});
        },
      });
      return (
        <input
          aria-label="Search"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      );
    }
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Search />
      </QueryClientProvider>,
    );
    for (const value of ["L", "La", "Lahore"])
      fireEvent.change(screen.getByLabelText("Search"), { target: { value } });
    await act(async () => vi.advanceTimersByTimeAsync(249));
    expect(searches).toEqual([""]);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(searches).toEqual(["", "Lahore"]);
    expect(signals[0].aborted).toBe(true);
    client.clear();
  });
  it("refreshes lead metrics without invalidating unrelated settings and pictures", async () => {
    const client = new QueryClient();
    for (const key of [
      "leads",
      "dashboard",
      "properties",
      "photos",
      "account-security",
      "system-status",
    ])
      client.setQueryData([key], {});
    await invalidateWorkspace(client);
    expect(client.getQueryState(["leads"]).isInvalidated).toBe(true);
    expect(client.getQueryState(["dashboard"]).isInvalidated).toBe(true);
    for (const key of [
      "properties",
      "photos",
      "account-security",
      "system-status",
    ])
      expect(client.getQueryState([key]).isInvalidated).toBe(false);
    client.clear();
  });
  it("uses batched covers without fetching or seeding an incomplete gallery", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mocks.api.mockResolvedValue([
      { id: "first", url: "/full-first" },
      { id: "second", url: "/full-second" },
    ]);
    const property = {
      id: "property",
      title: "Fixture home",
      type: "House",
      location: "Lahore",
      price: 10,
      area: 5,
      area_unit: "marla",
      availability: "available",
      photo_count: 2,
      cover_photo: { id: "first", url: "/cover" },
    };
    const view = render(
      <QueryClientProvider client={client}>
        <PropertyCard property={property} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("img")).toHaveAttribute("src", "/cover");
    expect(screen.getByText("2 photos")).toBeInTheDocument();
    expect(mocks.api).not.toHaveBeenCalled();
    expect(client.getQueryData(["photos", "property"])).toBeUndefined();
    view.rerender(
      <QueryClientProvider client={client}>
        <PropertyCard property={property} />
        <PhotoGallery propertyId="property" />
      </QueryClientProvider>,
    );
    expect(
      await screen.findAllByRole("img", { name: "Property photograph" }),
    ).toHaveLength(2);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    client.clear();
  });
  it("renews a failed cover once without polling every card", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    mocks.api.mockResolvedValue([{ id: "photo", url: "/renewed" }]);
    render(
      <QueryClientProvider client={client}>
        <PropertyCard
          property={{
            id: "property",
            title: "Home",
            photo_count: 1,
            cover_photo: { id: "photo", url: "/expired" },
          }}
        />
      </QueryClientProvider>,
    );
    fireEvent.error(screen.getByRole("img"));
    await waitFor(() =>
      expect(screen.getByRole("img")).toHaveAttribute("src", "/renewed"),
    );
    expect(mocks.api).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
describe("API request overhead", () => {
  it("uses an explicit verified-session bearer without rereading browser storage", async () => {
    const { api: original } = await vi.importActual("../src/lib/api");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ id: "profile" }),
      })),
    );
    await original("/me", { headers: { Authorization: "Bearer candidate" } });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith(
      "/api/me",
      expect.objectContaining({
        headers: { Authorization: "Bearer candidate" },
      }),
    );
  });
  it("preserves cancellation instead of reporting a connection failure", async () => {
    const { api: original } = await vi.importActual("../src/lib/api");
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Canceled", "AbortError");
      }),
    );
    await expect(
      original("/leads", {
        signal: controller.signal,
        headers: { Authorization: "Bearer fixture" },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
