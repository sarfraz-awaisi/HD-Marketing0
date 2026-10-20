import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowRight, LockKeyhole, UserRound } from "lucide-react";
import { ErrorBox, PasswordInput } from "../common/UI";
import EmailSuggestionsInput from "../common/EmailSuggestionsInput";
// Sign-in, reset and new-password forms in the glass style. Validation and
// messages match the shared RecordForm ("Required", "Enter a valid email");
// labels stay available to screen readers while the design shows icons and
// placeholders.
export default function GlassForm({
  fields,
  submit,
  pendingLabel,
  onSave,
  autoComplete,
  disabled = false,
  children,
}) {
  const shape = {};
  for (const f of fields) {
    let s = z.string();
    if (f.required) s = s.min(1, "Required");
    if (f.type === "email")
      s = z.union([z.email("Enter a valid email"), z.literal("")]);
    if (f.type === "email" && f.required)
      s = z.string().min(1, "Required").pipe(z.email("Enter a valid email"));
    shape[f.key] = s;
  }
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
    setValue,
    watch,
  } = useForm({
    resolver: zodResolver(z.object(shape)),
    defaultValues: Object.fromEntries(fields.map((f) => [f.key, ""])),
  });
  const busy = disabled || isSubmitting;
  return (
    <form
      className="glass-form"
      autoComplete={autoComplete}
      noValidate
      onSubmit={handleSubmit(async (data) => {
        try {
          await onSave(data);
        } catch (e) {
          setError("root", { message: e.message });
        }
      })}
    >
      {fields.map((f) => {
        const Icon = f.type === "password" ? LockKeyhole : UserRound;
        const error = errors[f.key]?.message;
        const input = {
          "aria-label": f.label,
          "aria-invalid": error ? true : undefined,
          placeholder: f.placeholder,
          autoComplete: f.autoComplete,
          disabled: busy,
        };
        return (
          <div className="glass-field-wrap" key={f.key}>
            <div className={error ? "glass-field invalid" : "glass-field"}>
              <Icon className="glass-field-icon" size={19} aria-hidden="true" />
              {f.type === "password" ? (
                <PasswordInput {...input} {...register(f.key)} />
              ) : Array.isArray(f.suggestions) ? (
                <EmailSuggestionsInput
                  {...input}
                  autoCapitalize="none"
                  spellCheck={false}
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
                  {...input}
                  type={f.type}
                  autoCapitalize="none"
                  spellCheck={false}
                  {...register(f.key)}
                />
              )}
            </div>
            {error && <span className="glass-field-error">{error}</span>}
          </div>
        );
      })}
      {children}
      <ErrorBox error={errors.root?.message} />
      <button
        className="glass-submit"
        disabled={busy}
        aria-busy={isSubmitting || undefined}
      >
        <span className="glass-submit-label">
          {isSubmitting ? pendingLabel || submit : submit}
        </span>
        {isSubmitting ? (
          <span className="glass-spinner" aria-hidden="true" />
        ) : (
          <ArrowRight size={20} aria-hidden="true" />
        )}
      </button>
    </form>
  );
}
