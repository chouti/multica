"use client";

import { useCallback, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { agentListOptions } from "@multica/core/workspace/queries";

/**
 * U3/KTD4 — auto-open gate for the skill-mention agent picker popover.
 *
 * Hand the returned handler to ContentEditor's `onSkillMentionInserted`
 * (fired ONLY by typed @-menu selections; see mention-suggestion.tsx). The
 * handler targets the composer's single-slot popover setter when the
 * workspace agent list has settled non-empty:
 *
 * - settled non-empty → open immediately;
 * - in-flight → hold the request and open once the list settles non-empty;
 * - settled empty (no bindable agent) → never auto-open; the manual
 *   chip-click gesture remains the way in.
 *
 * Shares the picker's own query key (agentListOptions), so mounting a
 * composer also warms the popover's list.
 */
export function useSkillMentionAutoOpen(
  wsId: string,
  setOpenPopoverFor: (skillId: string | null) => void,
): (skillId: string) => void {
  const { data: agents, isLoading } = useQuery(agentListOptions(wsId));
  // Same visibility rule as the picker itself: archived agents cannot be
  // designated, so they do not count toward "there is someone to pick".
  const hasBindableAgents = (agents ?? []).some((agent) => !agent.archived_at);
  // Held while the agent list is in flight; consumed by the effect below.
  const pendingSkillRef = useRef<string | null>(null);

  const handleSkillMentionInserted = useCallback(
    (skillId: string) => {
      if (isLoading) {
        pendingSkillRef.current = skillId;
        return;
      }
      if (hasBindableAgents) setOpenPopoverFor(skillId);
    },
    [isLoading, hasBindableAgents, setOpenPopoverFor],
  );

  // The in-flight tail: fire (or drop) the held request when the list settles.
  useEffect(() => {
    const pending = pendingSkillRef.current;
    if (!pending || isLoading) return;
    pendingSkillRef.current = null;
    if (hasBindableAgents) setOpenPopoverFor(pending);
  }, [isLoading, hasBindableAgents, setOpenPopoverFor]);

  return handleSkillMentionInserted;
}
