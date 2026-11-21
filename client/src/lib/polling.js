// How often a visible tab refreshes shared data. React Query pauses these
// intervals in hidden tabs, refreshes stale data when a tab is shown again,
// and a change made in this tab refreshes what it changed, so a slower
// interval only delays seeing other people's changes. Every API request
// still checks the session, role and two-step sign-in on the server.
export const POLL = {
  // Notifications are the largest regular request (up to 30 items each).
  notifications: 120000,
  // Follow-up reminders before database update 038.
  reminders: 60000,
  // Security alerts stay at a minute.
  securityAlerts: 60000,
  // Backup and job status changes a few times a day.
  systemStatus: 300000,
  // Facebook and Instagram leads: every minute while there is any
  // (metaActive), otherwise a slow check so the first one still shows.
  meta: 60000,
  metaIdle: 600000,
};

// Whether the Facebook and Instagram integration has anything to show. With
// no social lead at all the sidebar checks every 10 minutes (and whenever
// the tab is shown) instead of every minute. Webhook leads are stored by the
// server whether or not anyone has the CRM open.
export function metaActive(summary) {
  return Boolean(
    summary &&
      (summary.total > 0 ||
        summary.unassigned > 0 ||
        summary.processing > 0 ||
        summary.failures > 0 ||
        summary.notifications?.length > 0),
  );
}
