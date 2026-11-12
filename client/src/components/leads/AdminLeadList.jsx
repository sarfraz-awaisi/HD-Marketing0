import "../../styles/leads.css";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useUrlFilters } from "../../lib/useUrlFilters";
import { useLeadSelection } from "../../lib/useLeadSelection";
import { callOutcomes, followUpNotice } from "../../lib/calls";
import { firstCallState } from "../../lib/firstCall";
import { temperatureText } from "../../lib/temperature";
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
import { temperatureChoices } from "./PipelineParts";
// Administrators' All leads (update 057), built like an agent's Assigned
// leads: the database searches every lead by name or contact number (or an
// HD number written with HD), applies the filters together and counts and
// pages the result. # is the row's place in the list. Filters live in the
// address, so Back from a lead returns to the same list. Update 058: the
// temperature and the latest call's outcome, as in the Lead pipeline, in
// place of status and lost reason (still on each lead's page). Update 060:
// Assign to agent moves the selected leads to one agent, whoever has them,
// after confirming; Round-robin unassigned takes only leads with no agent.
// Update 062: Assign to agents gives them to one agent or shares them among
// chosen agents in turn, after a preview of who gets how many.
// First call: the names only are administrators' own; the values and what
// they match (update 038) are as in agents' Assigned leads.
const callLabels = {
  uncalled: "New",
  missed: "Not connected",
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
  "temperature",
  "call",
  "outcome",
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
  ...(f.temperature ? { temperature: f.temperature } : {}),
  ...(f.call ? { call: f.call } : {}),
  ...(f.outcome ? { outcome: f.outcome } : {}),
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
    ...(f.temperature
      ? [
          [
            `Temperature: ${temperatureText(f.temperature)}`,
            () => set({ temperature: null }),
          ],
        ]
      : []),
    ...(f.call
      ? [[`First call: ${callLabels[f.call]}`, () => set({ call: null })]]
      : []),
    ...(f.outcome
      ? [[`Latest call: ${f.outcome}`, () => set({ outcome: null })]]
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
          aria-label="Filter by temperature"
          value={f.temperature}
          onChange={(e) => set({ temperature: e.target.value })}
        >
          <option value="">All temperatures</option>
          {temperatureChoices.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
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
          aria-label="Filter by call outcome"
          value={f.outcome}
          onChange={(e) => set({ outcome: e.target.value })}
        >
          <option value="">All call outcomes</option>
          {callOutcomes.map((o) => (
            <option key={o} value={o}>
              {o}
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
                <Button onClick={() => setBulk({ mode: "distribute" })}>
                  Assign to agents
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
      {bulk &&
        (bulk.mode === "distribute" ? (
          <DistributeDialog
            ids={selection.ids}
            agents={activeAgents}
            onClose={() => setBulk(null)}
            onDone={(result) => {
              setBulk(null);
              setResults(result);
              selection.clear();
              done();
            }}
          />
        ) : (
          <BulkAssignDialog
            ids={selection.ids}
            onClose={() => setBulk(null)}
            onDone={(result) => {
              setBulk(null);
              setResults(result);
              selection.clear();
              done();
            }}
          />
        ))}
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

// Round-robin among all active agents for the selected leads that have no
// agent, after confirming; the database never takes a lead from an agent
// (update 057).
function BulkAssignDialog({ ids, onClose, onDone }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      onDone(
        await api("/leads/assign-unassigned", {
          method: "POST",
          body: { lead_ids: ids, mode: "round_robin" },
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
        Assign the selected leads that have no agent among active agents in turn
        (round-robin)? {plural(ids.length, "lead")} selected.
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

// The selected leads to one agent, or shared among chosen active agents in
// turn (update 062), whoever has them now. The preview, worked out by the
// database, changes nothing. Confirmed, the database works the plan out
// again under its assignment lock; if the leads or agents changed since the
// preview, nothing moves and the new plan comes back to confirm.
function DistributeDialog({ ids, agents, onClose, onDone }) {
  const [mode, setMode] = useState("one"),
    [search, setSearch] = useState(""),
    [chosen, setChosen] = useState([]),
    [asked, setAsked] = useState([]),
    [newer, setNewer] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // The preview follows the choice after a short pause, not every click.
  useEffect(() => {
    const t = setTimeout(() => setAsked(chosen), 300);
    return () => clearTimeout(t);
  }, [chosen]);
  const preview = useQuery({
    queryKey: ["lead-distribution", ids, asked],
    queryFn: ({ signal }) =>
      api("/leads/distribute/preview", {
        method: "POST",
        body: { lead_ids: ids, agent_ids: asked },
        signal,
      }),
    enabled: asked.length > 0,
    gcTime: 0,
  });
  const ready = asked.join() === chosen.join() && !preview.isFetching;
  const plan = newer || (chosen.length && ready ? preview.data : null);
  const words = search.trim().toLowerCase();
  const shown = agents.filter(
    (a) =>
      !words ||
      a.name.toLowerCase().includes(words) ||
      String(a.uid || "").includes(words),
  );
  const pick = (id) => {
    setNewer(null);
    setChosen((now) =>
      mode === "one"
        ? [id]
        : now.includes(id)
          ? now.filter((x) => x !== id)
          : [...now, id],
    );
  };
  const switchTo = (next) => {
    setNewer(null);
    setMode(next);
    if (next === "one") setChosen((now) => now.slice(0, 1));
  };
  async function confirm() {
    setBusy(true);
    setError("");
    try {
      const result = await api("/leads/distribute", {
        method: "POST",
        body: { lead_ids: ids, agent_ids: chosen, token: plan.token },
      });
      if (result.applied) return onDone(result);
      setNewer(result);
      setBusy(false);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  const moves = plan ? plan.assigned + plan.reassigned : 0;
  return (
    <Modal title="Assign the selected leads" onClose={() => !busy && onClose()}>
      <ErrorBox error={error || preview.error} />
      <p>
        {plural(ids.length, "lead")} selected. Leads that another agent has move
        too: their calls, notes and history stay with each lead, and pending
        follow-ups move with it.
      </p>
      <fieldset className="distribution-mode" disabled={busy}>
        <legend>How to assign</legend>
        <label className="checkbox-field">
          <input
            type="radio"
            name="distribution-mode"
            checked={mode === "one"}
            onChange={() => switchTo("one")}
          />
          One agent
        </label>
        <label className="checkbox-field">
          <input
            type="radio"
            name="distribution-mode"
            checked={mode === "turns"}
            onChange={() => switchTo("turns")}
          />
          Share among agents in turn (round-robin)
        </label>
      </fieldset>
      <input
        type="search"
        className="distribution-search"
        aria-label="Search agents"
        placeholder="Search active agents by name or UID"
        value={search}
        disabled={busy}
        onChange={(e) => setSearch(e.target.value)}
      />
      <div
        className="distribution-agents"
        role="group"
        aria-label="Active agents"
      >
        {shown.map((a) => (
          <label key={a.id} className="checkbox-field">
            <input
              type={mode === "one" ? "radio" : "checkbox"}
              name="distribution-agent"
              checked={chosen.includes(a.id)}
              disabled={busy}
              onChange={() => pick(a.id)}
            />
            {a.name} {a.uid && <small>UID {a.uid}</small>}
          </label>
        ))}
        {!shown.length && (
          <p className="lead-muted">No active agent matches your search.</p>
        )}
      </div>
      <p className="lead-muted">
        {chosen.length
          ? `${plural(chosen.length, "agent")} chosen.`
          : mode === "one"
            ? "Choose the agent."
            : "Choose the agents to share the leads among."}
        {mode === "turns" &&
          " Each gets an even share; leads already with one of them stay where their share allows."}
      </p>
      {newer && (
        <div role="alert" className="error">
          The leads or agents changed after the preview, so nothing was
          assigned. This is the updated plan: check it and assign again.
        </div>
      )}
      {chosen.length > 0 &&
        (plan ? (
          <DistributionSummary result={plan} preview />
        ) : (
          !preview.error && <Loader />
        ))}
      <footer>
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={busy || !plan || !moves} onClick={confirm}>
          {busy ? "Assigning…" : plan && !moves ? "Nothing to move" : "Assign"}
        </Button>
      </footer>
    </Modal>
  );
}

// Who gets how many (update 062): each agent's leads kept, newly assigned
// and moved in, and the total they end with, then where moved leads come
// from. A preview says it is worked out now and may change.
function DistributionSummary({ result, preview = false }) {
  const failed = result.results.filter((r) => r.result === "failed");
  return (
    <div className="distribution-summary">
      {preview && (
        <p className="pipeline-hint" role="note">
          Preview, worked out just now. If someone changes these leads or agents
          before you confirm, nothing moves and you see the updated plan first.
        </p>
      )}
      <p role="status">
        {preview ? "Plan: " : ""}
        {plural(result.assigned, "lead")} assigned ·{" "}
        {plural(result.reassigned, "lead")} reassigned ·{" "}
        {plural(result.skipped, "lead")} not changed ·{" "}
        {plural(result.failed, "lead")} failed
      </p>
      <div className="assignment-results">
        <Table
          rows={result.agents}
          columns={[
            { key: "name", label: "Agent" },
            { key: "kept", label: "Keeps" },
            { key: "assigned", label: "New" },
            { key: "reassigned", label: "Moved in" },
            { key: "total", label: "Total" },
          ]}
        />
      </div>
      {result.moved_from.length > 0 && (
        <p>
          Moved from:{" "}
          {result.moved_from.map((f) => `${f.name} (${f.count})`).join(", ")}
        </p>
      )}
      {preview && failed.length > 0 && (
        <div className="import-results assignment-results">
          <Table
            rows={failed}
            columns={[
              { key: "name", label: "Customer", render: (r) => r.name || "—" },
              { key: "reason", label: "Cannot be assigned" },
            ]}
          />
        </div>
      )}
    </div>
  );
}

const resultLabels = {
  assigned: "Assigned",
  reassigned: "Reassigned",
  skipped: "Not changed",
  failed: "Failed",
};
// Leads that moved from another agent are counted and listed apart (update
// 060); round-robin unassigned results have none. Shared leads (update 062)
// add each agent's counts.
function AssignmentResults({ result, onClose }) {
  const rows = result.results.filter((r) => r.result !== "assigned");
  return (
    <Modal title="Assignment results" onClose={onClose}>
      {result.agents ? (
        <DistributionSummary result={result} />
      ) : (
        <p role="status">
          {plural(result.assigned, "lead")} assigned ·{" "}
          {result.reassigned !== undefined &&
            `${plural(result.reassigned, "lead")} reassigned · `}
          {plural(result.skipped, "lead")} not changed ·{" "}
          {plural(result.failed, "lead")} failed
        </p>
      )}
      {rows.length > 0 && (
        <div className="import-results assignment-results">
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
