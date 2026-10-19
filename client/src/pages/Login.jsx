import { useState, useEffect, useRef } from "react";
import { Navigate } from "react-router-dom";
import { UserRound, ShieldCheck } from "lucide-react";
import { supabase, configured } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { RecordForm, ErrorBox } from "../components/common/UI";
import { authErrorMessage } from "../lib/authErrors";
import { signInToPortal } from "../lib/portalLogin";
import { savedLoginEmails } from "../lib/loginEmails";
import MfaChallenge from "../components/common/MfaChallenge";
import { restoreMfa, cancelMfa } from "../lib/mfaLogin";
import { SIGNED_OUT_KEY, idleSettings } from "../lib/useIdleLogout";
export default function Login() {
  const { user, error, recovering, finishRecovery } = useAuth();
  const [mode, setMode] = useState(
      location.hash.includes("type=recovery") ? "update" : "login",
    ),
    [message, setMessage] = useState("");
  const [portal, setPortal] = useState("agent");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [mfa, setMfa] = useState(null),
    [mfaError, setMfaError] = useState("");
  const restored = useRef(null);
  const portalLabel = portal === "admin" ? "Admin" : "Agent";
  useEffect(() => {
    if (location.hash.includes("type=recovery")) setMode("update");
  }, []);
  useEffect(() => {
    try {
      if (sessionStorage.getItem(SIGNED_OUT_KEY) !== "idle") return;
      sessionStorage.removeItem(SIGNED_OUT_KEY);
      setMessage(
        `You were signed out after ${idleSettings().limit / 60000} minutes of inactivity. Sign in again to continue.`,
      );
    } catch {
      // Without session storage there is simply no notice.
    }
  }, []);
  useEffect(() => {
    if (recovering) setMode("update");
  }, [recovering]);
  useEffect(() => {
    if (!user?.mfa_required || mfa || mode === "update" || recovering) return;
    let live = true;
    restored.current ||= restoreMfa(user);
    restored.current
      .then((flow) => {
        if (live) setMfa(flow);
      })
      .catch((e) => {
        if (live) setMfaError(e.message);
      });
    return () => {
      live = false;
    };
  }, [user, mfa, mode, recovering]);
  useEffect(
    () => () => {
      if (mfa && !mfa.disposed) cancelMfa(mfa).catch(() => {});
    },
    [mfa],
  );
  if (user && !user.mfa_required && mode !== "update" && !recovering)
    return <Navigate to="/" replace />;
  return (
    <div className="login">
      <section className="login-story">
        <div className="brand">
          <b>HD</b> MARKETING
        </div>
        <div>
          <span className="eyebrow">THE REAL ESTATE WORKSPACE</span>
          <h1>
            Build relationships.
            <br />
            Close with confidence.
          </h1>
          <p>
            Your leads, conversations and next steps. Together in one place.
          </p>
        </div>
        <small>HD Marketing · Sales CRM</small>
      </section>
      <section className="login-form">
        <span className="eyebrow">WELCOME TO YOUR WORKSPACE</span>
        {!mfa && (
          <h2>
            {mode === "login"
              ? `${portalLabel} sign in`
              : mode === "reset"
                ? "Reset password"
                : "Set a new password"}
          </h2>
        )}
        {!mfa && <p>Secure access for the HD Marketing team.</p>}
        {!configured ? (
          <ErrorBox error="Setup required: copy the public Supabase settings to client/.env. See README.md." />
        ) : mfa ? (
          <MfaChallenge
            flow={mfa}
            onVerified={() => setMessage("Two-factor verification complete.")}
            onCancelled={async () => {
              if (user?.mfa_required) await supabase.auth.signOut();
              setMfa(null);
              setMfaError("");
              restored.current = null;
            }}
          />
        ) : mfaError ? (
          <>
            <ErrorBox error={mfaError} />
            <button
              className="button secondary"
              onClick={async () => {
                await supabase.auth.signOut();
                setMfaError("");
                restored.current = null;
              }}
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            {mode === "login" && (
              <div
                className="login-portal"
                role="group"
                aria-label="Login portal"
              >
                {[
                  { role: "agent", label: "Agent", Icon: UserRound },
                  { role: "admin", label: "Admin", Icon: ShieldCheck },
                ].map(({ role, label, Icon }) => (
                  <button
                    key={role}
                    type="button"
                    aria-pressed={portal === role}
                    disabled={busy}
                    onClick={() => {
                      if (pending.current) return;
                      setPortal(role);
                      setMessage("");
                    }}
                  >
                    <Icon size={18} aria-hidden="true" /> {label}
                  </button>
                ))}
              </div>
            )}
            <RecordForm
              key={`${mode}:${portal}`}
              autoComplete={mode === "login" ? "off" : "on"}
              fields={
                mode === "update"
                  ? [
                      {
                        key: "password",
                        label: "New password",
                        type: "password",
                        autoComplete: "new-password",
                        required: true,
                      },
                    ]
                  : [
                      {
                        key: "email",
                        label: "Email address",
                        type: "email",
                        autoComplete: mode === "login" ? "off" : "email",
                        ...(mode === "login"
                          ? { suggestions: savedLoginEmails(portal) }
                          : {}),
                        autoCapitalize: "none",
                        spellCheck: false,
                        required: true,
                      },
                      ...(mode === "login"
                        ? [
                            {
                              key: "password",
                              label: "Password",
                              type: "password",
                              autoComplete: "off",
                              required: true,
                            },
                          ]
                        : []),
                    ]
              }
              submit={
                mode === "login"
                  ? `Sign in as ${portalLabel}`
                  : mode === "reset"
                    ? "Send reset link"
                    : "Update password"
              }
              onSave={async (data) => {
                if (pending.current) return;
                pending.current = true;
                setBusy(true);
                try {
                  if (mode === "login") {
                    const result = await signInToPortal(data, portal);
                    if (result.mfa) setMfa(result.mfa);
                    return;
                  }
                  let result;
                  if (mode === "reset")
                    result = await supabase.auth.resetPasswordForEmail(
                      data.email,
                      { redirectTo: location.origin + "/login" },
                    );
                  else {
                    if (data.password.length < 12)
                      throw new Error("Use at least 12 characters");
                    result = await supabase.auth.updateUser({
                      password: data.password,
                    });
                  }
                  if (result.error)
                    throw new Error(authErrorMessage(result.error));
                  if (mode === "reset")
                    setMessage(
                      "If your account exists, check your inbox for a reset link.",
                    );
                  if (mode === "update") {
                    finishRecovery();
                    setMode("login");
                    setMessage("Password updated.");
                  }
                } finally {
                  pending.current = false;
                  setBusy(false);
                }
              }}
            />
            <button
              className="text-button"
              disabled={busy}
              onClick={() => {
                if (pending.current) return;
                setMode(mode === "login" ? "reset" : "login");
                setMessage("");
              }}
            >
              {mode === "login" ? "Forgot your password?" : "Back to sign in"}
            </button>
          </>
        )}
        <ErrorBox error={error} />
        {message && <p role="status">{message}</p>}
        <small>Access is provisioned by your administrator.</small>
      </section>
    </div>
  );
}
