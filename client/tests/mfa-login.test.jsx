import React from "react";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  act,
} from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import Login from "../src/pages/Login";
import { Protected } from "../src/App";
import { signInToPortal } from "../src/lib/portalLogin";
import { prepareMfa, completeMfa, cancelMfa } from "../src/lib/mfaLogin";
import MfaChallenge from "../src/components/common/MfaChallenge";
import { savedLoginEmails } from "../src/lib/loginEmails";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  createLoginClient: vi.fn(),
  install: vi.fn(),
  signOut: vi.fn(),
  auth: { user: null, error: "", recovering: false, finishRecovery: vi.fn() },
  getSession: vi.fn(),
  login: vi.fn(),
}));
// The server sign-in endpoint returns the fixture candidate's tokens; every
// other request goes through the per-test api mock.
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: (path, options) =>
    path === "/auth/login" ? mocks.login(options) : mocks.api(path, options),
}));
vi.mock("../src/lib/supabase", () => ({
  configured: true,
  createLoginClient: mocks.createLoginClient,
  supabase: {
    auth: {
      setSession: mocks.install,
      signOut: mocks.signOut,
      getSession: mocks.getSession,
    },
  },
}));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
const id = "e1000000-0000-4000-8000-000000000001",
  factor = "f1000000-0000-4000-8000-000000000001";
