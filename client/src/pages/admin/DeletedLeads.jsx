import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { formatLeadNo } from "../../lib/formatLeadNo";
import { useLeadSelection } from "../../lib/useLeadSelection";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import {
  Button,
  Table,
  Pagination,
  Loader,
  ErrorBox,
  useToast,
} from "../../components/common/UI";
export default function DeletedLeads() {
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const selection = useLeadSelection(search),
    qc = useQueryClient(),
    toast = useToast(),
    debounced = useDebouncedValue(search);
  const rows = useQuery({
    queryKey: ["deleted-leads", page, debounced],
    queryFn: ({ signal }) =>
      api(
        "/leads/deleted?" + new URLSearchParams({ page, search: debounced }),
        { signal },
      ),
  });
  const files = useQuery({
    queryKey: ["deleted-lead-imports"],
    queryFn: ({ signal }) => api("/deleted-lead-imports", { signal }),
  });
  async function restore(ids, file) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        file ? `/lead-imports/${file.id}/restore` : "/leads/restore",
        { method: "POST", body: file ? {} : { lead_ids: ids } },
      );
      selection.clear();
      invalidateWorkspace(qc);
      toast(
        `${result.restored} restored${result.failed ? `, ${result.failed} unavailable` : ""}`,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">RECOVER CUSTOMER WORK</span>
          <h1>Deleted leads</h1>
          <p>
            Restore within 30 days. Leads keep their HD number and return
            unassigned. Erasure runs automatically after retention.
          </p>
        </div>
      </div>
      <ErrorBox error={error} />
      <section className="panel">
        <div className="toolbar">
          <input
            aria-label="Search deleted leads"
            placeholder="Search name or HD number…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <ErrorBox error={rows.error} />
        {selection.ids.length > 0 && (
          <div className="bulk-action-bar">
            <b>{selection.ids.length} selected</b>
            <Button disabled={busy} onClick={() => restore(selection.ids)}>
              Restore selected
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={selection.clear}
            >
              Clear selection
            </Button>
          </div>
        )}
        {rows.isPending ? (
          <Loader />
        ) : (
          <Table
            showSerial
            page={page}
            count={rows.data?.count}
            rows={rows.data?.data || []}
            selection={selection}
            columns={[
              {
                key: "lead_no",
                label: "Lead number",
                render: (r) => formatLeadNo(r.lead_no),
              },
              { key: "name", label: "Customer" },
              { key: "deleted_by_name", label: "Deleted by" },
              {
                key: "deleted_at",
                label: "Deleted",
                render: (r) => date(r.deleted_at),
              },
              { key: "delete_reason", label: "Reason" },
              { key: "days_left", label: "Days left" },
              {
                key: "restore",
                label: "Action",
                render: (r) => (
                  <Button
                    variant="secondary"
                    disabled={busy || !r.days_left}
                    onClick={() => restore([r.id])}
                  >
                    Restore
                  </Button>
                ),
              },
            ]}
          />
        )}
        <Pagination page={page} count={rows.data?.count} onPage={setPage} />
      </section>
      <section className="panel">
        <h2>Deleted files with leads</h2>
        <ErrorBox error={files.error} />
        {files.data?.length ? (
          files.data.map((file) => (
            <div className="list-row" key={file.id}>
              <div>
                <b>{file.file_name}</b>
                <small>
                  {date(file.deleted_at)} · {file.delete_reason}
                </small>
              </div>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => restore(null, file)}
              >
                Restore file and leads
              </Button>
            </div>
          ))
        ) : (
          <p>No recoverable deleted files.</p>
        )}
      </section>
    </>
  );
}
