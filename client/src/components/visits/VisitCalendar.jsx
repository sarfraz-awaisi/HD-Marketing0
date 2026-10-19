import { useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import { formatLeadNo } from "../../lib/formatLeadNo";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import {
  addDays,
  addMonths,
  dayLabel,
  dayStartIso,
  fullDayLabel,
  monthLabel,
  pkDate,
  startOfMonth,
  startOfWeek,
  todayPk,
  visitTime,
} from "../../lib/calendar";
import { statusLabel } from "../../lib/pipeline";
import { Button, ErrorBox, Loader, Modal, useToast } from "../common/UI";
import { ActivityForm } from "../common/RecordsPage";
const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function VisitCard({ visit, admin }) {
  return (
    <Link
      to={"/leads/" + visit.lead_id}
      className={`calendar-visit ${visit.status}`}
    >
      <b>{visitTime(visit.scheduled_at)}</b>
      <span>
        {formatLeadNo(visit.lead_no)} · {visit.lead_name}
      </span>
      <small>
        {visit.property_title}
        {admin && visit.agent_name ? ` · ${visit.agent_name}` : ""}
      </small>
      <em>{statusLabel(visit.status)}</em>
    </Link>
  );
}
// Week and month views of site visits in Pakistan time.
export default function VisitCalendar() {
  const { user } = useAuth(),
    admin = user.role === "admin";
  const qc = useQueryClient(),
    toast = useToast();
  const today = todayPk();
  const [mode, setMode] = useState("week"),
    [anchor, setAnchor] = useState(today),
    [selected, setSelected] = useState(today),
    [agent, setAgent] = useState(""),
    [adding, setAdding] = useState(false);
  const first =
    mode === "week" ? startOfWeek(anchor) : startOfWeek(startOfMonth(anchor));
  const days =
    mode === "week"
      ? 7
      : Math.ceil(
          (Date.parse(addMonths(startOfMonth(anchor), 1)) - Date.parse(first)) /
            (7 * 86400000),
        ) * 7;
  const grid = Array.from({ length: days }, (_, i) => addDays(first, i));
  const range = {
    from: dayStartIso(first),
    to: dayStartIso(addDays(first, days)),
    ...(admin && agent ? { agent } : {}),
  };
  const q = useQuery({
    queryKey: ["visit-calendar", range],
    queryFn: ({ signal }) =>
      api("/visits/calendar?" + new URLSearchParams(range), { signal }),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
    enabled: admin,
  });
  const visits = Array.isArray(q.data) ? q.data : [];
  const byDay = visits.reduce((map, visit) => {
    const day = pkDate(visit.scheduled_at);
    (map[day] ||= []).push(visit);
    return map;
  }, {});
  const move = (n) => {
    const next =
      mode === "week" ? addDays(anchor, 7 * n) : addMonths(anchor, n);
    setAnchor(next);
    setSelected(mode === "week" ? startOfWeek(next) : startOfMonth(next));
  };
  const title =
    mode === "week"
      ? `${dayLabel(grid[0])} – ${dayLabel(grid[6])}`
      : monthLabel(startOfMonth(anchor));
  return (
    <section className="panel visit-calendar" aria-label="Visit calendar">
      <div className="calendar-toolbar">
        <div className="calendar-nav">
          <Button
            variant="secondary"
            aria-label={mode === "week" ? "Previous week" : "Previous month"}
            onClick={() => move(-1)}
          >
            <ChevronLeft size={18} />
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setAnchor(today);
              setSelected(today);
            }}
          >
            Today
          </Button>
          <Button
            variant="secondary"
            aria-label={mode === "week" ? "Next week" : "Next month"}
            onClick={() => move(1)}
          >
            <ChevronRight size={18} />
          </Button>
          <h2 aria-live="polite">{title}</h2>
        </div>
        <div className="calendar-controls">
          <div
            className="review-tabs"
            role="tablist"
            aria-label="Calendar view"
          >
            {[
              ["week", "Week"],
              ["month", "Month"],
            ].map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={mode === value}
                className={mode === value ? "active" : ""}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {admin && (
            <select
              aria-label="Calendar agent"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
            >
              <option value="">All agents</option>
              {(Array.isArray(users.data) ? users.data : [])
                .filter((a) => a.role === "agent")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
            </select>
          )}
          <Button onClick={() => setAdding(true)}>+ Add visit</Button>
        </div>
      </div>
      <ErrorBox error={q.error} />
      {q.isPending ? (
        <Loader />
      ) : mode === "week" ? (
        <div className="calendar-week">
          {grid.map((day) => (
            <div
              key={day}
              className={`calendar-day${day === today ? " today" : ""}`}
            >
              <h3>{dayLabel(day)}</h3>
              {(byDay[day] || []).map((visit) => (
                <VisitCard key={visit.id} visit={visit} admin={admin} />
              ))}
              {!byDay[day] && <p className="calendar-empty">No visits</p>}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="calendar-month">
            {weekdays.map((d) => (
              <span key={d} className="calendar-weekday" aria-hidden="true">
                {d}
              </span>
            ))}
            {grid.map((day) => {
              const list = byDay[day] || [];
              const outside = day.slice(0, 7) !== anchor.slice(0, 7);
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={selected === day}
                  aria-label={`${fullDayLabel(day)}, ${list.length} visit${list.length === 1 ? "" : "s"}`}
                  className={[
                    "calendar-cell",
                    outside ? "outside" : "",
                    day === today ? "today" : "",
                    selected === day ? "selected" : "",
                  ].join(" ")}
                  onClick={() => setSelected(day)}
                >
                  <span className="calendar-date">{Number(day.slice(8))}</span>
                  {list.slice(0, 3).map((visit) => (
                    <span
                      key={visit.id}
                      className={`calendar-chip ${visit.status}`}
                    >
                      {visitTime(visit.scheduled_at)}{" "}
                      <i>{formatLeadNo(visit.lead_no)}</i>
                    </span>
                  ))}
                  {list.length > 3 && (
                    <span className="calendar-more">
                      +{list.length - 3} more
                    </span>
                  )}
                  {list.length > 0 && (
                    <span className="calendar-count">{list.length}</span>
                  )}
                </button>
              );
            })}
          </div>
          <div className="calendar-selected">
            <h3>{fullDayLabel(selected)}</h3>
            {(byDay[selected] || []).length ? (
              byDay[selected].map((visit) => (
                <VisitCard key={visit.id} visit={visit} admin={admin} />
              ))
            ) : (
              <p className="calendar-empty">No visits on this day.</p>
            )}
          </div>
        </>
      )}
      <div className="calendar-legend" aria-label="Status colours">
        {["scheduled", "completed", "cancelled", "no-show"].map((s) => (
          <span key={s} className={`calendar-chip ${s}`}>
            {statusLabel(s)}
          </span>
        ))}
      </div>
      {adding && (
        <Modal title="Add visit" onClose={() => setAdding(false)}>
          <ActivityForm
            entity="visits"
            onSave={async (data) => {
              await api("/visits", { method: "POST", body: data });
              invalidateWorkspace(qc);
              toast("Visit saved");
              setAdding(false);
            }}
          />
        </Modal>
      )}
    </section>
  );
}
