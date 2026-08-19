"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAgentRuntimeBound } from "@multica/core/agents";
import {
  issueDetailOptions,
  issueTimelineOptions,
} from "@multica/core/issues/queries";
import {
  recommendSkillMentionAgentWithTier,
  skillMentionSourcePriority,
} from "@multica/core/issues/skill-mention-recommendation";
import { agentListOptions } from "@multica/core/workspace/queries";
import type { UseCommentTriggerPreviewResult } from "./use-comment-trigger-preview";

const EMPTY_SUPPRESSED: ReadonlySet<string> = new Set();

export interface UseRecommendedSkillAgentParams {
  wsId: string;
  issueId: string;
  parentId?: string;
  /**
   * The composer's own trigger-preview result, injected instead of
   * re-instantiated: `backendAgents`/`resolved` depend only on the query key
   * (issue/parent/debounced signature), so the composer's instance answers
   * identically while each keystroke parses the mention signature once
   * instead of twice.
   */
  preview: Pick<UseCommentTriggerPreviewResult, "backendAgents" | "resolved">;
  /**
   * Agent ids the user explicitly suppressed in the popover ("don't run"
   * gesture, KTD5). Suppressed ids are never recommended.
   */
  suppressedAgentIds?: ReadonlySet<string>;
}

/**
 * The recommended agent for the skill-mention popover in the current composer
 * context: `id` is the agent id or `null` when no candidate qualifies, `from`
 * names the source tier, and `tier` is that tier's rank so the consumer can
 * apply the U4/KTD5 temporary-value semantics — a fast-path fill may be
 * replaced by the async answer exactly once; an async fill is sticky except
 * that one strictly higher-tier answer may replace it once (review finding
 * #4), keeping an @agent mention typed after the chip the winner (R5).
 *
 * Async path (authoritative): the backend trigger preview runs the same
 * read-only routing the submit will perform, so the recommendation is its
 * implicit rows ranked by source priority (KTD1) — computed from the UNMERGED
 * backend rows so a skill designation never erases the backend source.
 *
 * Fast path (bridge): while the debounced preview is still in flight, the
 * reply-parent agent and the issue assignee — the two sources the cold-start
 * window would otherwise hide — are answered synchronously from the timeline
 * and issue queries. Fast-path candidates pass the same checks as backend
 * rows (not suppressed, unarchived, runtime-bound); if none qualifies the
 * hook returns null until the preview resolves.
 *
 * The output is deliberately stateless: once the preview resolves it replaces
 * the fast-path value on the next render, and nothing is latched here. The
 * temporary-value / sticky semantics live in the consumer (KTD5).
 */
export interface SkillAgentRecommendation {
  id: string | null;
  from: "fast-path" | "async";
  /** Source-tier rank of the recommendation (lower ranks higher; Infinity
   *  when `id` is null). The consumer's one-shot upgrade gate replaces an
   *  async-origin fill only when a later answer strictly outranks this tier
   *  (review finding #4). */
  tier: number;
}

export function useRecommendedSkillAgent({
  wsId,
  issueId,
  parentId,
  preview,
  suppressedAgentIds,
}: UseRecommendedSkillAgentParams): SkillAgentRecommendation {
  // Recommendation-side visibility is stricter than the picker: an
  // auto-recommendation must be actionable, so the agent must be unarchived
  // AND runtime-bound. Manual selection in the picker may still target an
  // unbound agent — that difference is intentional.
  const agentsQuery = useQuery(agentListOptions(wsId));
  const eligibleAgentIds = useMemo(
    () =>
      new Set(
        (agentsQuery.data ?? [])
          .filter((a) => !a.archived_at && isAgentRuntimeBound(a))
          .map((a) => a.id),
      ),
    [agentsQuery.data],
  );

  const timelineQuery = useQuery({
    ...issueTimelineOptions(issueId),
    enabled: !!parentId,
  });
  const parentEntry = useMemo(
    () =>
      parentId
        ? timelineQuery.data?.find(
            (entry) => entry.type === "comment" && entry.id === parentId,
          )
        : undefined,
    [timelineQuery.data, parentId],
  );
  const timelineParentAgentId =
    parentEntry && parentEntry.actor_type === "agent" ? parentEntry.actor_id : null;

  const issueQuery = useQuery(issueDetailOptions(wsId, issueId));
  const issue = issueQuery.data;
  const assigneeAgentId =
    issue && issue.assignee_type === "agent" ? issue.assignee_id : null;

  const suppressed = suppressedAgentIds ?? EMPTY_SUPPRESSED;

  // Backend answer wins once available — including "answered with zero
  // candidates", which yields null instead of falling back to the fast path.
  if (preview.resolved) {
    return {
      ...recommendSkillMentionAgentWithTier(
        preview.backendAgents,
        eligibleAgentIds,
        suppressed,
      ),
      from: "async",
    };
  }

  // Fast path: the two synchronous candidates with their source tiers, so the
  // consumer's upgrade gate can compare a later async answer against the tier
  // this fill came from.
  const fastPathCandidates = [
    [timelineParentAgentId, "thread_parent"],
    [assigneeAgentId, "issue_assignee"],
  ] as const;
  for (const [candidateId, source] of fastPathCandidates) {
    if (!candidateId) continue;
    if (suppressed.has(candidateId)) continue;
    if (!eligibleAgentIds.has(candidateId)) continue;
    return {
      id: candidateId,
      tier: skillMentionSourcePriority(source),
      from: "fast-path",
    };
  }
  return { id: null, tier: Number.POSITIVE_INFINITY, from: "fast-path" };
}
