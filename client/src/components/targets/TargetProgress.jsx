import { pkr } from "../../lib/api";
// Goal key, matching metric and label. Only goals above zero are shown.
export const targetGoals = [
  ["calls", "completed_calls", "Answered calls"],
  ["leads_contacted", "leads_contacted", "Leads contacted"],
  ["followups_completed", "followups_completed", "Follow-ups completed"],
  ["visits", "completed_visits", "Site visits"],
  ["deals", "won_deals", "Won deals"],
  ["revenue", "revenue", "Closed revenue"],
];
export default function TargetProgress({ target, metrics }) {
  const set = targetGoals.filter(([t]) => Number(target[t] || 0) > 0);
  if (!set.length)
    return <p className="field-hint">No goals are set for this period.</p>;
  return (
    <div className="target-progress">
      {set.map(([t, m, label]) => {
        const goal = Number(target[t] || 0),
          actual = Number(metrics?.[m] || 0);
        return (
          <div key={t}>
            <div>
              <span>{label}</span>
              <b>
                {t === "revenue" ? pkr(actual) : actual} /{" "}
                {t === "revenue" ? pkr(goal) : goal}
              </b>
            </div>
            <progress
              className="fx-progress"
              aria-label={label + " progress"}
              value={Math.min(actual, goal)}
              max={goal}
            />
          </div>
        );
      })}
    </div>
  );
}
