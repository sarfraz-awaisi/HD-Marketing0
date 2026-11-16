import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, download } from "../../lib/api";
import { temperatures } from "../../lib/temperature";
import { Button, ErrorBox, Modal } from "../common/UI";
// Administrators' Lead pipeline export: every agent's Hot, Warm or Cold
// leads, as the pipeline counts them (leads assigned to an agent that the
// agent personally contacted), in a CSV or Excel file.
// Excel first: it keeps phone numbers exactly as written. In CSV, a cell
// starting with "+" gets a leading apostrophe so no spreadsheet runs it as a
// formula.
const formats = [
  ["xlsx", "Excel"],
  ["csv", "CSV"],
];
// Today in Pakistan, for the file name.
const pkDay = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi" }).format(
    new Date(),
  );
export default function PipelineExport() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Export
      </Button>
      {open && <ExportDialog onClose={() => setOpen(false)} />}
    </>
  );
}
function ExportDialog({ onClose }) {
  const [format, setFormat] = useState("xlsx"),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [done, setDone] = useState("");
  const totals = useQuery({
    queryKey: ["pipeline-export-summary"],
    queryFn: ({ signal }) => api("/pipeline/export/summary", { signal }),
  });
  async function save(t) {
    if (busy) return;
    setBusy(t.value);
    setError("");
    setDone("");
    try {
      const query = new URLSearchParams({ temperature: t.value, format });
      download(
        await api("/pipeline/export?" + query, { download: true }),
        `hd-pipeline-${t.value}-leads-${pkDay()}.${format}`,
      );
      setDone(`${t.label} leads exported.`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <Modal
      title="Export pipeline leads"
      className="pipeline-export"
      onClose={() => !busy && onClose()}
    >
      <p>
        Choose which leads to export. The file has every agent&apos;s leads of
        that temperature, as the Lead pipeline counts them (leads assigned to an
        agent that the agent personally contacted), with all of each lead&apos;s
        details and advertisement answers.
      </p>
      <fieldset>
        <legend>File type</legend>
        <div className="tag-picker">
          {formats.map(([value, label]) => (
            <label key={value}>
              <input
                type="radio"
                name="pipeline-export-format"
                value={value}
                checked={format === value}
                disabled={!!busy}
                onChange={() => setFormat(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="pipeline-export-choices">
        {temperatures.map((t) => {
          const n = totals.data?.[t.value];
          return (
            <Button
              key={t.value}
              variant="secondary"
              disabled={!!busy || n === 0}
              onClick={() => save(t)}
            >
              <span>
                <span aria-hidden="true">{t.emoji}</span>{" "}
                {busy === t.value
                  ? "Preparing…"
                  : `Export ${t.label.toLowerCase()} leads`}
              </span>
              <small>
                {totals.isPending
                  ? "Counting…"
                  : n === undefined
                    ? ""
                    : n === 0
                      ? `No ${t.label.toLowerCase()} leads`
                      : `${n} ${n === 1 ? "lead" : "leads"}`}
              </small>
            </Button>
          );
        })}
      </div>
      <p className="pipeline-export-note">
        The file includes full phone numbers. Each exported number, and the
        export itself, is recorded in Audit history.
      </p>
      <ErrorBox error={totals.error || error} />
      {done && (
        <p role="status" className="pipeline-export-done">
          {done}
        </p>
      )}
      <footer>
        <Button variant="secondary" disabled={!!busy} onClick={onClose}>
          Close
        </Button>
      </footer>
    </Modal>
  );
}
