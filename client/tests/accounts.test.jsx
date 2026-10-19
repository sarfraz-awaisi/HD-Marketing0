import React from "react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "../src/App";
import { ToastProvider } from "../src/components/common/UI";
const mocks = vi.hoisted(() => ({
  api: vi.fn(),
  user: null,
  configured: true,
  records: [],
  token: "opaque-private-unlock",
  expiry: null,
  unlocked: false,
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    user: mocks.user,
    loading: false,
    error: "",
    logout: vi.fn(),
  }),
}));
vi.mock("../src/lib/api", async (original) => ({
  ...(await original()),
  api: mocks.api,
}));
let qc;
const failure = (message, status = 400, code) =>
  Object.assign(new Error(message), { status, code });
const admin = {
  id: "81000000-0000-4000-8000-000000000001",
  uid: 741205,
  name: "Own Admin",
  role: "admin",
  active: true,
  email_confirmed_at: "2026-10-10T00:00:00Z",
  email: "admin@example.com",
  created_at: "2026-10-10T01:00:00Z",
};
const agent = {
  id: "81000000-0000-4000-8000-000000000002",
  uid: 583214,
  name: "Agent Person",
  role: "agent",
  active: true,
  email_confirmed_at: "2026-10-10T00:00:00Z",
  email: "agent@example.com",
  created_at: "2026-10-10T02:00:00Z",
};
function open(path = "/accounts") {
  qc = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: 0 },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[path]}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
async function unlock() {
  const input = await screen.findByLabelText("4-digit PIN");
  fireEvent.change(input, { target: { value: "0123" } });
  await userEvent.click(
    screen.getByRole("button", { name: "Unlock Accounts", exact: true }),
  );
  await screen.findByRole("button", { name: "Details for Agent Person" });
}
const accountCalls = () =>
  mocks.api.mock.calls.filter(([path]) => path.startsWith("/accounts"));
const createCalls = () =>
  mocks.api.mock.calls.filter(
    ([path, options]) => path === "/accounts" && options?.method === "POST",
  );
async function openCreate() {
  open();
  await unlock();
  await userEvent.click(
    screen.getByRole("button", { name: "Create account", exact: true }),
  );
  return screen.getByRole("dialog");
}
function fillAccount(
  dialog,
  {
    name = "New Person",
    email = "new.person@gmail.com",
    password = "new-account-password-123",
  } = {},
) {
  fireEvent.change(within(dialog).getByLabelText("Full name"), {
    target: { value: name },
  });
  fireEvent.change(within(dialog).getByLabelText("Gmail address"), {
    target: { value: email },
  });
  fireEvent.change(
    within(dialog).getByLabelText("New password", { exact: true }),
    { target: { value: password } },
  );
  fireEvent.change(within(dialog).getByLabelText("Confirm password"), {
    target: { value: password },
  });
}
const submitCreate = (dialog) =>
  userEvent.click(
    within(dialog).getByRole("button", { name: "Create account", exact: true }),
  );
