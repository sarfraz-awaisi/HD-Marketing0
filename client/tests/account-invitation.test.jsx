import React, { StrictMode } from "react";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import AcceptInvitation from "../src/pages/AcceptInvitation";
import {
  readInvitationCallback,
  openInvitation,
} from "../src/lib/accountInvitation";
const mocks = vi.hoisted(() => ({
  candidate: null,
  mainSession: vi.fn(),
  api: vi.fn(),
  auth: { user: null, logout: vi.fn() },
}));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => mocks.auth }));
vi.mock("../src/lib/supabase", () => ({
  createLoginClient: () => mocks.candidate,
  supabase: { auth: { setSession: mocks.mainSession } },
}));
vi.mock("../src/lib/api", () => ({ api: mocks.api }));
const ticket = "a".repeat(64);
function callback(type = "invite") {
  window.history.replaceState(
    null,
    "",
    `/accept-invitation?ticket=${ticket}#type=${type}&access_token=fixture-access&refresh_token=fixture-refresh`,
  );
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.auth.user = null;
  mocks.auth.logout.mockResolvedValue();
  callback();
  mocks.candidate = {
    auth: {
      setSession: vi.fn(async () => ({
        data: { session: { access_token: "fixture-access" } },
      })),
      verifyOtp: vi.fn(async () => ({
        data: { session: { access_token: "fixture-access" } },
      })),
      getSession: vi.fn(async () => ({
        data: { session: { access_token: "fixture-access" } },
      })),
      signOut: vi.fn(async () => ({})),
    },
  };
  mocks.api.mockImplementation(async (path) =>
    path === "/onboarding/context"
      ? {
          name: "Recipient",
          email: "owned@example.test",
          role: "agent",
          email_verified: true,
        }
      : { role: "agent", active: true },
  );
});
const page = () =>
  render(
    <StrictMode>
      <MemoryRouter>
        <AcceptInvitation />
      </MemoryRouter>
    </StrictMode>,
  );
