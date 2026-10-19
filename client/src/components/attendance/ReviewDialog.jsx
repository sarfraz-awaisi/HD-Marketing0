import { useState } from "react";
import { Button, ErrorBox, Modal } from "../common/UI";
// Approve or reject a leave or correction request, with an optional note.
export default function ReviewDialog({ title, children, onReview, onClose }) {
  const [note, setNote] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function decide(decision) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onReview(decision, note.trim() || undefined);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal title={title} onClose={() => !busy && onClose()}>
      {children}
      <label className="review-note">
        Note to the employee (optional)
        <textarea
          rows="2"
          maxLength={300}
          value={note}
          disabled={busy}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      <ErrorBox error={error} />
      <footer className="review-buttons">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => decide("rejected")}
        >
          Reject
        </Button>
        <Button disabled={busy} onClick={() => decide("approved")}>
          {busy ? "Saving…" : "Approve"}
        </Button>
      </footer>
    </Modal>
  );
}
