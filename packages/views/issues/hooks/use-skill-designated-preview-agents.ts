"use client";

import { useQuery } from "@tanstack/react-query";
import { agentListOptions } from "@multica/core/workspace/queries";
import type { CommentTriggerPreviewAgent } from "@multica/core/types";

/**
 * Map the composer-held skill→agent-id map to renderable
 * CommentTriggerPreviewAgent rows so the trigger-preview strip can show
 * designated skill agents even though the backend's read-only preview
 * discards skill_mention_agents (review finding #11).
 *
 * Each designated id is looked up in the workspace agent list (a single
 * batched query via agentListOptions). Agents that cannot be resolved
 * (deleted / cross-workspace) are silently dropped so the preview does
 * not show broken entries.
 */
export function useSkillDesignatedPreviewAgents(
  wsId: string,
  skillMentionAgents: Record<string, string[]>,
): CommentTriggerPreviewAgent[] {
  const agentIds = collectAgentIds(skillMentionAgents);
  const agentsQuery = useQuery({
    ...agentListOptions(wsId),
    enabled: agentIds.length > 0,
  });
  const byId = new Map((agentsQuery.data ?? []).map((a) => [a.id, a]));
  const out: CommentTriggerPreviewAgent[] = [];
  for (const id of agentIds) {
    const a = byId.get(id);
    if (!a) continue;
    out.push({
      id: a.id,
      name: a.name,
      avatar_url: a.avatar_url ?? undefined,
      source: "mention_skill",
      reason: "Skill mention designation",
    });
  }
  return out;
}

function collectAgentIds(skillMentionAgents: Record<string, string[]>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of Object.values(skillMentionAgents)) {
    for (const id of list) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
    }
  }
  return out;
}