describe("isolated invitation callback and password setup", () => {
  it("preserves an existing workspace session until the recipient explicitly signs out", async () => {
    mocks.auth.user = { id: "existing-admin", role: "admin" };
    page();
    await screen.findByText("Recipient · owned@example.test");
    for (const label of ["New password", "Confirm password"])
      fireEvent.change(screen.getByLabelText(label, { exact: true }), {
        target: { value: "recipient-password-123" },
      });
    fireEvent.click(
      screen.getByRole("button", { name: "Accept invitation", exact: true }),
    );
    await screen.findByRole("button", { name: "Sign out and sign in" });
    expect(mocks.auth.logout).not.toHaveBeenCalled();
    expect(mocks.mainSession).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out and sign in" }),
    );
    await waitFor(() => expect(mocks.auth.logout).toHaveBeenCalledTimes(1));
  });
  it("validates callback purpose and invitation ticket without trusting URL roles", () => {
    expect(readInvitationCallback()).toMatchObject({ ticket, type: "invite" });
    window.history.replaceState(
      null,
      "",
      "/accept-invitation?role=admin#type=signup",
    );
    expect(readInvitationCallback().error).toContain("invalid");
  });
  it("isolates the invited session until the server authorizes its ticket", async () => {
    const value = await openInvitation(readInvitationCallback());
    expect(value.profile.email).toBe("owned@example.test");
    expect(mocks.mainSession).not.toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledWith(
      "/onboarding/context",
      expect.objectContaining({
        headers: { Authorization: "Bearer fixture-access" },
        body: { ticket },
      }),
    );
    await value.close();
  });
  it("uses the supported verifyOtp flow for an explicit invite token hash", async () => {
    window.history.replaceState(
      null,
      "",
      `/accept-invitation?ticket=${ticket}&type=invite&token_hash=provider-hash`,
    );
    await openInvitation(readInvitationCallback());
    expect(mocks.candidate.auth.verifyOtp).toHaveBeenCalledWith({
      token_hash: "provider-hash",
      type: "invite",
    });
    expect(mocks.mainSession).not.toHaveBeenCalled();
  });
  it("clears URL secrets and initializes once during StrictMode before accepting", async () => {
    page();
    await screen.findByText("Recipient · owned@example.test");
    expect(location.search).toBe("");
    expect(location.hash).toBe("");
    expect(mocks.candidate.auth.setSession).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByLabelText("New password", { exact: true }), {
      target: { value: "recipient-password-123" },
    });
    fireEvent.change(
      screen.getByLabelText("Confirm password", { exact: true }),
      { target: { value: "recipient-password-123" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Accept invitation", exact: true }),
    );
    await screen.findByText(
      "Your account is ready. Sign in with your new password.",
    );
    expect(mocks.api).toHaveBeenCalledWith(
      "/onboarding/complete",
      expect.objectContaining({
        body: { ticket, password: "recipient-password-123" },
      }),
    );
    expect(mocks.mainSession).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Go to sign in" })).toHaveAttribute(
      "href",
      "/login",
    );
  });
  it("requires matching strong passwords before submitting", async () => {
    page();
    await screen.findByText("Recipient · owned@example.test");
    fireEvent.change(screen.getByLabelText("New password", { exact: true }), {
      target: { value: "recipient-password-123" },
    });
    fireEvent.change(
      screen.getByLabelText("Confirm password", { exact: true }),
      { target: { value: "mismatch" } },
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Accept invitation", exact: true }),
    );
    await screen.findByText("Passwords must match.");
    expect(
      mocks.api.mock.calls.some(([p]) => p === "/onboarding/complete"),
    ).toBe(false);
  });
  it("shows expiry/cancellation errors without opening the CRM or keeping the URL ticket", async () => {
    mocks.api.mockRejectedValue(
      new Error("This invitation is expired, cancelled or no longer valid."),
    );
    page();
    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("expired");
    expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    expect(location.search).toBe("");
    expect(mocks.mainSession).not.toHaveBeenCalled();
  });
  it("retains the password draft after server failure and guards repeat submission", async () => {
    const original = mocks.api.getMockImplementation();
    let reject;
    mocks.api.mockImplementation((p, o) =>
      p === "/onboarding/complete"
        ? new Promise((_, fail) => {
            reject = fail;
          })
        : original(p, o),
    );
    page();
    await screen.findByText("Recipient · owned@example.test");
    for (const label of ["New password", "Confirm password"])
      fireEvent.change(screen.getByLabelText(label, { exact: true }), {
        target: { value: "recipient-password-123" },
      });
    const button = screen.getByRole("button", {
      name: "Accept invitation",
      exact: true,
    });
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        mocks.api.mock.calls.filter(([p]) => p === "/onboarding/complete"),
      ).toHaveLength(1),
    );
    reject(new Error("Access remains blocked. Please try again."));
    await screen.findByText("Access remains blocked. Please try again.");
    expect(screen.getByLabelText("New password", { exact: true })).toHaveValue(
      "recipient-password-123",
    );
  });
  it("supports renewed recovery-purpose invitations while preserving suspended access", async () => {
    callback("recovery");
    mocks.api.mockImplementation(async (p) =>
      p === "/onboarding/context"
        ? { name: "Recipient", email: "owned@example.test", role: "admin" }
        : { role: "admin", active: false },
    );
    page();
    await screen.findByText("Recipient · owned@example.test");
    for (const label of ["New password", "Confirm password"])
      fireEvent.change(screen.getByLabelText(label, { exact: true }), {
        target: { value: "recipient-password-123" },
      });
    fireEvent.click(
      screen.getByRole("button", { name: "Accept invitation", exact: true }),
    );
    await screen.findByText(
      "Password saved and invitation accepted. Your administrator must enable access before you can sign in.",
    );
    expect(screen.getByText("Choose the Admin portal.")).toBeInTheDocument();
  });
});
