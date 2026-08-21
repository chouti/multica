"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { isAgentRuntimeBound } from "@multica/core/agents";
import type { Squad } from "@multica/core/types";
import {
  issueDetailOptions,
  issueTimelineOptions,
} from "@multica/core/issues/queries";
import {
  recommendSkillMentionAgentWithTier,
  skillMentionSourcePriority,
} from "@multica/core/issues/skill-mention-recommendation";
import {
  agentListOptions,
  squadListOptions,
} from "@multica/core/workspace/queries";
import type { UseCommentTriggerPreviewResult } from "./use-comment-trigger-preview";

const EMPTY_SUPPRESSED: ReadonlySet<string> = new Set();

/**
 * Description-editor fast-path mention: a parsed `@agent` / `@squad` mention
 * that lives in the current editor body. U5 widens the recommendation engine
 * to read these synchronously (no backend preview) so the description editors
 * — create modal manual panel + issue edit state — share the same
 * mention > assignee priority as the comment composer, with no preview race.
 */
export interface DescriptionMentionAgent {
  id: string;
  source: "mention_agent" | "mention_squad_leader";
}

export interface UseRecommendedSkillAgentParams {
  wsId: string;
  /** Optional: edit-state description editor has an issueId; create modal
   *  manual panel does not (uses `formAssignee` instead). */
  issueId?: string;
  parentId?: string;
  /**
   * The composer's own trigger-preview result, injected instead of
   * re-instantiated: `backendAgents`/`resolved` depend only on the query key
   * (issue/parent/debounced signature), so the composer's instance answers
   * identically while each keystroke parses the mention signature once
   * instead of twice.
   *
   * Description-editor consumers pass a synthetic empty+resolved preview
   * (no backend route exists for descriptions) — the async branch then yields
   * null and the recommendation collapses to fast-path only.
   */
  preview?: Pick<UseCommentTriggerPreviewResult, "backendAgents" | "resolved">;
  /**
   * Agent ids the user explicitly suppressed in the popover ("don't run"
   * gesture, KTD5). Suppressed ids are never recommended.
   */
  suppressedAgentIds?: ReadonlySet<string>;
  /**
   * Description-editor fast-path mentions parsed from the editor body via
   * `parseMentions`. Highest priority (tier 0) — a typed `@agent` mention
   * always wins over the assignee source. The composer is responsible for
   * filtering to "newly inserted" mentions per R2; this hook ranks whatever
   * the caller hands it.
   */
  descriptionMentions?: readonly DescriptionMentionAgent[];
  /**
   * Create-issue form assignee: replaces the issue query's assignee lookup
   * when there's no issueId yet. The recommendation reads this as the
   * `issue_assignee` fast-path source — squad types resolve to their leader
   * via `squadListOptions`, matching the comment composer's "treat squad
   * leader as assignee" rule.
   */
  formAssignee?: { type: string; id: string | undefined };
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
 * synchronous sources the cold-start window would otherwise hide are
 * answered immediately:
 * - description-editor `descriptionMentions` (tier 0, mention_agent /
 *   mention_squad_leader) — U5 extension, mirrors the backend's mention
 *   rows without a backend round-trip;
 * - reply-parent agent (tier 1, thread_parent) — comment composer only;
 * - issue assignee (tier 3, issue_assignee) — resolved through the issue
 *   query for edit-state or through `formAssignee` for create-issue, with
 *   squad types resolving to the leader via the squads query.
 *
 * Fast-path candidates pass the same checks as backend rows (not suppressed,
 * unarchived, runtime-bound); if none qualifies the hook returns null until
 * the preview resolves.
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
  descriptionMentions,
  formAssignee,
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

  // Squad resolution: when the assignee (issue or form) is a squad, the
  // recommendation resolves to the squad's leader (KTD5 mirrors comment
  // composer). Same query the page already mounts for the assignee picker,
  // so this adds no extra request.
  const squadsQuery = useQuery(squadListOptions(wsId));
  const squadById = useMemo(() => {
    const m = new Map<string, Squad>();
    for (const squad of squadsQuery.data ?? []) {
      m.set(squad.id, squad);
    }
    return m;
  }, [squadsQuery.data]);

  const timelineQuery = useQuery({
    ...issueTimelineOptions(issueId ?? ""),
    enabled: !!parentId && !!issueId,
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

  // Edit-state path reads the assignee from the issue query; create-issue
  // passes the form assignee directly (no issueId yet). Both code paths
  // resolve squad types to the leader via squadById.
  const issueQuery = useQuery({
    ...issueDetailOptions(wsId, issueId ?? ""),
    enabled: !!issueId,
  });
  const resolvedAssigneeAgentId = useMemo(() => {
    const resolveFromSource = (
      type: string | null | undefined,
      id: string | null | undefined,
    ): string | null => {
      if (!type || !id) return null;
      if (type === "agent") return id;
      if (type === "squad") return squadById.get(id)?.leader_id ?? null;
      return null;
    };
    if (formAssignee) {
      return resolveFromSource(formAssignee.type, formAssignee.id);
    }
    const issue = issueQuery.data;
    if (!issue) return null;
    return resolveFromSource(issue.assignee_type, issue.assignee_id);
  }, [formAssignee, issueQuery.data, squadById]);

  // Highest-priority mention_agent / mention_squad_leader from the
  // description body. The composer filters to this-session mentions per R2;
  // the hook ranks whatever survives. Squad mentions resolve to their leader
  // here — the form-assignee branch's `resolveFromSource` already mirrors
  // this for assignee types, and R2 calls out `@squad` as a valid
  // recommendation source.
  const descriptionAgentId = useMemo(() => {
    if (!descriptionMentions || descriptionMentions.length === 0) return null;
    const seen = new Set<string>();
    let bestId: string | null = null;
    let bestTier = Number.POSITIVE_INFINITY;
    for (const mention of descriptionMentions) {
      if (seen.has(mention.id)) continue;
      seen.add(mention.id);
      if (suppressedAgentIds?.has(mention.id)) continue;
      const candidateId =
        mention.source === "mention_squad_leader"
          ? (squadById.get(mention.id)?.leader_id ?? null)
          : mention.id;
      if (!candidateId) continue;
      if (suppressedAgentIds?.has(candidateId)) continue;
      if (!eligibleAgentIds.has(candidateId)) continue;
      const tier = skillMentionSourcePriority(mention.source);
      if (bestId === null || tier < bestTier) {
        bestId = candidateId;
        bestTier = tier;
      }
    }
    return bestId;
  }, [descriptionMentions, suppressedAgentIds, eligibleAgentIds, squadById]);

  const suppressed = suppressedAgentIds ?? EMPTY_SUPPRESSED;

  // Backend answer wins once available — including "answered with zero
  // candidates", which yields null instead of falling back to the fast path.
  // Description-editor consumers pass a synthetic empty+resolved preview, so
  // they fall through to the fast path immediately.
  if (preview?.resolved) {
    return {
      ...recommendSkillMentionAgentWithTier(
        preview.backendAgents,
        eligibleAgentIds,
        suppressed,
      ),
      from: "async",
    };
  }

  // Fast path: the synchronous candidates with their source tiers, so the
  // consumer's upgrade gate can compare a later async answer against the tier
  // this fill came from.
  const fastPathCandidates = [
    [descriptionAgentId, "mention_agent"],
    [timelineParentAgentId, "thread_parent"],
    [resolvedAssigneeAgentId, "issue_assignee"],
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