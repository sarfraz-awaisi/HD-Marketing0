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
  ListOrdered,
  PhoneCall,
  Plug,
  ScrollText,
  Settings,
  ShieldAlert,
  Store,
  Target,
  TrendingUp,
  Trash2,
  UserCog,
  UserRound,
  Users,
  UsersRound,
} from "lucide-react";
// Sidebar sections per role. Paths, labels and role access are unchanged from
// the previous flat menu; only the grouping and icons are new. Properties
// became Inventory in update 041 (/properties redirects there). Update 049
// adds the dealer network for administrators and agents (never staff);
// update 051 gives agents My performance, their own reports. A link may
// carry child links, shown under it in a group that opens and closes: an
// agent's My leads holds Assigned leads and the Lead pipeline (update 052),
// an administrator's Leads all leads and the Lead pipeline of each agent
// (update 055).
export const adminNavigation = [
  { label: "", links: [["/", "Overview", LayoutDashboard]] },
  {
    label: "Sales",
    links: [
      [
        "/leads",
        "Leads",
        Users,
        [
          ["/leads", "All leads", ListOrdered],
          ["/leads/pipeline", "Lead pipeline", TrendingUp],
        ],
      ],
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
    label: "Dealer Affiliate Network",
    links: [["/dealers", "Dealers", Store]],
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
      [
        "/leads",
        "My leads",
        Users,
        [
          ["/leads", "Assigned leads", ListOrdered],
          ["/leads/pipeline", "Lead pipeline", TrendingUp],
        ],
      ],
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
    label: "Dealer Affiliate Network",
    links: [["/dealers", "My dealers", Store]],
  },
  {
    label: "My work",
    links: [
      ["/my-tasks", "My tasks", ListChecks],
      ["/targets", "My targets", Target],
      ["/reports", "My performance", BarChart3],
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
// Every page a menu offers, child links with their parent's name.
export function menuPages(navigation) {
  return navigation.flatMap((group) =>
    group.links.flatMap(([to, label, , children]) =>
      children
        ? children.map(([childTo, childLabel]) => ({
            to: childTo,
            label: childLabel,
            parent: label,
            section: group.label,
          }))
        : [{ to, label, section: group.label }],
    ),
  );
}
// Section and page names for the breadcrumb: an exact menu match, else the
// menu item the path sits under (for example /leads/:id under Leads).
export function breadcrumb(navigation, pathname) {
  let found = null;
  for (const page of menuPages(navigation)) {
    const exact = pathname === page.to;
    const under = page.to !== "/" && pathname.startsWith(page.to + "/");
    if (exact && !found?.exact) found = { ...page, exact };
    else if (
      under &&
      !found?.exact &&
      (!found || page.to.length > found.to.length)
    )
      found = { ...page, exact };
  }
  if (!found) return [];
  // A page under a child link is named after the parent: Sales › My leads ›
  // Lead details.
  if (!found.exact)
    return [
      found.section,
      found.parent || found.label,
      detailLabel(found.to),
    ].filter(Boolean);
  return [found.section, found.parent, found.label].filter(Boolean);
}
function detailLabel(base) {
  return (
    {
      "/leads": "Lead details",
      "/leads/pipeline": "Agent pipeline",
      "/incoming-social": "Social lead",
      "/documents": "Document",
    }[base] || "Details"
  );
}
