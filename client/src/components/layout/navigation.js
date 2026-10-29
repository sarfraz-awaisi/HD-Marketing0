import {
  BarChart3,
  Bell,
  BookOpen,
  Building2,
  CalendarCheck,
  CalendarDays,
  ClipboardCheck,
  Clock,
  FileSpreadsheet,
  FileText,
  Handshake,
  Inbox,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  PhoneCall,
  Plug,
  ScrollText,
  Settings,
  ShieldAlert,
  Target,
  Trash2,
  UserCog,
  UserRound,
  Users,
  UsersRound,
} from "lucide-react";
// Sidebar sections per role. Paths, labels and role access are unchanged from
// the previous flat menu; only the grouping and icons are new. Properties
// became Inventory in update 041 (/properties redirects there).
export const adminNavigation = [
  { label: "", links: [["/", "Overview", LayoutDashboard]] },
  {
    label: "Sales",
    links: [
      ["/leads", "Leads", Users],
      ["/tasks", "Task assign", FileSpreadsheet],
      ["/incoming-social", "Incoming social leads", Inbox],
      ["/followups", "Follow-ups", Clock],
      ["/visits", "Site visits", CalendarDays],
      ["/deals", "Deals", Handshake],
      ["/calls", "Call review", PhoneCall],
      ["/deleted-leads", "Deleted leads", Trash2],
    ],
  },
  {
    label: "Resources",
    links: [
      ["/inventory", "Inventory", Building2],
      ["/documents", "Documentation & policies", BookOpen],
    ],
  },
  {
    label: "Team",
    links: [
      ["/targets", "Team targets", Target],
      ["/reports", "Reports", BarChart3],
      ["/team", "Employee management", UsersRound],
      ["/attendance", "My attendance", CalendarCheck],
      ["/attendance-management", "Attendance management", ClipboardCheck],
      ["/task-management", "Task management", ListChecks],
    ],
  },
  {
    label: "Administration",
    links: [
      ["/accounts", "Accounts", UserCog],
      ["/integrations/meta", "Integrations", Plug],
      ["/settings/security", "Admin settings", Settings],
      ["/audit", "Audit history", ScrollText],
      ["/security-alerts", "Security alerts", ShieldAlert],
      ["/login-history", "Login history", KeyRound],
    ],
  },
];
export const agentNavigation = [
  { label: "", links: [["/", "My overview", LayoutDashboard]] },
  {
    label: "Sales",
    links: [
      ["/leads", "My leads", Users],
      ["/followups", "Follow-ups", Clock],
      ["/visits", "Site visits", CalendarDays],
      ["/deals", "My deals", Handshake],
    ],
  },
  {
    label: "Resources",
    links: [
      ["/inventory", "Inventory", Building2],
      ["/documents", "Documentation & policies", BookOpen],
    ],
  },
  {
    label: "My work",
    links: [
      ["/my-tasks", "My tasks", ListChecks],
      ["/targets", "My targets", Target],
      ["/attendance", "My attendance", CalendarCheck],
    ],
  },
];
// Update 047: office staff see only their own work, attendance and profile.
export const staffNavigation = [
  { label: "", links: [["/", "My dashboard", LayoutDashboard]] },
  {
    label: "My work",
    links: [
      ["/my-tasks", "My tasks", ListChecks],
      ["/my-reports", "My reports", FileText],
    ],
  },
  {
    label: "Attendance",
    links: [
      ["/attendance", "Attendance", CalendarCheck],
      ["/leave", "Leave requests", CalendarDays],
    ],
  },
  {
    label: "Me",
    links: [
      ["/notifications", "Notifications", Bell],
      ["/profile", "My profile", UserRound],
    ],
  },
];
export const navigationFor = (role) =>
  role === "admin"
    ? adminNavigation
    : role === "staff"
      ? staffNavigation
      : agentNavigation;
// Section and page names for the breadcrumb: an exact menu match, else the
// menu item the path sits under (for example /leads/:id under Leads).
export function breadcrumb(navigation, pathname) {
  let found = null;
  for (const group of navigation)
    for (const [to, label] of group.links) {
      const exact = pathname === to;
      const under = to !== "/" && pathname.startsWith(to + "/");
      if (exact || (under && (!found || to.length > found.to.length)))
        found = { to, label, section: group.label, exact };
    }
  if (!found) return [];
  const trail = [found.section, found.label].filter(Boolean);
  if (!found.exact) trail.push(detailLabel(found.to));
  return trail;
}
function detailLabel(base) {
  return (
    {
      "/leads": "Lead details",
      "/incoming-social": "Social lead",
      "/documents": "Document",
    }[base] || "Details"
  );
}
