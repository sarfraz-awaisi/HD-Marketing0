import { describe, expect, it } from "vitest";
import { callOutcomes, unansweredOutcomes } from "../src/lib/calls";
import { periodWork } from "../src/lib/leadUsage";

// Update 079: "Closed lost" is one answered call outcome, listed once.
describe("Closed lost call outcome", () => {
  it("is offered once, after the existing outcomes, for answered calls only", () => {
    expect(callOutcomes.filter((o) => /closed\s*lost/i.test(o))).toEqual(["Closed lost"]);
    expect(callOutcomes.slice(0, 9)).toEqual([
      "No answer",
      "Busy",
      "Wrong number",
      "Number off",
      "Interested",
      "Not interested",
      "Follow-up required",
      "Site visit scheduled",
      "Deal discussion",
    ]);
    expect(unansweredOutcomes).not.toContain("Closed lost");
  });

  it("counts as a customer response in Lead Usage history", () => {
    const call = { connected: true, outcome: "Closed lost", recorded_by: "a1", agent_id: "a1" };
    const work = periodWork({ agent_id: "a1", calls: [call], followups: [] });
    expect(work.responded).toHaveLength(1);
    expect(work.outcomes).toEqual([{ outcome: "Closed lost", count: 1 }]);
  });
});
