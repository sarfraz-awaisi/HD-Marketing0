import { z } from "zod";
export const uuid = z.string().uuid();
export const mfaVerification = z
  .object({ factor_id: uuid, code: z.string().regex(/^\d{6}$/) })
  .strict();
export const mfaResetRequest = z.object({ confirm: z.literal(true) }).strict();
export const statuses = [
  "new",
  "contacted",
  "interested",
  "visit_scheduled",
  "visit_done",
  "negotiation",
  "won",
  "lost",
];
export const lostReasons = [
  "price",
  "location",
  "budget",
  "not_interested",
  "no_response",
  "bought_elsewhere",
  "wrong_number",
  "other",
];
const lossFields = {
  lost_reason: z.enum(lostReasons).nullable().optional(),
  lost_note: z.string().trim().max(500).nullable().optional(),
};
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
export const tags = [
  "Hot lead",
  "Warm lead",
  "Cold lead",
  "Budget mismatch",
  "Location mismatch",
  "Ready to visit",
  "Ready to close",
];
export function manualCall(role) {
  return z
    .object({
      answered: z.boolean(),
      started_at: z.iso.datetime({ offset: true }),
      duration_minutes: z.number().int().min(0).max(120).optional(),
      duration_seconds: z.number().int().min(0).max(7200),
      outcome: z.enum(outcomes),
      notes: z.string().max(4000).default(""),
      deal_tags: z.array(z.enum(tags)).max(7).default([]),
    })
    .strict()
    .superRefine((data, ctx) => {
      const total = (data.duration_minutes || 0) * 60 + data.duration_seconds;
      if (
        total > 7200 ||
        (data.duration_minutes !== undefined && data.duration_seconds > 59) ||
        (data.answered && total < 1)
      )
        ctx.addIssue({
          code: "custom",
          path: ["duration_seconds"],
          message: "Use a valid call duration up to 120 minutes",
        });
      if (
        !data.answered &&
        !["No answer", "Busy", "Wrong number"].includes(data.outcome)
      )
        ctx.addIssue({
          code: "custom",
          path: ["outcome"],
          message:
            "Choose No answer, Busy or Wrong number for an unanswered call",
        });
      const started = Date.parse(data.started_at);
      const oldest = Date.now() - (role === "admin" ? 30 * 24 : 48) * 3600000;
      if (started > Date.now() + 120000 || started < oldest)
        ctx.addIssue({
          code: "custom",
          path: ["started_at"],
          message:
            role === "admin"
              ? "Log calls within the past 30 days"
              : "Log calls within the past 48 hours",
        });
      if (new Set(data.deal_tags).size !== data.deal_tags.length)
        ctx.addIssue({
          code: "custom",
          path: ["deal_tags"],
          message: "Choose distinct deal tags",
        });
    })
    .transform(({ duration_minutes, duration_seconds, ...data }) => ({
      ...data,
      duration_seconds: (duration_minutes || 0) * 60 + duration_seconds,
    }));
}
const text = z.string().max(4000),
  amount = z.coerce.number().min(0).max(1e13),
  time = z.iso.datetime({ offset: true });
const lead = z.object({
  name: text.min(1).max(200),
  email: z.union([z.email(), z.literal("")]).optional(),
  source: z
    .enum(["manual", "CSV", "Meta", "WhatsApp", "other"])
    .default("manual"),
  property_id: uuid.nullable().optional(),
  budget_min: amount.default(0),
  budget_max: amount.nullable().optional(),
  preferred_location: text.optional(),
});
export const leadCreate = lead
  .extend({
    phone: z.string().min(10).max(30),
    assigned_agent: uuid.nullable().optional(),
  })
  .strict()
  .refine((v) => v.budget_max == null || v.budget_max >= v.budget_min, {
    message: "Maximum budget must exceed minimum",
  });
