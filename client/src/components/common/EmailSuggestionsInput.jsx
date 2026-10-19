import { useId, useState } from "react";
export default function EmailSuggestionsInput({
  suggestions,
  value,
  onSelect,
  onChange,
  onBlur,
  ...props
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [active, setActive] = useState(-1);
  const matches = suggestions.filter((email) =>
    email.toLowerCase().includes(value.trim().toLowerCase()),
  );
  const expanded = open && !props.disabled && matches.length > 0;
  const selected = expanded && active >= 0 && active < matches.length;
  function choose(email) {
    onSelect(email);
    setOpen(false);
    setActive(-1);
  }
  return (
    <span className="email-suggestion-field">
      <input
        {...props}
        id={id}
        type="email"
        role="combobox"
        value={value}
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? `${id}-emails` : undefined}
        aria-activedescendant={selected ? `${id}-email-${active}` : undefined}
        onFocus={() => {
          setOpen(true);
          setActive(-1);
        }}
        onBlur={(event) => {
          onBlur(event);
          setOpen(false);
          setActive(-1);
        }}
        onChange={(event) => {
          onChange(event);
          setOpen(true);
          setActive(-1);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (matches.length && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
            setActive((index) =>
              !expanded || index < 0
                ? event.key === "ArrowDown"
                  ? 0
                  : matches.length - 1
                : (index +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    matches.length) %
                  matches.length,
            );
          } else if (event.key === "Enter" && selected) {
            event.preventDefault();
            choose(matches[active]);
          } else if (event.key === "Escape" && expanded) {
            event.preventDefault();
            setOpen(false);
            setActive(-1);
          } else if (event.key === "Tab") {
            setOpen(false);
            setActive(-1);
          }
        }}
      />
      {expanded && (
        <span className="email-suggestion-popup">
          <span className="email-suggestion-caption">Saved on this device</span>
          <span
            id={`${id}-emails`}
            role="listbox"
            aria-label="Saved email addresses"
          >
            {matches.map((email, index) => (
              <button
                key={email}
                id={`${id}-email-${index}`}
                type="button"
                role="option"
                aria-selected={active === index}
                tabIndex={-1}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => choose(email)}
              >
                {email}
              </button>
            ))}
          </span>
        </span>
      )}
    </span>
  );
}
