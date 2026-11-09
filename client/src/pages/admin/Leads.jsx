import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import {
  Button,
  Modal,
  Table,
  ErrorBox,
  useToast,
} from "../../components/common/UI";
import LeadForm from "../../components/leads/LeadForm";
import ImportedFiles from "../../components/leads/ImportedFiles";
import AgentLeadList from "../../components/leads/AgentLeadList";
import AdminLeadList from "../../components/leads/AdminLeadList";
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
  // Agents: their assigned files, then Assigned leads (update 052).
  if (user.role === "agent")
    return importId || params.get("view") === "all" ? (
      <AgentLeadList key={importId || "all"} importId={importId} />
    ) : (
      <ImportedFiles />
    );
  // Administrators (agents and staff never reach this page otherwise):
  // All leads, with import and Add lead (update 057).
  return <AdminLeads importId={importId} />;
}
function AdminLeads({ importId }) {
  const [modal, setModal] = useState(false),
    [importResult, setImportResult] = useState(null),
    [importMapping, setImportMapping] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const qc = useQueryClient(),
    toast = useToast();
  const importInput = useRef(null);
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
  return (
    <>
      {importId && (
        <Link className="back-link" to="/tasks">
          ← Task assign
        </Link>
      )}
      <div className="page-heading">
        <div>
          <span className="eyebrow">SALES</span>
          <h1>All leads</h1>
          <p>
            Every lead in the CRM. Search by name or phone number, filter, and
            assign leads to agents.
          </p>
        </div>
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
      </div>
      <p id="lead-import-help" className="import-help">
        CSV, XLSX or XLS · Maximum 5 MB and 1,000 leads. Excel uses the first
        worksheet with name and phone headers in row 1. Format phone cells as
        Text to preserve leading zeros and country codes. Common headings like
        Full Name and Mobile Number work too; other columns can be matched or
        skipped.
      </p>
      <ErrorBox error={!importMapping && error} />
      <AdminLeadList />
      {modal && (
        <Modal title="Add a lead" onClose={() => setModal(false)}>
          <LeadForm
            onSave={async (data) => {
              await api("/leads", { method: "POST", body: data });
              invalidateWorkspace(qc);
              toast("Lead created");
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
