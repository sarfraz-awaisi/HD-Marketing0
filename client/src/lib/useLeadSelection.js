import { useState } from "react";
// Store the filter with the selection: a changed filter clears it immediately,
// while paging within that filter retains selected IDs. At most max leads
// (500; Deleted leads allows 2,000, update 071).
export function useLeadSelection(filter, max = 500) {
  const [state, setState] = useState({ filter, ids: [] });
  // Update 071: a changed filter drops the selection for good, so going
  // back to the earlier filter never brings an old selection back.
  if (state.filter !== filter) setState({ filter, ids: [] });
  const ids = state.filter === filter ? state.ids : [];
  const replace = (next) => setState({ filter, ids: next.slice(0, max) });
  const toggle = (id, checked) =>
    setState((current) => {
      const existing = current.filter === filter ? current.ids : [];
      return {
        filter,
        ids: checked
          ? [...new Set([...existing, id])].slice(0, max)
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
          ? [...new Set([...existing, ...pageIds])].slice(0, max)
          : existing.filter((id) => !pageIds.has(id)),
      };
    });
  return { ids, max, toggle, togglePage, replace, clear: () => replace([]) };
}
