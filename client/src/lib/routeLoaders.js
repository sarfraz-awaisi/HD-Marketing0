// Only page code is prefetched; customer data still requires an authorized request.
const once = (load) => {
  let pending;
  return () =>
    (pending ||= load().catch((error) => {
      pending = null;
      throw error;
    }));
};
export const routeLoaders = {
  Dashboard: once(() => import("../pages/admin/Dashboard")),
  DeletedLeads: once(() => import("../pages/admin/DeletedLeads")),
  Leads: once(() => import("../pages/admin/Leads")),
  ImportedFiles: once(() => import("../components/leads/ImportedFiles")),
  LeadDetail: once(() => import("../pages/agent/LeadDetail")),
  Properties: once(() => import("../pages/admin/Properties")),
  Targets: once(() => import("../pages/admin/Targets")),
  CallReview: once(() => import("../pages/admin/CallReview")),
  Team: once(() => import("../pages/admin/Team")),
  Reports: once(() => import("../pages/admin/Reports")),
  AuditLog: once(() => import("../pages/admin/AuditLog")),
  FollowUps: once(() => import("../pages/agent/FollowUps")),
  SiteVisits: once(() => import("../pages/agent/SiteVisits")),
  RecordsPage: once(() => import("../components/common/RecordsPage")),
  Documentation: once(() => import("../pages/shared/Documentation")),
  Accounts: once(() => import("../pages/admin/Accounts")),
  AdminSettings: once(() => import("../pages/admin/AdminSettings")),
  SecurityAlerts: once(() => import("../pages/admin/SecurityAlerts")),
  LoginHistory: once(() => import("../pages/admin/LoginHistory")),
  MetaIntegration: once(() => import("../pages/admin/MetaIntegration")),
  IncomingSocial: once(() => import("../pages/admin/IncomingSocial")),
  MyAttendance: once(() => import("../pages/shared/MyAttendance")),
  AttendanceManagement: once(
    () => import("../pages/admin/AttendanceManagement"),
  ),
};
const routes = {
  "/": "Dashboard",
  "/leads": "Leads",
  "/deleted-leads": "DeletedLeads",
  "/tasks": "ImportedFiles",
  "/properties": "Properties",
  "/targets": "Targets",
  "/calls": "CallReview",
  "/team": "Team",
  "/reports": "Reports",
  "/audit": "AuditLog",
  "/followups": "FollowUps",
  "/visits": "SiteVisits",
  "/deals": "RecordsPage",
  "/documents": "Documentation",
  "/accounts": "Accounts",
  "/settings/security": "AdminSettings",
  "/security-alerts": "SecurityAlerts",
  "/login-history": "LoginHistory",
  "/integrations/meta": "MetaIntegration",
  "/incoming-social": "IncomingSocial",
  "/attendance": "MyAttendance",
  "/attendance-management": "AttendanceManagement",
};
export function preloadRoute(path) {
  const connection = navigator.connection;
  if (
    connection?.saveData ||
    ["slow-2g", "2g"].includes(connection?.effectiveType)
  )
    return;
  const load = routeLoaders[routes[path]];
  if (load) void load().catch(() => {});
}
