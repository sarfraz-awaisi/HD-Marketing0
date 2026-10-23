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
export function Protected({ role }) {
  const { user, loading } = useAuth();
  if (loading) return <Loader />;
  if (!user) return <Navigate to="/login" replace />;
  if (user.mfa_required) return <Navigate to="/login" replace />;
  if (role && user.role !== role) return <Navigate to="/" replace />;
  return <Outlet />;
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
              <Route index element={<Dashboard />} />
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
              <Route path="attendance" element={<MyAttendance />} />
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
