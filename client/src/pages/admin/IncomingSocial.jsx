import { formatLeadNo } from "../../lib/formatLeadNo";
import { useState, useRef } from "react";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date, pkr, monthRange } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import {
  metaApi,
  platformLabel,
  metaStatus,
  useMetaSummary,
} from "../../lib/meta";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  Table,
  RecordForm,
  useToast,
} from "../../components/common/UI";
function Assignment({ leads, names = [], onClose, onSaved }) {
  const agents = useQuery({
      queryKey: ["meta-agents"],
      queryFn: () => api("/users"),
    }),
    [search, setSearch] = useState(""),
    [target, setTarget] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    pending = useRef(false);
  return (
    <Modal
      title="Assign incoming leads"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (pending.current) return;
          pending.current = true;
          setBusy(true);
          setError("");
          try {
            const result = await api(metaApi + "/assign", {
              method: "POST",
              body: { lead_ids: leads, agent_id: target },
            });
            onSaved(result);
          } catch (e) {
            setError(e.message);
          } finally {
            pending.current = false;
            setBusy(false);
          }
        }}
      >
        <p>
          Assign {leads.length} selected customers to one active agent. All
          selected leads must still be unassigned; a conflict cancels the whole
          operation.
        </p>
        <ul aria-label="Selected customers">
          {names.map((name, index) => (
            <li key={leads[index]}>{name}</li>
          ))}
        </ul>
        <ErrorBox error={error || agents.error} />
        <label>
          Find an agent
          <input
            type="search"
            disabled={busy}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label>
          Receiving agent *
          <select
            required
            disabled={busy}
            value={target}
            onChange={(e) => setTarget(e.target.value)}
          >
            <option value="">Choose an active agent</option>
            {agents.data
              ?.filter(
                (a) =>
                  a.active &&
                  a.role === "agent" &&
                  a.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <footer>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button disabled={busy || !target}>
            {busy ? "Assigning…" : "Confirm assignment"}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}
function SocialDetail({ id }) {
  const q = useQuery({
      queryKey: ["meta-submission", id],
      queryFn: () => api(`${metaApi}/submissions/${id}`),
    }),
    qc = useQueryClient(),
    toast = useToast();
  const [assign, setAssign] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const d = q.data;
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["meta-submission", id] });
    qc.invalidateQueries({ queryKey: ["meta-inbox"] });
    qc.invalidateQueries({ queryKey: ["meta-summary"] });
  };
  return (
    <>
      <Link to="/incoming-social">← Incoming social leads</Link>
      <div className="page-heading meta-page-heading">
        <div>
          <span className="eyebrow">SOCIAL ENQUIRY</span>
          <h1>
            {d?.lead?.name || d?.normalized?.name || "Submission details"}
          </h1>
        </div>
      </div>
      <ErrorBox error={q.error || error} />
      {q.isPending ? (
        <Loader />
      ) : (
        d && (
          <>
            <section className="panel">
              <h2>{metaStatus(d.status)}</h2>
              {d.lead && (
                <p className="lead-number">{formatLeadNo(d.lead.lead_no)}</p>
              )}
              <dl className="account-detail-grid">
                {[
                  ["Platform", platformLabel(d.platform)],
                  [
                    "Phone",
                    d.phone || d.normalized?.phone || "Missing / invalid",
                  ],
                  ["Email", d.lead?.email || d.normalized?.email || "—"],
                  [
                    "Campaign",
                    d.campaign_name || d.campaign_id || "Unavailable",
                  ],
                  ["Ad", d.ad_name || d.ad_id || "Unavailable"],
                  ["Form", d.form_id],
                  ["Submitted", date(d.submitted_at)],
                  ["Received", date(d.received_at)],
                  ["Lead stage", d.lead?.status || "Not created"],
                  ["Processing attempts", d.attempts],
                  ["Warning", d.warning || d.error_code || "—"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <dt>{label}</dt>
                    <dd>{value}</dd>
                  </div>
                ))}
              </dl>
              {d.status === "duplicate" && (
                <p>
                  Repeat inquiry matched an existing customer. Their owner,
                  notes and CRM stage are unchanged.
                </p>
              )}
              <div className="meta-actions">
                {d.lead_id && (
                  <Link className="button secondary" to={"/leads/" + d.lead_id}>
                    Customer activity
                  </Link>
                )}
                {d.lead?.meta_pending_assignment && (
                  <Button onClick={() => setAssign(true)}>Assign Agent</Button>
                )}
                {["failed", "review", "retry"].includes(d.status) && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await api(`${metaApi}/submissions/${id}/retry`, {
                          method: "POST",
                          body: {},
                        });
                        refresh();
                        toast("Retrieval queued");
                      } catch (e) {
                        setError(e.message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    Retry retrieval
                  </Button>
                )}
              </div>
            </section>
            <section className="panel">
              <h2>Form answers</h2>
              {d.answers?.length ? (
                <dl className="meta-answers">
                  {d.answers.map((a, i) => (
                    <div key={i}>
                      <dt>{a.name}</dt>
                      <dd>{a.values.join("; ")}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p>
                  Answers are not available or have expired under the retention
                  policy.
                </p>
              )}
            </section>
            {d.status === "review" && (
              <section className="panel">
                <h2>Resolve customer information</h2>
                <RecordForm
                  initial={d.normalized || {}}
                  fields={[
                    { key: "name", label: "Customer name", required: true },
                    { key: "phone", label: "Customer phone", required: true },
                    { key: "email", label: "Email", type: "email" },
                  ]}
                  submit="Save to incoming leads"
                  onSave={async (data) => {
                    await api(`${metaApi}/submissions/${id}/resolve`, {
                      method: "POST",
                      body: {
                        name: data.name,
                        phone: data.phone,
                        ...(data.email ? { email: data.email } : {}),
                      },
                    });
                    refresh();
                    toast("Review saved");
                  }}
                />
              </section>
            )}
            <section className="panel">
              <h2>Assignment history</h2>
              {d.assignments?.length ? (
                d.assignments.map((a) => (
                  <p key={a.id || a.created_at}>
                    Assigned {date(a.created_at)} · Agent ID{" "}
                    {a.agent_id || "Admin pool"}
                  </p>
                ))
              ) : (
                <p>No assignment yet.</p>
              )}
            </section>
          </>
        )
      )}
      {assign && (
        <Assignment
          leads={[d.lead_id]}
          names={[d.lead?.name || d.normalized?.name || "Selected customer"]}
          onClose={() => setAssign(false)}
          onSaved={(result) => {
            setAssign(false);
            refresh();
            toast(`${result.assigned} customer assigned`);
          }}
        />
      )}
    </>
  );
}
export default function IncomingSocial() {
  const { id } = useParams();
  return id ? <SocialDetail id={id} /> : <SocialInbox />;
}
function SocialInbox() {
  const [searchParams] = useSearchParams();
  const { user } = useAuth(),
    summary = useMetaSummary(user),
    qc = useQueryClient(),
    toast = useToast();
  const [page, setPage] = useState(1),
    [filters, setFilters] = useState({
      sort: "newest",
      ...([
        "queued",
        "processing",
        "retry",
        "created",
        "duplicate",
        "review",
        "failed",
      ].includes(searchParams.get("status"))
        ? { status: searchParams.get("status") }
        : {}),
    }),
    [selection, setSelection] = useState([]),
    [assignment, setAssignment] = useState(null),
    [report, setReport] = useState(false);
  const range = monthRange();
  const debouncedSearch = useDebouncedValue(filters.search);
  const params = { ...filters, search: debouncedSearch, page };
  if (params.from)
    params.from = new Date(params.from + "T00:00:00+05:00").toISOString();
  if (params.to)
    params.to = new Date(
      new Date(params.to + "T00:00:00+05:00").getTime() + 86400000,
    ).toISOString();
  const q = useQuery({
    queryKey: ["meta-inbox", params],
    queryFn: ({ signal }) =>
      api(
        metaApi +
          "/inbox?" +
          new URLSearchParams(Object.entries(params).filter(([, v]) => v)),
        { signal },
      ),
    refetchInterval: 30000,
  });
  const reporting = useQuery({
    queryKey: ["meta-report", range],
    queryFn: () =>
      api(
        metaApi +
          "/report?" +
          new URLSearchParams({
            from: range.from,
            to: range.to,
          }),
      ),
    enabled: report,
  });
  function change(key, value) {
    setFilters({ ...filters, [key]: value });
    setPage(1);
    setSelection([]);
  }
  return (
    <>
      <div className="page-heading meta-page-heading">
        <div>
          <span className="eyebrow">YOUR MARKETING INBOX</span>
          <h1>Incoming social leads</h1>
          <p>
            New customers stay private to administrators until you assign them.
          </p>
        </div>
        <Link className="button secondary" to="/integrations/meta">
          Meta integration
        </Link>
      </div>
      <ErrorBox error={summary.error} />
      <div className="metric-grid fx-stagger">
        {[
          ["Total submissions", "total"],
          ["New unassigned", "unassigned"],
          ["Facebook", "facebook"],
          ["Instagram", "instagram"],
          ["Needs review", "review"],
          ["Assigned today", "assigned_today"],
          ["Repeat inquiries", "duplicates"],
          ["Processing failures", "failures"],
        ].map(([label, key]) => (
          <section className="metric fx-card" key={key}>
            <span>{label}</span>
            <strong>{summary.data?.[key] ?? "—"}</strong>
          </section>
        ))}
      </div>
      <section className="panel meta-records">
        <div className="toolbar meta-filters">
          <label>
            Search customers
            <input
              aria-label="Search social leads"
              type="search"
              placeholder="Search customer, email or campaign…"
              maxLength={100}
              value={filters.search || ""}
              onChange={(e) => change("search", e.target.value)}
            />
          </label>
          <label>
            Platform
            <select
              aria-label="Platform"
              value={filters.platform || ""}
              onChange={(e) => change("platform", e.target.value)}
            >
              <option value="">All platforms</option>
              {["facebook", "instagram", "meta"].map((p) => (
                <option key={p} value={p}>
                  {platformLabel(p)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Assignment
            <select
              aria-label="Assignment"
              value={filters.assignment || ""}
              onChange={(e) => change("assignment", e.target.value)}
            >
              <option value="">All assignments</option>
              <option value="unassigned">Unassigned</option>
              <option value="assigned">Assigned</option>
            </select>
          </label>
          <label>
            Processing status
            <select
              aria-label="Processing status"
              value={filters.status || ""}
              onChange={(e) => change("status", e.target.value)}
            >
              <option value="">All processing states</option>
              {[
                "queued",
                "processing",
                "retry",
                "created",
                "duplicate",
                "review",
                "failed",
              ].map((s) => (
                <option key={s} value={s}>
                  {metaStatus(s)}
                </option>
              ))}
            </select>
          </label>
          <label>
            From
            <input
              type="date"
              value={filters.from || ""}
              onChange={(e) => change("from", e.target.value)}
            />
          </label>
          <label>
            Through
            <input
              type="date"
              value={filters.to || ""}
              onChange={(e) => change("to", e.target.value)}
            />
          </label>
          <label>
            Campaign ID
            <input
              aria-label="Campaign ID"
              placeholder="Campaign ID"
              value={filters.campaign || ""}
              onChange={(e) => change("campaign", e.target.value)}
            />
          </label>
          <label>
            Form ID
            <input
              aria-label="Form ID"
              placeholder="Form ID"
              value={filters.form || ""}
              onChange={(e) => change("form", e.target.value)}
            />
          </label>
          <label>
            Sort order
            <select
              aria-label="Sort submissions"
              value={filters.sort}
              onChange={(e) => change("sort", e.target.value)}
            >
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
            </select>
          </label>
        </div>
        <div className="meta-actions">
          <Button
            disabled={!selection.length}
            onClick={() => setAssignment(selection)}
          >
            Assign selected ({selection.length})
          </Button>
          <Button
            variant="secondary"
            disabled={!selection.length}
            onClick={() => setSelection([])}
          >
            Clear selection
          </Button>
        </div>
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : (
          !q.error && (
            <>
              <Table
                showSerial
                page={page}
                count={q.data?.count}
                rows={q.data?.data || []}
                columns={[
                  {
                    key: "lead_no",
                    label: "Lead number",
                    render: (r) => formatLeadNo(r.lead_no),
                  },
                  {
                    key: "select",
                    label: "Select",
                    render: (r) =>
                      r.meta_pending_assignment && !r.assigned_agent ? (
                        <label className="meta-select">
                          <input
                            type="checkbox"
                            aria-label={`Select ${r.customer_name || r.provider_lead_id}`}
                            checked={selection.includes(r.lead_id)}
                            onChange={(e) =>
                              setSelection((current) =>
                                e.target.checked
                                  ? [...new Set([...current, r.lead_id])]
                                  : current.filter((id) => id !== r.lead_id),
                              )
                            }
                          />
                        </label>
                      ) : (
                        "—"
                      ),
                  },
                  {
                    key: "customer_name",
                    label: "Customer",
                    render: (r) => (
                      <Link to={"/incoming-social/" + r.id}>
                        {r.customer_name || "Review submission"}
                      </Link>
                    ),
                  },
                  { key: "phone", label: "Phone" },
                  { key: "email", label: "Email" },
                  {
                    key: "platform",
                    label: "Platform",
                    render: (r) => platformLabel(r.platform),
                  },
                  { key: "campaign_name", label: "Campaign" },
                  { key: "form_name", label: "Form" },
                  {
                    key: "received_at",
                    label: "Received",
                    render: (r) => date(r.received_at),
                  },
                  { key: "preferred_location", label: "Location" },
                  {
                    key: "budget_min",
                    label: "Budget",
                    render: (r) =>
                      r.budget_min == null
                        ? "—"
                        : `${pkr(r.budget_min)} – ${r.budget_max == null ? "Open" : pkr(r.budget_max)}`,
                  },
                  { key: "interested_property", label: "Property interest" },
                  { key: "lead_status", label: "CRM stage" },
                  {
                    key: "status",
                    label: "Processing",
                    render: (r) => metaStatus(r.status),
                  },
                  {
                    key: "agent_name",
                    label: "Assigned agent",
                    render: (r) => r.agent_name || "Unassigned",
                  },
                  {
                    key: "assign",
                    label: "Action",
                    render: (r) =>
                      r.meta_pending_assignment && !r.assigned_agent ? (
                        <Button
                          variant="secondary"
                          onClick={() => setAssignment([r.lead_id])}
                        >
                          Assign Agent
                        </Button>
                      ) : null,
                  },
                ]}
              />
              <Pagination
                page={page}
                count={q.data?.count || 0}
                onPage={(value) => {
                  setPage(value);
                  setSelection([]);
                }}
              />
            </>
          )
        )}
      </section>
      <section className="panel meta-records meta-report">
        <h2>Marketing attribution</h2>
        <p>
          Submission totals include repeat inquiries. Unique customer metrics
          use the first Meta inquiry and preserve the CRM's recorded
          closed-value definition.
        </p>
        <Button variant="secondary" onClick={() => setReport(!report)}>
          {report ? "Close report" : "View current-month report"}
        </Button>
        {report && (
          <>
            <ErrorBox error={reporting.error} />
            {reporting.isPending ? (
              <Loader />
            ) : (
              reporting.data && (
                <>
                  <p>
                    {reporting.data.submissions} submissions ·{" "}
                    {reporting.data.unique_customers} unique customers ·{" "}
                    {reporting.data.assigned} assigned ·{" "}
                    {reporting.data.unassigned} unassigned ·{" "}
                    {reporting.data.completed_visits} completed visits ·{" "}
                    {reporting.data.won_deals} won deals · Recorded closed value{" "}
                    {pkr(reporting.data.revenue)}
                  </p>
                  <p>
                    CRM stages:{" "}
                    {Object.entries(reporting.data.stages || {})
                      .map(([s, n]) => `${s}: ${n}`)
                      .join(" · ") || "No customers"}
                  </p>
                  <Table
                    rows={(reporting.data.groups || []).map((row) => ({
                      ...row,
                      id: [row.platform, row.campaign_id, row.form_id].join(
                        ":",
                      ),
                    }))}
                    columns={[
                      {
                        key: "platform",
                        label: "Platform",
                        render: (r) => platformLabel(r.platform),
                      },
                      {
                        key: "campaign_name",
                        label: "Campaign",
                        render: (r) =>
                          r.campaign_name || r.campaign_id || "Unknown",
                      },
                      { key: "form_id", label: "Form" },
                      { key: "submissions", label: "Submissions" },
                      {
                        key: "customer_references",
                        label: "Distinct customers in group",
                      },
                    ]}
                  />
                </>
              )
            )}
          </>
        )}
      </section>
      {assignment && (
        <Assignment
          leads={assignment}
          names={assignment.map(
            (id) =>
              q.data?.data?.find((row) => row.lead_id === id)?.customer_name ||
              "Selected customer",
          )}
          onClose={() => setAssignment(null)}
          onSaved={(result) => {
            setAssignment(null);
            setSelection([]);
            qc.invalidateQueries({ queryKey: ["meta-inbox"] });
            qc.invalidateQueries({ queryKey: ["meta-summary"] });
            qc.invalidateQueries({ queryKey: ["leads"] });
            toast(`${result.assigned} customers assigned`);
          }}
        />
      )}
    </>
  );
}
