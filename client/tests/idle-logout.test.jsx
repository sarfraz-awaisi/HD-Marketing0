import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import IdleGuard from "../src/components/common/IdleGuard";
import {
  ACTIVITY_KEY,
  SIGNED_OUT_KEY,
  idleSettings,
} from "../src/lib/useIdleLogout";
const mocks = vi.hoisted(() => ({ logout: vi.fn(), auth: {} }));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ logout: mocks.logout, ...mocks.auth }),
}));
vi.mock("../src/lib/supabase", () => ({
  configured: true,
  supabase: { auth: { onAuthStateChange: vi.fn() } },
}));
const minutes = (n) => act(async () => vi.advanceTimersByTimeAsync(n * 60000));
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T10:00:00Z"));
  localStorage.clear();
  sessionStorage.clear();
  mocks.logout.mockReset().mockResolvedValue(undefined);
  mocks.auth = {};
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
});
afterEach(() => {
  vi.useRealTimers();
});
describe("automatic sign-out after inactivity", () => {
  it("warns five minutes early, lets the user stay, then signs out an idle session", async () => {
    render(<IdleGuard />);
    await minutes(24);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await minutes(1.5);
    expect(
      screen.getByRole("heading", { name: "Are you still there?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("timer")).toHaveTextContent(/4:\d\d/);
    fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await minutes(24);
    expect(mocks.logout).not.toHaveBeenCalled();
    await minutes(7);
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(SIGNED_OUT_KEY)).toBe("idle");
  });
  it("treats typing, clicks and touch as activity", async () => {
    render(<IdleGuard />);
    for (const event of ["keyDown", "mouseDown", "touchStart"]) {
      await minutes(20);
      fireEvent[event](window);
    }
    await minutes(20);
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("keeps sharing activity with other tabs during continuous mouse movement", async () => {
    render(<IdleGuard />);
    for (let second = 0; second < 35 * 60; second++) {
      fireEvent.mouseMove(window);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
    }
    expect(mocks.logout).not.toHaveBeenCalled();
    // Another tab reads this value; it must stay fresh, not frozen at start
    // (writes are throttled to one every 5 seconds).
    expect(
      Date.now() - Number(localStorage.getItem(ACTIVITY_KEY)),
    ).toBeLessThanOrEqual(7000);
  });
  it("keeps this tab signed in while another tab is in use", async () => {
    render(<IdleGuard />);
    await minutes(20);
    // Another CRM tab records activity in shared browser storage.
    localStorage.setItem(ACTIVITY_KEY, String(Date.now()));
    await minutes(20);
    expect(mocks.logout).not.toHaveBeenCalled();
    await minutes(11);
    expect(mocks.logout).toHaveBeenCalledTimes(1);
  });
  it("signs out immediately when a sleeping laptop wakes after the limit", async () => {
    render(<IdleGuard />);
    // Timers do not run during sleep; the wall clock still moves.
    vi.setSystemTime(Date.now() + 2 * 3600000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(mocks.logout).toHaveBeenCalledTimes(1);
  });
  it("offers an immediate sign-out from the warning", async () => {
    render(<IdleGuard />);
    await minutes(26);
    fireEvent.click(screen.getByRole("button", { name: "Sign out now" }));
    expect(mocks.logout).toHaveBeenCalledTimes(1);
  });
  it.each([
    [undefined, 30],
    ["45", 45],
    ["2", 30],
    ["not-a-number", 30],
    ["1000", 30],
  ])("reads VITE_IDLE_TIMEOUT_MINUTES=%s as %i minutes", (value, expected) => {
    expect(idleSettings(value).limit).toBe(expected * 60000);
  });
});
describe("sign-in notice", () => {
  it("explains an inactivity sign-out once on the login page", async () => {
    vi.useRealTimers();
    sessionStorage.setItem(SIGNED_OUT_KEY, "idle");
    mocks.auth = {
      user: null,
      error: "",
      recovering: false,
      finishRecovery: vi.fn(),
    };
    const { default: Login } = await import("../src/pages/Login");
    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>,
    );
    expect(await screen.findByRole("status")).toHaveTextContent(
      "signed out after 30 minutes of inactivity",
    );
    expect(sessionStorage.getItem(SIGNED_OUT_KEY)).toBeNull();
  });
});
