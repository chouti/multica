"use client";

/**
 * U4/KTD5 — the auto-bind engine behind the skill-mention recommendation.
 *
 * The resolved recommendation lands in the composer's `skillMentionAgents`
 * map as the default designation (dismiss = accept): closing the popover or
 * submitting never needs an explicit gesture for the default to bind. Every
 * explicit gesture outranks the machine:
 *
 * - Fill is keyed by skill id (not by the open popover slot): every skill
 *   chip that was inserted through the TYPED @-menu path (KTD3) and is still
 *   in the document fills at most once while its chips remain present.
 *   Pasted / undo / draft-hydrated chips never fill — they keep the manual
 *   chip-click gesture.
 * - `touched` marks skills the user toggled in the picker (select or clear);
 *   a touched skill is never filled, replaced, or terminal-filled again.
 * - A fast-path fill is a temporary value: the first async (backend) answer
 *   may replace or remove it exactly once — the badge flips at most once.
 *   An async fill is immediately sticky.
 * - Suppressing an agent clears non-touched auto-fill entries that contain
 *   it; the submit terminal fill skips suppressed recommendations too.
 * - The submit terminal fill (KTD5 step 3) reads the live document and the
 *   insertion record through refs, so a chip whose fill effect has not
 *   committed yet (cold-start race, OQ3) still binds on submit.
 * - touched/filled guards persist with the draft (CommentDraftPayload) and
 *   rehydrate on virtualization remounts, sharing the designation map's
 *   lifecycle.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import { sameStringList } from "@multica/core/utils";
import type { ContentEditorRef } from "../../editor/content-editor";
import { useT } from "../../i18n";
import type { UseCommentTriggerPreviewResult } from "./use-comment-trigger-preview";
import { useRecommendedSkillAgent } from "./use-recommended-skill-agent";
import { useSkillMentionAutoOpen } from "./use-skill-mention-auto-open";

export interface UseSkillAutoBindParams {
  wsId: string;
  issueId: string;
  /** Reply composers pass their parent comment id (thread-parent fast path). */
  parentId?: string;
  /** The composer's own trigger-preview result — see
   *  useRecommendedSkillAgent's `preview` param for why it is injected. */
  triggerPreview: Pick<UseCommentTriggerPreviewResult, "backendAgents" | "resolved">;
  /** Composer-held suppression set from the trigger chip strip. */
  suppressedAgentIds: ReadonlySet<string>;
  skillMentionAgents: Record<string, string[]>;
  setSkillMentionAgents: Dispatch<SetStateAction<Record<string, string[]>>>;
  editorRef: RefObject<ContentEditorRef | null>;
  /** Composer-owned single popover slot setter (U3). */
  setOpenPopoverFor: (skillId: string | null) => void;
  /** Draft-hydrated guards: skills already touched/filled in a previous
   *  mount of the same draft. */
  initialTouchedSkillIds?: readonly string[];
  initialFilledSkillIds?: readonly string[];
}

export interface UseSkillAutoBindResult {
  /** Replaces the composer's picker-change handler: marks the skill
   *  touched before writing the designation (KTD5 explicit-gesture rule). */
  handleSkillMentionChange: (skillId: string, agentIds: string[]) => void;
  /** Replaces the composer's doc-sync handler: prunes the insertion record
   *  and fill marks alongside the designation map when chips disappear. */
  syncSkillMentionsWithDoc: () => void;
  /** Typed-insert signal for the editor's `onSkillMentionInserted` — records
   *  fill eligibility (KTD3) and drives the U3 auto-open gate. */
  handleSkillMentionInserted: (skillId: string) => void;
  /** Call from the suppress toggle when an agent is being suppressed:
   *  clears non-touched auto-fill entries that contain the id. */
  clearAutoFilledDesignationsForAgent: (agentId: string) => void;
  /** Submit-time terminal fill: applies the resolved recommendation to
   *  typed-inserted, unfilled, untouched chips on a payload copy without
   *  depending on setState timing. Returns undefined when the map is empty. */
  finalizeSkillMentionAgents: () => Record<string, string[]> | undefined;
  /** Resets the guards and doc-skill snapshot (issue-scope change). */
  reset: () => void;
  /** Persisted-guard views for the draft payload. */
  touchedSkillIds: ReadonlySet<string>;
  filledSkillIds: ReadonlySet<string>;
  /** Polite live-region text for the latest auto-bind / auto-open event. */
  liveAnnouncement: string;
}

