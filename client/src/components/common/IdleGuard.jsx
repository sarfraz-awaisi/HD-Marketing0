import { useCallback } from "react";
import { useAuth } from "../../context/AuthContext";
import { SIGNED_OUT_KEY, useIdleLogout } from "../../lib/useIdleLogout";
import { Button, Modal } from "./UI";
// Separate from Layout so the countdown re-renders only this dialog.
export default function IdleGuard() {
  const { logout } = useAuth();
  const timeout = useCallback(async () => {
    try {
      sessionStorage.setItem(SIGNED_OUT_KEY, "idle");
    } catch {
      // The sign-out still happens without the explanatory notice.
    }
    await logout();
  }, [logout]);
  const { remaining, stay } = useIdleLogout(timeout);
  if (remaining == null) return null;
  const time = `${Math.floor(remaining / 60)}:${String(remaining % 60).padStart(2, "0")}`;
  return (
    <Modal title="Are you still there?" onClose={stay}>
      <p role="timer" aria-live="polite">
        For security, you will be signed out in <b>{time}</b> because there has
        been no activity. Unsaved changes in open forms will be lost.
      </p>
      <footer className="account-actions">
        <Button onClick={stay}>Stay signed in</Button>
        <Button variant="secondary" onClick={timeout}>
          Sign out now
        </Button>
      </footer>
    </Modal>
  );
}