beforeEach(() => {
  vi.resetAllMocks();
  mocks.user = { ...admin };
  mocks.configured = true;
  mocks.records = [{ ...admin }, { ...agent }];
  mocks.pending = [];
  mocks.pendingForms = new Map();
  mocks.expiry = null;
  mocks.unlocked = false;
  mocks.deleteError = null;
  mocks.deletePending = null;
  mocks.codeError = null;
  mocks.codePending = null;
  mocks.createError = null;
  mocks.createPending = null;
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  mocks.api.mockImplementation(async (path, options = {}) => {
    const url = new URL(path, "http://fixture");
    if (path === "/account-security") {
      if (options.method === "PUT") {
        if (options.body.password !== "current-password-fixture")
          throw failure("Your current login password was not accepted.", 403);
        mocks.configured = true;
        mocks.unlocked = false;
        return { configured: true, updated_at: new Date().toISOString() };
      }
      return {
        configured: mocks.configured,
        updated_at: null,
        locked_until: null,
      };
    }
    if (path === "/account-security/unlock") {
      if (options.body.pin !== "0123")
        throw failure("Incorrect PIN. 4 attempts remaining.", 403);
      mocks.unlocked = true;
      return {
        token: mocks.token,
        expires_at:
          mocks.expiry || new Date(Date.now() + 15 * 60000).toISOString(),
      };
    }
    if (path === "/account-security/lock") {
      mocks.unlocked = false;
      return null;
    }
    if (path.startsWith("/accounts")) {
      if (
        !mocks.unlocked ||
        options.headers?.["X-Accounts-Unlock"] !== mocks.token
      )
        throw failure(
          "Unlock Accounts with your PIN to continue.",
          423,
          "ACCOUNTS_LOCKED",
        );
      if (url.pathname === "/accounts") {
        if (options.method === "POST") {
          const body = options.body;
          if (mocks.createPending) await mocks.createPending;
          if (mocks.createError) throw mocks.createError;
          if (mocks.records.some((r) => r.email === body.email))
            throw failure(
              "An account with this email already exists.",
              409,
              "ACCOUNTS_EMAIL_EXISTS",
            );
          const uid = body.uid_mode === "manual" ? Number(body.uid) : 908234;
          if (mocks.records.some((r) => r.uid === uid))
            throw failure(
              "This UID is already assigned to another account. Please choose a different UID.",
              409,
              "ACCOUNTS_UID_TAKEN",
            );
          const record = {
            id: crypto.randomUUID(),
            uid,
            name: body.name,
            email: body.email,
            role: body.role,
            active: true,
            account_status: "active",
            email_confirmed_at: new Date().toISOString(),
            created_at: new Date().toISOString(),
          };
          mocks.records.push(record);
          return { ...record, message: "Account created successfully." };
        }
        let records = [...mocks.records];
        const search = url.searchParams.get("search")?.toLowerCase(),
          role = url.searchParams.get("role"),
          access = url.searchParams.get("access"),
          page = Number(url.searchParams.get("page") || 1);
        if (search)
          records = records.filter((r) =>
            (r.name + " " + r.email + " " + (r.uid ?? ""))
              .toLowerCase()
              .includes(search),
          );
        if (role) records = records.filter((r) => r.role === role);
        if (access)
          records = records.filter((r) => r.active === (access === "active"));
        return {
          data: records.slice((page - 1) * 20, page * 20),
          count: records.length,
          summary: {
            total: mocks.records.length,
            admins: mocks.records.filter((r) => r.role === "admin" && r.active)
              .length,
            agents: mocks.records.filter((r) => r.role === "agent" && r.active)
              .length,
            disabled: mocks.records.filter((r) => !r.active).length,
          },
        };
      }
      if (url.pathname === "/accounts/pending") return mocks.pending;
      if (url.pathname === "/accounts/uid-availability") {
        const uid = Number(url.searchParams.get("uid"));
        return { uid, available: !mocks.records.some((r) => r.uid === uid) };
      }
      if (url.pathname.startsWith("/accounts/pending/")) {
        const pendingId = url.pathname.split("/")[3];
        const pending = mocks.pending.find((r) => r.request_id === pendingId);
        if (options.method === "DELETE") {
          mocks.pending = mocks.pending.filter(
            (r) => r.request_id !== pendingId,
          );
          return null;
        }
        if (url.pathname.endsWith("/verify")) {
          const form = mocks.pendingForms.get(pendingId);
          if (
            options.body.code !== "123456" ||
            options.body.password !== form.password
          )
            throw failure("Invalid verification code. Please try again.");
          const record = {
            id: pendingId,
            name: form.name,
            email: form.email,
            role: form.role,
            active: true,
            account_status: "active",
            email_confirmed_at: new Date().toISOString(),
          };
          mocks.records.push(record);
          mocks.pending = mocks.pending.filter(
            (r) => r.request_id !== pendingId,
          );
          return {
            id: pendingId,
            role: form.role,
            completed: true,
            message: "Email verified. Account created successfully.",
          };
        }
        return { ...pending };
      }

      const id = url.pathname.split("/")[2],
        record = mocks.records.find((r) => r.id === id);
      if (!record) throw failure("Account not found", 404);
      if (options.method === "DELETE" && url.pathname === `/accounts/${id}`) {
        if (mocks.deletePending) await mocks.deletePending;
        if (mocks.deleteError) {
          Object.assign(record, {
            active: false,
            account_status: "deletion_pending",
          });
          throw mocks.deleteError;
        }
        mocks.records = mocks.records.filter((account) => account.id !== id);
        return {
          deleted: true,
          leads: 12,
          message: "Account deleted. Activity history retained.",
        };
      }
      if (url.pathname.endsWith("/offboard-preview"))
        return { leads: 12, followups: 3, visits: 2, reminders: 1 };
      if (url.pathname.endsWith("/offboard")) {
        Object.assign(record, options.body.changes || {}, { active: false });
        return {
          leads: 12,
          followups: 3,
          visits: 2,
          reminders: 1,
          mode: options.body.mode,
        };
      }
      if (options.method === "PATCH") {
        Object.assign(record, options.body);
        return { ...record };
      }
      if (url.pathname.endsWith("/password")) return { updated: true };
      if (url.pathname.endsWith("/email-code/verify")) {
        if (mocks.codePending) await mocks.codePending;
        if (mocks.codeError) throw mocks.codeError;
        if (options.body.code !== "123456")
          throw failure("Wrong verification code or code expired.");
        Object.assign(record, {
          email_confirmed_at: new Date().toISOString(),
          invitation_state: "accepted",
          active: true,
          account_status: "active",
        });
        return {
          id: record.id,
          role: record.role,
          active: true,
          email_verified: true,
          message:
            "Email verified and password saved. The account can now sign in.",
        };
      }
      if (url.pathname.endsWith("/email-code")) {
        Object.assign(record, {
          email_verification_method: "email_otp",
          invitation_state: "sent",
        });
        return {
          email_code_sent: true,
          message: "Verification code requested. Check the agent's inbox.",
        };
      }
      if (url.pathname.endsWith("/verification")) return { sent: true };
      if (url.pathname.endsWith("/invitation")) {
        if (options.method === "DELETE") {
          Object.assign(record, {
            active: false,
            invitation_state: "cancelled",
            account_status: "invitation_cancelled",
          });
          return null;
        }
        return {
          invitation_required: true,
          invitation_sent: true,
          message:
            "Invitation requested. Waiting for email verification and password setup.",
        };
      }
      return {
        ...record,
        assigned_leads: 12,
        completed_calls: 9,
        open_followups: 3,
      };
    }
    if (path === "/users") return mocks.records;
    if (url.pathname === "/reminders" || url.pathname === "/leaderboard")
      return [];
    if (url.pathname === "/reports") return {};
    return { data: [], count: 0 };
  });
});
afterEach(() => {
  qc?.clear();
});

