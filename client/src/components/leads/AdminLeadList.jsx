import "../../styles/leads.css";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ListOrdered } from "lucide-react";
import { api, date } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { useUrlFilters } from "../../lib/useUrlFilters";
import { useLeadSelection } from "../../lib/useLeadSelection";
import {
  callOutcomes,
  followUpNotice,
  reassignableOutcomes,
} from "../../lib/calls";
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
import CountryFilter from "./CountryFilter";
import { countryLabel } from "../../lib/countries";
import { CustomerCell, LastCallCell } from "./LeadCells";
import { temperatureChoices } from "./PipelineParts";
import {
  LeadHistoryDialog,
  LeadUsageButton,
  LeadUsageFilter,
} from "./LeadUsage";
import { usageOption } from "../../lib/leadUsage";
import AgentFilter from "./AgentFilter";
import OutcomeFilter from "./OutcomeFilter";
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
// Update 063: Missed first call is no call in the current assignment by its
// deadline; Not connected (overdue) is no answered call in it, from anyone.
// Update 075: Lead Usage (next to Export) keeps the leads assigned to
// exactly that many different agents; Used N times in a lead's row opens its
// agent history.
// Update 082: Never called is, since update 083, no call outcome saved on
// the lead by anyone, whatever its deadline; the agent filter
// takes one agent, several or all of them (agent: their IDs, with commas).
// Assign to agents from a Never called list keeps with their agent the
// leads called since.
// Update 084: the Never assigned page is this list with only the search,
// the agent filter (here: never assigned to any of them) and the call
// outcome; its moves, one lead or many, go only to agents a lead has never
// had, checked again when confirmed.
// Update 088: Never assigned leaves out, in the database, the leads whose
// latest saved call outcome shows an agent working on them; its call outcome
// filter takes any of the other outcomes (outcomes: with commas).
const callLabels = {
  uncalled: "New",
  missed: "Missed first call",
  not_connected: "Not connected (overdue)",
  never_called: "Never called",
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
  "country",
  "usage",
  "page",
];
const neverKeys = ["q", "agent", "outcomes", "page"];
// What the database is asked for, from the address.
const query = (f, neverAssigned = false) =>
  neverAssigned
    ? {
        ...(f.q ? { search: f.q } : {}),
        ...(f.agent ? { never_assigned: f.agent } : {}),
        ...(f.outcomes ? { outcomes: f.outcomes } : {}),
        reassignable: "true",
      }
    : {
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
        ...(f.country ? { country: f.country } : {}),
        ...(f.usage ? { usage: f.usage } : {}),
      };
const plural = (n, one, many = one + "s") =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

// The list as the address asks for it. Lead Usage next to Export reads the
// same request, so its counts always match the list.
function useAdminLeads(neverAssigned = false) {
  const { user } = useAuth();
  const [f, change] = useUrlFilters(neverAssigned ? neverKeys : keys);
  const page = Math.max(1, Number(f.page) || 1);
  const params = new URLSearchParams({ ...query(f, neverAssigned), page });
  const q = useQuery({
    queryKey: ["leads", "all", user.id, params.toString()],
    queryFn: ({ signal }) => api("/leads/all?" + params, { signal }),
    // The current results stay while the next ones load.
    placeholderData: (previous) => previous,
  });
  return { f, change, page, q };
}

// Lead Usage, for the page heading next to Export.
export function AdminLeadUsage() {
  const { f, change, q } = useAdminLeads();
  return (
    <LeadUsageFilter
      value={f.usage}
      counts={q.data ? (q.data.usage ?? null) : undefined}
      onChange={(usage) => change({ usage, page: null })}
    />
  );
}