export const schemas = {
  leads: lead
    .partial()
    .extend({ status: z.enum(statuses).optional(), ...lossFields })
    .strict(),
  notes: z.object({ lead_id: uuid, body: text.min(1) }).strict(),
  calls: z
    .object({
      outcome: z.enum(outcomes),
      notes: text.default(""),
      deal_tags: z.array(z.enum(tags)).max(7).default([]),
    })
    .strict(),
  properties: z
    .object({
      title: text.min(1).max(200),
      description: text.default(""),
      location: text.min(1).max(200),
      price: amount,
      type: text.min(1).max(100),
      area: z.coerce.number().positive(),
      area_unit: z.enum(["sq ft", "marla", "kanal"]),
      availability: z
        .enum(["available", "reserved", "sold", "archived"])
        .default("available"),
    })
    .strict(),
  followups: z
    .object({
      lead_id: uuid,
      due_at: time,
      notes: text.optional(),
      status: z.enum(["pending", "completed", "cancelled"]).default("pending"),
    })
    .strict(),
  visits: z
    .object({
      lead_id: uuid,
      property_id: uuid,
      scheduled_at: time,
      notes: text.optional(),
      status: z
        .enum(["scheduled", "completed", "cancelled", "no-show"])
        .default("scheduled"),
    })
    .strict(),
  deals: z
    .object({
      lead_id: uuid,
      property_id: uuid,
      stage: z.enum(["discussion", "negotiation", "won", "lost"]),
      expected_value: amount,
      close_date: z.iso.date().nullable().optional(),
      notes: text.optional(),
      ...lossFields,
    })
    .strict(),
  targets: z
    .object({
      agent_id: uuid,
      month: z.iso.date().refine((v) => v.endsWith("-01")),
      calls: z.coerce.number().int().min(0),
      visits: z.coerce.number().int().min(0),
      deals: z.coerce.number().int().min(0),
      revenue: amount,
    })
    .strict(),
  profiles: z
    .object({ name: text.min(1).optional(), active: z.boolean().optional() })
    .strict(),
};
export const listQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z
      .string()
      .max(100)
      .regex(/^[\p{L}\p{N} @._-]*$/u)
      .optional(),
    status: z.string().max(30).optional(),
    lost_reason: z.enum(lostReasons).optional(),
    source: z.enum(["manual", "CSV", "Meta", "WhatsApp", "other"]).optional(),
    agent: uuid.optional(),
    method: z.enum(["manual", "mock", "provider"]).optional(),
    import_id: uuid.optional(),
    sort: z
      .enum(["created_at", "name", "updated_at", "call_due_at"])
      .default("created_at"),
    direction: z.enum(["asc", "desc"]).default("desc"),
    view: z.enum(["due", "overdue", "upcoming", "completed"]).optional(),
    call: z.enum(["uncalled", "missed"]).optional(),
  })
  .strict();
const reviewKind = z.enum(["missed", "idle"]);
export const leadReviewQuery = z
  .object({
    kind: reviewKind.default("missed"),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(10),
    agent: uuid.optional(),
  })
  .strict();
const reviewLeads = z
  .array(uuid)
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Choose each lead once",
  });
export const leadReviewKeep = z
  .object({ lead_ids: reviewLeads, kind: reviewKind })
  .strict();
export const leadReviewReassign = z
  .object({
    lead_ids: reviewLeads,
    kind: reviewKind,
    mode: z.enum(["agent", "unassign"]),
    agent_id: uuid.optional(),
  })
  .strict()
  .refine((v) => (v.mode === "agent") === Boolean(v.agent_id), {
    message: "Choose an agent, or Unassigned without an agent",
    path: ["agent_id"],
  });
const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const minutesOf = (value) =>
  Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
export const workSettings = z
  .object({
    work_days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, {
        message: "Choose each day once",
      }),
    work_start: clock,
    work_end: clock,
    first_call_grace_minutes: z.number().int().min(0).max(600),
    idle_days: z.number().int().min(1).max(90),
  })
  .strict()
  .refine((v) => minutesOf(v.work_end) > minutesOf(v.work_start), {
    message: "The working day must end after it starts",
    path: ["work_end"],
  })
  .refine(
    (v) =>
      v.first_call_grace_minutes <=
      minutesOf(v.work_end) - minutesOf(v.work_start),
    {
      message: "The last-call window must fit inside the working day",
      path: ["first_call_grace_minutes"],
    },
  );
const offsetTime = z.iso.datetime({ offset: true });
export const calendarQuery = z
  .object({ from: offsetTime, to: offsetTime, agent: uuid.optional() })
  .strict()
  .refine(
    (v) =>
      Date.parse(v.from) < Date.parse(v.to) &&
      Date.parse(v.to) - Date.parse(v.from) <= 62 * 86400000,
    { message: "Choose a range of at most 62 days", path: ["to"] },
  );