const profile = {
  id,
  name: "Agent",
  role: "agent",
  active: true,
  mfa_required: true,
  mfa_enrolled: true,
};
let candidate, current, verified, enrollment;
beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.auth.user = null;
  mocks.auth.recovering = false;
  current = {
    access_token: "candidate-aal1",
    refresh_token: "candidate-refresh",
    user: { id, email: "owner@example.test" },
  };
  verified = { ...profile, mfa_required: false };
  enrollment = {
    id: factor,
    totp: {
      qr_code:
        'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E',
      secret: "PRIVATE-SETUP-KEY",
    },
  };
  candidate = {
    auth: {
      signInWithPassword: vi.fn(async () => ({ data: { session: current } })),
      getSession: vi.fn(async () => ({ data: { session: current } })),
      setSession: vi.fn(async (session) => {
        current = { ...current, ...session };
        return { data: { session: current } };
      }),
      signOut: vi.fn(async () => ({})),
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => ({
          data: { currentLevel: "aal1", nextLevel: "aal2" },
        })),
        listFactors: vi.fn(async () => ({
          data: {
            totp: [
              { id: factor, status: "verified", friendly_name: "My phone" },
            ],
            all: [{ id: factor, status: "verified", factor_type: "totp" }],
          },
        })),
        enroll: vi.fn(async () => ({ data: enrollment })),
        unenroll: vi.fn(async () => ({ data: {} })),
      },
    },
  };
  mocks.createLoginClient.mockReturnValue(candidate);
  mocks.install.mockResolvedValue({ data: { session: {} } });
  mocks.signOut.mockResolvedValue({});
  mocks.getSession.mockImplementation(async () => ({
    data: { session: current },
  }));
  mocks.login.mockImplementation(async () => ({
    access_token: current.access_token,
    refresh_token: current.refresh_token,
  }));
  mocks.api.mockImplementation(async (path, options) =>
    path === "/mfa/verify"
      ? { access_token: "verified-token", refresh_token: "verified-refresh" }
      : options?.headers?.Authorization === "Bearer verified-token"
        ? verified
        : profile,
  );
});
afterEach(() => vi.restoreAllMocks());
async function flow() {
  return (
    await signInToPortal(
      { email: "owner@example.test", password: "private-password" },
      "agent",
    )
  ).mfa;
}
function open() {
  render(
    <MemoryRouter>
      <Login />
    </MemoryRouter>,
  );
}
async function password() {
  fireEvent.click(screen.getByRole("button", { name: "Agent", exact: true }));
  fireEvent.change(screen.getByLabelText(/Email address/), {
    target: { value: "owner@example.test" },
  });
  fireEvent.change(screen.getByLabelText(/Password/), {
    target: { value: "private-password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Sign in as Agent" }));
}
describe("administrator email/password login", () => {
  it("installs an accepted admin candidate without invoking any authenticator methods", async () => {
    const admin = {
      ...profile,
      role: "admin",
      mfa_required: false,
      mfa_reset_pending: false,
    };
    mocks.api.mockResolvedValue(admin);
    expect(
      await signInToPortal(
        { email: "owner@example.test", password: "private-password" },
        "admin",
      ),
    ).toEqual(admin);
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith({
      access_token: "candidate-aal1",
      refresh_token: "candidate-refresh",
    });
    expect(candidate.auth.mfa.listFactors).not.toHaveBeenCalled();
    expect(candidate.auth.mfa.enroll).not.toHaveBeenCalled();
    expect(savedLoginEmails("admin")).toEqual(["owner@example.test"]);
  });
  it("does not show an authenticator step after admin password submission", async () => {
    mocks.api.mockResolvedValue({
      ...profile,
      role: "admin",
      mfa_required: false,
    });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Admin", exact: true }));
    fireEvent.change(screen.getByLabelText(/Email address/), {
      target: { value: "owner@example.test" },
    });
    fireEvent.change(screen.getByLabelText(/Password/), {
      target: { value: "private-password" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Admin" }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
    expect(screen.queryByLabelText("Authenticator code")).toBeNull();
    expect(
      screen.queryByRole("heading", { name: "Set up two-factor login" }),
    ).toBeNull();
  });
  it("opens protected pages for a restored password-only admin", async () => {
    mocks.auth.user = { ...profile, role: "admin", mfa_required: false };
    render(
      <MemoryRouter initialEntries={["/workspace"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Protected role="admin" />}>
            <Route path="/workspace" element={<h1>Private customer data</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(
      await screen.findByText("Private customer data"),
    ).toBeInTheDocument();
    expect(candidate.auth.mfa.listFactors).not.toHaveBeenCalled();
  });
});
describe("isolated optional-agent authenticator login", () => {
  it("keeps an opted-in agent password-only candidate out of the installed session and email history", async () => {
    const pending = await flow();
    expect(pending.profile.id).toBe(id);
    expect(mocks.install).not.toHaveBeenCalled();
    expect(savedLoginEmails("agent")).toEqual([]);
    expect(candidate.auth.mfa.enroll).not.toHaveBeenCalled();
    expect(
      candidate.auth.mfa.getAuthenticatorAssuranceLevel,
    ).toHaveBeenCalledOnce();
  });
  it("verifies the selected factor on the server and installs only the accepted AAL2 session", async () => {
    const pending = await flow();
    await completeMfa(pending, factor, "123456");
    expect(mocks.api).toHaveBeenCalledWith("/mfa/verify", {
      method: "POST",
      headers: { Authorization: "Bearer candidate-aal1" },
      body: { factor_id: factor, code: "123456" },
    });
    expect(mocks.install).toHaveBeenCalledExactlyOnceWith({
      access_token: "verified-token",
      refresh_token: "verified-refresh",
    });
    expect(savedLoginEmails("agent")).toEqual(["owner@example.test"]);
    expect(pending.disposed).toBe(true);
  });
  it("offers enrollment QR/manual secret only in component memory, then enables through code verification", async () => {
    candidate.auth.mfa.listFactors.mockResolvedValue({
      data: { totp: [], all: [] },
    });
    const pending = await flow();
    render(<MfaChallenge flow={pending} onCancelled={vi.fn()} />);
    expect(
      screen.getByRole("heading", { name: "Set up two-factor login" }),
    ).toBeInTheDocument();
    expect(
      screen.getByAltText("Scan this QR code with your authenticator app"),
    ).toHaveAttribute("src", enrollment.totp.qr_code);
    expect(screen.getByText("PRIVATE-SETUP-KEY")).toBeInTheDocument();
    expect(localStorage.getItem("PRIVATE-SETUP-KEY")).toBeNull();
    expect(Object.values(localStorage).join("")).not.toContain(
      "PRIVATE-SETUP-KEY",
    );
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Enable and sign in" }));
    await waitFor(() => expect(mocks.install).toHaveBeenCalledOnce());
    expect(
      mocks.api.mock.calls.every(
        ([, options]) => !JSON.stringify(options).includes("PRIVATE-SETUP-KEY"),
      ),
    ).toBe(true);
  });
  it("removes only abandoned unverified TOTP factors before new enrollment", async () => {
    candidate.auth.mfa.listFactors.mockResolvedValue({
      data: {
        totp: [],
        all: [
          { id: "abandoned", factor_type: "totp", status: "unverified" },
          { id: "other-kind", factor_type: "phone", status: "verified" },
        ],
      },
    });
    await flow();
    expect(candidate.auth.mfa.unenroll).toHaveBeenCalledExactlyOnceWith({
      factorId: "abandoned",
    });
    expect(candidate.auth.mfa.enroll).toHaveBeenCalledWith({
      factorType: "totp",
      friendlyName: "HD Marketing authenticator",
      issuer: "HD Marketing",
    });
  });
  it("supports multiple verified authenticators without replacing any existing factor", async () => {
    candidate.auth.mfa.listFactors.mockResolvedValue({
      data: {
        totp: [
          { id: factor, status: "verified", friendly_name: "First phone" },
          {
            id: "second-factor",
            status: "verified",
            friendly_name: "Backup phone",
          },
        ],
        all: [],
      },
    });
    const pending = await flow();
    render(<MfaChallenge flow={pending} onCancelled={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Authenticator"), {
      target: { value: "second-factor" },
    });
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    await waitFor(() =>
      expect(mocks.api).toHaveBeenCalledWith(
        "/mfa/verify",
        expect.objectContaining({
          body: { factor_id: "second-factor", code: "123456" },
        }),
      ),
    );
    expect(candidate.auth.mfa.enroll).not.toHaveBeenCalled();
  });
  it("retains the challenge on wrong code, clears the code and never installs a password session", async () => {
    const pending = await flow();
    mocks.api.mockRejectedValueOnce(
      new Error("The authenticator code was not accepted."),
    );
    render(<MfaChallenge flow={pending} onCancelled={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    await screen.findByText("The authenticator code was not accepted.");
    expect(screen.getByLabelText("Authenticator code")).toHaveValue("");
    expect(mocks.install).not.toHaveBeenCalled();
    expect(pending.disposed).toBe(false);
  });
  it("reports rate limiting without success and retains the user recovery advice", async () => {
    const pending = await flow();
    mocks.api.mockRejectedValueOnce(
      new Error("Too many authenticator attempts. Wait before trying again."),
    );
    render(<MfaChallenge flow={pending} onCancelled={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Verify and sign in" }));
    await screen.findByText(
      "Too many authenticator attempts. Wait before trying again.",
    );
    expect(
      screen.getByText(/Password recovery does not remove it/),
    ).toBeInTheDocument();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("guards pending verification against double submit or cancellation", async () => {
    const pending = await flow();
    let release;
    mocks.api.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    render(<MfaChallenge flow={pending} onCancelled={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Authenticator code"), {
      target: { value: "123456" },
    });
    const button = screen.getByRole("button", { name: "Verify and sign in" });
    fireEvent.click(button);
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Verifying…" });
    expect(
      screen.getByRole("button", { name: "Back to sign in" }),
    ).toBeDisabled();
    expect(
      mocks.api.mock.calls.filter(([path]) => path === "/mfa/verify"),
    ).toHaveLength(1);
    await act(async () =>
      release({
        access_token: "verified-token",
        refresh_token: "verified-refresh",
      }),
    );
  });
  it("cancels new setup locally and never installs/remembers it", async () => {
    candidate.auth.mfa.listFactors.mockResolvedValue({
      data: { totp: [], all: [] },
    });
    const pending = await flow();
    await cancelMfa(pending);
    expect(candidate.auth.mfa.unenroll).toHaveBeenCalledWith({
      factorId: factor,
    });
    expect(candidate.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(savedLoginEmails("agent")).toEqual([]);
  });
  it("does not remove a verified factor when cancelling ordinary code login", async () => {
    const pending = await flow();
    await cancelMfa(pending);
    expect(candidate.auth.mfa.unenroll).not.toHaveBeenCalled();
    expect(candidate.auth.signOut).toHaveBeenCalledOnce();
  });
  it("rejects a still-required, wrong-role or different-user post-verification profile", async () => {
    for (const value of [
      { ...verified, mfa_required: true },
      { ...verified, id: "other" },
      { ...verified, role: "admin" },
    ]) {
      const pending = await flow();
      mocks.api.mockImplementation(async (path) =>
        path === "/mfa/verify"
          ? {
              access_token: "verified-token",
              refresh_token: "verified-refresh",
            }
          : value,
      );
      await expect(completeMfa(pending, factor, "123456")).rejects.toThrow(
        "could not be confirmed",
      );
      expect(mocks.install).not.toHaveBeenCalled();
      mocks.api.mockImplementation(async () => profile);
    }
  });
  it("keeps wrong-portal credentials outside MFA and the main session", async () => {
    mocks.api.mockResolvedValue({ ...profile, role: "admin" });
    await expect(
      signInToPortal(
        { email: "owner@example.test", password: "password" },
        "agent",
      ),
    ).rejects.toThrow("Choose the correct portal");
    expect(candidate.auth.mfa.listFactors).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("shows the MFA step after an opted-in agent password login without the credential form", async () => {
    open();
    await password();
    await screen.findByRole("heading", { name: "Verify two-factor login" });
    expect(screen.queryByLabelText(/Password/)).toBeNull();
    expect(screen.queryByRole("group", { name: "Login portal" })).toBeNull();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("gates restored password-only sessions before any protected page mounts", async () => {
    mocks.auth.user = profile;
    render(
      <MemoryRouter initialEntries={["/workspace"]}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route element={<Protected />}>
            <Route path="/workspace" element={<h1>Private customer data</h1>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole("heading", { name: "Verify two-factor login" });
    expect(screen.queryByText("Private customer data")).toBeNull();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("blocks restored reset-pending access and explains recovery without enrolling another factor", async () => {
    mocks.auth.user = { ...profile, mfa_reset_pending: true };
    mocks.api.mockResolvedValue(mocks.auth.user);
    open();
    await screen.findByText(
      /Your two-factor reset needs administrator recovery/,
    );
    expect(candidate.auth.mfa.enroll).not.toHaveBeenCalled();
    expect(mocks.install).not.toHaveBeenCalled();
  });
  it("leaves agents without required MFA on the ordinary isolated sign-in path", async () => {
    mocks.api.mockResolvedValue({
      ...profile,
      role: "agent",
      mfa_required: false,
    });
    await signInToPortal(
      { email: "agent@example.test", password: "password" },
      "agent",
    );
    expect(mocks.install).toHaveBeenCalledWith({
      access_token: "candidate-aal1",
      refresh_token: "candidate-refresh",
    });
    expect(candidate.auth.mfa.listFactors).not.toHaveBeenCalled();
  });
});
