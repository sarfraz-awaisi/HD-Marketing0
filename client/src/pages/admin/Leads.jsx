import DeleteLeadsDialog from "../../components/leads/DeleteLeadsDialog";
import { useLeadSelection } from "../../lib/useLeadSelection";
import { formatLeadNo } from "../../lib/formatLeadNo";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import {
  Button,
  Modal,
  Table,
  Pagination,
  Loader,
  ErrorBox,
  Badge,
  useToast,
} from "../../components/common/UI";
import LeadForm from "../../components/leads/LeadForm";
import ImportedFiles from "../../components/leads/ImportedFiles";
import LeadPhone from "../../components/leads/LeadPhone";
import CallDialog from "../../components/calls/CallDialog";
import {
  statuses,
  statusLabel,
  lostReasons,
  lostReasonLabel,
} from "../../lib/pipeline";
import { firstCallState } from "../../lib/firstCall";
const importFields = [
  ["name", "Customer name (required)"],
  ["phone", "Phone number (required)"],
  ["email", "Email"],
  ["budget_min", "Minimum budget"],
  ["budget_max", "Maximum budget"],
  ["preferred_location", "Preferred location"],
  ["property_id", "Property ID"],
  ["assigned_agent", "Agent (name or ID)"],
  ["source", "Source (saved as CSV / Excel)"],
];
export default function Leads() {
  const { user } = useAuth();
  const [params] = useSearchParams();
  const importId = params.get("import_id");
  if (user.role === "agent" && !importId && params.get("view") !== "all")
    return <ImportedFiles />;
  return (
    <LeadList
      key={importId || "all"}
      importId={importId}
      initialCall={params.get("call")}
    />
  );
}
function LeadList({ importId, initialCall }) {
  const { user } = useAuth(),
    admin = user.role === "admin";
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [status, setStatus] = useState(""),
    [source, setSource] = useState(""),
    [lostReason, setLostReason] = useState(""),
    [call, setCall] = useState(
      ["uncalled", "missed"].includes(initialCall) ? initialCall : "",
    ),
    [modal, setModal] = useState(false),
    [importResult, setImportResult] = useState(null),
    [importMapping, setImportMapping] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [targetAgent, setTargetAgent] = useState(""),
    [deleteIds, setDeleteIds] = useState(null),
    [dialLead, setDialLead] = useState(null);
  const qc = useQueryClient(),
    toast = useToast();
  const importInput = useRef(null),
    assignmentPending = useRef(false);
  const importFieldOwners = new Map();
  for (const column of importMapping?.columns || []) {
    const field = importMapping.selections[column.index];
    if (field && !importFieldOwners.has(field))
      importFieldOwners.set(field, column);
  }
  async function importLeads(event) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file || busy) return;
    setError("");
    if (!/\.(csv|xlsx|xls)$/i.test(file.name)) {
      setError("Choose a .csv, .xlsx or .xls file.");
      input.value = "";
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError("Choose a file smaller than or equal to 5 MB.");
      input.value = "";
      return;
    }
    try {
      await submitImport(file);
    } finally {
      input.value = "";
    }
  }
  async function submitImport(file, mapping) {
    setBusy(true);
    setError("");
    try {
      const data = new FormData();
      data.append("file", file);
      if (mapping) data.append("mapping", JSON.stringify(mapping));
      setImportResult(
        await api("/leads/import", { method: "POST", body: data }),
      );
      setImportMapping(null);
      setPage(1);
      invalidateWorkspace(qc);
    } catch (error) {
      if (
        error.code === "IMPORT_COLUMNS_REQUIRED" &&
        Array.isArray(error.columns)
      ) {
        const counts = error.columns.reduce((result, { suggested }) => {
          if (suggested) result[suggested] = (result[suggested] || 0) + 1;
          return result;
        }, {});
        setImportMapping({
          file,
          columns: error.columns,
          selections: Object.fromEntries(
            error.columns.map(({ index, suggested }) => [
              index,
              counts[suggested] === 1 ? suggested : "",
            ]),
          ),
        });
      } else setError(error.message);
    } finally {
      setBusy(false);
    }
  }
  function closeMapping() {
    if (busy) return;
    setImportMapping(null);
    setError("");
  }
  function matchImportColumn(column, field) {
    if (busy) return;
    const owner = importFieldOwners.get(field);
    if (owner && owner.index !== column.index) {
      const label = importFields.find(([value]) => value === field)[1];
      setError(
        `${label} is already matched to column ${owner.index + 1}: ${owner.label}. Set that column to Skip column before using it here.`,
      );
      return;
    }
    setError("");
    setImportMapping((current) => ({
      ...current,
      selections: { ...current.selections, [column.index]: field },
    }));
  }
  async function importMatchedColumns(event) {
    event.preventDefault();
    if (busy) return;
    const selected = Object.entries(importMapping.selections).filter(
      ([, field]) => field,
    );
    const fields = selected.map(([, field]) => field);
    if (!fields.includes("name") || !fields.includes("phone")) {
      setError("Match customer name and phone number before importing.");
      return;
    }
    const duplicate = selected.find(
      ([index, field]) => importFieldOwners.get(field).index !== Number(index),
    );
    if (duplicate) {
      const [index, field] = duplicate;
      const owner = importFieldOwners.get(field);
      const label = importFields.find(([value]) => value === field)[1];
      setError(
        `${label} is matched to columns ${owner.index + 1} and ${Number(index) + 1}. Keep one match and set the other to Skip column.`,
      );
      return;
    }
    await submitImport(
      importMapping.file,
      Object.fromEntries(
        selected.map(([index, field]) => [field, Number(index)]),
      ),
    );
  }
  const debouncedSearch = useDebouncedValue(search);
  const selection = useLeadSelection(
    JSON.stringify([
      user.id,
      user.role,
      search,
      status,
      lostReason,
      source,
      importId,
      call,
    ]),
  );
  const params = new URLSearchParams({
    page,
    search: debouncedSearch,
    ...(importId ? { import_id: importId } : {}),
    ...(status ? { status } : {}),
    ...(source ? { source } : {}),
    ...(lostReason ? { lost_reason: lostReason } : {}),
    // Leads waiting longest for a first call come first.
    ...(call ? { call, sort: "call_due_at", direction: "asc" } : {}),
  });
  const q = useQuery({
    queryKey: ["leads", user.id, user.role, params.toString()],
    queryFn: ({ signal }) => api("/leads?" + params, { signal }),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
    enabled: admin,
  });
  async function assignSelected(
    mode,
    ids = selection.ids,
    agent = targetAgent,
  ) {
    if (assignmentPending.current || !ids.length) return;
    assignmentPending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api("/leads/assign-bulk", {
        method: "POST",
        body: {
          lead_ids: ids,
          mode,
          ...(mode === "agent" ? { agent_id: agent } : {}),
        },
      });
      toast(
        `${result.assigned} assigned, ${result.skipped} skipped, ${result.failed} failed`,
      );
      selection.clear();
      invalidateWorkspace(qc);
    } catch (e) {
      setError(e.message);
    } finally {
      assignmentPending.current = false;
      setBusy(false);
    }
  }
  const file = useQuery({
    queryKey: ["lead-import", user.id, user.role, importId],
    queryFn: ({ signal }) => api("/lead-imports/" + importId, { signal }),
    enabled: !!importId,
  });
  return (
    <>
      {(importId || !admin) && (
        <Link className="back-link" to={admin ? "/tasks" : "/leads"}>
          ← {admin ? "Task assign" : "Assigned files"}
        </Link>
      )}
      <div className="page-heading">
        <div>
          <span className="eyebrow">RELATIONSHIPS THAT MOVE BUSINESS</span>
          <h1>{admin ? "Leads" : "My leads"}</h1>
          <p>
            {importId
              ? `File: ${file.data?.file_name || "Loading file…"}`
              : "Every conversation starts here. Find the right next step."}
          </p>
        </div>
        {admin && (
          <div className="actions">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => importInput.current.click()}
            >
              {busy ? "Importing…" : "Import CSV / Excel"}
            </Button>
            <input
              ref={importInput}
              aria-label="Import CSV or Excel leads"
              aria-describedby="lead-import-help"
              type="file"
              accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
              hidden
              disabled={busy}
              onChange={importLeads}
            />
            <Button onClick={() => setModal(true)}>+ Add lead</Button>
          </div>
        )}
      </div>
      {admin && (
        <p id="lead-import-help" className="import-help">
          CSV, XLSX or XLS · Maximum 5 MB and 1,000 leads. Excel uses the first
          worksheet with name and phone headers in row 1. Format phone cells as
          Text to preserve leading zeros and country codes. Common headings like
          Full Name and Mobile Number work too; other columns can be matched or
          skipped.
        </p>
      )}
      <ErrorBox error={!importMapping && error} />
      <ErrorBox error={file.error} />
      <section className="panel">
        <div className="toolbar">
          <input
            aria-label="Search leads"
            placeholder="Search by customer name or HD number…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(e) => {
              setStatus(e.target.value);
              if (e.target.value !== "lost") setLostReason("");
              setPage(1);
            }}
          >
            <option value="">All statuses</option>
            {statuses.map((s) => (
              <option key={s} value={s}>
                {statusLabel(s)}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by lost reason"
            value={lostReason}
            onChange={(event) => {
              setLostReason(event.target.value);
              setStatus(event.target.value ? "lost" : "");
              setPage(1);
            }}
          >
            <option value="">All lost reasons</option>
            {lostReasons.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value);
              setPage(1);
            }}
          >
            <option value="">All sources</option>
            {["manual", "CSV", "Meta", "WhatsApp", "other"].map((s) => (
              <option key={s} value={s}>
                {s === "CSV" ? "CSV / Excel" : s}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by first call"
            value={call}
            onChange={(e) => {
              setCall(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Any first-call state</option>
            <option value="uncalled">Waiting for first call</option>
            <option value="missed">Missed first call</option>
          </select>
        </div>
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : q.error ? null : (
          <>
            <>
              {admin && (
                <div className="lead-selection-tools">
                  {q.data?.count > 500 ? (
                    <span>
                      Narrow your filter to select all matching leads (maximum
                      500).
                    </span>
                  ) : (
                    q.data?.count > 0 && (
                      <Button
                        variant="secondary"
                        disabled={search !== debouncedSearch}
                        onClick={async () => {
                          try {
                            const result = await api(
                              "/leads/selection?" + params,
                            );
                            selection.replace(result.ids);
                          } catch (e) {
                            setError(e.message);
                          }
                        }}
                      >
                        Select all {q.data.count} matching leads
                      </Button>
                    )
                  )}
                  {selection.ids.length > 0 && (
                    <div
                      className="bulk-action-bar"
                      role="toolbar"
                      aria-label="Selected lead actions"
                    >
                      <b>{selection.ids.length} selected</b>
                      <select
                        aria-label="Bulk receiving agent"
                        disabled={busy}
                        value={targetAgent}
                        onChange={(e) => setTargetAgent(e.target.value)}
                      >
                        <option value="">Choose an active agent</option>
                        {(users.data || [])
                          .filter((a) => a.active && a.role === "agent")
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                      </select>
                      <Button
                        disabled={busy || !targetAgent}
                        onClick={() => assignSelected("agent")}
                      >
                        Assign to agent
                      </Button>
                      <Button
                        disabled={busy}
                        variant="secondary"
                        onClick={() => assignSelected("round_robin")}
                      >
                        Round-robin
                      </Button>
                      <Button
                        disabled={busy}
                        variant="secondary"
                        onClick={() => assignSelected("unassign")}
                      >
                        Unassign
                      </Button>
                      <Button
                        variant="danger"
                        disabled={busy}
                        onClick={() => setDeleteIds(selection.ids)}
                      >
                        Delete
                      </Button>
                      <Button
                        disabled={busy}
                        variant="secondary"
                        onClick={selection.clear}
                      >
                        Clear selection
                      </Button>
                    </div>
                  )}
                </div>
              )}
              <Table
                showSerial
                page={page}
                count={q.data?.count}
                selection={admin ? selection : undefined}
                rows={q.data?.data || []}
                columns={[
                  {
                    key: "lead_no",
                    label: "Lead number",
                    render: (row) => formatLeadNo(row.lead_no),
                  },
                  ...(admin
                    ? [
                        {
                          key: "assigned_agent",
                          label: "Assigned agent",
                          render: (row) => (
                            <label className="quick-assign">
                              <span>
                                {(users.data || []).find(
                                  (a) => a.id === row.assigned_agent,
                                )?.name || "Unassigned"}
                              </span>
                              <select
                                aria-label={`Assign ${row.name}`}
                                disabled={busy}
                                value={row.assigned_agent || ""}
                                onChange={(e) =>
                                  assignSelected(
                                    e.target.value ? "agent" : "unassign",
                                    [row.id],
                                    e.target.value,
                                  )
                                }
                              >
                                <option value="">Unassigned</option>
                                {(users.data || [])
                                  .filter((a) => a.active && a.role === "agent")
                                  .map((a) => (
                                    <option key={a.id} value={a.id}>
                                      {a.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                          ),
                        },
                      ]
                    : []),
                  {
                    key: "name",
                    label: "Customer",
                    render: (r) => (
                      <Link className="customer-link" to={"/leads/" + r.id}>
                        <span className="avatar small">{r.name[0]}</span>
                        <div>
                          <b>{r.name}</b>
                          <small>{r.email || "No email"}</small>
                        </div>
                      </Link>
                    ),
                  },
                  {
                    key: "phone",
                    label: "Contact phone",
                    render: (lead) => (
                      <LeadPhone lead={lead} onCall={setDialLead} />
                    ),
                  },
                  {
                    key: "status",
                    label: "Status",
                    render: (r) => <Badge value={r.status} />,
                  },
                  {
                    key: "first_call",
                    label: "First call",
                    render: (r) => {
                      const state = firstCallState(r);
                      return state ? (
                        <span className={`badge plain ${state.tone}`}>
                          {state.label}
                        </span>
                      ) : (
                        "—"
                      );
                    },
                  },
                  {
                    key: "source",
                    label: "Source",
                    render: (r) =>
                      r.source === "CSV" ? "CSV / Excel" : r.source,
                  },
                  {
                    key: "lost_reason",
                    label: "Lost reason",
                    render: (row) => lostReasonLabel(row.lost_reason),
                  },
                  { key: "preferred_location", label: "Location" },
                  ...(admin
                    ? [
                        {
                          key: "edit",
                          label: "Actions",
                          render: (row) => (
                            <div className="lead-row-actions">
                              <Button
                                variant="secondary"
                                onClick={() => setModal(row)}
                              >
                                Edit
                              </Button>
                              <Button
                                variant="danger"
                                onClick={() => setDeleteIds([row.id])}
                              >
                                Delete
                              </Button>
                            </div>
                          ),
                        },
                      ]
                    : []),
                  {
                    key: "created_at",
                    label: "Added",
                    render: (r) => date(r.created_at),
                  },
                ]}
              />
            </>
            <Pagination page={page} count={q.data?.count} onPage={setPage} />
          </>
        )}
      </section>
      {dialLead && (
        <CallDialog
          lead={dialLead}
          role={user.role}
          onClose={() => setDialLead(null)}
          onSaved={() => {
            setDialLead(null);
            invalidateWorkspace(qc);
            toast("Call saved");
          }}
        />
      )}
      {deleteIds && (
        <DeleteLeadsDialog
          ids={deleteIds}
          onClose={() => setDeleteIds(null)}
          onDeleted={(result) => {
            setDeleteIds(null);
            selection.clear();
            invalidateWorkspace(qc);
            toast(`${result.deleted} deleted, ${result.failed} kept`);
          }}
        />
      )}
      {modal && (
        <Modal
          title={modal.id ? "Edit lead" : "Add a lead"}
          onClose={() => setModal(false)}
        >
          <LeadForm
            initial={modal.id ? modal : undefined}
            onSave={async (data) => {
              await api(modal.id ? "/leads/" + modal.id : "/leads", {
                method: modal.id ? "PATCH" : "POST",
                body: data,
              });
              invalidateWorkspace(qc);
              toast(modal.id ? "Lead updated" : "Lead created");
              setModal(false);
            }}
          />
        </Modal>
      )}
      {importMapping && (
        <Modal title="Match file columns" onClose={closeMapping}>
          <p>
            Match your file headings to CRM fields. Customer name and phone
            number are required. Columns set to Skip column will be omitted.
            Each CRM field can be used once. To move a match, set its current
            column to Skip column first.
          </p>
          <p className="import-help">
            Property ID needs an existing CRM ID. Agents can use an active team
            member’s exact name or ID. Unmatched or ambiguous agents leave leads
            unassigned and show a warning. Excel headers must be in row 1.
          </p>
          <ErrorBox error={error} />
          <form onSubmit={importMatchedColumns}>
            <div className="form-grid">
              {importMapping.columns.map((column) => (
                <label key={column.index}>
                  Column {column.index + 1}: {column.label}
                  <select
                    aria-label={`Match column ${column.index + 1}: ${column.label}`}
                    value={importMapping.selections[column.index] || ""}
                    disabled={busy}
                    onChange={(event) =>
                      matchImportColumn(column, event.target.value)
                    }
                  >
                    <option value="">Skip column</option>
                    {importFields.map(([field, label]) => {
                      const owner = importFieldOwners.get(field);
                      const usedElsewhere =
                        owner && owner.index !== column.index;
                      return (
                        <option
                          key={field}
                          value={field}
                          disabled={!!usedElsewhere}
                        >
                          {label}
                          {usedElsewhere
                            ? ` (matched to column ${owner.index + 1})`
                            : ""}
                        </option>
                      );
                    })}
                  </select>
                </label>
              ))}
            </div>
            <div className="actions">
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                onClick={closeMapping}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Importing…" : "Import leads"}
              </Button>
            </div>
          </form>
        </Modal>
      )}
      {importResult && (
        <Modal
          title="Lead import results"
          onClose={() => setImportResult(null)}
        >
          {importResult.file_name && <p>{importResult.file_name}</p>}
          {importResult.import_id && (
            <Link className="back-link" to="/tasks">
              Open Task assign →
            </Link>
          )}
          <p className="period-label">
            {importResult.format?.toUpperCase()}
            {importResult.worksheet
              ? ` · Worksheet: ${importResult.worksheet}`
              : ""}
          </p>
          <p>
            {importResult.rows.filter((r) => r.success).length} imported ·{" "}
            {importResult.rows.filter((r) => !r.success).length} rejected
          </p>
          {importResult.rows.some(
            (row) => row.success && row.warnings?.length,
          ) && (
            <p className="import-help">
              {
                importResult.rows.filter(
                  (row) => row.success && row.warnings?.length,
                ).length
              }{" "}
              imported with warnings. Review the row results and assign
              unassigned leads from Leads.
            </p>
          )}
          {importResult.ignored_columns?.length > 0 && (
            <p className="import-help">
              Skipped columns: {importResult.ignored_columns.join(", ")}
            </p>
          )}
          <div className="import-results">
            <Table
              rows={importResult.rows.map((r) => ({ ...r, id: r.row }))}
              columns={[
                { key: "row", label: "File row" },
                {
                  key: "success",
                  label: "Result",
                  render: (r) =>
                    r.success
                      ? ["Imported", ...(r.warnings || [])].join(" · ")
                      : r.error,
                },
              ]}
            />
          </div>
        </Modal>
      )}
    </>
  );
}
