import { useRef, useState } from "react";
import { api } from "../../lib/api";
import { Button, Modal, ErrorBox } from "../common/UI";
// Delete instantly (update 069): leads in Deleted leads, or the leads a
// deleted file moved there, are erased now with every record. It cannot be
// undone, so the administrator types DELETE first.
export default function EraseLeadsDialog({ ids, file, onClose, onErased }) {
  const [confirmation, setConfirmation] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const pending = useRef(false);
  const close = () => {
    if (!pending.current) onClose();
  };
  const what = file
    ? `The leads deleted with “${file.file_name}”`
    : ids.length === 1
      ? "This lead"
      : `These ${ids.length} leads`;
  return (
    <Modal title="Delete permanently" onClose={close}>
      <p>
        {what} and all {ids?.length === 1 ? "its" : "their"} records (calls and
        recordings, notes, follow-ups, site visits, deals and documents) will be
        deleted from the CRM now.
        {file && " The file can no longer be restored."}
      </p>
      <p>
        <b>This cannot be undone.</b> Leads with a won deal are kept.
      </p>
      <ErrorBox error={error} />
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending.current || confirmation !== "DELETE") return;
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            const result = await api(
              file ? `/lead-imports/${file.id}/erase` : "/leads/erase",
              { method: "POST", body: file ? {} : { lead_ids: ids } },
            );
            onErased(result);
          } catch (e) {
            setError(e.message);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <label>
          Type DELETE to confirm
          <input
            aria-label="Type DELETE to confirm"
            value={confirmation}
            disabled={busy}
            autoComplete="off"
            onChange={(e) => setConfirmation(e.target.value)}
          />
        </label>
        <footer>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </Button>
          <Button variant="danger" disabled={busy || confirmation !== "DELETE"}>
            {busy
              ? "Deleting…"
              : file
                ? "Delete the file's leads permanently"
                : `Delete ${ids.length === 1 ? "lead" : `${ids.length} leads`} permanently`}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
