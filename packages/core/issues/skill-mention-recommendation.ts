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
  let bestId: string | null = null;
  let bestPriority = Number.POSITIVE_INFINITY;

  for (const row of backendRows ?? []) {
    if (row.source === "mention_skill") continue;
    if (suppressedAgentIds.has(row.id)) continue;
    if (!eligibleAgentIds.has(row.id)) continue;

    const priority = SOURCE_PRIORITY[row.source] ?? Number.POSITIVE_INFINITY;
    // Strict compare keeps the earliest row within a tier (backend order). The
    // null check lets the first surviving row win even at Infinity priority
    // (an unknown source against the Infinity sentinel).
    if (bestId === null || priority < bestPriority) {
      bestId = row.id;
      bestPriority = priority;
    }
  }

  return bestId;
}
