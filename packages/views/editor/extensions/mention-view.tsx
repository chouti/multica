"use client";

/**
 * MentionView — NodeView for rendering @mentions inline in the editor.
 *
 * Dispatch is registry-driven via `isActorMentionType` from
 * `@multica/core/mention`. Issue and project have dedicated chip components
 * with navigation; actor types (member/agent/squad/@all) share the
 * ActorMentionChip pattern with hover cards. Skill mentions render as a
 * SkillChip with a hover card showing bound agents. Unknown types fall back
 * to a plain-text mention.
 *
 * Member/agent mentions: plain "@Name" text with .mention class styling.
 * Issue/project mentions render the same navigable chips as readonly content
 * (IssueMentionCard / ProjectMentionCard), so click behavior — plain click,
 * modifier click, middle click — cannot drift between an editing and a
 * readonly surface. The editor's ProseMirror click handler skips anything
 * inside `[data-node-view-wrapper]`, so the AppLink inside the card owns the
 * click alone.
 *
 * Issue chip sizing: must fit within the paragraph line box (14px * 1.625 =
 * 22.75px). Card is text-caption (12px) + py-0.5 + border ≈ 22px total. The
 * `vertical-align: middle` rule on `[data-node-view-wrapper]` in CSS handles
 * line-box alignment; setting it on an inner element has no effect because
 * the wrapper is the outermost inline element.
 */

import { useEffect } from "react";
import { NodeViewWrapper } from "@tiptap/react";
import type { Editor, NodeViewProps } from "@tiptap/react";
import { isActorMentionType } from "@multica/core/mention";
import { isImeComposing } from "@multica/core/utils";
import { IssueMentionCard } from "../../issues/components/issue-mention-card";
import { ProjectMentionCard } from "../../projects/components/project-mention-card";
import { ActorMentionChip } from "@multica/ui/components/common/actor-mention-chip";
import { SkillMentionChip } from "@multica/ui/components/common/skill-mention-chip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@multica/ui/components/ui/popover";
import { MentionHoverCard } from "../mention-hover-card";
import { SkillAgentPicker } from "../skill-agent-picker";
import { useSkillMentionContext } from "../skill-mention-context";

export function MentionView({ node, editor }: NodeViewProps) {
  const { type, id, label } = node.attrs;

  // stopPropagation mirrors the readonly renderer's mention wrappers: a chip
  // click must not reach surrounding click handlers.
  if (type === "issue") {
    return (
      <NodeViewWrapper
        as="span"
        className="inline"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <IssueMentionCard issueId={id} fallbackLabel={label} />
      </NodeViewWrapper>
    );
  }

  if (type === "project") {
    return (
      <NodeViewWrapper
        as="span"
        className="inline"
        onClick={(e: React.MouseEvent) => e.stopPropagation()}
      >
        <ProjectMentionCard projectId={id} fallbackLabel={label} />
      </NodeViewWrapper>
    );
  }

  const name = (label ?? id) as string;

  // Skill mentions render as a skill chip with bound-agents hover card. When
  // composer state is available (comment composers), clicking the chip also
  // opens the agent picker so the mention can be designated to specific agents.
  if (type === "skill") {
    return (
      <NodeViewWrapper as="span" className="inline">
        <SkillMention skillId={id} name={name} editor={editor} />
      </NodeViewWrapper>
    );
  }

  const initials = name.charAt(0);

  // Actor types (member/agent/squad/all) render as avatar chips with hover cards.
  if (isActorMentionType(type)) {
    return (
      <NodeViewWrapper as="span" className="inline">
        <MentionHoverCard type={type} id={id}>
          <ActorMentionChip type={type} label={name} initials={initials} focusable />
        </MentionHoverCard>
      </NodeViewWrapper>
    );
  }

  // Unknown or unhandled types — plain-text fallback.
  return (
    <NodeViewWrapper as="span" className="inline">
      <span className="mention">@{name}</span>
    </NodeViewWrapper>
  );
}

