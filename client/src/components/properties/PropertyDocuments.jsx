import { useId, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Download,
  Eye,
  FilePlus2,
  FileText,
  Share2,
  Trash2,
} from "lucide-react";
import { api, date, download } from "../../lib/api";
import {
  canShareFiles,
  documentSize,
  fetchDocument,
  isPdf,
  maxDocumentBytes,
  shareText,
  uploadDocument,
} from "../../lib/propertyDocuments";
import { Button, ErrorBox, useToast } from "../common/UI";
import "../../styles/properties.css";
// Update 054: a property's PDF documents in its details. Whoever can see the
// property can view, download and share them; whoever can change it (canManage)
// can add and remove them. Files come through the API, never a public link.
export default function PropertyDocuments({ property, canManage }) {
  const qc = useQueryClient(),
    toast = useToast(),
    headingId = useId(),
    input = useRef();
  const key = ["property-documents", property.id];
  const q = useQuery({
    queryKey: key,
    queryFn: ({ signal }) =>
      api(`/properties/${property.id}/documents`, { signal }),
  });
  const [busy, setBusy] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [confirming, setConfirming] = useState(null),
    [ready, setReady] = useState(null),
    [progress, setProgress] = useState("");
  async function run(doc, action, fn) {
    if (busy) return;
    setBusy({ id: doc?.id, action });
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }
  const pdfBlob = async (doc) =>
    new Blob([await fetchDocument(property.id, doc)], {
      type: "application/pdf",
    });
  function view(doc) {
    // Opened at once, so the browser treats it as the click's own tab.
    const tab = window.open("", "_blank");
    run(doc, "view", async () => {
      try {
        const url = URL.createObjectURL(await pdfBlob(doc));
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        if (tab && !tab.closed) {
          tab.opener = null;
          tab.location.href = url;
        } else {
          const a = document.createElement("a");
          a.href = url;
          a.download = doc.file_name;
          a.click();
          setNotice(
            "Your browser blocked the preview tab, so the PDF was downloaded instead.",
          );
        }
      } catch (e) {
        tab?.close();
        throw e;
      }
    });
  }
  const save = (doc) =>
    run(doc, "download", async () =>
      download(await pdfBlob(doc), doc.file_name),
    );
  function share(doc) {
    const text = shareText(property);
    if (canShareFiles())
      // The phone's share sheet attaches the PDF itself; choose WhatsApp.
      return run(doc, "share", async () => {
        const file = new File([await pdfBlob(doc)], doc.file_name, {
          type: "application/pdf",
        });
        try {
          await navigator.share({ files: [file], title: doc.file_name, text });
        } catch (e) {
          if (e?.name === "AbortError") return;
          // Preparing the file took too long for this click: share on the next.
          if (e?.name === "NotAllowedError")
            return setReady({ doc, file, text });
          throw new Error(
            "The document could not be shared. Download it and attach it in WhatsApp.",
          );
        }
      });
    // Desktop: WhatsApp opens with the details; the PDF is attached by hand.
    window.open(
      `https://wa.me/?text=${encodeURIComponent(text)}`,
      "_blank",
      "noopener,noreferrer",
    );
    return run(doc, "share", async () => {
      download(await pdfBlob(doc), doc.file_name);
      setNotice(
        `“${doc.file_name}” was downloaded and WhatsApp opened with the property details. Choose the chat, then attach the PDF with the paperclip: browsers cannot attach files to WhatsApp automatically.`,
      );
    });
  }
  async function shareReady() {
    const { file, text } = ready;
    setReady(null);
    try {
      await navigator.share({ files: [file], title: file.name, text });
    } catch (e) {
      if (e?.name !== "AbortError")
        setError(
          "The document could not be shared. Download it and attach it in WhatsApp.",
        );
    }
  }
  const remove = (doc) =>
    run(doc, "remove", async () => {
      await api(`/properties/${property.id}/documents/${doc.id}`, {
        method: "DELETE",
      });
      setConfirming(null);
      qc.setQueryData(key, (list) => list?.filter((d) => d.id !== doc.id));
      qc.invalidateQueries({ queryKey: key });
      toast("Document removed");
    });
  function add(event) {
    const files = [...event.target.files];
    event.target.value = "";
    const valid = files.filter(isPdf);
    run(null, "upload", async () => {
      if (valid.length !== files.length)
        setNotice(
          `Some files were skipped. Choose PDF files up to ${maxDocumentBytes / 1048576} MB each.`,
        );
      try {
        for (const [i, file] of valid.entries()) {
          setProgress(
            valid.length > 1
              ? `Uploading ${i + 1} of ${valid.length}…`
              : "Uploading…",
          );
          try {
            await uploadDocument(property.id, file);
          } catch (e) {
            throw new Error(`“${file.name}” could not be added. ${e.message}`);
          }
        }
        if (valid.length)
          toast(valid.length === 1 ? "Document added" : "Documents added");
      } finally {
        setProgress("");
        qc.invalidateQueries({ queryKey: key });
      }
    });
  }
  const docs = q.data || [];
  const doing = (doc, action) => busy?.id === doc.id && busy.action === action;
  return (
    <section className="property-documents" aria-labelledby={headingId}>
      <div className="property-documents-head">
        <h3 id={headingId}>Property documents</h3>
        {canManage && (
          <>
            <Button
              type="button"
              variant="secondary"
              disabled={!!busy || docs.length >= 10}
              onClick={() => input.current.click()}
            >
              <FilePlus2 size={18} aria-hidden="true" />{" "}
              {busy?.action === "upload"
                ? progress || "Uploading…"
                : "Add PDFs"}
            </Button>
            <input
              ref={input}
              type="file"
              hidden
              multiple
              accept="application/pdf,.pdf"
              aria-label="Add property documents"
              onChange={add}
            />
          </>
        )}
      </div>
      <ErrorBox error={q.error || error} />
      {notice && (
        <p className="document-notice" role="status">
          {notice}
        </p>
      )}
      {ready && (
        <p className="document-notice" role="status">
          “{ready.doc.file_name}” is ready.{" "}
          <Button type="button" onClick={shareReady}>
            <Share2 size={16} aria-hidden="true" /> Share now
          </Button>
        </p>
      )}
      {q.isPending ? (
        <p className="field-hint">Loading documents…</p>
      ) : !docs.length ? (
        <p className="field-hint">
          {canManage
            ? "No documents yet. Add brochures, floor plans or payment plans as PDF files."
            : "No documents added."}
        </p>
      ) : (
        <ul className="document-list">
          {docs.map((doc) => (
            <li key={doc.id}>
              <FileText
                size={20}
                aria-hidden="true"
                className="document-icon"
              />
              <span className="document-name">
                <b>{doc.file_name}</b>
                <small>
                  {documentSize(doc.size_bytes)} · {date(doc.created_at)}
                  {doc.uploaded_by_name && ` · ${doc.uploaded_by_name}`}
                </small>
              </span>
              {confirming === doc.id ? (
                <span
                  className="document-actions document-confirm"
                  role="group"
                  aria-label={`Remove ${doc.file_name}?`}
                >
                  <span>Remove this document? This cannot be undone.</span>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => setConfirming(null)}
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    disabled={!!busy}
                    onClick={() => remove(doc)}
                  >
                    {doing(doc, "remove") ? "Removing…" : "Remove"}
                  </Button>
                </span>
              ) : (
                <span className="document-actions">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!!busy}
                    aria-label={`View ${doc.file_name}`}
                    onClick={() => view(doc)}
                  >
                    <Eye size={16} aria-hidden="true" />
                    {doing(doc, "view") ? "Opening…" : "View"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={!!busy}
                    aria-label={`Download ${doc.file_name}`}
                    onClick={() => save(doc)}
                  >
                    <Download size={16} aria-hidden="true" />
                    {doing(doc, "download") ? "Downloading…" : "Download"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    className="document-whatsapp"
                    disabled={!!busy}
                    aria-label={`Share ${doc.file_name} on WhatsApp`}
                    onClick={() => share(doc)}
                  >
                    <Share2 size={16} aria-hidden="true" />
                    {doing(doc, "share") ? "Preparing…" : "WhatsApp"}
                  </Button>
                  {canManage && (
                    <Button
                      type="button"
                      variant="secondary"
                      className="document-remove"
                      disabled={!!busy}
                      aria-label={`Remove ${doc.file_name}`}
                      onClick={() => setConfirming(doc.id)}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                      Remove
                    </Button>
                  )}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
