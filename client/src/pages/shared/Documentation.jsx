import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  FileText,
  Paperclip,
  Download,
  Search,
  Building2,
} from "lucide-react";
import { api, date, download } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import KycClientPicker from "../../components/documents/KycClientPicker";
import {
  Button,
  Modal,
  Loader,
  ErrorBox,
  Pagination,
  useToast,
} from "../../components/common/UI";
import {
  documentCategories,
  documentCategoryLabel as typeLabel,
} from "../../lib/documentCategories";
const fileSize = (bytes) =>
  bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KB`
    : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

function EntryForm({ entry, onPending, onSaved }) {
  const savedId = useRef(entry?.id || null),
    submitting = useRef(false),
    picker = useRef();
  const [title, setTitle] = useState(entry?.title || ""),
    [category, setCategory] = useState(entry?.category || "policy");
  const [content, setContent] = useState(entry?.content || ""),
    [files, setFiles] = useState([]);
  const [propertyName, setPropertyName] = useState(entry?.property_name || ""),
    [keywords, setKeywords] = useState(entry?.keywords || "");
  const [leadId, setLeadId] = useState(entry?.lead_id || null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [fileError, setFileError] = useState("");
  const qc = useQueryClient();
  function chooseFiles(event) {
    const chosen = [...event.target.files];
    event.target.value = "";
    const valid = chosen.filter(
      (file) =>
        /\.(pdf|doc|docx)$/i.test(file.name) &&
        file.size > 0 &&
        file.size <= 10 * 1024 * 1024,
    );
    setFileError(
      chosen.length !== valid.length
        ? "Some files were skipped. Choose PDF, DOC or DOCX files up to 10 MB each."
        : "",
    );
    setFiles((current) => {
      const next = [...current];
      for (const file of valid)
        if (
          !next.some(
            (item) =>
              item.file.name === file.name &&
              item.file.size === file.size &&
              item.file.lastModified === file.lastModified,
          )
        )
          next.push({ id: crypto.randomUUID(), file });
      return next;
    });
  }
  async function save(event) {
    event.preventDefault();
    if (submitting.current) return;
    if (!title.trim() || !content.trim()) {
      setError(
        "Enter a title and written content or a description for the attached files.",
      );
      return;
    }
    if (category === "client_kyc" && !leadId) {
      setError("Choose a client for Client KYC.");
      return;
    }
    submitting.current = true;
    onPending(true);
    setBusy(true);
    setError("");
    let saved;
    try {
      saved = await api(
        "/documents" + (savedId.current ? "/" + savedId.current : ""),
        {
          method: savedId.current ? "PATCH" : "POST",
          body: {
            title: title.trim(),
            category,
            content: content.trim(),
            property_name: propertyName.trim(),
            keywords: keywords.trim(),
            ...(category === "client_kyc" ? { lead_id: leadId } : {}),
          },
        },
      );
      savedId.current = saved.id;
      qc.invalidateQueries({ queryKey: ["documents"] });
      qc.invalidateQueries({ queryKey: ["document"] });
      for (const item of files) {
        const body = new FormData();
        body.append("file", item.file);
        await api(`/documents/${saved.id}/files`, { method: "POST", body });
        setFiles((current) => current.filter((file) => file.id !== item.id));
        qc.invalidateQueries({ queryKey: ["document"] });
      }
      onSaved(saved);
    } catch (error) {
      setError(
        saved && files.length
          ? `Entry saved, but some files could not be uploaded. ${error.message} Save again to retry the remaining files.`
          : error.message,
      );
    } finally {
      submitting.current = false;
      onPending(false);
      setBusy(false);
    }
  }
  return (
    <form className="knowledge-editor" onSubmit={save}>
      <fieldset disabled={busy}>
        <div className="form-grid">
          <label>
            Title *
            <input
              aria-label="Title"
              required
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            Category *
            <select
              aria-label="Entry category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              {documentCategories.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Property name <small>(optional)</small>
            <input
              aria-label="Property name"
              maxLength={200}
              value={propertyName}
              onChange={(e) => setPropertyName(e.target.value)}
              placeholder="Property or project name…"
            />
          </label>
          {category === "client_kyc" && (
            <KycClientPicker
              value={leadId}
              onChange={setLeadId}
              selectedName={entry?.lead_name}
            />
          )}
          <label>
            Keywords <small>(optional)</small>
            <input
              aria-label="Keywords"
              maxLength={500}
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="e.g. ownership, approval, rental"
            />
          </label>
          <label className="wide">
            Content *
            <textarea
              aria-label="Content"
              rows={12}
              required
              maxLength={50000}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Write the policy, instructions, or a description of the attached files…"
            />
            <small>{content.length.toLocaleString()} / 50,000 characters</small>
          </label>
        </div>
        <section className="knowledge-attachments" aria-label="Attach files">
          <h3>
            Attachments <small>(optional)</small>
          </h3>
          <p>
            Attach PDF or Word files up to 10 MB each. Files upload when you
            save.
          </p>
          {!!entry?.files?.length && (
            <p>
              {entry.files.length} existing{" "}
              {entry.files.length === 1 ? "attachment" : "attachments"}. Manage
              saved files on the entry’s reading page.
            </p>
          )}
          <Button
            type="button"
            variant="secondary"
            onClick={() => picker.current.click()}
          >
            <Paperclip size={18} aria-hidden="true" /> Add files
          </Button>
          <input
            ref={picker}
            type="file"
            hidden
            multiple
            accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            aria-label="Policy or documentation files"
            onChange={chooseFiles}
          />
          <ErrorBox error={fileError} />
          {!!files.length && (
            <ul className="knowledge-file-list">
              {files.map((item) => (
                <li key={item.id}>
                  <span>
                    <b>{item.file.name}</b>
                    <small>{fileSize(item.file.size)}</small>
                  </span>
                  <Button
                    type="button"
                    variant="secondary"
                    aria-label={`Remove ${item.file.name}`}
                    onClick={() =>
                      setFiles((current) =>
                        current.filter((file) => file.id !== item.id),
                      )
                    }
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </fieldset>
      <ErrorBox error={error} />
      <footer>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save entry"}
        </Button>
      </footer>
    </form>
  );
}
function EntryEditor({ id, onPending, onSaved }) {
  const { user } = useAuth();
  const q = useQuery({
    queryKey: ["document", user.id, user.role, id],
    queryFn: ({ signal }) => api("/documents/" + id, { signal }),
    enabled: !!id,
  });
  if (id && q.isPending) return <Loader />;
  if (id && q.error)
    return (
      <>
        <ErrorBox error={q.error} />
        <Button variant="secondary" onClick={() => q.refetch()}>
          Retry loading
        </Button>
      </>
    );
  return (
    <EntryForm
      key={id || "new"}
      entry={id ? q.data : undefined}
      onPending={onPending}
      onSaved={onSaved}
    />
  );
}
export default function Documentation() {
  const { user } = useAuth(),
    admin = user.role === "admin",
    { id } = useParams();
  const navigate = useNavigate(),
    qc = useQueryClient(),
    toast = useToast();
  const [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [page, setPage] = useState(1);
  const [unlinkedKyc, setUnlinkedKyc] = useState(false);
  const [dialog, setDialog] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [downloading, setDownloading] = useState(null),
    [downloadError, setDownloadError] = useState("");
  const pending = useRef(false);
  const debouncedSearch = useDebouncedValue(search);
  const params = new URLSearchParams({
    page,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
    ...(category ? { category } : {}),
    ...(admin && unlinkedKyc ? { unlinked_kyc: "true" } : {}),
  });
  const list = useQuery({
    queryKey: ["documents", user.id, user.role, params.toString()],
    queryFn: ({ signal }) => api("/documents?" + params, { signal }),
    enabled: !id,
  });
  const entry = useQuery({
    queryKey: ["document", user.id, user.role, id],
    queryFn: ({ signal }) => api("/documents/" + id, { signal }),
    enabled: !!id,
  });
  function changePending(value) {
    pending.current = value;
    setBusy(value);
  }
  function open(mode, item) {
    setError("");
    setDialog({ mode, entry: item });
  }
  function close() {
    if (!pending.current) {
      setDialog(null);
      setError("");
    }
  }
  function invalidate() {
    qc.invalidateQueries({ queryKey: ["documents"] });
    qc.invalidateQueries({ queryKey: ["document"] });
  }
  async function remove() {
    if (pending.current) return;
    changePending(true);
    setError("");
    const file = dialog.mode === "delete-file";
    try {
      await api(
        "/documents/" +
          dialog.entry.id +
          (file ? "/files/" + dialog.file.id : ""),
        { method: "DELETE" },
      );
      invalidate();
      setDialog(null);
      toast(file ? "Attachment deleted" : "Entry deleted");
      if (id && !file) navigate("/documents");
    } catch (error) {
      setError(error.message);
    } finally {
      changePending(false);
    }
  }
  const actions = (item) =>
    admin && (
      <div className="actions">
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => open("edit", item)}
        >
          Edit
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => open("delete", item)}
        >
          Delete
        </Button>
      </div>
    );
  return (
    <>
      {id && (
        <Link className="back-link" to="/documents">
          ← Documentation & policies
        </Link>
      )}
      <div className="page-heading knowledge-page-heading">
        <div>
          <span className="eyebrow">ONE PLACE FOR TEAM KNOWLEDGE</span>
          <h1>
            {id
              ? (!entry.error && entry.data?.title) ||
                "Documentation & policies"
              : "Documentation & policies"}
          </h1>
          <p>
            {id
              ? "Read the latest shared guidance and attached documents."
              : "Company policies, guides and documentation for the whole team."}
          </p>
        </div>
        {admin && !id && (
          <Button onClick={() => open("create")}>+ Add entry</Button>
        )}
        {id && entry.data && !entry.error && actions(entry.data)}
      </div>
      {id ? (
        <>
          <ErrorBox error={entry.error} />
          {entry.isPending ? (
            <Loader />
          ) : (
            entry.data &&
            !entry.error && (
              <article className="panel knowledge-reader">
                <div className="knowledge-meta">
                  <span className="knowledge-type">
                    {typeLabel(entry.data.category)}
                  </span>
                  <small>Updated {date(entry.data.updated_at)}</small>
                </div>
                {!!entry.data.property_name && (
                  <p className="knowledge-property">
                    <Building2 size={17} aria-hidden="true" />
                    {entry.data.property_name}
                  </p>
                )}
                {entry.data.category === "client_kyc" && (
                  <p className="knowledge-client">
                    <b>Client:</b>{" "}
                    {entry.data.lead_name ||
                      "Not linked to a client — admin only"}
                  </p>
                )}
                {!!entry.data.keywords && (
                  <p className="knowledge-keywords">
                    <b>Keywords:</b> {entry.data.keywords}
                  </p>
                )}
                <div className="knowledge-content">{entry.data.content}</div>
                {!!entry.data.files?.length && (
                  <section className="knowledge-attachments">
                    <h2>Attachments</h2>
                    <ErrorBox error={downloadError} />
                    <ul className="knowledge-file-list">
                      {entry.data.files.map((file) => (
                        <li key={file.id}>
                          <span>
                            <b>{file.file_name}</b>
                            <small>{fileSize(file.size_bytes)}</small>
                          </span>
                          <div className="actions">
                            <Button
                              variant="secondary"
                              disabled={!!downloading}
                              aria-label={`Download ${file.file_name}`}
                              onClick={async () => {
                                setDownloading(file.id);
                                setDownloadError("");
                                try {
                                  download(
                                    await api(
                                      `/documents/${id}/files/${file.id}/download`,
                                      { download: true },
                                    ),
                                    file.file_name,
                                  );
                                } catch (error) {
                                  setDownloadError(error.message);
                                } finally {
                                  setDownloading(null);
                                }
                              }}
                            >
                              <Download size={16} aria-hidden="true" />
                              {downloading === file.id
                                ? "Downloading…"
                                : "Download"}
                            </Button>
                            {admin && (
                              <Button
                                variant="danger"
                                disabled={busy || !!downloading}
                                aria-label={`Delete ${file.file_name}`}
                                onClick={() => {
                                  setError("");
                                  setDialog({
                                    mode: "delete-file",
                                    entry: entry.data,
                                    file,
                                  });
                                }}
                              >
                                Delete file
                              </Button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}
              </article>
            )
          )}
        </>
      ) : (
        <section className="panel">
          <div className="knowledge-toolbar">
            <div className="knowledge-search">
              <Search size={18} aria-hidden="true" />
              <input
                aria-label="Search documentation and policies"
                type="search"
                placeholder="Search documents by title, property name, or keywords…"
                maxLength={100}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>
            <div
              className="knowledge-filters"
              role="group"
              aria-label="Filter document category"
            >
              {[{ value: "", label: "All" }, ...documentCategories].map(
                (item) => (
                  <button
                    key={item.value}
                    type="button"
                    aria-pressed={category === item.value}
                    onClick={() => {
                      setCategory(item.value);
                      if (item.value !== "client_kyc") setUnlinkedKyc(false);
                      setPage(1);
                    }}
                  >
                    {item.label}
                  </button>
                ),
              )}
            </div>
          </div>
          {admin && (
            <label className="kyc-unlinked-filter">
              <input
                type="checkbox"
                checked={unlinkedKyc}
                onChange={(e) => {
                  setUnlinkedKyc(e.target.checked);
                  setPage(1);
                  if (e.target.checked) setCategory("client_kyc");
                }}
              />
              KYC not linked to a client
            </label>
          )}
          <ErrorBox error={list.error} />
          {list.isPending ? (
            <Loader />
          ) : (
            !list.error &&
            (list.data?.data?.length ? (
              <div className="knowledge-grid fx-stagger">
                {list.data.data.map((item) => (
                  <article className="knowledge-card fx-card" key={item.id}>
                    <div className="knowledge-meta">
                      {item.category === "policy" ? (
                        <FileText size={20} aria-hidden="true" />
                      ) : (
                        <BookOpen size={20} aria-hidden="true" />
                      )}
                      <span className="knowledge-type">
                        {typeLabel(item.category)}
                      </span>
                    </div>
                    <h2>
                      <Link to={"/documents/" + item.id}>{item.title}</Link>
                    </h2>
                    {!!item.property_name && (
                      <p className="knowledge-property">
                        <Building2 size={16} aria-hidden="true" />
                        {item.property_name}
                      </p>
                    )}
                    {item.category === "client_kyc" && (
                      <p className="knowledge-client">
                        <b>Client:</b>{" "}
                        {item.lead_name || "Not linked — admin only"}
                      </p>
                    )}
                    <small>Updated {date(item.updated_at)}</small>
                    <div className="knowledge-card-actions">
                      <Link
                        className="button secondary"
                        to={"/documents/" + item.id}
                      >
                        Read entry
                      </Link>
                      {actions(item)}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty">
                {admin
                  ? "No entries found. Add documentation or a policy to share with your team."
                  : "No entries found. Your administrator can add shared documentation and policies here."}
              </div>
            ))
          )}
          {!list.error && (
            <Pagination page={page} count={list.data?.count} onPage={setPage} />
          )}
        </section>
      )}
      {dialog && admin && (
        <Modal
          title={
            dialog.mode === "delete-file"
              ? "Delete attachment?"
              : dialog.mode === "delete"
                ? "Delete entry?"
                : dialog.mode === "edit"
                  ? "Edit entry"
                  : "Add documentation or policy"
          }
          onClose={close}
        >
          {dialog.mode.startsWith("delete") ? (
            <>
              <p>
                Delete <b>{dialog.file?.file_name || dialog.entry.title}</b>?
                This removes it for the whole team.
              </p>
              <ErrorBox error={error} />
              <div className="actions">
                <Button variant="secondary" disabled={busy} onClick={close}>
                  Cancel
                </Button>
                <Button variant="danger" disabled={busy} onClick={remove}>
                  {busy ? "Deleting…" : "Delete permanently"}
                </Button>
              </div>
            </>
          ) : (
            <EntryEditor
              id={dialog.entry?.id}
              onPending={changePending}
              onSaved={() => {
                invalidate();
                setPage(1);
                setDialog(null);
                toast("Entry saved");
              }}
            />
          )}
        </Modal>
      )}
    </>
  );
}
