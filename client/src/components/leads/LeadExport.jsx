import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, download } from "../../lib/api";
import { Button, ErrorBox, Modal } from "../common/UI";
import { usageOption } from "../../lib/leadUsage";
import "../../styles/lead-export.css";
import "../../styles/lead-usage.css";
// Administrators' lead export (updates 073 and 074): one Google Sheet or
// imported lead file at a time, or the leads with no file. The Excel file
// lists every lead of it that is assigned to an agent now, called or not,
// in exactly the Lead pipeline export's 37 columns, on one worksheet.
// Agent, temperature, status, the agent's last call, contacted and worked
// can narrow it; by default nothing does. The server and the database check
// everything again; the file holds full phone numbers and the export is
// recorded in Audit history.
const outcomes = [
  "No answer",
  "Busy",
  "Wrong number",
  "Number off",
  "Interested",
  "Not interested",
  "Follow-up required",
  "Site visit scheduled",
  "Deal discussion",
  "Closed lost",
];
const statuses = [
  ["new", "New"],
  ["contacted", "Contacted"],
  ["interested", "Interested"],
  ["visit_scheduled", "Site visit scheduled"],
  ["visit_done", "Visit done"],
  ["negotiation", "Negotiation"],
  ["won", "Won (booked)"],
  ["lost", "Lost"],
];
const fileTypes = {
  sheets: "Google Sheet",
  csv: "CSV file",
  xlsx: "Excel file",
  xls: "Excel file",
  legacy: "Earlier import",
};
const noFile = "none";
const n = (v) => Number(v ?? 0).toLocaleString("en-US");
const counted = (v, one, many = one + "s") =>
  `${n(v)} ${Number(v) === 1 ? one : many}`;
const pkDay = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(
    new Date(),
  );
// As the server names it: "General-Form-Leads-Assigned-2026-11-19.xlsx".
export const exportFileName = (name, day = pkDay()) => {
  const safe = String(name ?? "")
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .slice(0, 80)
    .replace(/^-+|-+$/g, "");
  return `${safe || "Leads"}-Assigned-${day}.xlsx`;
};
// Only the filters chosen: blanks out.
const cleaned = (f) =>
  Object.fromEntries(Object.entries(f).filter(([, v]) => v));

