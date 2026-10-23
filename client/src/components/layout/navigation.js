import {
  BarChart3,
  BookOpen,
  Building2,
  CalendarCheck,
  CalendarDays,
  ClipboardCheck,
  Clock,
  FileSpreadsheet,
  Handshake,
  Inbox,
  KeyRound,
  LayoutDashboard,
  PhoneCall,
  Plug,
  ScrollText,
  Settings,
  ShieldAlert,
  Target,
  Trash2,
  UserCog,
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
      ["/team", "Team", UsersRound],
      ["/attendance", "My attendance", CalendarCheck],
      ["/attendance-management", "Attendance management", ClipboardCheck],
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
      ["/targets", "My targets", Target],
      ["/attendance", "My attendance", CalendarCheck],
    ],
  },
];
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
