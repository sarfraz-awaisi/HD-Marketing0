import React, { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { Protected } from "../src/App";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { savedLoginEmails } from "../src/lib/loginEmails";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  api: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
}));
vi.mock("../src/lib/supabase", () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
    },
  },
}));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal()),
  api: mocks.api,
}));

const session = {
  access_token: "fixture-token",
  user: { id: "fixture-user" },
};
const profile = { id: "fixture-user", role: "agent", active: true };

function AccountState() {
  const { user, loading, error } = useAuth();
  return (
    <>
      <div>
        {loading
          ? "Loading account"
          : user
            ? `Signed in as ${user.role}`
            : "Signed out"}
      </div>
      {error && <p role="alert">{error}</p>}
    </>
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  mocks.getSession.mockResolvedValue({
    data: { session },
    error: null,
  });
  mocks.api.mockResolvedValue(profile);
  mocks.onAuthStateChange.mockReturnValue({
    data: { subscription: { unsubscribe: mocks.unsubscribe } },
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function DraftForm() {
  const [notes, setNotes] = useState("");
  return (
    <label>
      Agent notes
      <textarea value={notes} onChange={(e) => setNotes(e.target.value)} />
    </label>
  );
}
async function openWorkspace(role) {
  vi.useFakeTimers();
  await act(async () => {
    render(
      <AuthProvider>
        <AccountState />
        <MemoryRouter initialEntries={["/work"]}>
          <Routes>
            <Route path="/login" element={<p>Login screen</p>} />
            <Route path="/" element={<p>My overview</p>} />
            <Route element={<Protected role={role} />}>
              <Route path="/work" element={<DraftForm />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
  });
  const notes = screen.getByLabelText("Agent notes");
  fireEvent.change(notes, { target: { value: "Customer wants a site visit" } });
  return notes;
}
function pendingProfile() {
  let resolve, reject;
  const promise = new Promise((success, failure) => {
    resolve = success;
    reject = failure;
  });
  mocks.api.mockReturnValueOnce(promise);
  return { resolve, reject };
}
async function authEvent(event, nextSession) {
  const callback = mocks.onAuthStateChange.mock.calls.at(-1)[0];
  await act(async () => {
    callback(event, nextSession);
    await vi.advanceTimersByTimeAsync(0);
  });
}
function expectDraftPreserved(notes) {
  expect(screen.getByLabelText("Agent notes")).toBe(notes);
  expect(notes).toHaveValue("Customer wants a site visit");
  expect(screen.queryByText("Loading workspace…")).not.toBeInTheDocument();
}

describe("session restoration", () => {
  it("remembers an existing session's own email only after the CRM authorizes it", async () => {
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          ...session,
          user: { ...session.user, email: "existing@example.com" },
        },
      },
    });
    const pending = pendingProfile();
    render(
      <AuthProvider>
        <AccountState />
      </AuthProvider>,
    );
    await waitFor(() => expect(mocks.api).toHaveBeenCalled());
    expect(savedLoginEmails("agent")).toEqual([]);
    await act(async () => pending.resolve(profile));
    expect(await screen.findByText("Signed in as agent")).toBeInTheDocument();
    expect(savedLoginEmails("agent")).toEqual(["existing@example.com"]);
    expect(savedLoginEmails("admin")).toEqual([]);
  });
  it("finishes loading and explains a failed Supabase session request", async () => {
    mocks.getSession.mockRejectedValue(new TypeError("Load failed"));
    render(
      <AuthProvider>
        <AccountState />
      </AuthProvider>,
    );
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Supabase login could not be reached",
    );
    expect(mocks.api).not.toHaveBeenCalled();
  });
  it("requires an authorized CRM profile even when an Auth session exists", async () => {
    mocks.api.mockRejectedValue(
      new Error("Account disabled or not provisioned"),
    );
    render(
      <AuthProvider>
        <AccountState />
      </AuthProvider>,
    );
    expect(await screen.findByText("Signed out")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Account disabled or not provisioned",
    );
  });
  it("restores a login after the CRM API authorizes its profile", async () => {
    render(
      <AuthProvider>
        <AccountState />
      </AuthProvider>,
    );
    expect(await screen.findByText("Signed in as agent")).toBeInTheDocument();
    expect(mocks.api).toHaveBeenCalledWith("/me", {
      headers: { Authorization: "Bearer fixture-token" },
    });
  });
});

describe("background workspace checks", () => {
  it("preserves an unsaved form during the minute check and after it finishes", async () => {
    const notes = await openWorkspace();
    const pending = pendingProfile();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(mocks.api).toHaveBeenCalledTimes(2);
    expectDraftPreserved(notes);
    await act(async () => pending.resolve(profile));
    expectDraftPreserved(notes);
  });

  it.each(["TOKEN_REFRESHED", "SIGNED_IN"])(
    "preserves an unsaved form during a %s event for the same account",
    async (event) => {
      const notes = await openWorkspace();
      const pending = pendingProfile();
      await authEvent(event, { ...session, access_token: "refreshed-token" });
      expect(mocks.api).toHaveBeenCalledTimes(2);
      expectDraftPreserved(notes);
      await act(async () => pending.resolve(profile));
      expectDraftPreserved(notes);
    },
  );

  it("removes the workspace when a background check finds disabled access", async () => {
    await openWorkspace();
    mocks.api.mockRejectedValueOnce(
      new Error("Account disabled or not provisioned"),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent notes")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Account disabled");
  });

  it("applies a role downgrade and closes an admin route", async () => {
    mocks.api.mockResolvedValueOnce({ ...profile, role: "admin" });
    await openWorkspace("admin");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(screen.getByText("Signed in as agent")).toBeInTheDocument();
    expect(screen.getByText("My overview")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent notes")).not.toBeInTheDocument();
  });

  it("ignores a pending profile response after signing out", async () => {
    await openWorkspace();
    const pending = pendingProfile();
    await authEvent("TOKEN_REFRESHED", session);
    await authEvent("SIGNED_OUT", null);
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    await act(async () => pending.resolve(profile));
    expect(screen.getByText("Signed out")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent notes")).not.toBeInTheDocument();
  });

  it("hides the previous account's workspace until a different account is authorized", async () => {
    await openWorkspace();
    const pending = pendingProfile();
    await authEvent("SIGNED_IN", {
      access_token: "other-token",
      user: { id: "other-user" },
    });
    expect(screen.getByText("Loading workspace…")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent notes")).not.toBeInTheDocument();
    await act(async () => pending.resolve({ ...profile, id: "other-user" }));
    expect(screen.getByLabelText("Agent notes")).toHaveValue("");
  });

  it("ignores an older check that finishes after a newer role decision", async () => {
    mocks.api.mockResolvedValueOnce({ ...profile, role: "admin" });
    await openWorkspace("admin");
    const pending = pendingProfile();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    await authEvent("TOKEN_REFRESHED", session);
    expect(screen.getByText("Signed in as agent")).toBeInTheDocument();
    await act(async () => pending.resolve({ ...profile, role: "admin" }));
    expect(screen.getByText("Signed in as agent")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent notes")).not.toBeInTheDocument();
  });
  it("gates the workspace on MFA denial and ignores an outstanding older profile decision", async () => {
    await openWorkspace();
    const pending = pendingProfile();
    await authEvent("TOKEN_REFRESHED", session);
    act(() => window.dispatchEvent(new Event("hd:mfa-required")));
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    await act(async () => pending.resolve(profile));
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    expect(screen.queryByLabelText("Agent notes")).not.toBeInTheDocument();
  });
  it("does not remember restored email suggestions before required authenticator verification", async () => {
    mocks.api.mockResolvedValue({ ...profile, mfa_required: true });
    mocks.getSession.mockResolvedValue({
      data: {
        session: {
          ...session,
          user: { ...session.user, email: "pending@example.test" },
        },
      },
    });
    render(
      <AuthProvider>
        <MemoryRouter>
          <Routes>
            <Route path="/login" element={<p>Login screen</p>} />
            <Route element={<Protected />}>
              <Route path="/" element={<DraftForm />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthProvider>,
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(savedLoginEmails("agent")).toEqual([]);
    expect(screen.queryByLabelText("Agent notes")).not.toBeInTheDocument();
  });
});

describe("workspace query cache boundaries", () => {
  async function start() {
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <AuthProvider>
          <AccountState />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await screen.findByText("Signed in as agent");
    client.setQueryData(["leads"], [{ id: "private-old-account" }]);
    return client;
  }
  async function emit(event, next) {
    mocks.onAuthStateChange.mock.calls.at(-1)[0](event, next);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  it("clears customer data immediately on sign-out and account replacement", async () => {
    const client = await start();
    await emit("SIGNED_OUT", null);
    expect(client.getQueryData(["leads"])).toBeUndefined();
    client.setQueryData(["leads"], ["stale"]);
    mocks.api.mockResolvedValue({ ...profile, id: "different-account" });
    await emit("SIGNED_IN", { ...session, user: { id: "different-account" } });
    expect(client.getQueryData(["leads"])).toBeUndefined();
    client.clear();
  });
  it("keeps same-account background data but clears it on role change", async () => {
    const client = await start();
    await emit("TOKEN_REFRESHED", session);
    expect(client.getQueryData(["leads"])).toHaveLength(1);
    mocks.api.mockResolvedValue({ ...profile, role: "admin" });
    await emit("TOKEN_REFRESHED", session);
    expect(client.getQueryData(["leads"])).toBeUndefined();
    client.clear();
  });
  it("clears cached records when access is disabled or MFA becomes required", async () => {
    const client = await start();
    act(() => window.dispatchEvent(new Event("hd:mfa-required")));
    expect(client.getQueryData(["leads"])).toBeUndefined();
    client.setQueryData(["leads"], ["stale"]);
    mocks.api.mockRejectedValue(new Error("Account disabled"));
    await emit("TOKEN_REFRESHED", session);
    expect(client.getQueryData(["leads"])).toBeUndefined();
    client.clear();
  });
});