export default function AdminLeadList({ neverAssigned = false }) {
  const { user } = useAuth(),
    location = useLocation(),
    qc = useQueryClient(),
    toast = useToast();
  const back = location.pathname + location.search;
  const { f, change, page, q } = useAdminLeads(neverAssigned);
  const set = (values) => change({ ...values, page: null });
  const [dialLead, setDialLead] = useState(null),
    [assignLead, setAssignLead] = useState(null),
    [historyLead, setHistoryLead] = useState(null),
    [bulk, setBulk] = useState(null),
    [results, setResults] = useState(null),
    [deleteIds, setDeleteIds] = useState(null),
    [howMany, setHowMany] = useState(false),
    [firstCount, setFirstCount] = useState(""),
    [picked, setPicked] = useState(null),
    [error, setError] = useState("");
  const filters = new URLSearchParams(query(f, neverAssigned));
  // Update 087: any number of leads; what is done with them goes to the
  // database 500 at a time.
  const selection = useLeadSelection(filters.toString(), Infinity);
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
  const agentIds = f.agent ? f.agent.split(",") : [];
  const agentName = (id) => agents.find((a) => a.id === id)?.name || "agent";
  const agentNames =
    agentIds.length > 3
      ? plural(agentIds.length, "agent")
      : agentIds.map(agentName).join(", ");
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
            `${neverAssigned ? "Never assigned to" : "Assigned to"} ${agentNames}`,
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
    ...(f.outcomes
      ? [
          [
            `Latest call: ${f.outcomes.split(",").join(", ")}`,
            () => set({ outcomes: null }),
          ],
        ]
      : []),
    ...(f.source
      ? [[`Source: ${sourceLabel(f.source)}`, () => set({ source: null })]]
      : []),
    ...(f.import_id
      ? [[`File: ${fileName(f.import_id)}`, () => set({ import_id: null })]]
      : []),
    ...(f.country
      ? [[`Country: ${countryLabel(f.country)}`, () => set({ country: null })]]
      : []),
    ...(f.usage
      ? [[`Lead Usage: ${usageOption(f.usage)}`, () => set({ usage: null })]]
      : []),
  ];
  const reset = () =>
    change(
      Object.fromEntries(
        (neverAssigned ? neverKeys : keys).map((k) => [k, null]),
      ),
    );
  // Filters other than assignment, which the counts are about.
  const narrowed =
    chips.length > (!neverAssigned && (f.agent || f.assignment) ? 1 : 0);
  const totals = q.data?.totals;
  const assignment = f.agent ? "assigned" : f.assignment;
  // Update 087: once leads are selected, Choose how many keeps the first
  // leads of the list (#1 down), a quick pick or a number typed.
  const total = q.data?.count ?? 0;
  const quickPicks = [50, 100, 250, 500, 1000, 2000].filter((n) => n < total);
  const range =
    picked?.filter === filters.toString() && picked.n === selection.ids.length
      ? picked
      : null;
  async function selectFirst(n) {
    setError("");
    if (!Number.isInteger(n) || n < 1 || n > total)
      return setError(
        `Type a number from 1 to ${total.toLocaleString("en-US")}.`,
      );
    const params = new URLSearchParams(filters);
    params.set("first", n);
    try {
      const ids = (await api("/leads/all/selection?" + params)).ids;
      selection.replace(ids);
      setPicked({ filter: filters.toString(), n: ids.length, all: false });
      setHowMany(false);
      setFirstCount("");
    } catch (e) {
      setError(e.message);
    }
  }
  const clearSelection = () => {
    selection.clear();
    setPicked(null);
    setHowMany(false);
  };
  async function selectAll() {
    setError("");
    try {
      const ids = (await api("/leads/all/selection?" + filters)).ids;
      selection.replace(ids);
      setPicked({ filter: filters.toString(), n: ids.length, all: true });
      setHowMany(false);
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
        ].map(([value, label, n]) =>
          neverAssigned ? (
            <span key={label} className="temperature-count">
              {label} <b>{n ?? "…"}</b>
            </span>
          ) : (
            <button
              key={label}
              type="button"
              className="temperature-count"
              aria-pressed={!f.agent && (f.assignment || "") === value}
              onClick={() => set({ assignment: value || null, agent: null })}
            >
              {label} <b>{n ?? "…"}</b>
            </button>
          ),
        )}
      </div>
      <p className="pipeline-count-note">
        {narrowed
          ? "Counts of the leads matching your search and filters."
          : neverAssigned
            ? "Counts of every lead in the CRM no agent is working on, not in Deleted leads."
            : "Counts of every lead in the CRM, not in Deleted leads."}
      </p>
      <div className="toolbar lead-toolbar">
        <LeadSearch value={f.q} onSearch={(text) => set({ q: text })} />
        {!neverAssigned && (
          <select
            aria-label="Filter by assignment"
            value={assignment}
            onChange={(e) => set({ assignment: e.target.value, agent: null })}
          >
            <option value="">All leads</option>
            <option value="assigned">Assigned</option>
            <option value="unassigned">Unassigned</option>
          </select>
        )}
        <AgentFilter
          agents={agents}
          value={agentIds}
          onChange={(ids) =>
            set({ agent: ids.length ? ids.join(",") : null, assignment: null })
          }
        />
        {!neverAssigned && (
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
        )}
        {!neverAssigned && (
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
        )}
        {neverAssigned ? (
          <OutcomeFilter
            options={reassignableOutcomes}
            value={f.outcomes ? f.outcomes.split(",") : []}
            onChange={(list) =>
              set({ outcomes: list.length ? list.join(",") : null })
            }
          />
        ) : (
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
        )}
        {!neverAssigned && (
          <>
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
            <CountryFilter
              value={f.country}
              onChange={(country) => set({ country })}
            />
          </>
        )}
      </div>
      <ActiveFilters items={chips} onReset={reset} />
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loader />
      ) : q.error ? null : (
        <>
          <div className="lead-selection-tools">
            {q.data.count > 0 && (
              <div>
                <Button variant="secondary" onClick={selectAll}>
                  Select all {plural(q.data.count, "matching lead")}
                </Button>
              </div>
            )}
            {selection.ids.length > 0 && (
              <div
                className="bulk-action-bar"
                role="toolbar"
                aria-label="Selected lead actions"
              >
                <b>{plural(selection.ids.length, "lead")} selected</b>
                {range && (
                  <span className="selection-range">
                    {range.all
                      ? "All matching"
                      : `#1–#${range.n.toLocaleString("en-US")}`}
                  </span>
                )}
                <Button
                  variant="secondary"
                  className="how-many-toggle"
                  aria-expanded={howMany}
                  onClick={() => setHowMany((open) => !open)}
                >
                  <ListOrdered size={16} aria-hidden="true" />
                  Choose how many
                </Button>
                <Button onClick={() => setBulk({ mode: "distribute" })}>
                  Assign to agents
                </Button>
                {/* Round-robin among every agent could give a lead back to
                    an agent it had, so Never assigned leaves it out. */}
                {!neverAssigned && (
                  <Button
                    variant="secondary"
                    onClick={() => setBulk({ mode: "round_robin" })}
                  >
                    Round-robin unassigned
                  </Button>
                )}
                <Button
                  variant="danger"
                  onClick={() => setDeleteIds(selection.ids)}
                >
                  Delete
                </Button>
                <Button variant="secondary" onClick={clearSelection}>
                  Clear selection
                </Button>
                {howMany && (
                  <div
                    className="how-many-panel"
                    role="group"
                    aria-label="Choose how many leads"
                  >
                    <p>
                      Keep the first leads of the list, from #1 down, out of{" "}
                      {plural(total, "matching lead")}.
                    </p>
                    <div className="how-many-chips">
                      {quickPicks.map((n) => (
                        <button
                          key={n}
                          type="button"
                          className="how-many-chip"
                          aria-pressed={!!range && !range.all && range.n === n}
                          onClick={() => selectFirst(n)}
                        >
                          {n.toLocaleString("en-US")}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="how-many-chip"
                        aria-pressed={!!range?.all}
                        onClick={selectAll}
                      >
                        All {total.toLocaleString("en-US")}
                      </button>
                    </div>
                    <form
                      className="how-many-custom"
                      noValidate
                      onSubmit={(event) => {
                        event.preventDefault();
                        selectFirst(Number(firstCount));
                      }}
                    >
                      <input
                        type="number"
                        inputMode="numeric"
                        min="1"
                        max={total}
                        placeholder="Or type a number"
                        aria-label="Number of leads to select"
                        value={firstCount}
                        onChange={(e) => setFirstCount(e.target.value)}
                      />
                      <Button type="submit">Select</Button>
                    </form>
                  </div>
                )}
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
                  render: (r) => (
                    <span className="lead-owner-cell">
                      {r.assigned_agent ? (
                        <span>
                          {r.assigned_name}
                          {r.assigned_active ? "" : " (inactive)"}
                        </span>
                      ) : (
                        <span className="lead-muted">Unassigned</span>
                      )}
                      <LeadUsageButton lead={r} onOpen={setHistoryLead} />
                    </span>
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
          neverCalled={f.call === "never_called"}
          neverAssigned={neverAssigned}
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
            neverCalled={f.call === "never_called"}
            neverAssigned={neverAssigned}
            filterAgents={agentIds}
            filterLabel={agentNames}
            onClose={() => setBulk(null)}
            onDone={(result) => {
              setBulk(null);
              setResults(result);
              clearSelection();
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
              clearSelection();
              done();
            }}
          />
        ))}
      {results && (
        <AssignmentResults result={results} onClose={() => setResults(null)} />
      )}
      {historyLead && (
        <LeadHistoryDialog
          lead={historyLead}
          onClose={() => setHistoryLead(null)}
        />
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
            clearSelection();
            done(`${result.deleted} deleted, ${result.failed} kept`);
          }}
        />
      )}
    </section>
  );
}

