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
 *   An async-origin fill is sticky against same-tier and lower-tier answers
 *   (no identity flicker), but one strictly higher-tier answer may replace it
 *   once (review finding #4): an @agent mention typed after the chip still
 *   wins the skill (R5).
 * - A `/note` draft is the explicit "this comment triggers nothing" gesture —
 *   the machine fill and the submit terminal fill both skip it; the manual
 *   picker gesture stays available (review finding #9).
 * - Suppressing an agent clears non-touched auto-fill entries that contain
 *   it; the submit terminal fill skips suppressed recommendations too.
 * - The composer's single popover slot is reconciled with the document: when
 *   every chip for the slotted skill disappears (delete or Cmd+Z), the slot
 *   clears so a later pasted chip of the same skill never auto-opens the
 *   picker (KTD3, review finding #10).
 * - The submit terminal fill (KTD5 step 3) reads the live document and the
 *   insertion record through refs, so a chip whose fill effect has not
 *   committed yet (cold-start race, OQ3) still binds on submit.
 * - touched/filled guards persist with the draft (CommentDraftPayload) and
 *   rehydrate on virtualization remounts, sharing the designation map's
 *   lifecycle.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import { useQuery } from "@tanstack/react-query";
import { sameStringList } from "@multica/core/utils";
import { parseMentions } from "@multica/core/issues/comment-trigger-outcomes";
import { agentListOptions } from "@multica/core/workspace/queries";
import type { ContentEditorRef } from "../../editor/content-editor";
import { useT } from "../../i18n";
import { isNoteCommentDraft } from "./use-comment-trigger-preview";
import type { UseCommentTriggerPreviewResult } from "./use-comment-trigger-preview";
import {
  useRecommendedSkillAgent,
  type DescriptionMentionAgent,
} from "./use-recommended-skill-agent";
import { useSkillMentionAutoOpen } from "./use-skill-mention-auto-open";

/** A fill that still holds its one-shot async upgrade window. `tier` is the
 *  source-tier rank the fill was written at (lower ranks higher). */
interface PendingFill {
  origin: "fast-path" | "async";
  tier: number;
}

export interface UseSkillAutoBindParams {
  wsId: string;
  /** Comment composers always have an issueId. Description-editor consumers
   *  (create modal manual panel before submit, issue edit state) may omit
   *  it: the recommendation engine falls back to `descriptionMentions` +
   *  `formAssignee` / `issue.assignee` when no issueId is available. */
  issueId?: string;
  /** Reply composers pass their parent comment id (thread-parent fast path). */
  parentId?: string;
  /** The composer's own trigger-preview result — see
   *  useRecommendedSkillAgent's `preview` param for why it is injected.
   *  Description-editor consumers pass a synthetic empty+resolved preview
   *  so the async branch yields null and the recommendation collapses to
   *  fast-path only (no backend preview exists for descriptions). */
  triggerPreview?: Pick<UseCommentTriggerPreviewResult, "backendAgents" | "resolved">;
  /** Composer-held suppression set from the trigger chip strip. */
  suppressedAgentIds: ReadonlySet<string>;
  skillMentionAgents: Record<string, string[]>;
  setSkillMentionAgents: Dispatch<SetStateAction<Record<string, string[]>>>;
  editorRef: RefObject<ContentEditorRef | null>;
  /** Composer-owned single popover slot setter (U3). Functional updates are
   *  supported — the doc-sync reconcile clears a stale slot through the
   *  updater form (review finding #10). */
  setOpenPopoverFor: Dispatch<SetStateAction<string | null>>;
  /** Draft-hydrated guards: skills already touched/filled in a previous
   *  mount of the same draft. */
  initialTouchedSkillIds?: readonly string[];
  initialFilledSkillIds?: readonly string[];
  /** Description-editor body. When provided, the recommendation engine parses
   *  the body's `@agent` and `@squad` mentions and ranks them at tier 0
   *  (mention_agent / mention_squad_leader), beating the assignee source.
   *  Comment composers leave this unset — their mention signal arrives via
   *  the backend preview's `backendAgents`. */
  description?: string;
  /** Create-issue form assignee. Description-editor consumer that has no
   *  issueId yet uses this in place of `issue.assignee_type` / `assignee_id`.
   *  Squad types resolve to their leader via the squads query, mirroring the
   *  comment composer's "treat squad leader as assignee" rule. */
  formAssignee?: { type: string; id: string | undefined };
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
  description,
  formAssignee,
}: UseSkillAutoBindParams): UseSkillAutoBindResult {
  const { t } = useT("issues");

  // Description-editor mentions: parsed from `description` when provided.
  // The caller is responsible for filtering to "newly inserted" mentions per
  // R2 — this hook ranks whatever it receives.
  const descriptionMentions = useMemo<readonly DescriptionMentionAgent[]>(() => {
    if (!description) return [];
    const out: DescriptionMentionAgent[] = [];
    for (const mention of parseMentions(description)) {
      if (mention.type === "agent") {
        out.push({ id: mention.id, source: "mention_agent" });
      } else if (mention.type === "squad") {
        out.push({ id: mention.id, source: "mention_squad_leader" });
      }
    }
    return out;
  }, [description]);

  const recommended = useRecommendedSkillAgent({
    wsId,
    issueId,
    parentId,
    preview: triggerPreview,
    suppressedAgentIds,
    descriptionMentions,
    formAssignee,
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
  // Fills still holding a one-shot async upgrade window (KTD5). A fast-path
  // fill is replaced/removed by the first authoritative answer; an async fill
  // is replaced only by a strictly higher-tier answer (review finding #4).
  const upgradableSkillIdsRef = useRef<Map<string, PendingFill>>(new Map());
  // Session-freshness latch (U5): the effect below fires once per session
  // (mount, or after `reset()`) — a chip hydrated with a pending designation
  // re-pops the picker so the user can confirm or modify before submit.
  // `reset()` clears the latch so an issue switch re-arms the scan.
  const sessionFreshnessDoneRef = useRef(false);
  // Live `/note` gate (review finding #9): snapshotted from the document on
  // every sync tick so the fill effect re-runs when note-ness flips.
  const [noteDraft, setNoteDraft] = useState(false);
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
  const isSkillPresent = useCallback(
    (skillId: string) =>
      (editorRef.current?.getSkillMentionIds() ?? []).includes(skillId),
    [editorRef],
  );
  const autoOpen = useSkillMentionAutoOpen(wsId, openPopoverAndAnnounce, isSkillPresent);
  const handleSkillMentionInserted = useCallback(
    (skillId: string) => {
      insertedSkillIdsRef.current.add(skillId);
      autoOpen(skillId);
    },
    [autoOpen],
  );

  // Session-freshness scan (U5): once per session (mount or post-reset) —
  // when the editor opens with chips already in the document carrying a
  // pending designation (hydrate from draft, or a chips-from-server case the
  // user has since touched via the popover), re-pop the picker so the user
  // sees the current designation rather than discovering it on submit. The
  // query is shared with useSkillMentionAutoOpen via TanStack's cache, so no
  // extra request fires. Touched chips stay closed (KTD5 explicit-gesture
  // rule) and typed-this-session chips defer to the typed-insert gate.
  const { data: bindableAgents, isLoading: bindableAgentsLoading } = useQuery(
    agentListOptions(wsId),
  );
  const hasBindableAgents = (bindableAgents ?? []).some(
    (agent) => !agent.archived_at,
  );
  useEffect(() => {
    if (sessionFreshnessDoneRef.current) return;
    if (bindableAgentsLoading || !hasBindableAgents) return;
    sessionFreshnessDoneRef.current = true;
    const designationMap = skillMentionAgentsRef.current;
    const inserted = insertedSkillIdsRef.current;
    const touched = touchedRef.current;
    for (const skillId of Object.keys(designationMap)) {
      const agents = designationMap[skillId];
      if (!agents || agents.length === 0) continue;
      if (inserted.has(skillId)) continue;
      if (touched.has(skillId)) continue;
      if (isSkillPresent(skillId) === false) continue;
      // Single-slot popover: don't trample an open slot. The freshest
      // popover slot wins; the rest stay as one-shots on next mount/reset.
      setOpenPopoverFor((prev) => (prev == null ? skillId : prev));
      return;
    }
  }, [bindableAgentsLoading, hasBindableAgents, setOpenPopoverFor, isSkillPresent]);

  const handleSkillMentionChange = useCallback(
    (skillId: string, agentIds: string[]) => {
      // Every picker gesture (select or clear) marks the skill touched —
      // the machine default never overrides an explicit choice afterwards.
      setTouchedSkillIds((prev) =>
        prev.has(skillId) ? prev : new Set([...prev, skillId]),
      );
      // A manual gesture also closes any pending one-shot upgrade window.
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
    // removes, so an unchanged collection keeps its reference (no allocation
    // on the common typing tick).
    const keptInserted = [...insertedSkillIdsRef.current].filter((id) =>
      present.has(id),
    );
    if (keptInserted.length !== insertedSkillIdsRef.current.size) {
      insertedSkillIdsRef.current = new Set(keptInserted);
    }
    const keptUpgradable = [...upgradableSkillIdsRef.current.keys()].filter(
      (id) => present.has(id),
    );
    if (keptUpgradable.length !== upgradableSkillIdsRef.current.size) {
      upgradableSkillIdsRef.current = new Map(
        keptUpgradable.map((id) => [id, upgradableSkillIdsRef.current.get(id)!]),
      );
    }
    setFilledSkillIds((prev) => {
      const next = new Set([...prev].filter((id) => present.has(id)));
      return next.size === prev.size ? prev : next;
    });
    setDocSkillIds((prev) => (sameStringList(prev, ids) ? prev : ids));
    // /note snapshot (review finding #9): the fill effect depends on this, so
    // it re-runs when the draft flips into or out of note mode.
    const isNote = isNoteCommentDraft(editorRef.current?.getMarkdown() ?? "");
    setNoteDraft((prev) => (prev === isNote ? prev : isNote));
    // Popover-slot reconcile (review finding #10): a slot pointing at a skill
    // whose chips are all gone must clear, or a later pasted/hydrated chip of
    // the same skill would inherit the open picker (KTD3 violation). The
    // updater form returns `prev` unchanged when the slot is already valid,
    // so this never causes extra renders.
    setOpenPopoverFor((prev) => (prev != null && !present.has(prev) ? null : prev));
    setSkillMentionAgents((prev) => {
      const next = Object.fromEntries(
        Object.entries(prev).filter(([id]) => present.has(id)),
      );
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [editorRef, setOpenPopoverFor, setSkillMentionAgents]);

  useEffect(() => {
    // (A) Async confirmation: a fast-path fill is a temporary value, so the
    // first authoritative answer replaces (or, when null, removes) it exactly
    // once per fill — the badge flips at most once. An async-origin fill is
    // only replaced when the authoritative answer's tier strictly outranks
    // the tier it filled from (review finding #4): same-tier and lower-tier
    // answers keep the binding (no identity flicker, KTD5), and an unreplaced
    // entry keeps its upgrade window for a later strictly higher tier, so an
    // @agent mention typed after the chip still wins the skill (R5).
    if (recommended.from === "async") {
      const pending = upgradableSkillIdsRef.current;
      if (pending.size > 0) {
        const authoritativeId = recommended.id;
        const authoritativeTier = recommended.tier;
        const prevAgents = skillMentionAgentsRef.current;
        const nextPending = new Map(pending);
        let next: Record<string, string[]> | null = null;
        for (const [skillId, fill] of pending) {
          const release = () => nextPending.delete(skillId);
          if (touchedRef.current.has(skillId)) {
            release();
            continue;
          }
          const current = prevAgents[skillId];
          // Entry already gone (suppress gesture / manual clear).
          if (!current) {
            release();
            continue;
          }
          const unchanged =
            authoritativeId != null &&
            current.length === 1 &&
            current[0] === authoritativeId;
          if (fill.origin === "fast-path") {
            // The first authoritative answer settles a fast-path fill.
            release();
            if (unchanged) continue;
            next ??= { ...prevAgents };
            if (authoritativeId == null) delete next[skillId];
            else next[skillId] = [authoritativeId];
          } else if (
            authoritativeId != null &&
            authoritativeTier < fill.tier
          ) {
            // A strictly higher tier replaces an async fill exactly once.
            release();
            if (unchanged) continue;
            next ??= { ...prevAgents };
            next[skillId] = [authoritativeId];
          }
        }
        upgradableSkillIdsRef.current = nextPending;
        if (next) setSkillMentionAgents(next);
      }
    }

    // (B) Fresh fills: typed-inserted chips still in the doc that were never
    // filled nor touched and carry no designation yet (hydrated designations
    // win over re-fill). A /note draft never machine-fills (review finding
    // #9): the backend drops all triggers for note comments, so a badge the
    // machine wrote there would claim a binding that cannot fire.
    const recommendedId = recommended.id;
    if (recommendedId == null || noteDraft) return;
    const targets = docSkillIds.filter(
      (skillId) =>
        insertedSkillIdsRef.current.has(skillId) &&
        !touchedSkillIds.has(skillId) &&
        !filledSkillIds.has(skillId) &&
        !skillMentionAgents[skillId],
    );
    if (targets.length === 0) return;
    for (const skillId of targets) {
      upgradableSkillIdsRef.current.set(skillId, {
        origin: recommended.from,
        tier: recommended.tier,
      });
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
    recommended.tier,
    noteDraft,
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
    if (
      recommendedId != null &&
      !suppressedAgentIdsRef.current.has(recommendedId) &&
      // /note drafts skip the machine terminal fill too (review finding #9);
      // manual designations above still submit — the user's own statement.
      !isNoteCommentDraft(editorRef.current?.getMarkdown() ?? "")
    ) {
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
    upgradableSkillIdsRef.current = new Map();
    setTouchedSkillIds(new Set());
    setFilledSkillIds(new Set());
    setDocSkillIds([]);
    setNoteDraft(false);
    sessionFreshnessDoneRef.current = false;
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
