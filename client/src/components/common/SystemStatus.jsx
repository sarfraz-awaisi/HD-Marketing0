import { useQuery } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { api, date } from "../../lib/api";
import { ErrorBox } from "./UI";
const labels = {
  deleteOldRecordings: "Recording retention",
  reportInactiveLeadOwners: "Inactive lead owners",
  leadResponseCheck: "Missed-call check",
  attendanceReconciliation: "Attendance check",
  followUpReminders: "Follow-up reminders",
  missingOutcomeCheck: "Call outcomes",
  cleanupPropertyPhotos: "Property photo cleanup",
  cleanupKnowledgeFiles: "Document cleanup",
  processMetaLeads: "Social lead processing",
};
export default function SystemStatus() {
  const query = useQuery({
    queryKey: ["system-status"],
    queryFn: () => api("/health/status"),
    refetchInterval: 60000,
  });
  const data = query.data;
  const problems = data?.jobs?.filter((job) => job.status !== "success") || [];
  const oldBackup =
    data?.backup?.last_success_at &&
    Date.now() - new Date(data.backup.last_success_at).getTime() > 36 * 3600000;
  return (
    <section
      className="panel fx-card system-overview"
      aria-labelledby="system-status-title"
    >
      <div className="panel-heading">
        <h2 id="system-status-title">System status</h2>
        <Activity size={20} />
      </div>
      <p role="status">
        {query.isPending
          ? "Checking system…"
          : data?.ready
            ? "Background jobs are running"
            : "System needs attention"}
      </p>
      <ErrorBox error={query.error || data?.message} />
      {data && (
        <>
          <dl className="system-status-details">
            <div>
              <dt>Last complete job cycle</dt>
              <dd>
                {data.last_job_at
                  ? date(data.last_job_at)
                  : "No complete cycle recorded"}
              </dd>
            </div>
            <div>
              <dt>Last database backup</dt>
              <dd>
                {data.backup?.last_success_at
                  ? date(data.backup.last_success_at)
                  : "No successful backup recorded"}
              </dd>
            </div>
          </dl>
          {problems.length > 0 && (
            <ul>
              {problems.map((job) => (
                <li key={job.job}>
                  {labels[job.job] || "Background task"}:{" "}
                  {job.status.replaceAll("_", " ")}
                </li>
              ))}
            </ul>
          )}
          {data.backup?.status === "failed" && (
            <p className="error">The latest database backup failed.</p>
          )}
          {oldBackup && (
            <p className="error">
              The last successful database backup is over 36 hours old.
            </p>
          )}
        </>
      )}
    </section>
  );
}
