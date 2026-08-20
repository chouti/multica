// @vitest-environment node
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { surfaceDesignationOutcomes } from "./skill-designation-toasts";

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

// The helper just calls `t` from `useT("modals")` / `useT("issues")` with
// selectors that walk the bundle object. We mirror that minimal surface
// here: the selector receives the relevant slice and we template
// interpolation the same way i18next does for our test cases.
function makeT<T>(bundle: T) {
  return ((
    selector: (b: T) => string,
    values?: Record<string, unknown>,
  ): string => {
    const template = selector(bundle);
    if (!values) return template;
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
      const v = values[key];
      return v === undefined || v === null ? `{{${key}}}` : String(v);
    });
  }) as never;
}

const tModals = makeT({
  skill_designation: {
    outcome_bound: "Bound {{count}} skill(s) to {{agent}}",
    outcome_blocked: "{{count}} designation(s) skipped: {{reasons}}",
  },
});

const tIssues = makeT({
  comment: {
    trigger_blocked_short_invocation_not_allowed: "permission",
    trigger_blocked_short_runtime_offline: "runtime offline",
    trigger_blocked_short_target_unavailable: "target unavailable",
    trigger_blocked_short_runtime_unusable: "runtime unusable",
    trigger_blocked_short_agent_runtime_required: "agent runtime required",
    trigger_blocked_short_generic: "blocked",
  },
});

describe("surfaceDesignationOutcomes —", () => {
  beforeEach(() => {
    vi.mocked(toast.success).mockReset();
    vi.mocked(toast.warning).mockReset();
  });

  it("is a no-op on an empty outcomes array", () => {
    surfaceDesignationOutcomes({
      outcomes: [],
      getActorName: () => "Agent",
      tModals,
      tIssues,
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("surfaces one bind-only toast per agent (aggregated)", () => {
    surfaceDesignationOutcomes({
      outcomes: [
        { target_type: "agent", target_id: "agent-1", status: "bound", reason_code: "backlog" },
        { target_type: "agent", target_id: "agent-1", status: "merged", reason_code: "merged" },
        { target_type: "agent", target_id: "agent-2", status: "bound", reason_code: "backlog" },
      ],
      getActorName: (_type, id) =>
        id === "agent-1" ? "Alice" : id === "agent-2" ? "Bob" : "Unknown",
      tModals,
      tIssues,
    });
    expect(toast.success).toHaveBeenCalledTimes(2);
    const messages = vi.mocked(toast.success).mock.calls.map((c) => c[0]);
    expect(messages).toContain("Bound 2 skill(s) to Alice");
    expect(messages).toContain("Bound 1 skill(s) to Bob");
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it("aggregates blocked outcomes into ONE warning toast with deduplicated reasons", () => {
    surfaceDesignationOutcomes({
      outcomes: [
        { target_type: "agent", target_id: "agent-1", status: "blocked", reason_code: "invocation_not_allowed" },
        { target_type: "agent", target_id: "agent-2", status: "blocked", reason_code: "runtime_offline" },
        // Same reason_code as the first row — should collapse, not
        // double-list in the joined reasons.
        { target_type: "agent", target_id: "agent-3", status: "blocked", reason_code: "invocation_not_allowed" },
      ],
      getActorName: () => "Agent",
      tModals,
      tIssues,
    });
    expect(toast.warning).toHaveBeenCalledTimes(1);
    const message = vi.mocked(toast.warning).mock.calls[0]?.[0];
    expect(typeof message).toBe("string");
    expect(message).toContain("3");
    expect(message).toContain("permission");
    expect(message).toContain("runtime offline");
    // Dedup: only one "permission" mention in the joined summary, not two.
    expect((message as string).match(/permission/g)).toHaveLength(1);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("ignores triggered outcomes (no extra toast for queued/coalesced)", () => {
    surfaceDesignationOutcomes({
      outcomes: [
        { target_type: "agent", target_id: "agent-1", status: "queued", reason_code: "queued" },
        { target_type: "agent", target_id: "agent-1", status: "coalesced", reason_code: "coalesced" },
      ],
      getActorName: () => "Agent",
      tModals,
      tIssues,
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });
});