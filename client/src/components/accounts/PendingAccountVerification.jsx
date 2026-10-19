import { useEffect, useRef, useState } from "react";
import { Button, ErrorBox, Modal, PasswordInput } from "../common/UI";

export default function PendingAccountVerification({
  pending,
  password: originalPassword,
  request,
  onClose,
  onChanged,
  onSaved,
}) {
  const [challenge, setChallenge] = useState(pending);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState(originalPassword || "");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState(
    pending.warning || pending.message || "",
  );
  const [now, setNow] = useState(Date.now());
  const submitting = useRef(false),
    input = useRef(null),
    live = useRef(true);
  useEffect(() => {
    live.current = true;
    input.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      live.current = false;
      clearInterval(timer);
    };
  }, []);
  const remaining = Math.max(
    0,
    Math.ceil((new Date(challenge.expires_at).getTime() - now) / 1000),
  );
  const cooldown = Math.max(
    0,
    Math.ceil((new Date(challenge.resend_at).getTime() - now) / 1000),
  );
  async function run(kind, action) {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(kind);
    setError("");
    try {
      await action();
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      submitting.current = false;
      if (live.current) setBusy("");
    }
  }
  const close = () => {
    if (!submitting.current) {
      setPassword("");
      setCode("");
      onClose();
    }
  };
  return (
    <Modal title="Verify Email Address" onClose={close}>
      <p>
        {challenge.masked_email} ·{" "}
        {challenge.role === "admin" ? "Admin" : "Agent"}
      </p>
      <p className="security-note">
        Enter the code received by the email owner. The account is created after
        successful verification.
      </p>
      <p role="timer" aria-label="Code expiration">
        {remaining
          ? `Code expires in ${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`
          : "Verification code has expired. Please request a new code."}
      </p>
      <ErrorBox error={error} />
      {notice && <p role="status">{notice}</p>}
      <form
        autoComplete="off"
        onSubmit={(event) => {
          event.preventDefault();
          run("verify", async () => {
            if (!/^\d{6}$/.test(code))
              throw new Error("Enter the 6-digit verification code.");
            if (
              password.length < 12 ||
              new TextEncoder().encode(password).length > 72
            )
              throw new Error(
                "Enter the original password, at least 12 characters and at most 72 bytes.",
              );
            const result = await request(
              `/accounts/pending/${challenge.request_id}/verify`,
              { method: "POST", body: { code, password } },
            );
            if (live.current) {
              setPassword("");
              setCode("");
              onSaved(result);
            }
          });
        }}
      >
        <div className="form-grid">
          <label>
            Email verification code *
            <input
              ref={input}
              aria-label="Email verification code"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              disabled={!!busy}
              onChange={(event) =>
                setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
              }
            />
          </label>
          {!originalPassword && (
            <label>
              Original account password *
              <PasswordInput
                aria-label="Original account password"
                autoComplete="new-password"
                disabled={!!busy}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          )}
        </div>
        <footer className="account-actions">
          <Button disabled={!!busy || !remaining}>
            {busy === "verify"
              ? "Creating account…"
              : "Verify & Create Account"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!!busy || !!cooldown}
            onClick={() =>
              run("resend", async () => {
                const result = await request(
                  `/accounts/pending/${challenge.request_id}/resend`,
                  { method: "POST", body: {} },
                );
                if (live.current) {
                  setChallenge(result);
                  setCode("");
                  setNotice(result.warning || result.message);
                  onChanged();
                  input.current?.focus();
                }
              })
            }
          >
            {busy === "resend"
              ? "Sending…"
              : cooldown
                ? `Resend Code (${cooldown}s)`
                : "Resend Code"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!!busy}
            onClick={() =>
              run("cancel", async () => {
                await request(`/accounts/pending/${challenge.request_id}`, {
                  method: "DELETE",
                  body: {},
                });
                if (live.current) {
                  setPassword("");
                  setCode("");
                  onChanged();
                  onClose();
                }
              })
            }
          >
            {busy === "cancel" ? "Cancelling…" : "Cancel request"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={!!busy}
            onClick={close}
          >
            Close
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
