import { useId, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { api } from "../../lib/api";
import { invalidateWorkspace } from "../../lib/invalidateWorkspace";
import { Button, ErrorBox, Modal, useToast } from "../common/UI";
import "../../styles/leads.css";
// Update 054: as the server and database check a corrected name.
const placeholders = new Set([
  "unknown",
  "n/a",
  "na",
  "n.a.",
  "none",
  "null",
  "nil",
  "no name",
  "noname",
  "-",
  "--",
  ".",
  "?",
  "customer",
  "client",
]);
export const cleanName = (value) => value.replace(/\s+/g, " ").trim();
export function nameError(value) {
  const name = cleanName(value);
  if (!name) return "Enter the customer's name";
  if (name.length > 100) return "Use a name of up to 100 characters";
  if (/\p{Cc}/u.test(name))
    return "Use letters, spaces and ordinary punctuation only";
  if (!/\p{L}/u.test(name)) return "Enter a name with letters";
  if (placeholders.has(name.toLowerCase()))
    return "Enter the customer's real name";
  return "";
}
// A pencil beside the customer's name: the lead's current agent, or an
// administrator, corrects it after speaking to the customer. Everything else
// about the lead stays as it is.
export default function EditLeadName({ lead, queryKey }) {
  const qc = useQueryClient(),
    toast = useToast(),
    inputId = useId(),
    helpId = useId();
  const [open, setOpen] = useState(false),
    [value, setValue] = useState(""),
    [touched, setTouched] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  const problem = nameError(value);
  const close = () => {
    if (!saving) setOpen(false);
  };
  async function save(event) {
    event.preventDefault();
    setTouched(true);
    if (problem || saving) return;
    setSaving(true);
    setError("");
    try {
      const saved = await api(`/leads/${lead.id}/name`, {
        method: "PUT",
        body: { name: cleanName(value) },
      });
      // The heading changes at once; every list showing the lead reloads.
      qc.setQueryData(queryKey, (old) => old && { ...old, name: saved.name });
      invalidateWorkspace(qc);
      setOpen(false);
      toast(saved.changed ? "Customer name updated" : "The name is unchanged");
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <button
        type="button"
        className="lead-name-edit"
        aria-label={`Edit customer name: ${lead.name}`}
        title="Edit name"
        onClick={() => {
          setValue(lead.name);
          setTouched(false);
          setError("");
          setOpen(true);
        }}
      >
        <Pencil size={16} aria-hidden="true" />
      </button>
      {open && (
        <Modal
          className="lead-name-dialog"
          title="Edit customer name"
          onClose={close}
        >
          <form noValidate onSubmit={save}>
            <div className="lead-name-field">
              <label htmlFor={inputId}>Customer name</label>
              <input
                id={inputId}
                autoFocus
                autoComplete="off"
                maxLength={120}
                value={value}
                disabled={saving}
                aria-invalid={touched && problem ? "true" : undefined}
                aria-describedby={helpId}
                onChange={(e) => setValue(e.target.value)}
                onBlur={() => setTouched(true)}
              />
              <span
                id={helpId}
                className={touched && problem ? "field-error" : "field-hint"}
              >
                {touched && problem
                  ? problem
                  : "Only the name changes. The phone number, calls, notes and follow-ups stay as they are."}
              </span>
            </div>
            <ErrorBox error={error} />
            <div className="actions">
              <Button
                type="button"
                variant="secondary"
                disabled={saving}
                onClick={close}
              >
                Cancel
              </Button>
              <Button disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
