import { z } from "zod";
import { normalizePhone } from "./phoneMask.js";
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
// Administrator entries for earlier days (update 042). The SQL function
// decides each date (day off, existing attendance, grace) and reports it.
export const attendanceManageDay = z
  .object({ user: uuid, date: isoDay })
  .strict();
export const attendanceManage = z
  .object({
    user_id: uuid,
    entries: z
      .array(
        z
          .object({
            date: isoDay,
            // clear removes an entered day so it is no longer counted.
            status: z.enum([
              "present",
              "late",
              "half_day",
              "absent",
              "leave",
              "clear",
            ]),
            check_in: hhmm.optional(),
            check_out: hhmm.optional(),
            leave_type: z
              .enum(["casual", "sick", "emergency", "unpaid", "other"])
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(31),
    reason: z.string().trim().max(300).optional(),
    replace: z.boolean().default(false),
    dry_run: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => new Set(v.entries.map((e) => e.date)).size === v.entries.length,
    { message: "Enter each date once", path: ["entries"] },
  );
// Audit history filters (update 043). Module and action type names are
// checked against the audit catalog by the route.
export const auditQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    sort: z.enum(["newest", "oldest"]).default("newest"),
    from: isoDay.optional(),
    to: isoDay.optional(),
    module: z
      .string()
      .regex(/^[a-z]{1,30}$/)
      .optional(),
    kind: z
      .string()
      .regex(/^[a-z]{1,30}$/)
      .optional(),
    actor: uuid.optional(),
    search: z.string().trim().max(100).optional(),
  })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "The date range must end on or after its start",
    path: ["to"],
  });
// Property inventory (update 041). Bodies never carry an owner: the signed-in
// account decides whether a property is company or private agent inventory.
export const propertyTypes = [
  "House",
  "Apartment",
  "Residential Plot",
  "Portion",
  "Farmhouse",
  "Shop",
  "Office",
  "Commercial Plot",
  "Warehouse",
  "Building",
  "Land",
  "Other",
];
export const propertyStatuses = [
  "available",
  "reserved",
  "sold",
  "rented",
  "archived",
];
export const areaUnits = ["sq ft", "sq yd", "marla", "kanal", "acre"];
export const provinces = [
  "Punjab",
  "Sindh",
  "Khyber Pakhtunkhwa",
  "Balochistan",
  "Islamabad Capital Territory",
  "Gilgit-Baltistan",
  "Azad Jammu and Kashmir",
];
export const amenities = [
  "electricity",
  "gas",
  "water",
  "sewerage",
  "internet",
  "boundary_wall",
  "security",
  "corner",
  "park_facing",
  "main_road",
  "lift",
  "backup_power",
  "solar",
  "servant_quarter",
  "basement",
  "lawn",
  "drawing_room",
  "store_room",
];
const optionalText = (max) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((v) => v || null);
const roomCount = (max) => z.number().int().min(0).max(max).nullable();
const ownerPhone = z
  .string()
  .trim()
  .max(30)
  .nullable()
  .transform((v, ctx) => {
    if (!v) return null;
    try {
      return normalizePhone(v);
    } catch {
      ctx.addIssue({ code: "custom", message: "Use a valid phone number" });
      return z.NEVER;
    }
  });
const propertyFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(4000),
  type: z.enum(propertyTypes),
  purpose: z.enum(["sale", "rent"]),
  availability: z.enum(propertyStatuses),
  price: z.coerce.number().min(0).max(1e13),
  price_negotiable: z.boolean(),
  price_notes: optionalText(300),
  area: z.coerce.number().positive().max(1e9),
  area_unit: z.enum(areaUnits),
  province: z.enum(provinces).nullable(),
  city: z.string().trim().min(1).max(80),
  area_society: optionalText(120),
  block_sector: optionalText(60),
  street: optionalText(120),
  plot_number: optionalText(40),
  address: optionalText(300),
  map_url: optionalText(500).refine((v) => !v || /^https:\/\/\S+$/.test(v), {
    message: "Use a map link that starts with https://",
  }),
  bedrooms: roomCount(50),
  bathrooms: roomCount(50),
  kitchens: roomCount(20),
  floors: roomCount(200),
  parking_spaces: roomCount(100),
  property_age: roomCount(200),
  furnishing: z.enum(["unfurnished", "semi_furnished", "furnished"]).nullable(),
  construction_status: z
    .enum([
      "new",
      "ready",
      "needs_renovation",
      "under_construction",
      "grey_structure",
    ])
    .nullable(),
  amenities: z
    .array(z.enum(amenities))
    .max(20)
    .refine((list) => new Set(list).size === list.length, {
      message: "Choose each amenity once",
    }),
  owner_contact: z
    .object({
      owner_name: optionalText(120),
      owner_phone: ownerPhone,
      owner_alt_phone: ownerPhone,
      owner_notes: optionalText(1000),
      share_with_agents: z.boolean(),
    })
    .partial()
    .strict()
    .nullable(),
};
const statusMatchesPurpose = {
  check: (v) =>
    !(v.availability === "sold" && v.purpose === "rent") &&
    !(v.availability === "rented" && v.purpose === "sale"),
  error: {
    message: "Use Sold for sale listings and Rented for rent listings",
    path: ["availability"],
  },
};
export const propertyCreate = z
  .object(propertyFields)
  .partial()
  .required({
    title: true,
    type: true,
    purpose: true,
    price: true,
    area: true,
    area_unit: true,
    city: true,
  })
  .strict()
  .refine(statusMatchesPurpose.check, statusMatchesPurpose.error);
// Only the fields sent change. expected_updated_at is the updated_at the
// editor loaded; a newer save by someone else is then refused (HTTP 409).
export const propertyUpdate = z
  .object({
    ...propertyFields,
    expected_updated_at: z.iso.datetime({ offset: true }),
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== "expected_updated_at"), {
    message: "Change at least one detail",
  })
  .refine(statusMatchesPurpose.check, statusMatchesPurpose.error);
const blankAsMissing = (schema) =>
  z.preprocess((v) => (v === "" ? undefined : v), schema.optional());
