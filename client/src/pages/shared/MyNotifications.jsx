import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { RecentActivity } from "../../components/dashboard/Widgets";
import { Button, ErrorBox } from "../../components/common/UI";
import "../../styles/dashboard.css";
// Notifications page (update 047), the same list as the bell, larger.
export default function MyNotifications() {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function markAll() {
    setBusy(true);
    setError("");
    try {
      await api("/notifications/read", { method: "POST", body: {} });
      qc.invalidateQueries({ queryKey: ["notifications"] });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">STAY UP TO DATE</span>
          <h1>Notifications</h1>
          <p>New tasks, report reviews and decisions on your requests.</p>
        </div>
        <Button variant="secondary" disabled={busy} onClick={markAll}>
          Mark all as read
        </Button>
      </div>
      <ErrorBox error={error} />
      <RecentActivity limit={30} />
    </>
  );
}
