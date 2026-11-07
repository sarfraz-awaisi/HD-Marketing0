import { useEffect, useRef, useState } from "react";
import { Phone } from "lucide-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import TemperaturePicker from "./TemperaturePicker";
import { Button, ErrorBox } from "../common/UI";
import { localISO, localInput } from "../../lib/api";
import { unansweredOutcomes } from "../../lib/calls";
import {
  otherTags,
  tagTemperature,
  temperatureOf,
} from "../../lib/temperature";
export const outcomes = [
  "No answer",
  "Busy",
  "Wrong number",
  "Interested",
  "Not interested",
  "Follow-up required",
  "Site visit scheduled",
  "Deal discussion",
];
// A call that ends with a promise to follow up schedules that follow-up, so it
// appears under Follow-ups. Optional for other outcomes.
export const followUpOutcome = "Follow-up required";
export const needsFollowUp = (outcome, call = {}, manual = false) =>
  outcome === followUpOutcome && (manual || call.outcome !== followUpOutcome);
function checkFollowUp(data, ctx, call, manual) {
  if (!data.follow_up_at) {
    if (needsFollowUp(data.outcome, call, manual))
      ctx.addIssue({
        code: "custom",
        path: ["follow_up_at"],
        message: "Choose when to follow up",
      });
    return;
  }
  let at = NaN;
  try {
    at = Date.parse(localISO(data.follow_up_at));
  } catch {
    /* Invalid local input is reported below. */
  }
  if (
    !Number.isFinite(at) ||
    at <= Date.now() - 60000 ||
    at >= Date.now() + 366 * 86400000
  )
    ctx.addIssue({
      code: "custom",
      path: ["follow_up_at"],
      message: "Choose a follow-up time in the future, within a year",
    });
}
function outcomeSchema(call, manual, role) {
  const base = z.object({
    outcome: z.enum(outcomes),
    notes: z.string().max(4000, "Use 4000 characters or fewer"),
    follow_up_at: z.string(),
  });
  if (!manual)
    return base.superRefine((data, ctx) => {
      checkFollowUp(data, ctx, call, manual);
      if (
        call.method === "manual" &&
        call.answered === false &&
        !unansweredOutcomes.includes(data.outcome)
      )
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "Choose an unanswered call outcome",
        });
    });
  return base
    .extend({
      answered: z.enum(["yes", "no"]),
      started_at: z.string().min(1, "Enter the call start time"),
      duration_minutes: z.coerce.number().int().min(0).max(120),
      duration_seconds: z.coerce.number().int().min(0).max(59),
    })
    .superRefine((data, ctx) => {
      checkFollowUp(data, ctx, call, manual);
      const total = data.duration_minutes * 60 + data.duration_seconds;
      if (total > 7200 || (data.answered === "yes" && total < 1))
        ctx.addIssue({
          code: "custom",
          path: ["duration_seconds"],
          message:
            "Answered calls need at least 1 second; maximum duration is 120 minutes",
        });
      if (data.answered === "no" && !unansweredOutcomes.includes(data.outcome))
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message: "Choose No answer, Busy or Wrong number",
        });
      let started = NaN;
      try {
        started = Date.parse(localISO(data.started_at));
      } catch {
        /* Invalid local input is reported below. */
      }
      if (
        !Number.isFinite(started) ||
        started > Date.now() + 120000 ||
        started < Date.now() - (role === "admin" ? 30 * 24 : 48) * 3600000
      )
        ctx.addIssue({
          code: "custom",
          path: ["started_at"],
          message:
            role === "admin"
              ? "Use a call start within the past 30 days, in Pakistan time"
              : "Use a call start within the past 48 hours, in Pakistan time",
        });
    });
}
// Formats a call length such as "2:07".
function clock(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export default function OutcomeForm({
  call = {},
  onSave,
  manual = false,
  role = "agent",
  onPending,
  dial,
  onDialStart,
}) {
  // The temperature is chosen here; any other tag an earlier version saved
  // with this call is kept as it is.
  const [temperature, setTemperature] = useState(
    tagTemperature(call.deal_tags),
  );
  const keptTags = otherTags(call.deal_tags);
  const pending = useRef(false);
  // Dialler timer: started when the agent presses Call, stopped by End call
  // (or by saving), and copied into the editable duration fields.
  const [dialStart, setDialStart] = useState(null),
    [dialSeconds, setDialSeconds] = useState(0),
    [dialEnded, setDialEnded] = useState(false);
  const dialing = dialStart !== null && !dialEnded;
  useEffect(() => {
    if (!dialing) return;
    const tick = () =>
      setDialSeconds(Math.round((Date.now() - dialStart) / 1000));
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [dialing, dialStart]);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    setError,
    watch,
    setValue,
  } = useForm({
    resolver: zodResolver(outcomeSchema(call, manual, role)),
    defaultValues: {
      outcome: call.outcome || "",
      notes: call.notes || "",
      follow_up_at: "",
      ...(manual
        ? {
            answered: "yes",
            started_at: localInput(new Date().toISOString()),
            duration_minutes: 0,
            duration_seconds: 0,
          }
        : {}),
    },
  });
  const unanswered = manual
    ? watch("answered") === "no"
    : call.method === "manual" && call.answered === false;
  // A temperature is recorded only after speaking to the customer.
  const spoke = (answered, outcome) =>
    answered && !unansweredOutcomes.includes(outcome);
  const answerField = register("answered");
  function startDial() {
    setValue("started_at", localInput(new Date().toISOString()));
    setDialStart(Date.now());
    setDialSeconds(0);
    setDialEnded(false);
    onDialStart?.();
  }
  function endDial() {
    const seconds = Math.min(
      7200,
      Math.max(0, Math.round((Date.now() - dialStart) / 1000)),
    );
    setDialSeconds(seconds);
    setDialEnded(true);
    setValue("duration_minutes", Math.floor(seconds / 60));
    setValue("duration_seconds", seconds % 60);
  }
  const submit = handleSubmit(async (data) => {
    if (pending.current) return;
    pending.current = true;
    onPending?.(true);
    try {
      const { follow_up_at: followUp, ...rest } = data;
      await onSave({
        ...rest,
        ...(followUp ? { follow_up_at: localISO(followUp) } : {}),
        ...(manual
          ? {
              answered: data.answered === "yes",
              started_at: localISO(data.started_at),
            }
          : {}),
        deal_tags: [
          ...keptTags,
          ...(temperature &&
          spoke(
            manual
              ? data.answered === "yes"
              : !(call.method === "manual" && call.answered === false),
            data.outcome,
          )
            ? [temperatureOf(temperature).tag]
            : []),
        ],
      });
    } catch (e) {
      setError("root", { message: e.message });
    } finally {
      pending.current = false;
      onPending?.(false);
    }
  });
  return (
    <form
      onSubmit={(event) => {
        if (dialing) endDial();
        return submit(event);
      }}
    >
      <fieldset disabled={isSubmitting}>
        {manual && dial && (
          <section className="call-dialer" aria-label="Dialler">
            <a
              className="button fx-btn call-dialer-button"
              href={`tel:${dial}`}
              onClick={startDial}
            >
              <Phone size={18} aria-hidden="true" />
              {dialStart === null ? "Call" : "Call again"} {dial}
            </a>
            {dialStart === null ? (
              <p>
                Your computer asks which app to use, such as Microsoft Phone
                Link. On a phone, the dialler opens.
              </p>
            ) : dialing ? (
              <div className="call-dialer-live">
                <span className="call-dialer-dot" aria-hidden="true" />
                <span role="timer" aria-label="Call time">
                  Call time {clock(dialSeconds)}
                </span>
                <Button type="button" variant="secondary" onClick={endDial}>
                  End call
                </Button>
              </div>
            ) : (
              <p>
                Call ended after {clock(dialSeconds)}. The time is filled in
                below; change it if needed.
              </p>
            )}
          </section>
        )}
        {manual && (
          <>
            {!dial && (
              <p className="notice">
                Call the customer using your company phone, then record the
                result here. Times are in Pakistan (Asia/Karachi).
              </p>
            )}
            <div className="form-grid">
              <label>
                Call connected?
                <select
                  aria-label="Call connected?"
                  {...answerField}
                  onChange={(event) => {
                    answerField.onChange(event);
                    setValue("outcome", "");
                  }}
                >
                  <option value="yes">Connected</option>
                  <option value="no">Not connected</option>
                </select>
              </label>
              <label>
                Call start (Pakistan time)
                <input
                  aria-label="Call start (Pakistan time)"
                  type="datetime-local"
                  required
                  {...register("started_at")}
                />
                <span className="field-error">
                  {errors.started_at?.message}
                </span>
              </label>
              <label>
                Duration minutes
                <input
                  aria-label="Duration minutes"
                  type="number"
                  min="0"
                  max="120"
                  step="1"
                  {...register("duration_minutes")}
                />
                <span className="field-error">
                  {errors.duration_minutes?.message}
                </span>
              </label>
              <label>
                Duration seconds
                <input
                  aria-label="Duration seconds"
                  type="number"
                  min="0"
                  max="59"
                  step="1"
                  {...register("duration_seconds")}
                />
                <span className="field-error">
                  {errors.duration_seconds?.message}
                </span>
              </label>
            </div>
          </>
        )}
        <label>
          Call outcome
          <select aria-label="Call outcome" {...register("outcome")}>
            <option value="">Select an outcome</option>
            {(unanswered ? unansweredOutcomes : outcomes).map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
          <span className="field-error">
            {errors.outcome && "Choose a call outcome"}
          </span>
        </label>
        <label>
          {needsFollowUp(watch("outcome"), call, manual)
            ? "Follow-up date and time (Pakistan time)"
            : "Schedule a follow-up (optional, Pakistan time)"}
          <input
            aria-label="Follow-up date and time"
            type="datetime-local"
            required={needsFollowUp(watch("outcome"), call, manual)}
            {...register("follow_up_at")}
          />
          <span className="field-error">{errors.follow_up_at?.message}</span>
        </label>
        <label>
          Agent notes
          <textarea
            {...register("notes")}
            rows="4"
            placeholder="What did you talk about? Add any other comments."
          />
          <span className="field-error">{errors.notes?.message}</span>
        </label>
        {spoke(!unanswered, watch("outcome")) && (
          <TemperaturePicker value={temperature} onChange={setTemperature} />
        )}
        <ErrorBox error={errors.root?.message} />
        <Button disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : manual ? "Save call" : "Save outcome"}
        </Button>
      </fieldset>
    </form>
  );
}
