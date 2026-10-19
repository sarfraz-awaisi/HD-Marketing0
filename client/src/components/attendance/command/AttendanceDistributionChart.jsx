import { PanelError, PanelSkeleton } from "./Skeleton";
// Today's mutually exclusive attendance states as a donut. Punctuality is
// not mixed in. The centre shows recorded attendance (checked in or out)
// out of the employees expected to work.
const segments = [
  ["working", "Working now", "var(--att-working)"],
  ["completed", "Checked out", "var(--att-present)"],
  ["waiting", "Not checked in", "var(--att-waiting)"],
  ["absent", "Absent", "var(--att-absent)"],
  ["incomplete", "Incomplete", "var(--att-incomplete)"],
  ["leave", "On leave", "var(--att-leave)"],
];
const radius = 52,
  circumference = 2 * Math.PI * radius;
export default function AttendanceDistributionChart({
  summary,
  overview,
  error,
  onRetry,
  loading,
}) {
  return (
    <section
      className="cc-card cc-distribution"
      aria-labelledby="cc-distribution-title"
    >
      <header className="cc-card-head">
        <h2 id="cc-distribution-title">Today's attendance</h2>
        <small>One status per employee</small>
      </header>
      {loading ? (
        <PanelSkeleton rows={5} />
      ) : error ? (
        <PanelError error={error} onRetry={onRetry} />
      ) : !summary.scheduled ? (
        <p className="cc-empty">
          {overview?.holiday
            ? `Company holiday: ${overview.holiday}. Nobody is expected today.`
            : "Nobody is scheduled to work today."}
        </p>
      ) : (
        <div className="cc-donut-wrap">
          <figure
            className="cc-donut"
            role="img"
            aria-label={`${summary.recorded} of ${summary.expected} expected employees have recorded attendance. ${segments
              .filter(([key]) => summary[key])
              .map(([key, label]) => `${label}: ${summary[key]}`)
              .join(", ")}.`}
          >
            <svg viewBox="0 0 128 128" aria-hidden="true">
              <circle cx="64" cy="64" r={radius} className="cc-donut-track" />
              {(() => {
                let offset = 0;
                return segments.map(([key, , color]) => {
                  const value = summary[key];
                  if (!value) return null;
                  const length = (value / summary.scheduled) * circumference;
                  const piece = (
                    <circle
                      key={key}
                      cx="64"
                      cy="64"
                      r={radius}
                      className="cc-donut-segment"
                      stroke={color}
                      strokeDasharray={`${Math.max(length - 1.5, 0.5)} ${circumference}`}
                      strokeDashoffset={-offset}
                    />
                  );
                  offset += length;
                  return piece;
                });
              })()}
            </svg>
            <figcaption>
              <b>
                {summary.recorded}
                <span>/{summary.expected}</span>
              </b>
              <small>recorded attendance</small>
            </figcaption>
          </figure>
          <ul className="cc-legend">
            {segments.map(([key, label, color]) => (
              <li key={key}>
                <i style={{ background: color }} aria-hidden="true" />
                <span>{label}</span>
                <b>{summary[key]}</b>
              </li>
            ))}
          </ul>
        </div>
      )}
      {!loading && !error && summary.scheduled > 0 && (
        <p className="cc-footnote">
          Arrival: {summary.onTime} on time · {summary.withinGrace} within grace
          · {summary.late} late
        </p>
      )}
    </section>
  );
}
