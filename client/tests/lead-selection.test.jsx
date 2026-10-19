import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Table } from "../src/components/common/UI";
import { useLeadSelection } from "../src/lib/useLeadSelection";
function List({ filter = "same", page = 1 }) {
  const selection = useLeadSelection(filter);
  return (
    <>
      <span>{selection.ids.length} selected</span>
      <Table
        showSerial
        page={page}
        rows={[{ id: String(page), name: "Customer " + page }]}
        columns={[{ key: "name", label: "Customer" }]}
        selection={selection}
      />
      <button onClick={selection.clear}>Clear selection</button>
    </>
  );
}
describe("bounded lead selection", () => {
  it("retains selected IDs on paging and clears on a changed filter", async () => {
    const user = userEvent.setup();
    const view = render(<List />);
    await user.click(
      screen.getByRole("checkbox", { name: "Select Customer 1" }),
    );
    view.rerender(<List page={2} />);
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(
      screen.getByRole("checkbox", { name: "Select all on this page" }),
    );
    expect(screen.getByText("2 selected")).toBeInTheDocument();
    view.rerender(<List filter="new" page={1} />);
    expect(screen.getByText("0 selected")).toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: "Select Customer 1" }),
    ).not.toBeChecked();
  });
  it("selects and unselects only the current page and clears explicitly", async () => {
    const user = userEvent.setup();
    const view = render(<List />);
    await user.click(
      screen.getByRole("checkbox", { name: "Select all on this page" }),
    );
    view.rerender(<List page={2} />);
    await user.click(
      screen.getByRole("checkbox", { name: "Select all on this page" }),
    );
    await user.click(
      screen.getByRole("checkbox", { name: "Select all on this page" }),
    );
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.getByText("0 selected")).toBeInTheDocument();
  });
});
