import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldCheck, KeyRound, ArrowUpRight } from "lucide-react";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import WorkHours from "../../components/sales/WorkHours";
import {
  Button,
  ErrorBox,
  Loader,
  PasswordInput,
  useToast,
} from "../../components/common/UI";
export default function AdminSettings() {
  const { user } = useAuth(),
    qc = useQueryClient(),
    toast = useToast();
  const q = useQuery({
    queryKey: ["account-security", user.id],
    queryFn: () => api("/account-security"),
  });
  const [pin, setPin] = useState(""),
    [confirmPin, setConfirmPin] = useState(""),
    [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false);
  async function save(event) {
    event.preventDefault();
    if (pending.current) return;
    setError("");
    if (!/^\d{4}$/.test(pin) || pin !== confirmPin) {
      setError("Enter the same four-digit PIN in both fields.");
      return;
    }
    pending.current = true;
    setBusy(true);
    try {
      await api("/account-security", {
        method: "PUT",
        body: { pin, confirm_pin: confirmPin, password },
      });
      setPin("");
      setConfirmPin("");
      setPassword("");
      await qc.invalidateQueries({ queryKey: ["account-security", user.id] });
      toast("Accounts PIN saved. Unlock Accounts with your new PIN.");
    } catch (e) {
      setError(e.message);
      setPassword("");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR ADMINISTRATOR CONTROLS</span>
          <h1>Admin settings</h1>
          <p>Keep sensitive account management under your control.</p>
        </div>
        <Link className="button secondary" to="/accounts">
          Accounts <ArrowUpRight size={17} />
        </Link>
      </div>
      <section className="panel security-panel">
        <h2>Administrator sign-in</h2>
        <p>
          Sign in with your verified email address and password. Your personal
          four-digit PIN protects account management.
        </p>
        <p>
          Manage your PIN below. Use Forgot your password on the login page if
          you need to reset your login password.
        </p>
        <Link className="button secondary" to="/accounts">
          Open Accounts
        </Link>
      </section>
      {q.isPending ? (
        <Loader />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        <section
          className="panel fx-card security-panel"
          aria-labelledby="security-title"
        >
          <div className="security-intro">
            <span className="security-symbol">
              <ShieldCheck size={28} aria-hidden="true" />
            </span>
            <div>
              <span className="eyebrow">SECURITY</span>
              <h2 id="security-title">Your Accounts PIN</h2>
              <p>
                A personal four-digit PIN for opening Accounts. It is separate
                from your login password.
              </p>
            </div>
          </div>
          <div className="security-state">
            <span
              className={`account-status ${q.data.configured ? "active" : "disabled"}`}
            >
              {q.data.configured ? "PIN configured" : "Set up your PIN"}
            </span>
            {q.data.updated_at && (
              <small>Last changed {date(q.data.updated_at)}</small>
            )}
          </div>
          <form onSubmit={save}>
            <fieldset disabled={busy} className="security-fields">
              <label>
                Current login password *
                <PasswordInput
                  aria-label="Current login password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                />
              </label>
              <div className="form-grid">
                <label>
                  New 4-digit PIN *
                  <PasswordInput
                    aria-label="New 4-digit PIN"
                    inputMode="numeric"
                    pattern="[0-9]{4}"
                    maxLength={4}
                    autoComplete="off"
                    required
                    value={pin}
                    onChange={(e) =>
                      setPin(e.target.value.replace(/\D/g, "").slice(0, 4))
                    }
                    disabled={busy}
                  />
                </label>
                <label>
                  Confirm PIN *
                  <PasswordInput
                    aria-label="Confirm PIN"
                    inputMode="numeric"
                    pattern="[0-9]{4}"
                    maxLength={4}
                    autoComplete="off"
                    required
                    value={confirmPin}
                    onChange={(e) =>
                      setConfirmPin(
                        e.target.value.replace(/\D/g, "").slice(0, 4),
                      )
                    }
                    disabled={busy}
                  />
                </label>
              </div>
            </fieldset>
            <ErrorBox error={error} />
            <footer>
              <Button disabled={busy}>
                <KeyRound size={17} aria-hidden="true" />
                {busy
                  ? "Saving PIN…"
                  : q.data.configured
                    ? "Change / reset PIN"
                    : "Set Accounts PIN"}
              </Button>
            </footer>
          </form>
          <div className="security-note">
            <b>Forgot your PIN?</b>
            <p>
              Set a new one here using your current login password. Changing it
              locks Accounts in all your sessions. Accounts unlocks for 15
              minutes; five incorrect PINs cause a 15-minute lockout. Your PIN
              is never displayed or stored as plain text.
            </p>
          </div>
        </section>
      )}
      <WorkHours />
    </>
  );
}
