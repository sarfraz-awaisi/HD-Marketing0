import { Suspense, lazy } from "react";
import { useSearchParams } from "react-router-dom";
import RecordsPage from "../../components/common/RecordsPage";
import { Loader } from "../../components/common/UI";
const VisitCalendar = lazy(
  () => import("../../components/visits/VisitCalendar"),
);
const description = "Bring your customers closer to their next property.";
export default function SiteVisits() {
  const [params, setParams] = useSearchParams();
  const calendar = params.get("view") === "calendar";
  const viewSwitch = (
    <div
      className="review-tabs view-switch"
      role="tablist"
      aria-label="Visits view"
    >
      {[
        ["list", "List"],
        ["calendar", "Calendar"],
      ].map(([value, label]) => (
        <button
          key={value}
          type="button"
          role="tab"
          aria-selected={(value === "calendar") === calendar}
          className={(value === "calendar") === calendar ? "active" : ""}
          onClick={() => setParams(value === "calendar" ? { view: value } : {})}
        >
          {label}
        </button>
      ))}
    </div>
  );
  if (!calendar)
    return (
      <RecordsPage
        entity="visits"
        title="Site visits"
        description={description}
        viewSwitch={viewSwitch}
      />
    );
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">PLAN YOUR NEXT MOVE</span>
          <h1>Site visits</h1>
          <p>{description}</p>
        </div>
      </div>
      {viewSwitch}
      <Suspense fallback={<Loader />}>
        <VisitCalendar />
      </Suspense>
    </>
  );
}
