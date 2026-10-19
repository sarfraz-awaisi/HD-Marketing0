import { useEffect, useState, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { RecordForm, ErrorBox, Loader, Button } from "../components/common/UI";
import { useAuth } from "../context/AuthContext";
import {
  readInvitationCallback,
  openInvitation,
} from "../lib/accountInvitation";
export default function AcceptInvitation() {
  const auth = useAuth() || {},
    navigate = useNavigate();
  const [leaving, setLeaving] = useState(false),
    leavePending = useRef(false);
  const [callback] = useState(readInvitationCallback),
    [opened, setOpened] = useState(null),
    [error, setError] = useState(""),
    [completed, setCompleted] = useState(null);
  const pending = useRef(null),
    alive = useRef(false);
  useEffect(() => {
    // Invitation/session secrets remain in component memory, not history or browser storage.
    window.history.replaceState(null, "", window.location.pathname);
    let live = true;
    alive.current = true;
    pending.current ||= openInvitation(callback);
    pending.current
      .then((result) => {
        if (live) setOpened(result);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
      alive.current = false;
      setTimeout(() => {
        if (!alive.current)
          pending.current.then((result) => result.close()).catch(() => {});
      }, 0);
    };
  }, [callback]);
  return (
    <div className="login">
      <section className="login-story">
        <div className="brand">
          <b>HD</b> MARKETING
        </div>
        <div>
          <span className="eyebrow">YOUR TEAM INVITATION</span>
          <h1>
            Your next chapter
            <br />
            starts here.
          </h1>
          <p>Join the HD Marketing workspace.</p>
        </div>
      </section>
      <section className="login-form">
        <span className="eyebrow">WELCOME TO YOUR WORKSPACE</span>
        <h2>Accept invitation</h2>
        <ErrorBox error={error} />
        {completed ? (
          <>
            <p role="status">
              {completed.active
                ? "Your account is ready. Sign in with your new password."
                : "Password saved and invitation accepted. Your administrator must enable access before you can sign in."}
            </p>
            <p>
              Choose the {completed.role === "admin" ? "Admin" : "Agent"}{" "}
              portal.
            </p>
            {auth.user ? (
              <>
                <p>
                  A different account is signed in. Sign out to use your new
                  account.
                </p>
                <Button
                  disabled={leaving}
                  onClick={async () => {
                    if (leavePending.current) return;
                    leavePending.current = true;
                    setLeaving(true);
                    try {
                      await auth.logout();
                      navigate("/login");
                    } catch (e) {
                      setError(e.message);
                    } finally {
                      leavePending.current = false;
                      setLeaving(false);
                    }
                  }}
                >
                  {leaving ? "Signing out…" : "Sign out and sign in"}
                </Button>
              </>
            ) : (
              <Link className="button" to="/login">
                Go to sign in
              </Link>
            )}
          </>
        ) : opened ? (
          <>
            <p>
              {opened.profile.name} · {opened.profile.email}
            </p>
            <p>
              Your email is verified. Set your own password to finish joining as{" "}
              {opened.profile.role === "admin"
                ? "an administrator"
                : "an agent"}
              .
            </p>
            <RecordForm
              autoComplete="off"
              fields={[
                {
                  key: "password",
                  label: "New password",
                  type: "password",
                  autoComplete: "new-password",
                  required: true,
                },
                {
                  key: "confirm_password",
                  label: "Confirm password",
                  type: "password",
                  autoComplete: "new-password",
                  required: true,
                },
              ]}
              submit="Accept invitation"
              onSave={async (data) => {
                if (data.password !== data.confirm_password)
                  throw new Error("Passwords must match.");
                if (
                  data.password.length < 12 ||
                  new TextEncoder().encode(data.password).length > 72
                )
                  throw new Error(
                    "Use at least 12 characters and no more than 72 bytes.",
                  );
                setCompleted(await opened.complete(data.password));
              }}
            />
          </>
        ) : !error ? (
          <Loader />
        ) : null}
        <small>
          Invitation links expire. Contact your administrator if you need a
          fresh link.
        </small>
      </section>
    </div>
  );
}
