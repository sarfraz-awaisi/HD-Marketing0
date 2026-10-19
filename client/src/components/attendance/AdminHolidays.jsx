import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { invalidateAttendance } from "../../lib/attendance";
import { fullDayLabel, todayPk } from "../../lib/calendar";
import { Button, ErrorBox, Loader, Modal, Table, useToast } from "../common/UI";
// Company holidays: no check-in is expected and the day is not an absence.
export default function AdminHolidays() {
  const qc = useQueryClient(),
    toast = useToast();
  const [year, setYear] = useState(Number(todayPk().slice(0, 4))),
    [form, setForm] = useState({
      holiday_date: todayPk(),
      name: "",
      description: "",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [removing, setRemoving] = useState(null);
  const q = useQuery({
    queryKey: ["attendance-admin", "holidays", year],
    queryFn: ({ signal }) =>
      api(`/admin/attendance/holidays?year=${year}`, { signal }),
  });
  async function add(event) {
    event.preventDefault();
    if (busy) return;
    if (!form.name.trim()) return setError("Name the holiday.");
    setBusy(true);
    setError("");
    try {
      await api("/admin/attendance/holidays", {
        method: "POST",
        body: {
          holiday_date: form.holiday_date,
          name: form.name.trim(),
          ...(form.description.trim()
            ? { description: form.description.trim() }
            : {}),
        },
      });
      setForm({ ...form, name: "", description: "" });
      invalidateAttendance(qc);
      toast("Holiday added");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await api(`/admin/attendance/holidays/${removing.id}`, {
        method: "DELETE",
      });
      setRemoving(null);
      invalidateAttendance(qc);
      toast("Holiday removed");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <section className="panel">
        <h2>Add a holiday</h2>
        <form onSubmit={add}>
          <fieldset disabled={busy} className="form-grid">
            <label>
              Date
              <input
                type="date"
                required
                value={form.holiday_date}
                onChange={(e) =>
                  setForm({ ...form, holiday_date: e.target.value })
                }
              />
            </label>
            <label>
              Name
              <input
                required
                maxLength={80}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </label>
            <label className="wide">
              Description (optional)
              <input
                maxLength={300}
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
              />
            </label>
          </fieldset>
          <ErrorBox error={!removing && error} />
          <footer>
            <Button disabled={busy}>{busy ? "Saving…" : "Add holiday"}</Button>
          </footer>
        </form>
      </section>
      <section className="panel">
        <div className="calendar-nav">
          <Button
            variant="secondary"
            aria-label="Previous year"
            onClick={() => setYear(year - 1)}
          >
            ‹
          </Button>
          <h2>Holidays in {year}</h2>
          <Button
            variant="secondary"
            aria-label="Next year"
            onClick={() => setYear(year + 1)}
          >
            ›
          </Button>
        </div>
        <ErrorBox error={q.error} />
        {q.isPending ? (
          <Loader />
        ) : (
          <Table
            rows={Array.isArray(q.data) ? q.data : []}
            columns={[
              {
                key: "holiday_date",
                label: "Date",
                render: (h) => fullDayLabel(h.holiday_date),
              },
              { key: "name", label: "Holiday" },
              {
                key: "description",
                label: "Description",
                render: (h) => h.description || "—",
              },
              {
                key: "remove",
                label: "Actions",
                render: (h) => (
                  <Button variant="danger" onClick={() => setRemoving(h)}>
                    Remove
                  </Button>
                ),
              },
            ]}
          />
        )}
      </section>
      {removing && (
        <Modal
          title="Remove holiday?"
          onClose={() => !busy && setRemoving(null)}
        >
          <p>
            {removing.name} on {fullDayLabel(removing.holiday_date)} will become
            a normal working day. Employees without a check-in that day will
            show as absent.
          </p>
          <ErrorBox error={error} />
          <footer className="review-buttons">
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => setRemoving(null)}
            >
              Keep holiday
            </Button>
            <Button variant="danger" disabled={busy} onClick={remove}>
              {busy ? "Removing…" : "Remove"}
            </Button>
          </footer>
        </Modal>
      )}
    </>
  );
}
