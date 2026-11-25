import AdminLeadList from "../../components/leads/AdminLeadList";
// Administrators' Never assigned (update 084): All leads' table, selection
// and assignment, filtered to the leads never assigned to the chosen
// agents, and moving leads only to agents they have never had.
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
            lead only ever goes to an agent it has never had.
          </p>
        </div>
      </div>
      <AdminLeadList neverAssigned />
    </>
  );
}
