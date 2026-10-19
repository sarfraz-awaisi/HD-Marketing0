export const dealTags = [
  "Hot lead",
  "Warm lead",
  "Cold lead",
  "Budget mismatch",
  "Location mismatch",
  "Ready to visit",
  "Ready to close",
];
export default function DealTagPicker({ value, onChange }) {
  return (
    <fieldset>
      <legend>Deal tags</legend>
      <div className="tag-picker">
        {dealTags.map((tag) => (
          <label key={tag}>
            <input
              type="checkbox"
              checked={value.includes(tag)}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, tag]
                    : value.filter((t) => t !== tag),
                )
              }
            />
            {tag}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
