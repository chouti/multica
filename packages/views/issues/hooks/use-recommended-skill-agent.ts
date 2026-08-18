"use client";

import { useQuery } from "@tanstack/react-query";
import { isAgentRuntimeBound } from "@multica/core/agents";
import {
  issueDetailOptions,
  issueTimelineOptions,
} from "@multica/core/issues/queries";
import { recommendSkillMentionAgent } from "@multica/core/issues/skill-mention-recommendation";
import { agentListOptions } from "@multica/core/workspace/queries";
import { useCommentTriggerPreview } from "./use-comment-trigger-preview";

const EMPTY_SUPPRESSED: ReadonlySet<string> = new Set();

export interface UseRecommendedSkillAgentParams {
  wsId: string;
  issueId: string;
  parentId?: string;
  editingCommentId?: string;
  content: string;
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
 * The recommended agent id for the skill-mention popover in the current
 * composer context, or `null` when no candidate qualifies.
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
export function useRecommendedSkillAgent({
  wsId,
  issueId,
  parentId,
  editingCommentId,
  content,
  suppressedAgentIds,
  replyParentAgentId,
}: UseRecommendedSkillAgentParams): string | null {
  const preview = useCommentTriggerPreview({
    issueId,
    parentId,
    editingCommentId,
    content,
  });

  // Recommendation-side visibility is stricter than the picker: an
  // auto-recommendation must be actionable, so the agent must be unarchived
  // AND runtime-bound. Manual selection in the picker may still target an
  // unbound agent — that difference is intentional.
  const agentsQuery = useQuery(agentListOptions(wsId));
  const eligibleAgentIds = new Set(
    (agentsQuery.data ?? [])
      .filter((a) => !a.archived_at && isAgentRuntimeBound(a))
      .map((a) => a.id),
  );

  const timelineQuery = useQuery({
    ...issueTimelineOptions(issueId),
    enabled: !!parentId,
  });
  const parentEntry = parentId
    ? timelineQuery.data?.find(
        (entry) => entry.type === "comment" && entry.id === parentId,
      )
    : undefined;
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
    return recommendSkillMentionAgent(preview.backendAgents, eligibleAgentIds, suppressed);
  }

  return firstEligibleCandidate(
    [parentCandidate, assigneeAgentId],
    eligibleAgentIds,
    suppressed,
  );
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
