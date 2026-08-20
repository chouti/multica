import { describe, expect, it } from "vitest";
import {
  parseCommentTriggerOutcomes,
  unhandledCommentTriggerOutcomes,
  parseIssueSkillDesignationOutcomes,
  unhandledIssueSkillDesignationOutcomes,
  bindOnlyIssueSkillDesignationOutcomes,
  mentionLabelsByTarget,
  blockedTriggerLabel,
} from "./comment-trigger-outcomes";

// MUL-4525 §2: the create/edit comment response's trigger_outcomes drive the
// "posted, but N not triggered" warning, so parsing must be defensive (drop
// malformed entries, tolerate older servers) and count only real blocks.
describe("comment trigger outcomes", () => {
  it("parses valid outcomes and drops malformed entries individually", () => {
    const raw = [
      { target_type: "agent", target_id: "a1", status: "queued", reason_code: "queued" },
      { target_type: "squad", target_id: "s1", status: "blocked", reason_code: "invocation_not_allowed" },
      { status: "blocked" }, // missing target_id → dropped
      "not-an-object", // → dropped
    ];
    const parsed = parseCommentTriggerOutcomes(raw);
    expect(parsed.map((o) => o.target_id)).toEqual(["a1", "s1"]);
  });

  it("returns [] for a missing / non-array field (older server)", () => {
    expect(parseCommentTriggerOutcomes(undefined)).toEqual([]);
    expect(parseCommentTriggerOutcomes(null)).toEqual([]);
    expect(parseCommentTriggerOutcomes("nope")).toEqual([]);
  });

  it("treats only queued/coalesced/deferred as handled; blocked warns", () => {
    const raw = [
      { target_type: "agent", target_id: "a1", status: "queued", reason_code: "queued" },
      { target_type: "agent", target_id: "a2", status: "coalesced", reason_code: "coalesced" },
      { target_type: "agent", target_id: "a3", status: "deferred", reason_code: "deferred" },
      { target_type: "squad", target_id: "s1", status: "blocked", reason_code: "invocation_not_allowed" },
    ];
    const unhandled = unhandledCommentTriggerOutcomes(raw);
    expect(unhandled).toHaveLength(1);
    expect(unhandled[0]?.target_id).toBe("s1");
  });

  it("warns on an unknown / future / empty status instead of assuming success", () => {
    const raw = [
      { target_type: "agent", target_id: "ok", status: "queued", reason_code: "queued" },
      { target_type: "agent", target_id: "future", status: "throttled", reason_code: "x" },
      { target_type: "squad", target_id: "empty", status: "", reason_code: "" },
    ];
    const unhandled = unhandledCommentTriggerOutcomes(raw);
    expect(unhandled.map((o) => o.target_id).sort()).toEqual(["empty", "future"]);
  });
});

// A blocked outcome carries no name (enumeration-safety), so the composer/toast
// recover it from the user's own mention markup. `@` prefix is stripped and the
// map is keyed by `${type}:${id}` to correlate with an outcome's target.
describe("mentionLabelsByTarget", () => {
  it("maps each mention target to the label the user typed (strips @)", () => {
    const content =
      "[@Go](mention://agent/deadbeef-0001) and [Design Squad](mention://squad/cafef00d-0002) hi";
    const labels = mentionLabelsByTarget(content);
    expect(labels.get("agent:deadbeef-0001")).toBe("Go");
    expect(labels.get("squad:cafef00d-0002")).toBe("Design Squad");
  });

  it("correlates a blocked outcome to its label, undefined when absent", () => {
    const labels = mentionLabelsByTarget("[@Go](mention://agent/deadbeef-0001)");
    expect(
      blockedTriggerLabel({ target_type: "agent", target_id: "deadbeef-0001" }, labels),
    ).toBe("Go");
    expect(
      blockedTriggerLabel({ target_type: "agent", target_id: "beefdead-9999" }, labels),
    ).toBeUndefined();
  });

  it("returns an empty map for content with no mentions", () => {
    expect(mentionLabelsByTarget("just text").size).toBe(0);
    expect(mentionLabelsByTarget("").size).toBe(0);
  });
});

