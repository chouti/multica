"use client";

/**
 * SkillAgentPicker — popover content for designating which workspace agent(s)
 * should run a skill mention in the comment composer.
 *
 * The designation map lives in composer state (NOT in the mention node attrs),
 * mirroring `suppressedAgentIds`. This component only renders the list and
 * toggles selections through `onChange`.
 *
 * Data notes:
 * - Uses `useQuery(agentListOptions(wsId))` rather than `getQueryData` so the
 *   picker still populates on a cold cache (the skill autocomplete cold-cache
 *   lesson).
 * - Archived agents are excluded from the list; the picker is not filtered by
 *   the skill's current bindings (a skill may target any workspace agent).
 * - Presence is optional display metadata only — the underlying agent list is
 *   still the source of truth.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Circle } from "lucide-react";
import type { Agent } from "@multica/core/types";
import { useAgentPresenceDetail } from "@multica/core/agents";
import {
  agentListOptions,
  skillDetailOptions,
} from "@multica/core/workspace/queries";
import { ActorAvatar as ActorAvatarBase } from "@multica/ui/components/common/actor-avatar";
import { cn } from "@multica/ui/lib/utils";
import { availabilityConfig } from "../agents/presence";
import { useT } from "../i18n";

interface SkillAgentPickerProps {
  skillId: string;
  selectedAgentIds: string[];
  onChange: (agentIds: string[]) => void;
  wsId: string;
  /** Best-effort label from the mention markdown. The true skill name is
   *  resolved through `skillDetailOptions` once the query settles, so the
   *  header never has to rely on `node.attrs.label`. */
  fallbackSkillName?: string;
}

function AgentPickerPresenceDot({ wsId, agentId }: { wsId: string; agentId: string }) {
  const detail = useAgentPresenceDetail(wsId, agentId);
  if (detail === "loading") return null;
  return (
    <span
      aria-label={`Status: ${availabilityConfig[detail.availability].label}`}
      className={cn("h-2 w-2 shrink-0 rounded-full", availabilityConfig[detail.availability].dotClass)}
    />
  );
}

export function SkillAgentPicker({
  skillId,
  selectedAgentIds,
  onChange,
  wsId,
  fallbackSkillName,
}: SkillAgentPickerProps) {
  const { t } = useT("editor");
  const { data: skillDetail } = useQuery(skillDetailOptions(wsId, skillId));
  const { data: agents = [], isLoading } = useQuery(agentListOptions(wsId));

  const visibleAgents = useMemo(
    () => agents.filter((agent) => !agent.archived_at),
    [agents],
  );

  const selectedSet = useMemo(() => new Set(selectedAgentIds), [selectedAgentIds]);
  const toggleAgent = (agentId: string) => {
    onChange(
      selectedSet.has(agentId)
        ? selectedAgentIds.filter((id) => id !== agentId)
        : [...selectedAgentIds, agentId],
    );
  };

  const title = skillDetail?.name ?? fallbackSkillName ?? skillId;
  const emptyText = isLoading
    ? t(($) => $.mention.searching)
    : t(($) => $.mention.skill_no_agents);

  return (
    <div className="flex w-full flex-col gap-2 overflow-hidden text-left">
      <div className="space-y-0.5 px-1">
        <div className="truncate text-body font-medium">{title}</div>
        <div className="text-caption text-muted-foreground">
          {t(($) => $.mention.skill_agents_picker_title)}
        </div>
      </div>
      {visibleAgents.length === 0 ? (
        <div className="px-1 py-2 text-caption text-muted-foreground">{emptyText}</div>
      ) : (
        <div className="flex flex-col">
          {visibleAgents.map((agent: Agent) => {
            const selected = selectedSet.has(agent.id);
            return (
              <button
                key={agent.id}
                type="button"
                aria-pressed={selected}
                aria-label={t(($) => $.mention.skill_agent_row_aria, {
                  name: agent.name,
                })}
                onClick={() => toggleAgent(agent.id)}
                className={cn(
                  "flex w-full cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-muted",
                  selected && "bg-muted",
                )}
              >
                <ActorAvatarBase
                  name={agent.name}
                  initials=""
                  avatarUrl={agent.avatar_url}
                  isAgent
                  size="xs"
                />
                <span className="min-w-0 flex-1 truncate text-caption">{agent.name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  <AgentPickerPresenceDot wsId={wsId} agentId={agent.id} />
                  <Circle
                    aria-hidden
                    className={cn(
                      "h-3 w-3 text-muted-foreground",
                      selected && "fill-current text-foreground",
                    )}
                  />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