describe("Account email codes in Accounts", () => {
  it("directs a partial independent account to resume without exposing alternate activation or password controls", async () => {
    Object.assign(mocks.records[1], {
      active: false,
      account_creation_pending: true,
      account_status: "pending_verification",
    });
    open();
    await unlock();
    expect(
      screen.getByRole("button", { name: "Edit Agent Person" }),
    ).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Enable Agent Person" }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    await screen.findByText(/Account setup is incomplete/);
    expect(
      screen.queryByRole("button", { name: "Set password" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Reset two-factor" }),
    ).not.toBeInTheDocument();
  });
  it("reopens code setup for an inactive admin whose enrollment staging was interrupted", async () => {
    Object.assign(mocks.records[1], {
      role: "admin",
      active: false,
      email_confirmed_at: null,
    });
    delete mocks.records[1].email_verification_method;
    delete mocks.records[1].invitation_state;
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Verify email for Agent Person" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByLabelText("Email verification code"),
    ).toBeInTheDocument();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Resend verification code" }),
    );
    expect(mocks.api).toHaveBeenCalledWith(
      `/accounts/${agent.id}/email-code`,
      expect.objectContaining({ method: "POST", body: {} }),
    );
    expect(accountCalls().some(([path]) => path.endsWith("/invitation"))).toBe(
      false,
    );
  });
  async function codeDialog(role = "agent") {
    Object.assign(mocks.records[1], {
      role,
      active: false,
      email_confirmed_at: null,
      invitation_state: "sent",
      invitation_required: true,
      account_status: "pending_verification",
      email_verification_method: "email_otp",
    });
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Verify email for Agent Person" }),
    );
    return screen.getByRole("dialog");
  }
  function fillCode(
    dialog,
    code = "123456",
    confirmation = "initial-agent-password-123",
  ) {
    fireEvent.change(within(dialog).getByLabelText("Email verification code"), {
      target: { value: code },
    });
    fireEvent.change(
      within(dialog).getByLabelText("New password", { exact: true }),
      { target: { value: "initial-agent-password-123" } },
    );
    fireEvent.change(within(dialog).getByLabelText("Confirm password"), {
      target: { value: confirmation },
    });
  }
  it.each(["agent", "admin"])(
    "verifies a pending %s with an emailed code and password without an invitation link",
    async (role) => {
      const dialog = await codeDialog(role);
      expect(within(dialog).queryByRole("link")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Resend invitation" }),
      ).not.toBeInTheDocument();
      fillCode(dialog);
      await userEvent.click(
        within(dialog).getByRole("button", {
          name: "Verify email and save password",
        }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(mocks.api).toHaveBeenCalledWith(
        `/accounts/${agent.id}/email-code/verify`,
        expect.objectContaining({
          method: "POST",
          body: { code: "123456", password: "initial-agent-password-123" },
          headers: { "X-Accounts-Unlock": mocks.token },
        }),
      );
      expect(mocks.records[1]).toMatchObject({
        active: true,
        invitation_state: "accepted",
      });
      expect(screen.queryByLabelText("New password")).not.toBeInTheDocument();
    },
  );
  it("keeps incorrect-code errors visible and resends using the code endpoint", async () => {
    const dialog = await codeDialog();
    fillCode(dialog, "999999");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Verify email and save password",
      }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Wrong verification code",
    );
    expect(mocks.records[1].active).toBe(false);
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Resend verification code" }),
    );
    expect(await within(dialog).findByRole("status")).toHaveTextContent(
      "agent's inbox",
    );
    expect(mocks.api).toHaveBeenCalledWith(
      `/accounts/${agent.id}/email-code`,
      expect.objectContaining({ method: "POST", body: {} }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.records[1].active).toBe(false);
  });
  it("validates code shape and password confirmation before making a verification request", async () => {
    const dialog = await codeDialog();
    expect(
      within(dialog).getByLabelText("Email verification code"),
    ).toHaveAttribute("inputmode", "numeric");
    for (const invalidCode of [
      "12",
      "1234",
      "1234567",
      "1234567890",
      "abcdef",
      "１２３４５６",
    ]) {
      fillCode(dialog, invalidCode);
      await userEvent.click(
        within(dialog).getByRole("button", {
          name: "Verify email and save password",
        }),
      );
      expect(await within(dialog).findByRole("alert")).toHaveTextContent(
        "6-digit",
      );
    }
    fillCode(dialog, "123456", "different-password-123");
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Verify email and save password",
      }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Passwords must match",
    );
    expect(
      accountCalls().filter(([path]) => path.endsWith("/email-code/verify")),
    ).toHaveLength(0);
  });
  it("guards duplicate verification and dismissal until the request completes", async () => {
    let resolve;
    mocks.codePending = new Promise((r) => {
      resolve = r;
    });
    const dialog = await codeDialog();
    fillCode(dialog);
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Verify email and save password",
      }),
    );
    fireEvent.submit(dialog.querySelector("form"));
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Close dialog" }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("button", { name: "Resend verification code" }),
    ).toBeDisabled();
    expect(
      accountCalls().filter(([path]) => path.endsWith("/email-code/verify")),
    ).toHaveLength(1);
    await act(async () => resolve());
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("allows retry after a server error without granting local access", async () => {
    const dialog = await codeDialog();
    fillCode(dialog);
    mocks.codeError = failure(
      "Email verified, but the password could not be saved.",
      503,
    );
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Verify email and save password",
      }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "password could not be saved",
    );
    expect(mocks.records[1].active).toBe(false);
    mocks.codeError = null;
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Verify email and save password",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.records[1].active).toBe(true);
  });
});

