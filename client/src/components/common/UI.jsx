import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Eye, EyeOff } from "lucide-react";
import { statusLabel } from "../../lib/pipeline";
import EmailSuggestionsInput from "./EmailSuggestionsInput";
export function Button({ children, variant = "", className = "", ...props }) {
  return (
    <button className={`button fx-btn ${variant} ${className}`} {...props}>
      {children}
    </button>
  );
}
export function Loader() {
  return (
    <div role="status" className="loading">
      <span className="spinner" />
      <div className="loading-copy">
        <span>Loading workspace…</span>
        <span className="fx-skeleton" aria-hidden="true" />
      </div>
    </div>
  );
}
export function ErrorBox({ error }) {
  return error ? (
    <div role="alert" className="error">
      {error.message || error}
    </div>
  ) : null;
}
// Exit animations run only when the browser allows motion (jsdom has no
// matchMedia, so tests close immediately).
function motionAllowed() {
  return (
    typeof window.matchMedia === "function" &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
export function Modal({
  title,
  children,
  onClose,
  className,
  animateClose = true,
}) {
  const ref = useRef();
  const titleId = useId();
  const closing = useRef(false);
  // Fade out, then ask the parent to close. A parent that keeps the dialog
  // open (for example while saving) gets it back unchanged.
  function requestClose() {
    if (closing.current) return;
    if (!animateClose || !motionAllowed()) return onClose();
    closing.current = true;
    ref.current?.classList.add("fx-closing");
    setTimeout(() => {
      onClose();
      setTimeout(() => {
        closing.current = false;
        ref.current?.classList.remove("fx-closing");
      }, 0);
    }, 140);
  }
  useEffect(() => {
    const focus = document.activeElement;
    ref.current.showModal();
    return () => focus?.focus?.();
  }, []);
  return (
    <dialog
      ref={ref}
      className={className}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        requestClose();
      }}
      onClick={(e) => {
        if (e.target !== ref.current) return;
        const bounds = ref.current.getBoundingClientRect();
        if (
          e.clientX < bounds.left ||
          e.clientX > bounds.right ||
          e.clientY < bounds.top ||
          e.clientY > bounds.bottom
        )
          requestClose();
      }}
    >
      <header>
        <h2 id={titleId}>{title}</h2>
        <button aria-label="Close dialog" onClick={requestClose}>
          ×
        </button>
      </header>
      {children}
    </dialog>
  );
}
export function Table({
  columns,
  rows,
  onRow,
  showSerial = false,
  page = 1,
  pageSize = 20,
  count,
  selection,
}) {
  if (selection)
    columns = [
      {
        key: "__select",
        label: (
          <input
            type="checkbox"
            aria-label="Select all on this page"
            checked={
              rows.length > 0 &&
              rows.every((row) => selection.ids.includes(row.id))
            }
            onChange={(event) =>
              selection.togglePage(rows, event.target.checked)
            }
          />
        ),
        render: (row) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.name || row.id}`}
            checked={selection.ids.includes(row.id)}
            disabled={
              !selection.ids.includes(row.id) && selection.ids.length >= 500
            }
            onChange={(event) => selection.toggle(row.id, event.target.checked)}
          />
        ),
      },
      ...columns,
    ];
  if (showSerial)
    columns = [
      {
        key: "__serial",
        label: "#",
        render: (_row, index) => (page - 1) * pageSize + index + 1,
      },
      ...columns,
    ];
  if (!rows.length)
    return (
      <div className="empty">
        {showSerial && count !== undefined && (
          <p className="lead-count">Showing 0–0 of {count} leads</p>
        )}
        No records to show. Adjust your filters or add a record.
      </div>
    );
  return (
    <>
      {showSerial && count !== undefined && (
        <p className="lead-count" role="status">
          Showing {count ? (page - 1) * pageSize + 1 : 0}–
          {Math.min(page * pageSize, count)} of {count} leads
        </p>
      )}
      <div
        className="table-scroll"
        role="region"
        aria-label="Scrollable records"
        tabIndex={0}
      >
        <table className={`fx-table${showSerial ? " lead-record-table" : ""}`}>
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} data-field={c.key}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id}>
                {columns.map((c) => (
                  <td
                    key={c.key}
                    data-field={c.key}
                    data-label={
                      typeof c.label === "string" ? c.label : "Select"
                    }
                  >
                    {c.render
                      ? c.render(row, index)
                      : String(row[c.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
export function Pagination({ page, count, limit = 20, onPage }) {
  return (
    <div className="pagination">
      <span>
        {count ?? 0} records · Page {page}
      </span>
      <Button
        variant="secondary"
        disabled={page === 1}
        onClick={() => onPage(page - 1)}
      >
        Previous
      </Button>
      <Button
        variant="secondary"
        disabled={page * limit >= (count || 0)}
        onClick={() => onPage(page + 1)}
      >
        Next
      </Button>
    </div>
  );
}
export function Badge({ value }) {
  return (
    <span className={`badge fx-badge ${value}`}>{statusLabel(value)}</span>
  );
}
const ToastContext = createContext();
export const useToast = () => useContext(ToastContext);
export function ToastProvider({ children }) {
  const [toast, setToast] = useState(""),
    [leaving, setLeaving] = useState(false);
  useEffect(() => {
    setLeaving(false);
    if (!toast) return;
    const fade = setTimeout(() => setLeaving(true), 4320);
    const t = setTimeout(() => setToast(""), 4500);
    return () => {
      clearTimeout(fade);
      clearTimeout(t);
    };
  }, [toast]);
  return (
    <ToastContext.Provider value={setToast}>
      {children}
      {toast && (
        <div
          className={leaving ? "toast fx-toast fx-leaving" : "toast fx-toast"}
          role="status"
        >
          {toast}
        </div>
      )}
    </ToastContext.Provider>
  );
}
export function PasswordInput(props) {
  const [visible, setVisible] = useState(false);
  const id = useId();
  const action = visible ? "Hide password" : "Show password";
  return (
    <span className="password-field">
      <input {...props} id={id} type={visible ? "text" : "password"} />
      <button
        type="button"
        className="icon-button password-toggle"
        aria-label={action}
        aria-controls={id}
        title={action}
        disabled={props.disabled}
        onClick={() => setVisible((current) => !current)}
      >
        {visible ? (
          <EyeOff size={20} aria-hidden="true" />
        ) : (
          <Eye size={20} aria-hidden="true" />
        )}
      </button>
    </span>
  );
}
export function RecordForm({
  fields,
  initial = {},
  onSave,
  submit = "Save record",
  children,
  autoComplete,
  disabled = false,
}) {
  const shape = {};
  fields.forEach((f) => {
    let s = f.type === "number" ? z.coerce.number().min(0) : z.string();
    if (f.required && f.type !== "number") s = s.min(1, "Required");
    if (f.type === "email")
      s = z.union([z.email("Enter a valid email"), z.literal("")]);
    shape[f.key] = s;
  });
  const defaults = Object.fromEntries(
    fields.map((f) => [f.key, initial[f.key] ?? f.default ?? ""]),
  );
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
    setValue,
    watch,
  } = useForm({
    resolver: zodResolver(z.object(shape)),
    defaultValues: defaults,
  });
  return (
    <form
      autoComplete={autoComplete}
      onSubmit={handleSubmit(async (data) => {
        try {
          await onSave(data);
        } catch (e) {
          setError("root", { message: e.message });
        }
      })}
    >
      <div className="form-grid">
        {fields.map((f) => (
          <label key={f.key} className={f.type === "textarea" ? "wide" : ""}>
            {f.label}
            {f.required && " *"}
            {f.options ? (
              <select
                aria-label={f.label}
                disabled={disabled || isSubmitting}
                {...register(f.key)}
              >
                {!f.required && <option value="">None</option>}
                {f.options.map((o) => (
                  <option key={o.value ?? o} value={o.value ?? o}>
                    {o.label ?? o}
                  </option>
                ))}
              </select>
            ) : f.type === "textarea" ? (
              <textarea
                aria-label={f.label}
                rows="3"
                disabled={disabled || isSubmitting}
                {...register(f.key)}
              />
            ) : f.type === "password" ? (
              <PasswordInput
                aria-label={f.label}
                autoComplete={f.autoComplete}
                disabled={disabled || isSubmitting}
                {...register(f.key)}
              />
            ) : f.type === "email" && Array.isArray(f.suggestions) ? (
              <EmailSuggestionsInput
                aria-label={f.label}
                autoComplete={f.autoComplete}
                autoCapitalize={f.autoCapitalize}
                spellCheck={f.spellCheck}
                disabled={disabled || isSubmitting}
                {...register(f.key)}
                value={watch(f.key) || ""}
                suggestions={f.suggestions}
                onSelect={(email) =>
                  setValue(f.key, email, {
                    shouldDirty: true,
                    shouldTouch: true,
                    shouldValidate: true,
                  })
                }
              />
            ) : (
              <input
                aria-label={f.label}
                type={f.type || "text"}
                inputMode={f.inputMode}
                autoComplete={f.autoComplete}
                autoCapitalize={f.autoCapitalize}
                spellCheck={f.spellCheck}
                step={f.type === "number" ? "any" : undefined}
                disabled={disabled || isSubmitting}
                {...register(f.key)}
              />
            )}
            <span className="field-error">{errors[f.key]?.message}</span>
          </label>
        ))}
      </div>
      {typeof children === "function"
        ? children({ isSubmitting, values: watch() })
        : children}
      <ErrorBox error={errors.root?.message} />
      <footer>
        <Button disabled={disabled || isSubmitting}>
          {isSubmitting ? "Saving…" : submit}
        </Button>
      </footer>
    </form>
  );
}
