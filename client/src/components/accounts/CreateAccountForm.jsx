import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button, ErrorBox, PasswordInput } from "../common/UI";
import { api } from "../../lib/api";
import {
  gmailError,
  normalizeEmail,
  uidError,
  UID_TAKEN_MESSAGE,
} from "../../lib/accountFields";
const passwordError = (value) =>
  value.length < 12 ||
  value.length > 72 ||
  new TextEncoder().encode(value).length > 72
    ? "Use a password of at least 12 characters and no more than 72 bytes."
    : "";
const schema = z
  .object({
    name: z.string(),
    email: z.string(),
    role: z.enum(["agent", "admin", "staff"]),
    department_id: z.string(),
    job_title: z.string(),
    password: z.string(),
    confirm_password: z.string(),
    uid_mode: z.enum(["auto", "manual"]),
    uid: z.string(),
  })
  .superRefine((data, ctx) => {
    const check = (path, message) =>
      message && ctx.addIssue({ code: "custom", path: [path], message });
    check(
      "name",
      !data.name.trim()
        ? "Required"
        : data.name.trim().length > 200
          ? "Enter a name up to 200 characters."
          : "",
    );
    check("email", gmailError(data.email));
    check("password", passwordError(data.password));
    check(
      "confirm_password",
      data.password !== data.confirm_password ? "Passwords must match." : "",
    );
    if (data.uid_mode === "manual") check("uid", uidError(data.uid));
    check(
      "job_title",
      data.job_title.trim().length > 80
        ? "Use a job title of up to 80 characters."
        : "",
    );
    check(
      "department_id",
      data.role === "staff" && !data.department_id
        ? "Choose the department this staff member works in."
        : "",
    );
  });
