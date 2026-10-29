import { lazy, Suspense, Component } from "react";
import { Routes, Route, Navigate, Outlet, Link } from "react-router-dom";
import { useAuth } from "./context/AuthContext";
import { Loader } from "./components/common/UI";
import { routeLoaders } from "./lib/routeLoaders";
import Layout from "./components/layout/Layout";
import Login from "./pages/Login";
import AcceptInvitation from "./pages/AcceptInvitation";
const Dashboard = lazy(routeLoaders.Dashboard);
const DeletedLeads = lazy(routeLoaders.DeletedLeads);
const Leads = lazy(routeLoaders.Leads);
const ImportedFiles = lazy(routeLoaders.ImportedFiles);
const LeadDetail = lazy(routeLoaders.LeadDetail);
const Inventory = lazy(routeLoaders.Inventory);
const Targets = lazy(routeLoaders.Targets);
const CallReview = lazy(routeLoaders.CallReview);
const Team = lazy(routeLoaders.Team);
const Reports = lazy(routeLoaders.Reports);
const AuditLog = lazy(routeLoaders.AuditLog);
const FollowUps = lazy(routeLoaders.FollowUps);
const SiteVisits = lazy(routeLoaders.SiteVisits);
const RecordsPage = lazy(routeLoaders.RecordsPage);
const Documentation = lazy(routeLoaders.Documentation);
const Accounts = lazy(routeLoaders.Accounts);
const AdminSettings = lazy(routeLoaders.AdminSettings);
const SecurityAlerts = lazy(routeLoaders.SecurityAlerts);
const LoginHistory = lazy(routeLoaders.LoginHistory);
const MetaIntegration = lazy(routeLoaders.MetaIntegration);
const IncomingSocial = lazy(routeLoaders.IncomingSocial);
const MyAttendance = lazy(routeLoaders.MyAttendance);
const AttendanceManagement = lazy(routeLoaders.AttendanceManagement);
const MyTasks = lazy(routeLoaders.MyTasks);
const TaskManagement = lazy(routeLoaders.TaskManagement);
const StaffDashboard = lazy(routeLoaders.StaffDashboard);
const MyProfile = lazy(routeLoaders.MyProfile);
const MyNotifications = lazy(routeLoaders.MyNotifications);
// `role` admits one role, `roles` several. The server enforces the same
// rules; this only keeps each workspace to its own pages.
export function Protected({ role, roles }) {
  const { user, loading } = useAuth();
  if (loading) return <Loader />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mfa_required) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  if (roles && !roles.includes(user.role)) return <Navigate to="/" replace />;
  return <Outlet />;
}
// Staff (update 047) have their own overview.
function Home() {
  const { user } = useAuth();
  return user?.role === "staff" ? <StaffDashboard /> : <Dashboard />;
}
class PageLoadError extends Component {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <div className="panel">
        <h1>Page could not load</h1>
        <p>Check your connection, then reload this page.</p>
        <button className="button" onClick={() => window.location.reload()}>
          Reload page
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
export default function App() {
  return (
    <PageLoadError>
      <Suspense fallback={<Loader />}>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/accept-invitation" element={<AcceptInvitation />} />
          <Route element={<Protected />}>
            <Route element={<Layout />}>
              <Route index element={<Home />} />
              <Route element={<Protected roles={["admin", "agent"]} />}>
                <Route path="leads" element={<Leads />} />
                <Route path="leads/:id" element={<LeadDetail />} />
                <Route path="inventory" element={<Inventory />} />
                <Route
                  path="properties"
                  element={<Navigate to="/inventory" replace />}
                />
                <Route path="documents" element={<Documentation />} />
                <Route path="documents/:id" element={<Documentation />} />
                <Route path="targets" element={<Targets />} />
                <Route path="followups" element={<FollowUps />} />
                <Route path="visits" element={<SiteVisits />} />
                <Route
                  path="deals"
                  element={
                    <RecordsPage
                      entity="deals"
                      title="Deals"
                      description="Track negotiations and record closed business."
                    />
                  }
                />
              </Route>
              <Route path="attendance" element={<MyAttendance />} />
              <Route path="profile" element={<MyProfile />} />
              <Route path="notifications" element={<MyNotifications />} />
              <Route
                path="leave"
                element={<Navigate to="/attendance#leave" replace />}
              />
              <Route element={<Protected roles={["agent", "staff"]} />}>
                <Route path="my-tasks" element={<MyTasks />} />
                <Route
                  path="my-reports"
                  element={<Navigate to="/my-tasks?tab=reports" replace />}
                />
              </Route>
              <Route element={<Protected role="admin" />}>
                <Route path="deleted-leads" element={<DeletedLeads />} />
                <Route path="integrations/meta" element={<MetaIntegration />} />
                <Route path="incoming-social" element={<IncomingSocial />} />
                <Route
                  path="incoming-social/:id"
                  element={<IncomingSocial />}
                />
                <Route path="accounts" element={<Accounts />} />
                <Route path="settings/security" element={<AdminSettings />} />
                <Route path="tasks" element={<ImportedFiles assignable />} />
                <Route path="calls" element={<CallReview />} />
                <Route path="team" element={<Team />} />
                <Route path="reports" element={<Reports />} />
                <Route path="audit" element={<AuditLog />} />
                <Route path="task-management" element={<TaskManagement />} />
                <Route path="security-alerts" element={<SecurityAlerts />} />
                <Route path="login-history" element={<LoginHistory />} />
                <Route
                  path="attendance-management"
                  element={<AttendanceManagement />}
                />
              </Route>
              <Route
                path="*"
                element={
                  <div className="panel">
                    <h1>Page not found</h1>
                    <Link to="/">Return to overview</Link>
                  </div>
                }
              />
            </Route>
          </Route>
        </Routes>
      </Suspense>
    </PageLoadError>
  );
}
