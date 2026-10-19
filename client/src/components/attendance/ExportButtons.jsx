import { useState } from "react";
import { api, download } from "../../lib/api";
import { Button, ErrorBox } from "../common/UI";
// CSV or Excel download of the report currently shown, with its filters.
export default function ExportButtons({ params, name }) {
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  async function save(format) {
    if (busy) return;
    setBusy(format);
    setError("");
    try {
      const query = new URLSearchParams({ ...params, format });
      download(
        await api("/admin/attendance/export?" + query, { download: true }),
        `${name}.${format}`,
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy("");
    }
  }
  return (
    <div className="export-buttons">
      <Button variant="secondary" disabled={!!busy} onClick={() => save("csv")}>
        {busy === "csv" ? "Preparing…" : "Export CSV"}
      </Button>
      <Button
        variant="secondary"
        disabled={!!busy}
        onClick={() => save("xlsx")}
      >
        {busy === "xlsx" ? "Preparing…" : "Export Excel"}
      </Button>
      <ErrorBox error={error} />
    </div>
  );
}
