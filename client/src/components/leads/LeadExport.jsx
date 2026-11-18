import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, download } from "../../lib/api";
import { Button, ErrorBox, Modal } from "../common/UI";
import "../../styles/lead-export.css";
// Administrators' lead export (update 073): leads file by file (Google
// Sheets, CSV and Excel files, or leads with no file), with filters on the
// lead now and on its history, a count before exporting, and one Excel file
// with the chosen worksheets or one worksheet as CSV. The server and the
// database check everything again; the file holds full phone numbers and
// the export is recorded in Audit history.
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
];
const sheets = [
  ["summary", "Lead summary", "One row per lead"],
  ["calls", "Call history", "Every call"],
  ["notes", "Notes", "Lead, follow-up, visit and deal notes"],
  ["assignments", "Assignment history", "Every move between agents"],
  ["ad_quality", "Ad quality", "Leads by advertisement"],
  ["files", "Files", "Each file's rows, new leads, repeats and rejections"],
];
const everySheet = sheets.map(([v]) => v);
// Presets: the filters they set (files and agent stay as chosen) and the
// worksheets that suit them.
export const presets = [
  ["file", "All leads from the files", {}, everySheet],
  [
    "contacted",
    "Contacted",
    { contacted: "yes" },
    ["summary", "calls", "notes", "assignments", "ad_quality", "files"],
  ],
  [
    "not_contacted",
    "Not contacted",
    { contacted: "no" },
    ["summary", "calls", "assignments", "files"],
  ],
  [
    "interested",
    "Interested",
    { had_outcome: "Interested" },
    ["summary", "calls", "notes", "ad_quality"],
  ],
  ["hot", "Hot", { temperature: "hot" }, ["summary", "calls", "notes"]],
  ["warm", "Warm", { temperature: "warm" }, ["summary", "calls", "notes"]],
  [
    "followup",
    "Follow-up required",
    { outcome: "Follow-up required" },
    ["summary", "calls", "notes"],
  ],
  [
    "visit",
    "Site visit scheduled",
    { visit: "scheduled" },
    ["summary", "calls", "notes"],
  ],
  [
    "won",
    "Won deals",
    { deal: "won" },
    ["summary", "calls", "notes", "ad_quality"],
  ],
];
const presetKeys = [
  "contacted",
  "had_outcome",
  "temperature",
  "outcome",
  "visit",
  "deal",
];
const fileTypes = {
  sheets: "Google Sheet",
  csv: "CSV",
  xlsx: "Excel",
  xls: "Excel",
  legacy: "Earlier import",
};
const n = (v) => Number(v ?? 0).toLocaleString("en-US");
const counted = (v, one, many = one + "s") =>
  `${n(v)} ${Number(v) === 1 ? one : many}`;
const pkDay = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(
    new Date(),
  );
// Only what the server takes: blanks out.
const cleaned = (f) =>
  Object.fromEntries(
    Object.entries(f).filter(([, v]) =>
      Array.isArray(v) ? v.length > 0 : v !== "" && v !== false && v != null,
    ),
  );

