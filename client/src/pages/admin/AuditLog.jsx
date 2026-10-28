import { useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  Activity,
  Building2,
  CalendarCheck,
  CalendarClock,
  Cpu,
  FileText,
  Link2,
  Phone,
  Settings,
  ShieldCheck,
  Target,
  UserCog,
  Users,
} from "lucide-react";
import { api } from "../../lib/api";
import { todayPk } from "../../lib/calendar";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
} from "../../components/common/UI";
import "../../styles/audit-history.css";
// Audit history (update 043): who did what, to which record, when and what
// changed, in plain English. The server describes each entry and removes
// anything secret; entries are read-only here.
const icons = {
  leads: Users,
  calls: Phone,
  activities: CalendarClock,
  targets: Target,
  properties: Building2,
  documents: FileText,
  accounts: UserCog,
  security: ShieldCheck,
  attendance: CalendarCheck,
  settings: Settings,
  integrations: Link2,
  system: Cpu,
};
const dayFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  day: "numeric",
  year: "numeric",
  timeZone: "Asia/Karachi",
});
const timeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: "Asia/Karachi",
});
const when = (value) => {
  const at = new Date(value);
  return Number.isNaN(at.getTime())
    ? { day: "—", time: "" }
    : { day: dayFormat.format(at), time: timeFormat.format(at) };
};
const blank = {
  search: "",
  module: "",
  kind: "",
  actor: "",
  from: "",
  to: "",
  sort: "newest",
};
const LIMIT = 20;

function Who({ person }) {
  if (!person) return <span className="muted">—</span>;
  return (
    <span className="audit-person">
      <b>{person.name || person.label}</b>
      {person.detail && <small>{person.detail}</small>}
      {person.note && <small className="audit-note">{person.note}</small>}
    </span>
  );
}

