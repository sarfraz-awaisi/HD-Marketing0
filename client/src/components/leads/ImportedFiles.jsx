import DeleteLeadsDialog from "./DeleteLeadsDialog";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileSpreadsheet } from "lucide-react";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import {
  Button,
  Modal,
  Table,
  Pagination,
  Loader,
  ErrorBox,
  useToast,
} from "../common/UI";
const format = (file) =>
  file.file_format === "legacy"
    ? "CSV / Excel"
    : file.file_format.toUpperCase();
export default function ImportedFiles({ assignable = false }) {
  const { user } = useAuth();
  const admin = assignable && user.role === "admin";
  const [page, setPage] = useState(1),
    [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null),
    [agent, setAgent] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [deleteFile, setDeleteFile] = useState(null);
  const qc = useQueryClient(),
    toast = useToast();
  const debouncedSearch = useDebouncedValue(search);
  const params = new URLSearchParams({
    page,
    ...(debouncedSearch ? { search: debouncedSearch } : {}),
  });
  const files = useQuery({
    queryKey: ["lead-imports", user.id, user.role, params.toString()],
    queryFn: ({ signal }) => api("/lead-imports?" + params, { signal }),
  });
  const users = useQuery({
    queryKey: ["users", user.id],
    queryFn: ({ signal }) => api("/users", { signal }),
    enabled: admin,
  });
  const close = () => {
    if (!busy) {
      setSelected(null);
      setError("");
      setAgent("");
    }
  };
  async function assignFile(event) {
    event.preventDefault();
    if (busy || !agent) return;
    setBusy(true);
    setError("");
    try {
      await api(`/lead-imports/${selected.id}/assign`, {
        method: "POST",
        body: { agent_id: agent },
      });
      invalidateWorkspace(qc);
      toast("File assigned");
      setSelected(null);
      setAgent("");
    } catch (error) {
      setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading file-page-heading">
        <div>
          <span className="eyebrow">LEADS ORGANIZED BY FILE</span>
          <h1>{admin ? "Task assign" : "My leads"}</h1>
          <p>
            {admin
              ? "Assign an imported CSV or Excel file and its leads to an agent."
              : "Open an assigned file to work through its customer leads."}
          </p>
        </div>
        <Link
          className="button secondary"
          to={admin ? "/leads" : "/leads?view=all"}
        >
          {admin ? "Import CSV / Excel" : "All my leads"}
        </Link>
      </div>
      <section className="panel">
        <div className="toolbar">
          <input
            aria-label="Search imported files"
            placeholder="Search files…"
            maxLength={100}
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <ErrorBox error={files.error} />
        {files.isPending ? (
          <Loader />
        ) : files.error ? null : !files.data?.data?.length ? (
          <div className="empty">
            {admin
              ? "No imported files yet. Import a CSV or Excel file from Leads."
              : "No files assigned yet. Your admin can assign a file, or open All my leads for individual assignments."}
          </div>
        ) : admin ? (
          <Table
            rows={files.data.data}
            columns={[
              {
                key: "file_name",
                label: "File",
                render: (file) => (
                  <div>
                    <Link
                      className="customer-link"
                      to={`/leads?import_id=${file.id}`}
                    >
                      <b>{file.file_name}</b>
                    </Link>
                    {file.legacy && (
                      <small className="file-note">
                        Original filename unavailable
                      </small>
                    )}
                  </div>
                ),
              },
              { key: "file_format", label: "Format", render: format },
              {
                key: "lead_count",
                label: "Leads",
                render: (file) => (
                  <div>
                    {file.lead_count}
                    <small className="file-note">
                      {file.assigned_count ?? 0} assigned ·{" "}
                      {file.unassigned_count ?? 0} unassigned
                    </small>
                    {file.rejected_count > 0 && (
                      <small className="file-note">
                        {file.rejected_count} rejected
                      </small>
                    )}
                  </div>
                ),
              },
              {
                key: "assigned_name",
                label: "Assigned agent",
                render: (file) =>
                  file.assigned_name ||
                  (file.mixed_assignment
                    ? "Individual assignments"
                    : "Unassigned"),
              },
              {
                key: "created_at",
                label: "Imported",
                render: (file) => date(file.created_at),
              },
              {
                key: "assign",
                label: "Action",
                render: (file) => (
                  <div className="lead-row-actions">
                    <Button
                      variant="secondary"
                      disabled={!file.lead_count}
                      onClick={() => {
                        setSelected(file);
                        setAgent(file.assigned_agent || "");
                        setError("");
                      }}
                    >
                      Assign file
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => setDeleteFile(file)}
                    >
                      Delete file
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        ) : (
          <div className="import-file-grid fx-stagger">
            {files.data.data.map((file) => (
              <Link
                key={file.id}
                className="import-file-card fx-card"
                to={`/leads?import_id=${file.id}`}
              >
                <div className="import-file-heading">
                  <FileSpreadsheet size={24} aria-hidden="true" />
                  <b>{file.file_name}</b>
                </div>
                <span>
                  {format(file)} · {file.lead_count}{" "}
                  {file.lead_count === 1 ? "lead" : "leads"}
                </span>
                <small>{date(file.created_at)}</small>
                {file.legacy && <small>Original filename unavailable</small>}
                <span className="import-file-open">Open leads →</span>
              </Link>
            ))}
          </div>
        )}
        <Pagination page={page} count={files.data?.count} onPage={setPage} />
      </section>
      {deleteFile && (
        <DeleteLeadsDialog
          file={deleteFile}
          onClose={() => setDeleteFile(null)}
          onDeleted={(result) => {
            setDeleteFile(null);
            invalidateWorkspace(qc);
            toast(
              `File deleted · ${result.deleted} leads deleted, ${result.failed} kept`,
            );
          }}
        />
      )}
      {selected && (
        <Modal title="Assign file" onClose={close}>
          <p>
            <b>{selected.file_name}</b>
          </p>
          <p>
            All {selected.lead_count} leads in this file will be assigned to the
            selected agent, including leads currently assigned to someone else.
          </p>
          <ErrorBox error={error || users.error} />
          <form onSubmit={assignFile}>
            <label>
              Agent
              <select
                aria-label="Agent"
                required
                disabled={busy || users.isPending || !!users.error}
                value={agent}
                onChange={(event) => setAgent(event.target.value)}
              >
                <option value="">Choose an active agent</option>
                {(users.data || [])
                  .filter((member) => member.role === "agent" && member.active)
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
              </select>
            </label>
            <div className="actions">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={close}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy || !agent || !!users.error}>
                {busy ? "Assigning…" : "Assign file"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
