import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { fullDayLabel } from "../../lib/calendar";
import { Button, ErrorBox, Loader, Modal, useToast } from "../common/UI";
import "../../styles/kpis.css";
// Administrators' KPI list (update 070). Wording and order change at once;
// rules (frequency, answer type, target, on/off and agents) change from the
// next period, so earlier results keep the rules they were measured by. A
// KPI with answers is archived, not deleted.
const frequencyLabel = { day: "Daily", week: "Weekly" };
const typeLabel = { yes_no: "Yes / No", number: "Number" };
const targetText = (r) =>
  !r
    ? "—"
    : r.answer_type === "yes_no"
      ? "Yes"
      : `${r.target} a ${r.frequency === "week" ? "week" : "day"}`;
const blank = {
  title: "",
  question: "",
  description: "",
  frequency: "day",
  answer_type: "yes_no",
  target: "1",
  active: true,
  everyone: true,
  agent_ids: [],
};

function KpiForm({ kpi, agents, onClose, onSaved }) {
  const rules = kpi?.scheduled ?? kpi?.rules;
  const [form, setForm] = useState(
    kpi
      ? {
          title: kpi.title,
          question: kpi.question,
          description: kpi.description ?? "",
          frequency: rules.frequency,
          answer_type: rules.answer_type,
          target: String(rules.target),
          active: rules.active,
          everyone: !rules.agent_ids,
          agent_ids: rules.agent_ids ?? [],
        }
      : blank,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const number = form.answer_type === "number";
  const validTarget = !number || /^[1-9]\d{0,4}$/.test(form.target);
  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!form.everyone && !form.agent_ids.length)
      return setError("Choose at least one agent, or All agents.");
    const body = {
      title: form.title.trim(),
      question: form.question.trim(),
      description: form.description.trim() || null,
      frequency: form.frequency,
      answer_type: form.answer_type,
      target: number ? Number(form.target) : 1,
      active: form.active,
      agent_ids: form.everyone ? null : form.agent_ids,
    };
    setBusy(true);
    setError("");
    try {
      const result = await api(kpi ? `/kpis/${kpi.id}` : "/kpis", {
        method: kpi ? "PATCH" : "POST",
        body,
      });
      onSaved(result, !kpi);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title={kpi ? "Edit KPI" : "New KPI"} onClose={onClose}>
      <form className="form-grid kpi-edit" onSubmit={submit}>
        <label>
          Title
          <input
            required
            maxLength={80}
            value={form.title}
            onChange={(e) => set({ title: e.target.value })}
          />
        </label>
        <label>
          Question shown to agents
          <input
            required
            maxLength={300}
            value={form.question}
            onChange={(e) => set({ question: e.target.value })}
          />
        </label>
        <label>
          Description (optional)
          <textarea
            maxLength={500}
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </label>
        <label>
          Frequency
          <select
            value={form.frequency}
            onChange={(e) => set({ frequency: e.target.value })}
          >
            <option value="day">Daily</option>
            <option value="week">Weekly (daily entries add up)</option>
          </select>
        </label>
        <label>
          Answer type
          <select
            value={form.answer_type}
            onChange={(e) =>
              set({
                answer_type: e.target.value,
                target: e.target.value === "yes_no" ? "1" : form.target,
              })
            }
          >
            <option value="yes_no">Yes / No</option>
            <option value="number">Number</option>
          </select>
        </label>
        {number ? (
          <label>
            Target ({form.frequency === "week" ? "per week" : "per day"})
            <input
              inputMode="numeric"
              required
              value={form.target}
              aria-invalid={!validTarget}
              onChange={(e) => set({ target: e.target.value.trim() })}
            />
          </label>
        ) : (
          <p className="field-hint">Expected answer: Yes</p>
        )}
        <label className="check-label">
          <input
            type="checkbox"
            checked={form.active}
            onChange={(e) => set({ active: e.target.checked })}
          />
          Enabled
        </label>
        <fieldset className="kpi-agents">
          <legend>Agents</legend>
          <label className="check-label">
            <input
              type="radio"
              name="everyone"
              checked={form.everyone}
              onChange={() => set({ everyone: true })}
            />
            All agents
          </label>
          <label className="check-label">
            <input
              type="radio"
              name="everyone"
              checked={!form.everyone}
              onChange={() => set({ everyone: false })}
            />
            Selected agents
          </label>
          {!form.everyone && (
            <div className="kpi-agent-list">
              {agents.map((a) => (
                <label className="check-label" key={a.id}>
                  <input
                    type="checkbox"
                    checked={form.agent_ids.includes(a.id)}
                    onChange={(e) =>
                      set({
                        agent_ids: e.target.checked
                          ? [...form.agent_ids, a.id]
                          : form.agent_ids.filter((id) => id !== a.id),
                      })
                    }
                  />
                  {a.name}
                  {!a.active && " (disabled)"}
                </label>
              ))}
            </div>
          )}
        </fieldset>
        {kpi && (
          <p className="field-hint">
            New wording shows at once; answers already given keep theirs.
            Changes to the frequency, answer type, target, Enabled or agents
            start tomorrow for a daily KPI and next Monday for a weekly one, so
            earlier results are never recalculated.
          </p>
        )}
        <ErrorBox error={error} />
        <footer>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button disabled={busy || !validTarget}>
            {busy ? "Saving…" : kpi ? "Save changes" : "Create KPI"}
          </Button>
        </footer>
      </form>
    </Modal>
  );
}

