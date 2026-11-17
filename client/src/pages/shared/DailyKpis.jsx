import { useSearchParams } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import AgentKpis from "../../components/kpis/AgentKpis";
import KpiManage from "../../components/kpis/KpiManage";
import KpiReport from "../../components/kpis/KpiReport";
import "../../styles/kpis.css";
// Daily KPIs (update 070), in place of Team targets and My targets.
// Administrators: everyone's results, and the KPI list. Agents: their own
// answers. Office staff have no KPIs.
export default function DailyKpis() {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  if (user.role === "agent") return <AgentKpis />;
  if (user.role !== "admin")
    return <div className="panel empty">Daily KPIs are for agents.</div>;
  const tab = params.get("tab") === "manage" ? "manage" : "results";
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TEAM</span>
          <h1>Daily KPIs</h1>
          <p>
            What each agent reports every day, against the daily and weekly
            targets you set. Pakistan time.
          </p>
        </div>
      </div>
      <div className="review-tabs" role="tablist" aria-label="Daily KPIs">
        {[
          ["results", "Results"],
          ["manage", "Manage KPIs"],
        ].map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={tab === value ? "active" : ""}
            onClick={() =>
              setParams(value === "manage" ? { tab: value } : {}, {
                replace: true,
              })
            }
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "manage" ? <KpiManage /> : <KpiReport />}
    </>
  );
}
