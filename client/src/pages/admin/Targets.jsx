import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { api } from "../../lib/api";
import { useAuth } from "../../context/AuthContext";
import {
  periodLabel,
  periodStart,
  shiftPeriod,
  todayPk,
} from "../../lib/calendar";
import {
  Button,
  Modal,
  RecordForm,
  ErrorBox,
  Loader,
  Pagination,
  useToast,
} from "../../components/common/UI";
import { targetGoals } from "../../components/targets/TargetProgress";
import TargetCard from "../../components/targets/TargetCard";
const periods = [
  ["day", "Daily"],
  ["week", "Weekly"],
  ["month", "Monthly"],
];
const periodName = { day: "day", week: "week", month: "month" };
const periodAdjective = { day: "daily", week: "weekly", month: "monthly" };
export default function Targets() {
  const { user } = useAuth(),
    admin = user.role === "admin";
  const qc = useQueryClient(),
    toast = useToast();
  const [period, setPeriod] = useState("month"),
    [start, setStart] = useState(periodStart("month", todayPk())),
    [page, setPage] = useState(1),
    [modal, setModal] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const q = useQuery({
    queryKey: ["targets", period, start, page],
    queryFn: ({ signal }) =>
      api(
        "/targets?" + new URLSearchParams({ period, start, page }).toString(),
        { signal },
      ),
  });
  const users = useQuery({
    queryKey: ["users"],
    queryFn: ({ signal }) => api("/users", { signal }),
    enabled: admin,
  });
  const go = (next) => {
    setStart(next);
    setPage(1);
    setError("");
  };
  async function copyPrevious() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await api("/targets/copy", {
        method: "POST",
        body: { period, start },
      });
      qc.invalidateQueries({ queryKey: ["targets"] });
      toast(
        result.copied
          ? `${result.copied} target${result.copied === 1 ? "" : "s"} copied from the previous ${periodName[period]}`
          : `Nothing to copy: no new targets in the previous ${periodName[period]}`,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const rows = Array.isArray(q.data?.data) ? q.data.data : [];
  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TURN AMBITION INTO PROGRESS</span>
          <h1>{admin ? "Team targets" : "My targets"}</h1>
          <p>
            Daily, weekly and monthly goals measured against actual completed
            records, in Pakistan time.
          </p>
        </div>
        {admin && (
          <div className="actions">
            <Button variant="secondary" disabled={busy} onClick={copyPrevious}>
              {busy ? "Copying…" : `Copy previous ${periodName[period]}`}
            </Button>
            <Button onClick={() => setModal({})}>+ Set target</Button>
          </div>
        )}
      </div>
      <section className="panel target-toolbar">
        <div className="review-tabs" role="tablist" aria-label="Target period">
          {periods.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={period === value}
              className={period === value ? "active" : ""}
              onClick={() => {
                setPeriod(value);
                go(periodStart(value, todayPk()));
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="calendar-nav">
          <Button
            variant="secondary"
            aria-label={`Previous ${periodName[period]}`}
            onClick={() => go(shiftPeriod(period, start, -1))}
          >
            <ChevronLeft size={18} />
          </Button>
          <h2 aria-live="polite">{periodLabel(period, start)}</h2>
          <Button
            variant="secondary"
            aria-label={`Next ${periodName[period]}`}
            onClick={() => go(shiftPeriod(period, start, 1))}
          >
            <ChevronRight size={18} />
          </Button>
          <label className="period-jump">
            Go to
            <input
              aria-label={`Choose ${periodName[period]}`}
              type={period === "month" ? "month" : "date"}
              value={period === "month" ? start.slice(0, 7) : start}
              onChange={(e) =>
                e.target.value &&
                go(
                  periodStart(
                    period,
                    period === "month"
                      ? e.target.value + "-01"
                      : e.target.value,
                  ),
                )
              }
            />
          </label>
        </div>
      </section>
      <ErrorBox error={error || q.error} />
      {q.isPending ? (
        <Loader />
      ) : rows.length ? (
        <div className="target-grid fx-stagger">
          {rows.map((t) => (
            <TargetCard
              key={t.id}
              target={t}
              admin={admin}
              onEdit={() => setModal(t)}
            />
          ))}
        </div>
      ) : (
        !q.error && (
          <div className="panel empty">
            No targets for {periodLabel(period, start)}.
            {admin && " Set one, or copy the previous period's targets."}
          </div>
        )
      )}
      <Pagination page={page} count={q.data?.count} onPage={setPage} />
      {modal && (
        <Modal
          title={`${modal.id ? "Edit" : "Set"} ${periodAdjective[modal.period || period]} target`}
          onClose={() => setModal(null)}
        >
          <p className="field-hint">
            {periodLabel(modal.period || period, modal.period_start || start)}.
            Leave a goal at 0 to skip it.
          </p>
          <RecordForm
            initial={modal.id ? modal : undefined}
            fields={[
              ...(modal.id
                ? []
                : [
                    {
                      key: "agent_id",
                      label: "Agent",
                      required: true,
                      options: (Array.isArray(users.data) ? users.data : [])
                        .filter((u) => u.role === "agent" && u.active)
                        .map((u) => ({ value: u.id, label: u.name })),
                    },
                  ]),
              ...targetGoals.map(([key, , label]) => ({
                key,
                label: key === "revenue" ? "Closed revenue (PKR)" : label,
                type: "number",
                default: 0,
              })),
            ]}
            onSave={async (data) => {
              const goals = Object.fromEntries(
                targetGoals.map(([key]) => [key, Number(data[key] || 0)]),
              );
              if (
                Object.entries(goals).some(
                  ([key, value]) =>
                    value < 0 ||
                    (key !== "revenue" && !Number.isInteger(value)),
                )
              )
                throw new Error("Use whole numbers of 0 or more for goals");
              await api("/targets" + (modal.id ? "/" + modal.id : ""), {
                method: modal.id ? "PATCH" : "POST",
                body: modal.id
                  ? goals
                  : {
                      ...goals,
                      agent_id: data.agent_id,
                      period,
                      period_start: start,
                    },
              });
              qc.invalidateQueries({ queryKey: ["targets"] });
              qc.invalidateQueries({ queryKey: ["target-metrics"] });
              toast("Target saved");
              setModal(null);
            }}
          />
        </Modal>
      )}
    </>
  );
}
