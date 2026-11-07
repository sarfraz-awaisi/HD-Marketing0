import "../../styles/leads.css";
import { temperatures } from "../../lib/temperature";
// One lead temperature for a call: Hot, Warm or Cold, or none.
export default function TemperaturePicker({ value, onChange }) {
  return (
    <fieldset className="temperature-picker">
      <legend>Lead temperature</legend>
      <div className="tag-picker">
        {temperatures.map((t) => (
          <label key={t.value}>
            <input
              type="radio"
              name="lead-temperature"
              aria-label={t.label}
              value={t.value}
              checked={value === t.value}
              onChange={() => onChange(t.value)}
            />
            <span aria-hidden="true">{t.emoji}</span> {t.label}
          </label>
        ))}
        {value && (
          <button
            type="button"
            className="temperature-clear"
            onClick={() => onChange("")}
          >
            Clear
          </button>
        )}
      </div>
      <small>How likely is this customer to buy? Optional.</small>
    </fieldset>
  );
}