export default function LeadExport({ initial = {} }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Export
      </Button>
      {open && (
        <ExportDialog initial={initial} onClose={() => setOpen(false)} />
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

function ExportDialog({ initial, onClose }) {
  const [filters, setFilters] = useState(() => cleaned(initial));
  const [preset, setPreset] = useState(null),
    [format, setFormat] = useState("xlsx"),
    [chosen, setChosen] = useState(everySheet),
    [csvSheet, setCsvSheet] = useState("summary"),
    [search, setSearch] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [done, setDone] = useState("");
  const set = (patch) => {
    setDone("");
    setFilters((f) => cleaned({ ...f, ...patch }));
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
  // The count follows the filters, a moment after the last change.
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
    placeholderData: (previous) => previous,
    retry: false,
  });
  const files = sources.data?.files ?? [];
  const noFile = Object.values(sources.data?.no_file ?? {}).reduce(
    (a, b) => a + b,
    0,
  );
  const picked = new Set(filters.files ?? []);
  // The order stays put while ticking; only the files chosen on opening
  // come first.
  const [initialFiles] = useState(() => new Set(initial.files ?? []));
  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    // Files already ticked first, then the newest.
    return files
      .filter(
        (f) =>
          !f.file_deleted &&
          (!s ||
            f.name.toLowerCase().includes(s) ||
            (f.sheet?.spreadsheet_id ?? "").toLowerCase().includes(s)),
      )
      .sort((a, b) => initialFiles.has(b.id) - initialFiles.has(a.id));
  }, [files, search, initialFiles]);
  // Two files can share a name; the spreadsheet ID or date tells them apart.
  const sameName = (f) => files.filter((x) => x.name === f.name).length > 1;
  const toggleFile = (id, on) => {
    const next = new Set(picked);
    if (on) next.add(id);
    else next.delete(id);
    set({ files: [...next] });
  };
  const choosePreset = ([value, , patch, sheetList]) => {
    setPreset(value);
    set({
      ...Object.fromEntries(presetKeys.map((k) => [k, ""])),
      ...patch,
    });
    setChosen(sheetList);
  };
  const sheetsToSend = format === "xlsx" ? chosen : [csvSheet];
  const count = size.data?.count;
  const ready =
    !busy &&
    count > 0 &&
    !size.isFetching &&
    sheetsToSend.length > 0 &&
    !size.error;
  async function exportFile() {
    if (!ready) return;
    setBusy(true);
    setError("");
    setDone("");
    try {
      const body = {
        filters,
        format,
        ...(format === "xlsx" ? { sheets: chosen } : { sheet: csvSheet }),
        ...(preset ? { preset } : {}),
      };
      const name = `hd-leads-${preset ?? "export"}-${pkDay()}`;
      download(
        await api("/leads/export", { method: "POST", body, download: true }),
        format === "xlsx" ? `${name}.xlsx` : `${name}-${csvSheet}.csv`,
      );
      setDone(`Exported ${n(count)} ${count === 1 ? "lead" : "leads"}.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const tooBig =
    count != null &&
    (format === "xlsx"
      ? count > (size.data?.limits?.xlsxLeads ?? Infinity)
      : count > (size.data?.limits?.csvLeads ?? Infinity));
  return (
    <Modal
      title="Export leads"
      className="lead-export"
      onClose={() => !busy && onClose()}
    >
      <p className="lead-export-intro">
        Choose files and filters. The file has one row per lead, and, if you
        choose them, every call, note and assignment of those leads.
      </p>

      <fieldset className="lead-export-presets">
        <legend>Quick choices</legend>
        <div className="lead-export-chips">
          {presets.map((p) => (
            <button
              key={p[0]}
              type="button"
              aria-pressed={preset === p[0]}
              className={preset === p[0] ? "active" : ""}
              onClick={() => choosePreset(p)}
            >
              {p[1]}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="lead-export-files">
        <legend>Files</legend>
        <p className="field-hint">
          None chosen: every lead. A Google Sheet exports the leads it created;
          a customer who was already a lead and wrote in again is counted under
          Repeats, not exported as that Sheet&apos;s lead.
        </p>
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
                  type="checkbox"
                  checked={picked.has(f.id)}
                  onChange={(e) => toggleFile(f.id, e.target.checked)}
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
                      f.repeat > 0 && counted(f.repeat, "repeat"),
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
                type="checkbox"
                checked={!!filters.no_file}
                onChange={(e) => set({ no_file: e.target.checked })}
              />
              <span className="lead-export-file">
                <b>No file</b>
                <small>
                  Added by hand, Meta Lead Ads, WhatsApp · {n(noFile)} leads
                </small>
              </span>
            </label>
          </li>
        </ul>
      </fieldset>

      <div className="lead-export-filters">
        <fieldset>
          <legend>The lead now</legend>
          <Select
            id="lx-agent"
            label="Agent"
            value={
              filters.agent ??
              (filters.assignment ? `@${filters.assignment}` : "")
            }
            onChange={(v) =>
              set(
                v.startsWith("@")
                  ? { agent: "", assignment: v.slice(1) }
                  : { agent: v, assignment: "" },
              )
            }
          >
            <option value="">Any</option>
            <option value="@assigned">Any agent</option>
            <option value="@unassigned">No agent</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
                {a.active ? "" : " (disabled)"}
              </option>
            ))}
          </Select>
          <Select
            id="lx-source"
            label="Source"
            value={filters.source}
            onChange={(v) => set({ source: v })}
          >
            <option value="">Any</option>
            <option value="Meta">Meta</option>
            <option value="CSV">CSV / Excel</option>
            <option value="manual">Manual</option>
            <option value="WhatsApp">WhatsApp</option>
            <option value="other">Other</option>
          </Select>
          <Select
            id="lx-status"
            label="Status"
            value={filters.status}
            onChange={(v) => set({ status: v })}
          >
            <option value="">Any</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="interested">Interested</option>
            <option value="visit_scheduled">Site visit scheduled</option>
            <option value="visit_done">Visit done</option>
            <option value="negotiation">Negotiation</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
          </Select>
          <Select
            id="lx-temp"
            label="Temperature"
            value={filters.temperature}
            onChange={(v) => set({ temperature: v })}
          >
            <option value="">Any</option>
            <option value="hot">Hot</option>
            <option value="warm">Warm</option>
            <option value="cold">Cold</option>
            <option value="none">Not set</option>
          </Select>
          <Select
            id="lx-outcome"
            label="Latest call outcome"
            value={filters.outcome}
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
            value={filters.contacted}
            onChange={(v) => set({ contacted: v })}
          >
            <option value="">Any</option>
            <option value="yes">Contacted (an answered call)</option>
            <option value="no">Not contacted</option>
          </Select>
          <Select
            id="lx-followup"
            label="Follow-ups"
            value={filters.followup}
            onChange={(v) => set({ followup: v })}
          >
            <option value="">Any</option>
            <option value="pending">Pending</option>
            <option value="overdue">Overdue</option>
            <option value="completed">Completed</option>
            <option value="none">None</option>
          </Select>
          <Select
            id="lx-visit"
            label="Site visits"
            value={filters.visit}
            onChange={(v) => set({ visit: v })}
          >
            <option value="">Any</option>
            <option value="scheduled">Scheduled</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled or no-show</option>
            <option value="none">None</option>
          </Select>
          <Select
            id="lx-deal"
            label="Deals"
            value={filters.deal}
            onChange={(v) => set({ deal: v })}
          >
            <option value="">Any</option>
            <option value="discussion">Discussion</option>
            <option value="negotiation">Negotiation</option>
            <option value="won">Won</option>
            <option value="lost">Lost</option>
            <option value="none">None</option>
          </Select>
        </fieldset>
        <fieldset>
          <legend>History (Pakistan days)</legend>
          <label htmlFor="lx-cf">
            Lead created from
            <input
              id="lx-cf"
              type="date"
              value={filters.created_from ?? ""}
              onChange={(e) => set({ created_from: e.target.value })}
            />
          </label>
          <label htmlFor="lx-ct">
            to
            <input
              id="lx-ct"
              type="date"
              value={filters.created_to ?? ""}
              onChange={(e) => set({ created_to: e.target.value })}
            />
          </label>
          <label htmlFor="lx-kf">
            Had a call from
            <input
              id="lx-kf"
              type="date"
              value={filters.calls_from ?? ""}
              onChange={(e) => set({ calls_from: e.target.value })}
            />
          </label>
          <label htmlFor="lx-kt">
            to
            <input
              id="lx-kt"
              type="date"
              value={filters.calls_to ?? ""}
              onChange={(e) => set({ calls_to: e.target.value })}
            />
          </label>
          <Select
            id="lx-had"
            label="Had a call with the outcome"
            value={filters.had_outcome}
            onChange={(v) => set({ had_outcome: v })}
          >
            <option value="">Any</option>
            {outcomes.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </Select>
          <p className="field-hint">
            A call period also limits Call history to those days.
          </p>
        </fieldset>
      </div>

      <fieldset className="lead-export-format">
        <legend>File</legend>
        <div className="lead-export-chips">
          {[
            ["xlsx", "Excel (several worksheets)"],
            ["csv", "CSV (one worksheet)"],
          ].map(([value, label]) => (
            <label key={value} className="lead-export-radio">
              <input
                type="radio"
                name="lead-export-format"
                checked={format === value}
                onChange={() => setFormat(value)}
              />
              {label}
            </label>
          ))}
        </div>
        {format === "xlsx" ? (
          <div className="lead-export-sheets">
            {sheets.map(([value, label, hint]) => (
              <label key={value}>
                <input
                  type="checkbox"
                  checked={chosen.includes(value)}
                  onChange={(e) =>
                    setChosen((c) =>
                      e.target.checked
                        ? everySheet.filter((s) => s === value || c.includes(s))
                        : c.filter((s) => s !== value),
                    )
                  }
                />
                <span>
                  {label}
                  <small>{hint}</small>
                </span>
              </label>
            ))}
          </div>
        ) : (
          <Select
            id="lx-csv"
            label="Worksheet"
            value={csvSheet}
            onChange={setCsvSheet}
          >
            {sheets.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>
        )}
      </fieldset>

      <div className="lead-export-count" role="status" aria-live="polite">
        {size.error ? (
          <ErrorBox error={size.error} />
        ) : count == null ? (
          "Counting…"
        ) : (
          <>
            <b>
              {n(count)} {count === 1 ? "lead" : "leads"}
            </b>{" "}
            match · {n(size.data.calls)} calls · {n(size.data.notes)} notes ·{" "}
            {n(size.data.assignments)} assignments
            {size.isFetching ? " · updating…" : ""}
          </>
        )}
      </div>
      {tooBig && (
        <p className="lead-export-warning">
          Too many leads for one {format === "xlsx" ? "Excel file" : "CSV file"}
          . Choose fewer files or narrower filters
          {format === "xlsx" ? ", or one worksheet as CSV" : ""}.
        </p>
      )}
      <p className="lead-export-note">
        The file includes full phone numbers. Each number in the Lead summary,
        and the export itself, is recorded in Audit history.
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
        <Button disabled={!ready || tooBig} onClick={exportFile}>
          {busy
            ? "Preparing…"
            : count
              ? `Export ${n(count)} ${count === 1 ? "lead" : "leads"}`
              : "Export"}
        </Button>
      </footer>
    </Modal>
  );
}