export default function KpiManage() {
  const qc = useQueryClient(),
    toast = useToast();
  const [modal, setModal] = useState(null),
    [showArchived, setShowArchived] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const q = useQuery({
    queryKey: ["kpis", "manage"],
    queryFn: ({ signal }) => api("/kpis/manage", { signal }),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
  });
  const agents = (Array.isArray(users.data) ? users.data : []).filter(
    (u) => u.role === "agent",
  );
  const agentName = new Map(agents.map((a) => [a.id, a.name]));
  const all = q.data?.kpis || [];
  const kpis = all.filter((k) => !!k.archived_at === showArchived);
  const refresh = () => qc.invalidateQueries({ queryKey: ["kpis"] });
  // A change that started this period applies now; otherwise from a day.
  const from = (day) =>
    !day ? "" : day <= q.data?.today ? " now" : ` from ${fullDayLabel(day)}`;
  async function act(path, options, message) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(path, options);
      refresh();
      toast(message(result));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const status = (k) => {
    if (k.archived_at)
      return k.rules?.active ? "Archived (stops next period)" : "Archived";
    const parts = [k.rules?.active ? "Enabled" : "Off"];
    if (k.scheduled)
      parts.push(
        `Change waiting${from(k.scheduled.effective_from)}: ${frequencyLabel[k.scheduled.frequency]}, ${targetText(k.scheduled)}${k.scheduled.active ? "" : ", off"}`,
      );
    return parts.join(" · ");
  };
  return (
    <>
      <div className="kpi-manage-bar">
        <div className="review-tabs" role="tablist" aria-label="KPI list">
          {[
            [false, "Current KPIs"],
            [true, "Archived"],
          ].map(([value, label]) => (
            <button
              key={label}
              type="button"
              role="tab"
              aria-selected={showArchived === value}
              className={showArchived === value ? "active" : ""}
              onClick={() => setShowArchived(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <Button onClick={() => setModal({})}>+ New KPI</Button>
      </div>
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loader />
      ) : !kpis.length ? (
        <div className="panel empty">
          {showArchived ? "No archived KPIs." : "No KPIs yet. Add one."}
        </div>
      ) : (
        <section className="panel">
          <div className="table-scroll">
            <table className="kpi-manage-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>KPI</th>
                  <th>Frequency</th>
                  <th>Answer</th>
                  <th>Target</th>
                  <th>Agents</th>
                  <th>Status</th>
                  <th>Answers</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {kpis.map((k) => (
                  <tr key={k.id}>
                    <td>{k.position}</td>
                    <td>
                      <b>{k.title}</b>
                      <small className="kpi-sub">{k.question}</small>
                    </td>
                    <td>{frequencyLabel[k.rules?.frequency] ?? "—"}</td>
                    <td>{typeLabel[k.rules?.answer_type] ?? "—"}</td>
                    <td>{targetText(k.rules)}</td>
                    <td>
                      {!k.rules?.agent_ids
                        ? "All agents"
                        : k.rules.agent_ids
                            .map((id) => agentName.get(id) ?? "Agent")
                            .join(", ")}
                    </td>
                    <td>{status(k)}</td>
                    <td>{k.answers}</td>
                    <td className="kpi-actions">
                      {!k.archived_at && (
                        <Button
                          variant="secondary"
                          disabled={busy}
                          onClick={() => setModal({ kpi: k })}
                        >
                          Edit
                        </Button>
                      )}
                      <Button
                        variant="secondary"
                        disabled={busy}
                        aria-label={`${k.archived_at ? "Restore" : "Archive"} ${k.title}`}
                        onClick={() =>
                          act(
                            `/kpis/${k.id}/archive`,
                            {
                              method: "POST",
                              body: { archived: !k.archived_at },
                            },
                            (r) =>
                              `${k.archived_at ? "Restored" : "Archived"} ${k.title}${r.rules_from ? `; takes effect${from(r.rules_from)}` : ""}`,
                          )
                        }
                      >
                        {k.archived_at ? "Restore" : "Archive"}
                      </Button>
                      {k.answers === 0 && (
                        <Button
                          variant="danger"
                          disabled={busy}
                          aria-label={`Delete ${k.title}`}
                          onClick={() =>
                            window.confirm(
                              `Delete “${k.title}”? It has no answers.`,
                            ) &&
                            act(
                              `/kpis/${k.id}`,
                              { method: "DELETE" },
                              () => `Deleted ${k.title}`,
                            )
                          }
                        >
                          Delete
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
      <p className="field-hint">
        Earlier sales targets stay available in{" "}
        <Link to="/targets">Sales targets</Link>.
      </p>
      {modal && (
        <KpiForm
          kpi={modal.kpi}
          agents={agents}
          onClose={() => setModal(null)}
          onSaved={(result, created) => {
            setModal(null);
            refresh();
            toast(
              created
                ? `Created ${result.title}`
                : `Saved ${result.title}${result.rules_from ? `; the rules apply${from(result.rules_from)}` : ""}`,
            );
          }}
        />
      )}
    </>
  );
}
