import React from "react";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import PendingAccountVerification from "../src/components/accounts/PendingAccountVerification";
const id = "88000000-0000-4000-8000-000000000001";
const challenge = () => ({
  request_id: id,
  masked_email: "a***@example.test",
  name: "New teammate",
  role: "agent",
  status: "sent",
  expires_at: new Date(Date.now() + 600000).toISOString(),
  resend_at: new Date(Date.now() + 60000).toISOString(),
});
let request, onClose, onSaved, onChanged;
beforeEach(() => {
  request = vi.fn();
  onClose = vi.fn();
  onSaved = vi.fn();
  onChanged = vi.fn();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
});
afterEach(() => vi.useRealTimers());
const open = (props = {}) =>
  render(
    <PendingAccountVerification
      pending={challenge()}
      password="initial-account-password-123"
      request={request}
      onClose={onClose}
      onSaved={onSaved}
      onChanged={onChanged}
      {...props}
    />,
  );
it("focuses numeric input, accepts pasted six digits, masks the recipient and sends only code/password", async () => {
  request.mockResolvedValue({ completed: true, id });
  open();
  const input = screen.getByLabelText("Email verification code");
  expect(input).toHaveFocus();
  expect(input).toHaveAttribute("inputmode", "numeric");
  expect(screen.getByText(/a\*\*\*@example.test/)).toBeInTheDocument();
  fireEvent.change(input, { target: { value: "001234" } });
  await userEvent.click(
    screen.getByRole("button", { name: "Verify & Create Account" }),
  );
  expect(request).toHaveBeenCalledWith(`/accounts/pending/${id}/verify`, {
    method: "POST",
    body: { code: "001234", password: "initial-account-password-123" },
  });
  expect(onSaved).toHaveBeenCalledWith({ completed: true, id });
  expect(
    screen.queryByDisplayValue("initial-account-password-123"),
  ).not.toBeInTheDocument();
});
it("shows incorrect-code errors without closing or creating an account", async () => {
  request.mockRejectedValue(
    new Error("Invalid verification code. Please try again."),
  );
  open();
  fireEvent.change(screen.getByLabelText("Email verification code"), {
    target: { value: "999999" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Verify & Create Account" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid verification code",
  );
  expect(onSaved).not.toHaveBeenCalled();
  expect(onClose).not.toHaveBeenCalled();
});
it("shows expired-code error and enables resend only after the cooldown", async () => {
  vi.useFakeTimers();
  open();
  expect(
    screen.getByRole("button", { name: "Resend Code (60s)" }),
  ).toBeDisabled();
  act(() => vi.advanceTimersByTime(600000));
  expect(screen.getByRole("timer")).toHaveTextContent("has expired");
  expect(
    screen.getByRole("button", { name: "Verify & Create Account" }),
  ).toBeDisabled();
  expect(screen.getByRole("button", { name: "Resend Code" })).toBeEnabled();
});
it("resends through the stored request identity and resets code and timers", async () => {
  request.mockResolvedValue({ ...challenge(), message: "New code requested." });
  open({
    pending: {
      ...challenge(),
      resend_at: new Date(Date.now() - 1000).toISOString(),
    },
  });
  fireEvent.change(screen.getByLabelText("Email verification code"), {
    target: { value: "123456" },
  });
  await userEvent.click(screen.getByRole("button", { name: "Resend Code" }));
  expect(request).toHaveBeenCalledWith(`/accounts/pending/${id}/resend`, {
    method: "POST",
    body: {},
  });
  expect(screen.getByLabelText("Email verification code")).toHaveValue("");
  expect(onChanged).toHaveBeenCalled();
  expect(await screen.findByRole("status")).toHaveTextContent("New code");
});
it("cancels a pending request and guards duplicate submission and dismissal", async () => {
  let resolve;
  request.mockImplementation(() => new Promise((r) => (resolve = r)));
  open();
  fireEvent.change(screen.getByLabelText("Email verification code"), {
    target: { value: "123456" },
  });
  const form = screen.getByLabelText("Email verification code").closest("form");
  fireEvent.submit(form);
  fireEvent.submit(form);
  expect(request).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("button", { name: "Creating account…" }),
  ).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => resolve({ completed: true, id }));
  expect(onSaved).toHaveBeenCalledTimes(1);
});
it("requires the original password when resumed and never accepts changed identity fields", async () => {
  request.mockResolvedValue({ completed: true, id });
  open({ password: undefined });
  fireEvent.change(screen.getByLabelText("Email verification code"), {
    target: { value: "123456" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Verify & Create Account" }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "original password",
  );
  expect(request).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Original account password"), {
    target: { value: "initial-account-password-123" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: "Verify & Create Account" }),
  );
  expect(request.mock.calls[0][1].body).toEqual({
    code: "123456",
    password: "initial-account-password-123",
  });
});
it("cancel removes the request and closes without saving an account", async () => {
  request.mockResolvedValue(null);
  open();
  await userEvent.click(screen.getByRole("button", { name: "Cancel request" }));
  expect(request).toHaveBeenCalledWith(`/accounts/pending/${id}`, {
    method: "DELETE",
    body: {},
  });
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(onChanged).toHaveBeenCalledTimes(1);
  expect(onSaved).not.toHaveBeenCalled();
});
