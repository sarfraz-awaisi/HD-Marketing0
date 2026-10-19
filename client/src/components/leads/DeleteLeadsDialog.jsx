import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { Button, Modal, ErrorBox, Loader } from "../common/UI";
export default function DeleteLeadsDialog({ ids, file, onClose, onDeleted }) {
  const [reason, setReason] = useState(""),
    [confirmation, setConfirmation] = useState(""),
    [mode, setMode] = useState("file_only"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false);
  const preview = useQuery({
    queryKey: ["delete-preview", file?.id, ids],
    queryFn: ({ signal }) =>
      api("/leads/delete-preview", {
        method: "POST",
        body: file ? { import_id: file.id } : { lead_ids: ids },
        signal,
      }),
  });
  const count = preview.data?.leads ?? ids?.length ?? 0;
  const close = () => {
    if (!pending.current) onClose();
  };
  return (
    <Modal
      title={file ? "Delete imported file" : "Move leads to Deleted leads"}
      onClose={close}
    >
      {preview.isPending ? (
        <Loader />
      ) : (
        <>
          <p>{file?.file_name}</p>
          <p>
            {count} leads · {preview.data?.followups ?? 0} open follow-ups ·{" "}
            {preview.data?.visits ?? 0} scheduled visits
          </p>
          {!!preview.data?.won && (
            <p>{preview.data.won} leads have a won deal and will be kept.</p>
          )}
        </>
      )}
      <ErrorBox error={error || preview.error} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current || preview.error || !preview.data) return;
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            const result = await api(
              file ? `/lead-imports/${file.id}` : "/leads/delete",
              {
                method: file ? "DELETE" : "POST",
                body: file
                  ? { mode, reason: reason.trim() }
                  : { lead_ids: ids, reason: reason.trim() },
              },
            );
            onDeleted(result);
          } catch (e) {
            setError(e.message);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        {file && (
          <label>
            Delete mode
            <select
              aria-label="Delete mode"
              value={mode}
              disabled={busy}
              onChange={(e) => setMode(e.target.value)}
            >
              <option value="file_only">Delete file only (keep leads)</option>
              <option value="file_and_leads">Delete file and its leads</option>
            </select>
          </label>
        )}
        <p>
          {file && mode === "file_only"
            ? "Customer leads will remain in Leads without this file."
            : "Leads can be restored for 30 days. They will be unassigned; pending follow-ups and visits will be cancelled, and unread reminders removed. After retention, the background job erases them."}
        </p>
        <label>
          Reason
          <textarea
            aria-label="Delete reason"
            required
            minLength={3}
            maxLength={300}
            value={reason}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        {count >= 20 && (
          <label>
            Type DELETE to confirm
            <input
              aria-label="Type DELETE to confirm"
              value={confirmation}
              disabled={busy}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
        )}
        <footer>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={
              busy ||
              preview.isPending ||
              !!preview.error ||
              reason.trim().length < 3 ||
              (count >= 20 && confirmation !== "DELETE")
            }
          >
            {busy
              ? "Deleting…"
              : file
                ? "Delete file"
                : "Move to Deleted leads"}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
