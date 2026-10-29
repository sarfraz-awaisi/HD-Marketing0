import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { fullDayLabel } from "../../lib/calendar";
import { roleLabel } from "../../lib/roles";
import { scheduleName, shiftLine } from "../../lib/shifts";
import { ErrorBox, Loader } from "../../components/common/UI";
import AccountUid from "../../components/accounts/AccountUid";
import "../../styles/tasks.css";
// My profile (update 047): the signed-in employee's account and working
// details. Administrators set them in Employee management, Accounts and
// Shift management.
export default function MyProfile() {
  const q = useQuery({
    queryKey: ["my-profile"],
    queryFn: ({ signal }) => api("/profile", { signal }),
  });
  const p = q.data;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR ACCOUNT</span>
          <h1>My profile</h1>
          <p>
            Your account and working details. Ask an administrator if anything
            needs to change.
          </p>
        </div>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : p ? (
        <section className="panel" aria-label="Profile details">
          <dl className="task-facts profile-facts">
            {[
              ["Name", p.name],
              ["Email", p.email || "—"],
              ["Role", roleLabel(p.role)],
              ["Employee UID", <AccountUid key="uid" uid={p.uid} />],
              ["Department", p.department || "Not assigned"],
              ["Job title", p.job_title || "—"],
              ["Joined", p.joined_on ? fullDayLabel(p.joined_on) : "—"],
              [
                "Office timing",
                p.shift?.shift_start ? shiftLine(p.shift) : "Not set yet",
              ],
              ["Schedule", scheduleName(p.shift)],
            ].map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          {p.shift?.upcoming && (
            <p className="field-hint">
              From {fullDayLabel(p.shift.upcoming.effective_from)}:{" "}
              {shiftLine(p.shift.upcoming)} ({scheduleName(p.shift.upcoming)}).
            </p>
          )}
        </section>
      ) : null}
    </>
  );
}
