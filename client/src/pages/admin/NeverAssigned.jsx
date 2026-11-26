import AdminLeadList from "../../components/leads/AdminLeadList";
import { workingOutcomes } from "../../lib/calls";
// Administrators' Never assigned (update 084): All leads' table, selection
// and assignment, filtered to the leads never assigned to the chosen
// agents, and moving leads only to agents they have never had. Update 088:
// never the leads an agent is working on, by the latest call outcome.
export default function NeverAssigned() {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SALES</span>
          <h1>Never assigned</h1>
          <p>
            Choose agents to see the leads none of them has ever been assigned,
            by each lead&apos;s full assignment history, then assign them on. A
            lead only ever goes to an agent it has never had. Leads whose latest
            call outcome is {workingOutcomes.slice(0, -1).join(", ")} or{" "}
            {workingOutcomes.at(-1)} are left out: an agent is working on them.
          </p>
        </div>
      </div>
      <AdminLeadList neverAssigned />
    </>
  );
}
