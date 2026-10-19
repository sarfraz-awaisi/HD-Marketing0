import { useState } from "react";
// Store the filter with the selection: a changed filter clears it immediately,
// while paging within that filter retains selected IDs.
export function useLeadSelection(filter) {
  const [state, setState] = useState({ filter, ids: [] });
  const ids = state.filter === filter ? state.ids : [];
  const replace = (next) => setState({ filter, ids: next });
  const toggle = (id, checked) =>
    setState((current) => {
      const existing = current.filter === filter ? current.ids : [];
      return {
        filter,
        ids: checked
          ? [...new Set([...existing, id])].slice(0, 500)
          : existing.filter((value) => value !== id),
      };
    });
  const togglePage = (rows, checked) =>
    setState((current) => {
      const existing = current.filter === filter ? current.ids : [];
      const pageIds = new Set(rows.map((row) => row.id));
      return {
        filter,
        ids: checked
          ? [...new Set([...existing, ...pageIds])].slice(0, 500)
          : existing.filter((id) => !pageIds.has(id)),
      };
    });
  return { ids, toggle, togglePage, replace, clear: () => replace([]) };
}
