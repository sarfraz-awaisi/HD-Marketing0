import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import AttendanceCommandHeader from "../../components/attendance/command/AttendanceCommandHeader";
import AttendanceNavigation, {
  allTabs,
} from "../../components/attendance/command/AttendanceNavigation";
import AttendanceOverview from "../../components/attendance/command/AttendanceOverview";
import EmployeeAttendanceDrawer from "../../components/attendance/command/EmployeeAttendanceDrawer";
import AdminDaily from "../../components/attendance/AdminDaily";
import AdminPeriod from "../../components/attendance/AdminPeriod";
import AdminEmployee from "../../components/attendance/AdminEmployee";
import AdminRequests from "../../components/attendance/AdminRequests";
import AdminHolidays from "../../components/attendance/AdminHolidays";
import AdminAttendanceSettings from "../../components/attendance/AdminAttendanceSettings";
import AttendanceManage from "../../components/attendance/AttendanceManage";
import { useAttendanceOverview } from "../../lib/attendanceDashboard";
import "../../styles/attendance-command.css";
// Attendance Command Center for administrators (update 040). The overview
// is the dashboard; the other sections keep their existing tools. ?tab=
// links, including ?tab=employee&user=<id>, are unchanged.
export default function AttendanceManagement() {
  const [params, setParams] = useSearchParams();
  const tab = allTabs.some(([key]) => key === params.get("tab"))
    ? params.get("tab")
    : "overview";
  const user = params.get("user") || "";
  const date = params.get("date") || "";
  const drawer = params.get("details") || "";
  const overview = useAttendanceOverview();
  const go = useCallback((next) => setParams({ tab: next }), [setParams]);
  const openEmployee = useCallback(
    (id) => setParams({ tab: "employee", user: id }),
    [setParams],
  );
  const openDrawer = useCallback(
    (id) => setParams({ tab: "overview", details: id }),
    [setParams],
  );
  // ?tab=manage&user=<id>&date=YYYY-MM-DD opens one employee's day.
  const manage = useCallback(
    (next) =>
      setParams({
        tab: "manage",
        ...(next.user ? { user: next.user } : {}),
        ...(next.date ? { date: next.date } : {}),
      }),
    [setParams],
  );
  const closeDrawer = useCallback(
    () => setParams({ tab: "overview" }, { replace: true }),
    [setParams],
  );
  return (
    <div className="cc-page">
      <AttendanceCommandHeader />
      <AttendanceNavigation
        tab={tab}
        onChange={go}
        counts={{
          leave: overview.data?.pending_leave,
          corrections: overview.data?.pending_corrections,
        }}
      />
      <section
        id="attendance-panel"
        className="attendance-section cc-panel"
        role="tabpanel"
        aria-labelledby={`attendance-tab-${tab}`}
      >
        {tab === "overview" && (
          <AttendanceOverview
            go={go}
            selected={drawer}
            openDrawer={openDrawer}
          />
        )}
        {tab === "daily" && <AdminDaily openEmployee={openEmployee} />}
        {(tab === "weekly" || tab === "monthly") && (
          <AdminPeriod key={tab} mode={tab} openEmployee={openEmployee} />
        )}
        {tab === "employee" && (
          <AdminEmployee userId={user} onSelect={openEmployee} />
        )}
        {tab === "manage" && (
          <AttendanceManage userId={user} date={date} onChange={manage} />
        )}
        {(tab === "leave" || tab === "corrections") && (
          <AdminRequests key={tab} kind={tab} />
        )}
        {tab === "holidays" && <AdminHolidays />}
        {tab === "settings" && <AdminAttendanceSettings />}
      </section>
      {tab === "overview" && drawer && (
        <EmployeeAttendanceDrawer
          userId={drawer}
          onClose={closeDrawer}
          onOpenHistory={openEmployee}
        />
      )}
    </div>
  );
}
