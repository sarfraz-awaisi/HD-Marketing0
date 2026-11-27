import { useEffect, useId, useRef, useState } from "react";
// The agent filter of All leads (update 082): one agent, several or all of
// them, as checkboxes with a search by name or UID, Select all (every agent
// the search shows) and Clear all. `value` is the chosen agent IDs; onChange
// gets the new list in the agents' order, empty for any agent. current
// (Never Worked's Assigned but Never Called, update 090): the agents who
// have the leads now.
export default function AgentFilter({
  agents,
  value,
  onChange,
  current = false,
}) {
  const id = useId();
  const box = useRef(null);
  const [open, setOpen] = useState(false),
    [text, setText] = useState("");
  useEffect(() => {
    if (!open) return;
    const away = (e) => !box.current?.contains(e.target) && setOpen(false);
    const escape = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  const chosen = new Set(value);
  const words = text.trim().toLowerCase();
  const shown = agents.filter(
    (a) =>
      !words ||
      a.name.toLowerCase().includes(words) ||
      String(a.uid || "").includes(words),
  );
  const names = agents.filter((a) => chosen.has(a.id)).map((a) => a.name);
  const label = !value.length
    ? current
      ? "Any current agent"
      : "Any agent"
    : agents.length > 1 && agents.every((a) => chosen.has(a.id))
      ? `All agents (${agents.length})`
      : value.length <= 2 && names.length === value.length
        ? names.join(", ")
        : `${value.length} agents`;
  const pick = (next) =>
    onChange(agents.filter((a) => next.has(a.id)).map((a) => a.id));
  const toggle = (agent) => {
    const next = new Set(chosen);
    if (!next.delete(agent)) next.add(agent);
    pick(next);
  };
  return (
    <span className="agent-filter" ref={box}>
      <button
        type="button"
        className="agent-filter-button"
        aria-label={`Filter by ${current ? "current agent" : "agent"}: ${label}`}
        aria-expanded={open}
        aria-controls={open ? `${id}-agents` : undefined}
        title={names.length > 2 ? names.join(", ") : undefined}
        onClick={() => setOpen((now) => !now)}
      >
        {label}
      </button>
      {open && (
        <span id={`${id}-agents`} className="agent-filter-panel">
          <input
            type="search"
            aria-label="Search agents"
            placeholder="Search agents by name or UID"
            value={text}
            autoFocus
            onChange={(e) => setText(e.target.value)}
          />
          <span className="agent-filter-actions">
            <button
              type="button"
              disabled={!shown.length}
              onClick={() =>
                pick(new Set([...value, ...shown.map((a) => a.id)]))
              }
            >
              Select all
            </button>
            <button
              type="button"
              disabled={!value.length}
              onClick={() => onChange([])}
            >
              Clear all
            </button>
          </span>
          <span className="agent-filter-list" role="group" aria-label="Agents">
            {shown.map((a) => (
              <label key={a.id} className="checkbox-field">
                <input
                  type="checkbox"
                  checked={chosen.has(a.id)}
                  onChange={() => toggle(a.id)}
                />
                <span>
                  {a.name}
                  {a.active ? "" : " (inactive)"}
                </span>
              </label>
            ))}
            {!shown.length && (
              <span className="lead-muted">No agent matches your search.</span>
            )}
          </span>
        </span>
      )}
    </span>
  );
}
