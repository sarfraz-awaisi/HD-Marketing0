import { useRef } from "react";
// Primary views and a smaller management group in one keyboard-navigable
// tab list (arrow keys, Home and End). Every existing ?tab= link still works.
export const primaryTabs = [
  ["overview", "Overview"],
  ["daily", "Daily"],
  ["weekly", "Weekly"],
  ["monthly", "Monthly"],
  ["employee", "Employees"],
];
// "Manage" used to be only a label over this group, which looked clickable
// but did nothing. It is now the tab for entering and correcting attendance.
export const managementTabs = [
  ["manage", "Manage"],
  ["leave", "Leave requests"],
  ["corrections", "Corrections"],
  ["holidays", "Holidays"],
  ["settings", "Settings"],
];
export const allTabs = [...primaryTabs, ...managementTabs];
export default function AttendanceNavigation({ tab, onChange, counts = {} }) {
  const refs = useRef({});
  function onKeyDown(event) {
    const keys = allTabs.map(([key]) => key);
    const index = keys.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? keys[(index + 1) % keys.length]
        : event.key === "ArrowLeft"
          ? keys[(index - 1 + keys.length) % keys.length]
          : event.key === "Home"
            ? keys[0]
            : event.key === "End"
              ? keys.at(-1)
              : null;
    if (!next) return;
    event.preventDefault();
    onChange(next);
    refs.current[next]?.focus();
  }
  const button = ([key, label]) => (
    <button
      key={key}
      ref={(el) => (refs.current[key] = el)}
      type="button"
      role="tab"
      id={`attendance-tab-${key}`}
      aria-selected={tab === key}
      aria-controls="attendance-panel"
      tabIndex={tab === key ? 0 : -1}
      className={tab === key ? "active" : ""}
      onClick={() => onChange(key)}
    >
      {label}
      {counts[key] > 0 && (
        <span className="cc-tab-count" aria-label={`${counts[key]} waiting`}>
          {counts[key]}
        </span>
      )}
    </button>
  );
  return (
    <nav className="cc-nav" aria-label="Attendance sections">
      <div
        className="cc-tabs"
        role="tablist"
        aria-label="Attendance sections"
        onKeyDown={onKeyDown}
      >
        <span className="cc-tab-group" role="presentation">
          {primaryTabs.map(button)}
        </span>
        <span className="cc-tab-divider" role="presentation" />
        <span className="cc-tab-group manage" role="presentation">
          {managementTabs.map(button)}
        </span>
      </div>
    </nav>
  );
}
