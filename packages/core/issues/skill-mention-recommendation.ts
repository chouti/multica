import type { CommentTriggerPreviewAgent } from "../types";

// KTD1: the skill auto-bind recommendation is the backend's implicit trigger
// agents ranked by source priority — the same logic the backend preview runs
// (read-only computeCommentAgentTriggers). The frontend only sorts; it never
// recomputes routing.
const SOURCE_PRIORITY: Readonly<Record<string, number>> = {
  mention_agent: 0,
  mention_squad_leader: 0,
  thread_parent: 1,
  conversation_continuation: 2,
  issue_assignee: 3,
};

/**
 * The source-tier rank of a backend trigger row (KTD1 lattice). Lower ranks
 * higher; unknown sources rank below every known tier.
 */
export function skillMentionSourcePriority(source: string): number {
  return SOURCE_PRIORITY[source] ?? Number.POSITIVE_INFINITY;
}

export interface SkillMentionRecommendationWithTier {
  id: string | null;
  /** Rank of the winning row's source tier — `skillMentionSourcePriority`.
   *  `Infinity` when no row wins. Consumers use it to decide whether a later
   *  answer strictly outranks an earlier fill (review finding #4). */
  tier: number;
}

/**
 * Tier-aware variant of {@link recommendSkillMentionAgent}: identical
 * selection, plus the winning row's source-tier rank. Same input contract
 * (UNMERGED backend rows, eligibility set, suppression set).
 */
export function recommendSkillMentionAgentWithTier(
  backendRows: readonly CommentTriggerPreviewAgent[],
  eligibleAgentIds: ReadonlySet<string>,
  suppressedAgentIds: ReadonlySet<string>,
): SkillMentionRecommendationWithTier {
  let best: SkillMentionRecommendationWithTier = {
    id: null,
    tier: Number.POSITIVE_INFINITY,
  };

  for (const row of backendRows ?? []) {
    if (row.source === "mention_skill") continue;
    if (suppressedAgentIds.has(row.id)) continue;
    if (!eligibleAgentIds.has(row.id)) continue;

    const priority = skillMentionSourcePriority(row.source);
    // Strict compare keeps the earliest row within a tier (backend order). The
    // null check lets the first surviving row win even at Infinity priority
    // (an unknown source against the Infinity sentinel).
    if (best.id === null || priority < best.tier) {
      best = { id: row.id, tier: priority };
    }
  }

  return best;
}

/**
 * Pick the recommended agent id for a skill-mention popover in the current
 * composer context, or `null` when no candidate survives.
 *
 * Inputs:
 * - `backendRows` must be the UNMERGED backend preview rows. The composer's
 *   `useCommentTriggerPreview` merges skill-designated rows in by replacing a
 *   backend row with its designation row (`source = "mention_skill"`), which
 *   erases the backend source this function sorts on. Consuming merged rows
 *   would let a second @skill chip mistake an already-designated agent for a
 *   self-reference and drop it.
 * - `eligibleAgentIds` is the recommendation-side visibility set (unarchived
 *   AND runtime-bound) — deliberately stricter than the picker, which only
 *   filters `archived_at` and allows manually selecting an unbound agent.
 * - `suppressedAgentIds` holds ids the user explicitly suppressed ("don't
 *   run"); an explicit refusal must never be machine-recommended.
 *
 * Exclusions: `mention_skill` rows (self-reference guard — the backend never
 * emits that source, so any such row is a frontend designation row),
 * suppressed ids, and ids that fail the visibility check. Unknown future
 * sources rank below every known tier instead of being dropped: the row still
 * means the backend will run that agent (server-driven enums need a default
 * branch). Within one tier the backend row order wins.
 */
export function recommendSkillMentionAgent(
  backendRows: readonly CommentTriggerPreviewAgent[],
  eligibleAgentIds: ReadonlySet<string>,
  suppressedAgentIds: ReadonlySet<string>,
): string | null {
  return recommendSkillMentionAgentWithTier(
    backendRows,
    eligibleAgentIds,
    suppressedAgentIds,
  ).id;
}
