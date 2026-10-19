import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock } from "lucide-react";
import { api, date } from "../../lib/api";
import { weekdays } from "../../lib/firstCall";
import { Button, ErrorBox, Loader, useToast } from "../common/UI";
const minutes = (value) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3, 5));
// Working days and hours (Pakistan time) used for first-call deadlines,
// reminders and the end-of-day call summary.
export default function WorkHours() {
  const qc = useQueryClient(),
    toast = useToast();
  const q = useQuery({
    queryKey: ["work-hours"],
    queryFn: ({ signal }) => api("/settings/work-hours", { signal }),
  });
  const [form, setForm] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (Array.isArray(q.data?.work_days) && !form)
      setForm({
        work_days: q.data.work_days,
        work_start: q.data.work_start,
        work_end: q.data.work_end,
        grace_hours: String(q.data.first_call_grace_minutes / 60),
        idle_days: String(q.data.idle_days),
      });
  }, [q.data, form]);
  async function save(event) {
    event.preventDefault();
    if (busy) return;
    setError("");
    const grace = Math.round(Number(form.grace_hours) * 60),
      idle = Number(form.idle_days);
    if (!form.work_days.length) return setError("Choose at least one day.");
    if (minutes(form.work_end) <= minutes(form.work_start))
      return setError("The working day must end after it starts.");
    if (
      !Number.isFinite(grace) ||
      grace < 0 ||
      grace > minutes(form.work_end) - minutes(form.work_start)
    )
      return setError(
        "The last-call window must be shorter than the working day.",
      );
    if (!Number.isInteger(idle) || idle < 1 || idle > 90)
      return setError("Use 1 to 90 days for quiet leads.");
    setBusy(true);
    try {
      await api("/settings/work-hours", {
        method: "PUT",
        body: {
          work_days: [...form.work_days].sort(),
          work_start: form.work_start,
          work_end: form.work_end,
          first_call_grace_minutes: grace,
          idle_days: idle,
        },
      });
      qc.invalidateQueries({ queryKey: ["work-hours"] });
      qc.invalidateQueries({ queryKey: ["call-activity"] });
      qc.invalidateQueries({ queryKey: ["lead-review"] });
      toast("Working hours saved. New deadlines use them from now on.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel fx-card" aria-labelledby="work-hours-title">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">SALES WORKFLOW</span>
          <h2 id="work-hours-title">Working hours and first calls</h2>
          <p className="field-hint">
            New leads must get their first call on the working day they are
            assigned. Leads assigned during the last-call window, or outside
            working hours, are due by the end of the next working day. Pakistan
            time.
          </p>
        </div>
        <Clock size={20} />
      </div>
      {q.isPending ? (
        <Loader />
      ) : q.error ? (
        <ErrorBox error={q.error} />
      ) : (
        form && (
          <form onSubmit={save}>
            <fieldset disabled={busy} className="work-days">
              <legend>Working days</legend>
              {weekdays.map(([value, label]) => (
                <label key={value} className="day-choice">
                  <input
                    type="checkbox"
                    checked={form.work_days.includes(value)}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        work_days: e.target.checked
                          ? [...form.work_days, value]
                          : form.work_days.filter((d) => d !== value),
                      })
                    }
                  />
                  {label}
                </label>
              ))}
            </fieldset>
            <div className="form-grid">
              <label>
                Day starts
                <input
                  type="time"
                  required
                  disabled={busy}
                  value={form.work_start}
                  onChange={(e) =>
                    setForm({ ...form, work_start: e.target.value })
                  }
                />
              </label>
              <label>
                Day ends
                <input
                  type="time"
                  required
                  disabled={busy}
                  value={form.work_end}
                  onChange={(e) =>
                    setForm({ ...form, work_end: e.target.value })
                  }
                />
              </label>
              <label>
                Last-call window (hours before close)
                <input
                  type="number"
                  min="0"
                  max="10"
                  step="0.5"
                  required
                  disabled={busy}
                  value={form.grace_hours}
                  onChange={(e) =>
                    setForm({ ...form, grace_hours: e.target.value })
                  }
                />
              </label>
              <label>
                Review quiet leads after (days)
                <input
                  type="number"
                  min="1"
                  max="90"
                  required
                  disabled={busy}
                  value={form.idle_days}
                  onChange={(e) =>
                    setForm({ ...form, idle_days: e.target.value })
                  }
                />
              </label>
            </div>
            <ErrorBox error={error} />
            <footer>
              <small>Last changed {date(q.data.updated_at)}</small>
              <Button disabled={busy}>
                {busy ? "Saving…" : "Save working hours"}
              </Button>
            </footer>
          </form>
        )
      )}
    </section>
  );
}
