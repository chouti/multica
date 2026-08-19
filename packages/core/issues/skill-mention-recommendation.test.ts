// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { CommentTriggerPreviewAgent } from "../types";
import {
  recommendSkillMentionAgent,
  recommendSkillMentionAgentWithTier,
  skillMentionSourcePriority,
} from "./skill-mention-recommendation";

// Recommendation-side visibility set: unarchived AND runtime-bound agents.
// The caller (hook) computes it; the pure function only consumes it.
const ALL_ELIGIBLE = new Set(["agent-x", "agent-y", "agent-z", "agent-w"]);

function row(
  id: string,
  source: CommentTriggerPreviewAgent["source"],
): CommentTriggerPreviewAgent {
  return { id, name: id, source, reason: "" };
}

describe("recommendSkillMentionAgent", () => {
  describe("source priority ordering", () => {
    it("ranks mention_agent above thread_parent", () => {
      const rows = [row("agent-x", "thread_parent"), row("agent-y", "mention_agent")];
      expect(recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set())).toBe("agent-y");
    });

    it("ranks thread_parent above conversation_continuation", () => {
      const rows = [
        row("agent-x", "conversation_continuation"),
        row("agent-y", "thread_parent"),
      ];
      expect(recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set())).toBe("agent-y");
    });

    it("ranks conversation_continuation above issue_assignee", () => {
      const rows = [row("agent-x", "issue_assignee"), row("agent-y", "conversation_continuation")];
      expect(recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set())).toBe("agent-y");
    });

    it("ranks mention_squad_leader in the top tier with mention_agent", () => {
      const rows = [
        row("agent-x", "issue_assignee"),
        row("agent-y", "mention_squad_leader"),
      ];
      expect(recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set())).toBe("agent-y");
    });

    it("keeps backend order within the same tier", () => {
      const rows = [row("agent-x", "mention_agent"), row("agent-y", "mention_squad_leader")];
      expect(recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set())).toBe("agent-x");
    });
  });

  describe("mention_skill exclusion (self-reference guard)", () => {
    it("skips a mention_skill row and falls through to the next tier", () => {
      const rows = [row("agent-x", "mention_skill"), row("agent-y", "issue_assignee")];
      expect(recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set())).toBe("agent-y");
    });

    it("returns null when the only row is a designation row", () => {
      const rows = [row("agent-x", "mention_skill")];
      expect(recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set())).toBeNull();
    });
  });

  describe("designated masking does not pollute the recommendation", () => {
    it("recommends the backend-picked agent from unmerged rows even when it is also skill-designated", () => {
      // Same comment: skillA designated agent X, and the backend picked X as
      // thread_parent. Inserting skillB must still recommend X. The input is
      // the UNMERGED backend row (source thread_parent); the merged strip row
      // would carry source mention_skill and wrongly read as self-reference.
      const unmerged = [row("agent-x", "thread_parent"), row("agent-w", "issue_assignee")];
      expect(recommendSkillMentionAgent(unmerged, ALL_ELIGIBLE, new Set())).toBe("agent-x");
    });

    it("the masked (merged-shape) row would have hidden the agent — guard stays loud", () => {
      // Sanity check of WHY unmerged rows are required: feed the merged
      // shape (designation row replaced the backend source) and the function
      // must not return the designated agent via the mention_skill row.
      const masked = [row("agent-x", "mention_skill"), row("agent-w", "issue_assignee")];
      expect(recommendSkillMentionAgent(masked, ALL_ELIGIBLE, new Set())).toBe("agent-w");
    });
  });

  describe("suppression", () => {
    it("skips a suppressed agent and takes the next candidate", () => {
      const rows = [row("agent-x", "mention_agent"), row("agent-y", "thread_parent")];
      expect(
        recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set(["agent-x"])),
      ).toBe("agent-y");
    });

    it("returns null when every candidate is suppressed", () => {
      const rows = [row("agent-x", "mention_agent")];
      expect(
        recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set(["agent-x"])),
      ).toBeNull();
    });
  });

  describe("recommendation-side visibility (stricter than picker)", () => {
    it("does not output an archived or runtime-unbound candidate id", () => {
      // agent-x is the top-tier pick but failed the unarchived+runtime-bound
      // check (not in the eligible set); the next visible candidate wins.
      const rows = [
        row("agent-x", "mention_agent"),
        row("agent-y", "issue_assignee"),
      ];
      const eligible = new Set(["agent-y"]);
      expect(recommendSkillMentionAgent(rows, eligible, new Set())).toBe("agent-y");
    });

    it("returns null when no candidate passes the visibility check", () => {
      const rows = [row("agent-x", "thread_parent")];
      expect(recommendSkillMentionAgent(rows, new Set(), new Set())).toBeNull();
    });
  });

  describe("no candidates", () => {
    it("returns null for empty rows", () => {
      expect(recommendSkillMentionAgent([], ALL_ELIGIBLE, new Set())).toBeNull();
    });

    it("returns null for an undefined row list (preview unresolved shape)", () => {
      expect(
        recommendSkillMentionAgent(undefined as unknown as CommentTriggerPreviewAgent[], ALL_ELIGIBLE, new Set()),
      ).toBeNull();
    });
  });

  describe("future backend sources", () => {
    it("ranks an unknown source below every known tier instead of dropping it", () => {
      // Server-driven enums need a default branch: a row with a source this
      // frontend does not know still means the backend WILL run that agent,
      // so it stays recommendable — just below the known tiers.
      const rows = [
        row("agent-x", "some_future_source"),
        row("agent-y", "issue_assignee"),
      ];
      expect(recommendSkillMentionAgent(rows, ALL_ELIGIBLE, new Set())).toBe("agent-y");

      const rowsOnly = [row("agent-x", "some_future_source")];
      expect(recommendSkillMentionAgent(rowsOnly, ALL_ELIGIBLE, new Set())).toBe("agent-x");
    });
  });

  // The tier-aware variant feeds the one-shot upgrade gate (review finding
  // #4): a fill's replacement rule compares the winning rows' source ranks.
  describe("recommendSkillMentionAgentWithTier", () => {
    it("reports the winning row's tier rank alongside its id", () => {
      const rows = [row("agent-x", "issue_assignee"), row("agent-y", "mention_agent")];
      expect(recommendSkillMentionAgentWithTier(rows, ALL_ELIGIBLE, new Set())).toEqual({
        id: "agent-y",
        tier: skillMentionSourcePriority("mention_agent"),
      });
      expect(skillMentionSourcePriority("mention_agent")).toBeLessThan(
        skillMentionSourcePriority("issue_assignee"),
      );
    });

    it("returns tier Infinity when no row wins (null id)", () => {
      expect(
        recommendSkillMentionAgentWithTier([], ALL_ELIGIBLE, new Set()),
      ).toEqual({ id: null, tier: Number.POSITIVE_INFINITY });
    });

    it("ranks an unknown source at Infinity — never strictly outranked by a known tier above it", () => {
      // A future-source fill stays replaceable by any known tier; the strict
      // outrank comparison excludes equality, so Infinity vs Infinity (two
      // unknown tiers) never flips.
      const rows = [row("agent-x", "some_future_source")];
      expect(
        recommendSkillMentionAgentWithTier(rows, ALL_ELIGIBLE, new Set()),
      ).toEqual({ id: "agent-x", tier: Number.POSITIVE_INFINITY });
      expect(skillMentionSourcePriority("some_future_source")).toBe(
        Number.POSITIVE_INFINITY,
      );
    });

    it("mention_skill exclusion falls through to the next row's tier", () => {
      const rows = [row("agent-x", "mention_skill"), row("agent-y", "thread_parent")];
      expect(
        recommendSkillMentionAgentWithTier(rows, ALL_ELIGIBLE, new Set()),
      ).toEqual({ id: "agent-y", tier: skillMentionSourcePriority("thread_parent") });
    });
  });
});
