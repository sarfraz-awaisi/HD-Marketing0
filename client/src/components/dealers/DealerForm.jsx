import { useRef, useState } from "react";
import { api } from "../../lib/api";
import {
  blankDealer,
  cleanDealer,
  dealerErrors,
  dealerFields,
  dealerStatus,
  normalizeDealerPhone,
} from "../../lib/dealers";
import { Button, ErrorBox } from "../common/UI";

// Add a dealer (administrators and agents) or change one (administrators,
// initial set). The same client_key is sent until the form is closed, so a
// repeated click or a retry after a lost reply never adds the dealer twice.
export default function DealerForm({ initial, admin, onSaved, onCancel }) {
  const editing = !!initial?.id;
  const [form, setForm] = useState(() =>
    editing
      ? Object.fromEntries(
          dealerFields.map(({ key }) => [key, initial[key] ?? ""]),
        )
      : blankDealer,
  );
  const [errors, setErrors] = useState({}),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [matches, setMatches] = useState(null);
  const key = useRef(crypto.randomUUID());
  const checked = useRef("");
  const set = (field) => (e) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    if (errors[field]) setErrors(({ [field]: _, ...rest }) => rest);
    if (field === "phone") setMatches(null);
  };
  // After the number is typed: other dealers with it (an agent's own only).
  async function checkPhone() {
    const phone = normalizeDealerPhone(form.phone);
    if (!phone || phone === checked.current) return;
    if (editing && phone === initial.phone) return setMatches(null);
    checked.current = phone;
    try {
      const params = new URLSearchParams({ phone });
      if (editing) params.set("except", initial.id);
      const result = await api("/dealers/check-phone?" + params);
      if (normalizeDealerPhone(form.phone) === phone)
        setMatches(result.matches);
    } catch {
      // The check only helps; saving checks again.
      checked.current = "";
    }
  }
  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    const found = dealerErrors(form);
    setErrors(found);
    setError("");
    if (Object.keys(found).length) {
      e.currentTarget
        .querySelector(`[name="${Object.keys(found)[0]}"]`)
        ?.focus();
      return;
    }
    const values = cleanDealer(form);
    values.phone = normalizeDealerPhone(values.phone);
    let body;
    if (editing) {
      body = Object.fromEntries(
        Object.entries(values).filter(([k, v]) => v !== (initial[k] ?? null)),
      );
      if (!Object.keys(body).length) return onCancel();
      body.expected_updated_at = initial.updated_at;
    } else body = { ...values, client_key: key.current };
    setBusy(true);
    try {
      const saved = await api(editing ? `/dealers/${initial.id}` : "/dealers", {
        method: editing ? "PATCH" : "POST",
        body,
      });
      onSaved(saved);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const field = ({ key: name, label, max, required }) => {
    const props = {
      name,
      value: form[name],
      onChange: set(name),
      maxLength: max,
      disabled: busy,
      "aria-invalid": errors[name] ? true : undefined,
      "aria-describedby": errors[name] ? `dealer-${name}-error` : undefined,
    };
    return (
      <label
        key={name}
        className={name === "address" || name === "notes" ? "wide" : ""}
      >
        {label}
        {required ? " *" : ""}
        {name === "address" || name === "notes" ? (
          <textarea rows={name === "notes" ? 3 : 2} {...props} />
        ) : (
          <input
            {...props}
            type={name === "phone" ? "tel" : "text"}
            inputMode={name === "phone" ? "tel" : undefined}
            autoComplete="off"
            placeholder={
              name === "phone"
                ? "0300 1234567"
                : name === "name"
                  ? "Dealer's full name"
                  : undefined
            }
            onBlur={name === "phone" ? checkPhone : undefined}
          />
        )}
        {errors[name] && (
          <span className="field-error" id={`dealer-${name}-error`}>
            {errors[name]}
          </span>
        )}
      </label>
    );
  };
  // Agents are only ever told about their own dealers (the server sends
  // nothing else); administrators see who recorded each match.
  const own = admin ? [] : matches || [];
  const others = admin ? matches || [] : [];
  return (
    <form className="dealer-form" onSubmit={submit} noValidate>
      {!editing && (
        <p className="field-hint">
          {admin
            ? "Dealers you add are approved straight away."
            : "An administrator reviews each dealer you add. You can't change or delete a dealer after submitting it."}
        </p>
      )}
      <div className="form-grid">{dealerFields.map(field)}</div>
      {matches?.length > 0 && (
        <div className="notice dealer-duplicates" role="status">
          {own.length > 0 && (
            <p>
              You already added this number:{" "}
              {own
                .map(
                  (m) =>
                    `${m.reference} ${m.name} (${dealerStatus(m.status).label})`,
                )
                .join("; ")}
              .
              {own.some((m) => m.status !== "rejected") &&
                " Open that dealer instead of adding it again."}
            </p>
          )}
          {others.length > 0 && (
            <p>
              Already recorded with this number by{" "}
              {others
                .map(
                  (m) =>
                    `${m.submitted_by?.name || "another person"} (${m.reference}, ${dealerStatus(m.status).label})`,
                )
                .join("; ")}
              . Saving keeps both records; nothing is merged.
            </p>
          )}
        </div>
      )}
      <ErrorBox error={error} />
      <div className="actions">
        <Button
          type="button"
          variant="secondary"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : editing ? "Save changes" : "Add dealer"}
        </Button>
      </div>
    </form>
  );
}
