"use client";

import type { IssueAssigneeType, IssueStatus } from "@multica/core/types";
import { useActorName } from "@multica/core/workspace/hooks";
import { cn } from "@multica/ui/lib/utils";
import { ActorAvatar } from "../../common/actor-avatar";
import { useIssueTriggerPreview } from "../hooks/use-issue-trigger-preview";
import { useT } from "../../i18n";

/**
 * U7 — the create modal's passive pre-trigger label (MUL-3375 §4).
 *
 * Whether saving will start a run, driven by the unified backend predicate
 * (preview, isCreate) — never a frontend guess. No dialog, no blocking.
 *
 * Plus the U7 designation hint: when the user has chosen one or more
 * `@skill` chips with an agent picked in their popovers, this hint surfaces
 * a localized "Designated @<skill> for @<agent>" line so they can confirm
 * what they're about to bind before pressing Create (KTD8). The line has
 * two variants — `willRun: true` (will run after creation) and `willRun:
 * false` (bind-only: backlog OR assignee). The unresolved hint covers the
 * remaining R14 surface: chips in the doc with no agent picked.
 *
 * Visually it borrows the comment header's avatar+text line, minus the
 * interactivity — purely a caption, never a link/hover-card. It renders
 * its own reveal band (a grid 0fr→1fr collapse) so it sits on a dedicated
 * row above the property toolbar without reflowing anything: collapsed it
 * is 0px (the flex-1 editor absorbs the delta), and it expands only once
 * the predicate resolves, animating straight to the correct copy.
 */

export interface SkillDesignationHint {
  /** The label the user typed for the skill chip. */
  skillLabel: string;
  /** Display name of the agent the skill is bound to. */
  agentName: string;
  /** True when the designation will start a run after creation/edit;
   *  false for bind-only paths (backlog / assignee). */
  willRun: boolean;
}

export interface CreateRunHintProps {
  assigneeType?: IssueAssigneeType;
  assigneeId?: string;
  status: IssueStatus;
  /** Designation lines to render. Renders nothing for this section when
   *  empty (R3 touched semantics + R12 no-designation silent path). */
  designations?: ReadonlyArray<SkillDesignationHint>;
  /** Skill labels that are in the doc but have no agent picked yet (R14
   *  unresolved surface). Renders the unresolved hint when non-empty. */
  unresolvedSkillLabels?: ReadonlyArray<string>;
}

export function CreateRunHint({
  assigneeType,
  assigneeId,
  status,
  designations,
  unresolvedSkillLabels,
}: CreateRunHintProps) {
  const { t } = useT("modals");
  const { getActorName } = useActorName();
  const isAgentLike = assigneeType === "agent" || assigneeType === "squad";
  const preview = useIssueTriggerPreview({
    isCreate: true,
    assigneeType: assigneeType ?? null,
    assigneeId: assigneeId ?? null,
    status,
    enabled: isAgentLike && !!assigneeId,
  });

  // Reveal only after the predicate resolves so the band animates to the final
  // copy instead of flashing "parked" before the run preview lands.
  const ready = isAgentLike && !!assigneeId && !preview.isLoading;
  const willStart = preview.totalCount > 0;
  const isSquad = assigneeType === "squad";
  const triggerAgentId = preview.triggers[0]?.agent_id ?? assigneeId;

  // Avatar + copy mirror the flow. A squad doesn't "work" — its leader
  // evaluates and delegates — so the squad path keeps the squad as the subject
  // (avatar + name) and uses the leader-delegates copy. A single agent picks
  // the issue up directly; a parked issue shows whoever it was assigned to.
  let avatarType: string;
  let avatarId: string | undefined;
  let text: string;
  if (!willStart) {
    avatarType = assigneeType ?? "agent";
    avatarId = assigneeId;
    text = t(($) => $.run_confirm.create_parked);
  } else if (isSquad) {
    avatarType = "squad";
    avatarId = assigneeId;
    text = t(($) => $.run_confirm.create_will_start_squad, {
      name: getActorName("squad", assigneeId ?? ""),
    });
  } else {
    avatarType = "agent";
    avatarId = triggerAgentId;
    text = t(($) => $.run_confirm.create_will_start, {
      name: getActorName("agent", triggerAgentId ?? assigneeId ?? ""),
    });
  }

  const designationEntries = designations ?? [];
  const unresolvedEntries = unresolvedSkillLabels ?? [];
  const showDesignations = designationEntries.length > 0;
  const showUnresolved = unresolvedEntries.length > 0;
  const showAny = (ready && !!text) || showDesignations || showUnresolved;

  return (
    <div
      className={cn(
        "grid shrink-0 transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none",
        showAny ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
      )}
      aria-hidden={!showAny}
    >
      <div className="overflow-hidden">
        <div
          aria-live="polite"
          className="flex flex-col gap-0.5 px-4 pb-1 pt-0.5 text-micro text-muted-foreground"
        >
          {ready && text && (
            <div className="flex items-center gap-1.5">
              {avatarId && (
                <ActorAvatar
                  actorType={avatarType}
                  actorId={avatarId}
                  size="sm"
                  profileLink={false}
                />
              )}
              <span className="truncate">{text}</span>
            </div>
          )}
          {showDesignations &&
            designationEntries.map((entry, idx) => {
              const line = entry.willRun
                ? t(($) => $.skill_designation.run_hint_will_run, {
                    skillName: entry.skillLabel,
                    agentName: entry.agentName,
                  })
                : t(($) => $.skill_designation.run_hint_bind_only, {
                    skillName: entry.skillLabel,
                    agentName: entry.agentName,
                  });
              return (
                <div
                  key={`designation-${idx}-${entry.skillLabel}-${entry.agentName}`}
                  className="flex items-center gap-1.5"
                  data-testid="create-run-hint-designation"
                >
                  <span className="truncate">{line}</span>
                </div>
              );
            })}
          {showUnresolved && (
            <div
              className="flex items-center gap-1.5"
              data-testid="create-run-hint-unresolved"
            >
              <span className="truncate">
                {t(($) => $.skill_designation.unresolved_hint, {
                  count: unresolvedEntries.length,
                  // The single-skill hint (EN `_one`) names the chip; multi-
                  // skill (EN `_other` + every non-EN locale, which only have
                  // `_other`) ignores the parameter. Always pass it so the
                  // locale decides what to render — never us.
                  skillName: unresolvedEntries[0] ?? "",
                })}
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}