// One lead: assign it if it has no agent (never taking it from one who got
// it meanwhile), or, once confirmed, move it to another agent or remove its
// agent with the usual assignment rules. From a Never called list (update
// 082) the move goes through Assign to agents' checks: it stops if the lead
// was called, marked Won or Lost, or moved since the list loaded. From the
// Never assigned page (update 084) likewise, and it stops if the lead has
// had that agent.
async function moveChecked(lead, agent, list) {
  const body = { lead_ids: [lead.id], agent_ids: [agent], [list]: true };
  const moving = lead.assigned_agent ? "reassigned" : "assigned";
  const plan = await api("/leads/distribute/preview", { method: "POST", body });
  const [row] = plan.results;
  if (row?.result === "reassigned" && row.from !== lead.assigned_agent)
    throw new Error(
      `${lead.name} moved to ${row.from_name || "another agent"} after this list loaded. Check the list again.`,
    );
  if (row?.result !== moving) throw new Error(row?.reason || `Not ${moving}`);
  const result = await api("/leads/distribute", {
    method: "POST",
    body: { ...body, token: plan.token },
  });
  if (!result.applied || result[moving] !== 1)
    throw new Error(
      `${lead.name} changed while you were reassigning it. Check the list again.`,
    );
  return { results: [{ result: "assigned" }] };
}
function AssignLeadDialog({
  lead,
  agents,
  neverCalled,
  neverAssigned,
  onClose,
  onDone,
}) {
  const [agent, setAgent] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const current = lead.assigned_agent;
  const choices = agents.filter((a) => a.id !== current);
  const had = new Set(neverAssigned ? lead.agents_had || [] : []);
  const checked = neverAssigned
    ? "never_assigned"
    : current && neverCalled
      ? "never_called"
      : null;
  async function save(mode) {
    setBusy(true);
    setError("");
    try {
      const result =
        checked && mode === "agent"
          ? await moveChecked(lead, agent, checked)
          : current
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
          ? `${lead.name} is assigned to ${lead.assigned_name}. Moving the lead takes it from ${lead.assigned_name}; its calls, notes and history stay with the lead for administrators. The new agent starts fresh, without ${lead.assigned_name}'s comments or results, and ${lead.assigned_name}'s pending follow-ups and scheduled visits on it are cancelled.`
          : `${lead.name} has no agent yet.`}
      </p>
      {neverAssigned && (
        <p className="pipeline-hint" role="note">
          Only agents {lead.name} has never had can be chosen; the CRM checks
          again when you confirm.
        </p>
      )}
      <label>
        {current ? "Move to" : "Assign to"}
        <select
          value={agent}
          disabled={busy}
          onChange={(e) => setAgent(e.target.value)}
        >
          <option value="">Choose an active agent</option>
          {choices.map((a) => (
            <option key={a.id} value={a.id} disabled={had.has(a.id)}>
              {a.name}
              {had.has(a.id) ? " (had this lead)" : ""}
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
          !neverAssigned && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => save("round_robin")}
            >
              Round-robin
            </Button>
          )
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
// preview, nothing moves and the new plan comes back to confirm. From a
// Never called list (update 082) the leads their agent has called since stay
// with that agent. From the Never assigned page (update 084) each lead goes
// only to a chosen agent it has never had; the agents chosen here are the
// ones who receive leads, whoever the page is filtered by.
function DistributeDialog({
  ids,
  agents,
  neverCalled,
  neverAssigned,
  filterAgents = [],
  filterLabel = "",
  onClose,
  onDone,
}) {
  const list = neverAssigned
    ? { never_assigned: true }
    : neverCalled
      ? { never_called: true }
      : {};
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
    queryKey: ["lead-distribution", ids, asked, list],
    queryFn: ({ signal }) =>
      api("/leads/distribute/preview", {
        method: "POST",
        body: {
          lead_ids: ids,
          agent_ids: asked,
          ...list,
        },
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
  // The page's filter agents, chosen as receivers only when asked.
  const filtered = filterAgents.filter((id) => agents.some((a) => a.id === id));
  const chooseFiltered = () => {
    setNewer(null);
    setMode(filtered.length > 1 ? "turns" : "one");
    setChosen(filtered);
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
        body: {
          lead_ids: ids,
          agent_ids: chosen,
          token: plan.token,
          ...list,
        },
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
        too: their calls, notes and history stay with each lead for
        administrators, and the new agent starts fresh. The earlier agent&apos;s
        pending follow-ups and scheduled visits on those leads are cancelled.
      </p>
      {neverAssigned && (
        <div className="pipeline-hint" role="note">
          <p>
            {filterAgents.length
              ? `Page filter: leads never assigned to ${filterLabel}. `
              : "Page filter: any agent. "}
            The agents you choose below receive the leads, and they need not be
            the filter&apos;s agents. Each lead goes only to a chosen agent it
            has never had; a lead that had every chosen agent, or is marked Won
            or Lost, stays where it is.
          </p>
          {filtered.length > 0 && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={chooseFiltered}
            >
              Choose the filtered agents
            </Button>
          )}
        </div>
      )}
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
      {busy && ids.length > 500 && (
        <p className="lead-muted" role="status">
          Assigning {plural(ids.length, "lead")}, 500 at a time. Keep this
          window open.
        </p>
      )}
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
// From a Never called list, leads called since are counted and listed as
// kept with their agent (update 082); from Never assigned, leads with no
// chosen agent they have never had, and Won or Lost leads (update 084).
function DistributionSummary({ result, preview = false }) {
  const failed = result.results.filter((r) =>
    ["failed", "kept"].includes(r.result),
  );
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
        {result.kept > 0 &&
          ` · ${plural(result.kept, "lead")} ${result.never_assigned ? "kept where they are" : "kept (called since)"}`}
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
  kept: "Kept with agent",
};
// Leads that moved from another agent are counted and listed apart (update
// 060); round-robin unassigned results have none. Shared leads (update 062)
// add each agent's counts.
function AssignmentResults({ result, onClose }) {
  const rows = result.results.filter((r) => r.result !== "assigned");
  return (
    <Modal title="Assignment results" onClose={onClose}>
      {/* Updates 086 and 087: a part that changed while a large selection
          was being assigned, and the parts after it, were not assigned. */}
      {result.partial && (
        <div role="alert" className="error">
          Not every lead was assigned: some changed, or the CRM could not
          finish, so they and the leads after them are listed below as failed.
          Check them and assign them again.
        </div>
      )}
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
