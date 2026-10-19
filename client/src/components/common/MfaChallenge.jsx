import { useRef, useState } from "react";
import { Button, ErrorBox } from "./UI";
import { cancelMfa, completeMfa } from "../../lib/mfaLogin";
export default function MfaChallenge({ flow, onCancelled, onVerified }) {
  const [factor, setFactor] = useState(
      flow.enrollment?.id || flow.factors[0]?.id || "",
    ),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false);
  const enrollment = flow.enrollment;
  const qr = enrollment?.totp.qr_code;
  const safeQr = qr?.startsWith("data:image/svg+xml")
    ? qr
    : qr?.trim().startsWith("<svg")
      ? "data:image/svg+xml;charset=utf-8," + encodeURIComponent(qr)
      : null;
  return (
    <div className="mfa-challenge">
      <h2>
        {enrollment ? "Set up two-factor login" : "Verify two-factor login"}
      </h2>
      <p>
        {enrollment
          ? "Add HD Marketing to your authenticator app, then enter its six-digit code."
          : "Enter the six-digit code from your authenticator app to open your workspace."}
      </p>
      {enrollment && (
        <>
          <img
            className="mfa-qr"
            src={safeQr || undefined}
            alt="Scan this QR code with your authenticator app"
          />
          <details>
            <summary>Enter a setup key instead</summary>
            <p>
              Keep this key private. Never send it to an administrator or
              support.
            </p>
            <code className="mfa-secret">{enrollment.totp.secret}</code>
          </details>
        </>
      )}
      <form
        autoComplete="off"
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            await completeMfa(flow, factor, code);
            setCode("");
            onVerified?.();
          } catch (e) {
            setError(e.message);
            setCode("");
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        {!enrollment && flow.factors.length > 1 && (
          <label>
            Authenticator
            <select
              value={factor}
              disabled={busy}
              onChange={(e) => {
                setFactor(e.target.value);
                setCode("");
              }}
            >
              {flow.factors.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.friendly_name || "Authenticator " + f.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Authenticator code
          <input
            autoFocus
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength={6}
            required
            disabled={busy}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
        </label>
        <ErrorBox error={error} />
        <div className="mfa-actions">
          <Button disabled={busy || code.length !== 6}>
            {busy
              ? "Verifying…"
              : enrollment
                ? "Enable and sign in"
                : "Verify and sign in"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={async () => {
              if (pending.current) return;
              pending.current = true;
              setBusy(true);
              try {
                await cancelMfa(flow);
                onCancelled();
              } catch {
                setError("Sign out and try again.");
              } finally {
                pending.current = false;
                setBusy(false);
              }
            }}
          >
            Back to sign in
          </Button>
        </div>
      </form>
      <p className="security-note">
        Lost your authenticator? Another administrator can reset two-factor
        login from Accounts. Password recovery does not remove it.
      </p>
    </div>
  );
}