function SkillMention({
  skillId,
  name,
  editor,
}: {
  skillId: string;
  name: string;
  editor: Editor;
}) {
  // Popover open state is hoisted into the composer-owned SkillMentionContext
  // so a Tiptap NodeView recreation (which can happen on surrounding
  // transactions) does not close the picker mid-selection. See review
  // finding #14.
  const context = useSkillMentionContext();
  const selectedAgentIds = context?.skillMentionAgents[skillId] ?? [];
  const open = context?.openPopoverFor === skillId;
  const setOpen = (next: boolean) => {
    if (!context) return;
    context.setOpenPopoverFor(next ? skillId : null);
  };

  // U3/KTD4 — the auto-opened popover must not steal focus: the caret stays
  // in the editor and drives the popover from there. While open, a capture
  // keydown listener on the document routes the editor-side keys:
  // Tab/ArrowDown move focus into the picker list; Escape closes the popover
  // (only the popover — the MUL-5429 dialog lesson); the first typing
  // keystroke closes it and keeps typing. Once focus is inside the list the
  // picker owns its keys (arrow navigation + Enter live there).
  useEffect(() => {
    if (!open || !context) return;
    const editorDom = editor?.view?.dom as HTMLElement | null | undefined;
    if (!editorDom) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (isImeComposing(event)) return;
      const active = document.activeElement;
      const focusInEditor = active instanceof Node && editorDom.contains(active);
      const popup = document.querySelector<HTMLElement>(
        '[data-slot="popover-content"]',
      );

      if (event.key === "Escape" || event.key === "Esc") {
        // Only the popover closes — the keypress is stopped here so it cannot
        // bubble on to a host Dialog and discard the draft (MUL-5429).
        event.preventDefault();
        event.stopPropagation();
        context.setOpenPopoverFor(null);
        if (!focusInEditor) {
          // Focus was inside the (now closing) list — return the caret to
          // the editor so typing continues where it left off.
          editor.commands.focus();
        }
        return;
      }

      // Everything below is the editor-resident path.
      if (!focusInEditor) return;
      if (event.key === "Tab" || event.key === "ArrowDown") {
        const firstRow = popup?.querySelector<HTMLElement>("button");
        if (firstRow) {
          event.preventDefault();
          firstRow.focus();
        }
        return;
      }
      // First typing keystroke while focus never entered the list: let it
      // land in the editor and dismiss the popover. Modifier combos are not
      // typing.
      if (
        !event.metaKey &&
        !event.ctrlKey &&
        !event.altKey &&
        (event.key.length === 1 ||
          event.key === "Backspace" ||
          event.key === "Delete" ||
          event.key === "Enter")
      ) {
        context.setOpenPopoverFor(null);
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, context, editor]);

  const chip = (
    <SkillMentionChip
      name={name}
      focusable
      designatedCount={selectedAgentIds.length}
    />
  );

  if (!context) {
    return (
      <MentionHoverCard type="skill" id={skillId}>
        {chip}
      </MentionHoverCard>
    );
  }

  // The picker must still open on click while the hover card keeps its own
  // hover-only preview. PopoverTrigger is the click target; the HoverCard wrapper
  // stays outside so hover behavior remains unchanged.
  return (
    <Popover modal={false} open={open} onOpenChange={setOpen}>
      <MentionHoverCard type="skill" id={skillId}>
        <PopoverTrigger
          render={(triggerProps) => (
            <span
              {...triggerProps}
              className="inline-flex cursor-pointer"
              data-testid={`skill-mention-trigger-${skillId}`}
            />
          )}
        >
          {chip}
        </PopoverTrigger>
      </MentionHoverCard>
      {/* initialFocus=false keeps the caret in the editor for both the
          auto-open and the manual click — the popover is non-modal. */}
      <PopoverContent align="start" className="w-72" initialFocus={false}>
        <SkillAgentPicker
          skillId={skillId}
          fallbackSkillName={name}
          wsId={context.wsId}
          selectedAgentIds={selectedAgentIds}
          onChange={(agentIds) => context.onSkillMentionChange(skillId, agentIds)}
        />
      </PopoverContent>
    </Popover>
  );
}