const fieldFor = {
  ACCOUNTS_INVALID_EMAIL: "email",
  ACCOUNTS_EMAIL_EXISTS: "email",
  ACCOUNTS_INVALID_UID: "uid",
  ACCOUNTS_UID_TAKEN: "uid",
};
export default function CreateAccountForm({
  request,
  onCreate,
  onIncomplete,
  disabled = false,
}) {
  const {
    register,
    handleSubmit,
    watch,
    setError,
    clearErrors,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(schema),
    mode: "onTouched",
    defaultValues: {
      name: "",
      email: "",
      role: "agent",
      department_id: "",
      job_title: "",
      password: "",
      confirm_password: "",
      uid_mode: "auto",
      uid: "",
    },
  });
  const mode = watch("uid_mode"),
    uid = watch("uid"),
    role = watch("role");
  // Update 047: departments for the new account (active ones only).
  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: ({ signal }) => api("/admin/departments", { signal }),
    retry: false,
  });
  const [availability, setAvailability] = useState(null);
  useEffect(() => {
    if (mode === "auto") clearErrors("uid");
  }, [mode, clearErrors]);
  // Advisory only: the server and the database recheck at creation time.
  useEffect(() => {
    if (mode !== "manual" || uidError(uid)) {
      setAvailability(null);
      return;
    }
    let live = true;
    setAvailability({ uid, checking: true });
    const timer = setTimeout(() => {
      request(`/accounts/uid-availability?uid=${uid}`)
        .then((result) => {
          if (live) setAvailability({ uid, available: result.available });
        })
        .catch(() => {
          if (live) setAvailability(null);
        });
    }, 350);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [mode, uid, request]);
  const busy = disabled || isSubmitting;
  const current = mode === "manual" && availability?.uid === uid;
  const taken = current && availability.available === false;
  return (
    <form
      autoComplete="off"
      noValidate
      onSubmit={handleSubmit(async (data) => {
        if (taken) {
          setError("uid", { message: UID_TAKEN_MESSAGE });
          return;
        }
        try {
          await onCreate({
            name: data.name.trim(),
            email: normalizeEmail(data.email),
            role: data.role,
            ...(data.department_id
              ? { department_id: data.department_id }
              : {}),
            ...(data.job_title.trim()
              ? { job_title: data.job_title.trim() }
              : {}),
            password: data.password,
            uid_mode: data.uid_mode,
            ...(data.uid_mode === "manual" ? { uid: data.uid } : {}),
          });
        } catch (e) {
          if (e.code === "ACCOUNTS_UID_TAKEN")
            setAvailability({ uid: data.uid, available: false });
          if (e.code === "ACCOUNTS_CREATE_INCOMPLETE") onIncomplete?.();
          setError(fieldFor[e.code] || "root", { message: e.message });
        }
      })}
    >
      <div className="form-grid">
        <label>
          Full name *
          <input aria-label="Full name" disabled={busy} {...register("name")} />
          <span className="field-error">{errors.name?.message}</span>
        </label>
        <label>
          Account role *
          <select
            aria-label="Account role"
            disabled={busy}
            {...register("role")}
          >
            <option value="agent">Agent</option>
            <option value="staff">Staff</option>
            <option value="admin">Admin</option>
          </select>
          {role === "staff" && (
            <span className="field-hint">
              Office staff: tasks, reports, attendance and leave only, without
              leads or inventory.
            </span>
          )}
        </label>
        <label>
          Department{role === "staff" ? " *" : ""}
          <select
            aria-label="Department"
            aria-invalid={!!errors.department_id}
            disabled={busy}
            {...register("department_id")}
          >
            <option value="">Not assigned</option>
            {(Array.isArray(departments.data) ? departments.data : [])
              .filter((d) => d.active)
              .map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
          </select>
          <span className="field-error">{errors.department_id?.message}</span>
        </label>
        <label>
          Job title
          <input
            aria-label="Job title"
            placeholder={
              role === "staff" ? "e.g. Video Editor" : "e.g. Sales Agent"
            }
            maxLength={80}
            disabled={busy}
            {...register("job_title")}
          />
          <span className="field-error">{errors.job_title?.message}</span>
          {role === "staff" && (
            <span className="field-hint">
              A shift other than the company shift is set in Employee management
              after the account is created.
            </span>
          )}
        </label>
        <label className="wide">
          Gmail address *
          <input
            aria-label="Gmail address"
            type="email"
            inputMode="email"
            placeholder="name@gmail.com"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={!!errors.email}
            disabled={busy}
            {...register("email")}
          />
          <span className="field-error">{errors.email?.message}</span>
        </label>
        <label>
          New password *
          <PasswordInput
            aria-label="New password"
            autoComplete="new-password"
            disabled={busy}
            {...register("password")}
          />
          <span className="field-error">{errors.password?.message}</span>
        </label>
        <label>
          Confirm password *
          <PasswordInput
            aria-label="Confirm password"
            autoComplete="new-password"
            disabled={busy}
            {...register("confirm_password")}
          />
          <span className="field-error">
            {errors.confirm_password?.message}
          </span>
        </label>
      </div>
      <fieldset className="account-uid-options" disabled={busy}>
        <legend>Account UID</legend>
        <label className="uid-choice">
          <input type="radio" value="auto" {...register("uid_mode")} />
          <span>Auto Generate UID</span>
        </label>
        <label className="uid-choice">
          <input type="radio" value="manual" {...register("uid_mode")} />
          <span>Enter UID Manually</span>
        </label>
        {mode === "manual" ? (
          <label className="uid-entry">
            Enter 6-Digit UID *
            <input
              aria-label="Enter 6-Digit UID"
              inputMode="numeric"
              placeholder="e.g. 583214"
              aria-invalid={!!errors.uid || taken}
              {...register("uid")}
            />
            <span className="field-error">
              {errors.uid?.message || (taken ? UID_TAKEN_MESSAGE : "")}
            </span>
            {current && !taken && (
              <span className="field-hint" role="status">
                {availability.checking
                  ? "Checking availability…"
                  : `UID ${uid} is available.`}
              </span>
            )}
          </label>
        ) : (
          <p className="field-hint">
            A unique six-digit UID is generated securely when the account is
            created.
          </p>
        )}
      </fieldset>
      <p className="security-note">
        The account is created immediately with this password and can sign in
        through the matching Agent, Staff or Admin login. Share the password
        with its owner securely; it is never shown again.
      </p>
      <ErrorBox error={errors.root?.message} />
      <footer>
        <Button disabled={busy}>
          {isSubmitting ? "Creating account…" : "Create account"}
        </Button>
      </footer>
    </form>
  );
}
