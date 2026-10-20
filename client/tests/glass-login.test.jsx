import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import Login from "../src/pages/Login";

const mocks = vi.hoisted(() => ({
  signInToPortal: vi.fn(),
  auth: { user: null, error: null, recovering: false },
}));
vi.mock("../src/lib/supabase", () => ({
  configured: true,
  supabase: { auth: { signOut: vi.fn() } },
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ ...mocks.auth, finishRecovery: vi.fn() }),
}));
vi.mock("../src/lib/portalLogin", () => ({
  signInToPortal: mocks.signInToPortal,
}));
const original = window.matchMedia;
function allowMotion(allowed) {
  window.matchMedia = vi.fn((query) => ({
    matches: query.includes("reduce") ? !allowed : false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
}
beforeEach(() => {
  vi.clearAllMocks();
  window.matchMedia = original;
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
  window.matchMedia = original;
});
function openLogin() {
  return render(
    <MemoryRouter initialEntries={["/login"]}>
      <Routes>
        <Route path="/login" element={<Login />} />
      </Routes>
    </MemoryRouter>,
  );
}
const card = () => document.querySelector(".glass-login");
const heading = () => screen.getByRole("heading", { level: 1 });

describe("glass sign-in page", () => {
  it("shows the active form with the other role as a switch panel", () => {
    openLogin();
    expect(heading()).toHaveTextContent("Agent Login");
    expect(card()).toHaveAttribute("data-side", "agent");
    const preview = screen.getByRole("complementary", {
      name: "Admin Login option",
    });
    expect(preview).toHaveTextContent("Access management tools");
    expect(
      screen.getByRole("button", { name: "Open Admin Login" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Switch to Admin Login" }),
    ).toBeEnabled();
    // One real form: a single email and password field.
    expect(screen.getAllByLabelText("Email address")).toHaveLength(1);
    expect(screen.getAllByLabelText("Password", { exact: true })).toHaveLength(
      1,
    );
    expect(screen.queryByRole("link", { name: /sign up/i })).toBeNull();
  });
  it("switches with the centre button and the switch panel, clearing fields", () => {
    openLogin();
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "agent@example.com" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Admin Login" }),
    );
    expect(card()).toHaveAttribute("data-side", "admin");
    expect(heading()).toHaveTextContent("Admin Login");
    expect(screen.getByLabelText("Email address")).toHaveValue("");
    expect(
      screen.getByRole("button", { name: "Sign in as Admin" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "Agent Login option" }),
    ).toHaveTextContent("Manage your leads");
    fireEvent.click(screen.getByRole("button", { name: "Open Agent Login" }));
    expect(heading()).toHaveTextContent("Agent Login");
    expect(screen.getByLabelText("Email address")).toHaveFocus();
  });
  it("slides the panels at once and swaps the form halfway, ending on the last choice", () => {
    allowMotion(true);
    vi.useFakeTimers();
    openLogin();
    const toggle = () =>
      screen.getByRole("button", { name: /^Switch to (Admin|Agent) Login$/ });
    fireEvent.click(toggle());
    expect(card()).toHaveAttribute("data-side", "admin");
    expect(card()).toHaveAttribute("data-leaving", "true");
    expect(heading()).toHaveTextContent("Agent Login");
    act(() => vi.advanceTimersByTime(300));
    expect(heading()).toHaveTextContent("Admin Login");
    expect(card()).not.toHaveAttribute("data-leaving");
    // Rapid clicks: the form follows the final side only.
    fireEvent.click(toggle());
    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(toggle());
    act(() => vi.advanceTimersByTime(100));
    fireEvent.click(toggle());
    expect(card()).toHaveAttribute("data-side", "agent");
    act(() => vi.advanceTimersByTime(300));
    expect(heading()).toHaveTextContent("Agent Login");
    expect(card()).not.toHaveAttribute("data-leaving");
  });
  it("swaps immediately when the device prefers reduced motion", () => {
    allowMotion(false);
    openLogin();
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Admin Login" }),
    );
    expect(heading()).toHaveTextContent("Admin Login");
    expect(card()).not.toHaveAttribute("data-leaving");
  });
  it("validates both fields inline before calling the existing sign-in", async () => {
    openLogin();
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Agent" }));
    expect(await screen.findAllByText("Required")).toHaveLength(2);
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "not-an-email" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Agent" }));
    expect(await screen.findByText("Enter a valid email")).toBeInTheDocument();
    expect(screen.getByLabelText("Email address")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(mocks.signInToPortal).not.toHaveBeenCalled();
  });
  it("passes the chosen portal to the existing sign-in and locks switching while it runs", async () => {
    let finish;
    mocks.signInToPortal.mockReturnValue(
      new Promise((resolve, reject) => (finish = reject)),
    );
    openLogin();
    fireEvent.click(
      screen.getByRole("button", { name: "Switch to Admin Login" }),
    );
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "owner@example.com" },
    });
    fireEvent.change(screen.getByLabelText("Password", { exact: true }), {
      target: { value: "fixture-password-1234" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign in as Admin" }));
    expect(
      await screen.findByRole("button", { name: "Signing in…" }),
    ).toHaveAttribute("aria-busy", "true");
    expect(mocks.signInToPortal).toHaveBeenCalledWith(
      { email: "owner@example.com", password: "fixture-password-1234" },
      "admin",
    );
    for (const name of [
      "Switch to Agent Login",
      "Open Agent Login",
      "Agent",
      "Forgot password?",
    ])
      expect(screen.getByRole("button", { name, exact: true })).toBeDisabled();
    await act(async () =>
      finish(new Error("This account cannot sign in to the Admin portal.")),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "cannot sign in to the Admin portal",
    );
    expect(
      screen.getByRole("button", { name: "Switch to Agent Login" }),
    ).toBeEnabled();
  });
  it("hides the switch controls while resetting a password", () => {
    openLogin();
    fireEvent.click(screen.getByRole("button", { name: "Forgot password?" }));
    expect(heading()).toHaveTextContent("Reset password");
    expect(
      screen.queryByRole("button", { name: /^Switch to/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Login portal" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("complementary", { name: "About access" }),
    ).toHaveTextContent("There is no public sign-up.");
  });
});
