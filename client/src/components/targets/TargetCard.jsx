import { useQuery } from "@tanstack/react-query";
import { api, reportSearch } from "../../lib/api";
import { periodLabel, periodRange } from "../../lib/calendar";
import { Button, ErrorBox, Loader } from "../common/UI";
import TargetProgress from "./TargetProgress";
// One target with live progress for exactly its own day, week or month.
export default function TargetCard({ target, admin, onEdit }) {
  const range = periodRange(target.period, target.period_start);
  const q = useQuery({
    queryKey: ["target-metrics", target.id, target.agent_id, range],
    queryFn: ({ signal }) =>
      api(
        "/reports?" +
          reportSearch({
            ...range,
            ...(admin ? { agent: target.agent_id } : {}),
          }),
        { signal },
      ),
  });
  return (
    <section className="panel fx-card target-card">
      <div className="panel-heading">
        <div>
          <h2>{target.agent_name}</h2>
          <small>{periodLabel(target.period, target.period_start)}</small>
        </div>
        {admin && onEdit && (
          <Button variant="secondary" onClick={onEdit}>
            Edit target
          </Button>
        )}
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : (
        <TargetProgress target={target} metrics={q.data} />
      )}
    </section>
  );
}
