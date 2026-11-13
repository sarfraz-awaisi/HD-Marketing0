import { useId, useState } from "react";
import {
  countryName,
  flagOf,
  unknownFlag,
  useCountries,
} from "../../lib/countries";
// The Country filter (update 065): a searchable list of every country the
// phone-number library knows, by name, code or calling code, with All
// countries and Unknown country (numbers placed in no one country). `value`
// is a country code, "unknown" or empty; onChange gets the new one, or null
// for all countries.
export default function CountryFilter({ value, onChange }) {
  const id = useId();
  const q = useCountries();
  const [text, setText] = useState(null),
    [active, setActive] = useState(-1);
  const options = [
    { code: "", name: "All countries", flag: "🌍" },
    { code: "PK", name: countryName("PK"), flag: flagOf("PK"), calling: "92" },
    { code: "unknown", name: "Unknown country", flag: unknownFlag },
    ...(q.data?.countries || [])
      .filter((c) => c.code !== "PK")
      .map((c) => ({
        code: c.code,
        name: c.name,
        flag: flagOf(c.code),
        calling: c.calling_code,
      })),
  ];
  const selected = options.find((o) => o.code === (value || "")) || {
    code: value,
    name: countryName(value),
    flag: flagOf(value),
  };
  const term = (text || "").trim().toLowerCase();
  const digits = term.replace(/^\+|^00/, "");
  const matches = term
    ? options.filter(
        (o) =>
          o.name.toLowerCase().includes(term) ||
          o.code.toLowerCase() === term ||
          (/^\d{1,3}$/.test(digits) && o.calling === digits),
      )
    : options;
  const open = text !== null;
  const expanded = open;
  const current = expanded && active >= 0 && active < matches.length;
  function choose(option) {
    onChange(option.code || null);
    setText(null);
    setActive(-1);
  }
  return (
    <span className="country-filter">
      <span className="country-filter-flag" aria-hidden="true">
        {open ? "🔍" : selected.flag}
      </span>
      <input
        id={id}
        role="combobox"
        aria-label="Filter by country"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-countries` : undefined}
        aria-activedescendant={current ? `${id}-country-${active}` : undefined}
        autoComplete="off"
        placeholder="Search countries"
        value={open ? text : selected.name}
        onFocus={() => {
          setText("");
          setActive(-1);
        }}
        onBlur={() => {
          setText(null);
          setActive(-1);
        }}
        onChange={(event) => {
          setText(event.target.value);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (matches.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            if (!open) setText("");
            setActive((index) =>
              index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : matches.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    matches.length) %
                  matches.length,
            );
          } else if (event.key === "Enter" && current) {
            event.preventDefault();
            choose(matches[active]);
            event.currentTarget.blur();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      {expanded && (
        <span
          id={`${id}-countries`}
          className="country-filter-list"
          role="listbox"
          aria-label="Countries"
        >
          {matches.map((option, index) => (
            <button
              key={option.code || "all"}
              id={`${id}-country-${index}`}
              type="button"
              role="option"
              aria-selected={active === index}
              tabIndex={-1}
              onPointerDown={(event) => event.preventDefault()}
              onClick={(event) => {
                choose(option);
                event.currentTarget
                  .closest(".country-filter")
                  ?.querySelector("input")
                  ?.blur();
              }}
            >
              <span aria-hidden="true">{option.flag}</span>
              <span>{option.name}</span>
              {option.calling && <small>+{option.calling}</small>}
            </button>
          ))}
          {!matches.length && (
            <span className="country-filter-empty" role="note">
              No country matches “{text.trim()}”
            </span>
          )}
        </span>
      )}
    </span>
  );
}
