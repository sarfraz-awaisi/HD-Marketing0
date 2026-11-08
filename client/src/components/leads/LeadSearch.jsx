import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
// One search box for a customer's name or contact number (update 053).
// What is typed stays here and reaches the address once typing settles;
// characters the search does not use are left out. Update 055 also finds
// agents by name or UID with it, under its own label.
const clean = (text) => text.replace(/[^\p{L}\p{N} ()+.-]/gu, "").trim();
export function LeadSearch({
  value,
  onSearch,
  label = "Search leads",
  placeholder = "Search by name or phone number…",
}) {
  const [text, setText] = useState(value);
  const settled = useDebouncedValue(text);
  // Only a settled change searches; the address then follows it.
  useEffect(() => {
    if (clean(settled) !== value) onSearch(clean(settled));
  }, [settled]); // eslint-disable-line react-hooks/exhaustive-deps
  // Reset filters clears the box too.
  useEffect(() => {
    if (value === "") setText("");
  }, [value]);
  return (
    <span className="lead-search">
      <input
        aria-label={label}
        placeholder={placeholder}
        maxLength={100}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      {text && (
        <button
          type="button"
          className="icon-button"
          aria-label="Clear search"
          onClick={() => setText("")}
        >
          <X size={16} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}
// The filters in use, each removable, and one reset for all of them.
export function ActiveFilters({ items, onReset }) {
  if (!items.length) return null;
  return (
    <div className="active-filters" role="group" aria-label="Active filters">
      {items.map(([label, remove]) => (
        <button
          key={label}
          type="button"
          className="filter-chip"
          aria-label={`Remove filter ${label}`}
          onClick={remove}
        >
          {label} <X size={13} aria-hidden="true" />
        </button>
      ))}
      <button type="button" className="filter-reset" onClick={onReset}>
        Reset filters
      </button>
    </div>
  );
}
