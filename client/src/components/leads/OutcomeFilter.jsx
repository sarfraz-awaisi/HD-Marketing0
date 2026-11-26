import { useEffect, useId, useRef, useState } from "react";
// The call outcome filter of Never assigned (update 088), built as the agent
// filter: checkboxes with Select all and Clear all. `value` is the chosen
// outcomes; onChange gets the new list in the options' order, empty for any
// outcome (then leads with no outcome saved show too).
export default function OutcomeFilter({ options, value, onChange }) {
  const id = useId();
  const box = useRef(null);
  const [open, setOpen] = useState(false);
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
  const label = !value.length
    ? "Any call outcome"
    : value.length <= 2
      ? value.join(", ")
      : `${value.length} call outcomes`;
  const toggle = (outcome) => {
    const next = new Set(chosen);
    if (!next.delete(outcome)) next.add(outcome);
    onChange(options.filter((o) => next.has(o)));
  };
  return (
    <span className="agent-filter" ref={box}>
      <button
        type="button"
        className="agent-filter-button"
        aria-label={`Filter by call outcome: ${label}`}
        aria-expanded={open}
        aria-controls={open ? `${id}-outcomes` : undefined}
        title={value.length > 2 ? value.join(", ") : undefined}
        onClick={() => setOpen((now) => !now)}
      >
        {label}
      </button>
      {open && (
        <span id={`${id}-outcomes`} className="agent-filter-panel">
          <span className="agent-filter-actions">
            <button
              type="button"
              disabled={value.length === options.length}
              onClick={() => onChange(options)}
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
          <span
            className="agent-filter-list"
            role="group"
            aria-label="Call outcomes"
          >
            {options.map((o) => (
              <label key={o} className="checkbox-field">
                <input
                  type="checkbox"
                  checked={chosen.has(o)}
                  onChange={() => toggle(o)}
                />
                <span>{o}</span>
              </label>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}