export const visitConflictQuery = z
  .object({ lead_id: uuid, at: offsetTime, exclude: uuid.optional() })
  .strict();
const periods = ["day", "week", "month"];
// Weeks start on Monday; monthly targets start on the 1st (calendar dates).
const periodStartValid = (period, start) => {
  if (!start) return true;
  const day = new Date(start + "T00:00:00Z");
  return period === "week"
    ? day.getUTCDay() === 1
    : period === "month"
      ? start.endsWith("-01")
      : true;
};
// Goals left out are saved as 0 (not tracked).
const goal = z.number().int().min(0).max(1000000).optional();
const targetFields = {
  agent_id: uuid,
  period: z.enum(periods),
  period_start: z.iso.date(),
  calls: goal,
  visits: goal,
  deals: goal,
  leads_contacted: goal,
  followups_completed: goal,
  revenue: z.number().min(0).max(1e13).optional(),
};
const periodMessage = {
  message: "Weekly targets start on a Monday and monthly targets on the 1st",
  path: ["period_start"],
};
export const targetCreate = z
  .object(targetFields)
  .strict()
  .refine((v) => periodStartValid(v.period, v.period_start), periodMessage);
export const targetUpdate = z
  .object(targetFields)
  .partial()
  .strict()
  .refine(
    (v) =>
      !v.period_start ||
      !v.period ||
      periodStartValid(v.period, v.period_start),
    periodMessage,
  );
