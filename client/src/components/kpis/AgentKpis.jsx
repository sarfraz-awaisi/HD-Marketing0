import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, date } from "../../lib/api";
import { addDays, dayLabel, fullDayLabel, todayPk } from "../../lib/calendar";
import { answerText, dayStates, measured } from "../../lib/kpiPeriods";
import { Button, ErrorBox, Loader, useToast } from "../common/UI";
import { MeasuredKpi } from "./KpiEvidence";
import "../../styles/kpis.css";
// An agent's Daily KPIs (update 070): every KPI that applies to them for the
// chosen day. Yes/No has no default and a number may be 0, so nothing is
// answered until the agent answers it. Daily KPIs are answered on their
// day; weekly ones on any day of this week up to today, adding up to the
// week's target. Saving again replaces that day's answer. Since update 072
// the CRM fills some KPIs in (calls, inventory) or counts the evidence
// administrators approve (links, visit photos): no answer to give there.
const isCount = (text) => /^\d{1,4}$/.test(text) && Number(text) <= 1000;

function YesNo({ item, value, onChange }) {
  return (
    <div className="kpi-choice" role="radiogroup" aria-label={item.question}>
      {[
        [true, "Yes"],
        [false, "No"],
      ].map(([option, label]) => (
        <button
          key={label}
          type="button"
          role="radio"
          aria-checked={value === option}
          className={value === option ? "selected" : ""}
          disabled={!item.editable}
          onClick={() => onChange(option)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function WeekProgress({ week, type }) {
  if (!week) return null;
  const entered = week.days.filter((d) => d.value !== null);
  return (
    <div className="kpi-week">
      <span className={`kpi-progress ${week.status}`}>
        This week: {week.total}/{week.target}
        {week.status === "met" ? " · met" : ""}
      </span>
      {entered.length > 0 && (
        <small>
          {entered
            .map((d) => `${dayLabel(d.day)}: ${answerText(type, d.value)}`)
            .join(" · ")}
        </small>
      )}
    </div>
  );
}

export default function AgentKpis() {
  const qc = useQueryClient(),
    toast = useToast();
  const [day, setDay] = useState(todayPk()),
    [draft, setDraft] = useState({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const q = useQuery({
    queryKey: ["kpis", "my", day],
    queryFn: ({ signal }) => api(`/kpis/my?day=${day}`, { signal }),
  });
  const data = q.data;
  const items = data?.kpis || [];
  const own = items.filter((i) => !measured(i));
  const refresh = (message) => {
    qc.invalidateQueries({ queryKey: ["kpis", "my"] });
    toast(message);
  };
  const saved = (item) => item.answer;
  const current = (item) =>
    Object.hasOwn(draft, item.id) ? draft[item.id] : saved(item);
  // Number fields keep the typed text; blank is no answer, 0 is an answer.
  const text = (item) =>
    Object.hasOwn(draft, item.id)
      ? draft[item.id]
      : item.answer === null
        ? ""
        : String(item.answer);
  const changes = items.filter((item) => {
    if (!item.editable || !Object.hasOwn(draft, item.id)) return false;
    if (item.answer_type === "yes_no") return draft[item.id] !== item.answer;
    return isCount(draft[item.id]) && Number(draft[item.id]) !== item.answer;
  });
  const invalid = items.filter(
    (item) =>
      item.answer_type === "number" &&
      Object.hasOwn(draft, item.id) &&
      draft[item.id] !== "" &&
      !isCount(draft[item.id]),
  );
  const pick = (next) => {
    setDay(next);
    setDraft({});
    setError("");
  };
  async function save() {
    if (busy || !changes.length || invalid.length) return;
    setBusy(true);
    setError("");
    try {
      const result = await api(`/kpis/my/${day}`, {
        method: "PUT",
        body: {
          answers: changes.map((item) => ({
            kpi_id: item.id,
            answer:
              item.answer_type === "yes_no"
                ? draft[item.id]
                : Number(draft[item.id]),
          })),
        },
      });
      qc.setQueryData(["kpis", "my", day], result);
      qc.invalidateQueries({ queryKey: ["kpis", "my"] });
      setDraft({});
      toast(
        `Saved ${result.saved} answer${result.saved === 1 ? "" : "s"} for ${fullDayLabel(day)}`,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const today = data?.today ?? todayPk();
  const weekDays = [];
  if (data)
    for (let d = data.editable_from; d <= today; d = addDays(d, 1))
      weekDays.push(d);
  const groups = [
    ["day", "Daily KPIs", "Answer these for today."],
    [
      "week",
      "Weekly KPIs",
      "Enter what you did each day; the week adds up to the target.",
    ],
  ];
  const crmHint = {
    day: "The CRM fills these in from your work and the evidence an administrator approves.",
    week: "The week adds up what an administrator approves; add your evidence as you go.",
  };
  const history = data?.history;
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">MY WORK</span>
          <h1>Daily KPIs</h1>
          <p>
            {data?.agent?.name ? `${data.agent.name} · ` : ""}
            {fullDayLabel(day)}
            {data && data.day_status !== "work" && (
              <span className="kpi-day-status">
                {" "}
                · {dayStates[data.day_status] ?? data.day_status}
              </span>
            )}
          </p>
        </div>
      </div>
      <section className="panel kpi-days" aria-label="Choose a day">
        <div className="review-tabs" role="tablist" aria-label="Day">
          {weekDays.map((d) => (
            <button
              key={d}
              type="button"
              role="tab"
              aria-selected={day === d}
              className={day === d ? "active" : ""}
              onClick={() => pick(d)}
            >
              {d === today ? "Today" : dayLabel(d)}
            </button>
          ))}
        </div>
        {data && (
          <p className="kpi-status-line" aria-live="polite">
            {own.length
              ? `${data.answered} of ${own.length} answered for this day`
              : `All ${items.length} KPIs are filled in by the CRM`}
            {own.length > 0 &&
              own.length < items.length &&
              ` · ${items.length - own.length} filled in by the CRM`}
          </p>
        )}
      </section>
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loader />
      ) : !items.length ? (
        <div className="panel empty">No KPIs are set for you on this day.</div>
      ) : (
        <form
          className="kpi-form"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {groups.map(([frequency, heading, hint]) => {
            const list = items.filter((i) => i.frequency === frequency);
            if (!list.length) return null;
            return (
              <section className="panel kpi-group" key={frequency}>
                <h2>{heading}</h2>
                <p className="field-hint">
                  {list.every(measured) ? crmHint[frequency] : hint}
                </p>
                {list.map((item) =>
                  measured(item) ? (
                    <div className="kpi-item kpi-item-measured" key={item.id}>
                      <div className="kpi-question">
                        <b>{item.title}</b>
                        <span>{item.question}</span>
                        {item.description && <small>{item.description}</small>}
                      </div>
                      <MeasuredKpi
                        item={item}
                        data={data}
                        onChanged={refresh}
                      />
                    </div>
                  ) : (
                    <div className="kpi-item" key={item.id}>
                      <div className="kpi-question">
                        <b>{item.title}</b>
                        <span>{item.question}</span>
                        {item.description && <small>{item.description}</small>}
                        {item.answer_type === "number" &&
                          item.frequency === "day" && (
                            <small>Target: {item.target} a day</small>
                          )}
                        {/* Update 076: a Yes/No KPI may expect No. */}
                        {item.answer_type === "yes_no" &&
                          item.expected === "no" && (
                            <small>Expected answer: No</small>
                          )}
                      </div>
                      <div className="kpi-answer">
                        {item.answer_type === "yes_no" ? (
                          <YesNo
                            item={item}
                            value={current(item)}
                            onChange={(v) =>
                              setDraft((d) => ({ ...d, [item.id]: v }))
                            }
                          />
                        ) : (
                          <input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            aria-label={item.question}
                            placeholder="Number"
                            value={text(item)}
                            disabled={!item.editable}
                            aria-invalid={invalid.includes(item)}
                            onChange={(e) =>
                              setDraft((d) => ({
                                ...d,
                                [item.id]: e.target.value.trim(),
                              }))
                            }
                          />
                        )}
                        {invalid.includes(item) && (
                          <small className="kpi-error">
                            Enter a whole number from 0 to 1,000.
                          </small>
                        )}
                        {item.frequency === "day" &&
                          item.answer_type === "number" &&
                          item.answer !== null && (
                            <small
                              className={`kpi-progress ${item.met ? "met" : "below"}`}
                            >
                              {item.answer}/{item.target}
                            </small>
                          )}
                        {item.frequency === "week" && (
                          <WeekProgress
                            week={item.week}
                            type={item.answer_type}
                          />
                        )}
                        {!item.editable && (
                          <small className="field-hint">
                            {item.frequency === "day"
                              ? "Daily KPIs are answered on the day."
                              : "This week is closed."}
                          </small>
                        )}
                        {item.updated_at && (
                          <small className="field-hint">
                            Saved {date(item.updated_at)}
                          </small>
                        )}
                      </div>
                    </div>
                  ),
                )}
              </section>
            );
          })}
          {own.length > 0 && (
            <div className="kpi-save">
              <Button disabled={busy || !changes.length || invalid.length > 0}>
                {busy
                  ? "Saving…"
                  : changes.length
                    ? `Save ${changes.length} answer${changes.length === 1 ? "" : "s"}`
                    : "Saved"}
              </Button>
            </div>
          )}
        </form>
      )}
      {history?.days?.length > 0 && (
        <section className="panel">
          <h2>Recent days</h2>
          <div className="table-scroll">
            <table className="kpi-history-table">
              <thead>
                <tr>
                  <th>Day</th>
                  {history.kpis.map((k) => (
                    <th key={k.id}>{k.title}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.days.map((d) => (
                  <tr key={d.day}>
                    <td>{dayLabel(d.day)}</td>
                    {history.kpis.map((k) => {
                      const a = d.answers[k.id];
                      return (
                        <td key={k.id}>
                          {!a ||
                          (a.state === "not_due" && k.frequency === "week")
                            ? "—"
                            : a.state === "answered"
                              ? answerText(k.answer_type, a.value)
                              : (dayStates[a.state] ?? a.state)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
