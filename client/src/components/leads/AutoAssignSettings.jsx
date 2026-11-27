import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { Button, ErrorBox, Loader, Modal, Table, useToast } from "../common/UI";
// Update 091: automatic lead distribution, from All leads → Unassigned.
// Administrators choose the batch size, the agents and each agent's
// percentage; the CRM shares every complete batch of eligible unassigned
// leads among them. The preview, the status and every change come from the
// server, which checks them again; nothing is assigned from this dialog
// except by Run now, after confirming.
const stateLabels = {
  on: "Enabled",
  off: "Disabled",
  paused: "Paused",
  error: "Error",
};
const stateTone = { on: "won", paused: "warning", error: "lost", off: "" };
const plural = (n, one, many = one + "s") =>
  `${Number(n).toLocaleString("en-US")} ${n === 1 ? one : many}`;
const percentText = (n) =>
  `${Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const hundredths = (text) => Math.round(Number(text) * 100);
// What the server would refuse, in the same words.
function problems(form) {
  const out = [];
  const size = Number(form.batch);
  if (!/^\d+$/.test(form.batch) || size < 1 || size > 500)
    out.push("Enter a batch of 1 to 500 leads.");
  if (!form.agents.length) out.push("Choose at least one agent.");
  const bad = form.agents.find(
    (a) =>
      !/^\d{1,3}(\.\d{1,2})?$/.test(a.percent) ||
      Number(a.percent) <= 0 ||
      Number(a.percent) > 100,
  );
  if (bad)
    out.push(
      "Give each agent a percentage above 0 and up to 100, with at most two decimals.",
    );
  const total = form.agents.reduce((n, a) => n + hundredths(a.percent), 0);
  if (form.agents.length && !bad && total !== 10000)
    out.push("The percentages must add up to exactly 100.");
  return out;
}
const fromSaved = (s) => ({
  on: s.state !== "off",
  batch: String(s.batch_size),
  scope: s.scope,
  agents: s.rules.map((r) => ({
    agent_id: r.agent_id,
    percent: String(Number(r.percent)),
  })),
});
const body = (form) => ({
  batch_size: Number(form.batch),
  scope: form.scope,
  agents: form.agents.map((a) => ({
    agent_id: a.agent_id,
    percent: Number(a.percent),
  })),
});

export default function AutoAssignSettings({ agents, onClose, onAssigned }) {
  const toast = useToast(),
    qc = useQueryClient();
  const status = useQuery({
    queryKey: ["auto-assign"],
    queryFn: ({ signal }) => api("/leads/auto-assign", { signal }),
    refetchInterval: 30000,
  });
  const [form, setForm] = useState(null),
    [search, setSearch] = useState(""),
    [asked, setAsked] = useState(null),
    [confirm, setConfirm] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const s = status.data;
  // The form starts from the saved settings.
  useEffect(() => {
    if (s && !form) setForm(fromSaved(s));
  }, [s, form]);
  const issues = form ? problems(form) : [];
  const key = form && !issues.length ? JSON.stringify(body(form)) : null;
  useEffect(() => {
    const t = setTimeout(() => setAsked(key), 300);
    return () => clearTimeout(t);
  }, [key]);
  const preview = useQuery({
    queryKey: ["auto-assign-preview", asked],
    queryFn: ({ signal }) =>
      api("/leads/auto-assign/preview", {
        method: "POST",
        body: JSON.parse(asked),
        signal,
      }),
    enabled: !!asked && asked === key,
    gcTime: 0,
  });
  if (!s || !form)
    return (
      <Modal title="Auto Assign Settings" onClose={onClose}>
        <ErrorBox error={status.error} />
        {!status.error && <Loader />}
      </Modal>
    );
  const names = new Map([
    ...s.rules.map((r) => [r.agent_id, r.name]),
    ...agents.map((a) => [a.id, a.name]),
  ]);
  const inactive = new Set(
    s.rules.filter((r) => !r.active).map((r) => r.agent_id),
  );
  const chosen = new Set(form.agents.map((a) => a.agent_id));
  const words = search.trim().toLowerCase();
  const shown = agents.filter(
    (a) =>
      !words ||
      a.name.toLowerCase().includes(words) ||
      String(a.uid || "").includes(words),
  );
  const total = form.agents.reduce(
    (n, a) =>
      n + (Number.isFinite(Number(a.percent)) ? hundredths(a.percent) : 0),
    0,
  );
  const plan = preview.data && asked === key ? preview.data : null;
  const counts = plan?.counts;
  const change = (values) => {
    setError("");
    setForm((now) => ({ ...now, ...values }));
  };
  const toggleAgent = (id) =>
    change({
      agents: chosen.has(id)
        ? form.agents.filter((a) => a.agent_id !== id)
        : [...form.agents, { agent_id: id, percent: "" }],
    });
  const setPercent = (id, percent) =>
    change({
      agents: form.agents.map((a) =>
        a.agent_id === id ? { ...a, percent } : a,
      ),
    });
  // Even shares in hundredths, the first agents taking the rest.
  const splitEvenly = () => {
    const n = form.agents.length;
    const base = Math.floor(10000 / n);
    change({
      agents: form.agents.map((a, i) => ({
        ...a,
        percent: String((base + (i < 10000 - base * n ? 1 : 0)) / 100),
      })),
    });
  };
  const switchingOn = form.on && s.state === "off";
  const nextState = !form.on ? "off" : s.state === "paused" ? "paused" : "on";
  async function send(path, options, message) {
    setBusy(true);
    setError("");
    try {
      const result = await api(path, options);
      qc.setQueryData(["auto-assign"], result);
      if (message) toast(message);
      return result;
    } catch (e) {
      setError(e.message);
      await qc.invalidateQueries({ queryKey: ["auto-assign"] });
      return null;
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }
  async function save() {
    const result = await send(
      "/leads/auto-assign",
      {
        method: "PUT",
        body: { ...body(form), version: s.version, state: nextState },
      },
      null,
    );
    if (result) {
      setForm(fromSaved(result));
      toast("Auto assign settings saved");
    }
  }
  const setState = (state) =>
    send(
      "/leads/auto-assign/state",
      { method: "POST", body: { state } },
      state === "paused" ? "Auto assign paused" : null,
    ).then((result) => result && setForm(fromSaved(result)));
  async function runNow() {
    setBusy(true);
    setError("");
    try {
      const result = await api("/leads/auto-assign/run", {
        method: "POST",
        body: {},
      });
      await qc.invalidateQueries({ queryKey: ["auto-assign"] });
      if (result.assigned) {
        toast(`${plural(result.assigned, "lead")} assigned`);
        onAssigned?.();
      } else
        setError(
          result.status === "waiting"
            ? `No complete batch is waiting (${plural(result.waiting ?? 0, "eligible lead")}).`
            : result.reason || "Nothing was assigned.",
        );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  }
  const worker = s.worker || {};
  const savedCounts = s.counts || {};
  return (
    <Modal
      title="Auto Assign Settings"
      className="auto-assign-dialog"
      onClose={() => !busy && onClose()}
    >
      <ErrorBox error={error || status.error} />
      <section className="auto-assign-status" aria-label="Current status">
        <p>
          <span className={`badge ${stateTone[s.state]}`}>
            {stateLabels[s.state]}
          </span>{" "}
          {s.state === "on"
            ? `Every ${plural(s.batch_size, "eligible lead")} waiting are shared among the agents below.`
            : s.state === "paused"
              ? "Paused: no new batch starts until you resume. A batch already being assigned (a few seconds) finishes first."
              : s.state === "error"
                ? "Stopped after a problem: fix the settings and save them, or resume."
                : "Off: unassigned leads stay unassigned until you assign them."}
        </p>
        <dl className="auto-assign-facts">
          <dt>Worker</dt>
          <dd>
            {worker.has_job
              ? `Running auto assign${worker.last_run_at ? `, last check ${date(worker.last_run_at)}` : ""}`
              : worker.running
                ? "Running, but auto assign is not one of its jobs: automatic batches wait. Run now still works."
                : "Not running: automatic batches wait until it is started. Run now still works."}
          </dd>
          <dt>Waiting</dt>
          <dd>
            {plural(savedCounts.waiting ?? 0, "eligible lead")}
            {s.state !== "off" &&
              s.scope === "new" &&
              ` (added since ${date(s.active_since)})`}
          </dd>
          <dt>Batch</dt>
          <dd>Every {plural(s.batch_size, "lead")}</dd>
          <dt>Agents</dt>
          <dd>
            {s.rules.length
              ? s.rules
                  .map(
                    (r) =>
                      `${r.name || "An agent"} ${percentText(r.percent)}${r.active ? "" : " (not active)"}`,
                  )
                  .join(" · ")
              : "None chosen"}
          </dd>
          <dt>Today</dt>
          <dd>{plural(s.today ?? 0, "lead")} assigned automatically</dd>
          <dt>Last batch</dt>
          <dd>{date(s.last_batch_at)}</dd>
          {s.last_error && (
            <>
              <dt>Last error</dt>
              <dd className="field-error">
                {s.last_error} ({date(s.last_error_at)})
              </dd>
            </>
          )}
          <dt>Last updated</dt>
          <dd>
            {s.updated_by_name
              ? `${s.updated_by_name}, ${date(s.updated_at)}`
              : "Never"}
          </dd>
        </dl>
        <div className="auto-assign-actions">
          {["on", "error"].includes(s.state) && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setState("paused")}
            >
              Pause
            </Button>
          )}
          {["paused", "error"].includes(s.state) && (
            <Button
              variant="secondary"
              disabled={busy || !!s.problem}
              onClick={() => setState("on")}
            >
              Resume
            </Button>
          )}
          {s.state === "on" && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirm("run")}
            >
              Run now
            </Button>
          )}
        </div>
        {s.problem && s.state !== "off" && (
          <p className="field-error" role="alert">
            {s.problem}. Change the settings and save them.
          </p>
        )}
      </section>

      <form
        className="auto-assign-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (!issues.length) setConfirm(switchingOn ? "enable" : "save");
        }}
      >
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={form.on}
            disabled={busy}
            onChange={(e) => change({ on: e.target.checked })}
          />
          Enable automatic assignment
        </label>
        <label>
          Leads per batch
          <span className="auto-assign-batch">
            Assign automatically every
            <input
              type="number"
              inputMode="numeric"
              min="1"
              max="500"
              step="1"
              aria-label="Leads per batch"
              value={form.batch}
              disabled={busy}
              onChange={(e) => change({ batch: e.target.value })}
            />
            eligible leads
          </span>
          <small>
            Whenever this many eligible unassigned leads accumulate, the CRM
            automatically distributes one complete batch, oldest leads first. It
            never assigns part of a batch.
          </small>
        </label>
        {form.on && (
          <fieldset className="auto-assign-scope" disabled={busy}>
            <legend>Which leads</legend>
            <label className="checkbox-field">
              <input
                type="radio"
                name="auto-assign-scope"
                checked={form.scope === "new"}
                onChange={() => change({ scope: "new" })}
              />
              New leads only
              {switchingOn ? " (added from now on)" : ""}
            </label>
            <label className="checkbox-field">
              <input
                type="radio"
                name="auto-assign-scope"
                checked={form.scope === "backlog"}
                onChange={() => change({ scope: "backlog" })}
              />
              Include the eligible leads already waiting (
              {plural(
                switchingOn
                  ? (savedCounts.eligible ?? 0)
                  : (savedCounts.backlog ?? 0),
                "lead",
              )}
              )
            </label>
          </fieldset>
        )}
        <fieldset className="auto-assign-agents" disabled={busy}>
          <legend>Agents and percentages</legend>
          <input
            type="search"
            aria-label="Search agents"
            placeholder="Search active agents by name or UID"
            value={search}
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
                  type="checkbox"
                  checked={chosen.has(a.id)}
                  onChange={() => toggleAgent(a.id)}
                />
                {a.name} {a.uid && <small>UID {a.uid}</small>}
              </label>
            ))}
            {!shown.length && (
              <p className="lead-muted">No active agent matches your search.</p>
            )}
          </div>
          {form.agents.length > 0 && (
            <Table
              rows={form.agents.map((a) => {
                const row = plan?.agents.find((p) => p.agent_id === a.agent_id);
                return {
                  ...a,
                  id: a.agent_id,
                  name: names.get(a.agent_id) || "An agent",
                  count: row ? row.count : null,
                };
              })}
              columns={[
                {
                  key: "name",
                  label: "Agent",
                  render: (r) =>
                    inactive.has(r.agent_id) ? (
                      <span>
                        {r.name} <span className="badge lost">Not active</span>
                      </span>
                    ) : (
                      r.name
                    ),
                },
                {
                  key: "percent",
                  label: "Percentage",
                  render: (r) => (
                    <span className="auto-assign-percent">
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0.01"
                        max="100"
                        step="0.01"
                        aria-label={`Percentage for ${r.name}`}
                        value={r.percent}
                        onChange={(e) => setPercent(r.agent_id, e.target.value)}
                      />
                      %
                    </span>
                  ),
                },
                {
                  key: "count",
                  label: "Leads per batch",
                  render: (r) => (r.count === null ? "—" : r.count),
                },
                {
                  key: "remove",
                  label: "Remove",
                  render: (r) => (
                    <Button
                      variant="secondary"
                      aria-label={`Remove ${r.name}`}
                      onClick={() => toggleAgent(r.agent_id)}
                    >
                      Remove
                    </Button>
                  ),
                },
              ]}
            />
          )}
          <p className="auto-assign-total" role="status">
            Total {percentText(total / 100)}
            {plan &&
              ` · ${plural(
                plan.agents.reduce((n, a) => n + a.count, 0),
                "lead",
              )} per batch`}
            {form.agents.length > 1 && (
              <>
                {" "}
                <button
                  type="button"
                  className="text-button"
                  onClick={splitEvenly}
                >
                  Split evenly
                </button>
              </>
            )}
          </p>
        </fieldset>
        {issues.length > 0 ? (
          <ul className="field-error auto-assign-issues">
            {issues.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        ) : (
          <div className="pipeline-hint" role="note">
            {counts ? (
              <p>
                Preview: {plural(counts.waiting, "eligible lead")} waiting
                {form.on ? "" : " if switched on"} ·{" "}
                {plural(counts.batches, "complete batch", "complete batches")} ·{" "}
                {plural(counts.leftover, "lead")} left until the next batch.
                Small batches are rounded fairly over time: each batch&apos;s
                counts carry the remainder forward, so totals follow the
                percentages.
              </p>
            ) : preview.error ? (
              <ErrorBox error={preview.error} />
            ) : (
              <p>Working out the preview…</p>
            )}
          </div>
        )}
        {confirm === "enable" || confirm === "save" ? (
          <div className="auto-assign-confirm" role="alert">
            <p>
              {confirm === "enable"
                ? `Switch on automatic assignment? Every ${plural(Number(form.batch), "eligible lead")} will be shared among ${plural(form.agents.length, "agent")}. ${
                    form.scope === "backlog"
                      ? `The ${plural(counts?.waiting ?? 0, "lead")} already waiting are included: ${plural(counts?.batches ?? 0, "batch", "batches")} can be assigned straight away.`
                      : "Only leads added from now on are included; the leads already waiting stay as they are."
                  }`
                : "Save these settings? Future batches use them; leads already assigned stay with their agents, and the fair-share balance starts again."}
            </p>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Back
            </Button>
            <Button disabled={busy} onClick={save}>
              {busy ? "Saving…" : confirm === "enable" ? "Switch on" : "Save"}
            </Button>
          </div>
        ) : confirm === "run" ? (
          <div className="auto-assign-confirm" role="alert">
            <p>
              Assign the complete batches waiting now (
              {plural(savedCounts.batches ?? 0, "batch", "batches")} of{" "}
              {s.batch_size}, at most 500 leads), with the saved settings?
            </p>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirm(null)}
            >
              Back
            </Button>
            <Button disabled={busy} onClick={runNow}>
              {busy ? "Assigning…" : "Run now"}
            </Button>
          </div>
        ) : (
          <footer>
            <Button variant="secondary" disabled={busy} onClick={onClose}>
              Close
            </Button>
            <Button type="submit" disabled={busy || issues.length > 0}>
              Save settings
            </Button>
          </footer>
        )}
      </form>
      {s.batches.length > 0 && (
        <section className="auto-assign-history" aria-label="Recent batches">
          <h3>Recent batches</h3>
          <Table
            rows={s.batches}
            columns={[
              {
                key: "created_at",
                label: "When (Pakistan)",
                render: (b) => (
                  <span title={b.created_at}>{date(b.created_at)}</span>
                ),
              },
              {
                key: "trigger",
                label: "How",
                render: (b) =>
                  b.trigger === "manual"
                    ? `Run now${b.actor_name ? ` by ${b.actor_name}` : ""}`
                    : "Automatic",
              },
              {
                key: "assigned",
                label: "Assigned",
                render: (b) =>
                  b.status === "assigned"
                    ? b.allocation
                        .map((a) => `${a.name || "An agent"}: ${a.count}`)
                        .join(" · ")
                    : b.reason || "—",
              },
              {
                key: "status",
                label: "Result",
                render: (b) => (
                  <span
                    className={`badge ${b.status === "assigned" ? "won" : b.status === "failed" ? "lost" : "warning"}`}
                  >
                    {b.status === "assigned"
                      ? `${b.assigned} assigned`
                      : b.status === "failed"
                        ? "Failed"
                        : "Tried again later"}
                  </span>
                ),
              },
            ]}
          />
        </section>
      )}
    </Modal>
  );
}