export const targetQuery = z
  .object({
    period: z.enum(periods).optional(),
    start: z.iso.date().optional(),
    current: z.enum(["true", "false"]).optional(),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export const targetCopy = z
  .object({ period: z.enum(periods), start: z.iso.date() })
  .strict()
  .refine((v) => periodStartValid(v.period, v.start), {
    ...periodMessage,
    path: ["start"],
  });
export const insightQuery = z
  .object({
    from: offsetTime,
    to: offsetTime,
    agent: uuid.optional(),
    source: z.enum(["manual", "CSV", "Meta", "WhatsApp", "other"]).optional(),
  })
  .strict()
  .refine((v) => Date.parse(v.from) < Date.parse(v.to), {
    message: "Date range must be increasing",
    path: ["to"],
  });
export const notificationRead = z
  .object({ ids: z.array(uuid).min(1).max(100).optional() })
  .strict();

const requireLostReason = (value) =>
  (value.status ?? value.stage) !== "lost" || Boolean(value.lost_reason);
const lostReasonError = {
  message: "Choose a lost reason",
  path: ["lost_reason"],
};
export const leadUpdate = schemas.leads
  .extend({
    phone: z.string().min(10).max(30).optional(),
    assigned_agent: uuid.nullable().optional(),
  })
  .strict()
  .refine(requireLostReason, lostReasonError);
export const agentLeadUpdate = schemas.leads
  .pick({ status: true, lost_reason: true, lost_note: true })
  .strict()
  .refine(requireLostReason, lostReasonError);
export const dealCreate = schemas.deals.refine(
  requireLostReason,
  lostReasonError,
);
export const dealUpdate = schemas.deals
  .partial()
  .refine(requireLostReason, lostReasonError);

export const phoneRevealQuery = z.object({}).strict();
export const securityAlertsQuery = z
  .object({
    page: listQuery.shape.page,
    limit: listQuery.shape.limit,
    view: z.enum(["unreviewed", "reviewed", "all"]).default("unreviewed"),
    severity: z.enum(["info", "warning", "critical"]).optional(),
  })
  .strict();
export const reviewSecurityAlert = z
  .object({ reviewed: z.literal(true) })
  .strict();
export const loginHistoryQuery = z
  .object({
    page: listQuery.shape.page,
    limit: listQuery.shape.limit,
    user: uuid.optional(),
    outcome: z.enum(["success", "failed", "locked"]).optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();

export const accountVerification = z.object({}).strict();

export const leadIds = z
  .array(uuid)
  .min(1)
  .max(500)
  .refine((ids) => new Set(ids).size === ids.length, "Choose distinct leads");
export const bulkAssignment = z
  .object({
    lead_ids: leadIds,
    mode: z.enum(["agent", "round_robin", "unassign"]),
    agent_id: uuid.nullable().optional(),
  })
  .strict()
  .refine(
    (body) => (body.mode === "agent" ? !!body.agent_id : !body.agent_id),
    "Choose an agent only for direct assignment",
  );
// Attendance (update 040). Self-service bodies never carry a user id: the
// employee always comes from the verified session.
const isoDay = z.iso.date();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const clockMinutes = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3, 5));
export const attendanceStates = [
  "checked_in",
  "checked_out",
  "incomplete",
  "absent",
  "not_checked_in",
  "leave",
  "holiday",
  "day_off",
  "upcoming",
  "not_employed",
  "not_tracked",
];
const pageFields = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
const peopleFilters = {
  search: z
    .string()
    .trim()
    .max(100)
    .regex(/^[\p{L}\p{N} .'-]*$/u)
    .optional(),
  role: z.enum(["admin", "agent"]).optional(),
  account: z.enum(["active", "inactive"]).optional(),
};
export const attendanceRange = z
  .object({ from: isoDay, to: isoDay })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "The range must end on or after its start",
    path: ["to"],
  });
export const leaveCreate = z
  .object({
    leave_type: z.enum(["casual", "sick", "emergency", "unpaid", "other"]),
    start_date: isoDay,
    end_date: isoDay,
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((v) => v.start_date <= v.end_date, {
    message: "The leave must end on or after its start date",
    path: ["end_date"],
  });
export const correctionCreate = z
  .object({
    attendance_date: isoDay,
    correction_type: z.enum([
      "missing_check_in",
      "missing_check_out",
      "incorrect_check_in",
      "incorrect_check_out",
    ]),
    requested_check_in_at: z.iso.datetime({ offset: true }).optional(),
    requested_check_out_at: z.iso.datetime({ offset: true }).optional(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((v) => v.requested_check_in_at || v.requested_check_out_at, {
    message: "Enter the corrected time",
    path: ["requested_check_in_at"],
  });
export const requestReview = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export const requestListQuery = z
  .object({
    status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
    user: uuid.optional(),
    ...pageFields,
  })
  .strict();
export const attendanceDailyQuery = z
  .object({
    date: isoDay,
    state: z.enum(attendanceStates).optional(),
    punctuality: z.enum(["on_time", "within_grace", "late"]).optional(),
    ...peopleFilters,
    page: pageFields.page,
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export const attendanceWeekQuery = z
  .object({ week_start: isoDay, ...peopleFilters })
  .strict()
  .refine((v) => new Date(v.week_start + "T00:00:00Z").getUTCDay() === 1, {
    message: "Weeks start on a Monday",
    path: ["week_start"],
  });
export const attendanceMonthQuery = z
  .object({
    month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
    ...peopleFilters,
  })
  .strict();
export const attendanceExportQuery = z
  .object({
    type: z.enum(["daily", "weekly", "monthly"]),
    format: z.enum(["csv", "xlsx"]).default("csv"),
    date: isoDay.optional(),
    week_start: isoDay.optional(),
    month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .optional(),
    state: z.enum(attendanceStates).optional(),
    punctuality: z.enum(["on_time", "within_grace", "late"]).optional(),
    ...peopleFilters,
  })
  .strict()
  .refine(
    (v) =>
      (v.type === "daily" && v.date) ||
      (v.type === "weekly" &&
        v.week_start &&
        new Date(v.week_start + "T00:00:00Z").getUTCDay() === 1) ||
      (v.type === "monthly" && v.month),
    { message: "Choose the date, week (Monday) or month to export" },
  );
export const holidayCreate = z
  .object({
    holiday_date: isoDay,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().max(300).optional(),
  })
  .strict();
export const holidayQuery = z
  .object({ year: z.coerce.number().int().min(2000).max(2100) })
  .strict();
export const attendancePolicy = z
  .object({
    name: z.string().trim().min(1).max(80),
    shift_start: hhmm,
    shift_end: hhmm,
    work_days: z
      .array(z.number().int().min(1).max(7))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, {
        message: "Choose each day once",
      }),
    grace_minutes: z.number().int().min(0).max(120),
    effective_from: isoDay,
  })
  .strict()
  .refine((v) => clockMinutes(v.shift_end) > clockMinutes(v.shift_start), {
    message: "The shift must end after it starts",
    path: ["shift_end"],
  })
  .refine(
    (v) =>
      v.grace_minutes < clockMinutes(v.shift_end) - clockMinutes(v.shift_start),
    {
      message: "The grace period must be shorter than the shift",
      path: ["grace_minutes"],
    },
  );
