import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { formatLeadNo } from "../../lib/formatLeadNo";
import { useLeadSelection } from "../../lib/useLeadSelection";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import EraseLeadsDialog from "../../components/leads/EraseLeadsDialog";
import {
  Button,
  Table,
  Pagination,
  Loader,
  ErrorBox,
  useToast,
} from "../../components/common/UI";
// Update 071: up to 2,000 deleted leads at once; restored 500 and erased 250
// at a time.
const MAX = 2000;
const plural = (n, one, many = one + "s") =>
  `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export default function DeletedLeads() {
  const [page, setPage] = useState(1),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    // Delete instantly (update 069): { ids } or { file }.
    [erasing, setErasing] = useState(null),
    // "all": the selection is every lead the search matched (update 071).
    [scope, setScope] = useState(null);
  const debounced = useDebouncedValue(search),
    // A changed search clears the selection at once.
    selection = useLeadSelection(search, MAX),
    qc = useQueryClient(),
    toast = useToast();
  const rows = useQuery({
    queryKey: ["deleted-leads", page, debounced],
    queryFn: ({ signal }) =>
      api(
        "/leads/deleted?" + new URLSearchParams({ page, search: debounced }),
        { signal },
      ),
  });
  const pageRows = rows.data?.data || [],
    count = rows.data?.count ?? 0,
    // The list shows the search typed (not still being typed).
    current = search === debounced && !rows.isFetching,
    everyMatching =
      scope?.search === search && scope.count === selection.ids.length;
  const clear = () => {
    selection.clear();
    setScope(null);
  };
  async function selectAll() {
    if (busy || !current) return;
    setBusy(true);
    setError("");
    try {
      const all = await api(
        "/leads/deleted/selection?" + new URLSearchParams({ search }),
      );
      if (all.count > MAX)
        throw new Error(
          `${plural(all.count, "deleted lead")} match. Narrow your search to ${MAX.toLocaleString("en-US")} or fewer to select them all.`,
        );
      selection.replace(all.ids);
      setScope({ search, count: all.ids.length });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const files = useQuery({
    queryKey: ["deleted-lead-imports"],
    queryFn: ({ signal }) => api("/deleted-lead-imports", { signal }),
  });
  async function restore(ids, file) {
    if (busy) return;
    setBusy(true);
    setError("");
    let restored = 0,
      failed = 0;
    try {
      if (file) {
        const result = await api(`/lead-imports/${file.id}/restore`, {
          method: "POST",
          body: {},
        });
        restored = result.restored;
        failed = result.failed;
      } else
        // 500 a request, one after another; an error stops the rest.
        for (let i = 0; i < ids.length; i += 500) {
          const result = await api("/leads/restore", {
            method: "POST",
            body: { lead_ids: ids.slice(i, i + 500) },
          });
          restored += result.restored;
          failed += result.failed;
        }
      toast(`${restored} restored${failed ? `, ${failed} unavailable` : ""}`);
    } catch (e) {
      setError(
        restored
          ? `${restored} restored, then: ${e.message} The rest are still in Deleted leads.`
          : e.message,
      );
    } finally {
      clear();
      invalidateWorkspace(qc);
      setBusy(false);
    }
  }
  // The dialog reports every number itself; the toast sums it up.
  function erased(result) {
    setErasing(null);
    clear();
    invalidateWorkspace(qc);
    if (result.erased || result.failed || result.left)
      toast(
        `${result.erased} permanently deleted${result.failed ? `, ${result.failed} kept (won deal or no longer here)` : ""}` +
          (result.left
            ? `, ${result.left} not deleted: check Deleted leads`
            : "") +
          // Update 071: files still in storage are said, never hidden.
          (result.files_waiting
            ? `. ${result.files_waiting}${result.files_more ? " or more" : ""} storage files still waiting to be removed`
            : result.files_unknown || result.files_removed === false
              ? ". Storage clean-up not confirmed"
              : ""),
      );
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">RECOVER CUSTOMER WORK</span>
          <h1>Deleted leads</h1>
          <p>
            Restore within 14 days. Leads keep their HD number and return
            unassigned. After 14 days they are erased automatically; Delete
            instantly erases the selected leads now.
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
              setScope(null);
              setPage(1);
            }}
          />
        </div>
        <ErrorBox error={rows.error} />
        {count > 0 && (
          <div className="lead-selection-tools">
            <Button
              variant="secondary"
              disabled={busy || !current}
              onClick={() => {
                selection.togglePage(pageRows, true);
                setScope(null);
              }}
            >
              Select this page ({pageRows.length})
            </Button>
            {count > MAX ? (
              <span className="lead-muted">
                Narrow your search to select all matching deleted leads (
                {MAX.toLocaleString("en-US")} at most).
              </span>
            ) : (
              <Button
                variant="secondary"
                disabled={busy || !current || everyMatching}
                onClick={selectAll}
              >
                Select all {plural(count, "matching deleted lead")}
              </Button>
            )}
          </div>
        )}
        {selection.ids.length > 0 && (
          <div
            className="bulk-action-bar"
            role="toolbar"
            aria-label="Selected deleted leads"
          >
            <b role="status">
              {everyMatching
                ? `All ${plural(selection.ids.length, "matching deleted lead")} selected${search.trim() ? ` (search “${search.trim()}”)` : ""}`
                : `${plural(selection.ids.length, "lead")} selected`}
            </b>
            <Button disabled={busy} onClick={() => restore(selection.ids)}>
              Restore selected
            </Button>
            <Button
              variant="danger"
              disabled={busy}
              onClick={() => setErasing({ ids: selection.ids })}
            >
              Delete instantly
            </Button>
            <Button variant="secondary" disabled={busy} onClick={clear}>
              Clear selection
            </Button>
          </div>
        )}
        {rows.isPending ? (
          <Loader variant="table" />
        ) : (
          <Table
            showSerial
            page={page}
            count={rows.data?.count}
            rows={pageRows}
            selection={{
              ...selection,
              // Changing one lead makes it a chosen set, not "all matching".
              toggle: (id, checked) => {
                setScope(null);
                selection.toggle(id, checked);
              },
              togglePage: (list, checked) => {
                setScope(null);
                selection.togglePage(list, checked);
              },
            }}
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
              <div className="actions">
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => restore(null, file)}
                >
                  Restore file and leads
                </Button>
                <Button
                  variant="danger"
                  disabled={busy}
                  onClick={() => setErasing({ file })}
                >
                  Delete instantly
                </Button>
              </div>
            </div>
          ))
        ) : (
          <p>No recoverable deleted files.</p>
        )}
      </section>
      {erasing && (
        <EraseLeadsDialog
          ids={erasing.ids}
          file={erasing.file}
          onClose={() => setErasing(null)}
          onErased={erased}
        />
      )}
    </>
  );
}