// R16 / KTD10: the create/edit issue response carries a parallel outcomes
// field (`skill_designation_outcomes`) with two new non-error end states —
// `bound` (durable agent_skill wrote, no run) and `merged` (run already
// enqueued, designation folded into it). The comment path's helper
// surface mirrors exactly so the toast layer can share one reason-code
// mapping. Tests below mirror the comment path's coverage shape.
describe("issue skill designation outcomes", () => {
  it("parses valid outcomes and drops malformed entries individually", () => {
    const raw = [
      { target_type: "agent", target_id: "a1", status: "queued", reason_code: "queued" },
      { target_type: "agent", target_id: "a2", status: "bound", reason_code: "bound" },
      { target_type: "agent", target_id: "a3", status: "merged", reason_code: "merged" },
      { status: "bound" }, // missing target_id → dropped
      "not-an-object", // → dropped
    ];
    const parsed = parseIssueSkillDesignationOutcomes(raw);
    expect(parsed.map((o) => o.target_id)).toEqual(["a1", "a2", "a3"]);
  });

  it("returns [] for a missing / non-array field (older server)", () => {
    expect(parseIssueSkillDesignationOutcomes(undefined)).toEqual([]);
    expect(parseIssueSkillDesignationOutcomes(null)).toEqual([]);
    expect(parseIssueSkillDesignationOutcomes("nope")).toEqual([]);
    expect(parseIssueSkillDesignationOutcomes({ not: "an array" })).toEqual([]);
  });

  it("treats queued / coalesced / deferred / bound / merged as handled; blocked / unknown warns", () => {
    const raw = [
      { target_type: "agent", target_id: "a1", status: "queued", reason_code: "queued" },
      { target_type: "agent", target_id: "a2", status: "coalesced", reason_code: "coalesced" },
      { target_type: "agent", target_id: "a3", status: "deferred", reason_code: "deferred" },
      { target_type: "agent", target_id: "a4", status: "bound", reason_code: "bound" },
      { target_type: "agent", target_id: "a5", status: "merged", reason_code: "merged" },
      { target_type: "agent", target_id: "a6", status: "blocked", reason_code: "invocation_not_allowed" },
      { target_type: "agent", target_id: "a7", status: "throttled", reason_code: "x" },
      { target_type: "agent", target_id: "a8", status: "", reason_code: "" },
    ];
    const unhandled = unhandledIssueSkillDesignationOutcomes(raw);
    // blocked + unknown (throttled) + empty status → 3 warnings.
    expect(unhandled.map((o) => o.target_id).sort()).toEqual(["a6", "a7", "a8"]);
  });

  it("isolates bind-only outcomes (bound / merged) for the bind-only toast surface (R13 / R16)", () => {
    const raw = [
      { target_type: "agent", target_id: "a1", status: "queued", reason_code: "queued" },
      { target_type: "agent", target_id: "a2", status: "bound", reason_code: "bound" },
      { target_type: "agent", target_id: "a3", status: "merged", reason_code: "merged" },
      { target_type: "agent", target_id: "a4", status: "blocked", reason_code: "invocation_not_allowed" },
    ];
    const bindOnly = bindOnlyIssueSkillDesignationOutcomes(raw);
    expect(bindOnly.map((o) => o.target_id).sort()).toEqual(["a2", "a3"]);
  });

  it("survives an unknown status as a plain string (lenient enum, per CLAUDE.md API Compatibility)", () => {
    const raw = [
      { target_type: "agent", target_id: "a1", status: "future-status", reason_code: "future-reason" },
    ];
    const parsed = parseIssueSkillDesignationOutcomes(raw);
    expect(parsed[0]).toMatchObject({
      target_id: "a1",
      status: "future-status",
      reason_code: "future-reason",
    });
    // Future / unknown statuses land in the unhandled set so the toast
    // surface treats them as "not clearly resolved" instead of assuming
    // success.
    expect(unhandledIssueSkillDesignationOutcomes(raw)).toHaveLength(1);
    expect(bindOnlyIssueSkillDesignationOutcomes(raw)).toHaveLength(0);
  });
});
