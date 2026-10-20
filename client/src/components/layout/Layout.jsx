import { formatLeadNo } from "../../lib/formatLeadNo";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LogOut,
  Menu,
  Bell,
  X,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { useAuth } from "../../context/AuthContext";
import { api, date } from "../../lib/api";
import { preloadRoute } from "../../lib/routeLoaders";
import { Button, ErrorBox } from "../common/UI";
import AccountUid from "../accounts/AccountUid";
import IdleGuard from "../common/IdleGuard";
import { useSecurityAlertSummary } from "../../lib/securityAlerts";
import { useMetaSummary, metaApi, platformLabel } from "../../lib/meta";
import { adminNavigation, agentNavigation, breadcrumb } from "./navigation";
// The collapsed sidebar is a per-browser preference; storage can be blocked.
const collapseKey = "hd-crm-sidebar-collapsed";
function storedCollapse() {
  try {
    return localStorage.getItem(collapseKey) === "1";
  } catch {
    return false;
  }
}
export default function Layout() {
  const { user, logout } = useAuth();
  const security = useSecurityAlertSummary(user.role === "admin");
  const social = useMetaSummary(user);
  const { pathname } = useLocation();
  const [open, setOpen] = useState(false),
    [notices, setNotices] = useState(false),
    [profile, setProfile] = useState(false),
    [noticeError, setNoticeError] = useState(""),
    [dismissing, setDismissing] = useState(null),
    [collapsed, setCollapsed] = useState(storedCollapse);
  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(collapseKey, next ? "1" : "0");
    } catch {
      /* The preference simply is not remembered. */
    }
  }
  useEffect(() => {
    const close = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        setNotices(false);
        setProfile(false);
      }
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, []);
  // A press anywhere outside an open menu (and its own button) closes it.
  const bellButton = useRef(null),
    noticePanel = useRef(null),
    profileButton = useRef(null),
    profilePanel = useRef(null);
  useEffect(() => {
    if (!notices && !profile) return;
    const outside = (event) => {
      const inside = (...refs) =>
        refs.some((ref) => ref.current?.contains(event.target));
      if (notices && !inside(bellButton, noticePanel)) setNotices(false);
      if (profile && !inside(profileButton, profilePanel)) setProfile(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [notices, profile]);
  const inbox = useQuery({
    queryKey: ["notifications"],
    queryFn: ({ signal }) => api("/notifications", { signal }),
    refetchInterval: 60000,
  });
  // Until database update 038 is installed, keep showing follow-up reminders.
  const legacy = inbox.error?.status === 503;
  const q = useQuery({
    queryKey: ["reminders"],
    queryFn: ({ signal }) => api("/reminders", { signal }),
    refetchInterval: 60000,
    enabled: legacy,
  });
  const qc = useQueryClient();
  const unread =
    (legacy ? q.data?.length || 0 : inbox.data?.unread || 0) +
    (social.data?.notifications?.length || 0);
  async function markRead(ids) {
    setNoticeError("");
    try {
      await api("/notifications/read", {
        method: "POST",
        body: ids ? { ids } : {},
      });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch (error) {
      setNoticeError(error.message);
    }
  }
  const navigation = user.role === "admin" ? adminNavigation : agentNavigation;
  const trail = breadcrumb(navigation, pathname);
  async function signOut() {
    await logout();
    qc.clear();
  }
  return (
    <div className={collapsed ? "shell nav-collapsed" : "shell"}>
      <IdleGuard />
      {open && (
        <button
          className="nav-backdrop"
          aria-label="Close navigation backdrop"
          onClick={() => setOpen(false)}
        />
      )}
      <aside
        id="workspace-navigation"
        className={open ? "sidebar open" : "sidebar"}
      >
        <button
          className="icon-button sidebar-close"
          aria-label="Close navigation"
          onClick={() => setOpen(false)}
        >
          <X size={20} />
        </button>
        <NavLink
          className="brand"
          to="/"
          aria-label="HD Marketing home"
          onClick={() => setOpen(false)}
        >
          <b>HD</b>
          <span>
            MARKETING<small>REAL ESTATE CRM</small>
          </span>
        </NavLink>
        <nav aria-label="Workspace">
          {navigation.map((group) => (
            <div className="nav-group" key={group.label || "home"}>
              {group.label && (
                <span className="nav-label" aria-hidden="true">
                  {group.label}
                </span>
              )}
              {group.links.map(([to, label, Icon]) => (
                <NavLink
                  end={to === "/"}
                  key={to}
                  className="fx-nav"
                  to={to}
                  title={collapsed ? label : undefined}
                  onPointerEnter={() => preloadRoute(to)}
                  onFocus={() => preloadRoute(to)}
                  onClick={() => setOpen(false)}
                >
                  <Icon size={18} aria-hidden="true" />
                  <span className="nav-text">{label}</span>
                  {to === "/incoming-social" && social.data?.unassigned > 0 && (
                    <span
                      className="nav-count"
                      aria-label={`${social.data.unassigned} unassigned social leads`}
                    >
                      {social.data.unassigned}
                    </span>
                  )}
                  {to === "/security-alerts" &&
                    security.data?.count != null && (
                      <span
                        className="nav-count"
                        aria-label={`${security.data.count} unreviewed security alerts`}
                      >
                        {security.data.count}
                      </span>
                    )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button
            type="button"
            className="nav-signout"
            title={collapsed ? "Sign out" : undefined}
            onClick={signOut}
          >
            <LogOut size={18} aria-hidden="true" />
            <span className="nav-text">Sign out</span>
          </button>
          <p className="sidebar-meta">
            <span className="status-dot" aria-hidden="true" />
            <span className="nav-text">Secure workspace · Asia/Karachi</span>
          </p>
        </div>
      </aside>
      <div className="workspace">
        <header className="topbar">
          <div className="topbar-start">
            <button
              className="icon-button menu"
              aria-label="Toggle navigation"
              aria-expanded={open}
              aria-controls="workspace-navigation"
              onClick={() => setOpen(!open)}
            >
              <Menu size={20} />
            </button>
            <button
              type="button"
              className="icon-button sidebar-collapse"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              aria-pressed={collapsed}
              aria-controls="workspace-navigation"
              onClick={toggleCollapsed}
            >
              {collapsed ? (
                <PanelLeftOpen size={19} />
              ) : (
                <PanelLeftClose size={19} />
              )}
            </button>
            <nav className="breadcrumbs" aria-label="Breadcrumb">
              <ol>
                <li>HD Marketing</li>
                {trail.map((item, i) => (
                  <li
                    key={item + i}
                    aria-current={i === trail.length - 1 ? "page" : undefined}
                  >
                    {item}
                  </li>
                ))}
              </ol>
            </nav>
          </div>
          <div className="top-actions">
            <button
              ref={bellButton}
              className="icon-button top-icon fx-bell"
              aria-label={
                unread
                  ? `View notifications, ${unread} unread`
                  : "View notifications"
              }
              aria-expanded={notices}
              aria-controls="workspace-reminders"
              onClick={() => {
                setNotices(!notices);
                setProfile(false);
              }}
            >
              <Bell size={18} />
              {unread > 0 && (
                <i key={unread} className="fx-unread">
                  {unread > 99 ? "99+" : unread}
                </i>
              )}
            </button>
            <button
              ref={profileButton}
              type="button"
              className="profile-trigger"
              aria-label={`My profile: ${user.name}`}
              aria-expanded={profile}
              aria-controls="workspace-profile"
              onClick={() => {
                setProfile(!profile);
                setNotices(false);
              }}
            >
              <span className="avatar" aria-hidden="true">
                {user.name.charAt(0)}
              </span>
              <span className="identity">
                <b>{user.name}</b>
                <small>
                  {user.role}
                  {user.uid ? ` · UID ${user.uid}` : ""}
                </small>
              </span>
              <ChevronDown
                size={16}
                className="profile-chevron"
                aria-hidden="true"
              />
            </button>
          </div>
        </header>
        {notices && (
          <div
            ref={noticePanel}
            id="workspace-reminders"
            className="notification-panel"
          >
            <div className="notification-head">
              <h3>Notifications</h3>
              {!legacy && inbox.data?.unread > 0 && (
                <Button variant="secondary" onClick={() => markRead()}>
                  Mark all read
                </Button>
              )}
            </div>
            {!legacy && (
              <>
                <ErrorBox error={inbox.error} />
                {inbox.data?.data?.length ? (
                  <ul className="notification-list">
                    {inbox.data.data.map((n) => (
                      <li key={n.id} className={n.read_at ? "" : "unread"}>
                        <div>
                          {n.link ? (
                            <NavLink
                              to={n.link}
                              onClick={() => {
                                setNotices(false);
                                if (!n.read_at) markRead([n.id]);
                              }}
                            >
                              {n.title}
                            </NavLink>
                          ) : (
                            <b>{n.title}</b>
                          )}
                          {n.body && <p>{n.body}</p>}
                          <small>{date(n.updated_at)}</small>
                        </div>
                        {!n.read_at && (
                          <Button
                            variant="secondary"
                            aria-label={`Mark read: ${n.title}`}
                            onClick={() => markRead([n.id])}
                          >
                            Mark read
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  !inbox.isPending &&
                  !inbox.error && <p>No notifications yet.</p>
                )}
              </>
            )}
            {legacy && <h3>Follow-up reminders</h3>}
            {user.role === "admin" && (
              <>
                <h3>Social enquiries</h3>
                <ErrorBox error={social.error} />
                {social.data?.notifications?.map((n) => (
                  <div key={n.id}>
                    <NavLink
                      to={"/incoming-social/" + n.id}
                      onClick={() => setNotices(false)}
                    >
                      {platformLabel(n.platform)} · {n.name}
                    </NavLink>
                    <Button
                      variant="secondary"
                      disabled={dismissing !== null}
                      onClick={async () => {
                        setDismissing(n.id);
                        try {
                          await api(`${metaApi}/notices/${n.id}/read`, {
                            method: "POST",
                            body: {},
                          });
                          qc.invalidateQueries({ queryKey: ["meta-summary"] });
                        } catch (e) {
                          setNoticeError(e.message);
                        } finally {
                          setDismissing(null);
                        }
                      }}
                    >
                      Dismiss
                    </Button>
                  </div>
                ))}
              </>
            )}
            <ErrorBox error={noticeError || (legacy && q.error)} />
            {!legacy ? null : q.data?.length ? (
              q.data.map((r) => (
                <div key={r.id}>
                  <span>
                    {formatLeadNo(r.followups?.leads?.lead_no)} · Follow-up due{" "}
                    {date(r.due_at)}
                  </span>
                  <Button
                    variant="secondary"
                    disabled={dismissing !== null}
                    onClick={async () => {
                      setNoticeError("");
                      setDismissing(r.id);
                      try {
                        await api("/reminders/" + r.id, { method: "PATCH" });
                        qc.invalidateQueries({ queryKey: ["reminders"] });
                      } catch (error) {
                        setNoticeError(error.message);
                      } finally {
                        setDismissing(null);
                      }
                    }}
                  >
                    {dismissing === r.id ? "Dismissing…" : "Dismiss"}
                  </Button>
                </div>
              ))
            ) : (
              <p>No unread reminders.</p>
            )}
          </div>
        )}
        {profile && (
          <section
            ref={profilePanel}
            id="workspace-profile"
            className="notification-panel profile-panel"
            aria-labelledby="workspace-profile-title"
          >
            <h3 id="workspace-profile-title">My profile</h3>
            <dl className="profile-details">
              {[
                ["Name", user.name],
                ["Email", user.email || "—"],
                ["Role", user.role === "admin" ? "Admin" : "Agent"],
                ["Employee UID", <AccountUid uid={user.uid} />],
              ].map(([label, value]) => (
                <div key={label}>
                  <dt>{label}</dt>
                  <dd>{value}</dd>
                </div>
              ))}
            </dl>
            <p className="field-hint">
              Your UID is assigned by an administrator and cannot be changed.
            </p>
            <footer className="profile-actions">
              <Button variant="secondary" onClick={signOut}>
                <LogOut size={16} aria-hidden="true" />
                Sign out
              </Button>
            </footer>
          </section>
        )}
        <main>
          <div className="fx-page" key={pathname}>
            <Outlet />
          </div>
        </main>
        <footer className="watermark">
          HD Marketing · {user.name} · {user.id.slice(0, 8)}
        </footer>
      </div>
    </div>
  );
}
