import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Button, ErrorBox, Modal } from "../common/UI";
import { statuses, statusLabel, lostReasons } from "../../lib/pipeline";

export function LostReasonForm({ initial = {}, onSave, onCancel }) {
  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm({
    resolver: zodResolver(
      z.object({
        lost_reason: z.enum(
          lostReasons.map((reason) => reason.value),
          { error: "Choose a lost reason" },
        ),
        lost_note: z.string().trim().max(500, "Use 500 characters or fewer"),
      }),
    ),
    defaultValues: {
      lost_reason: initial.lost_reason || "",
      lost_note: initial.lost_note || "",
    },
  });
  return (
    <form
      onSubmit={handleSubmit(async (data) => {
        try {
          await onSave({ status: "lost", ...data });
        } catch (error) {
          setError("root", { message: error.message });
        }
      })}
    >
      <label>
        Lost reason *
        <select aria-label="Lost reason" {...register("lost_reason")}>
          <option value="">Choose a reason</option>
          {lostReasons.map((reason) => (
            <option key={reason.value} value={reason.value}>
              {reason.label}
            </option>
          ))}
        </select>
        <span className="field-error">{errors.lost_reason?.message}</span>
      </label>
      <label>
        Lost note (optional)
        <textarea rows="3" maxLength={500} {...register("lost_note")} />
        <small>{(watch("lost_note") || "").length} / 500 characters</small>
        <span className="field-error">{errors.lost_note?.message}</span>
      </label>
      <ErrorBox error={errors.root?.message} />
      <footer className="actions">
        <Button disabled={isSubmitting}>
          {isSubmitting ? "Saving…" : "Save lost reason"}
        </Button>
        {onCancel && (
          <Button
            type="button"
            variant="secondary"
            disabled={isSubmitting}
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </footer>
    </form>
  );
}

export default function LeadStatusControl({ lead, onSave, disabled = false }) {
  const [showLoss, setShowLoss] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState("");
  return (
    <>
      <label>
        Status
        <select
          aria-label="Lead status"
          value={lead.status}
          disabled={disabled || saving}
          onChange={async (event) => {
            const status = event.target.value;
            setError("");
            if (status === "lost") {
              setShowLoss(true);
              return;
            }
            setSaving(true);
            try {
              await onSave({ status });
            } catch (failure) {
              setError(failure.message);
            } finally {
              setSaving(false);
            }
          }}
        >
          {statuses.map((status) => (
            <option key={status} value={status}>
              {statusLabel(status)}
            </option>
          ))}
        </select>
      </label>
      <ErrorBox error={error} />
      {lead.status === "lost" && (
        <Button
          variant="secondary"
          disabled={disabled || saving}
          onClick={() => setShowLoss(true)}
        >
          Edit lost reason
        </Button>
      )}
      {showLoss && (
        <Modal title="Mark lead as lost" onClose={() => setShowLoss(false)}>
          <LostReasonForm
            initial={lead}
            onCancel={() => setShowLoss(false)}
            onSave={async (data) => {
              await onSave(data);
              setShowLoss(false);
            }}
          />
        </Modal>
      )}
    </>
  );
}
