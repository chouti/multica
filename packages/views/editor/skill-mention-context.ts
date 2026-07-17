"use client";

/**
 * Composer-owned state for skill-mention agent designation.
 *
 * Skill mentions live in the editor document; the designation of which agent(s)
 * should run a skill lives in composer React state, mirroring the
 * `suppressedAgentIds` pattern. This context is what lets a Tiptap NodeView
 * (rendered outside the composer's normal React subtree) read and update that
 * composer state.
 *
 * One shared context is defined here so `MentionView` (inside
 * `ReactNodeViewRenderer`) and `ContentEditor` (the host) stay aligned.
 */

import { createContext, useContext } from "react";

export interface SkillMentionContextValue {
  /** Workspace id for the editor's current workspace context. */
  wsId: string;
  /** Composer-held designation map: skill id -> selected agent ids. */
  skillMentionAgents: Record<string, string[]>;
  /** Update the composer-held designation map for one skill mention. */
  onSkillMentionChange: (skillId: string, agentIds: string[]) => void;
  /**
   * Currently-open skill picker popover, keyed by skill id. When the
   * editor recreates a NodeView (e.g. on surrounding transactions that
   * tear down + rebuild the React subtree), the local useState is lost;
   * hoisting this into composer state keeps the popover open across the
   * recreation. Only one picker is open at a time — selecting another
   * chip moves the open state.
   */
  openPopoverFor: string | null;
  setOpenPopoverFor: (skillId: string | null) => void;
}

export const SkillMentionContext = createContext<SkillMentionContextValue | null>(null);

export function useSkillMentionContext(): SkillMentionContextValue | null {
  return useContext(SkillMentionContext);
}
