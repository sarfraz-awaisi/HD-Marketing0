// Shimmer placeholder shown while data loads (never a misleading zero).
export function Skeleton({ width = "100%", height = "1em", className = "" }) {
  return (
    <span
      className={`cc-skeleton ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    />
  );
}
export function PanelSkeleton({ rows = 4 }) {
  return (
    <div className="cc-panel-skeleton" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} height="14px" width={`${90 - i * 12}%`} />
      ))}
    </div>
  );
}
export function PanelError({ error, onRetry }) {
  return (
    <div className="cc-panel-error" role="alert">
      <span>{error?.message || "This section could not load."}</span>
      {onRetry && (
        <button type="button" className="text-button" onClick={() => onRetry()}>
          Try again
        </button>
      )}
    </div>
  );
}