function AuditDetails({ entry, onClose }) {
  const at = when(entry.at);
  const t = entry.technical || {};
  return (
    <Modal title={entry.title} onClose={onClose} className="audit-dialog">
      <p className="audit-detail-description">{entry.description}</p>
      <dl className="audit-facts">
        <div>
          <dt>When</dt>
          <dd>
            {at.day} at {at.time}
          </dd>
        </div>
        <div>
          <dt>Performed by</dt>
          <dd>
            <Who person={entry.actor} />
          </dd>
        </div>
        {entry.record && (
          <div>
            <dt>Affected</dt>
            <dd>
              <Who person={entry.record} />
            </dd>
          </div>
        )}
        <div>
          <dt>Module</dt>
          <dd>{entry.module?.label}</dd>
        </div>
        {entry.kind && (
          <div>
            <dt>Action type</dt>
            <dd>{entry.kind.label}</dd>
          </div>
        )}
        {entry.fields && (
          <div className="wide">
            <dt>Changed fields</dt>
            <dd>{entry.fields}</dd>
          </div>
        )}
        {entry.reason && (
          <div className="wide">
            <dt>Reason given</dt>
            <dd>{entry.reason}</dd>
          </div>
        )}
      </dl>
      {entry.changes?.length > 0 && (
        <div className="audit-changes-wrap">
          <table className="audit-changes">
            <caption>What changed</caption>
            <thead>
              <tr>
                <th scope="col">Item</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
              </tr>
            </thead>
            <tbody>
              {entry.changes.map((c) => (
                <tr key={c.label}>
                  <th scope="row">{c.label}</th>
                  <td>{c.before || "—"}</td>
                  <td>{c.after || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <details className="audit-technical">
        <summary>Technical details</summary>
        <p className="field-hint">
          For troubleshooting. Secret and personal values are hidden.
        </p>
        <dl>
          {[
            ["Action", t.action],
            ["Record type", t.entity],
            ["Performed by (ID)", t.actor_id],
            ["Record ID", t.entity_id],
            ["Request ID", t.request_id],
          ].map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>
                <code>{value ?? "—"}</code>
              </dd>
            </div>
          ))}
        </dl>
        <pre aria-label="Recorded details">
          {JSON.stringify(t.metadata ?? {}, null, 2)}
        </pre>
      </details>
      <footer className="review-buttons">
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </footer>
    </Modal>
  );
}

export default function AuditLog() {
  const [filters, setFilters] = useState(blank),
    [page, setPage] = useState(1),
    [open, setOpen] = useState(null);
  const search = useDebouncedValue(filters.search.trim());
  const badRange = Boolean(
    filters.from && filters.to && filters.from > filters.to,
  );
  const params = {
    page,
    limit: LIMIT,
    sort: filters.sort,
    ...(search ? { search } : {}),
    ...(filters.module ? { module: filters.module } : {}),
    ...(filters.kind ? { kind: filters.kind } : {}),
    ...(filters.actor ? { actor: filters.actor } : {}),
    ...(filters.from ? { from: filters.from } : {}),
    ...(filters.to ? { to: filters.to } : {}),
  };
  const q = useQuery({
    queryKey: ["audit", params],
    queryFn: ({ signal }) =>
      api("/audit?" + new URLSearchParams(params), { signal }),
    enabled: !badRange,
    // Keep the current results (and the filter choices that come with them)
    // on screen while the next page or filter loads.
    placeholderData: keepPreviousData,
  });
  const people = useQuery({
    queryKey: ["audit-actors"],
    queryFn: ({ signal }) => api("/audit/actors", { signal }),
  });
  const set = (key) => (event) => {
    setFilters({ ...filters, [key]: event.target.value });
    setPage(1);
  };
  const filtered = Object.keys(blank).some(
    (key) => key !== "sort" && filters[key],
  );
  const rows = q.data?.data || [];
  const options = (list) => (Array.isArray(list) ? list : []);
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">ACCOUNTABILITY IN EVERY ACTION</span>
          <h1>Audit history</h1>
          <p>
            Every important change in the CRM: who made it, when, and what
            changed. Entries can't be edited or deleted.
          </p>
        </div>
      </div>
      <section className="panel audit-filters" aria-label="Filter activity">
        <label className="audit-search">
          Search
          <input
            type="search"
            placeholder="Employee name or UID…"
            value={filters.search}
            maxLength={100}
            onChange={set("search")}
          />
        </label>
        <label>
          Module
          <select value={filters.module} onChange={set("module")}>
            <option value="">All modules</option>
            {options(q.data?.modules).map((m) => (
              <option key={m.key} value={m.key}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Action
          <select value={filters.kind} onChange={set("kind")}>
            <option value="">All actions</option>
            {options(q.data?.kinds).map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Performed by
          <select value={filters.actor} onChange={set("actor")}>
            <option value="">Anyone</option>
            {options(people.data).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.detail ? ` · ${p.detail}` : ""}
              </option>
            ))}
          </select>
        </label>
        <label>
          From
          <input
            type="date"
            max={todayPk()}
            value={filters.from}
            onChange={set("from")}
          />
        </label>
        <label>
          Through
          <input
            type="date"
            max={todayPk()}
            value={filters.to}
            onChange={set("to")}
          />
        </label>
        <label>
          Order
          <select value={filters.sort} onChange={set("sort")}>
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
        </label>
        <Button
          variant="secondary"
          className="audit-clear"
          disabled={!filtered && filters.sort === "newest"}
          onClick={() => {
            setFilters(blank);
            setPage(1);
          }}
        >
          Clear filters
        </Button>
      </section>
      <section className="panel">
        <ErrorBox
          error={
            badRange
              ? "The date range must end on or after its start."
              : q.error || people.error
          }
        />
        {q.data && (
          <p className="audit-count" aria-live="polite">
            {q.data.count === 1
              ? "1 activity"
              : `${q.data.count.toLocaleString("en-US")} activities`}
            {filtered ? " match these filters" : " recorded"}
          </p>
        )}
        {q.isPending && !badRange ? (
          <Loader />
        ) : q.data && rows.length === 0 ? (
          <div className="empty">
            {filtered
              ? "No activity matches these filters. Try a wider date range or clear the filters."
              : "No activity has been recorded yet."}
          </div>
        ) : rows.length > 0 ? (
          <table className="audit-table">
            <thead>
              <tr>
                <th scope="col">Date &amp; time</th>
                <th scope="col">Activity</th>
                <th scope="col">Performed by</th>
                <th scope="col">Affected</th>
                <th scope="col">
                  <span className="visually-hidden">Details</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((entry) => {
                const at = when(entry.at);
                const Icon = icons[entry.module?.key] || Activity;
                return (
                  <tr key={entry.id}>
                    <td className="audit-when" data-label="Date & time">
                      <span>{at.day}</span>
                      <small>{at.time}</small>
                    </td>
                    <td data-label="Activity">
                      <div className="audit-activity">
                        <span
                          className={`audit-icon module-${entry.module?.key || "other"}`}
                          aria-hidden="true"
                        >
                          <Icon size={16} />
                        </span>
                        <div>
                          <b>{entry.title}</b>
                          <p className="audit-description">
                            {entry.description}
                          </p>
                          <small>
                            {entry.module?.label}
                            {entry.kind ? ` · ${entry.kind.label}` : ""}
                          </small>
                        </div>
                      </div>
                    </td>
                    <td data-label="Performed by">
                      <Who person={entry.actor} />
                    </td>
                    <td data-label="Affected">
                      <Who person={entry.record} />
                    </td>
                    <td className="audit-action">
                      <Button
                        variant="secondary"
                        aria-label={`View details: ${entry.title}, ${at.day} ${at.time}`}
                        onClick={() => setOpen(entry)}
                      >
                        Details
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : null}
        {q.data?.count > LIMIT && (
          <Pagination
            page={page}
            count={q.data.count}
            limit={LIMIT}
            onPage={setPage}
          />
        )}
      </section>
      {open && <AuditDetails entry={open} onClose={() => setOpen(null)} />}
    </>
  );
}
