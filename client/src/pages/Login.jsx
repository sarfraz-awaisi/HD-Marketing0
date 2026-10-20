import { useState, useEffect, useRef } from "react";
import { Navigate } from "react-router-dom";
import { MoveHorizontal, ShieldCheck, Users } from "lucide-react";
import { supabase, configured } from "../lib/supabase";
import { useAuth } from "../context/AuthContext";
import { ErrorBox } from "../components/common/UI";
import GlassForm from "../components/login/GlassForm";
import { authErrorMessage } from "../lib/authErrors";
import { signInToPortal } from "../lib/portalLogin";
import { savedLoginEmails } from "../lib/loginEmails";
import MfaChallenge from "../components/common/MfaChallenge";
import { restoreMfa, cancelMfa } from "../lib/mfaLogin";
import { SIGNED_OUT_KEY, idleSettings } from "../lib/useIdleLogout";
import officeLarge from "../assets/login/office-sunset-1600.webp";
import officeSmall from "../assets/login/office-sunset-960.webp";
import "../styles/login.css";
const portals = {
  admin: {
    label: "Admin",
    title: "Admin Login",
    Icon: ShieldCheck,
    description:
      "Access management tools, team performance, attendance, and company operations.",
  },
  agent: {
    label: "Agent",
    title: "Agent Login",
    Icon: Users,
    description: "Manage your leads, calls, follow-ups, and daily attendance.",
  },
};
const other = (portal) => (portal === "admin" ? "agent" : "admin");
// The slide is skipped when the browser asks for reduced motion (and in
// jsdom, which has no matchMedia), so the form swaps immediately.
function motionAllowed() {
  return (
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
// Half of the 680 ms slide: the old form fades out, then the new one mounts.
const SWAP_DELAY = 300;
function BrandMark() {
  return (
    <svg
      className="glass-brand-mark"
      viewBox="0 0 48 48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 43h38" />
      <path d="M9 43V24l9-4v23" />
      <path d="M18 43V11l11-6v38" />
      <path d="M29 43V18l10 5v20" />
      <path d="M13 27v12M22 15v24M25.5 12.5v26.5M33 23v16M36 25v14" />
    </svg>
  );
}
function Brand() {
  return (
    <div className="glass-brand">
      <BrandMark />
      <p className="glass-brand-name">
        <span>HD</span> MARKETING
      </p>
      <p className="glass-brand-sub">Real Estate Management CRM</p>
    </div>
  );
}
export default function Login() {
  const { user, error, recovering, finishRecovery } = useAuth();
  const [mode, setMode] = useState(
      location.hash.includes("type=recovery") ? "update" : "login",
    ),
    [message, setMessage] = useState("");
  // `side` moves the glass panels at once; `portal` (the form shown) follows
  // halfway through the slide.
  const [portal, setPortal] = useState("agent"),
    [side, setSide] = useState("agent"),
    [leaving, setLeaving] = useState(false);
  const swapTimer = useRef(null),
    formPane = useRef(null),
    focusForm = useRef(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [mfa, setMfa] = useState(null),
    [mfaError, setMfaError] = useState("");
  const restored = useRef(null);
  const current = portals[portal];
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
  useEffect(() => () => clearTimeout(swapTimer.current), []);
  // "Open … Login" on the preview side moves keyboard focus into the new form.
  useEffect(() => {
    if (!focusForm.current) return;
    focusForm.current = false;
    formPane.current?.querySelector("input")?.focus();
  }, [portal]);
  function choosePortal(next) {
    if (pending.current || next === side) return;
    setSide(next);
    setMessage("");
    clearTimeout(swapTimer.current);
    if (!motionAllowed()) {
      setPortal(next);
      setLeaving(false);
      return;
    }
    // Repeated clicks restart this timer, so the form always ends on the
    // last chosen side.
    setLeaving(true);
    swapTimer.current = setTimeout(() => {
      setPortal(next);
      setLeaving(false);
    }, SWAP_DELAY);
  }
  if (user && !user.mfa_required && mode !== "update" && !recovering)
    return <Navigate to="/" replace />;
  const switching = configured && mode === "login" && !mfa && !mfaError;
  const preview = portals[other(portal)];
  const Icon = current.Icon;
  return (
    <div
      className="glass-login-page"
      style={{
        "--login-bg": `url(${officeLarge})`,
        "--login-bg-small": `url(${officeSmall})`,
      }}
    >
      <main
        className="glass-login"
        data-side={side}
        data-leaving={leaving || undefined}
        data-switching={switching || undefined}
      >
        <section
          ref={formPane}
          className="glass-pane glass-form-pane"
          aria-labelledby={mfa ? undefined : "login-title"}
        >
          {switching && (
            <div
              className="glass-portal-toggle"
              role="group"
              aria-label="Login portal"
              data-side={side}
            >
              {["admin", "agent"].map((role) => (
                <button
                  key={role}
                  type="button"
                  aria-pressed={side === role}
                  disabled={busy}
                  onClick={() => choosePortal(role)}
                >
                  {portals[role].label}
                </button>
              ))}
            </div>
          )}
          <div className="glass-pane-content" key={`${portal}:${mode}`}>
            <Brand />
            {!mfa && (
              <div className="glass-heading">
                <h1 id="login-title">
                  {mode === "login" && <Icon size={30} aria-hidden="true" />}
                  {mode === "login"
                    ? current.title
                    : mode === "reset"
                      ? "Reset password"
                      : "Set a new password"}
                </h1>
                <p>
                  {mode === "login"
                    ? current.description
                    : mode === "reset"
                      ? "Enter your work email and we will send you a reset link."
                      : "Choose a new password of at least 12 characters."}
                </p>
              </div>
            )}
            {!configured ? (
              <ErrorBox error="Setup required: copy the public Supabase settings to client/.env. See README.md." />
            ) : mfa ? (
              <MfaChallenge
                flow={mfa}
                onVerified={() =>
                  setMessage("Two-factor verification complete.")
                }
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
                  className="glass-ghost"
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
                <GlassForm
                  key={`${mode}:${portal}`}
                  autoComplete={mode === "login" ? "off" : "on"}
                  disabled={busy}
                  fields={
                    mode === "update"
                      ? [
                          {
                            key: "password",
                            label: "New password",
                            type: "password",
                            placeholder: "Enter a new password",
                            autoComplete: "new-password",
                            required: true,
                          },
                        ]
                      : [
                          {
                            key: "email",
                            label: "Email address",
                            type: "email",
                            placeholder: "Enter your email",
                            autoComplete: mode === "login" ? "off" : "email",
                            ...(mode === "login"
                              ? { suggestions: savedLoginEmails(portal) }
                              : {}),
                            required: true,
                          },
                          ...(mode === "login"
                            ? [
                                {
                                  key: "password",
                                  label: "Password",
                                  type: "password",
                                  placeholder: "Enter your password",
                                  autoComplete: "off",
                                  required: true,
                                },
                              ]
                            : []),
                        ]
                  }
                  submit={
                    mode === "login"
                      ? `Sign in as ${current.label}`
                      : mode === "reset"
                        ? "Send reset link"
                        : "Update password"
                  }
                  pendingLabel={
                    mode === "login"
                      ? "Signing in…"
                      : mode === "reset"
                        ? "Sending…"
                        : "Updating…"
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
                >
                  {mode === "login" && (
                    <div className="glass-row">
                      <button
                        type="button"
                        className="glass-link"
                        disabled={busy}
                        onClick={() => {
                          if (pending.current) return;
                          setMode("reset");
                          setMessage("");
                        }}
                      >
                        Forgot password?
                      </button>
                    </div>
                  )}
                </GlassForm>
                {mode !== "login" && (
                  <button
                    className="glass-link glass-back"
                    disabled={busy}
                    onClick={() => {
                      if (pending.current) return;
                      setMode("login");
                      setMessage("");
                    }}
                  >
                    Back to sign in
                  </button>
                )}
              </>
            )}
            <ErrorBox error={error} />
            {message && (
              <p className="glass-message" role="status">
                {message}
              </p>
            )}
            <small className="glass-footnote">
              Access is provisioned by your administrator.
            </small>
          </div>
        </section>
        {switching && (
          <button
            type="button"
            className="glass-switch"
            aria-label={`Switch to ${portals[other(side)].title}`}
            title={`Switch to ${portals[other(side)].title}`}
            disabled={busy}
            onClick={() => choosePortal(other(side))}
          >
            <MoveHorizontal size={26} aria-hidden="true" />
          </button>
        )}
        <aside
          className="glass-pane glass-preview-pane"
          aria-label={switching ? `${preview.title} option` : "About access"}
        >
          <div
            className="glass-pane-content"
            key={switching ? `preview:${portal}` : "about"}
          >
            <Brand />
            {switching ? (
              <>
                <p className="glass-preview-title">
                  <preview.Icon size={30} aria-hidden="true" />
                  {preview.title}
                </p>
                <p className="glass-preview-text">{preview.description}</p>
                <button
                  type="button"
                  className="glass-ghost"
                  disabled={busy}
                  onClick={() => {
                    focusForm.current = true;
                    choosePortal(other(portal));
                  }}
                >
                  Open {preview.title}
                </button>
              </>
            ) : (
              <>
                <p className="glass-preview-title">Secure team access</p>
                <p className="glass-preview-text">
                  Accounts are created by your administrator inside the CRM.
                  There is no public sign-up.
                </p>
              </>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}
