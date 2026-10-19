import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { Protected } from "../src/App";
import OutcomeForm from "../src/components/calls/OutcomeForm";
import { RecordForm } from "../src/components/common/UI";
import { localISO, localInput, monthRange } from "../src/lib/api";
const auth = vi.hoisted(() => ({ user: null, loading: false }));
vi.mock("../src/context/AuthContext", () => ({ useAuth: () => auth }));
describe("route security", () => {
  it("redirects anonymous users to login", () => {
    auth.user = null;
    render(
      <MemoryRouter initialEntries={["/secure"]}>
        <Routes>
          <Route path="/login" element={<p>Login screen</p>} />
          <Route element={<Protected />}>
            <Route path="/secure" element={<p>Private lead</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("Login screen")).toBeInTheDocument();
    expect(screen.queryByText("Private lead")).not.toBeInTheDocument();
  });
  it("redirects agents from admin routes", () => {
    auth.user = { role: "agent" };
    render(
      <MemoryRouter initialEntries={["/admin"]}>
        <Routes>
          <Route path="/" element={<p>My overview</p>} />
          <Route element={<Protected role="admin" />}>
            <Route path="/admin" element={<p>Secret report</p>} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(screen.getByText("My overview")).toBeInTheDocument();
  });
});
describe("critical forms", () => {
  it("requires a call outcome and submits tags with notes", async () => {
    const save = vi.fn();
    const user = userEvent.setup();
    render(<OutcomeForm call={{}} onSave={save} />);
    await user.click(screen.getByText("Save outcome"));
    expect(save).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Choose a call outcome"),
    ).toBeInTheDocument();
    await user.selectOptions(
      screen.getByLabelText("Call outcome"),
      "Interested",
    );
    await user.click(screen.getByLabelText("Hot lead"));
    await user.type(screen.getByLabelText("Agent notes"), "Visit requested");
    await user.click(screen.getByText("Save outcome"));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith({
        outcome: "Interested",
        notes: "Visit requested",
        deal_tags: ["Hot lead"],
      }),
    );
  });
  it("validates required customer name before saving", async () => {
    const save = vi.fn();
    render(
      <RecordForm
        fields={[{ key: "name", label: "Customer", required: true }]}
        onSave={save}
      />,
    );
    await userEvent.click(screen.getByText("Save record"));
    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(save).not.toHaveBeenCalled();
  });
});
describe("Pakistan timestamps", () => {
  it("round-trips local form time", () => {
    expect(localISO("2026-10-08T14:00")).toBe("2026-10-08T09:00:00.000Z");
    expect(localInput("2026-10-08T09:00:00Z")).toBe("2026-10-08T14:00");
  });
  it("uses month boundaries in Pakistan", () => {
    expect(monthRange("2026-10")).toEqual({
      from: "2026-09-30T19:00:00.000Z",
      to: "2026-10-31T19:00:00.000Z",
    });
  });
});
