import { useEffect, useState } from "react";
import { Download, ExternalLink } from "lucide-react";
import { api, download } from "../../lib/api";
import { Button, ErrorBox, Loader, Modal } from "../common/UI";
// Viewing a Documentation & policies file in the browser: a PDF, in the
// browser's own PDF viewer, for anyone who may download it (administrators,
// and agents for the entries they can read). The file is fetched with the
// signed-in account, held only in this page's memory and released on
// closing; nothing is stored or shared. The server records each view; the
// Download button here is an ordinary, recorded download.
export const viewable = (file) => file?.mime_type === "application/pdf";

export default function DocumentViewer({ documentId, file, onClose }) {
  const [shown, setShown] = useState({ url: null, error: "" }),
    [saving, setSaving] = useState(false),
    [saveError, setSaveError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let url = null;
    api(`/documents/${documentId}/files/${file.id}/view`, {
      download: true,
      signal: controller.signal,
    })
      .then((blob) => {
        url = URL.createObjectURL(
          new Blob([blob], { type: "application/pdf" }),
        );
        setShown({ url, error: "" });
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setShown({ url: null, error: error.message });
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [documentId, file.id]);
  async function save() {
    setSaving(true);
    setSaveError("");
    try {
      download(
        await api(`/documents/${documentId}/files/${file.id}/download`, {
          download: true,
        }),
        file.file_name,
      );
    } catch (error) {
      setSaveError(error.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Modal title={file.file_name} onClose={onClose} className="document-viewer">
      <ErrorBox error={shown.error || saveError} />
      {!shown.url ? (
        !shown.error && <Loader />
      ) : (
        <>
          <iframe
            className="document-viewer-frame"
            title={`${file.file_name} (PDF)`}
            src={shown.url}
          />
          <div className="document-viewer-actions">
            <a
              className="button fx-btn secondary"
              href={shown.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink size={16} aria-hidden="true" /> Open in a new tab
            </a>
            <Button variant="secondary" disabled={saving} onClick={save}>
              <Download size={16} aria-hidden="true" />
              {saving ? "Downloading…" : "Download"}
            </Button>
          </div>
          <p className="field-hint">
            If the document does not show here (some phones), use Open in a new
            tab.
          </p>
        </>
      )}
    </Modal>
  );
}
