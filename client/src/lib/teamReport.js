// Team report numbers (update 063): what each counts, in the words the
// records window and the tables use.
export const teamMetrics = {
  received: [
    "Leads received",
    "Different leads that reached the agent in this period.",
  ],
  received_first_time: [
    "First time",
    "Leads received that no other agent had before.",
  ],
  received_reassigned: [
    "From another agent",
    "Leads received that another agent had before.",
  ],
  moved_away: [
    "Moved away",
    "Times one of the agent's leads was given to someone else.",
  ],
  assignment_events: [
    "Assignment history",
    "Every assignment to or from the agent in this period, repeated transfers included.",
  ],
  calls: ["Calls", "Calls the agent recorded, by when they started."],
  answered: ["Answered", "Calls the agent recorded that were answered."],
  not_answered: [
    "Not answered",
    "Calls the agent recorded that did not connect.",
  ],
  leads_called: ["Leads called", "Different leads the agent called."],
  leads_answered: ["Leads answered", "Different leads the agent spoke to."],
  interested: ["Interested", "The agent's calls with the outcome Interested."],
  not_interested: [
    "Not interested",
    "The agent's calls with the outcome Not interested.",
  ],
  followup_required: [
    "Follow-up required",
    "The agent's calls with the outcome Follow-up required.",
  ],
  admin_calls: [
    "Admin calls",
    "Calls an administrator recorded on the agent's leads. They never count as the agent's own.",
  ],
  first_calls: [
    "First calls",
    "The agent's own first call on a lead assigned to them.",
  ],
  on_time: ["On time", "First calls made by the lead's deadline."],
  deadlines_missed: [
    "Deadlines missed",
    "First-call deadlines in this period that passed while the agent had the lead, with no call from them by then.",
  ],
  followups_created: ["Follow-ups created", "Follow-ups the agent created."],
  followups_completed: [
    "Follow-ups completed",
    "The agent's follow-ups completed in this period.",
  ],
  notes: ["Notes", "Notes the agent wrote."],
  waiting_now: [
    "Waiting for first call",
    "Now: the agent's leads whose first-call deadline is still ahead.",
  ],
  missed_now: [
    "Missed first call",
    "Now: deadline passed with no call from the agent in this assignment.",
  ],
  not_connected_now: [
    "Not connected",
    "Now: deadline passed and no answered call in this assignment, from anyone.",
  ],
  followups_overdue_now: [
    "Overdue follow-ups",
    "Now: the agent's pending follow-ups past their time.",
  ],
  idle_now: ["No recent activity", "Now: leads with no recent activity."],
};
export const metricLabel = (metric) => teamMetrics[metric]?.[0] || metric;
export const metricHint = (metric) => teamMetrics[metric]?.[1] || "";
// How an assignment was made, from the action that made it.
export const assignmentHow = {
  "lead.bulk_assigned": "Assign or reassign",
  "lead.bulk_distributed": "Assign to agents",
  assign_file: "Lead file",
  "meta.bulk_assigned": "Facebook leads",
};
