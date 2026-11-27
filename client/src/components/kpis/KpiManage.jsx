import { useEffect, useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { addDays, fullDayLabel } from "../../lib/calendar";
import { measured, measureLabels } from "../../lib/kpiPeriods";
import {
  frequencyLabel,
  per,
  rulesProblem,
  rulesStart,
  targetText,
  typeLabel,
} from "../../lib/kpiRules";
import { Button, ErrorBox, Loader, Modal, useToast } from "../common/UI";
import "../../styles/kpis.css";
// Administrators' KPI list (update 070). Wording and order change at once;
// rules (frequency, answer type, target, on/off and agents) change from the
// next period, so earlier results keep the rules they were measured by. A
// KPI with answers is archived, not deleted.
// Update 076: every KPI's frequency, answer type and target can change,
// including those the CRM fills in, within what its records can measure
// (the server's sources; anything else shows why). A Yes/No KPI has an
// expected answer. The form says when new rules start before saving, and a
// change of frequency or answer type is confirmed first. The list is a
// compact table on wide screens and cards on narrow ones.
const blank = {
  title: "",
  question: "",
  description: "",
  frequency: "day",
  answer_type: "yes_no",
  target: "1",
  expected: "yes",
  active: true,
  everyone: true,
  agent_ids: [],
};
const validNumber = (v) => /^[1-9]\d{0,4}$/.test(v) && Number(v) <= 10000;

function KpiForm({ kpi, list, agents, onClose, onSaved }) {
  const current = kpi?.rules;
  // A waiting change is what the form starts from.
  const rules = kpi?.scheduled ?? current;
  const measure = rules?.measure ?? "self";
  const source = list.sources?.[measure];
  const auto = measure !== "self";
  const [form, setForm] = useState(
    kpi
      ? {
          title: kpi.title,
          question: kpi.question,
          description: kpi.description ?? "",
          frequency: rules.frequency,
          answer_type: rules.answer_type,
          target: String(rules.target),
          expected: rules.expected ?? "yes",
          active: rules.active,
          everyone: !rules.agent_ids,
          agent_ids: rules.agent_ids ?? [],
        }
      : blank,
  );
  const [busy, setBusy] = useState(false),
    [confirming, setConfirming] = useState(false),
    [error, setError] = useState("");
  const id = useId();
  const confirmHeading = useRef(null);
  useEffect(() => {
    if (confirming) confirmHeading.current?.focus();
  }, [confirming]);
  const set = (patch) => {
    setError("");
    setForm((f) => ({ ...f, ...patch }));
  };
  const number = form.answer_type === "number";
  // A number target is per day or per week: another frequency or answer
  // type needs a target chosen for it, never one carried over silently.
  const keptTarget = (frequency, answer_type) =>
    answer_type !== "number"
      ? "1"
      : kpi && rules.answer_type === "number" && rules.frequency === frequency
        ? String(rules.target)
        : kpi
          ? ""
          : form.target;
  const can = (key, value) => !source || source[key].includes(value);
  const next = {
    frequency: form.frequency,
    answer_type: form.answer_type,
    target: number ? Number(form.target) : 1,
    expected: number ? null : form.expected,
    active: form.active,
    agent_ids: form.everyone ? null : form.agent_ids,
  };
  const validTarget = !number || validNumber(form.target);
  const problem = validTarget
    ? rulesProblem(list.sources, measure, next)
    : null;
  const start = validTarget ? rulesStart(list, kpi, next) : null;
  const switching =
    !!kpi &&
    (form.frequency !== current.frequency ||
      form.answer_type !== current.answer_type);
  const max = number && source?.max?.[form.frequency];
  const body = () => ({
    title: form.title.trim(),
    question: form.question.trim(),
    description: form.description.trim() || null,
    frequency: form.frequency,
    answer_type: form.answer_type,
    target: next.target,
    ...(number ? {} : { expected: form.expected }),
    active: form.active,
    agent_ids: next.agent_ids,
  });
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await api(kpi ? `/kpis/${kpi.id}` : "/kpis", {
        method: kpi ? "PATCH" : "POST",
        body: body(),
      });
      onSaved(result, !kpi);
    } catch (err) {
      setError(err.message);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }
  function submit(e) {
    e.preventDefault();
    if (busy) return;
    if (!form.everyone && !form.agent_ids.length)
      return setError("Choose at least one agent, or All agents.");
    if (!validTarget)
      return setError(
        `Enter a whole number from 1 to 10,000 as the target per ${per(form.frequency)}.`,
      );
    if (problem) return setError(problem);
    // A change of frequency or answer type is confirmed first.
    if (switching && !confirming) return setConfirming(true);
    save();
  }
  const firstWeek =
    start?.date && !start.now && next.frequency === "week"
      ? `${fullDayLabel(start.date)} to ${fullDayLabel(addDays(start.date, 6))}`
      : null;
  const when = !start
    ? kpi
      ? "Only the wording changes. It shows at once; answers already given keep the question they were given."
      : null
    : start.cancels
      ? `These are the rules in effect now, so saving cancels the change waiting from ${fullDayLabel(start.cancels)}.`
      : start.keeps
        ? `The change waiting from ${fullDayLabel(start.date)} stays as it is.`
        : !kpi
          ? next.frequency === "week"
            ? `Starts this week, ${fullDayLabel(start.date)}.`
            : "Starts today."
          : start.now
            ? "These rules apply now: no one has answered under today's rules yet."
            : `New rules start ${fullDayLabel(start.date)} (Pakistan time). Until then: ${frequencyLabel[current.frequency]}, ${targetText(current)}. Earlier days and weeks keep their results.`;
  return (
    <Modal
      title={kpi ? "Edit KPI" : "New KPI"}
      className="kpi-form-dialog"
      onClose={() => !busy && onClose()}
    >
      <form className="kpi-form" onSubmit={submit} noValidate>
        {confirming ? (
          <section className="kpi-confirm" aria-labelledby={`${id}-confirm`}>
            <h3 id={`${id}-confirm`} ref={confirmHeading} tabIndex={-1}>
              Confirm the new rules for {form.title.trim() || kpi.title}
            </h3>
            <dl>
              <div>
                <dt>Now</dt>
                <dd>
                  {frequencyLabel[current.frequency]},{" "}
                  {typeLabel[current.answer_type]}, {targetText(current)}
                </dd>
              </div>
              <div>
                <dt>From {fullDayLabel(start.date)}</dt>
                <dd>
                  {frequencyLabel[next.frequency]},{" "}
                  {typeLabel[next.answer_type]}, {targetText(next)}
                </dd>
              </div>
              {firstWeek && (
                <div>
                  <dt>First weekly period</dt>
                  <dd>{firstWeek}</dd>
                </div>
              )}
              {auto && (
                <div>
                  <dt>Counted from</dt>
                  <dd>
                    {next.answer_type === "number"
                      ? `The CRM: ${source.counts}`
                      : `The CRM: Yes when ${source.yes.toLowerCase()}`}
                  </dd>
                </div>
              )}
            </dl>
            <p className="field-hint">
              Results before {fullDayLabel(start.date)} keep the rules they were
              measured by. Nothing already recorded is changed.
            </p>
          </section>
        ) : (
          <>
            <fieldset className="kpi-form-section">
              <legend>Wording</legend>
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
                <textarea
                  required
                  rows={2}
                  maxLength={300}
                  value={form.question}
                  onChange={(e) => set({ question: e.target.value })}
                />
              </label>
              <label>
                Description (optional)
                <textarea
                  rows={3}
                  maxLength={500}
                  value={form.description}
                  onChange={(e) => set({ description: e.target.value })}
                />
              </label>
            </fieldset>
            <fieldset className="kpi-form-section">
              <legend>Rules</legend>
              {auto && (
                <p className="field-hint kpi-source">
                  Filled in by the CRM from{" "}
                  {measureLabels[measure].replace(/^CRM: /, "")}. Agents cannot
                  answer or change it.
                </p>
              )}
              <div className="kpi-form-row">
                <div className="kpi-field">
                  <label>
                    Frequency
                    <select
                      value={form.frequency}
                      aria-describedby={`${id}-frequency`}
                      onChange={(e) =>
                        set({
                          frequency: e.target.value,
                          target: keptTarget(e.target.value, form.answer_type),
                        })
                      }
                    >
                      <option value="day" disabled={!can("frequencies", "day")}>
                        Daily
                      </option>
                      <option
                        value="week"
                        disabled={!can("frequencies", "week")}
                      >
                        Weekly (Monday to Sunday)
                      </option>
                    </select>
                  </label>
                  <small className="field-hint" id={`${id}-frequency`}>
                    {!can("frequencies", "week")
                      ? `Weekly is not available: ${source.reasons.week}`
                      : form.frequency === "week"
                        ? "Each day's results add up over the week."
                        : "Each Pakistan day is judged on its own."}
                  </small>
                </div>
                <div className="kpi-field">
                  <label>
                    Answer type
                    <select
                      value={form.answer_type}
                      aria-describedby={`${id}-type`}
                      onChange={(e) =>
                        set({
                          answer_type: e.target.value,
                          target: keptTarget(form.frequency, e.target.value),
                        })
                      }
                    >
                      <option
                        value="yes_no"
                        disabled={!can("answer_types", "yes_no")}
                      >
                        Yes / No
                      </option>
                      <option
                        value="number"
                        disabled={!can("answer_types", "number")}
                      >
                        Number
                      </option>
                    </select>
                  </label>
                  <small className="field-hint" id={`${id}-type`}>
                    {!can("answer_types", "number")
                      ? `Number is not available: ${source.reasons.number}`
                      : auto && number
                        ? `Counts ${source.counts}.`
                        : auto
                          ? `Yes when: ${source.yes}.`
                          : number
                            ? "Agents enter a whole number."
                            : "Agents answer Yes or No."}
                  </small>
                </div>
              </div>
              <div className="kpi-form-row">
                {number ? (
                  <div className="kpi-field">
                    <label>
                      Target per {per(form.frequency)}
                      <input
                        inputMode="numeric"
                        required
                        placeholder={`Number per ${per(form.frequency)}`}
                        value={form.target}
                        aria-invalid={!validTarget || !!problem}
                        aria-describedby={`${id}-target`}
                        onChange={(e) => set({ target: e.target.value.trim() })}
                      />
                    </label>
                    <small className="field-hint" id={`${id}-target`}>
                      {form.target && validTarget
                        ? `${form.target} a ${per(form.frequency)}`
                        : `A whole number from 1 to ${max ? max : "10,000"}`}
                      {max && validTarget && form.target
                        ? ` (at most ${max} a ${per(form.frequency)})`
                        : ""}
                    </small>
                  </div>
                ) : (
                  <div className="kpi-field">
                    <label>
                      Expected answer
                      <select
                        value={form.expected}
                        aria-describedby={`${id}-expected`}
                        onChange={(e) => set({ expected: e.target.value })}
                      >
                        <option value="yes">Yes</option>
                        <option value="no" disabled={!can("expected", "no")}>
                          No
                        </option>
                      </select>
                    </label>
                    <small className="field-hint" id={`${id}-expected`}>
                      {!can("expected", "no")
                        ? `A KPI the CRM fills in expects Yes. Yes when: ${source.yes}.`
                        : form.frequency === "week"
                          ? `Met once a day of the week is answered ${form.expected === "no" ? "No" : "Yes"}.`
                          : `Met on a day answered ${form.expected === "no" ? "No" : "Yes"}.`}
                    </small>
                  </div>
                )}
                <div className="kpi-field kpi-enabled">
                  <label className="kpi-check">
                    <input
                      type="checkbox"
                      checked={form.active}
                      aria-describedby={`${id}-active`}
                      onChange={(e) => set({ active: e.target.checked })}
                    />
                    <span>Enabled</span>
                  </label>
                  <small className="field-hint" id={`${id}-active`}>
                    Off: no results are expected from the next period.
                  </small>
                </div>
              </div>
            </fieldset>
            <fieldset className="kpi-form-section">
              <legend>Agents</legend>
              <div
                className="kpi-radio-row"
                role="radiogroup"
                aria-label="Agents"
              >
                <label className="kpi-check">
                  <input
                    type="radio"
                    name={`${id}-everyone`}
                    checked={form.everyone}
                    onChange={() => set({ everyone: true })}
                  />
                  <span>All agents</span>
                </label>
                <label className="kpi-check">
                  <input
                    type="radio"
                    name={`${id}-everyone`}
                    checked={!form.everyone}
                    onChange={() => set({ everyone: false })}
                  />
                  <span>Selected agents</span>
                </label>
              </div>
              {!form.everyone && (
                <div className="kpi-agent-list">
                  {agents.map((a) => (
                    <label className="kpi-check" key={a.id}>
                      <input
                        type="checkbox"
                        checked={form.agent_ids.includes(a.id)}
                        onChange={(e) =>
                          set({
                            agent_ids: e.target.checked
                              ? [...form.agent_ids, a.id]
                              : form.agent_ids.filter((x) => x !== a.id),
                          })
                        }
                      />
                      <span>
                        {a.name}
                        {!a.active && " (disabled)"}
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
            {(problem || when) && (
              <p
                className={problem ? "kpi-effect problem" : "kpi-effect"}
                role="status"
              >
                {problem ?? when}
                {!problem && firstWeek && (
                  <>
                    <br />
                    First weekly period: {firstWeek}.
                  </>
                )}
              </p>
            )}
          </>
        )}
        <ErrorBox error={error} />
        <footer>
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => (confirming ? setConfirming(false) : onClose())}
          >
            {confirming ? "Back to editing" : "Cancel"}
          </Button>
          <Button disabled={busy}>
            {busy
              ? "Saving…"
              : confirming
                ? "Confirm and save"
                : kpi
                  ? "Save changes"
                  : "Create KPI"}
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
  const status = (k) =>
    k.archived_at
      ? k.rules?.active
        ? "Archived (stops next period)"
        : "Archived"
      : k.rules?.active
        ? "Enabled"
        : "Off";
  const waiting = (k) =>
    k.scheduled &&
    `From ${fullDayLabel(k.scheduled.effective_from)}: ${frequencyLabel[k.scheduled.frequency]}, ${typeLabel[k.scheduled.answer_type]}, ${targetText(k.scheduled)}${k.scheduled.active ? "" : ", off"}`;
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
        <Button disabled={!q.data} onClick={() => setModal({})}>
          + New KPI
        </Button>
      </div>
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loader variant="table" />
      ) : !kpis.length ? (
        <div className="panel empty">
          {showArchived ? "No archived KPIs." : "No KPIs yet. Add one."}
        </div>
      ) : (
        <section className="panel kpi-manage">
          <table className="kpi-manage-table">
            <colgroup>
              <col className="kpi-col-pos" />
              <col />
              <col className="kpi-col-rules" />
              <col className="kpi-col-agents" />
              <col className="kpi-col-status" />
              <col className="kpi-col-actions" />
            </colgroup>
            <thead>
              <tr>
                <th>#</th>
                <th>KPI</th>
                <th>Rules</th>
                <th>Agents</th>
                <th>Status</th>
                <th>
                  <span className="visually-hidden">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {kpis.map((k) => {
                const r = k.rules ?? k.scheduled;
                return (
                  <tr key={k.id}>
                    <td className="kpi-pos" data-label="#">
                      {k.position}
                    </td>
                    <td className="kpi-name">
                      <b>{k.title}</b>
                      <small className="kpi-sub">{k.question}</small>
                    </td>
                    <td data-label="Rules">
                      <span className="kpi-rules">
                        {r
                          ? `${frequencyLabel[r.frequency]} · ${typeLabel[r.answer_type]} · ${targetText(r)}`
                          : "—"}
                      </span>
                      <small className="kpi-sub">
                        {measured(r)
                          ? measureLabels[r.measure]
                          : measureLabels.self}
                      </small>
                    </td>
                    <td data-label="Agents">
                      {!k.rules?.agent_ids
                        ? "All agents"
                        : k.rules.agent_ids
                            .map((id) => agentName.get(id) ?? "Agent")
                            .join(", ")}
                    </td>
                    <td data-label="Status">
                      <span
                        className={`badge plain ${k.rules?.active && !k.archived_at ? "completed" : ""}`}
                      >
                        {status(k)}
                      </span>
                      {waiting(k) && (
                        <small className="kpi-sub kpi-waiting">
                          Change waiting · {waiting(k)}
                        </small>
                      )}
                      <small className="kpi-sub">
                        {k.answers === 1
                          ? "1 agent answer"
                          : `${k.answers} agent answers`}
                      </small>
                    </td>
                    <td className="kpi-actions-cell">
                      <div className="kpi-actions">
                        {!k.archived_at && (
                          <Button
                            variant="secondary"
                            disabled={busy}
                            aria-label={`Edit ${k.title}`}
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
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      <p className="field-hint">
        Earlier sales targets stay available in{" "}
        <Link to="/targets">Sales targets</Link>.
      </p>
      {modal && (
        <KpiForm
          kpi={modal.kpi}
          list={q.data}
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
