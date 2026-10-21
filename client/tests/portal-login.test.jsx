import React from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Login from "../src/pages/Login";
import { Protected } from "../src/App";
import { AuthProvider, useAuth } from "../src/context/AuthContext";
import { signInToPortal } from "../src/lib/portalLogin";
import { rememberLoginEmail, savedLoginEmails } from "../src/lib/loginEmails";

const mocks = vi.hoisted(() => ({
  createLoginClient: vi.fn(),
  signInWithPassword: vi.fn(),
  candidateSetSession: vi.fn(),
  signOut: vi.fn(),
  getSession: vi.fn(),
  setSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  resetPasswordForEmail: vi.fn(),
  updateUser: vi.fn(),
  listeners: new Set(),
  profile: null,
  session: null,
}));
vi.mock("../src/lib/supabase", () => ({
  configured: true,
  createLoginClient: mocks.createLoginClient,
  supabase: {
    auth: {
      getSession: mocks.getSession,
      setSession: mocks.setSession,
      onAuthStateChange: mocks.onAuthStateChange,
      resetPasswordForEmail: mocks.resetPasswordForEmail,
      updateUser: mocks.updateUser,
    },
  },
}));
const candidate = {
  access_token: "candidate-token",
  refresh_token: "candidate-refresh-token",
  user: { id: "fixture-account" },
};
const response = (body, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
// The CRM server now checks the password (with lockout) at /api/auth/login;
// this stand-in answers it from the same sign-in fixture as before.
async function serverLogin(options) {
  const { email, password } = JSON.parse(options.body);
  const result = await mocks.signInWithPassword({ email, password });
  if (result?.error) return response({ error: result.error.message }, 401);
  const session = result?.data?.session;
  return response({
    access_token: session?.access_token,
    refresh_token: session?.refresh_token,
    user: session?.user,
  });
}
const isLogin = (url) => String(url).endsWith("/api/auth/login");
// Applies a one-time response to the next profile check only.
function nextProfileCheck(handler) {
  const original = fetch.getMockImplementation();
  fetch.mockImplementation((url, options) => {
    if (isLogin(url)) return original(url, options);
    fetch.mockImplementation(original);
    return handler(url, options);
  });
}
const profileChecks = () => fetch.mock.calls.filter(([url]) => !isLogin(url));
function Workspace() {
  const { user } = useAuth();
  return <h1>{user.role} workspace</h1>;
}
function openLogin() {
  render(
    <AuthProvider>
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Protected />}>
            <Route path="/" element={<Workspace />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  );
}
async function submit(portal = "agent") {
  if (portal === "admin")
    await userEvent.click(
      screen.getByRole("button", { name: "Admin", exact: true }),
    );
  fireEvent.change(screen.getByLabelText("Email address"), {
    target: { value: "person@example.com" },
  });
  fireEvent.change(screen.getByLabelText("Password", { exact: true }), {
    target: { value: "fixture-password-1234" },
  });
  await userEvent.click(
    screen.getByRole("button", {
      name: `Sign in as ${portal === "admin" ? "Admin" : "Agent"}`,
    }),
  );
}
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.stubEnv("VITE_API_URL", "/api");
  history.replaceState({}, "", "/");
  mocks.listeners.clear();
  mocks.session = null;
  mocks.profile = {
    id: "fixture-account",
    name: "Fixture",
    role: "agent",
    active: true,
  };
  mocks.getSession.mockImplementation(async () => ({
    data: { session: mocks.session },
    error: null,
  }));
  mocks.onAuthStateChange.mockImplementation((callback) => {
    mocks.listeners.add(callback);
    return {
      data: {
        subscription: { unsubscribe: () => mocks.listeners.delete(callback) },
      },
    };
  });
  mocks.createLoginClient.mockReturnValue({
    auth: {
      setSession: mocks.candidateSetSession,
      signOut: mocks.signOut,
    },
  });
  mocks.candidateSetSession.mockImplementation(async (tokens) => ({
    data: { session: { ...candidate, ...tokens } },
    error: null,
  }));
  mocks.signInWithPassword.mockResolvedValue({
    data: { session: candidate },
    error: null,
  });
  mocks.signOut.mockResolvedValue({ error: null });
  mocks.setSession.mockImplementation(async () => {
    mocks.session = candidate;
    for (const callback of mocks.listeners) callback("SIGNED_IN", candidate);
    return { data: { session: candidate }, error: null };
  });
  mocks.resetPasswordForEmail.mockResolvedValue({ data: {}, error: null });
  mocks.updateUser.mockResolvedValue({ data: {}, error: null });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) => {
      if (isLogin(url)) return serverLogin(options);
      if (String(url).endsWith("/api/auth/forgot-password")) {
        const { email } = JSON.parse(options.body);
        await mocks.resetPasswordForEmail(email, {
          redirectTo: location.origin + "/login",
        });
        return response({
          message:
            "If your administrator account exists, check your inbox for a reset link.",
        });
      }
      const portal = new URL(url, "http://localhost").searchParams.get(
        "portal",
      );
      if (!mocks.profile.active)
        return response({ error: "Account disabled or not provisioned" }, 403);
      if (portal && portal !== mocks.profile.role)
        return response(
          {
            error: `This account cannot sign in to the ${portal === "admin" ? "Admin" : "Agent"} portal. Choose the correct portal for your account.`,
          },
          403,
        );
      return response(mocks.profile);
    }),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("separate login portals", () => {
  it("defaults to Agent and clears entered credentials when switching portals", async () => {
    openLogin();
    expect(
      screen.getByRole("heading", { name: "Agent Login" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Agent", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    const email = screen.getByLabelText("Email address");
    const password = screen.getByLabelText("Password", { exact: true });
    expect(email).toHaveAttribute("autocomplete", "off");
    expect(password).toHaveAttribute("autocomplete", "off");
    fireEvent.change(email, { target: { value: "person@example.com" } });
    fireEvent.change(password, { target: { value: "draft-password" } });
    await userEvent.click(
      screen.getByRole("button", { name: "Show password" }),
    );
    expect(password).toHaveAttribute("type", "text");
    await userEvent.click(
      screen.getByRole("button", { name: "Admin", exact: true }),
    );
    expect(
      screen.getByRole("heading", { name: "Admin Login" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveValue("");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveAttribute(
      "type",
      "password",
    );
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it.each(["agent", "admin"])(
    "opens only the matching %s workspace after server authorization",
    async (portal) => {
      mocks.profile.role = portal;
      openLogin();
      await submit(portal);
      expect(
        await screen.findByRole("heading", { name: `${portal} workspace` }),
      ).toBeInTheDocument();
      expect(fetch).toHaveBeenCalledWith(
        `/api/me?portal=${portal}`,
        expect.objectContaining({
          headers: { Authorization: "Bearer candidate-token" },
        }),
      );
      expect(mocks.signInWithPassword).toHaveBeenCalledWith({
        email: "person@example.com",
        password: "fixture-password-1234",
      });
      expect(mocks.setSession).toHaveBeenCalledExactlyOnceWith({
        access_token: candidate.access_token,
        refresh_token: candidate.refresh_token,
      });
      expect(mocks.signOut).not.toHaveBeenCalled();
      expect(savedLoginEmails(portal)).toEqual(["person@example.com"]);
      expect(savedLoginEmails(portal === "agent" ? "admin" : "agent")).toEqual(
        [],
      );
      expect(
        JSON.parse(localStorage.getItem("hd-marketing-login-emails-v1")),
      ).toEqual({
        agent: portal === "agent" ? ["person@example.com"] : [],
        admin: portal === "admin" ? ["person@example.com"] : [],
      });
    },
  );

  it.each(["agent", "admin"])(
    "rejects the other role in the %s portal without creating an app session",
    async (portal) => {
      mocks.profile.role = portal === "agent" ? "admin" : "agent";
      openLogin();
      await submit(portal);
      expect(await screen.findByRole("alert")).toHaveTextContent(
        "Choose the correct portal",
      );
      expect(
        screen.queryByRole("heading", { name: /workspace/ }),
      ).not.toBeInTheDocument();
      expect(mocks.session).toBeNull();
      expect(mocks.setSession).not.toHaveBeenCalled();
      expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
      expect(savedLoginEmails("agent")).toEqual([]);
      expect(savedLoginEmails("admin")).toEqual([]);
      await userEvent.click(
        screen.getByRole("button", {
          name: portal === "agent" ? "Admin" : "Agent",
          exact: true,
        }),
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await submit(portal === "agent" ? "admin" : "agent");
      expect(
        await screen.findByRole("heading", {
          name: `${mocks.profile.role} workspace`,
        }),
      ).toBeInTheDocument();
    },
  );

  it("keeps the session unpublished and controls locked while the role check is pending", async () => {
    let finish;
    nextProfileCheck(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    openLogin();
    await submit();
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", { name: "Agent Login" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Forgot password?" }),
    ).not.toBeInTheDocument();
    for (const label of ["Agent", "Admin", "Show password"])
      expect(
        screen.getByRole("button", { name: label, exact: true }),
      ).toBeDisabled();
    expect(screen.getByLabelText("Email address")).toBeDisabled();
    expect(screen.getByLabelText("Password", { exact: true })).toBeDisabled();
    await act(async () =>
      finish(response({ error: "Choose the correct portal" }, 403)),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Choose the correct portal",
    );
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Admin", exact: true }),
    ).toBeEnabled();
  });

  it("keeps invalid passwords out of the role check and app session", async () => {
    mocks.signInWithPassword.mockResolvedValue({
      data: { session: null },
      error: { message: "Invalid login credentials" },
    });
    openLogin();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Invalid login credentials",
    );
    expect(profileChecks()).toEqual([]);
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(savedLoginEmails("agent")).toEqual([]);
  });

  it("suggests matching saved emails and fills only the email when clicked", async () => {
    rememberLoginEmail("agent", "sarfraz.fixture@gmail.com");
    rememberLoginEmail("agent", "another@example.com");
    rememberLoginEmail("admin", "owner@example.com");
    openLogin();
    const email = screen.getByRole("combobox", { name: "Email address" });
    await userEvent.type(email, "SaRf");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.click(
      screen.getByRole("option", { name: "sarfraz.fixture@gmail.com" }),
    );
    expect(email).toHaveValue("sarfraz.fixture@gmail.com");
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in as Agent" }),
    );
    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
  });

  it("supports keyboard choice, Escape and Tab without submitting or changing the password", async () => {
    rememberLoginEmail("agent", "first@example.com");
    rememberLoginEmail("agent", "second@example.com");
    openLogin();
    const email = screen.getByRole("combobox", { name: "Email address" });
    await userEvent.click(email);
    await userEvent.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(email).toHaveValue("first@example.com");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    await userEvent.clear(email);
    await userEvent.keyboard("{ArrowUp}");
    expect(email).toHaveAttribute(
      "aria-activedescendant",
      screen.getByRole("option", { name: "first@example.com" }).id,
    );
    await userEvent.keyboard("{Escape}");
    expect(email).toHaveValue("");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await userEvent.type(email, "second");
    await userEvent.tab();
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Password", { exact: true })).toHaveFocus();
    expect(screen.getByLabelText("Password", { exact: true })).toHaveValue("");
    expect(email).toHaveValue("second");
  });

  it("keeps saved email choices separate between portals and hides nonmatches", async () => {
    rememberLoginEmail("agent", "agent@example.com");
    rememberLoginEmail("admin", "admin@example.com");
    openLogin();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Email address" }),
    );
    expect(
      screen.getByRole("option", { name: "agent@example.com" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "admin@example.com" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Admin", exact: true }),
    );
    const email = screen.getByRole("combobox", { name: "Email address" });
    await userEvent.click(email);
    expect(
      screen.getByRole("option", { name: "admin@example.com" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: "agent@example.com" }),
    ).not.toBeInTheDocument();
    await userEvent.type(email, "unknown");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("accepts a first login with no saved emails and tolerates blocked device storage", async () => {
    openLogin();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Email address" }),
    );
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("Blocked");
      });
    try {
      await submit();
      expect(
        await screen.findByRole("heading", { name: "agent workspace" }),
      ).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("rejects disabled accounts before publishing a session", async () => {
    mocks.profile.active = false;
    openLogin();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Account disabled or not provisioned",
    );
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("keeps a role-check network failure retryable without saving the candidate", async () => {
    nextProfileCheck(async () => {
      throw new TypeError("Load failed");
    });
    openLogin();
    await submit();
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "CRM server could not be reached",
    );
    expect(mocks.setSession).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Email address")).toHaveValue(
      "person@example.com",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Sign in as Agent" }),
    );
    expect(
      await screen.findByRole("heading", { name: "agent workspace" }),
    ).toBeInTheDocument();
  });

  it("rejects missing tokens and an unsuccessful session installation", async () => {
    mocks.signInWithPassword.mockResolvedValueOnce({
      data: { session: { access_token: "incomplete" } },
      error: null,
    });
    await expect(
      signInToPortal({ email: "a@example.com", password: "fixture" }, "agent"),
    ).rejects.toThrow("Sign-in could not be completed");
    expect(mocks.setSession).not.toHaveBeenCalled();
    mocks.setSession.mockResolvedValueOnce({
      error: { message: "Session expired" },
    });
    await expect(
      signInToPortal({ email: "a@example.com", password: "fixture" }, "agent"),
    ).rejects.toThrow("Session expired");
    expect(mocks.session).toBeNull();
    expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("checks the returned profile and rejects invalid portal values before authenticating", async () => {
    await expect(
      signInToPortal({ email: "a@example.com", password: "fixture" }, "owner"),
    ).rejects.toThrow("Choose Agent or Admin");
    expect(mocks.createLoginClient).not.toHaveBeenCalled();
    nextProfileCheck(async () => response({ ...mocks.profile, role: "admin" }));
    await expect(
      signInToPortal({ email: "a@example.com", password: "fixture" }, "agent"),
    ).rejects.toThrow("Choose the correct portal");
    expect(mocks.setSession).not.toHaveBeenCalled();
  });

  it("retains password reset and the selected portal without logging in", async () => {
    openLogin();
    await userEvent.click(
      screen.getByRole("button", { name: "Admin", exact: true }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Forgot password?" }),
    );
    expect(
      screen.queryByRole("group", { name: "Login portal" }),
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveAttribute(
      "autocomplete",
      "email",
    );
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "person@example.com" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Send reset link" }),
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "check your inbox",
    );
    expect(mocks.resetPasswordForEmail).toHaveBeenCalledWith(
      "person@example.com",
      { redirectTo: location.origin + "/login" },
    );
    expect(mocks.signInWithPassword).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Back to sign in" }),
    );
    expect(
      screen.getByRole("heading", { name: "Admin Login" }),
    ).toBeInTheDocument();
  });
});

it("does not install tokens for an account whose email is unconfirmed", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, options) =>
      isLogin(url)
        ? serverLogin(options)
        : response(
            {
              error:
                "Confirm your email using the link in your inbox before signing in.",
              code: "EMAIL_CONFIRMATION_REQUIRED",
            },
            403,
          ),
    ),
  );
  await expect(
    signInToPortal(
      { email: "pending@example.com", password: "private-fixture-password" },
      "agent",
    ),
  ).rejects.toMatchObject({ code: "EMAIL_CONFIRMATION_REQUIRED", status: 403 });
  expect(mocks.setSession).not.toHaveBeenCalled();
  expect(mocks.signOut).toHaveBeenCalledWith({ scope: "local" });
  expect(savedLoginEmails("agent")).not.toContain("pending@example.com");
});
