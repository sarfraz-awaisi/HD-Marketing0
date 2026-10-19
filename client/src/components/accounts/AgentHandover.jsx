import { useEffect, useRef, useState } from "react";
import { Button, ErrorBox, Loader } from "../common/UI";
export default function AgentHandover({
  account,
  request,
  changes,
  onClose,
  onSaved,
  onPending,
}) {
  const [preview, setPreview] = useState(null),
    [agents, setAgents] = useState([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [mode, setMode] = useState("equal"),
    [target, setTarget] = useState("");
  const pending = useRef(false);
  useEffect(() => {
    let live = true;
    Promise.all([
      request(`/accounts/${account.id}/offboard-preview`),
      request("/users"),
    ])
      .then(([counts, users]) => {
        if (live) {
          setPreview(counts);
          setAgents(
            users.filter(
              (u) => u.active && u.role === "agent" && u.id !== account.id,
            ),
          );
        }
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [account.id, request]);
  async function submit(e) {
    e.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    onPending(true);
    setError("");
    try {
      const result = await request(`/accounts/${account.id}/offboard`, {
        method: "POST",
        body: {
          mode,
          target: mode === "single" ? target : null,
          ...(changes ? { changes } : {}),
        },
      });
      onSaved({
        ...result,
        message: `Agent disabled. ${result.leads} leads handed over; completed activity history retained.`,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      pending.current = false;
      setBusy(false);
      onPending(false);
    }
  }
  return (
    <form onSubmit={submit} className="agent-handover">
      <ErrorBox error={error} />
      {!preview ? (
        !error && <Loader />
      ) : (
        <>
          <p>
            This agent owns <b>{preview.leads} leads</b>,{" "}
            <b>{preview.followups} pending follow-ups</b> and{" "}
            <b>{preview.visits} scheduled visits</b>.
          </p>
          <p>
            Choose who will take over this work before disabling access.
            Completed history stays with the original agent.
          </p>
          <fieldset disabled={busy}>
            <legend>Where should the work go?</legend>
            {[
              ["equal", "Share equally among all active agents"],
              ["single", "Give all to one agent"],
              ["admin", "Keep with admin (unassigned)"],
            ].map(([value, label]) => (
              <label className="handover-choice" key={value}>
                <input
                  type="radio"
                  name="handover-mode"
                  value={value}
                  checked={mode === value}
                  onChange={() => setMode(value)}
                />
                <span>{label}</span>
              </label>
            ))}
            {mode === "single" && (
              <label>
                Receiving agent *
                <select
                  aria-label="Receiving agent"
                  required
                  value={target}
                  onChange={(e) => setTarget(e.target.value)}
                >
                  <option value="">Choose an active agent</option>
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!agents.length && (
              <p>
                No other active agents are available. Choose Keep with admin to
                retain the work in the admin pool.
              </p>
            )}
            {mode === "admin" && (
              <p>
                Leads become unassigned. Their pending follow-ups, visits and
                future unread reminders go to your administrator account.
              </p>
            )}
          </fieldset>
          <footer>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={
                busy ||
                ((mode === "equal" || mode === "single") &&
                  !agents.length &&
                  preview.leads > 0)
              }
            >
              {busy
                ? "Handing over…"
                : account.active
                  ? "Disable access"
                  : "Hand over work"}
            </Button>
          </footer>
        </>
      )}
    </form>
  );
}