const filterText = z
  .string()
  .trim()
  .max(100)
  .regex(/^[\p{L}\p{N} @.,#/'_-]*$/u);
const priceFilter = z.coerce.number().min(0).max(1e13);
export const inventoryQuery = z
  .object({
    scope: z.enum(["company", "mine", "agent"]).default("company"),
    agent: blankAsMissing(uuid),
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: blankAsMissing(filterText),
    type: blankAsMissing(z.enum(propertyTypes)),
    purpose: blankAsMissing(z.enum(["sale", "rent"])),
    status: blankAsMissing(z.enum(propertyStatuses)),
    city: blankAsMissing(filterText.max(80)),
    min_price: blankAsMissing(priceFilter),
    max_price: blankAsMissing(priceFilter),
    sort: z
      .enum(["newest", "oldest", "price_low", "price_high", "updated", "title"])
      .default("newest"),
    covers: z.enum(["true", "false"]).optional(),
  })
  .strict()
  .refine((v) => (v.scope === "agent") === Boolean(v.agent), {
    message: "Choose an agent only for an agent's inventory",
    path: ["agent"],
  })
  .refine(
    (v) =>
      v.min_price === undefined ||
      v.max_price === undefined ||
      v.min_price <= v.max_price,
    {
      message: "The minimum price must not exceed the maximum",
      path: ["max_price"],
    },
  );
export const inventoryAgentsQuery = z
  .object({
    page: z.coerce.number().int().min(1).max(100000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: blankAsMissing(filterText),
  })
  .strict();
export const photoOrder = z
  .object({
    photo_ids: z
      .array(uuid)
      .min(1)
      .max(20)
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "List each picture once",
      }),
  })
  .strict();
// Daily tasks, reports and checkout requests (update 045). The database
// checks the same limits and every rule that depends on the date or role.
const taskText = (max) => z.string().trim().max(max);
const taskCategory = z.enum([
  "calls",
  "follow_ups",
  "site_visits",
  "listings",
  "meetings",
  "documents",
  "other",
]);
const taskPriority = z.enum(["low", "normal", "high", "urgent"]);
export const taskCreate = z
  .object({
    scope: z.enum(["team", "individual"]),
    title: z.string().trim().min(3).max(120),
    description: taskText(1000).optional(),
    instructions: taskText(1000).optional(),
    category: taskCategory.optional(),
    priority: taskPriority.default("normal"),
    kind: z.enum(["measurable", "simple"]),
    target_quantity: z.coerce.number().int().min(1).max(100000).optional(),
    unit: z.string().trim().min(1).max(30).optional(),
    task_date: isoDay.optional(),
    due_on: isoDay.optional(),
    assignees: z.array(uuid).min(1).max(200).optional(),
    all_agents: z.boolean().optional(),
    client_key: uuid,
    allow_duplicate: z.boolean().optional(),
  })
  .strict()
  .refine((v) => v.all_agents || v.assignees?.length, {
    message: "Choose at least one agent",
    path: ["assignees"],
  })
  .refine(
    (v) => v.kind === "simple" || (v.target_quantity != null && v.unit != null),
    {
      message: "A measurable task needs a target and a unit",
      path: ["target_quantity"],
    },
  );
export const taskUpdate = z
  .object({
    title: z.string().trim().min(3).max(120).optional(),
    description: taskText(1000).optional(),
    instructions: taskText(1000).optional(),
    category: taskCategory.or(z.literal("")).optional(),
    priority: taskPriority.optional(),
    target_quantity: z.coerce.number().int().min(1).max(100000).optional(),
    unit: z.string().trim().min(1).max(30).optional(),
    due_on: isoDay.optional(),
    add_assignees: z.array(uuid).min(1).max(200).optional(),
    expected_updated_at: z.string().optional(),
  })
  .strict();
export const taskProgress = z
  .object({
    quantity: z.coerce.number().int().min(0).max(1000000).optional(),
    status: z.enum(["pending", "in_progress", "completed"]).optional(),
    note: taskText(500).optional(),
  })
  .strict()
  .refine((v) => v.quantity != null || v.status != null, {
    message: "Enter a quantity or a status",
  });
export const taskReport = z
  .object({
    date: isoDay.optional(),
    remarks: taskText(1000).optional(),
    amend: z.boolean().default(false),
  })
  .strict();
export const taskVerify = z
  .object({
    status: z.enum(["confirmed", "adjusted", "not_done"]),
    quantity: z.coerce.number().int().min(0).max(1000000).optional(),
    note: taskText(500).optional(),
  })
  .strict();
export const taskReason = z
  .object({ reason: taskText(300).optional() })
  .strict();
export const taskNote = z.object({ note: taskText(500).optional() }).strict();
export const checkoutRequest = z
  .object({
    kind: z.enum(["early", "emergency"]),
    reason: taskText(500).optional(),
  })
  .strict()
  .refine((v) => v.kind === "early" || (v.reason || "").length >= 5, {
    message: "Tell the administrator briefly what happened",
    path: ["reason"],
  });
export const checkoutDecision = z
  .object({
    decision: z.enum(["approve", "reject"]),
    note: taskText(300).optional(),
    waive_report: z.boolean().default(false),
  })
  .strict();
const taskPage = {
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
};
export const taskListQuery = z
  .object({
    scope: z.enum(["team", "individual"]).optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    status: z.enum(["open", "cancelled"]).optional(),
    user: uuid.optional(),
    search: z.string().trim().max(100).optional(),
    ...taskPage,
  })
  .strict();
export const taskReportsQuery = z
  .object({
    from: isoDay.optional(),
    to: isoDay.optional(),
    user: uuid.optional(),
    status: z.enum(["submitted", "reviewed"]).optional(),
    ...taskPage,
  })
  .strict();
export const checkoutListQuery = z
  .object({
    status: z.enum(["pending", "approved", "rejected", "cancelled"]).optional(),
    kind: z.enum(["early", "emergency"]).optional(),
    user: uuid.optional(),
    from: isoDay.optional(),
    to: isoDay.optional(),
    ...taskPage,
  })
  .strict();
export const taskPerformanceQuery = z
  .object({ from: isoDay, to: isoDay, user: uuid.optional() })
  .strict()
  .refine((v) => v.from <= v.to, {
    message: "The range must end on or after its start",
    path: ["to"],
  });
export const taskOverviewQuery = z.object({ date: isoDay.optional() }).strict();
export const taskSettings = z
  .object({ rules_from: isoDay.nullable() })
  .strict();
export const taskMissingQuery = z
  .object({ from: isoDay.optional(), to: isoDay.optional() })
  .strict()
  .refine((v) => !v.from || !v.to || v.from <= v.to, {
    message: "The range must end on or after its start",
    path: ["to"],
  });