// file: the lead file All leads is showing, if any, chosen to start with.
// usage: All leads' Lead Usage choice (update 075), which the export does
// not use: the dialog says so, so a different set of leads is never
// exported unannounced.
export default function LeadExport({ file = "", usage = "" }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Export
      </Button>
      {open && (
        <ExportDialog
          initialFile={file}
          usage={usage}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function Select({ label, value, onChange, children, id }) {
  return (
    <label htmlFor={id}>
      {label}
      <select
        id={id}
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
    </label>
  );
}

function ExportDialog({ initialFile, usage, onClose }) {
  const [file, setFile] = useState(initialFile),
    [narrow, setNarrow] = useState({}),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState("");
  const set = (patch) => {
    setDone("");
    setNarrow((f) => ({ ...f, ...patch }));
  };
  const sources = useQuery({
    queryKey: ["lead-export", "sources"],
    queryFn: ({ signal }) => api("/leads/export/sources", { signal }),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const agents = (Array.isArray(users.data) ? users.data : []).filter(
    (u) => u.role === "agent",
  );
  const files = useMemo(
    () => (sources.data?.files ?? []).filter((f) => !f.file_deleted),
    [sources.data],
  );
  const chosen = files.find((f) => f.id === file);
  const noFileLeads = Object.values(sources.data?.no_file ?? {}).reduce(
    (a, b) => a + b,
    0,
  );
  // A file All leads was showing that is no longer listed is not chosen.
  const filters = useMemo(
    () =>
      file === noFile
        ? { no_file: true, ...cleaned(narrow) }
        : chosen
          ? { file: chosen.id, ...cleaned(narrow) }
          : null,
    [file, chosen, narrow],
  );
  // The counts follow the choices, a moment after the last change.
  const [asked, setAsked] = useState(filters);
  useEffect(() => {
    const t = setTimeout(() => setAsked(filters), 300);
    return () => clearTimeout(t);
  }, [filters]);
  const size = useQuery({
    queryKey: ["lead-export", "preview", asked],
    queryFn: ({ signal }) =>
      api("/leads/export/preview", {
        method: "POST",
        body: { filters: asked },
        signal,
      }),
    enabled: !!asked,
    // While a filter changes, the last counts stay; another file is counted
    // afresh.
    placeholderData: (previous, query) => {
      const before = query?.queryKey[2];
      return before &&
        before.file === asked?.file &&
        !!before.no_file === !!asked?.no_file
        ? previous
        : undefined;
    },
    retry: false,
  });
  // Files in the list's order (newest first); the one All leads was
  // showing first.
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    return files
      .filter(
        (f) =>
          !s ||
          f.name.toLowerCase().includes(s) ||
          (f.sheet?.spreadsheet_id ?? "").toLowerCase().includes(s),
      )
      .sort((a, b) => (b.id === initialFile) - (a.id === initialFile));
  }, [files, search, initialFile]);
  // Two files can share a name; the spreadsheet ID or date tells them apart.
  const sameName = (f) => files.filter((x) => x.name === f.name).length > 1;
  const current = asked && size.data && !size.error ? size.data : null;
  const count = current?.count;
  const tooBig = count != null && count > (current.max ?? Infinity);
  const ready =
    !busy &&
    !!filters &&
    filters === asked &&
    !size.isFetching &&
    count > 0 &&
    !tooBig;
  const name = file === noFile ? "No file" : chosen?.name;
  async function exportFile() {
    if (!ready) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const saved = exportFileName(name);
      download(
        await api("/leads/export", {
          method: "POST",
          body: { filters },
          download: true,
        }),
        saved,
      );
      setDone(`Downloaded ${counted(count, "lead")}: ${saved}`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Export leads"
      className="lead-export"
      onClose={() => !busy && onClose()}
    >
      <p className="lead-export-intro">
        Choose a Google Sheet or lead file. The Excel file lists every lead from
        it that is assigned to an agent now, called or not, with the same
        columns as the Lead pipeline export.
      </p>
      {usage && (
        <p className="lead-export-notice" role="note">
          All leads is showing {usageOption(usage)} only. The export does not
          use Lead Usage: it lists every assigned lead of the file you choose,
          whatever its usage, so it can include leads the list is not showing.
        </p>
      )}

      <fieldset className="lead-export-files">
        <legend>Lead file</legend>
        {files.length > 6 && (
          <input
            type="search"
            aria-label="Find a file"
            placeholder="Find a file or spreadsheet ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        )}
        <ErrorBox error={sources.error} />
        <ul className="lead-export-file-list">
          {shown.map((f) => (
            <li key={f.id}>
              <label>
                <input
                  type="radio"
                  name="lead-export-file"
                  checked={file === f.id}
                  onChange={() => {
                    setDone("");
                    setFile(f.id);
                  }}
                />
                <span className="lead-export-file">
                  <b>{f.name}</b>
                  <small>
                    {fileTypes[f.format] ?? f.format}
                    {f.sheet
                      ? ` · tab ${f.sheet.worksheet}${sameName(f) ? ` · ${f.sheet.spreadsheet_id}` : ""}`
                      : ""}
                    {!f.sheet && sameName(f)
                      ? ` · ${new Date(f.created_at).toLocaleDateString("en-GB")}`
                      : ""}
                  </small>
                  <small>
                    {[
                      f.rows != null && counted(f.rows, "row"),
                      counted(f.created, "new lead"),
                      f.repeat > 0 &&
                        counted(f.repeat, "repeat inquiry", "repeat inquiries"),
                      f.rejected > 0 && `${n(f.rejected)} rejected`,
                      `${n(f.in_crm)} in the CRM now`,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </small>
                </span>
              </label>
            </li>
          ))}
          <li>
            <label>
              <input
                type="radio"
                name="lead-export-file"
                checked={file === noFile}
                onChange={() => {
                  setDone("");
                  setFile(noFile);
                }}
              />
              <span className="lead-export-file">
                <b>No file</b>
                <small>
                  Added by hand, Meta Lead Ads, WhatsApp · {n(noFileLeads)}{" "}
                  leads
                </small>
              </span>
            </label>
          </li>
        </ul>
      </fieldset>

      <fieldset className="lead-export-filters">
        <legend>Narrow the list (optional)</legend>
        <Select
          id="lx-agent"
          label="Agent"
          value={narrow.agent}
          onChange={(v) => set({ agent: v })}
        >
          <option value="">All agents</option>
          {agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
              {a.active === false ? " (disabled)" : ""}
            </option>
          ))}
        </Select>
        <Select
          id="lx-temperature"
          label="Temperature"
          value={narrow.temperature}
          onChange={(v) => set({ temperature: v })}
        >
          <option value="">Any</option>
          <option value="hot">Hot</option>
          <option value="warm">Warm</option>
          <option value="cold">Cold</option>
          <option value="none">Not set</option>
        </Select>
        <Select
          id="lx-status"
          label="Status"
          value={narrow.status}
          onChange={(v) => set({ status: v })}
        >
          <option value="">Any</option>
          {statuses.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          id="lx-outcome"
          label="Last call outcome"
          value={narrow.outcome}
          onChange={(v) => set({ outcome: v })}
        >
          <option value="">Any</option>
          {outcomes.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </Select>
        <Select
          id="lx-contacted"
          label="Contacted"
          value={narrow.contacted}
          onChange={(v) => set({ contacted: v })}
        >
          <option value="">Any</option>
          <option value="yes">Contacted</option>
          <option value="no">Not contacted</option>
        </Select>
        <Select
          id="lx-worked"
          label="Worked"
          value={narrow.worked}
          onChange={(v) => set({ worked: v })}
        >
          <option value="">Any</option>
          <option value="yes">Worked (called)</option>
          <option value="no">Not worked (never called)</option>
        </Select>
        <p className="field-hint">
          Last call, Contacted and Worked are the assigned agent&apos;s own
          calls, as in the Lead pipeline: worked means the agent called,
          contacted means the agent got through.
        </p>
      </fieldset>

      <div className="lead-export-count" role="status" aria-live="polite">
        {!filters ? (
          "Choose a lead file."
        ) : size.error ? (
          <ErrorBox error={size.error} />
        ) : !current ? (
          "Counting…"
        ) : (
          <dl>
            {chosen?.rows != null && (
              <div>
                <dt>
                  {chosen.format === "sheets"
                    ? "Rows in the Sheet (last check)"
                    : "Rows in the file"}
                </dt>
                <dd>{n(chosen.rows)}</dd>
              </div>
            )}
            <div>
              <dt>Leads from it in the CRM</dt>
              <dd>{n(current.in_file)}</dd>
            </div>
            <div>
              <dt>Assigned to an agent now</dt>
              <dd>{n(current.assigned)}</dd>
            </div>
            <div className="lead-export-total">
              <dt>Leads to export</dt>
              <dd>
                {n(count)}
                {size.isFetching ? " …" : ""}
              </dd>
            </div>
          </dl>
        )}
      </div>
      {chosen && (chosen.repeat > 0 || chosen.rejected > 0) && (
        <p className="lead-export-note">
          Rows are not all leads:{" "}
          {[
            chosen.repeat > 0 &&
              counted(
                chosen.repeat,
                "row was a repeat inquiry from a customer who was already a lead",
                "rows were repeat inquiries from customers who were already leads",
              ),
            chosen.rejected > 0 &&
              `${counted(chosen.rejected, "row was", "rows were")} rejected`,
          ]
            .filter(Boolean)
            .join(", and ")}
          .
        </p>
      )}
      {tooBig && (
        <p className="lead-export-warning">
          More than {n(current.max)} leads match. Choose an agent or narrower
          filters.
        </p>
      )}
      <p className="lead-export-note">
        The file has full phone numbers. Each number, and the export itself, is
        recorded in Audit history.
      </p>
      <ErrorBox error={error} />
      {done && (
        <p role="status" className="lead-export-done">
          {done}
        </p>
      )}
      <footer>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Close
        </Button>
        <Button disabled={!ready} onClick={exportFile}>
          {busy ? "Preparing…" : "Export Excel"}
        </Button>
      </footer>
    </Modal>
  );
}