describe("Accounts and Security administration", () => {
  it("shows tracked invitation state and offers resend/cancellation without enabling access", async () => {
    Object.assign(mocks.records[1], {
      role: "admin",
      active: false,
      email_confirmed_at: null,
      account_status: "pending_verification",
      invitation_state: "sent",
      invitation_required: true,
      email_verification_method: "link",
      invitation_date: new Date().toISOString(),
      invitation_expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    open();
    await unlock();
    expect(
      screen.queryByRole("button", { name: "Enable Agent Person" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    await screen.findByRole("button", { name: "Resend invitation" });
    expect(
      screen.queryByRole("button", { name: "Set password" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Resend invitation" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.api).toHaveBeenCalledWith(
      `/accounts/${agent.id}/invitation`,
      expect.objectContaining({ method: "POST", body: {} }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    await screen.findByRole("button", { name: "Cancel pending invitation" });
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel pending invitation" }),
    );
    await screen.findByRole("button", {
      name: "Cancel invitation",
      exact: true,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Cancel invitation", exact: true }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.api).toHaveBeenCalledWith(
      `/accounts/${agent.id}/invitation`,
      expect.objectContaining({ method: "DELETE", body: {} }),
    );
    expect(screen.getByText("Invitation cancelled")).toBeInTheDocument();
  });
  it("shows admin sidebar links and requests no account data before PIN unlock", async () => {
    open();
    expect(
      await screen.findByRole("heading", { name: "Accounts is protected" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Accounts", exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Admin settings", exact: true }),
    ).toBeInTheDocument();
    expect(accountCalls()).toHaveLength(0);
    expect(screen.queryByText("agent@example.com")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Create account" }),
    ).not.toBeInTheDocument();
    await unlock();
    expect(screen.getByText("agent@example.com")).toBeInTheDocument();
    expect(accountCalls()[0][1].headers).toEqual({
      "X-Accounts-Unlock": mocks.token,
    });
    expect(
      qc
        .getQueryCache()
        .getAll()
        .some((q) => q.queryKey[0] === "accounts"),
    ).toBe(false);
  });
  it.each(["/accounts", "/settings/security"])(
    "keeps agents out of %s and hides account sidebar controls",
    async (path) => {
      mocks.user = { ...agent };
      open(path);
      expect(
        await screen.findByRole("heading", { name: "My overview" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Accounts", exact: true }),
      ).not.toBeInTheDocument();
      expect(mocks.api.mock.calls.some(([p]) => p.startsWith("/account"))).toBe(
        false,
      );
    },
  );
  it("directs first-time administrators to Security settings instead of opening Accounts", async () => {
    mocks.configured = false;
    open();
    await userEvent.click(
      await screen.findByRole("link", { name: "Set up Accounts PIN" }),
    );
    expect(
      await screen.findByRole("heading", { name: "Your Accounts PIN" }),
    ).toBeInTheDocument();
    expect(accountCalls()).toHaveLength(0);
  });
  it("retains the PIN gate after errors and clears sensitive data on manual lock", async () => {
    open();
    const input = await screen.findByLabelText("4-digit PIN");
    fireEvent.change(input, { target: { value: "9999" } });
    await userEvent.click(
      screen.getByRole("button", { name: "Unlock Accounts", exact: true }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Incorrect PIN");
    expect(accountCalls()).toHaveLength(0);
    expect(input).toHaveValue("");
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Lock Accounts" }),
    );
    expect(screen.queryByText("agent@example.com")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Accounts is protected" }),
    ).toBeInTheDocument();
    expect(mocks.api).toHaveBeenCalledWith(
      "/account-security/lock",
      expect.objectContaining({
        method: "POST",
        headers: { "X-Accounts-Unlock": mocks.token },
      }),
    );
  });
  it("locks on expiry and clears visible account data", async () => {
    mocks.expiry = new Date(Date.now() + 800).toISOString();
    open();
    await unlock();
    await waitFor(
      () =>
        expect(
          screen.getByRole("heading", { name: "Accounts is protected" }),
        ).toBeInTheDocument(),
      { timeout: 2000 },
    );
    expect(screen.queryByText("agent@example.com")).not.toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("expired");
  });
  it("ignores a late list response after locking", async () => {
    const original = mocks.api.getMockImplementation();
    let resolve;
    mocks.api.mockImplementation((path, options) =>
      path.startsWith("/accounts?") && path.includes("search=late")
        ? new Promise((r) => {
            resolve = r;
          })
        : original(path, options),
    );
    open();
    await unlock();
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search accounts" }),
      { target: { value: "late" } },
    );
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    await userEvent.click(
      screen.getByRole("button", { name: "Lock Accounts" }),
    );
    await act(async () =>
      resolve({ data: [agent], count: 1, summary: { total: 1 } }),
    );
    expect(screen.queryByText("agent@example.com")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Accounts is protected" }),
    ).toBeInTheDocument();
  });
  it("revokes a late unlock when the user leaves the page", async () => {
    const original = mocks.api.getMockImplementation();
    let resolve;
    mocks.api.mockImplementation((path, options) =>
      path === "/account-security/unlock"
        ? new Promise((r) => {
            resolve = r;
          })
        : original(path, options),
    );
    open();
    fireEvent.change(await screen.findByLabelText("4-digit PIN"), {
      target: { value: "0123" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Unlock Accounts", exact: true }),
    );
    await userEvent.click(
      screen.getByRole("link", { name: "Security settings", exact: true }),
    );
    await screen.findByRole("heading", { name: "Your Accounts PIN" });
    await act(async () =>
      resolve({
        token: mocks.token,
        expires_at: new Date(Date.now() + 900000).toISOString(),
      }),
    );
    expect(accountCalls()).toHaveLength(0);
    expect(mocks.api).toHaveBeenCalledWith(
      "/account-security/lock",
      expect.objectContaining({
        headers: { "X-Accounts-Unlock": mocks.token },
      }),
    );
  });
  it.each(["agent", "admin"])(
    "creates %s accounts directly with an automatic UID and a success popup",
    async (role) => {
      const dialog = await openCreate();
      expect(
        within(dialog).getByRole("radio", { name: "Auto Generate UID" }),
      ).toBeChecked();
      expect(
        within(dialog).queryByLabelText("Enter 6-Digit UID"),
      ).not.toBeInTheDocument();
      fillAccount(dialog, { email: "  New.Person@Gmail.com " });
      await userEvent.selectOptions(
        within(dialog).getByLabelText("Account role"),
        role,
      );
      await submitCreate(dialog);
      const popup = await screen.findByRole("dialog", {
        name: "Account Created Successfully!",
      });
      for (const text of [
        "New Person",
        "new.person@gmail.com",
        role === "admin" ? "Admin" : "Agent",
        "908234",
        "Active",
      ])
        expect(within(popup).getByText(text)).toBeInTheDocument();
      expect(within(popup).getByText("Active")).toHaveClass("active");
      expect(popup).not.toHaveTextContent("new-account-password-123");
      expect(createCalls()).toHaveLength(1);
      expect(createCalls()[0][1].body).toEqual({
        name: "New Person",
        email: "new.person@gmail.com",
        role,
        password: "new-account-password-123",
        uid_mode: "auto",
      });
      // The administrator's own session is untouched.
      expect(mocks.user.id).toBe(admin.id);
      expect(
        screen.queryByRole("heading", { name: "Verify Email Address" }),
      ).not.toBeInTheDocument();
      await userEvent.click(
        within(popup).getByRole("button", { name: "Done" }),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
      );
      expect(
        await screen.findByRole("button", { name: "Details for New Person" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Copy UID 908234" }),
      ).toBeInTheDocument();
    },
  );
  it("assigns a manual UID only after it is confirmed available", async () => {
    const dialog = await openCreate();
    fillAccount(dialog);
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Enter UID Manually" }),
    );
    const uid = within(dialog).getByLabelText("Enter 6-Digit UID");
    fireEvent.change(uid, { target: { value: String(agent.uid) } });
    expect(
      await within(dialog).findByText(
        "This UID is already assigned to another account. Please choose a different UID.",
      ),
    ).toBeInTheDocument();
    await submitCreate(dialog);
    expect(createCalls()).toHaveLength(0);
    fireEvent.change(uid, { target: { value: "246810" } });
    expect(
      await within(dialog).findByText("UID 246810 is available."),
    ).toBeInTheDocument();
    await submitCreate(dialog);
    const popup = await screen.findByRole("dialog", {
      name: "Account Created Successfully!",
    });
    expect(within(popup).getByText("246810")).toBeInTheDocument();
    expect(createCalls()[0][1].body).toMatchObject({
      uid_mode: "manual",
      uid: "246810",
    });
  });
  it("validates manual UID format inline without contacting the server", async () => {
    const dialog = await openCreate();
    fillAccount(dialog);
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Enter UID Manually" }),
    );
    const uid = within(dialog).getByLabelText("Enter 6-Digit UID");
    for (const [value, message] of [
      ["12345", "Enter exactly 6 digits."],
      ["1234567", "Enter exactly 6 digits."],
      ["12a456", "Use numbers only (0–9)."],
      ["58321!", "Use numbers only (0–9)."],
      ["012345", "The UID cannot begin with 0."],
      ["", "Enter the 6-digit UID."],
    ]) {
      fireEvent.change(uid, { target: { value } });
      fireEvent.blur(uid);
      expect(await within(dialog).findByText(message)).toBeInTheDocument();
    }
    await submitCreate(dialog);
    expect(createCalls()).toHaveLength(0);
    expect(
      mocks.api.mock.calls.some(([path]) =>
        path.startsWith("/accounts/uid-availability"),
      ),
    ).toBe(false);
    // Switching back to automatic assignment clears the manual entry error.
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Auto Generate UID" }),
    );
    expect(
      within(dialog).queryByText("Enter the 6-digit UID."),
    ).not.toBeInTheDocument();
  });
  it.each([
    "john@yahoo.com",
    "john@outlook.com",
    "john@company.com",
    "john@gmail.co",
    "john@gmail.com.fake",
    "john@gmail",
    "invalid-email",
  ])(
    "shows the Gmail-only message for %s and blocks creation",
    async (email) => {
      const dialog = await openCreate();
      fillAccount(dialog, { email });
      fireEvent.blur(within(dialog).getByLabelText("Gmail address"));
      expect(
        await within(dialog).findByText(
          "Only valid @gmail.com email addresses are allowed.",
        ),
      ).toBeInTheDocument();
      await submitCreate(dialog);
      expect(createCalls()).toHaveLength(0);
    },
  );
  it("shows server email and UID conflicts on the matching field", async () => {
    mocks.records.push({
      ...agent,
      id: crypto.randomUUID(),
      uid: 135790,
      name: "Existing Gmail",
      email: "taken@gmail.com",
    });
    const dialog = await openCreate();
    fillAccount(dialog, { email: "taken@gmail.com" });
    await submitCreate(dialog);
    expect(
      await within(dialog).findByText(
        "An account with this email already exists.",
      ),
    ).toBeInTheDocument();
    // Another admin may take an available UID before this form is submitted.
    mocks.createError = failure(
      "This UID is already assigned to another account. Please choose a different UID.",
      409,
      "ACCOUNTS_UID_TAKEN",
    );
    fillAccount(dialog, { email: "fresh@gmail.com" });
    await userEvent.click(
      within(dialog).getByRole("radio", { name: "Enter UID Manually" }),
    );
    fireEvent.change(within(dialog).getByLabelText("Enter 6-Digit UID"), {
      target: { value: "975310" },
    });
    expect(
      await within(dialog).findByText("UID 975310 is available."),
    ).toBeInTheDocument();
    await submitCreate(dialog);
    expect(
      await within(dialog).findByText(
        "This UID is already assigned to another account. Please choose a different UID.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("dialog", { name: "Account Created Successfully!" }),
    ).not.toBeInTheDocument();
    expect(mocks.records).toHaveLength(3);
  });
  it("guards dismissal while creating and reports an incomplete setup without a success popup", async () => {
    let release;
    mocks.createPending = new Promise((resolve) => {
      release = resolve;
    });
    mocks.createError = failure(
      "The login account was created with UID 908234, but its setup could not finish. It stays disabled until an administrator enables it in Accounts.",
      503,
      "ACCOUNTS_CREATE_INCOMPLETE",
    );
    const dialog = await openCreate();
    fillAccount(dialog);
    await submitCreate(dialog);
    expect(
      within(dialog).getByRole("button", { name: "Creating account…" }),
    ).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    const lists = () =>
      accountCalls().filter(
        ([path, options]) => path.startsWith("/accounts?") && !options?.method,
      ).length;
    const before = lists();
    await act(async () => release());
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "stays disabled",
    );
    await waitFor(() => expect(lists()).toBeGreaterThan(before));
    expect(
      screen.queryByRole("dialog", { name: "Account Created Successfully!" }),
    ).not.toBeInTheDocument();
  });
  it("preserves invalid account drafts and allows cancellation without creating anything", async () => {
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Create account", exact: true }),
    );
    fireEvent.change(screen.getByLabelText("Full name"), {
      target: { value: "Draft" },
    });
    fireEvent.change(screen.getByLabelText("Gmail address"), {
      target: { value: "draft@gmail.com" },
    });
    fireEvent.change(screen.getByLabelText("New password", { exact: true }), {
      target: { value: "draft-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "draft-password-123" },
    });
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      path === "/accounts" && options?.method === "POST"
        ? Promise.reject(
            new Error("An account with this email already exists."),
          )
        : original(path, options),
    );
    await userEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Create account",
        exact: true,
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "already exists",
    );
    expect(mocks.records).toHaveLength(2);
    expect(screen.getByLabelText("Full name")).toHaveValue("Draft");
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("shows UIDs on account cards and details with a copy action", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    try {
      open();
      await unlock();
      expect(screen.getByText(String(agent.uid))).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: `Copy UID ${agent.uid}` }),
      );
      expect(writeText).toHaveBeenCalledWith(String(agent.uid));
      expect(
        await screen.findByText(`UID ${agent.uid} copied.`),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: "Details for Agent Person" }),
      );
      const details = screen.getByRole("dialog");
      expect(
        await within(details).findByText(String(agent.uid)),
      ).toBeInTheDocument();
      expect(within(details).getByText("UID")).toBeInTheDocument();
    } finally {
      delete navigator.clipboard;
    }
  });
  it("finds accounts by UID", async () => {
    open();
    await unlock();
    const search = screen.getByRole("searchbox", { name: "Search accounts" });
    expect(search).toHaveAttribute(
      "placeholder",
      "Search by name, email or UID…",
    );
    fireEvent.change(search, { target: { value: String(agent.uid) } });
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Details for Own Admin" }),
      ).not.toBeInTheDocument(),
    );
    expect(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    ).toBeInTheDocument();
    expect(
      accountCalls().some(([path]) => path.includes(`search=${agent.uid}`)),
    ).toBe(true);
  });
  it.each([
    ["admin", "/accounts", "Admin"],
    ["agent", "/", "Agent"],
  ])(
    "shows the signed-in %s their read-only UID in My profile",
    async (role, path, label) => {
      const person = role === "admin" ? admin : agent;
      mocks.user = { ...person };
      open(path);
      expect(
        await screen.findByText(`${role} · UID ${person.uid}`),
      ).toBeInTheDocument();
      await userEvent.click(
        screen.getByRole("button", { name: `My profile: ${person.name}` }),
      );
      const panel = screen.getByRole("region", { name: "My profile" });
      for (const text of [
        person.name,
        person.email,
        label,
        "Employee UID",
        String(person.uid),
      ])
        expect(within(panel).getByText(text)).toBeInTheDocument();
      expect(within(panel).queryByRole("textbox")).not.toBeInTheDocument();
      expect(within(panel).queryByRole("spinbutton")).not.toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(
        screen.queryByRole("region", { name: "My profile" }),
      ).not.toBeInTheDocument();
    },
  );
  it("shows detailed account activity, permits editing, and protects the current administrator", async () => {
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    expect(await screen.findByText("Assigned leads")).toBeInTheDocument();
    expect(screen.getByText("12", { exact: true })).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit account", exact: true }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Account role"),
      "admin",
    );
    await userEvent.click(screen.getByRole("button", { name: "Save account" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.records.find((r) => r.id === agent.id).role).toBe("admin");
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Own Admin" }),
    );
    expect(screen.queryByLabelText("Account role")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Account access")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Disable Own Admin" }),
    ).not.toBeInTheDocument();
  });
  it("confirms access changes and keeps account history in place", async () => {
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Disable Agent Person" }),
    );
    expect(
      await screen.findByText(/Choose who will take over this work/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Cancel", exact: true }),
    );
    expect(mocks.records[1].active).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Disable Agent Person" }),
    );
    await userEvent.click(
      await screen.findByLabelText("Keep with admin (unassigned)"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Disable access", exact: true }),
    );
    expect(
      await screen.findByRole("button", { name: "Enable Agent Person" }),
    ).toBeInTheDocument();
    expect(mocks.records[1].active).toBe(false);
  });
  it("previews counts, defaults to equal sharing and submits a selected receiving agent", async () => {
    const receiver = {
      ...agent,
      id: "81000000-0000-4000-8000-000000000003",
      name: "Receiving agent",
    };
    mocks.records.push(receiver);
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Disable Agent Person" }),
    );
    await screen.findByText("12 leads");
    expect(
      screen.getByLabelText("Share equally among all active agents"),
    ).toBeChecked();
    expect(screen.getByText("3 pending follow-ups")).toBeInTheDocument();
    expect(
      accountCalls().filter(
        ([p, o]) => p.endsWith("/offboard") && o?.method === "POST",
      ),
    ).toHaveLength(0);
    await userEvent.click(screen.getByLabelText("Give all to one agent"));
    await userEvent.selectOptions(
      screen.getByLabelText("Receiving agent"),
      receiver.id,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Disable access", exact: true }),
    );
    await screen.findByRole("button", { name: "Enable Agent Person" });
    expect(
      accountCalls().find(([p]) => p.endsWith("/offboard"))[1].body,
    ).toEqual({ mode: "single", target: receiver.id });
  });
  it("routes an edit that disables an agent through confirmation without a bypassing PATCH", async () => {
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Agent Person" }),
    );
    await userEvent.selectOptions(
      screen.getByLabelText("Account access"),
      "disabled",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Save account", exact: true }),
    );
    await screen.findByText("12 leads");
    expect(
      accountCalls().filter(([, o]) => o?.method === "PATCH"),
    ).toHaveLength(0);
    await userEvent.click(
      screen.getByLabelText("Keep with admin (unassigned)"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Disable access", exact: true }),
    );
    await screen.findByRole("button", { name: "Enable Agent Person" });
    expect(
      accountCalls().find(([p]) => p.endsWith("/offboard"))[1].body.changes,
    ).toEqual({ name: "Agent Person", role: "agent" });
  });
  it("sets a new password with confirmation without displaying any existing password", async () => {
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    await userEvent.click(
      await screen.findByRole("button", { name: "Set password", exact: true }),
    );
    expect(screen.getByLabelText("New password", { exact: true })).toHaveValue(
      "",
    );
    fireEvent.change(screen.getByLabelText("New password", { exact: true }), {
      target: { value: "new-private-password-123" },
    });
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "different-password-123" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Update password" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Passwords must match",
    );
    fireEvent.change(screen.getByLabelText("Confirm password"), {
      target: { value: "new-private-password-123" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Update password" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.api).toHaveBeenCalledWith(
      `/accounts/${agent.id}/password`,
      expect.objectContaining({
        method: "POST",
        body: { password: "new-private-password-123" },
      }),
    );
  });
  it("blocks modal dismissal and fields while an account mutation is pending", async () => {
    const original = mocks.api.getMockImplementation();
    let resolve;
    mocks.api.mockImplementation((path, options) =>
      path === `/accounts/${agent.id}` && options?.method === "PATCH"
        ? new Promise((r) => {
            resolve = r;
          })
        : original(path, options),
    );
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit Agent Person" }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save account" }));
    expect(screen.getByLabelText("Full name")).toBeDisabled();
    expect(screen.getByLabelText("Account role")).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await act(async () => resolve(agent));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("relocks when the server revokes an unlock token", async () => {
    open();
    await unlock();
    mocks.unlocked = false;
    await userEvent.selectOptions(
      screen.getByLabelText("Filter account role"),
      "agent",
    );
    expect(
      await screen.findByRole("heading", { name: "Accounts is protected" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("agent@example.com")).not.toBeInTheDocument();
  });
  it("searches, filters and paginates accounts", async () => {
    mocks.records.push(
      ...Array.from({ length: 21 }, (_, i) => ({
        ...agent,
        id: crypto.randomUUID(),
        name: `Member ${i}`,
        email: `member${i}@example.com`,
      })),
    );
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Next", exact: true }),
    );
    await waitFor(() =>
      expect(accountCalls().some(([path]) => path.includes("page=2"))).toBe(
        true,
      ),
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search accounts" }),
      { target: { value: "agent@example.com" } },
    );
    expect(await screen.findByText("agent@example.com")).toBeInTheDocument();
    expect(screen.queryByText("admin@example.com")).not.toBeInTheDocument();
    await userEvent.selectOptions(
      screen.getByLabelText("Filter account access"),
      "disabled",
    );
    expect(
      await screen.findByText("No accounts match your filters."),
    ).toBeInTheDocument();
  });
  it("sets and resets a personal PIN using the current login password", async () => {
    mocks.configured = false;
    open("/settings/security");
    await screen.findByRole("heading", { name: "Your Accounts PIN" });
    fireEvent.change(screen.getByLabelText("Current login password"), {
      target: { value: "wrong" },
    });
    fireEvent.change(screen.getByLabelText("New 4-digit PIN"), {
      target: { value: "0456" },
    });
    fireEvent.change(screen.getByLabelText("Confirm PIN"), {
      target: { value: "0456" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Set Accounts PIN" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("not accepted");
    expect(screen.getByLabelText("Current login password")).toHaveValue("");
    expect(screen.getByLabelText("New 4-digit PIN")).toHaveValue("0456");
    fireEvent.change(screen.getByLabelText("Current login password"), {
      target: { value: "current-password-fixture" },
    });
    await userEvent.click(
      screen.getByRole("button", { name: "Set Accounts PIN" }),
    );
    expect(await screen.findByText("PIN configured")).toBeInTheDocument();
    expect(screen.getByLabelText("New 4-digit PIN")).toHaveValue("");
    expect(screen.getByLabelText("Current login password")).toHaveValue("");
    expect(mocks.api).toHaveBeenCalledWith(
      "/account-security",
      expect.objectContaining({
        method: "PUT",
        body: {
          pin: "0456",
          confirm_pin: "0456",
          password: "current-password-fixture",
        },
      }),
    );
  });
  it("explains a missing migration without revealing account data", async () => {
    mocks.api.mockRejectedValue(
      failure(
        "Accounts needs a database update. Apply CRM migration 016.",
        503,
        "ACCOUNTS_MIGRATION_REQUIRED",
      ),
    );
    open();
    expect(await screen.findByRole("alert")).toHaveTextContent("016");
    expect(accountCalls()).toHaveLength(0);
  });
});

describe("Pending email ownership screens", () => {
  it("shows pending status and resends from account details without setting confirmation locally", async () => {
    mocks.records[1].role = "admin";
    mocks.records[1].email_confirmed_at = null;
    open();
    await unlock();
    expect(
      await screen.findByText("Pending email confirmation"),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByText("Unconfirmed");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Resend confirmation email" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(mocks.api).toHaveBeenCalledWith(
      `/accounts/${agent.id}/verification`,
      expect.objectContaining({
        method: "POST",
        body: {},
        headers: { "X-Accounts-Unlock": mocks.token },
      }),
    );
    expect(
      await screen.findByText(/Verification email requested/),
    ).toBeInTheDocument();
    expect(screen.getByText("Pending email confirmation")).toBeInTheDocument();
  });
  it("keeps the pending account and readable retry error when sending fails", async () => {
    mocks.records[1].role = "admin";
    mocks.records[1].email_confirmed_at = null;
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      path.endsWith("/verification")
        ? Promise.reject(
            failure(
              "Verification email could not be sent. Check Supabase email delivery settings.",
              503,
            ),
          )
        : original(path, options),
    );
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    const button = await screen.findByRole("button", {
      name: "Resend confirmation email",
    });
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "email delivery settings",
    );
    expect(button).toBeEnabled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("guards repeat resend and dismissal while sending, with only one mail request", async () => {
    mocks.records[1].role = "admin";
    mocks.records[1].email_confirmed_at = null;
    let resolve;
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      path.endsWith("/verification")
        ? new Promise((done) => (resolve = done))
        : original(path, options),
    );
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    const button = await screen.findByRole("button", {
      name: "Resend confirmation email",
    });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(
      screen.getByRole("button", { name: "Requesting email…" }),
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit account" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(
      mocks.api.mock.calls.filter(([p]) => p.endsWith("/verification")),
    ).toHaveLength(1);
    await act(async () => resolve({ sent: true }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
  it("offers no resend button for a confirmed account", async () => {
    open();
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    await screen.findByText("Confirmed");
    expect(
      screen.queryByRole("button", { name: "Resend confirmation email" }),
    ).not.toBeInTheDocument();
  });
});

describe("PIN-protected MFA account recovery controls", () => {
  it("confirms a factor reset for another account and retains no false success on failure", async () => {
    const original = mocks.api.getMockImplementation();
    mocks.api.mockImplementation((path, options) =>
      path.endsWith("/mfa-reset")
        ? Promise.reject(
            new Error("Reset could not be completed. Access remains blocked."),
          )
        : original(path, options),
    );
    open();
    await unlock();
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Agent Person" }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Reset two-factor" }),
    );
    await screen.findByRole("heading", { name: "Reset two-factor login" });
    expect(
      mocks.api.mock.calls.some(([path]) => path.endsWith("/mfa-reset")),
    ).toBe(false);
    fireEvent.click(
      screen.getByRole("button", { name: "Confirm two-factor reset" }),
    );
    await screen.findByText(
      "Reset could not be completed. Access remains blocked.",
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.api).toHaveBeenCalledWith(
      `/accounts/${agent.id}/mfa-reset`,
      expect.objectContaining({
        method: "POST",
        body: { confirm: true },
        headers: { "X-Accounts-Unlock": mocks.token },
      }),
    );
  });
  it("does not offer an administrator their own factor reset", async () => {
    open();
    await unlock();
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Own Admin" }),
    );
    await screen.findByText("Your account");
    expect(
      screen.queryByRole("button", { name: "Reset two-factor" }),
    ).toBeNull();
  });
  it("does not offer factor reset for another administrator", async () => {
    mocks.records.push({
      ...admin,
      id: "81000000-0000-4000-8000-000000000003",
      name: "Another Admin",
    });
    open();
    await unlock();
    fireEvent.click(
      screen.getByRole("button", { name: "Details for Another Admin" }),
    );
    await screen.findByRole("heading", { name: "Account details" });
    expect(
      screen.queryByRole("button", { name: "Reset two-factor" }),
    ).toBeNull();
  });
});

describe("delete account controls", () => {
  const deletions = () =>
    accountCalls().filter(
      ([path, options]) =>
        options?.method === "DELETE" && path === `/accounts/${agent.id}`,
    );
  async function confirmDialog() {
    await unlock();
    await userEvent.click(
      screen.getByRole("button", { name: `Delete ${agent.name}`, exact: true }),
    );
    return screen.getByRole("dialog", { name: "Delete account" });
  }
  it("offers deletion for another account and protects the current administrator", async () => {
    open();
    await unlock();
    expect(
      screen.getByRole("button", { name: `Delete ${agent.name}` }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Delete ${admin.name}` }),
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: `Details for ${agent.name}` }),
    );
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Delete account",
        exact: true,
      }),
    );
    expect(
      screen.getByRole("dialog", { name: "Delete account" }),
    ).toBeInTheDocument();
    expect(deletions()).toHaveLength(0);
  });
  it("requires the exact email and allows cancellation without deleting", async () => {
    open();
    const dialog = await confirmDialog();
    const button = within(dialog).getByRole("button", {
      name: "Delete account",
      exact: true,
    });
    expect(button).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText("Confirm account email"), {
      target: { value: "wrong@example.test" },
    });
    expect(button).toBeDisabled();
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel", exact: true }),
    );
    expect(deletions()).toHaveLength(0);
  });
  it("deletes the confirmed account and refreshes the account list", async () => {
    open();
    const dialog = await confirmDialog();
    fireEvent.change(within(dialog).getByLabelText("Confirm account email"), {
      target: { value: agent.email },
    });
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Delete account",
        exact: true,
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: `Details for ${agent.name}` }),
      ).not.toBeInTheDocument(),
    );
    expect(deletions()).toHaveLength(1);
    expect(deletions()[0][1]).toMatchObject({
      body: { confirm: true, email: agent.email },
      headers: { "X-Accounts-Unlock": mocks.token },
    });
    expect(
      screen.getByText("Account deleted. Activity history retained."),
    ).toBeInTheDocument();
  });
  it("prevents double submission and retries a blocked partial deletion", async () => {
    let resolve;
    mocks.deletePending = new Promise((r) => (resolve = r));
    mocks.deleteError = failure(
      "Deletion could not finish. Retry Delete account.",
      503,
      "ACCOUNTS_DELETE_PENDING",
    );
    open();
    const dialog = await confirmDialog();
    fireEvent.change(within(dialog).getByLabelText("Confirm account email"), {
      target: { value: agent.email },
    });
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Delete account",
        exact: true,
      }),
    );
    fireEvent.submit(dialog.querySelector("form"));
    expect(deletions()).toHaveLength(1);
    expect(
      within(dialog).getByRole("button", { name: "Deleting…" }),
    ).toBeDisabled();
    await act(async () => resolve());
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Retry Delete account",
    );
    mocks.deletePending = null;
    mocks.deleteError = null;
    await userEvent.click(
      within(dialog).getByRole("button", {
        name: "Delete account",
        exact: true,
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(deletions()).toHaveLength(2);
  });
});
