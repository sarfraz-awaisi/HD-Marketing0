import "../../styles/leads.css";
import { useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useUrlFilters } from "../../lib/useUrlFilters";
import { useLeadSelection } from "../../lib/useLeadSelection";
import { followUpNotice } from "../../lib/calls";
import { firstCallState } from "../../lib/firstCall";
import {
  statuses,
  statusLabel,
  lostReasons,
  lostReasonLabel,
} from "../../lib/pipeline";
import {
  Button,
  ErrorBox,
  Loader,
  Modal,
  Pagination,
  Table,
  useToast,
} from "../common/UI";
import LeadPhone from "./LeadPhone";
import CallDialog from "../calls/CallDialog";
import DeleteLeadsDialog from "./DeleteLeadsDialog";
import { ActiveFilters, LeadSearch } from "./LeadSearch";
import { CustomerCell, LastCallCell } from "./LeadCells";
// Administrators' All leads (update 057), built like an agent's Assigned
// leads: the database searches every lead by name or contact number (or an
// HD number written with HD), applies the filters together and counts and
// pages the result. # is the row's place in the list. Filters live in the
// address, so Back from a lead returns to the same list. Bulk assignment
// takes only leads with no agent; moving a lead from its agent is done one
// lead at a time, after confirming.
const callLabels = {
  uncalled: "Waiting for first call",
  missed: "Missed first call",
};
const sources = [
  ["manual", "Manual"],
  ["CSV", "CSV / Excel"],
  ["Meta", "Meta"],
  ["WhatsApp", "WhatsApp"],
  ["other", "Other"],
];
const sourceLabel = (value) => sources.find(([v]) => v === value)?.[1];
const keys = [
  "q",
  "assignment",
  "agent",
  "call",
  "status",
  "lost",
  "source",
  "import_id",
  "page",
];
// What the database is asked for, from the address.
const query = (f) => ({
  ...(f.q ? { search: f.q } : {}),
  ...(f.agent
    ? { agent: f.agent }
    : f.assignment
      ? { assignment: f.assignment }
      : {}),
  ...(f.call ? { call: f.call } : {}),
  ...(f.status ? { status: f.status } : {}),
  ...(f.lost ? { lost_reason: f.lost } : {}),
  ...(f.source ? { source: f.source } : {}),
  ...(f.import_id ? { import_id: f.import_id } : {}),
});
const plural = (n, one, many = one + "s") =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function AdminLeadList() {
  const { user } = useAuth(),
    location = useLocation(),
    qc = useQueryClient(),
    toast = useToast();
  const back = location.pathname + location.search;
  const [f, change] = useUrlFilters(keys);
  const page = Math.max(1, Number(f.page) || 1);
  const set = (values) => change({ ...values, page: null });
  const [dialLead, setDialLead] = useState(null),
    [assignLead, setAssignLead] = useState(null),
    [bulk, setBulk] = useState(null),
    [results, setResults] = useState(null),
    [deleteIds, setDeleteIds] = useState(null),
    [targetAgent, setTargetAgent] = useState(""),
    [error, setError] = useState("");
  const filters = new URLSearchParams(query(f));
  const params = new URLSearchParams({ ...query(f), page });
  const selection = useLeadSelection(filters.toString());
  const q = useQuery({
    queryKey: ["leads", "all", user.id, params.toString()],
    queryFn: ({ signal }) => api("/leads/all?" + params, { signal }),
    // The current results stay while the next ones load.
    placeholderData: (previous) => previous,
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const files = useQuery({
    queryKey: ["lead-imports", user.id, user.role, "filter"],
    queryFn: ({ signal }) => api("/lead-imports?limit=100", { signal }),
  });
  // A file from a link that is not among the latest 100 still has its name.
  const file = useQuery({
    queryKey: ["lead-import", user.id, user.role, f.import_id],
    queryFn: ({ signal }) => api("/lead-imports/" + f.import_id, { signal }),
    enabled:
      !!f.import_id &&
      !!files.data &&
      !files.data.data?.some((x) => x.id === f.import_id),
  });
  const agents = (Array.isArray(users.data) ? users.data : []).filter(
    (a) => a.role === "agent",
  );
  const activeAgents = agents.filter((a) => a.active);
  const agentName = (id) => agents.find((a) => a.id === id)?.name || "agent";
  const fileOptions = [
    ...(files.data?.data || []),
    ...(file.data ? [file.data] : []),
  ];
  const fileName = (id) =>
    fileOptions.find((x) => x.id === id)?.file_name || "Selected file";
  const chips = [
    ...(f.q ? [[`Search: ${f.q}`, () => set({ q: null })]] : []),
    ...(f.agent
      ? [
          [
            `Assigned to ${agentName(f.agent)}`,
            () => set({ agent: null, assignment: null }),
          ],
        ]
      : f.assignment
        ? [
            [
              f.assignment === "assigned" ? "Assigned" : "Unassigned",
              () => set({ assignment: null }),
            ],
          ]
        : []),
    ...(f.call ? [[callLabels[f.call], () => set({ call: null })]] : []),
    ...(f.status
      ? [
          [
            `Status: ${statusLabel(f.status)}`,
            () => set({ status: null, lost: null }),
          ],
        ]
      : []),
    ...(f.lost
      ? [[`Lost: ${lostReasonLabel(f.lost)}`, () => set({ lost: null })]]
      : []),
    ...(f.source
      ? [[`Source: ${sourceLabel(f.source)}`, () => set({ source: null })]]
      : []),
    ...(f.import_id
      ? [[`File: ${fileName(f.import_id)}`, () => set({ import_id: null })]]
      : []),
  ];
  const reset = () => change(Object.fromEntries(keys.map((k) => [k, null])));
  // Filters other than assignment, which the counts are about.
  const narrowed = chips.length > (f.agent || f.assignment ? 1 : 0);
  const totals = q.data?.totals;
  const assignment = f.agent ? "agent:" + f.agent : f.assignment;
  async function selectAll() {
    setError("");
    try {
      selection.replace((await api("/leads/all/selection?" + filters)).ids);
    } catch (e) {
      setError(e.message);
    }
  }
  const done = (message) => {
    invalidateWorkspace(qc);
    if (message) toast(message);
  };
  return (
    <section className="panel admin-leads">
      <div className="pipeline-stats" role="group" aria-label="Lead counts">
        {[
          ["", "Total", totals?.total],
          ["assigned", "Assigned", totals?.assigned],
          ["unassigned", "Unassigned", totals?.unassigned],
        ].map(([value, label, n]) => (
          <button
            key={label}
            type="button"
            className="temperature-count"
            aria-pressed={!f.agent && (f.assignment || "") === value}
            onClick={() => set({ assignment: value || null, agent: null })}
          >
            {label} <b>{n ?? "…"}</b>
          </button>
        ))}
      </div>
      <p className="pipeline-count-note">
        {narrowed
          ? "Counts of the leads matching your search and filters."
          : "Counts of every lead in the CRM, not in Deleted leads."}
      </p>
      <div className="toolbar lead-toolbar">
        <LeadSearch value={f.q} onSearch={(text) => set({ q: text })} />
        <select
          aria-label="Filter by assignment"
          value={assignment}
          onChange={(e) => {
            const v = e.target.value;
            set(
              v.startsWith("agent:")
                ? { agent: v.slice(6), assignment: null }
                : { assignment: v, agent: null },
            );
          }}
        >
          <option value="">All leads</option>
          <option value="assigned">Assigned</option>
          <option value="unassigned">Unassigned</option>
          <optgroup label="Assigned to">
            {agents.map((a) => (
              <option key={a.id} value={"agent:" + a.id}>
                {a.name}
                {a.active ? "" : " (inactive)"}
              </option>
            ))}
          </optgroup>
        </select>
        <select
          aria-label="Filter by first call"
          value={f.call}
          onChange={(e) => set({ call: e.target.value })}
        >
          <option value="">Any first-call state</option>
          {Object.entries(callLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by status"
          value={f.status}
          onChange={(e) =>
            set({
              status: e.target.value,
              ...(e.target.value !== "lost" ? { lost: null } : {}),
            })
          }
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
          value={f.lost}
          onChange={(e) =>
            set({
              lost: e.target.value,
              status: e.target.value ? "lost" : null,
            })
          }
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
          value={f.source}
          onChange={(e) => set({ source: e.target.value })}
        >
          <option value="">All sources</option>
          {sources.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter by lead file"
          value={f.import_id}
          onChange={(e) => set({ import_id: e.target.value })}
        >
          <option value="">All lead files</option>
          {fileOptions.map((x) => (
            <option key={x.id} value={x.id}>
              {x.file_name}
              {x.file_format === "sheets" ? " (Google Sheets)" : ""}
            </option>
          ))}
        </select>
      </div>
      <ActiveFilters items={chips} onReset={reset} />
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.error ? null : (
        <>
          <div className="lead-selection-tools">
            {q.data.count > 500 ? (
              <span className="lead-muted">
                Narrow your search or filters to select all matching leads (500
                at most).
              </span>
            ) : (
              q.data.count > 0 && (
                <Button variant="secondary" onClick={selectAll}>
                  Select all {plural(q.data.count, "matching lead")}
                </Button>
              )
            )}
            {selection.ids.length > 0 && (
              <div
                className="bulk-action-bar"
                role="toolbar"
                aria-label="Selected lead actions"
              >
                <b>{plural(selection.ids.length, "lead")} selected</b>
                <select
                  aria-label="Agent for the selected unassigned leads"
                  value={targetAgent}
                  onChange={(e) => setTargetAgent(e.target.value)}
                >
                  <option value="">Choose an active agent</option>
                  {activeAgents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
                <Button
                  disabled={!targetAgent}
                  onClick={() => setBulk({ mode: "agent", agent: targetAgent })}
                >
                  Assign unassigned
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => setBulk({ mode: "round_robin" })}
                >
                  Round-robin unassigned
                </Button>
                <Button
                  variant="danger"
                  onClick={() => setDeleteIds(selection.ids)}
                >
                  Delete
                </Button>
                <Button variant="secondary" onClick={selection.clear}>
                  Clear selection
                </Button>
              </div>
            )}
          </div>
          <div className="admin-lead-table">
            <Table
              showSerial
              page={q.data.page ?? page}
              count={q.data.count}
              selection={selection}
              rows={q.data.data}
              empty={
                chips.length
                  ? "No leads match your search or filters. Reset filters to see every lead."
                  : "No leads yet. Import a CSV or Excel file, add a lead, or turn on a Google Sheet."
              }
              columns={[
                {
                  key: "name",
                  label: "Customer name",
                  render: (r) => (
                    <CustomerCell lead={r} back={back} email={false} />
                  ),
                },
                {
                  key: "phone",
                  label: "Phone number",
                  render: (r) => <LeadPhone lead={r} onCall={setDialLead} />,
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
                  key: "assigned_agent",
                  label: "Assigned to",
                  render: (r) =>
                    r.assigned_agent ? (
                      <span>
                        {r.assigned_name}
                        {r.assigned_active ? "" : " (inactive)"}
                      </span>
                    ) : (
                      <span className="lead-muted">Unassigned</span>
                    ),
                },
                {
                  key: "last_call",
                  label: "Last contact",
                  render: (r) => <LastCallCell lead={r} />,
                },
                {
                  key: "actions",
                  label: "Actions",
                  // Deleting is a selected-leads action, with its own
                  // confirmation; editing is on the lead's page.
                  render: (r) => (
                    <Button
                      variant="secondary"
                      aria-label={`${r.assigned_agent ? "Reassign" : "Assign"} ${r.name}`}
                      onClick={() => setAssignLead(r)}
                    >
                      {r.assigned_agent ? "Reassign" : "Assign"}
                    </Button>
                  ),
                },
              ]}
            />
          </div>
          <Pagination
            page={q.data.page ?? page}
            count={q.data.count}
            onPage={(p) => change({ page: p > 1 ? p : null })}
          />
        </>
      )}
      {assignLead && (
        <AssignLeadDialog
          lead={assignLead}
          agents={activeAgents}
          onClose={() => setAssignLead(null)}
          onDone={(message) => {
            setAssignLead(null);
            done(message);
          }}
        />
      )}
      {bulk && (
        <BulkAssignDialog
          ids={selection.ids}
          mode={bulk.mode}
          agent={bulk.mode === "agent" ? agentName(bulk.agent) : null}
          agentId={bulk.agent}
          onClose={() => setBulk(null)}
          onDone={(result) => {
            setBulk(null);
            setResults(result);
            selection.clear();
            done();
          }}
        />
      )}
      {results && (
        <AssignmentResults result={results} onClose={() => setResults(null)} />
      )}
      {dialLead && (
        <CallDialog
          lead={dialLead}
          role={user.role}
          onClose={() => setDialLead(null)}
          onSaved={(result) => {
            setDialLead(null);
            done(followUpNotice(result, date) || "Call saved");
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
            done(`${result.deleted} deleted, ${result.failed} kept`);
          }}
        />
      )}
    </section>
  );
}

// One lead: assign it if it has no agent (never taking it from one who got
// it meanwhile), or, once confirmed, move it to another agent or remove its
// agent with the usual assignment rules.
function AssignLeadDialog({ lead, agents, onClose, onDone }) {
  const [agent, setAgent] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const current = lead.assigned_agent;
  const choices = agents.filter((a) => a.id !== current);
  async function save(mode) {
    setBusy(true);
    setError("");
    try {
      const result = current
        ? await api("/leads/assign-bulk", {
            method: "POST",
            body: {
              lead_ids: [lead.id],
              mode,
              ...(mode === "agent" ? { agent_id: agent } : {}),
            },
          })
        : await api("/leads/assign-unassigned", {
            method: "POST",
            body: {
              lead_ids: [lead.id],
              mode,
              ...(mode === "agent" ? { agent_id: agent } : {}),
            },
          });
      const [row] = result.results;
      if (row?.result !== "assigned")
        throw new Error(row?.reason || "Not assigned");
      onDone(
        mode === "unassign"
          ? `${lead.name} no longer has an agent`
          : `${lead.name} ${current ? "reassigned" : "assigned"}`,
      );
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal
      title={`${current ? "Reassign" : "Assign"} ${lead.name}`}
      onClose={() => !busy && onClose()}
    >
      <ErrorBox error={error} />
      <p>
        {current
          ? `${lead.name} is assigned to ${lead.assigned_name}. Moving the lead takes it from ${lead.assigned_name}; its calls, notes and history stay with the lead.`
          : `${lead.name} has no agent yet.`}
      </p>
      <label>
        {current ? "Move to" : "Assign to"}
        <select
          value={agent}
          disabled={busy}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="">Choose an active agent</option>
          {choices.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </label>
      <footer>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        {current ? (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => save("unassign")}
          >
            Remove agent
          </Button>
        ) : (
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => save("round_robin")}
          >
            Round-robin
          </Button>
        )}
        <Button disabled={busy || !agent} onClick={() => save("agent")}>
          {busy ? "Saving…" : current ? "Reassign" : "Assign"}
        </Button>
      </footer>
    </Modal>
  );
}

// Selected leads to one agent or round-robin, after confirming; leads with
// an agent are skipped by the database and named in the results.
function BulkAssignDialog({ ids, mode, agent, agentId, onClose, onDone }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      onDone(
        await api("/leads/assign-unassigned", {
          method: "POST",
          body: {
            lead_ids: ids,
            mode,
            ...(mode === "agent" ? { agent_id: agentId } : {}),
          },
        }),
      );
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <Modal title="Assign the selected leads" onClose={() => !busy && onClose()}>
      <ErrorBox error={error} />
      <p>
        Assign the selected leads that have no agent{" "}
        {mode === "agent"
          ? `to ${agent}`
          : "among active agents in turn (round-robin)"}
        ? {plural(ids.length, "lead")} selected.
      </p>
      <p>
        Leads that already have an agent stay with that agent and are listed in
        the results.
      </p>
      <footer>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy} onClick={confirm}>
          {busy ? "Assigning…" : "Assign"}
        </Button>
      </footer>
    </Modal>
  );
}

const resultLabels = {
  assigned: "Assigned",
  skipped: "Not changed",
  failed: "Failed",
};
function AssignmentResults({ result, onClose }) {
  const rows = result.results.filter((r) => r.result !== "assigned");
  return (
    <Modal title="Assignment results" onClose={onClose}>
      <p role="status">
        {plural(result.assigned, "lead")} assigned ·{" "}
        {plural(result.skipped, "lead")} not changed ·{" "}
        {plural(result.failed, "lead")} failed
      </p>
      {rows.length > 0 && (
        <div className="import-results">
          <Table
            rows={rows}
            columns={[
              { key: "name", label: "Customer", render: (r) => r.name || "—" },
              {
                key: "result",
                label: "Result",
                render: (r) => resultLabels[r.result],
              },
              {
                key: "reason",
                label: "Reason",
                render: (r) => r.reason || "—",
              },
            ]}
          />
        </div>
      )}
      <footer>
        <Button onClick={onClose}>Done</Button>
      </footer>
    </Modal>
  );
}
