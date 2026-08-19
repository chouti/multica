"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAgentRuntimeBound } from "@multica/core/agents";
import {
  issueDetailOptions,
  issueTimelineOptions,
} from "@multica/core/issues/queries";
import { recommendSkillMentionAgent } from "@multica/core/issues/skill-mention-recommendation";
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
  /**
   * Reply-parent agent id when the caller already knows it. `undefined` lets
   * the hook resolve the parent comment's actor from the issue timeline;
   * `null` explicitly disables the timeline lookup.
   */
  replyParentAgentId?: string | null;
}

/**
 * The recommended agent for the skill-mention popover in the current composer
 * context: `id` is the agent id or `null` when no candidate qualifies, and
 * `from` names the source tier so the consumer can apply the U4/KTD5
 * temporary-value semantics — a fast-path fill may be replaced by the async
 * answer exactly once, an async value is immediately sticky.
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
}

export function useRecommendedSkillAgent({
  wsId,
  issueId,
  parentId,
  preview,
  suppressedAgentIds,
  replyParentAgentId,
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
  const parentCandidate =
    replyParentAgentId !== undefined ? replyParentAgentId : timelineParentAgentId;

  // Backend answer wins once available — including "answered with zero
  // candidates", which yields null instead of falling back to the fast path.
  if (preview.resolved) {
    return {
      id: recommendSkillMentionAgent(preview.backendAgents, eligibleAgentIds, suppressed),
      from: "async",
    };
  }

  return {
    id: firstEligibleCandidate(
      [parentCandidate, assigneeAgentId],
      eligibleAgentIds,
      suppressed,
    ),
    from: "fast-path",
  };
}

function firstEligibleCandidate(
  candidates: ReadonlyArray<string | null | undefined>,
  eligibleAgentIds: ReadonlySet<string>,
  suppressedAgentIds: ReadonlySet<string>,
): string | null {
  for (const id of candidates) {
    if (!id) continue;
    if (suppressedAgentIds.has(id)) continue;
    if (!eligibleAgentIds.has(id)) continue;
    return id;
  }
  return null;
}