export function useSkillAutoBind({
  wsId,
  issueId,
  parentId,
  triggerPreview,
  suppressedAgentIds,
  skillMentionAgents,
  setSkillMentionAgents,
  editorRef,
  setOpenPopoverFor,
  initialTouchedSkillIds,
  initialFilledSkillIds,
}: UseSkillAutoBindParams): UseSkillAutoBindResult {
  const { t } = useT("issues");

  const recommended = useRecommendedSkillAgent({
    wsId,
    issueId,
    parentId,
    preview: triggerPreview,
    suppressedAgentIds,
  });
  // Render-time mirror: the submit terminal fill must read the freshest
  // recommendation without waiting for a re-render (same-tick submits).
  const recommendedRef = useRef(recommended);
  recommendedRef.current = recommended;

  const [touchedSkillIds, setTouchedSkillIds] = useState<ReadonlySet<string>>(
    () => new Set(initialTouchedSkillIds ?? []),
  );
  const [filledSkillIds, setFilledSkillIds] = useState<ReadonlySet<string>>(
    () => new Set(initialFilledSkillIds ?? []),
  );
  // Skill ids whose chips are currently in the doc, snapshotted on every
  // editor update tick — the fill effect's view of `getSkillMentionIds()`.
  const [docSkillIds, setDocSkillIds] = useState<string[]>([]);
  // Typed-insertion record (KTD3): only chips inserted through the @-menu
  // path are fill-eligible. In-memory on purpose — a hydrated chip was not
  // typed in this session, so it must not fill.
  const insertedSkillIdsRef = useRef<Set<string>>(new Set());
  // Fast-path fills still awaiting their one async confirmation.
  const upgradableSkillIdsRef = useRef<Set<string>>(new Set());
  const [liveAnnouncement, setLiveAnnouncement] = useState("");

  // Render-time mirrors for synchronous reads inside event handlers and the
  // submit path (setState in the same tick must not shadow these).
  const skillMentionAgentsRef = useRef(skillMentionAgents);
  skillMentionAgentsRef.current = skillMentionAgents;
  const suppressedAgentIdsRef = useRef(suppressedAgentIds);
  suppressedAgentIdsRef.current = suppressedAgentIds;
  const touchedRef = useRef(touchedSkillIds);
  touchedRef.current = touchedSkillIds;
  const filledRef = useRef(filledSkillIds);
  filledRef.current = filledSkillIds;

  // Auto-open wiring (U3/KTD4) with the aria-live announcement: the gate
  // lives in useSkillMentionAutoOpen; the wrapper only marks fill eligibility.
  const openPopoverAndAnnounce = useCallback(
    (skillId: string | null) => {
      setOpenPopoverFor(skillId);
      if (skillId !== null) {
        setLiveAnnouncement(t(($) => $.comment.skill_picker_auto_opened_live));
      }
    },
    [setOpenPopoverFor, t],
  );
  const autoOpen = useSkillMentionAutoOpen(wsId, openPopoverAndAnnounce);
  const handleSkillMentionInserted = useCallback(
    (skillId: string) => {
      insertedSkillIdsRef.current.add(skillId);
      autoOpen(skillId);
    },
    [autoOpen],
  );

  const handleSkillMentionChange = useCallback(
    (skillId: string, agentIds: string[]) => {
      // Every picker gesture (select or clear) marks the skill touched —
      // the machine default never overrides an explicit choice afterwards.
      setTouchedSkillIds((prev) =>
        prev.has(skillId) ? prev : new Set([...prev, skillId]),
      );
      // A manual gesture also finalizes any pending fast-path upgrade.
      upgradableSkillIdsRef.current.delete(skillId);
      setSkillMentionAgents((prev) => {
        const next = { ...prev };
        if (agentIds.length > 0) next[skillId] = agentIds;
        else delete next[skillId];
        return next;
      });
    },
    [setSkillMentionAgents],
  );

  const syncSkillMentionsWithDoc = useCallback(() => {
    const ids = editorRef.current?.getSkillMentionIds() ?? [];
    const present = new Set(ids);
    // Prune the typed-insertion record and the fill-once marks with the
    // designation map: once every chip for a skill is gone, a re-insertion
    // is eligible to fill again (KTD5). Touched is deliberately NOT pruned —
    // an explicit gesture outlives the chip that received it. The filter only
    // removes, so an unchanged set keeps its reference (no allocation on the
    // common typing tick).
    const keepPresent = (ids: Set<string>) => {
      const filtered = [...ids].filter((id) => present.has(id));
      return filtered.length === ids.size ? ids : new Set(filtered);
    };
    insertedSkillIdsRef.current = keepPresent(insertedSkillIdsRef.current);
    upgradableSkillIdsRef.current = keepPresent(upgradableSkillIdsRef.current);
    setFilledSkillIds((prev) => {
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setDocSkillIds((prev) => (sameStringList(prev, ids) ? prev : ids));
    setSkillMentionAgents((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([id]) => present.has(id)),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [editorRef, setSkillMentionAgents]);

  useEffect(() => {
    // (A) Async confirmation: a fast-path fill is a temporary value, so the
    // first authoritative answer replaces (or, when null, removes) it exactly
    // once per fill — the badge flips at most once.
    if (recommended.from === "async") {
      const pending = [...upgradableSkillIdsRef.current];
      if (pending.length > 0) {
        upgradableSkillIdsRef.current = new Set();
        const authoritativeId = recommended.id;
        setSkillMentionAgents((prev) => {
          let next: Record<string, string[]> | null = null;
          for (const skillId of pending) {
            if (touchedRef.current.has(skillId)) continue;
            const current = prev[skillId];
            // Entry already gone (suppress gesture / manual clear).
            if (!current) continue;
            const unchanged =
              authoritativeId != null &&
              current.length === 1 &&
              current[0] === authoritativeId;
            if (unchanged) continue;
            next ??= { ...prev };
            if (authoritativeId == null) delete next[skillId];
            else next[skillId] = [authoritativeId];
          }
          return next ?? prev;
        });
      }
    }

    // (B) Fresh fills: typed-inserted chips still in the doc that were never
    // filled nor touched and carry no designation yet (hydrated designations
    // win over re-fill).
    const recommendedId = recommended.id;
    if (recommendedId == null) return;
    const targets = docSkillIds.filter(
      (skillId) =>
        insertedSkillIdsRef.current.has(skillId) &&
        !touchedSkillIds.has(skillId) &&
        !filledSkillIds.has(skillId) &&
        !skillMentionAgents[skillId],
    );
    if (targets.length === 0) return;
    if (recommended.from === "fast-path") {
      for (const skillId of targets) upgradableSkillIdsRef.current.add(skillId);
    }
    setFilledSkillIds((prev) => {
      const next = new Set(prev);
      for (const skillId of targets) next.add(skillId);
      return next;
    });
    setSkillMentionAgents((prev) => {
      const next = { ...prev };
      for (const skillId of targets) next[skillId] = [recommendedId];
      return next;
    });
    // The chip badge flips from 0 to 1 designated agent — announce it.
    setLiveAnnouncement(t(($) => $.comment.skill_autobind_applied_live));
  }, [
    recommended.id,
    recommended.from,
    docSkillIds,
    touchedSkillIds,
    filledSkillIds,
    skillMentionAgents,
    setSkillMentionAgents,
    t,
  ]);

  const clearAutoFilledDesignationsForAgent = useCallback(
    (agentId: string) => {
      // The suppress ("don't run") gesture: machine-written entries that name
      // the suppressed agent are removed. Touched entries stay — an explicit
      // pick survives a suppress aimed at the implicit chip. The filled marks
      // stay too, so the machine cannot immediately re-fill another default.
      setSkillMentionAgents((prev) => {
        let next: Record<string, string[]> | null = null;
        for (const [skillId, agentIds] of Object.entries(prev)) {
          if (touchedRef.current.has(skillId)) continue;
          if (!agentIds.includes(agentId)) continue;
          next ??= { ...prev };
          delete next[skillId];
        }
        return next ?? prev;
      });
    },
    [setSkillMentionAgents],
  );

  const finalizeSkillMentionAgents = useCallback(():
    | Record<string, string[]>
    | undefined => {
    const { id: recommendedId } = recommendedRef.current;
    let out: Record<string, string[]> | null = null;
    if (recommendedId != null && !suppressedAgentIdsRef.current.has(recommendedId)) {
      // Live document read: unlike the fill effect (fed by the debounced
      // doc snapshot), the terminal fill sees chips inserted moments before
      // the submit (OQ3 race narrowing).
      const docIds = editorRef.current?.getSkillMentionIds() ?? [];
      for (const skillId of docIds) {
        if (skillMentionAgentsRef.current[skillId]) continue;
        if (!insertedSkillIdsRef.current.has(skillId)) continue;
        if (touchedRef.current.has(skillId)) continue;
        if (filledRef.current.has(skillId)) continue;
        out ??= { ...skillMentionAgentsRef.current };
        out[skillId] = [recommendedId];
      }
    }
    const map = out ?? skillMentionAgentsRef.current;
    return Object.keys(map).length > 0 ? map : undefined;
  }, [editorRef]);

  const reset = useCallback(() => {
    insertedSkillIdsRef.current = new Set();
    upgradableSkillIdsRef.current = new Set();
    setTouchedSkillIds(new Set());
    setFilledSkillIds(new Set());
    setDocSkillIds([]);
  }, []);

  return {
    handleSkillMentionChange,
    syncSkillMentionsWithDoc,
    handleSkillMentionInserted,
    clearAutoFilledDesignationsForAgent,
    finalizeSkillMentionAgents,
    reset,
    touchedSkillIds,
    filledSkillIds,
    liveAnnouncement,
  };
}
