import AdminLeadList from "../../components/leads/AdminLeadList";
import { workingOutcomes } from "../../lib/calls";
// Administrators' Never Worked (update 084, Never assigned until update
// 090): All leads' table, selection and assignment, filtered to the leads
// never assigned to the chosen agents, and moving leads only to agents they
// have never had. Update 088: never the leads an agent is working on, by the
// latest call outcome. Update 090: or the leads their current agent has not
// called since receiving them (Assigned but Never Called); Assign to agents
// takes as many as asked from each current agent.
export default function NeverAssigned() {
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">SALES</span>
          <h1>Never Worked</h1>
          <p>
            Never Assigned to Selected Agent: the leads none of the chosen
            agents has ever been assigned, by each lead&apos;s full assignment
            history. Assigned but Never Called: the leads whose current agent
            has saved no call outcome on them since receiving them. Either way a
            lead only ever goes to an agent it has never had, and leads whose
            latest call outcome is {workingOutcomes.slice(0, -1).join(", ")} or{" "}
            {workingOutcomes.at(-1)} are left out: an agent is working on them.
          </p>
        </div>
      </div>
      <AdminLeadList neverAssigned />
    </>
  );
}
